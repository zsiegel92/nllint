-- Run as the migration owner. Runtime connections always assume nllint_runtime.
SET LOCAL search_path=public,pg_catalog;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nllint_runtime') THEN
        CREATE ROLE nllint_runtime NOLOGIN NOBYPASSRLS;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION nllint_user_id() RETURNS bigint
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('nllint.user_id', true), '')::bigint $$;

CREATE TABLE IF NOT EXISTS users (
    id bigint PRIMARY KEY CHECK (id >= 0)
);
CREATE TABLE IF NOT EXISTS projects (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    parent_id bigint,
    routing bytea,
    UNIQUE (user_id, id),
    UNIQUE (user_id, name),
    FOREIGN KEY (user_id, parent_id) REFERENCES projects(user_id,id),
    CHECK (parent_id IS DISTINCT FROM id)
);
CREATE TABLE IF NOT EXISTS api_keys (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    digest text NOT NULL UNIQUE,
    prefix text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    UNIQUE (user_id,id)
);
CREATE TABLE IF NOT EXISTS streams (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    key_id bigint NOT NULL,
    project_id bigint NOT NULL,
    cursor bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id,key_id,project_id),
    FOREIGN KEY (user_id,key_id) REFERENCES api_keys(user_id,id),
    FOREIGN KEY (user_id,project_id) REFERENCES projects(user_id,id)
);
CREATE TABLE IF NOT EXISTS texts (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    key_id bigint NOT NULL,
    hash text NOT NULL,
    body text NOT NULL,
    PRIMARY KEY (user_id,key_id,hash),
    FOREIGN KEY (user_id,key_id) REFERENCES api_keys(user_id,id)
);
CREATE TABLE IF NOT EXISTS file_rules (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key_id bigint NOT NULL,
    project_id bigint NOT NULL,
    file_path text NOT NULL,
    rule_path text NOT NULL,
    file_hash text NOT NULL,
    rule_hash text NOT NULL,
    prompt_hash text NOT NULL,
    file_label boolean,
    file_labeled_at timestamptz,
    force_requested boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id,key_id,project_id) REFERENCES streams(user_id,key_id,project_id),
    FOREIGN KEY (user_id,key_id,file_hash) REFERENCES texts(user_id,key_id,hash),
    FOREIGN KEY (user_id,key_id,rule_hash) REFERENCES texts(user_id,key_id,hash),
    FOREIGN KEY (user_id,key_id,prompt_hash) REFERENCES texts(user_id,key_id,hash),
    UNIQUE (user_id,id),
    UNIQUE (key_id, project_id, file_path, rule_path, file_hash, rule_hash, prompt_hash)
);
CREATE INDEX IF NOT EXISTS file_rules_changes ON file_rules (key_id, project_id, revision) WHERE revision > 0;
CREATE INDEX IF NOT EXISTS file_rules_rule_history ON file_rules (project_id, rule_path, id DESC);
CREATE TABLE IF NOT EXISTS traces (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id text PRIMARY KEY,
    key_id bigint NOT NULL,
    project_id bigint NOT NULL,
    file_path text NOT NULL,
    version text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id,id),
    FOREIGN KEY (user_id,key_id,project_id) REFERENCES streams(user_id,key_id,project_id)
);
CREATE INDEX IF NOT EXISTS traces_recent ON traces (created_at DESC, id);
CREATE INDEX IF NOT EXISTS traces_filter ON traces (key_id, project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS provider_versions (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id bigint NOT NULL,
    version text NOT NULL,
    routing bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id,id),
    UNIQUE (project_id,version),
    FOREIGN KEY (user_id,project_id) REFERENCES projects(user_id,id)
);
CREATE TABLE IF NOT EXISTS runs (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pair_id bigint NOT NULL,
    version text NOT NULL,
    batch_id text NOT NULL,
    cache_identity text NOT NULL,
    stage text NOT NULL DEFAULT 'file' CHECK (stage IN ('file','ranges','adjudication','ready','failed')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    error text,
    provider_version_id bigint NOT NULL,
    UNIQUE (user_id,id),
    UNIQUE (pair_id, version),
    FOREIGN KEY (user_id,pair_id) REFERENCES file_rules(user_id,id),
    FOREIGN KEY (user_id,batch_id) REFERENCES traces(user_id,id),
    FOREIGN KEY (user_id,provider_version_id) REFERENCES provider_versions(user_id,id)
);
CREATE INDEX IF NOT EXISTS runs_by_content ON runs (cache_identity,id);
CREATE INDEX IF NOT EXISTS runs_queue ON runs (user_id, available_at, id)
    WHERE stage IN ('file','ranges','adjudication');
CREATE TABLE IF NOT EXISTS trace_runs (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    trace_id text NOT NULL,
    run_id bigint NOT NULL,
    rule_id text NOT NULL,
    PRIMARY KEY (trace_id, run_id),
    UNIQUE (trace_id, rule_id),
    FOREIGN KEY (user_id,trace_id) REFERENCES traces(user_id,id),
    FOREIGN KEY (user_id,run_id) REFERENCES runs(user_id,id)
);
CREATE INDEX IF NOT EXISTS trace_runs_by_run ON trace_runs (run_id);
-- One row per outbound attempt. The result is appended in a separate transaction.
CREATE TABLE IF NOT EXISTS provider_requests (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_version_id bigint NOT NULL,
    trace_id text NOT NULL,
    stage text NOT NULL CHECK (stage IN ('file','ranges','adjudication')),
    run_ids bigint[] NOT NULL CHECK (cardinality(run_ids) > 0),
    question_count integer CHECK (question_count > 0),
    request_options jsonb NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (user_id,id),
    FOREIGN KEY (user_id,provider_version_id) REFERENCES provider_versions(user_id,id),
    FOREIGN KEY (user_id,trace_id) REFERENCES traces(user_id,id)
);
CREATE INDEX IF NOT EXISTS provider_requests_runs ON provider_requests USING gin (run_ids);
CREATE INDEX IF NOT EXISTS provider_requests_recent ON provider_requests (user_id,started_at);
CREATE TABLE IF NOT EXISTS provider_request_results (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    request_id bigint PRIMARY KEY,
    finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    http_status integer CHECK (http_status BETWEEN 100 AND 599),
    transport_error text,
    upstream_request_id text,
    resolved_model text,
    resolved_service_tier text,
    usage jsonb,
    CHECK ((http_status IS NULL) <> (transport_error IS NULL)),
    FOREIGN KEY (user_id,request_id) REFERENCES provider_requests(user_id,id)
);

CREATE TABLE IF NOT EXISTS questions (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    run_id bigint NOT NULL,
    stage text NOT NULL CHECK (stage IN ('file','ranges','adjudication')),
    start_line integer NOT NULL DEFAULT 0,
    end_line integer NOT NULL DEFAULT 0,
    decision boolean,
    confidence double precision CHECK (confidence BETWEEN 0 AND 1),
    model text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, stage, start_line, end_line),
    FOREIGN KEY (user_id,run_id) REFERENCES runs(user_id,id),
    CHECK (
        (stage = 'adjudication' AND start_line >= 1 AND end_line >= start_line)
        OR (stage <> 'adjudication' AND start_line = 0 AND end_line = 0)
    )
);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS provider_request_id bigint;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_constraint WHERE conrelid='questions'::regclass AND conname='questions_provider_request_fk'
    ) THEN
        ALTER TABLE questions ADD CONSTRAINT questions_provider_request_fk
            FOREIGN KEY (user_id,provider_request_id) REFERENCES provider_requests(user_id,id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS range_candidates (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    run_id bigint NOT NULL,
    start_line integer NOT NULL CHECK (start_line >= 1),
    end_line integer NOT NULL CHECK (end_line >= start_line),
    PRIMARY KEY (run_id, start_line, end_line),
    FOREIGN KEY (user_id,run_id) REFERENCES runs(user_id,id)
);
CREATE TABLE IF NOT EXISTS range_annotations (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    pair_id bigint NOT NULL,
    start_line integer NOT NULL CHECK (start_line >= 1),
    end_line integer NOT NULL CHECK (end_line >= start_line),
    decision boolean NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pair_id, start_line, end_line),
    FOREIGN KEY (user_id,pair_id) REFERENCES file_rules(user_id,id)
);

ALTER TABLE file_rules ADD COLUMN IF NOT EXISTS labeler_identity jsonb;
ALTER TABLE range_annotations ADD COLUMN IF NOT EXISTS labeler_identity jsonb;

CREATE TABLE IF NOT EXISTS agentic_labelers (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    model text NOT NULL,
    max_tool_calls integer NOT NULL CHECK (max_tool_calls BETWEEN 0 AND 12),
    UNIQUE (user_id,id),
    UNIQUE (user_id,name)
);

CREATE TABLE IF NOT EXISTS agentic_labels (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    run_id bigint NOT NULL,
    labeler_id bigint NOT NULL,
    ranges jsonb NOT NULL,
    labeler_identity jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id,labeler_id),
    FOREIGN KEY (user_id,run_id) REFERENCES runs(user_id,id),
    FOREIGN KEY (user_id,labeler_id) REFERENCES agentic_labelers(user_id,id)
);

ALTER TABLE agentic_labelers ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '';
ALTER TABLE agentic_labelers ADD COLUMN IF NOT EXISTS configured_via text;

CREATE TABLE IF NOT EXISTS annotation_history (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pair_id bigint NOT NULL,
    start_line integer,
    end_line integer,
    decision boolean,
    labeler_identity jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id,pair_id) REFERENCES file_rules(user_id,id)
);
CREATE INDEX IF NOT EXISTS annotation_history_pair ON annotation_history (pair_id,id DESC);

CREATE TABLE IF NOT EXISTS eval_sets (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id,id),
    UNIQUE (user_id,name)
);
CREATE TABLE IF NOT EXISTS eval_examples (
    user_id bigint NOT NULL DEFAULT nllint_user_id() REFERENCES users(id),
    set_id bigint NOT NULL,
    run_id bigint NOT NULL,
    reference jsonb NOT NULL,
    PRIMARY KEY (set_id,run_id),
    FOREIGN KEY (user_id,set_id) REFERENCES eval_sets(user_id,id),
    FOREIGN KEY (user_id,run_id) REFERENCES runs(user_id,id)
);

-- These tables contain control-plane indexes only and are readable through the functions below.
CREATE TABLE IF NOT EXISTS api_key_directory (
    digest text PRIMARY KEY,
    user_id bigint NOT NULL,
    key_id bigint NOT NULL,
    FOREIGN KEY (user_id,key_id) REFERENCES api_keys(user_id,id)
);
CREATE TABLE IF NOT EXISTS provider_budget (
    provider text PRIMARY KEY CHECK (provider IN ('decision','ranges')),
    next_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION nllint_index_key() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
    IF NEW.revoked_at IS NULL THEN
        INSERT INTO public.api_key_directory(digest,user_id,key_id)
        VALUES (NEW.digest,NEW.user_id,NEW.id) ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM public.api_key_directory WHERE digest=NEW.digest;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS index_key ON api_keys;
CREATE TRIGGER index_key AFTER INSERT OR UPDATE OF revoked_at ON api_keys
FOR EACH ROW EXECUTE FUNCTION nllint_index_key();

CREATE OR REPLACE FUNCTION nllint_lookup_key(candidate text)
RETURNS TABLE(user_id bigint,key_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT d.user_id,d.key_id FROM public.api_key_directory d WHERE d.digest=candidate $$;

CREATE OR REPLACE FUNCTION nllint_register_user(user_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
AS $$ INSERT INTO public.users(id) VALUES (user_id) ON CONFLICT DO NOTHING $$;

CREATE OR REPLACE FUNCTION nllint_worker_users() RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$ SELECT id FROM public.users ORDER BY id $$;

CREATE OR REPLACE FUNCTION nllint_reserve_provider(provider_name text, interval_seconds double precision)
RETURNS double precision
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE
    reserved timestamptz;
    current_time_at_lock timestamptz;
BEGIN
    IF interval_seconds <= 0 OR interval_seconds > 60 THEN
        RAISE EXCEPTION 'invalid provider reservation interval';
    END IF;
    INSERT INTO public.provider_budget(provider,next_at)
        VALUES (provider_name,'-infinity') ON CONFLICT DO NOTHING;
    SELECT next_at INTO STRICT reserved FROM public.provider_budget WHERE provider=provider_name FOR UPDATE;
    current_time_at_lock := clock_timestamp();
    IF reserved > current_time_at_lock THEN
        RETURN EXTRACT(epoch FROM reserved-current_time_at_lock);
    END IF;
    UPDATE public.provider_budget SET next_at=current_time_at_lock+make_interval(secs => interval_seconds)
    WHERE provider=provider_name;
    RETURN 0;
END $$;

REVOKE ALL ON FUNCTION nllint_index_key(), nllint_lookup_key(text), nllint_register_user(bigint),
    nllint_worker_users(), nllint_reserve_provider(text,double precision) FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nllint_runtime;
GRANT EXECUTE ON FUNCTION nllint_lookup_key(text), nllint_register_user(bigint),
    nllint_worker_users(), nllint_reserve_provider(text,double precision) TO nllint_runtime;

DO $$
DECLARE
    relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY[
        'projects','api_keys','streams','texts','file_rules','traces','provider_versions',
        'runs','trace_runs','questions','range_candidates','range_annotations',
        'provider_requests','provider_request_results','agentic_labelers','agentic_labels',
        'annotation_history','eval_sets','eval_examples'
    ] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format('DROP POLICY IF EXISTS owner_isolation ON public.%I', relation);
        EXECUTE format(
            'CREATE POLICY owner_isolation ON public.%I USING (user_id = public.nllint_user_id())
             WITH CHECK (user_id = public.nllint_user_id())', relation
        );
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO nllint_runtime', relation);
    END LOOP;
END $$;
GRANT USAGE ON SEQUENCE agentic_labelers_id_seq, annotation_history_id_seq, eval_sets_id_seq TO nllint_runtime;
REVOKE UPDATE ON annotation_history, eval_sets, eval_examples FROM nllint_runtime;
GRANT DELETE ON range_annotations TO nllint_runtime;
GRANT USAGE ON SEQUENCE projects_id_seq, api_keys_id_seq, file_rules_id_seq,
    provider_versions_id_seq, runs_id_seq, provider_requests_id_seq TO nllint_runtime;

-- Project routing is the editable pointer. Snapshots and their request ledger are append-only.
CREATE OR REPLACE FUNCTION nllint_reject_provider_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog
AS $$
BEGIN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

DO $$
DECLARE
    relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY['provider_versions','provider_requests','provider_request_results'] LOOP
        EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM nllint_runtime', relation);
        EXECUTE format('DROP TRIGGER IF EXISTS provider_history_append_only ON public.%I', relation);
        EXECUTE format(
            'CREATE TRIGGER provider_history_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
             ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.nllint_reject_provider_history_change()',
             relation
        );
    END LOOP;
END $$;

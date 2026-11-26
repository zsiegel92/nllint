import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {useQueryStates} from 'nuqs';
import {BrowserRouter, Link, matchRoutes, useLocation, useNavigate} from 'react-router';
import {NuqsAdapter} from 'nuqs/adapters/react-router/v7';
import {closedReview, exportKinds, findRangesPath, gatewayQuery, issueLabels, modelsPath, navigation, rangeParam, routes, sectionPaths, tracePath} from './navigation';
import {Api} from './api';
import type {Cell, Key, Label, Mode, Project, Provider, ProviderEdit, Range, ReviewMode, Routing, Run, Trace} from './api';
import type {Section} from './navigation';
import {isLanguage, languageForPath} from './code';
import {Matrix, ReviewPanel} from './review';
import {RulePicker} from './rule-picker';
import {TableStages} from './stage-selector';
import type {Bounds} from './source-review';
import './style.css';

const pageSize = 20;
const devVerifierKey = 'nllint.dev-verifier';
const devReturnKey = 'nllint.dev-return';

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const matched = matchRoutes([...routes], location)?.at(-1);
  const [authenticated, setAuthenticated] = useState<boolean>();
  const api = useMemo(() => new Api(), []);
  const [loginError, setLoginError] = useState('');
  useEffect(() => {
    async function checkSession() {
      const current = window.location;
      const ticket = new URLSearchParams(current.hash.slice(1)).get('dev_ticket');
      if (ticket) {
        history.replaceState(history.state, '', current.pathname + current.search);
        const verifier = sessionStorage.getItem(devVerifierKey);
        const destination = sessionStorage.getItem(devReturnKey);
        sessionStorage.removeItem(devVerifierKey);
        sessionStorage.removeItem(devReturnKey);
        if (!verifier) throw new Error('Start remote sign-in again in this tab.');
        await api.request('/session/dev/exchange', 'POST', {ticket, verifier});
        if (destination?.startsWith('/') && !destination.startsWith('//')
          && new URL(destination, current.origin).origin === current.origin
          && destination !== current.pathname + current.search) {
          current.replace(destination);
          return;
        }
      }
      const session = await api.json<{authenticated: boolean}>('/session');
      setAuthenticated(session.authenticated);
    }
    checkSession().catch(error => {setLoginError(error.message); setAuthenticated(false);});
  }, [api]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const legacyMode = params.get('review');
    const oldAdjudication = params.get('mode') === 'adjudication';
    if (legacyMode === null && !oldAdjudication && !params.has('context')) return;
    if (oldAdjudication || (!params.has('mode') && legacyMode === 'adjudication')) params.set('mode', 'ranges');
    else if (!params.has('mode') && (legacyMode === 'files' || legacyMode === 'ranges')) params.set('mode', legacyMode);
    for (const key of ['review', 'context', 'ruleHistory', 'providerRequests']) params.delete(key);
    void navigate({pathname: location.pathname, search: params.toString(), hash: location.hash}, {replace: true});
  }, [location.pathname, location.search, location.hash, navigate]);
  if (authenticated === undefined) return <main className="entry"><p role="status">Checking session…</p></main>;
  if (!authenticated) return <Login api={api} initialError={loginError} login={() => setAuthenticated(true)}/>;
  if (!matched) return <main className="entry"><section className="entry-card">
    <h1>Page not found</h1><Link to="/traces">Back to traces</Link>
  </section></main>;
  if (matched.route.id === 'home') return <LegacyHome api={api}/>;
  if (matched.route.id === 'find') return <FindRanges api={api} run={matched.params.runId ?? ''}/>;
  const section: Section = matched.route.id === 'keys' ? 'keys'
    : matched.route.id === 'projects' || matched.route.id === 'models' ? 'projects' : 'traces';
  return <Workspace api={api} section={section} project={matched.params.projectId ?? ''}
    traceId={matched.params.traceId} models={matched.params.pipelineId} logout={() => {
      api.request('/session', 'DELETE').then(() => setAuthenticated(false));
    }}/>;

}

type SignInMethod = {github: boolean; app_url: string; remote_dev_origin: string | null};

function Login({api, login, initialError}: {api: Api; login: () => void; initialError: string}) {
  const [token, setToken] = useState('');
  const [method, setMethod] = useState<SignInMethod>();
  const [error, setError] = useState(initialError);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    api.json<SignInMethod>('/session/method').then(setMethod).catch(error => setError(error.message));
  }, [api]);

  async function remoteSignIn(method: SignInMethod) {
    try {
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      sessionStorage.setItem(devVerifierKey, verifier);
      sessionStorage.setItem(devReturnKey, location.pathname + location.search);
      const start = new URL('/api/session/github/start', method.app_url);
      start.searchParams.set('dev_challenge', base64Url(new Uint8Array(hash)));
      location.assign(start);
    } catch (error) {
      setError((error as Error).message);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setWaiting(true);
    api.request('/session', 'POST', {token: token.trim()}).then(login)
      .catch(error => setError(error.message)).finally(() => setWaiting(false));
  }
  const signIn = '/api/session/github/start?' + new URLSearchParams({next: location.pathname + location.search});
  const remote = Boolean(method?.app_url && location.hostname === 'localhost' && new URL(method.app_url).protocol === 'https:');
  return <main className="entry"><form className="entry-card" onSubmit={submit}>
    <div className="brand"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</div>
    <h1>Sign in</h1>
    {method?.github && !remote && <a className="primary button-link" href={signIn}>Continue with GitHub</a>}
    {method?.github && remote && (method.remote_dev_origin === location.origin
      ? <button type="button" className="primary" onClick={() => remoteSignIn(method)}>Continue with GitHub</button>
      : <p>Set NLLINT_REMOTE_DEV_ORIGIN to {location.origin} on the backend to use GitHub from Vite.</p>)}
    {method?.github === false && <>
      <label>Local development token<input type="password" autoComplete="current-password" required
        value={token} onChange={event => setToken(event.target.value)}/></label>
      <button className="primary" disabled={waiting}>Continue</button>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </form></main>;
}

function LegacyHome({api}: {api: Api}) {
  const {search} = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function redirect() {
      const params = new URLSearchParams(search);
      const section = params.get('section');
      const traceId = params.get('traceId');
      const project = params.get('project') ?? '';
      const models = params.get('models');
      const findRun = params.get('findRun');
      for (const name of ['section', 'traceId', 'project', 'models', 'findRun']) params.delete(name);
      let path = tracePath(project);
      if (findRun) path = findRangesPath(encodeURIComponent(findRun));
      else if (section === 'keys') path = sectionPaths.keys;
      else if (section === 'projects') path = models && /^\d+$/.test(models) ? modelsPath(models) : sectionPaths.projects;
      else if (traceId) {
        const result = await api.json<{traces: Trace[]}>(`/traces?${new URLSearchParams({trace_id: traceId})}`);
        if (!result.traces[0]) throw new Error('Trace not found');
        path = tracePath(result.traces[0].project, traceId);
      }
      if (active) void navigate(params.size ? `${path}?${params}` : path, {replace: true});
    }
    redirect().catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, navigate, search]);
  return <main className="entry"><section className="entry-card">
    {error ? <><p role="alert">{error}</p><Link to="/traces">Back to traces</Link></> : <p role="status">Opening view…</p>}
  </section></main>;
}

function FindRanges({api, run}: {api: Api; run: string}) {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function wait(trace: string) {
      const result = await api.json<Run>(`/runs/${encodeURIComponent(run)}`);
      if (!active) return;
      if (result.stage === 'ready') {
        const view = await api.json<{traces: Trace[]}>(`/traces?${new URLSearchParams({trace_id: trace})}`);
        if (!view.traces[0]) throw new Error('Trace not found');
        if (active) void navigate(gatewayQuery(tracePath(view.traces[0].project, trace), {run: Number(run), mode: 'ranges'}), {replace: true});
      }
      else if (result.stage === 'failed') {
        throw new Error(`Range processing failed${result.error ? ` (${result.error})` : ''}.`);
      } else timer = window.setTimeout(() => wait(trace).catch(fail), 1400);
    }
    const fail = (error: Error) => {if (active) setError(error.message);};
    api.json<{trace_id: string}>(`/runs/${encodeURIComponent(run)}/find-ranges`, 'POST')
      .then(result => {if (active) return wait(result.trace_id);}).catch(fail);
    return () => {active = false; clearTimeout(timer);};
  }, [api, navigate, run, attempt]);

  return <main className="entry"><section className="entry-card">
    <div className="brand"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</div>
    <h1>Finding ranges</h1>
    {error ? <>
      <p role="alert" className="error">{error}</p>
      <button type="button" onClick={() => {setError(''); setAttempt(value => value + 1);}}>Try again</button>
    </> : <p role="status"><span className="spinner"/> Finding and adjudicating candidate ranges…</p>}
    <Link to="/traces">Back to traces</Link>
  </section></main>;
}

function Workspace({api, logout, section, project, traceId, models}: {
  api: Api; logout: () => void; section: Section; project: string; traceId?: string; models?: string;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useQueryStates(navigation, {history: 'push'});
  const {mode, stages, issue, key, rule, rules, sort, exportKind} = query;
  const page = Math.max(0, query.page);
  const selectedTrace = query.reviewTrace ?? (query.run ? traceId : undefined);
  const [keys, setKeys] = useState<Key[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const routingProject = projects.find(item => String(item.id) === models);
  const [projectName, setProjectName] = useState('');
  const [data, setData] = useState<{traces: Trace[]; more: boolean}>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [fallbackTrace, setFallbackTrace] = useState<Trace>();
  const refresh = useCallback(() => setReload(value => value + 1), []);
  const close = useCallback(() => {void setQuery(closedReview);}, [setQuery]);

  useEffect(() => {
    let mounted = true;
    Promise.all([api.json<Key[]>('/keys'), api.json<Project[]>('/projects')])
      .then(([keys, projects]) => {if (mounted) {setKeys(keys); setProjects(projects);}})
      .catch(error => {if (mounted) setError(error.message);});
    return () => {mounted = false;};
  }, [api, reload]);

  useEffect(() => {
    if (!key || section !== 'projects') return;
    let mounted = true;
    api.json<Project[]>(`/projects?${new URLSearchParams({key_id: key})}`)
      .then(items => {if (mounted) setFilteredProjects(items);})
      .catch(error => {if (mounted) setError(error.message);});
    return () => {mounted = false;};
  }, [api, key, reload, section]);

  const scope = useMemo(() => {
    const params = new URLSearchParams();
    if (key) params.set('key_id', key);
    if (project) params.set('project', project);
    if (rule.trim()) params.set('rule', rule.trim());
    for (const version of rules) params.append('rule_version', version);
    return params;
  }, [key, project, rule, rules]);
  const ruleScope = new URLSearchParams();
  if (project) ruleScope.set('project', project);
  if (key) ruleScope.set('key_id', key);
  if (traceId) ruleScope.set('trace_id', traceId);
  useEffect(() => {
    if (section !== 'traces') return;
    let mounted = true;
    let timer: number;
    const params = new URLSearchParams(scope);
    params.set('issue', issue);
    params.set('sort', sort);
    params.set('limit', String(pageSize));
    params.set('offset', String(page * pageSize));
    if (traceId) params.set('trace_id', traceId);
    function fetchData() {
      api.json<{traces: Trace[]; more: boolean}>(`/traces?${params}`).then(next => {
        if (!mounted) return;
        setData(next);
        if (next.traces.some(trace => trace.cells.some(cell => !['ready', 'failed'].includes(cell.stage)))) {
          timer = window.setTimeout(fetchData, 2200);
        }
      }).catch(error => {if (mounted) setError(error.message);});
    }
    fetchData();
    return () => {mounted = false; clearTimeout(timer);};
  }, [api, issue, page, reload, scope, section, sort, traceId]);

  function changeMode(next: ReviewMode) {
    void setQuery({mode: next});
  }

  function saveRange(cell: Cell, range: Bounds, decision: Label) {
    setBusy(true);
    setError('');
    api.range(cell.pair_id, range.start, range.end, decision).then(refresh)
      .catch(error => setError(error.message)).finally(() => setBusy(false));
  }

  function saveFile(cell: Cell, decision: Label, rejectAll = false) {
    setBusy(true);
    setError('');
    api.file(cell.pair_id, cell.run_id, decision, rejectAll).then(refresh)
      .catch(error => setError(error.message)).finally(() => setBusy(false));
  }

  function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    api.json<Project>('/projects', 'POST', {name: projectName.trim()}).then(created => {
      setProjectName('');
      void navigate(gatewayQuery(modelsPath(created.id), {...query, key: ''}));
      refresh();
    }).catch(error => setError(error.message)).finally(() => setBusy(false));
  }

  async function download() {
    setError('');
    try {
      const params = new URLSearchParams(scope);
      if (traceId) params.set('trace_id', traceId);
      const link = document.createElement('a');
      const path = `/export/${exportKind}?${params}`;
      if (exportKind === 'all' || exportKind === 'annotated') {
        link.href = '/api' + path;
        link.download = `nllint-${exportKind}.jsonl`;
        link.click();
        return;
      }
      const response = await api.request(path);
      link.href = URL.createObjectURL(await response.blob());
      link.download = `nllint-${exportKind}.jsonl`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      setError((error as Error).message);
    }
  }

  const traces = data?.traces ?? [];
  const visibleTrace = traces.find(trace => trace.id === selectedTrace);
  useEffect(() => {
    if (section !== 'traces' || !selectedTrace || (visibleTrace && !rule)) return;
    let active = true;
    api.json<{traces: Trace[]}>(`/traces?${new URLSearchParams({trace_id: selectedTrace})}`)
      .then(result => {if (active) setFallbackTrace(result.traces[0]);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, reload, rule, section, selectedTrace, visibleTrace]);

  const active = visibleTrace && !rule ? visibleTrace : fallbackTrace?.id === selectedTrace ? fallbackTrace : undefined;
  const current = active?.cells.find(cell => cell.run_id === query.run);
  const language = query.syntax && isLanguage(query.syntax) ? query.syntax : undefined;
  const open = (trace: Trace, cell: Cell | undefined, view: ReviewMode, range?: Range) => {
    void setQuery({
      run: cell?.run_id ?? null, reviewTrace: trace.id,
      mode: view, range: range ? rangeParam(range) : null,
      syntax: selectedTrace === trace.id ? query.syntax : null,
    });
  };
  return <>
    <header className="topbar">
      <Link className="brand" to="/traces"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</Link>
      <nav aria-label="Workspace">
        <Link to="/traces" aria-current={section === 'traces' ? 'page' : undefined}>Traces</Link>
        <Link to="/pipelines" aria-current={section === 'projects' ? 'page' : undefined}>Pipelines</Link>
        <Link to="/api-keys" aria-current={section === 'keys' ? 'page' : undefined}>API keys</Link>
      </nav>
      <button className="quiet" type="button" onClick={logout}>Sign out</button>
    </header>
    <main className={active && section === 'traces' ? 'workspace with-review' : 'workspace'}>
      <section className="workspace-main">
        {error && <p role="alert" className="error">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p>}
        {section === 'traces' && <>
          <div className="page-heading">
            <h1>{traceId ? 'Trace review' : 'Lint traces'}</h1>
            <div className="export" role="group" aria-label="Export dataset">
              <label className="sr-only" htmlFor="dataset">Dataset to export</label>
              <select id="dataset" value={exportKind} onChange={event => {
                const value = exportKinds.find(kind => kind === event.target.value);
                if (value) void setQuery({exportKind: value});
              }}>
                <option value="files">File decisions</option>
                <option value="ranges">Range examples</option>
                <option value="adjudication">Adjudication examples</option>
                <option value="annotated">All annotated data</option>
                <option value="all">All lint data</option>
              </select>
              <button type="button" onClick={download}>Export JSONL</button>
            </div>
          </div>
          {traceId && <Link to={gatewayQuery(tracePath(project), {...query, ...closedReview, page: null})}>← Project traces</Link>}
          <div className="filters">
            <label>Find<select value={issue} onChange={event => void setQuery({issue: event.target.value, page: null})}>
              {Object.entries(issueLabels).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select></label>
            <label>Project<select value={project} onChange={event => void navigate(gatewayQuery(tracePath(event.target.value), {...query, ...closedReview, rules: null, rule: null, page: null}))}>
              <option value="">All projects</option>{projects.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
            </select></label>
            <label>API key<select value={key} onChange={event => void setQuery({key: event.target.value, page: null})}>
              <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <RulePicker api={api} scope={ruleScope.toString()} selected={rules}
              onChange={rules => void setQuery({rules, rule: null, page: null})}/>
            {rule && <button type="button" onClick={() => void setQuery({rule: null, page: null})}>Clear rule path filter</button>}
          </div>
          <div className="matrix-bar">
            <TableStages selected={stages} onChange={stages => void setQuery({stages})}/>
            <button className="quiet" type="button" onClick={refresh}>Refresh</button>
          </div>
          {data ? <Matrix traces={traces} stages={stages} open={open}
            languages={selectedTrace && language ? {[selectedTrace]: language} : {}}
            openFile={trace => open(trace, undefined, 'files')}
            traceLink={trace => gatewayQuery(tracePath(trace.project, trace.id), {...query, ...closedReview, page: null})}
            selectedRules={rules} onRule={version => void setQuery({
              rules: rules.includes(version) ? rules.filter(id => id !== version) : [...rules, version], rule: null, page: null,
            })}/>
            : <p role="status">Loading traces…</p>}
          {!traceId && data && <div className="pagination">
            <button type="button" disabled={!page} onClick={() => void setQuery({page: page - 1})}>← Previous</button>
            <span>Page {page + 1}</span>
            <button type="button" disabled={!data.more} onClick={() => void setQuery({page: page + 1})}>Next →</button>
          </div>}
        </>}
        {section === 'keys' && <Keys api={api} keys={keys} refresh={refresh} onError={setError}/>}
        {section === 'projects' && <>
          <h1>Pipelines</h1>
          <p>Projects group traces and model settings by the client’s <code>project_id</code>. API keys authenticate requests and can be used across projects.</p>
          <form className="create-project" onSubmit={createProject}>
            <label>Project ID<input value={projectName} maxLength={200} required
              onChange={event => setProjectName(event.target.value)}/></label>
            <button className="primary" disabled={busy || !projectName.trim()}>Create project</button>
          </form>
          <p className="muted">Create a project to configure its models before the first lint. Otherwise, the first lint creates it. A rule history parent adds earlier versions of matching rule paths to Rule history.</p>
          <div className="filters"><label>Projects with work submitted using API key<select value={key} onChange={event => void setQuery({key: event.target.value, page: null})}>
            <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label></div>
          {(key ? filteredProjects : projects).length ? <table className="settings-table">
          <thead><tr><th>Project</th><th>Rules</th><th title="Unique lint requests recorded as traces">Requests</th><th>Inherits rule history from</th><th>Models</th></tr></thead>
          <tbody>{(key ? filteredProjects : projects).map(item => <tr key={item.id}>
            <th><Link to={gatewayQuery(tracePath(item.name), {key})}>{item.name}</Link></th>
            <td>{item.rules}</td>
            <td>{item.requests.toLocaleString()}</td>
            <td><select aria-label={`Parent for ${item.name}`} value={item.parent ?? ''} onChange={event => {
              api.request(`/projects/${item.id}/inheritance`, 'PUT', {parent: event.target.value || null})
                .then(refresh).catch(error => setError(error.message));
            }}><option value="">No parent</option>{projects.filter(parent => parent.id !== item.id).map(parent =>
              <option value={parent.name} key={parent.id}>{parent.name}</option>)}</select></td>
            <td><button type="button" onClick={() => void navigate(gatewayQuery(modelsPath(item.id), {key}))}>Configure models</button></td>
          </tr>)}</tbody></table> : <div className="empty">{key ? "No projects have work submitted using this API key." : "No projects yet."}</div>}
          {routingProject && <ModelSettings key={routingProject.id} api={api} project={routingProject}
            close={() => void navigate(gatewayQuery(sectionPaths.projects, {key}))}/>}
        </>}
      </section>
      {section === 'traces' && active && <ReviewPanel key={`${active.id}:${current?.run_id ?? 'all'}`} api={api}
        cell={current} trace={active} mode={mode} close={close}
        refresh={refresh} saveFile={saveFile} saveRange={saveRange} busy={busy}
        language={language ?? languageForPath(active.file_path)}
        onLanguage={syntax => void setQuery({syntax})}
        onMode={changeMode}
        selectedRange={query.range} onRange={range => void setQuery({range: rangeParam(range)})}
        onAllRules={() => open(active, undefined, mode)}/>}

    </main>
  </>;
}

function editRoute(form: FormData, kind: keyof Routing, existing: Provider): ProviderEdit {
  if (form.get(kind + '.reset')) return {reset: true};
  const baseURL = String(form.get(kind + '.base') ?? '').trim();
  const model = String(form.get(kind + '.model') ?? '').trim();
  const secret = String(form.get(kind + '.key') ?? '').trim();
  const tier = form.get(kind + '.tier');
  return {
    ...(baseURL !== existing.base_url ? {base_url: baseURL} : {}),
    ...(model !== existing.model ? {model} : {}),
    ...(secret ? {api_key: secret} : {}),
    ...((tier === 'flex' || tier === 'fast') && tier !== existing.service_tier ? {service_tier: tier} : {}),
  };
}

function ModelSettings({api, project, close}: {api: Api; project: Project; close: () => void}) {
  const [routing, setRouting] = useState<Routing>();
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const path = `/projects/${project.id}/routing`;
  useEffect(() => {
    let mounted = true;
    api.json<Routing>(path).then(value => {if (mounted) setRouting(value);})
      .catch(error => {if (mounted) setError(error.message);});
    return () => {mounted = false;};
  }, [api, path]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!routing) return;
    const form = new FormData(event.currentTarget);
    setError('');
    setSaved(false);
    setPending(true);
    api.json<Routing>(path, 'PUT', {
      decision: editRoute(form, 'decision', routing.decision),
      ranges: editRoute(form, 'ranges', routing.ranges),
    }).then(value => {
      setRouting(value);
      setRevision(number => number + 1);
      setSaved(true);
    }).catch(error => setError(error.message)).finally(() => setPending(false));
  }

  return <section className="model-settings">
    <div className="panel-heading"><h2>Models for {project.name}</h2><button type="button" onClick={close}>Close</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {saved && <p role="status">Model settings saved.</p>}
    {!routing && !error && <p role="status">Loading model settings…</p>}
    {routing && <form key={revision} onSubmit={save}>
      <div className="provider-fields">
        {(['decision', 'ranges'] as const).map(kind => <fieldset key={kind}>
          <legend>{kind === 'decision' ? 'File decisions and adjudication' : 'Candidate ranges'}</legend>
          <label>Provider base URL<input name={kind + '.base'} type="url" required defaultValue={routing[kind].base_url}/></label>
          <label>Model<input name={kind + '.model'} required defaultValue={routing[kind].model}/></label>
          {kind === 'ranges' && <label>Service tier
            <select name={kind + '.tier'} defaultValue={routing.ranges.service_tier ?? 'flex'}>
              <option value="flex">Flex</option>
              <option value="fast">Fast</option>
            </select>
          </label>}
          <label>API key<input name={kind + '.key'} type="password" autoComplete="new-password"
            placeholder={routing[kind].custom_key ? 'Stored project key' : 'Uses gateway key'}/></label>
          {routing[kind].overridden && <label className="inline-check"><input name={kind + '.reset'} type="checkbox"/> Restore gateway defaults</label>}
        </fieldset>)}
      </div>
      <button type="submit" className="primary" disabled={pending}>Save model settings</button>
    </form>}
  </section>;
}

function Keys({api, keys, refresh, onError}: {api: Api; keys: Key[]; refresh: () => void; onError: (value: string) => void}) {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  function create(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    api.json<Key & {secret: string}>('/keys', 'POST', {name: name.trim()}).then(key => {
      setSecret(key.secret);
      setName('');
      refresh();
    }).catch(error => onError(error.message)).finally(() => setPending(false));
  }
  return <>
    <h1>API keys</h1>
    <p>Key names are labels for identifying credentials. The client’s project ID determines where lint traces appear.</p>
    <form className="create-key" onSubmit={create}>
      <label>Key name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
      <button className="primary" disabled={pending || !name.trim()}>Create API key</button>
    </form>
    {secret && <div className="secret">
      <label>Copy this key now. It is shown once.<input readOnly value={secret} onFocus={event => event.target.select()}/></label>
      <button type="button" onClick={() => navigator.clipboard.writeText(secret).catch(error => onError(error.message))}>Copy</button>
      <button type="button" className="quiet" onClick={() => setSecret('')}>Done</button>
    </div>}
    {keys.length ? <table className="settings-table"><thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>{keys.map(key => <tr key={key.id}>
      <th>{key.name}</th><td><code>{key.prefix}…</code></td><td>{key.revoked_at ? 'Revoked' : 'Active'}</td>
      <td>{!key.revoked_at && <button type="button" onClick={() => {
        if (window.confirm(`Revoke ${key.name}? Clients using it will lose access.`)) {
          api.request(`/keys/${key.id}`, 'DELETE').then(refresh).catch(error => onError(error.message));
        }
      }}>Revoke</button>}</td>
    </tr>)}</tbody></table> : <div className="empty">No API keys yet.</div>}
  </>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><NuqsAdapter><App/></NuqsAdapter></BrowserRouter>);

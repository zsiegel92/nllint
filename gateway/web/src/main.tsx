import {DatasetActions, EvalSets} from './evaluation';
import type {Selection} from './evaluation';
import {LabelerSettings} from './agentic';
import {Keys, ModelSettings} from './settings';
import {TraceFilters, traceSearchParams} from './trace-filters';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {useQueryStates} from 'nuqs';
import {BrowserRouter, Link, matchRoutes, useLocation, useNavigate} from 'react-router';
import {NuqsAdapter} from 'nuqs/adapters/react-router/v7';
import {closedReview, exportKinds, findRangesPath, gatewayQuery, modelsPath, navigation, rangeParam, routes, sectionPaths, tracePath} from './navigation';
import {Api} from './api';
import type {Cell, Key, Label, Labeler, Project, Range, ReviewMode, Run, Trace} from './api';
import type {Section} from './navigation';
import {isLanguage, languageForPath} from './code';
import {Matrix, ReviewPanel} from './review';
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
  const section: Section = matched.route.id === 'evals' ? 'evals' : matched.route.id === 'labelers' ? 'labelers' : matched.route.id === 'keys' ? 'keys'
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
    </> : <p role="status"><span className="spinner"/> Looking for possible violations and checking each range…</p>}
    <Link to="/traces">Back to traces</Link>
  </section></main>;
}

function Workspace({api, logout, section, project, traceId, models}: {
  api: Api; logout: () => void; section: Section; project: string; traceId?: string; models?: string;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useQueryStates(navigation, {history: 'push'});
  const {mode, stages, key, rule, rules, exportKind} = query;
  const page = Math.max(0, query.page);
  const selectedTrace = query.reviewTrace ?? (query.run ? traceId : undefined);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [labelers, setLabelers] = useState<Labeler[]>([]);
  const agentBatch = useRef<{stop: boolean} | null>(null);
  const [agentProgress, setAgentProgress] = useState<{done: number; total: number; stopping: boolean}>();
  const [agentSummary, setAgentSummary] = useState('');
  useEffect(() => () => {
    if (agentBatch.current) agentBatch.current.stop = true;
    agentBatch.current = null;
  }, []);
  const [keys, setKeys] = useState<Key[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const routingProject = projects.find(item => String(item.id) === models);
  const [projectName, setProjectName] = useState('');
  const [tracePage, setTracePage] = useState<{path: string; traces: Trace[]; more: boolean}>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [fallbackTrace, setFallbackTrace] = useState<Trace>();
  const refresh = useCallback(() => setReload(value => value + 1), []);
  const close = useCallback(() => {void setQuery(closedReview);}, [setQuery]);

  useEffect(() => {
    let mounted = true;
    Promise.all([api.json<Key[]>('/keys'), api.json<Project[]>('/projects'), api.json<Labeler[]>('/agentic-labelers')])
      .then(([keys, projects, labelers]) => {if (mounted) {setKeys(keys); setProjects(projects); setLabelers(labelers);}})
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
  const traceParams = traceSearchParams(scope, query, {traceId, limit: pageSize, offset: page * pageSize});
  const traceRequest = `/traces?${traceParams}`;
  const data = tracePage?.path === traceRequest ? tracePage : undefined;
  useEffect(() => {
    if (section !== 'traces') return;
    let mounted = true;
    let timer: number;
    function fetchData() {
      api.json<{traces: Trace[]; more: boolean}>(traceRequest).then(next => {
        if (!mounted) return;
        setTracePage({...next, path: traceRequest});
        if (next.traces.some(trace => trace.cells.some(cell => !['ready', 'failed'].includes(cell.stage)))) {
          timer = window.setTimeout(fetchData, 2200);
        }
      }).catch(error => {if (mounted) setError(error.message);});
    }
    fetchData();
    return () => {mounted = false; clearTimeout(timer);};
  }, [api, reload, section, traceRequest]);

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
      if (query.includeAgentic) params.set('include_agentic', 'true');
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

  const selectedLabeler = labelers.find(item => item.id === query.agent) ?? labelers[0];
  const pageSelection = traces.flatMap(trace => trace.matching_run_ids
    .filter(id => trace.cells.some(cell => cell.run_id === id)).map(run_id => ({trace_id: trace.id, run_id})));
  const matchingRuns = [...new Set(pageSelection.map(item => item.run_id))];
  const selectionKey = (item: Selection) => `${item.trace_id}:${item.run_id}`;
  const selected = new Set(selection.map(selectionKey));
  function selectItems(items: Selection[]) {
    setSelection(current => [...new Map([...current, ...items].map(item => [selectionKey(item), item])).values()].slice(0, 250));
  }
  function toggleItem(item: Selection) {
    if (selected.has(selectionKey(item))) {
      setSelection(current => current.filter(entry => selectionKey(entry) !== selectionKey(item)));
    } else selectItems([item]);
  }
  async function runAgent(ids: number[]) {
    if (!selectedLabeler || agentBatch.current || !ids.length) return;
    const batch = {stop: false};
    agentBatch.current = batch;
    const failures: string[] = [];
    setError('');
    setAgentSummary('');
    setAgentProgress({done: 0, total: ids.length, stopping: false});
    let done = 0;
    for (const id of ids) {
      if (batch.stop) break;
      try {
        await api.json(`/runs/${id}/agentic-label`, 'POST', {labeler_id: selectedLabeler.id});
        if (agentBatch.current === batch) refresh();
      } catch (error) {
        failures.push(`Run ${id} · ${(error as Error).message}`);
      }
      if (agentBatch.current !== batch) return;
      done++;
      setAgentProgress({done, total: ids.length, stopping: batch.stop});
    }
    agentBatch.current = null;
    setAgentProgress(undefined);
    const remaining = ids.length - done;
    setAgentSummary(`Labeled ${done - failures.length} of ${ids.length}${failures.length ? ` · ${failures.length} failed` : ''}${remaining ? ` · ${remaining} skipped` : ''}`);
    if (failures.length) setError(failures.join(' | '));
  }

  function stopAgentBatch() {
    if (agentBatch.current) agentBatch.current.stop = true;
    setAgentProgress(progress => progress && {...progress, stopping: true});
  }
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
        <Link to="/pipelines" aria-current={section === 'projects' ? 'page' : undefined}>Projects</Link>
        <Link to="/agentic-labelers" aria-current={section === 'labelers' ? 'page' : undefined}>Agent labelers</Link>
        <Link to="/eval-sets" aria-current={section === 'evals' ? 'page' : undefined}>Evaluation sets</Link>
        <Link to="/api-keys" aria-current={section === 'keys' ? 'page' : undefined}>API keys</Link>
      </nav>
      <button className="quiet" type="button" onClick={logout}>Sign out</button>
    </header>
    <main className={section === 'traces' ? `workspace trace-workspace${active ? ' with-review' : ''}` : 'workspace'}>
      <section className="workspace-main">
        {error && <p role="alert" className="error">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p>}
        {section === 'traces' && <>
          <div className="page-heading">
            <div><h1>{traceId ? 'Trace review' : 'Lint traces'}</h1>
              <p className="muted trace-intro">Each row is a file snapshot. Each rule has its own results for that file.</p></div>
          </div>
          {traceId && <Link to={gatewayQuery(tracePath(project), {...query, ...closedReview, page: null})}>← Project traces</Link>}
          <TraceFilters api={api} query={query} setQuery={setQuery} project={project}
            projects={projects} keys={keys} labelers={labelers} ruleScope={ruleScope.toString()}/>
          <DatasetActions api={api} selection={selection} labelers={labelers} onError={setError}
            matchingOnPage={pageSelection.length} onSelectPage={() => selectItems(pageSelection)} onClear={() => setSelection([])}
            scopeDownload={<div className="export" role="group" aria-label="Project and rule JSONL options">
              <label htmlFor="dataset">Records
              <select id="dataset" value={exportKind} onChange={event => {
                const value = exportKinds.find(kind => kind === event.target.value);
                if (value) void setQuery({exportKind: value});
              }}>
                <option value="files">File decisions</option>
                <option value="ranges">Range examples</option>
                <option value="adjudication">Range annotations</option>
                <option value="annotated">Annotated runs</option>
                <option value="all">All runs</option>
              </select></label>
              <label><input type="checkbox" checked={Boolean(query.includeAgentic)}
                onChange={event => void setQuery({includeAgentic: Number(event.target.checked)})}/>Include agent results</label>
              <button type="button" onClick={download}>Download .jsonl</button>
            </div>}/>
          <div className="matrix-bar">
            <TableStages selected={stages} onChange={stages => void setQuery({stages})}/>
            <div className="trace-table-actions">
              <button className="quiet" type="button" onClick={refresh}>Refresh</button>
              {!traceId && <nav className="pagination" aria-label="Trace pages">
                <button type="button" disabled={!page} onClick={() => void setQuery({page: page - 1})}>← Previous</button>
                <span>Page {page + 1}</span>
                <button type="button" disabled={!data?.more} onClick={() => void setQuery({page: page + 1})}>Next →</button>
              </nav>}
            </div>
          </div>
          <div className="matrix-bar agent-controls">
            {selectedLabeler ? <>
              <label>Labeler to run <select value={selectedLabeler.id} disabled={Boolean(agentProgress)}
                onChange={event => void setQuery({agent: Number(event.target.value)})}>
                {labelers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              <button type="button" disabled={Boolean(agentProgress) || !matchingRuns.length}
                onClick={() => void runAgent(matchingRuns)}>Run on page matches ({matchingRuns.length})</button>
              {agentProgress && <>
                <span role="status">{agentProgress.stopping ? 'Finishing current run' : 'Labeling'} · {agentProgress.done} of {agentProgress.total}</span>
                {agentProgress.total - agentProgress.done > 1 && <button type="button" className="quiet"
                  disabled={agentProgress.stopping} onClick={stopAgentBatch}>Stop after current run</button>}
              </>}
              {agentSummary && <span role="status">{agentSummary}</span>}
            </> : <Link to="/agentic-labelers">Set up an agent labeler</Link>}
          </div>
          {data ? <Matrix selected={selected} onSelect={toggleItem}
            compareLink={trace => gatewayQuery(tracePath(trace.project), {pathContains: trace.file_path, key: String(trace.key_id), sort: 'newest'})}
            runAgent={selectedLabeler ? ids => void runAgent(ids) : undefined} agentBusy={Boolean(agentProgress)} traces={traces} stages={stages} open={open}
            languages={selectedTrace && language ? {[selectedTrace]: language} : {}}
            openFile={trace => open(trace, undefined, 'files')}
            traceLink={trace => gatewayQuery(tracePath(trace.project, trace.id), {...query, ...closedReview, page: null})}
            selectedRules={rules} onRule={version => void setQuery({
              rules: rules.includes(version) ? rules.filter(id => id !== version) : [...rules, version], rule: null, page: null,
            })}/>
            : <p role="status">Loading traces…</p>}
        </>}
        {section === 'evals' && <EvalSets api={api} onError={setError}/>}
        {section === 'labelers' && <LabelerSettings api={api} items={labelers} refresh={refresh} onError={setError}/>}
        {section === 'keys' && <Keys api={api} keys={keys} refresh={refresh} onError={setError}/>}
        {section === 'projects' && <>
          <h1>Projects</h1>
          <p>A project groups lint traces and model settings under the <code>project_id</code> from your lint configuration.</p>
          <form className="create-project" onSubmit={createProject}>
            <label>Project ID<input value={projectName} maxLength={200} required
              onChange={event => setProjectName(event.target.value)}/></label>
            <button className="primary" disabled={busy || !projectName.trim()}>Create project</button>
          </form>
          <p className="muted">The first lint request creates the project automatically. Create it here to choose its models in advance.</p>
          <div className="filters"><label>Filter by API key<select value={key} onChange={event => void setQuery({key: event.target.value, page: null})}>
            <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label></div>
          {(key ? filteredProjects : projects).length ? <table className="settings-table">
          <thead><tr><th>Project</th><th>Rules</th><th title="Unique lint requests recorded as traces">Requests</th><th>Include rule history from</th><th>Models</th></tr></thead>
          <tbody>{(key ? filteredProjects : projects).map(item => <tr key={item.id}>
            <th><Link to={gatewayQuery(tracePath(item.name), {key})}>{item.name}</Link></th>
            <td>{item.rules}</td>
            <td>{item.requests.toLocaleString()}</td>
            <td><select aria-label={`Include rule history from another project for ${item.name}`} value={item.parent ?? ''} onChange={event => {
              api.request(`/projects/${item.id}/inheritance`, 'PUT', {parent: event.target.value || null})
                .then(refresh).catch(error => setError(error.message));
            }}><option value="">This project only</option>{projects.filter(parent => parent.id !== item.id).map(parent =>
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

createRoot(document.getElementById('root')!).render(<BrowserRouter><NuqsAdapter><App/></NuqsAdapter></BrowserRouter>);

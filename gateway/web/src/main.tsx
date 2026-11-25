import {useCallback, useEffect, useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {Api} from './api';
import type {Cell, Key, Label, Mode, Project, Provider, ProviderEdit, Range, Routing, Run, Trace} from './api';
import {Matrix, ReviewPanel} from './review';
import './style.css';

const url = new URLSearchParams(location.search);
const traceId = url.get('traceId');
const findRun = url.get('findRun');
const pageSize = 20;
const issues = {
  all: 'All traces',
  'no-ranges': 'Positive file, no ranges',
  'all-rejected': 'Positive file, all ranges rejected',
  disagreements: 'Human and model disagree',
  'rejected-candidates': 'Rejected candidates',
  unreviewed: 'Unreviewed decisions',
  failed: 'Processing failed',
};

function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const api = useMemo(() => new Api(), []);
  useEffect(() => {
    api.json<{authenticated: boolean}>('/session').then(result => setAuthenticated(result.authenticated)).catch(() => setAuthenticated(false));
  }, [api]);
  if (authenticated === undefined) return <main className="entry"><p role="status">Checking session…</p></main>;
  if (!authenticated) return <Login api={api} login={() => setAuthenticated(true)}/>;
  if (findRun) return <FindRanges api={api} run={findRun}/>;
  return <Workspace api={api} logout={() => {
    api.request('/session', 'DELETE').then(() => setAuthenticated(false));
  }}/>;
}

function Login({api, login}: {api: Api; login: () => void}) {
  const [token, setToken] = useState('');
  const [github, setGithub] = useState<boolean>();
  useEffect(() => {
    api.json<{github: boolean}>('/session/method').then(method => setGithub(method.github))
      .catch(error => setError(error.message));
  }, [api]);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    setWaiting(true);
    api.request('/session', 'POST', {token: token.trim()}).then(login)
      .catch(error => setError(error.message)).finally(() => setWaiting(false));
  }
  const signIn = '/api/session/github/start?' + new URLSearchParams({next: location.pathname + location.search});
  return <main className="entry"><form className="entry-card" onSubmit={submit}>
    <div className="brand"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</div>
    <h1>Sign in</h1>
    {github === true && <a className="primary button-link" href={signIn}>Continue with GitHub</a>}
    {github === false && <>
      <label>Local development token<input type="password" autoComplete="current-password" required
        value={token} onChange={event => setToken(event.target.value)}/></label>
      <button className="primary" disabled={waiting}>Continue</button>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </form></main>;
}

function FindRanges({api, run}: {api: Api; run: string}) {
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function wait(trace: string) {
      const result = await api.json<Run>(`/runs/${encodeURIComponent(run)}`);
      if (!active) return;
      if (result.stage === 'ready') location.replace(`/?traceId=${encodeURIComponent(trace)}&run=${encodeURIComponent(run)}`);
      else if (result.stage === 'failed') {
        throw new Error(`Range processing failed${result.error ? ` (${result.error})` : ''}.`);
      } else timer = window.setTimeout(() => wait(trace).catch(fail), 1400);
    }
    const fail = (error: Error) => {if (active) setError(error.message);};
    api.json<{trace_id: string}>(`/runs/${encodeURIComponent(run)}/find-ranges`, 'POST')
      .then(result => {if (active) return wait(result.trace_id);}).catch(fail);
    return () => {active = false; clearTimeout(timer);};
  }, [api, run, attempt]);

  return <main className="entry"><section className="entry-card">
    <div className="brand"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</div>
    <h1>Finding ranges</h1>
    {error ? <>
      <p role="alert" className="error">{error}</p>
      <button type="button" onClick={() => {setError(''); setAttempt(value => value + 1);}}>Try again</button>
    </> : <p role="status"><span className="spinner"/> Finding and adjudicating candidate ranges…</p>}
    <a href="/">Back to traces</a>
  </section></main>;
}

function Workspace({api, logout}: {api: Api; logout: () => void}) {
  const [section, setSection] = useState<'traces' | 'keys' | 'projects'>('traces');
  const [mode, setMode] = useState<Mode>('adjudication');
  const [issue, setIssue] = useState('all');
  const [key, setKey] = useState('');
  const [project, setProject] = useState('');
  const [rule, setRule] = useState('');
  const [page, setPage] = useState(0);
  const [keys, setKeys] = useState<Key[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filteredProjects, setFilteredProjects] = useState<Project[]>([]);
  const [routingProject, setRoutingProject] = useState<Project>();
  const [projectName, setProjectName] = useState('');
  const [data, setData] = useState<{traces: Trace[]; more: boolean}>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [exportKind, setExportKind] = useState('adjudication');
  const [active, setActive] = useState<{trace: Trace; cell: Cell; range?: Range; view?: Mode}>();
  const opened = useMemo(() => ({value: false}), []);
  const refresh = useCallback(() => setReload(value => value + 1), []);
  const close = useCallback(() => setActive(undefined), []);

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
    return params;
  }, [key, project, rule]);
  useEffect(() => {
    if (section !== 'traces') return;
    let mounted = true;
    let timer: number;
    const params = new URLSearchParams(scope);
    params.set('issue', issue);
    params.set('limit', String(pageSize));
    params.set('offset', String(page * pageSize));
    if (traceId) params.set('trace_id', traceId);
    function fetchData() {
      api.json<{traces: Trace[]; more: boolean}>(`/traces?${params}`).then(next => {
        if (!mounted) return;
        setData(next);
        const wanted = url.get('run');
        if (wanted && !opened.value && next.traces.length) {
          const trace = next.traces[0];
          const cell = trace.cells.find(cell => String(cell.run_id) === wanted);
          if (cell) setActive({trace, cell});
          opened.value = true;
        }
        if (next.traces.some(trace => trace.cells.some(cell => !['ready', 'failed'].includes(cell.stage)))) {
          timer = window.setTimeout(fetchData, 2200);
        }
      }).catch(error => {if (mounted) setError(error.message);});
    }
    fetchData();
    return () => {mounted = false; clearTimeout(timer);};
  }, [api, issue, opened, page, reload, scope, section]);

  function changeMode(next: Mode) {
    setMode(next);
    setActive(current => current ? {...current, view: undefined} : undefined);
  }

  function saveRange(cell: Cell, range: Range, decision: Label) {
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
      setKey('');
      setRoutingProject(created);
      refresh();
    }).catch(error => setError(error.message)).finally(() => setBusy(false));
  }

  async function download() {
    setError('');
    try {
      const params = new URLSearchParams(scope);
      if (traceId) params.set('trace_id', traceId);
      const response = await api.request(`/export/${exportKind}?${params}`);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = `nllint-${exportKind}.jsonl`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      setError((error as Error).message);
    }
  }

  const traces = data?.traces ?? [];
  const current = active && (traces.find(trace => trace.id === active.trace.id)?.cells
    .find(cell => cell.run_id === active.cell.run_id) ?? active.cell);
  const reviewOrder = [...new Map(traces.flatMap(trace =>
    trace.cells.filter(cell => cell.ranges.length).map(cell => [cell.run_id, {trace, cell}] as const)
  )).values()];
  const reviewIndex = active ? reviewOrder.findIndex(item => item.cell.run_id === active.cell.run_id) : -1;
  function adjacent(direction: number) {
    return reviewIndex < 0 ? undefined : reviewOrder[reviewIndex + direction];
  }
  function openAdjacent(direction: number) {
    const next = adjacent(direction);
    if (!next) return;
    const range = direction < 0 ? next.cell.ranges.at(-1) : next.cell.ranges[0];
    setActive({...next, range, view: 'adjudication'});
  }
  return <>
    <header className="topbar">
      <a className="brand" href="/"><img className="brand-icon" src="/favicon.ico" alt=""/> NLLint Gateway</a>
      <nav aria-label="Workspace">
        <button type="button" aria-pressed={section === 'traces'} onClick={() => setSection('traces')}>Traces</button>
        <button type="button" aria-pressed={section === 'projects'} onClick={() => setSection('projects')}>Pipelines</button>
        <button type="button" aria-pressed={section === 'keys'} onClick={() => setSection('keys')}>API keys</button>
      </nav>
      <button className="quiet" type="button" onClick={logout}>Sign out</button>
    </header>
    <main className={active && section === 'traces' ? 'workspace with-review' : 'workspace'}>
      <section className="workspace-main">
        {error && <p role="alert" className="error">{error} <button type="button" onClick={() => setError('')}>Dismiss</button></p>}
        {section === 'traces' && <>
          <div className="page-heading">
            <h1>{traceId ? 'Trace review' : 'Lint traces'}</h1>
            <div className="export">
              <label className="sr-only" htmlFor="dataset">Dataset</label>
              <select id="dataset" value={exportKind} onChange={event => setExportKind(event.target.value)}>
                <option value="adjudication">Adjudication examples</option>
                <option value="files">File decisions</option>
                <option value="ranges">Range examples</option>
              </select>
              <button type="button" onClick={download}>Export JSONL</button>
            </div>
          </div>
          {traceId && <a href="/">← All traces</a>}
          <div className="filters">
            <label>Project<select value={project} onChange={event => {setPage(0); setProject(event.target.value);}}>
              <option value="">All projects</option>{projects.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
            </select></label>
            <label>API key<select value={key} onChange={event => {setPage(0); setKey(event.target.value);}}>
              <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label>Rule path<input value={rule} placeholder="All rules" onChange={event => {setPage(0); setRule(event.target.value);}}/></label>
            <label>Find<select value={issue} onChange={event => {setPage(0); setIssue(event.target.value);}}>
              {Object.entries(issues).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </select></label>
          </div>
          <div className="matrix-bar">
            <div className="segmented">
              <button type="button" aria-pressed={mode === 'files'} onClick={() => changeMode('files')}>File decisions</button>
              <button type="button" aria-pressed={mode === 'adjudication'} onClick={() => changeMode('adjudication')}>Adjudication</button>
              <button type="button" aria-pressed={mode === 'ranges'} onClick={() => changeMode('ranges')}>Ranges</button>
            </div>
            <button className="quiet" type="button" onClick={refresh}>Refresh</button>
          </div>
          {data ? <Matrix traces={traces} mode={mode} open={(trace, cell, range) => setActive({trace, cell, range})}
            save={saveFile} saveRange={saveRange} busy={busy} onRule={path => {setRule(path); setPage(0);}}/>
            : <p role="status">Loading traces…</p>}
          {!traceId && data && <div className="pagination">
            <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>← Previous</button>
            <span>Page {page + 1}</span>
            <button type="button" disabled={!data.more} onClick={() => setPage(page + 1)}>Next →</button>
          </div>}
        </>}
        {section === 'keys' && <Keys api={api} keys={keys} refresh={refresh} onError={setError}/>}
        {section === 'projects' && <>
          <h1>Pipelines</h1>
          <form className="create-project" onSubmit={createProject}>
            <label>Project ID<input value={projectName} maxLength={200} required
              onChange={event => setProjectName(event.target.value)}/></label>
            <button className="primary" disabled={busy || !projectName.trim()}>Create project</button>
          </form>
          <div className="filters"><label>API key<select value={key} onChange={event => setKey(event.target.value)}>
            <option value="">All keys</option>{keys.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label></div>
          {(key ? filteredProjects : projects).length ? <table className="settings-table">
          <thead><tr><th>Project</th><th>Rules</th><th>Inherits rule history from</th><th>Models</th></tr></thead>
          <tbody>{(key ? filteredProjects : projects).map(item => <tr key={item.id}>
            <th><button className="text-button" type="button" onClick={() => {setProject(item.name); setSection('traces'); setPage(0);}}>{item.name}</button></th>
            <td>{item.rules}</td>
            <td><select aria-label={`Parent for ${item.name}`} value={item.parent ?? ''} onChange={event => {
              api.request(`/projects/${item.id}/inheritance`, 'PUT', {parent: event.target.value || null})
                .then(refresh).catch(error => setError(error.message));
            }}><option value="">No parent</option>{projects.filter(parent => parent.id !== item.id).map(parent =>
              <option value={parent.name} key={parent.id}>{parent.name}</option>)}</select></td>
            <td><button type="button" onClick={() => setRoutingProject(item)}>Configure models</button></td>
          </tr>)}</tbody></table> : <div className="empty">No pipelines match the selected key.</div>}
          {routingProject && <ModelSettings key={routingProject.id} api={api} project={routingProject}
            close={() => setRoutingProject(undefined)}/>}
        </>}
      </section>
      {section === 'traces' && active && current && <ReviewPanel key={active.cell.run_id} api={api}
        initial={current} trace={active.trace} initialRange={active.range} mode={active.view ?? mode} close={close}
        refresh={refresh} saveFile={saveFile} busy={busy}
        canGoPrevious={Boolean(adjacent(-1))} canGoNext={Boolean(adjacent(1))} goAdjacent={openAdjacent}/>}
    </main>
  </>;
}

function editRoute(form: FormData, kind: keyof Routing, existing: Provider): ProviderEdit {
  if (form.get(kind + '.reset')) return {reset: true};
  const baseURL = String(form.get(kind + '.base') ?? '').trim();
  const model = String(form.get(kind + '.model') ?? '').trim();
  const secret = String(form.get(kind + '.key') ?? '').trim();
  return {
    ...(baseURL !== existing.base_url ? {base_url: baseURL} : {}),
    ...(model !== existing.model ? {model} : {}),
    ...(secret ? {api_key: secret} : {}),
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

createRoot(document.getElementById('root')!).render(<App/>);

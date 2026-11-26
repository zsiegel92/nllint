import {useEffect, useState} from 'react';
import type {FormEvent} from 'react';
import type {Api, Key, Project, Provider, ProviderEdit, Routing} from './api';

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

export function ModelSettings({api, project, close}: {api: Api; project: Project; close: () => void}) {
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
          <legend>{kind === 'decision' ? 'File and range checks' : 'Range suggestions'}</legend>
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

export function Keys({api, keys, refresh, onError}: {api: Api; keys: Key[]; refresh: () => void; onError: (value: string) => void}) {
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
    <p>Use these keys to connect the CLI, VS Code, or an MCP client. The project ID in your lint settings determines where traces appear.</p>
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

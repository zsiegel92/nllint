import {useState} from 'react';
import type {FormEvent} from 'react';
import {useQueryStates} from 'nuqs';
import {annotationSources} from './api';
import type {Api, Labeler, TraceSelection} from './api';
import {Disclosure} from './disclosure';
import {exportKinds, navigation} from './navigation';

const recordLabels = {
  files: 'File decisions',
  ranges: 'Range examples',
  adjudication: 'Range annotations',
  annotated: 'Annotated runs',
  all: 'All runs',
} as const;

export function TraceExport({api, scope, selection, labelers, onError}: {
  api: Api; scope: URLSearchParams; selection: TraceSelection[];
  labelers: Labeler[]; onError: (message: string) => void;
}) {
  const [query, setQuery] = useQueryStates({
    exportKind: navigation.exportKind, includeAgentic: navigation.includeAgentic,
  }, {history: 'push'});
  const [source, setSource] = useState<'scope' | 'selected'>();
  const [labeler, setLabeler] = useState('');
  const [includeHistory, setIncludeHistory] = useState(false);
  const [includeReview, setIncludeReview] = useState(true);
  const [reviewerOrigin, setReviewerOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = source === undefined ? selection.length > 0 : source === 'selected';
  const includeAgentic = query.includeAgentic === null ? selected : Boolean(query.includeAgentic);

  async function download(event: FormEvent) {
    event.preventDefault();
    if (busy || (selected && !selection.length)) return;
    setBusy(true);
    onError('');
    try {
      const kind = selected ? 'selection' : query.exportKind;
      const params = new URLSearchParams(scope);
      if (includeAgentic) params.set('include_agentic', 'true');
      const path = selected ? '/export/selection' : `/export/${kind}?${params}`;
      const stream = kind === 'all' || kind === 'annotated';
      const payload = selected ? {
        selection, include_agentic: includeAgentic, include_history: includeHistory,
        include_review: includeReview,
        reviewer_origin: includeReview || includeHistory ? reviewerOrigin || null : null,
        agent_labeler_ids: includeAgentic && labeler ? [Number(labeler)] : [],
      } : undefined;
      const link = document.createElement('a');
      link.download = `nllint-${kind}.jsonl`;
      if (stream) {
        link.href = '/api' + path;
      } else {
        const response = await api.request(path, selected ? 'POST' : 'GET', payload);
        const url = URL.createObjectURL(await response.blob());
        link.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      link.click();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <Disclosure label="Export JSONL">
    <form className="trace-export-form" onSubmit={download}>
      <div className="trace-export-fields">
        <label>Export from<select value={selected ? 'selected' : 'scope'} onChange={event =>
          setSource(event.target.value === 'selected' ? 'selected' : 'scope')}>
          <option value="scope">Current project, key, rule, or trace</option>
          <option value="selected">Selected runs ({selection.length})</option>
        </select></label>
        {!selected && <label>Records<select value={query.exportKind} onChange={event => {
          const kind = exportKinds.find(value => value === event.target.value);
          if (kind) void setQuery({exportKind: kind});
        }}>
          {exportKinds.map(kind => <option key={kind} value={kind}>{recordLabels[kind]}</option>)}
        </select></label>}
      </div>
      {!selected && <p className="muted">To export matches from Find or Advanced filters, use <strong>Add page matches</strong> under <strong>Build eval set</strong>.</p>}
      {selected && !selection.length && <p className="muted">Select rule results in the table or use <strong>Add page matches</strong> under <strong>Build eval set</strong>.</p>}
      <div className="trace-export-fields">
        <label className="inline-check"><input type="checkbox" checked={includeAgentic}
          onChange={event => void setQuery({includeAgentic: Number(event.target.checked)})}/>Include agent results</label>
        {selected && includeAgentic && labelers.length > 0 && <label>Agent labeler<select value={labeler}
          onChange={event => setLabeler(event.target.value)}>
          <option value="">All saved labelers</option>
          {labelers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select></label>}
      </div>
      {selected && <div className="trace-export-fields">
        <label className="inline-check"><input type="checkbox" checked={includeReview}
          onChange={event => setIncludeReview(event.target.checked)}/>Include current annotations</label>
        <label className="inline-check"><input type="checkbox" checked={includeHistory}
          onChange={event => setIncludeHistory(event.target.checked)}/>Include annotation history</label>
        {(includeReview || includeHistory) && <label>Annotation source<select value={reviewerOrigin}
          onChange={event => setReviewerOrigin(event.target.value)}>
          <option value="">Any source</option>
          {Object.entries(annotationSources).map(([origin, name]) => <option key={origin} value={origin}>{name}</option>)}
        </select></label>}
      </div>}
      <button className="primary" type="submit" disabled={busy || (selected && !selection.length)}>
        {busy ? 'Preparing download…' : 'Download JSONL'}
      </button>
    </form>
  </Disclosure>;
}

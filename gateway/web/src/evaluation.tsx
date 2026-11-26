import {useEffect, useState} from 'react';
import type {FormEvent, ReactNode} from 'react';
import type {Api, Labeler} from './api';
import {Link} from 'react-router';
import {gatewayQuery, tracePath} from './navigation';
import {RulePicker} from './rule-picker';

export type Selection = {trace_id: string; run_id: number};
type EvalSet = {id: number; name: string; examples: number; baseline_rule_version: string};
type Span = {start: number; end: number};
type Score = {
  file_counts: Record<string, number>;
  exact_range_counts: Record<string, number>;
  exact_range_examples: number;
  file_metrics: Record<string, number | null>;
  exact_range_metrics: Record<string, number | null>;
  examples: {reference_run_id: number; run_id: number | null; path: string; project: string; trace_id: string | null;
    outcome: string; expected: boolean; predicted: boolean | null; range_mismatch: boolean;
    expected_ranges: Span[] | null; predicted_ranges: Span[] | null}[];
  more: boolean;
};

export function DatasetActions({api, selection, labelers, onError, matchingOnPage, onSelectPage, onClear, scopeDownload}: {
  api: Api; selection: Selection[]; labelers: Labeler[]; onError: (message: string) => void;
  matchingOnPage: number; onSelectPage: () => void; onClear: () => void; scopeDownload: ReactNode;
}) {
  const [name, setName] = useState('');
  const [reference, setReference] = useState('');
  const [exportAgent, setExportAgent] = useState('');
  const [includeAgentic, setIncludeAgentic] = useState(true);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [includeReview, setIncludeReview] = useState(true);
  const [reviewerOrigin, setReviewerOrigin] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function freeze(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const examples = [...new Set(selection.map(item => item.run_id))].map(run_id =>
        ({run_id, ...(reference ? {labeler_id: Number(reference)} : {})}));
      const set = await api.json<EvalSet>('/eval-sets', 'POST', {name: name.trim(), examples});
      setName('');
      setStatus(`Saved ${set.examples} examples to ${set.name}`);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const response = await api.request('/export/selection', 'POST', {
        selection, include_agentic: includeAgentic, include_history: includeHistory,
        include_review: includeReview, reviewer_origin: reviewerOrigin || null,
        agent_labeler_ids: exportAgent ? [Number(exportAgent)] : [],
      });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = 'nllint-selection.jsonl';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <details className="dataset-actions">
    <summary>Dataset{selection.length > 0 && ` · ${selection.length} selected`}</summary>
    <section className="selection-section" aria-label="Export JSONL by project and rule">
      <h3>Export JSONL by project and rule</h3>
      <p>Download JSONL for the current project, API key, rule, and trace scope. Use selected traces below to export specific matches from Find or Advanced filters.</p>
      {scopeDownload}
    </section>
    <section className="selection-section" aria-label="Select traces">
      <h3>Select traces · {selection.length} selected</h3>
      <div className="selection-controls">
        <p>Check individual rule cells or add all matches from this page. Your selection carries across pages until you reload.</p>
        <div className="selection-button-group" role="group" aria-label="Manage selected traces">
          <button type="button" disabled={!matchingOnPage || selection.length >= 250} onClick={onSelectPage}>Add page matches</button>
          <button type="button" disabled={!selection.length} onClick={onClear}>Clear selection</button>
        </div>
      </div>
      {selection.length === 250 && <p role="status">Selection limit reached. Export or deselect examples before adding more.</p>}
    </section>
    <section className="selection-section" aria-label="Download selected traces">
      <h3>Export selected traces as JSONL</h3>
      <p>Download the selected trace records and the label sources you choose. This is a file download only.</p>
      <div className="matrix-bar agent-controls">
        <label>Agent results to export<select value={exportAgent} disabled={!includeAgentic} onChange={event => setExportAgent(event.target.value)}>
          <option value="">All saved agents</option>
          {labelers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select></label>
        <label><input type="checkbox" checked={includeAgentic} onChange={event => setIncludeAgentic(event.target.checked)}/>Include agent results</label>
        <label><input type="checkbox" checked={includeReview} onChange={event => setIncludeReview(event.target.checked)}/>Include current reviewer labels</label>
        <label>Reviewer source <select value={reviewerOrigin} onChange={event => setReviewerOrigin(event.target.value)}>
          <option value="">All reviewers</option><option value="human">Any human</option><option value="webapp">Signed browser</option>
          <option value="ide">IDE</option><option value="mcp">External MCP</option><option value="api">External REST</option><option value="legacy">Legacy</option>
        </select></label>
        <label><input type="checkbox" checked={includeHistory} onChange={event => setIncludeHistory(event.target.checked)}/>Include annotation history</label>
        <button type="button" disabled={busy || !selection.length} onClick={() => void download()}>Download .jsonl</button>
      </div>
    </section>
    <section className="selection-section" aria-label="Save an evaluation set">
      <h3>Save an evaluation set</h3>
      <p>Save a named set in the gateway with a copy of the selected labels as expected answers. Use it under Evaluation sets to score future rule revisions against the same answers, even if someone relabels a trace later.</p>
      <p>Choose runs from one baseline rule revision. Each run needs a file annotation or a result from the selected agent.</p>
      <form className="create-project" onSubmit={freeze}>
        <label>Evaluation set name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)}/></label>
        <label>Reference labels<select value={reference} onChange={event => setReference(event.target.value)}>
          <option value="">Current file annotations</option>
          {labelers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}
        </select></label>
        <button className="primary" disabled={busy || !name.trim() || !selection.length}>Save evaluation set</button>
      </form>
      {status && <p role="status">{status} · <Link to="/eval-sets">View evaluation sets</Link></p>}
    </section>
  </details>;
}

const fileLabels: Record<string, string> = {
  tp: 'True positives', fp: 'False positives', tn: 'True negatives', fn: 'False negatives',
  missing: 'Missing', failed: 'Failed', incomplete: 'Incomplete',
};

const metricLabels: Record<string, string> = {precision: 'Precision', recall: 'Recall', f1: 'F1'};
function Metrics({values}: {values: Record<string, number | null>}) {
  return <p>{Object.entries(values).map(([metric, value]) =>
    `${metricLabels[metric]} ${value === null ? '—' : `${(value * 100).toFixed(1)}%`}`).join(' · ')}</p>;
}
function spans(items: Span[] | null) {
  return items?.length ? items.map(item => `L${item.start}${item.end === item.start ? '' : `–${item.end}`}`).join(', ') : '';
}

export function EvalSets({api, onError}: {api: Api; onError: (message: string) => void}) {
  const [sets, setSets] = useState<EvalSet[]>([]);
  const [setId, setSetId] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [threshold, setThreshold] = useState('0.8');
  const [score, setScore] = useState<Score>();
  const [baselineScore, setBaselineScore] = useState<Score>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api.json<EvalSet[]>('/eval-sets').then(rows => {if (active) setSets(rows);})
      .catch(error => {if (active) onError(error.message);});
    return () => {active = false;};
  }, [api, onError]);
  async function evaluate(event: FormEvent) {
    event.preventDefault();
    setScore(undefined);
    setBaselineScore(undefined);
    setBusy(true);
    try {
      const path = `/eval-sets/${setId}/score`;
      const version = versions.at(-1);
      const baseline = sets.find(item => String(item.id) === setId)?.baseline_rule_version;
      const [candidate, original] = await Promise.all([
        api.json<Score>(path, 'POST', {rule_version: version, threshold: Number(threshold)}),
        baseline && baseline !== version
          ? api.json<Score>(path, 'POST', {rule_version: baseline, threshold: Number(threshold), examples: 'none'})
          : undefined,
      ]);
      setScore(candidate);
      setBaselineScore(original);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h1>Evaluation sets</h1>
    <p>Freeze references from a curated trace selection, then score a rule revision on the same source files.</p>
    {sets.length ? <table><thead><tr><th>Set</th><th>Examples</th><th>Download</th></tr></thead>
      <tbody>{sets.map(item => <tr key={item.id}>
        <td>{item.name}</td><td>{item.examples}</td><td><a href={`/api/eval-sets/${item.id}/export`}>Export JSONL</a></td>
      </tr>)}</tbody></table> : <p>No evaluation sets yet.</p>}
    {sets.length > 0 && <form className="create-project" onSubmit={evaluate}>
      <label>Evaluation set<select value={setId} required onChange={event => {
        setSetId(event.target.value); setScore(undefined);
        const baseline = sets.find(item => String(item.id) === event.target.value);
        setVersions(baseline ? [baseline.baseline_rule_version] : []);
      }}>
        <option value="">Choose a set</option>
        {sets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <RulePicker api={api} scope="" selected={versions} onChange={next => {setVersions(next.slice(-1)); setScore(undefined);}}/>
      <label>Range confidence threshold<input type="number" min={0} max={1} step={0.01} required
        value={threshold} onChange={event => {setThreshold(event.target.value); setScore(undefined);}}/></label>
      <button className="primary" disabled={busy || !setId || !versions.length}>Score revision</button>
    </form>}
    {score && <section>
      <h2>File outcomes</h2>
      <dl className="eval-counts">{Object.entries(score.file_counts).map(([key, count]) =>
        <div key={key}><dt>{fileLabels[key]}</dt><dd>{count}</dd>{baselineScore && <small>Baseline {baselineScore.file_counts[key]}</small>}</div>)}</dl>
      <Metrics values={score.file_metrics}/>
      {baselineScore && <div className="muted">Baseline <Metrics values={baselineScore.file_metrics}/></div>}
      <h2>Exact range outcomes</h2>
      <p>{score.exact_range_examples} evaluated examples with complete reference ranges</p>
      <dl className="eval-counts">{Object.entries(score.exact_range_counts).map(([key, count]) =>
        <div key={key}><dt>{fileLabels[key]}</dt><dd>{count}</dd>{baselineScore && <small>Baseline {baselineScore.exact_range_counts[key]}</small>}</div>)}</dl>
      <Metrics values={score.exact_range_metrics}/>
      {baselineScore && <div className="muted">Baseline <Metrics values={baselineScore.exact_range_metrics}/></div>}
      {score.examples.length > 0 && <table><thead><tr><th>File</th><th>Outcome</th><th>Expected</th><th>Pipeline</th></tr></thead><tbody>
        {score.examples.map(example => <tr key={example.reference_run_id}>
          <td>{example.trace_id && example.run_id
            ? <Link to={gatewayQuery(tracePath(example.project, example.trace_id), {run: example.run_id, mode: 'ranges'})}>{example.path}</Link>
            : example.path}</td>
          <td>{example.range_mismatch && ['tp', 'tn'].includes(example.outcome) ? 'Range mismatch' : fileLabels[example.outcome] ?? example.outcome}</td>
          <td>{example.expected ? 'Violation' : 'Clean'} <small>{spans(example.expected_ranges)}</small></td>
          <td>{example.predicted == null ? 'Unavailable' : example.predicted ? 'Violation' : 'Clean'} <small>{spans(example.predicted_ranges)}</small></td>
        </tr>)}
      </tbody></table>}
      {score.more && <p>Showing the first {score.examples.length} mismatches.</p>}
    </section>}
  </>;
}

import {AgentResults} from './agentic';
import {useEffect, useMemo, useState} from 'react';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import {Eye, Pencil} from 'lucide-react';
import {Link} from 'react-router';
import {CodeBlock, highlightLines, languageForPath} from './code';
import type {Language} from './code';
import {findRangesPath, rangeParam} from './navigation';
import {ReviewStages} from './stage-selector';
import {LabelButtons, RangeLink, rangeStatus, SourceReview} from './source-review';
import type {SaveRange} from './source-review';
import {Api, attribution, label, probability} from './api';
import type {Cell, History, Label, Mode, ProviderHistory, Range, ReviewMode, Run, Trace} from './api';

function Verdict({decision, confidence}: {decision: Label; confidence?: number | null}) {
  return <span className={`badge ${decision === null ? 'neutral' : decision ? 'violation' : 'clear'}`}>
    {label(decision)}{confidence == null ? '' : ` · ${probability(confidence)}`}
  </span>;
}

function Stage({cell}: {cell: Cell}) {
  return <span className={`badge ${cell.stage === 'failed' ? 'violation' : 'neutral'}`}>
    {{file: 'Checking file', ranges: 'Finding ranges', adjudication: 'Adjudicating', failed: 'Failed', ready: 'No decision'}[cell.stage]}
  </span>;
}

function FileVerdict({cell}: {cell: Cell}) {
  return cell.file_decision === null ? <Stage cell={cell}/> : <Verdict decision={cell.file_decision} confidence={cell.file_confidence}/>;
}

type OpenReview = (trace: Trace, cell: Cell, view: ReviewMode, range?: Range) => void;
type SetFileLabel = (cell: Cell, decision: Label, rejectAll?: boolean) => void;

function FileFollowup({cell, save, busy}: {cell: Cell; save: SetFileLabel; busy: boolean}) {
  return <div className="review-rule-followup">
    {cell.file_decision === true && cell.file_label === false && cell.ranges.some(range => range.candidate) &&
      <button type="button" className="quiet" disabled={busy}
        onClick={() => save(cell, false, true)}>Mark all {cell.ranges.filter(range => range.candidate).length} snippets as no violation</button>}
    {cell.file_decision === false && cell.file_label === true &&
      <a href={findRangesPath(cell.run_id)} target="_blank" rel="noopener noreferrer">Find and annotate ranges ↗</a>}
  </div>;
}

function RangeStageCard({trace, cell, adjudicated, open, language}: {
  trace: Trace; cell: Cell; adjudicated?: boolean; open: OpenReview; language: Language;
}) {
  const ranges = adjudicated ? cell.ranges.filter(range => range.model_decision !== null) : cell.ranges;
  const inProgress = adjudicated ? cell.stage === 'adjudication' : cell.stage === 'ranges';
  const discoveryEmpty = !adjudicated && cell.ranges_checked && !cell.ranges.some(range => range.candidate);
  if (!ranges.length && !inProgress && !discoveryEmpty) return null;
  return <section className="stage-card">
    <div className="stage-card-heading">
      <strong>{adjudicated ? 'Snippet Adjudication' : 'Ranges'}</strong>
      <button type="button" className="icon-action" aria-label={`View ${adjudicated ? 'adjudication' : 'ranges'} for ${cell.rule_id}`}
        onClick={() => open(trace, cell, 'ranges')}><Eye size={15} aria-hidden="true"/></button>
    </div>
    {inProgress && <small><Stage cell={cell}/></small>}
    {discoveryEmpty && <small>No candidate ranges</small>}
    {ranges.map(range => <div className="stage-range" key={rangeParam(range)}>
      <RangeLink range={range} cell={cell} onClick={() => open(trace, cell, 'ranges', range)}/>
      <small>{adjudicated || !range.candidate ? rangeStatus(range) : 'Candidate range'}
        {(adjudicated || !range.candidate) && range.annotation !== null ? ` · ${attribution(range.labeler_identity)}: ${label(range.annotation)}` : ''}</small>
      {adjudicated && range.preview && <CodeBlock source={range.preview} language={language}/>}
    </div>)}
  </section>;
}

export function Matrix({traces, stages, open, openFile, onRule, languages, traceLink, selectedRules, runAgent, agentBusy}: {
  traces: Trace[]; stages: Mode[]; open: OpenReview; openFile: (trace: Trace) => void;
  languages: Partial<Record<string, Language>>; traceLink: (trace: Trace) => string;
  runAgent?: (ids: number[]) => void; agentBusy: boolean;
  onRule: (version: string) => void; selectedRules: string[];
}) {
  if (!traces.length) return <div className="empty">No traces match these filters.</div>;
  const columns = [...new Map(traces.flatMap(trace => trace.cells.map(cell =>
    [cell.rule_version, {...cell, project: trace.project}] as const))).values()]
    .sort((left, right) => left.rule_id.localeCompare(right.rule_id) || left.rule_path.localeCompare(right.rule_path));
  return <div className="table-scroll"><table>
    <thead><tr><th scope="col">File</th>{columns.map(column =>
      <th scope="col" key={column.rule_version}>
        <button type="button" className="column-rule" aria-pressed={selectedRules.includes(column.rule_version)}
          onClick={() => onRule(column.rule_version)} title={column.rule_path}>{column.rule_id}</button>
        <small>{column.rule_path} · {column.rule_hash.slice(0, 8)}</small>
        <small>{column.project}</small>
      </th>)}</tr></thead>
    <tbody>{traces.map(trace => <tr key={trace.id}>
      <th scope="row">
        <Link className="file-name" to={traceLink(trace)}>{trace.file_path}</Link>
        <button type="button" className="text-button" aria-label={`View file ${trace.file_path}`}
          onClick={() => openFile(trace)}>View file</button>
        {runAgent && <button type="button" disabled={agentBusy} onClick={() => runAgent([...new Set(trace.cells.map(cell => cell.run_id))])}>Label all file rules</button>}
        <small>{trace.project} · {trace.key_name}</small>
        <small>Score {trace.score} · {new Date(trace.created_at).toLocaleString()}</small>
      </th>
      {columns.map(column => {
        const cell = trace.cells.find(item => item.rule_version === column.rule_version);
        if (!cell) return <td key={column.rule_version} className="void-cell">—</td>;
        const language = languages[trace.id] ?? languageForPath(trace.file_path);
        return <td key={column.rule_version}>
          {stages.includes('files') && <section className="stage-card">
            <div className="stage-card-heading"><strong>Pipeline · File</strong>
              <button type="button" className="icon-action" aria-label={`Review file decision for ${cell.rule_id}`}
                onClick={() => open(trace, cell, 'files')}><Pencil size={14} aria-hidden="true"/></button></div>
            <FileVerdict cell={cell}/>
            {cell.file_label !== null && <small>{attribution(cell.labeler_identity)} · {label(cell.file_label)}</small>}
          </section>}
          {stages.includes('ranges') && <RangeStageCard trace={trace} cell={cell} language={language} open={open}/>}
          {stages.includes('adjudication') && <RangeStageCard trace={trace} cell={cell} language={language} open={open} adjudicated/>}
          <AgentResults cell={cell} open={range => open(trace, cell, 'ranges', range)}/>
          {runAgent && <button type="button" disabled={agentBusy} onClick={() => runAgent([cell.run_id])}>Label this rule</button>}
        </td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

function ProviderRequestList({history}: {history: ProviderHistory}) {
  return <section>
    <p>Settings version {history.settings_version_id}</p>
    {(['decision', 'ranges'] as const).map(kind => <div key={kind}>
      <strong>{kind === 'decision' ? 'Decisions' : 'Ranges'}</strong>
      {' · '}{history.settings[kind].model}
      {history.settings[kind].service_tier && ` · ${history.settings[kind].service_tier}`}
      <small> {history.settings[kind].base_url}</small>
    </div>)}
    {history.requests.length === 0 && <p className="muted">No provider requests recorded for this run.</p>}
    {history.requests.map(item => <details key={item.id}>
      <summary>{({file: 'File decision', ranges: 'Range discovery', adjudication: 'Snippet adjudication'})[item.stage]}
        {' · '}{item.reused ? 'Reused request' : (item.http_status ?? item.transport_error ?? 'Outcome pending')}
        {' · '}{new Date(item.started_at).toLocaleString()}</summary>
      {item.resolved_model && <div>Served by {item.resolved_model}{item.resolved_service_tier && ` · ${item.resolved_service_tier}`}</div>}
      {item.question_count !== null && <div>Questions sent {item.question_count}</div>}
      {item.usage && <CodeBlock source={JSON.stringify(item.usage, null, 2)} language="json"/>}
    </details>)}
  </section>;
}

const ruleDetailLabels = {definition: 'Rule', history: 'Rule history', provider: 'Provider requests'} as const;
type RuleDetail = keyof typeof ruleDetailLabels;

function RuleDetails({api, trace, cell, tab, refresh}: {api: Api; trace: Trace; cell: Cell; tab: RuleDetail; refresh: () => void}) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState('');
  const [history, setHistory] = useState<History[]>();
  const [provider, setProvider] = useState<ProviderHistory>();
  useEffect(() => {
    if (tab === 'history') return;
    let active = true;
    api.json<Run>(`/runs/${cell.run_id}`).then(result => {if (active) setRun(result);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, cell.run_id, tab]);

  useEffect(() => {
    let active = true;
    if (tab === 'history') {
      api.json<History[]>(`/history?${new URLSearchParams({project_id: String(trace.project_id), rule: cell.rule_path})}`)
        .then(result => {if (active) setHistory(result);})
        .catch(error => {if (active) setError(error.message);});
    } else if (tab === 'provider') {
      api.json<ProviderHistory>(`/runs/${cell.run_id}/provider-requests`)
        .then(result => {if (active) setProvider(result);})
        .catch(error => {if (active) setError(error.message);});
    }
    return () => {active = false;};
  }, [api, cell.run_id, cell.rule_path, tab, trace.project_id]);

  const otherVersions = history?.filter(item => item.rule_hash !== cell.rule_hash);
  return <div className="rule-card-content">
    {tab === 'provider' && run?.langfuse_url && <a href={run.langfuse_url} target="_blank" rel="noreferrer">Langfuse ↗</a>}
    {error && <p role="alert" className="error">{error}</p>}
    {cell.stage === 'failed' && <div className="error">Processing failed{cell.error ? ` · ${cell.error}` : ''}. <button type="button"
      onClick={() => api.json(`/runs/${cell.run_id}/retry`, 'POST').then(refresh).catch(error => setError(error.message))}>Retry</button></div>}
    {tab === 'definition' && (run ? <CodeBlock source={run.rule} language="markdown"/> : <p role="status">Loading rule…</p>)}
    {tab === 'history' && (otherVersions ? (otherVersions.length > 0
      ? otherVersions.map(item => <details key={`${item.project}-${item.rule_hash}`}>
        <summary>{item.project} · {new Date(item.first_seen).toLocaleDateString()} · {item.rule_hash.slice(0, 8)}</summary>
        <CodeBlock source={item.rule} language="markdown"/>
      </details>) : <p className="muted">Only the current version is recorded.</p>)
      : <p role="status">Loading rule history…</p>)}
    {tab === 'provider' && (provider ? <ProviderRequestList history={provider}/> : <p role="status">Loading requests…</p>)}
  </div>;
}

function RuleCard({api, trace, cell, focused, canAnnotate, saveFile, busy, refresh}: {
  api: Api; trace: Trace; cell: Cell; focused: boolean; canAnnotate: boolean;
  saveFile: SetFileLabel; busy: boolean; refresh: () => void;
}) {
  const [tab, setTab] = useState<RuleDetail | ''>(focused ? 'definition' : '');
  return <section className="review-rule">
    <div className="review-rule-header">
      <div className="review-rule-summary">
        <span className="review-rule-name"><strong>{cell.rule_id}</strong><small>{cell.rule_path}</small></span>
        <span>Pipeline <FileVerdict cell={cell}/></span>
        {cell.file_label !== null && <small>{attribution(cell.labeler_identity)} · {label(cell.file_label)}</small>}
        {canAnnotate && <LabelButtons active={cell.file_label} disabled={busy} save={decision => saveFile(cell, decision)}/>}
      </div>
      <ToggleGroup.Root className="rule-detail-pills" type="single" value={tab}
        aria-label={`Details for ${cell.rule_id}`} onValueChange={value => setTab(value as RuleDetail | '')}>
        {Object.entries(ruleDetailLabels).map(([value, title]) =>
          <ToggleGroup.Item key={value} value={value}>{title}</ToggleGroup.Item>)}
      </ToggleGroup.Root>
    </div>
    {canAnnotate && <FileFollowup cell={cell} save={saveFile} busy={busy}/>}
    <AgentResults cell={cell}/>
    {tab && <RuleDetails key={tab} api={api} trace={trace} cell={cell} tab={tab} refresh={refresh}/>}
  </section>;
}

export function ReviewPanel({api, trace, cell, mode, close, refresh, saveFile, saveRange, busy, language, onLanguage, onMode, selectedRange, onRange, onAllRules}: {
  api: Api; trace: Trace; cell?: Cell; mode: ReviewMode; close: () => void;
  refresh: () => void; saveFile: SetFileLabel; saveRange: SaveRange; busy: boolean;
  language: Language; onLanguage: (language: Language) => void;
  onMode: (mode: ReviewMode) => void; selectedRange: string | null; onRange: (range: Range) => void;
  onAllRules: () => void;
}) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState('');
  const cells = useMemo(() => cell ? [cell] : trace.cells, [cell, trace.cells]);
  const lines = useMemo(() => highlightLines(source ?? '', language), [source, language]);

  useEffect(() => {
    let active = true;
    api.json<{source: string}>(`/traces/${encodeURIComponent(trace.id)}/source`)
      .then(result => {if (active) setSource(result.source);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, trace.id]);

  return <aside className="review-panel" aria-label="Review">
    <div className="panel-heading">
      <div><small>{trace.project}</small><h2>{trace.file_path}</h2>{cell && <small>{cell.rule_id}</small>}</div>
      <button type="button" className="close" aria-label="Close review" onClick={close}>×</button>
    </div>
    <div className="panel-heading">
      <ReviewStages mode={mode} onChange={onMode}/>
      {cell && <button type="button" className="text-button" onClick={onAllRules}>All rules</button>}
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {source === undefined && !error && <p role="status">Loading source…</p>}
    {source !== undefined && <SourceReview key={mode} title={trace.file_path} lines={lines}
      cells={mode === 'ranges' ? cells : []} language={language} onLanguage={onLanguage}
      focus={mode === 'ranges' && cell ? selectedRange ?? undefined : undefined}
      onFocus={cell && mode === 'ranges' ? onRange : undefined} save={mode === 'ranges' ? saveRange : undefined} busy={busy}/>}
    {mode === 'ranges' && cells.every(item => !item.ranges.length && !item.agentic_labels.some(agent => agent.ranges.length)) &&
      <p className="muted">{cells.some(item => item.stage !== 'ready' && item.stage !== 'failed') ? 'Ranges are still processing.' : 'No ranges recorded.'}</p>}
    {cells.map(item => <RuleCard key={item.run_id} api={api} trace={trace} cell={item} focused={Boolean(cell && mode === 'files')}
      canAnnotate={mode === 'files'} saveFile={saveFile} busy={busy} refresh={refresh}/>)}
  </aside>;
}

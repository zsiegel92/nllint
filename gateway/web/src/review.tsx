import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {CodeBlock, CodeExcerpt, CodeTokens, highlightLines, languageForPath, SyntaxPicker} from './code';
import type {HighlightedLine, Language} from './code';
import {Link} from 'react-router';
import {findRangesPath, rangeParam} from './navigation';
import {Api, label, probability, rangeText} from './api';
import type {Cell, History, Label, Mode, ProviderHistory, Range, Run, Trace} from './api';

export function Verdict({decision, confidence}: {decision: Label; confidence?: number | null}) {
  return <span className={`badge ${decision === null ? 'neutral' : decision ? 'violation' : 'clear'}`}>
    {label(decision)}{confidence == null ? '' : ` · ${probability(confidence)}`}
  </span>;
}

export function LabelButtons({active, save, disabled}: {active: Label; save: (label: Label) => void; disabled?: boolean}) {
  return <div className="label-buttons">
    <button type="button" title="Mark no violation" aria-label="Mark no violation" aria-pressed={active === false}
      disabled={disabled} onClick={() => save(false)}>× <span>No violation</span></button>
    <button type="button" title="Mark violates" aria-label="Mark violates" aria-pressed={active === true}
      disabled={disabled} onClick={() => save(true)}>✓ <span>Violates</span></button>
    {active !== null && <button type="button" className="quiet" disabled={disabled} onClick={() => save(null)}>Clear</button>}
  </div>;
}

function Stage({cell}: {cell: Cell}) {
  if (cell.stage === 'ready') return null;
  return <span className={`badge ${cell.stage === 'failed' ? 'violation' : 'neutral'}`}>
    {{file: 'Checking file', ranges: 'Finding ranges', adjudication: 'Adjudicating', failed: 'Failed'}[cell.stage]}
  </span>;
}

function RangeChip({range, open}: {range: Range; open: () => void}) {
  const agreement = range.model_decision !== null && range.annotation !== null
    ? range.model_decision === range.annotation ? 'agree' : 'disagree' : '';
  return <button type="button" title={`Model: ${range.model_decision === null ? 'No decision' : label(range.model_decision)}. Human: ${label(range.annotation)}.`}
    className={`range-chip ${range.model_decision === null ? 'neutral' : range.model_decision ? 'violation' : 'clear'} ${agreement}`}
    onClick={open}>
    {rangeText(range)} {agreement === 'agree' ? '✓' : agreement === 'disagree' ? '×' : ''}
    {!range.candidate ? ' · Human' : ''}
  </button>;
}

type OpenReview = (trace: Trace, cell: Cell, range?: Range) => void;
type SetFileLabel = (cell: Cell, decision: Label, rejectAll?: boolean) => void;

function FileCell({cell, save, busy}: {cell: Cell; save: SetFileLabel; busy: boolean}) {
  return <>
    {cell.file_decision === null ? <Stage cell={cell}/> : <Verdict decision={cell.file_decision} confidence={cell.file_confidence}/>}
    <LabelButtons active={cell.file_label} disabled={busy} save={decision => save(cell, decision)}/>
    {cell.file_decision === true && cell.file_label === false && cell.ranges.some(range => range.candidate) &&
      <button type="button" className="quiet" disabled={busy}
        onClick={() => save(cell, false, true)}>Mark all {cell.ranges.filter(range => range.candidate).length} snippets as no violation</button>}
    {cell.file_decision === false && cell.file_label === true &&
      <a href={findRangesPath(cell.run_id)} target="_blank" rel="noopener noreferrer">Find and annotate ranges ↗</a>}
  </>;
}

export function Matrix({traces, mode, open, openFile, save, saveRange, busy, onRule, languages, traceLink}: {
  traces: Trace[]; mode: Mode; open: OpenReview; openFile: (trace: Trace, cell: Cell) => void;
  languages: Partial<Record<string, Language>>; traceLink: (trace: Trace) => string; save: SetFileLabel; saveRange: (cell: Cell, range: Range, decision: Label) => void; busy: boolean; onRule: (rule: string) => void;
}) {
  if (!traces.length) return <div className="empty">No traces match these filters.</div>;
  const columns = [...new Set(traces.flatMap(trace => trace.cells.map(cell => cell.rule_path)))].sort();
  return <div className="table-scroll"><table>
    <thead><tr><th scope="col">File</th>{columns.map(column =>
      <th scope="col" key={column}><button type="button" className="column-rule" onClick={() => onRule(column)}
        title={column}>{column.split('/').at(-1)}</button><small>{column}</small></th>)}</tr></thead>
    <tbody>{traces.map(trace => <tr key={trace.id}>
      <th scope="row">
        <Link className="file-name" to={traceLink(trace)}>{trace.file_path}</Link>
        {trace.cells[0] && <button type="button" className="text-button"
          aria-label={`View file ${trace.file_path}`} onClick={() => openFile(trace, trace.cells[0])}>View file</button>}
        <small>{trace.project} · {trace.key_name}</small>
        <small>{new Date(trace.created_at).toLocaleString()}</small>
      </th>
      {columns.map(column => {
        const cell = trace.cells.find(item => item.rule_path === column);
        if (!cell) return <td key={column} className="void-cell">—</td>;
        return <td key={column}>
          {mode === 'files' ? <FileCell cell={cell} save={save} busy={busy}/> : <>
            <Stage cell={cell}/>
            {mode === 'adjudication' ? <div className="snippet-stack">
              {cell.ranges.slice(0, 8).map(range => <div className="snippet-card" key={rangeText(range)}>
                <RangeChip range={range} open={() => open(trace, cell, range)}/>
                {range.preview && <CodeBlock source={range.preview} language={languages[trace.id] ?? languageForPath(trace.file_path)}/>}
                <LabelButtons active={range.annotation} disabled={busy} save={decision => saveRange(cell, range, decision)}/>
              </div>)}
              {cell.ranges.length > 8 && <button type="button" className="text-button" onClick={() => open(trace, cell)}>
                View all {cell.ranges.length} ranges
              </button>}
            </div> : <div className="range-chips">{cell.ranges.map(range =>
              <RangeChip key={rangeText(range)} range={range} open={() => open(trace, cell, range)}/>)}</div>}
            {cell.stage === 'ready' && !cell.ranges.length && <div className="muted">No candidate ranges</div>}
          </>}
          <button type="button" className="text-button" onClick={() => open(trace, cell)}>Open review ↗</button>
        </td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

function SourceRanges({lines, ranges, selected, select, save, busy, title}: {
  lines: HighlightedLine[]; ranges: Range[]; selected?: Range; select?: (range: Range) => void;
  title: string; save?: (start: number, end: number, decision: Label) => void; busy?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<{start: number; end: number}>();
  const drag = useRef<number | null>(null);
  const source = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) source.current?.querySelector(`[data-line="${selected.start}"]`)?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [selected?.start, lines.length]);

  function move(event: ReactPointerEvent) {
    if (drag.current === null) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-line]');
    const line = Number(target?.dataset.line);
    if (line > 0) setSelection({start: Math.min(line, drag.current), end: Math.max(line, drag.current)});
  }

  return <section className="source-panel">
    <div className="source-tools">
      <h3>{title}</h3>
      {save && <button type="button" onClick={() => {setAdding(!adding); setSelection(undefined);}}>
        {adding ? 'Cancel' : '+ Add range'}
      </button>}
    </div>
    {adding && save && <div className="range-instructions">
      {selection ? <>
        <strong>{rangeText(selection)}</strong>
        <LabelButtons active={null} disabled={busy} save={decision => {
          save(selection.start, selection.end, decision);
          setAdding(false);
          setSelection(undefined);
        }}/>
      </> : 'Drag in the line-number gutter to select a range, or use the start and end fields.'}
      <div className="line-fields">
        <label>Start <input type="number" min="1" max={lines.length} value={selection?.start ?? ''}
          onChange={event => {const start = Math.max(1, Math.min(lines.length, Number(event.target.value)));
            setSelection({start, end: Math.max(start, selection?.end ?? start)});}}/></label>
        <label>End <input type="number" min={selection?.start ?? 1} max={lines.length} value={selection?.end ?? ''}
          onChange={event => {const start = selection?.start ?? 1;
            setSelection({start, end: Math.max(start, Math.min(lines.length, Number(event.target.value)))});}}/></label>
      </div>
    </div>}
    <div className={`source ${adding ? 'adding' : ''}`} ref={source} onPointerMove={move}
      onPointerUp={() => {drag.current = null;}} onPointerCancel={() => {drag.current = null;}}>
      {lines.map((tokens, index) => {
        const line = index + 1;
        const regions = ranges.filter(range => range.start <= line && range.end >= line);
        const top = regions.find(range => selected && range.start === selected.start && range.end === selected.end) ?? regions[0];
        const marked = selection && selection.start <= line && line <= selection.end;
        const focused = selected && selected.start <= line && line <= selected.end;
        const status = top?.model_decision == null ? 'neutral' : top.model_decision ? 'violation' : 'clear';
        const agreement = top?.annotation != null && top.model_decision !== null
          ? top.annotation === top.model_decision ? 'agree' : 'disagree' : '';
        return <div key={line} data-line={line}
          className={`source-line ${top ? status : ''} ${agreement} ${marked ? 'marked' : ''} ${focused ? 'focused-range' : ''} ${top && !top.candidate ? 'human-only' : ''}`}>
          {save ? <button type="button" className="gutter" aria-label={`Line ${line}`} tabIndex={top && !adding ? 0 : -1}
            onPointerDown={event => {
              if (!adding || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = line;
              setSelection({start: line, end: line});
            }}
            onClick={() => {if (!adding && top) select?.(top);}}>{line}</button>
            : <span className="gutter" aria-hidden="true">{line}</span>}
          <code className="syntax-code">{tokens.length ? <CodeTokens line={tokens}/> : ' '}</code>
          {save && top && line === top.start && !adding && <div className="line-actions">
            <button type="button" disabled={busy} title="Mark no violation" aria-label={`Mark ${rangeText(top)} no violation`}
              onClick={() => save(top.start, top.end, false)}>×</button>
            <button type="button" disabled={busy} title="Mark violates" aria-label={`Mark ${rangeText(top)} violates`}
              onClick={() => save(top.start, top.end, true)}>✓</button>
          </div>}
          {top && agreement && !adding && <span className="margin-mark" aria-label={agreement}>{agreement === 'agree' ? '✓' : '×'}</span>}
        </div>;
      })}
      {lines.length === 0 && <p className="muted">This file is empty.</p>}
    </div>
  </section>;
}

export function ReviewPanel({api, initial, trace, mode, close, refresh, saveFile, busy, canGoPrevious, canGoNext, goAdjacent, language, onLanguage, onMode, selectedRange, onRange, showContext, onContext, showRuleHistory, onRuleHistory, showProviderHistory, onProviderHistory}: {
  api: Api; initial: Cell; trace: Trace; mode: Mode; close: () => void;
  refresh: () => void; saveFile: SetFileLabel; busy: boolean;
  canGoPrevious: boolean; canGoNext: boolean; goAdjacent: (direction: number) => void;
  language: Language; onLanguage: (language: Language) => void;
  onMode: (mode: Mode) => void; selectedRange: string | null; onRange: (range: Range) => void;
  showContext: boolean; onContext: (show: boolean) => void;
  showRuleHistory: boolean; onRuleHistory: (show: boolean) => void;
  showProviderHistory: boolean; onProviderHistory: (show: boolean) => void;
}) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [history, setHistory] = useState<History[]>();
  const [providerHistory, setProviderHistory] = useState<ProviderHistory>();
  const [reload, setReload] = useState(0);
  const swipe = useRef<{x: number; y: number} | null>(null);

  useEffect(() => {
    if (!showRuleHistory) return;
    let active = true;
    api.json<History[]>(`/history?${new URLSearchParams({project_id: String(trace.project_id), rule: initial.rule_path})}`)
      .then(result => {if (active) setHistory(result);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, showRuleHistory, trace.project_id, initial.rule_path]);

  useEffect(() => {
    if (!showProviderHistory) return;
    let active = true;
    api.json<ProviderHistory>(`/runs/${initial.run_id}/provider-requests`)
      .then(result => {if (active) setProviderHistory(result);})
      .catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, showProviderHistory, initial.run_id]);

  useEffect(() => {
    let active = true;
    api.json<Run>(`/runs/${initial.run_id}`).then(data => {
      if (active) setRun(data);
    }).catch(error => {if (active) setError(error.message);});
    return () => {active = false;};
  }, [api, initial, reload]);

  function save(start: number, end: number, decision: Label) {
    setPending(true);
    setError('');
    api.range(initial.pair_id, start, end, decision).then(() => {
      setReload(value => value + 1);
      refresh();
    }).catch(error => setError(error.message)).finally(() => setPending(false));
  }

  const source = run?.source ?? '';
  const sourceLines = useMemo(() => highlightLines(source, language), [source, language]);
  const range = run?.ranges.find(item => rangeParam(item) === selectedRange) ?? run?.ranges[0];
  const index = run && range ? run.ranges.indexOf(range) : -1;
  const step = useCallback((amount: number) => {
    if (run?.ranges[index + amount]) onRange(run.ranges[index + amount]);
    else goAdjacent(amount);
  }, [run, index, goAdjacent, onRange]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || mode !== 'adjudication') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [close, step, mode]);

  return <aside className="review-panel" aria-label="Review">
    <div className="panel-heading"><div><small>{trace.project} / {trace.file_path}</small><h2>{initial.rule_id}</h2></div>
      <button type="button" className="close" aria-label="Close review" onClick={close}>×</button></div>
    <div className="segmented">
      <button type="button" aria-pressed={mode === 'files'} onClick={() => onMode('files')}>File</button>
      <button type="button" aria-pressed={mode === 'adjudication'} onClick={() => onMode('adjudication')}>Adjudication</button>
      <button type="button" aria-pressed={mode === 'ranges'} onClick={() => onMode('ranges')}>Ranges</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    {!run && !error && <p role="status">Loading review…</p>}
    {run && <>
      {run.stage === 'failed' && <div className="error">
        Processing failed{run.error ? ` · ${run.error}` : ''}. <button type="button" disabled={pending} onClick={() => {
          setPending(true);
          api.json(`/runs/${run.run_id}/retry`, 'POST').then(() => {setReload(value => value + 1); refresh();})
            .catch(error => setError(error.message)).finally(() => setPending(false));
        }}>Retry</button>
      </div>}
      <SyntaxPicker language={language} onChange={onLanguage}/>
      {mode === 'files' && <>
        <div className="file-review"><FileCell cell={run} save={saveFile} busy={busy}/></div>
        <SourceRanges lines={sourceLines} ranges={[]} title={run.file_path}/>
      </>}
      <details className="rule-text" open={mode === 'adjudication'}><summary>{run.rule_path}</summary><CodeBlock source={run.rule} language="markdown"/></details>
      <div className="panel-links">
        {run.langfuse_url && <a href={run.langfuse_url} target="_blank" rel="noreferrer">Langfuse ↗</a>}
        <button className="text-button" type="button" onClick={() => onRuleHistory(!showRuleHistory)}>
          {showRuleHistory ? 'Hide rule history' : 'Rule history'}
        </button>
        <button className="text-button" type="button" onClick={() => onProviderHistory(!showProviderHistory)}>
          {showProviderHistory ? 'Hide provider requests' : 'Provider requests'}
        </button>
      </div>
      {showProviderHistory && providerHistory && <section>
        <p>Settings version {providerHistory.settings_version_id}</p>
        {(['decision', 'ranges'] as const).map(kind => <div key={kind}>
          <strong>{kind === 'decision' ? 'Decisions' : 'Ranges'}</strong>
          {' · '}{providerHistory.settings[kind].model}
          {providerHistory.settings[kind].service_tier && ` · ${providerHistory.settings[kind].service_tier}`}
          <small> {providerHistory.settings[kind].base_url}</small>
        </div>)}
        {providerHistory.requests.length === 0 && <p className="muted">No provider requests recorded for this run.</p>}
        {providerHistory.requests.map(item => <details key={item.id}>
          <summary>{({file: 'File decision', ranges: 'Range discovery', adjudication: 'Adjudication'})[item.stage]}
            {' · '}{item.reused ? 'Reused request' : (item.http_status ?? item.transport_error ?? 'Outcome pending')}
            {' · '}{new Date(item.started_at).toLocaleString()}</summary>
          {item.resolved_model && <div>Served by {item.resolved_model}{item.resolved_service_tier && ` · ${item.resolved_service_tier}`}</div>}
          {item.question_count !== null && <div>Questions sent {item.question_count}</div>}
          {item.usage && <CodeBlock source={JSON.stringify(item.usage, null, 2)} language="json"/>}
        </details>)}
      </section>}
      {showRuleHistory && history?.map(item => <details key={`${item.project}-${item.rule_hash}`}>
        <summary>{item.project} · {new Date(item.first_seen).toLocaleDateString()} · {item.rule_hash.slice(0, 8)}</summary>
        <CodeBlock source={item.rule} language="markdown"/>
      </details>)}
      {mode === 'adjudication' && (range ? <div className="adjudication"
        onPointerDown={event => {swipe.current = {x: event.clientX, y: event.clientY};}}
        onPointerCancel={() => {swipe.current = null;}}
        onPointerUp={event => {
          const start = swipe.current;
          swipe.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(event.clientY - start.y) * 1.5) step(dx > 0 ? -1 : 1);
        }}>
        <div className="range-navigation">
          <button type="button" onClick={() => step(-1)} disabled={index <= 0 && !canGoPrevious} aria-label="Previous snippet">←</button>
          <strong>{rangeText(range)}</strong><small>{index + 1} of {run.ranges.length}</small>
          <button type="button" onClick={() => step(1)} disabled={index + 1 >= run.ranges.length && !canGoNext} aria-label="Next snippet">→</button>
        </div>
        {range.candidate ? (range.model_decision === null ? <Stage cell={run}/> :
          <Verdict decision={range.model_decision} confidence={range.confidence}/>) : <span className="badge neutral">Human-added range</span>}
        <div className="segmented">
          <button type="button" aria-pressed={!showContext} onClick={() => onContext(false)}>Snippet</button>
          <button type="button" aria-pressed={showContext} onClick={() => onContext(true)}>In file</button>
        </div>
        {showContext
          ? <SourceRanges lines={sourceLines} ranges={[range]} selected={range} title={run.file_path}/>
          : <CodeExcerpt lines={sourceLines.slice(range.start - 1, range.end)} className="snippet"/>}
        <LabelButtons active={range.annotation} disabled={pending} save={decision => save(range.start, range.end, decision)}/>
      </div> : <div className="empty">{run.stage === 'ready' ? 'No candidate ranges' : <Stage cell={run}/>}
        <button type="button" onClick={() => onMode('ranges')}>Open source to add a range</button></div>)}
      {mode === 'ranges' && <>
        <div className="range-chips">{run.ranges.map(item =>
          <RangeChip key={rangeText(item)} range={item} open={() => onRange(item)}/>)}</div>
        {range && <div className="range-selection"><strong>{rangeText(range)}</strong>
          <LabelButtons active={range.annotation} disabled={pending} save={decision => save(range.start, range.end, decision)}/>
        </div>}
        <SourceRanges lines={sourceLines} ranges={run.ranges} selected={range} select={onRange} save={save} busy={pending} title={run.file_path}/>
      </>}
    </>}
  </aside>;
}

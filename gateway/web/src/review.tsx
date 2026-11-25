import {useCallback, useEffect, useRef, useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {Api, label, probability, rangeText} from './api';
import type {Cell, History, Label, Mode, Range, Run, Trace} from './api';

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
      <a href={`/?findRun=${cell.run_id}`} target="_blank" rel="noopener noreferrer">Find and annotate ranges ↗</a>}
  </>;
}

export function Matrix({traces, mode, open, save, saveRange, busy, onRule}: {
  traces: Trace[]; mode: Mode; open: OpenReview; save: SetFileLabel; saveRange: (cell: Cell, range: Range, decision: Label) => void; busy: boolean; onRule: (rule: string) => void;
}) {
  if (!traces.length) return <div className="empty">No traces match these filters.</div>;
  const columns = [...new Set(traces.flatMap(trace => trace.cells.map(cell => cell.rule_path)))].sort();
  return <div className="table-scroll"><table>
    <thead><tr><th scope="col">File</th>{columns.map(column =>
      <th scope="col" key={column}><button type="button" className="column-rule" onClick={() => onRule(column)}
        title={column}>{column.split('/').at(-1)}</button><small>{column}</small></th>)}</tr></thead>
    <tbody>{traces.map(trace => <tr key={trace.id}>
      <th scope="row">
        <a className="file-name" href={`/?traceId=${trace.id}`}>{trace.file_path}</a>
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
                {range.preview && <pre>{range.preview}</pre>}
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

export function SourceRanges({run, selected, select, save, busy}: {
  run: Run; selected: Range | undefined; select: (range: Range) => void;
  save: (start: number, end: number, decision: Label) => void; busy: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<{start: number; end: number}>();
  const drag = useRef<number | null>(null);
  const lines = run.source ? run.source.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const source = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) source.current?.querySelector(`[data-line="${selected.start}"]`)?.scrollIntoView({block: 'nearest'});
  }, [selected]);

  function move(event: ReactPointerEvent) {
    if (drag.current === null) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-line]');
    const line = Number(target?.dataset.line);
    if (line > 0) setSelection({start: Math.min(line, drag.current), end: Math.max(line, drag.current)});
  }

  return <section className="source-panel">
    <div className="source-tools">
      <h3>Source</h3>
      <button type="button" onClick={() => {setAdding(!adding); setSelection(undefined);}}>
        {adding ? 'Cancel' : '+ Add range'}
      </button>
    </div>
    {adding && <div className="range-instructions">
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
      {lines.map((text, index) => {
        const line = index + 1;
        const regions = run.ranges.filter(range => range.start <= line && range.end >= line);
        const top = regions.find(range => selected && range.start === selected.start && range.end === selected.end) ?? regions[0];
        const marked = selection && selection.start <= line && line <= selection.end;
        const status = top?.model_decision == null ? 'neutral' : top.model_decision ? 'violation' : 'clear';
        const agreement = top?.annotation != null && top.model_decision !== null
          ? top.annotation === top.model_decision ? 'agree' : 'disagree' : '';
        return <div key={line} data-line={line}
          className={`source-line ${top ? status : ''} ${agreement} ${marked ? 'marked' : ''} ${top && !top.candidate ? 'human-only' : ''}`}>
          <button type="button" className="gutter" aria-label={`Line ${line}`} tabIndex={top && !adding ? 0 : -1}
            onPointerDown={event => {
              if (!adding || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = line;
              setSelection({start: line, end: line});
            }}
            onClick={() => {if (!adding && top) select(top);}}>{line}</button>
          <code>{text || ' '}</code>
          {top && line === top.start && !adding && <div className="line-actions">
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

export function ReviewPanel({api, initial, trace, mode, initialRange, close, refresh, saveFile, busy, canGoPrevious, canGoNext, goAdjacent}: {
  api: Api; initial: Cell; trace: Trace; mode: Mode; initialRange?: Range; close: () => void;
  refresh: () => void; saveFile: SetFileLabel; busy: boolean;
  canGoPrevious: boolean; canGoNext: boolean; goAdjacent: (direction: number) => void;
}) {
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState(initialRange);
  const [history, setHistory] = useState<History[]>();
  const [view, setView] = useState<Mode>(mode);
  const [reload, setReload] = useState(0);
  const swipe = useRef<{x: number; y: number} | null>(null);

  useEffect(() => setView(mode), [mode]);

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

  const range = selected && run?.ranges.find(item => rangeText(item) === rangeText(selected)) || run?.ranges[0];
  const index = run && range ? run.ranges.indexOf(range) : -1;
  const step = useCallback((amount: number) => {
    if (run?.ranges[index + amount]) setSelected(run.ranges[index + amount]);
    else goAdjacent(amount);
  }, [run, index, goAdjacent]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || view !== 'adjudication') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [close, step, view]);

  return <aside className="review-panel" aria-label="Review">
    <div className="panel-heading"><div><small>{trace.project} / {trace.file_path}</small><h2>{initial.rule_id}</h2></div>
      <button type="button" className="close" aria-label="Close review" onClick={close}>×</button></div>
    <div className="segmented">
      <button type="button" aria-pressed={view === 'files'} onClick={() => setView('files')}>File</button>
      <button type="button" aria-pressed={view === 'adjudication'} onClick={() => setView('adjudication')}>Adjudication</button>
      <button type="button" aria-pressed={view === 'ranges'} onClick={() => setView('ranges')}>Ranges</button>
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
      {view === 'files' && <div className="file-review"><FileCell cell={run} save={saveFile} busy={busy}/></div>}
      <details className="rule-text" open={view === 'adjudication'}><summary>{run.rule_path}</summary><pre>{run.rule}</pre></details>
      <div className="panel-links">
        {run.langfuse_url && <a href={run.langfuse_url} target="_blank" rel="noreferrer">Langfuse ↗</a>}
        <button className="text-button" type="button" onClick={() => {
          if (history) {setHistory(undefined); return;}
          api.json<History[]>(`/history?${new URLSearchParams({project_id: String(trace.project_id), rule: initial.rule_path})}`)
            .then(setHistory).catch(error => setError(error.message));
        }}>{history ? 'Hide rule history' : 'Rule history'}</button>
      </div>
      {history?.map(item => <details key={`${item.project}-${item.rule_hash}`}>
        <summary>{item.project} · {new Date(item.first_seen).toLocaleDateString()} · {item.rule_hash.slice(0, 8)}</summary>
        <pre>{item.rule}</pre>
      </details>)}
      {view === 'adjudication' && (range ? <div className="adjudication"
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
        <pre className="snippet">{run.source.split(/\r?\n/).slice(range.start - 1, range.end).join('\n')}</pre>
        <LabelButtons active={range.annotation} disabled={pending} save={decision => save(range.start, range.end, decision)}/>
        <details><summary>Full file context</summary><pre>{run.source}</pre></details>
      </div> : <div className="empty">{run.stage === 'ready' ? 'No candidate ranges' : <Stage cell={run}/>}
        <button type="button" onClick={() => setView('ranges')}>Open source to add a range</button></div>)}
      {view === 'ranges' && <>
        <div className="range-chips">{run.ranges.map(item =>
          <RangeChip key={rangeText(item)} range={item} open={() => setSelected(item)}/>)}</div>
        {range && <div className="range-selection"><strong>{rangeText(range)}</strong>
          <LabelButtons active={range.annotation} disabled={pending} save={decision => save(range.start, range.end, decision)}/>
        </div>}
        <SourceRanges key={run.run_id} run={run} selected={range} select={setSelected} save={save} busy={pending}/>
      </>}
    </>}
  </aside>;
}

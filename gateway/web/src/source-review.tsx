import {agentRanges} from './agentic';
import {useEffect, useMemo, useRef, useState} from 'react';
import type {CSSProperties, PointerEvent as ReactPointerEvent} from 'react';
import {ArrowLeft, ArrowRight, Eye} from 'lucide-react';
import {CodeTokens, SourceHeader} from './code';
import type {HighlightedLine, Language} from './code';
import {attribution, label, rangeText} from './api';
import type {Identity, Cell, Label, Range} from './api';
import {rangeParam} from './navigation';

export type Bounds = Pick<Range, 'start' | 'end'>;
export type SaveRange = (cell: Cell, range: Bounds, decision: Label) => void;

export function LabelButtons({active, save, disabled}: {
  active: Label; save: (decision: Label) => void; disabled?: boolean;
}) {
  return <div className="label-buttons">
    <button type="button" aria-pressed={active === false} disabled={disabled} onClick={() => save(false)}>No violation</button>
    <button type="button" aria-pressed={active === true} disabled={disabled} onClick={() => save(true)}>Violates</button>
    {active !== null && <button type="button" className="quiet" disabled={disabled} onClick={() => save(null)}>Clear annotation</button>}
  </div>;
}

export function rangeStatus(range: Range, showCheck = true) {
  if (range.agent) return `Violation found by ${range.agent.name}`;
  if (!range.candidate) return 'Added in review';
  if (!showCheck) return 'Pipeline candidate';
  if (range.model_decision === null) return 'Pipeline candidate · unchecked';
  return range.model_decision ? 'Pipeline found a violation' : 'Pipeline found no violation';
}

export function RangeLink({range, cell, onClick}: {range: Range; cell: Cell; onClick: () => void}) {
  return <button type="button" className="range-link" onClick={onClick}
    aria-label={`View ${cell.rule_id} ${rangeText(range)} in file`}><Eye size={14} aria-hidden="true"/> {rangeText(range)}</button>;
}

type Marker = {cell: Cell; range: Range; key: string; color: string; lane: number};
type Hover = {marker: Marker; line: number; above: boolean};

function layout(cells: Cell[], lineCount: number) {
  const markers = cells.flatMap((cell, index) => [...cell.ranges, ...agentRanges(cell)].map(range => ({
    cell, range, color: range.agent ? '#8554b3' : `hsl(${(index * 137.508 + 217) % 360} 61% 42%)`,
    key: `${cell.run_id}:${rangeParam(range)}`, lane: 0,
  }))).sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.cell.run_id - b.cell.run_id);
  const ends: number[] = [];
  const byLine = new Map<number, Marker[]>();
  for (const marker of markers) {
    if (marker.range.start > lineCount) continue;
    const free = ends.findIndex(end => end < marker.range.start);
    marker.lane = free < 0 ? ends.length : free;
    ends[marker.lane] = marker.range.end;
    for (let line = marker.range.start; line <= Math.min(marker.range.end, lineCount); line++) {
      const overlapping = byLine.get(line);
      if (overlapping) overlapping.push(marker);
      else byLine.set(line, [marker]);
    }
  }
  return {markers, byLine, lanes: ends.length};
}

function colorStyle(color: string, column?: number): CSSProperties & {'--rule-color': string} {
  return {'--rule-color': color, gridColumn: column};
}

export function AnnotationVerdict({identity, decision}: {identity: Identity | null; decision: Label}) {
  if (decision === null) return null;
  return <span className="annotation-verdict">
    <span>{identity ? `${attribution(identity)} annotation` : attribution(identity)}</span>
    <strong>{label(decision)}</strong>
  </span>;
}

function RangeControls({marker, save, busy}: {marker: Marker; save: SaveRange; busy: boolean}) {
  return <>
    <strong>{marker.cell.rule_id} · {rangeText(marker.range)}</strong>
    <small>{rangeStatus(marker.range)}</small>
    <AnnotationVerdict identity={marker.range.labeler_identity} decision={marker.range.annotation}/>
    <LabelButtons active={marker.range.annotation} disabled={busy}
      save={decision => save(marker.cell, marker.range, decision)}/>
  </>;
}

export function SourceReview({title, lines, cells, focus, onFocus, language, onLanguage, save, busy}: {
  title: string; lines: HighlightedLine[]; cells: Cell[]; focus?: string;
  onFocus?: (range: Range) => void; language: Language; onLanguage: (language: Language) => void;
  save?: SaveRange; busy: boolean;
}) {
  const source = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const swipe = useRef<{x: number; y: number} | null>(null);
  const dismiss = useRef<number | undefined>(undefined);
  const [hover, setHover] = useState<Hover>();
  const [adding, setAdding] = useState(false);
  const [rangeRule, setRangeRule] = useState<number>();
  const [selection, setSelection] = useState<Bounds>();
  const {markers, byLine, lanes} = useMemo(() => layout(cells, lines.length), [cells, lines.length]);
  const focused = focus ? markers.find(marker => rangeParam(marker.range) === focus) : undefined;
  const focusIndex = focused ? markers.indexOf(focused) : -1;
  const hovered = hover && markers.find(marker => marker.key === hover.marker.key);
  const emphasized = focused ?? hovered;
  const selectedRule = cells.find(cell => cell.run_id === rangeRule) ?? (cells.length === 1 ? cells[0] : undefined);

  useEffect(() => {
    if (focused) source.current?.querySelector(`[data-line="${focused.range.start}"]`)
      ?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  }, [focused?.key, lines.length]);

  useEffect(() => () => window.clearTimeout(dismiss.current), []);

  function step(direction: number) {
    const next = markers[focusIndex + direction];
    if (next && onFocus) onFocus(next.range);
  }

  function show(marker: Marker, line: number, target: HTMLElement) {
    window.clearTimeout(dismiss.current);
    const bottom = source.current?.getBoundingClientRect().bottom ?? Infinity;
    setHover({marker, line, above: target.getBoundingClientRect().bottom + 120 > bottom});
  }

  function hide() {
    window.clearTimeout(dismiss.current);
    dismiss.current = window.setTimeout(() => setHover(undefined), 150);
  }

  function move(event: ReactPointerEvent) {
    if (drag.current === null) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-line]');
    const line = Number(hit?.dataset.line);
    if (line > 0) setSelection({start: Math.min(line, drag.current), end: Math.max(line, drag.current)});
  }

  return <section className="source-panel">
    <SourceHeader filename={title} language={language} onLanguage={onLanguage}>
      {save && cells.length > 0 && lines.length > 0 && <button type="button" onClick={() => {
        setAdding(!adding);
        setSelection(undefined);
        setHover(undefined);
      }}>{adding ? 'Cancel' : '+ Add range'}</button>}
    </SourceHeader>
    {save && markers.length > 0 && <div className="range-legend">
      {markers.some(marker => marker.range.agent) && <span><i data-state="agent"/> Agent violation</span>}
      {markers.some(marker => marker.range.annotation !== null) && <span><i data-reviewed="true"/> Reviewed range</span>}
      <span><i data-state="candidate"/> Unchecked candidate</span>
      <span><i data-state="violation"/> Pipeline violation</span>
      <span><i data-state="clear"/> Pipeline no violation</span>
      {markers.some(marker => !marker.range.candidate && !marker.range.agent) && <span><i data-state="human"/> Reviewer-added</span>}
    </div>}
    {focused && save && !adding && <div className="focused-annotation" style={colorStyle(focused.color)}
      onPointerDown={event => {swipe.current = {x: event.clientX, y: event.clientY};}}
      onPointerCancel={() => {swipe.current = null;}}
      onPointerUp={event => {
        const start = swipe.current;
        swipe.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(event.clientY - start.y) * 1.5) step(dx > 0 ? -1 : 1);
      }}>
      <RangeControls marker={focused} save={save} busy={busy}/>
      {markers.length > 1 && <div className="range-focus-navigation">
        <button type="button" aria-label="Previous range" disabled={focusIndex === 0} onClick={() => step(-1)}><ArrowLeft size={14}/></button>
        <small>{focusIndex + 1} of {markers.length}</small>
        <button type="button" aria-label="Next range" disabled={focusIndex + 1 === markers.length} onClick={() => step(1)}><ArrowRight size={14}/></button>
      </div>}
    </div>}
    {adding && save && <div className="range-instructions">
      {cells.length > 1 && <label>Rule<select value={rangeRule ?? ''} onChange={event => setRangeRule(Number(event.target.value) || undefined)}>
        <option value="">Choose a rule</option>
        {cells.map(cell => <option key={cell.run_id} value={cell.run_id}>{cell.rule_id}</option>)}
      </select></label>}
      {selection ? <>
        <strong>{rangeText(selection)}</strong>
        <LabelButtons active={null} disabled={busy || !selectedRule} save={decision => {
          if (!selectedRule) return;
          save(selectedRule, selection, decision);
          setAdding(false);
          setSelection(undefined);
        }}/>
      </> : <p>Drag in the line-number gutter or enter the start and end lines.</p>}
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
      <div className="source-sheet">{lines.map((tokens, index) => {
        const line = index + 1;
        const overlapping = byLine.get(line) ?? [];
        const highlight = overlapping.find(marker => marker.key === emphasized?.key);
        const marked = selection && selection.start <= line && line <= selection.end;
        return <div key={line} data-line={line}
          className={`source-line ${marked ? 'marked' : ''} ${highlight ? 'range-highlight' : ''} ${highlight?.range.start === line ? 'range-start' : ''} ${highlight?.range.end === line ? 'range-end' : ''}`}
          style={highlight ? colorStyle(highlight.color) : undefined}>
          {adding ? <button type="button" className="gutter" aria-label={`Select line ${line}`}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = line;
              setSelection({start: line, end: line});
            }} onClick={event => {if (event.detail === 0) setSelection({start: line, end: line});}}>{line}</button>
            : <span className="gutter" aria-hidden="true">{line}</span>}
          <code className="syntax-code">{tokens.length ? <CodeTokens line={tokens}/> : ' '}</code>
          {lanes > 0 && <div className="range-rails" style={{
            gridTemplateColumns: `repeat(${lanes}, .55rem)`, zIndex: hover?.line === line ? 2 : 1,
          }}>
            {overlapping.map(marker => <button key={marker.key} type="button" className="range-marker"
              style={colorStyle(marker.color, marker.lane + 1)}
              data-state={marker.range.agent ? 'agent' : marker.range.model_decision === null ? marker.range.candidate ? 'candidate' : 'human' : marker.range.model_decision ? 'violation' : 'clear'}
              data-reviewed={marker.range.annotation !== null}
              data-highlighted={marker.key === emphasized?.key}
              tabIndex={line === marker.range.start && !adding ? 0 : -1}
              aria-label={`${marker.cell.rule_id}, ${rangeText(marker.range)}, ${rangeStatus(marker.range)}${marker.range.annotation === null ? '' : `, ${attribution(marker.range.labeler_identity)}: ${label(marker.range.annotation)}`}`}
              onPointerEnter={event => {if (!adding && !focused) show(marker, line, event.currentTarget);}}
              onPointerLeave={hide}
              onFocus={event => {if (!adding && !focused) show(marker, line, event.currentTarget);}}
              onBlur={hide}
              onClick={event => {
                if (adding) return;
                if (onFocus) onFocus(marker.range);
                else show(marker, line, event.currentTarget);
              }}/>)}
            {!focused && !adding && save && hovered && hover?.line === line && <div
            className={`range-hover-actions ${hover.above ? 'above' : ''}`} style={colorStyle(hovered.color)}
            onPointerEnter={() => window.clearTimeout(dismiss.current)} onPointerLeave={hide}
            onFocus={() => window.clearTimeout(dismiss.current)} onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) hide();
            }}>
              <RangeControls marker={hovered} save={save} busy={busy}/>
            </div>}
          </div>}
        </div>;
      })}</div>
      {lines.length === 0 && <p className="muted">This file is empty.</p>}
    </div>
  </section>;
}

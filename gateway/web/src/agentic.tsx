import {useState} from 'react';
import type {FormEvent} from 'react';
import {label, rangeText, sourceName} from './api';
import type {Api, Cell, Labeler, Range} from './api';

export function LabelerSettings({api, items, refresh, onError}: {
  api: Api; items: Labeler[]; refresh: () => void; onError: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [calls, setCalls] = useState(4);
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.json('/agentic-labelers', 'POST', {name: name.trim(), model: model.trim(), max_tool_calls: calls, instructions});
      refresh();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return <>
    <h1>Agent labelers</h1>
    <p>A labeler checks a file against one rule and can look up related stored source from the same project and API key. Run it from Traces to get a second opinion. Save an annotation to change what the CLI and IDE report.</p>
    <form className="create-project" onSubmit={save}>
      <label>Name<input value={name} required maxLength={120} onChange={event => setName(event.target.value)}/>
        <small>Use the same name to update a saved labeler.</small></label>
      <label>OpenRouter model<input value={model} required maxLength={200} placeholder="provider/model"
        onChange={event => setModel(event.target.value)}/></label>
      <label>Context lookups per run<input type="number" min={0} max={12} required value={calls}
        onChange={event => setCalls(event.target.valueAsNumber)}/></label>
      <label>Extra instructions<textarea value={instructions} maxLength={8000}
        onChange={event => setInstructions(event.target.value)}/></label>
      <button className="primary" disabled={saving || !name.trim() || !model.trim()}>Save labeler</button>
    </form>
    <table><thead><tr><th>Name</th><th>Model</th><th>Tool calls</th><th>Configured via</th><th/></tr></thead>
      <tbody>{items.map(item => <tr key={item.id}>
        <td>{item.name}</td><td>{item.model}</td><td>{item.max_tool_calls}</td><td>{sourceName(item.configured_via)}</td>
        <td><button type="button" onClick={() => {setName(item.name); setModel(item.model); setCalls(item.max_tool_calls); setInstructions(item.instructions);}}>Edit</button></td>
      </tr>)}</tbody>
    </table>
  </>;
}

export function agentRanges(cell: Cell): Range[] {
  return cell.agentic_labels.flatMap(agent => agent.ranges.map(bounds => {
    const reviewed = cell.ranges.find(range => range.start === bounds.start && range.end === bounds.end);
    return {...bounds, candidate: false, model_decision: null, confidence: null,
      annotation: reviewed?.annotation ?? null, labeler_identity: reviewed?.labeler_identity ?? null,
      agent: {id: agent.labeler_id, name: agent.labeler_identity.name ?? 'Agent labeler'}};
  }));
}

export function AgentResults({cell, open}: {cell: Cell; open?: (range: Range) => void}) {
  const ranges = agentRanges(cell);
  return cell.agentic_labels.map(agent => <section className="stage-card agent-result" key={agent.labeler_id}>
    <strong>{agent.labeler_identity.name ?? 'Agent labeler'}</strong>
    <small>{label(agent.violates)} · {agent.labeler_identity.model}</small>
    {agent.labeler_identity.invoked_via && <small>Run via {sourceName(agent.labeler_identity.invoked_via)}</small>}
    <div>{ranges.filter(range => range.agent?.id === agent.labeler_id).map(range =>
      open ? <button key={`${range.start}-${range.end}`} className="range-link" type="button" onClick={() => open(range)}>{rangeText(range)}</button>
        : <small key={`${range.start}-${range.end}`}>{rangeText(range)}</small>
    )}</div>
  </section>);
}

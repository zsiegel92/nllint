import {useEffect, useId, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {Api} from './api';
import type {RuleVersion} from './api';

export function RulePicker({api, scope, selected, onChange}: {
  api: Api;
  scope: string;
  selected: string[];
  onChange: (rules: string[]) => void;
}) {
  const listId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<RuleVersion[]>([]);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const params = new URLSearchParams(scope);
    if (search.trim()) params.set('search', search.trim());
    for (const id of selected) params.append('rule_version', id);
    const timer = window.setTimeout(() => {
      api.json<RuleVersion[]>(`/rules?${params}`).then(rules => {
        if (!cancelled) {
          setOptions(rules);
          setStatus('ready');
        }
      }).catch(() => {
        if (!cancelled) setStatus('error');
      });
    }, search ? 150 : 0);
    return () => {cancelled = true; clearTimeout(timer);};
  }, [api, open, scope, search, selected]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) {
        setOpen(false);
        setSearch('');
        setActive(-1);
      }
    }
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id]);
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      setSearch('');
      setActive(-1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      const next = event.key === 'ArrowDown'
        ? Math.min(active + 1, options.length - 1)
        : active <= 0 ? options.length - 1 : active - 1;
      setActive(next);
      document.getElementById(`${listId}-${options[next]?.id}`)?.scrollIntoView({block: 'nearest'});
    } else if (event.key === 'Enter' && open && status === 'ready' && options[active]) {
      event.preventDefault();
      toggle(options[active].id);
    }
  }

  return <div className="rule-picker" ref={picker}>
    <label htmlFor={`${listId}-input`}>Rules</label>
    <div className="rule-picker-input">
      <input ref={input} id={`${listId}-input`} role="combobox" aria-autocomplete="list"
        aria-expanded={open} aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? `${listId}-${options[active].id}` : undefined}
        placeholder={selected.length ? `${selected.length} selected · search rules` : 'Search rule names'}
        value={search} maxLength={200} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onKeyDown={keyDown}
        onChange={event => {setSearch(event.target.value); setStatus('loading'); setActive(-1); setOpen(true);}}/>
      {selected.length > 0 && <button type="button" aria-label="Clear rule selection" onClick={() => {onChange([]); input.current?.focus();}}>
        Clear
      </button>}
    </div>
    {open && <div className="rule-options" id={listId} role="listbox" aria-label="Rule versions" aria-multiselectable="true">
      {status === 'loading' && <p role="status">Loading rules…</p>}
      {status === 'error' && <p role="alert">Could not load rules.</p>}
      {status === 'ready' && options.length === 0 && <p>No matching rules.</p>}
      {status === 'ready' && options.map((rule, index) =>
        <button key={rule.id} id={`${listId}-${rule.id}`} type="button" role="option" tabIndex={-1}
          aria-selected={selected.includes(rule.id)} className={active === index ? 'active' : undefined}
          onMouseDown={event => event.preventDefault()} onClick={() => toggle(rule.id)}>
          <strong>{rule.name}</strong>
          <small>{rule.path} · {rule.project} · {rule.hash.slice(0, 8)}</small>
          <small>File positives {rule.file_positives} · Range positives {rule.range_positives} · Adjudicated positives {rule.adjudicated_positives}</small>
        </button>)}
    </div>}
  </div>;
}

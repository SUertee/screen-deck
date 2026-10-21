import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import type { AgentChatSourceInfo } from '../../shared/agent-chat';
import { assignmentKey, assignmentLabel, availableAssignments, deckError, type DeckAssignment } from './deck-model';

interface Props {
  value: DeckAssignment;
  sources: AgentChatSourceInfo[];
  recent: DeckAssignment[];
  disabled?: boolean;
  collapsed?: boolean;
  label: string;
  onCommit(value: DeckAssignment): Promise<void>;
  onOpenChange?(open: boolean): void;
}

export function AssignmentPicker({ value, sources, recent, disabled, collapsed, label, onCommit, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const alive = useRef(true);
  const listID = useId();
  const rootID = useId();
  const options = useMemo(() => {
    const catalog = availableAssignments(sources);
    const byKey = new Map(catalog.map(option => [assignmentKey(option), option]));
    const seed = [{ assignee: 'human' }, { assignee: 'unassigned' }, value, ...recent, ...catalog] as DeckAssignment[];
    const seen = new Set<string>();
    const tokens = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    return seed.filter(option => {
      const key = assignmentKey(option);
      if (seen.has(key) || option.assignee === 'chat' || option.assignee === 'agent' && !byKey.has(key)) return false;
      seen.add(key);
      const text = `${assignmentLabel(option, sources)} ${option.agentID ?? ''} ${option.assignee === 'human' ? '人工 我' : ''}`.normalize('NFKC').toLowerCase();
      return tokens.every(token => text.includes(token));
    });
  }, [sources, recent, value, query]);
  const selectedKey = assignmentKey(value);

  useEffect(() => { alive.current = true; return () => { alive.current = false; onOpenChange?.(false); }; }, [onOpenChange]);
  useEffect(() => { if (collapsed && open) { setOpen(false); onOpenChange?.(false); } }, [collapsed, open, onOpenChange]);
  useEffect(() => {
    if (open && !options.some(option => assignmentKey(option) === activeKey)) setActiveKey(options[0] ? assignmentKey(options[0]) : null);
  }, [open, options, activeKey]);

  const close = (restore = true) => {
    if (busy) return;
    setOpen(false); onOpenChange?.(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const bounds = (trigger.current?.closest('.deck-content-shell') ?? trigger.current?.closest('.deck-workbench'))?.getBoundingClientRect();
      const left = Math.max(6, bounds?.left ?? 0), right = Math.min(innerWidth - 6, bounds?.right ?? innerWidth);
      const top = Math.max(6, bounds?.top ?? 0), bottom = Math.min(innerHeight - 6, bounds?.bottom ?? innerHeight);
      setPosition({ left: Math.max(left, Math.min(anchor.right - 184, right - 184)), top: Math.max(top, Math.min(anchor.bottom + 4 + 156 > bottom ? anchor.top - 160 : anchor.bottom + 4, bottom - 156)) });
    };
    place(); search.current?.focus({ preventScroll: true });
    const list = trigger.current?.closest('.deck-workbench')?.querySelector('[data-testid="deck-task-list"]');
    const anchor = trigger.current?.getBoundingClientRect();
    const listScroll = list?.scrollTop;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false);
    };
    const scrolled = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      const current = trigger.current?.getBoundingClientRect();
      if (list && event.target === list && current && anchor && Math.abs(current.top - anchor.top) < .5 && Math.abs(current.left - anchor.left) < .5 && list.scrollTop === listScroll) return;
      close(false);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', place);
    const blurred = () => { setOpen(false); onOpenChange?.(false); };
    window.addEventListener('blur', blurred);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', place); window.removeEventListener('blur', blurred); };
  }, [open, busy]);

  useEffect(() => {
    if (!open || !activeKey) return;
    const node = menu.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, activeKey]);

  const commit = async (option: DeckAssignment) => {
    if (busy || composing.current) return;
    setBusy(true); setError('');
    try {
      await onCommit(option);
      if (!alive.current) return;
      setOpen(false); onOpenChange?.(false); trigger.current?.focus({ preventScroll: true });
    } catch (failure) { if (alive.current) setError(deckError(failure)); }
    finally { if (alive.current) setBusy(false); }
  };
  const name = value.assignee === 'human' ? '我' : value.assignee === 'unassigned' ? '未分配'
    : value.assignee === 'chat' ? '模型聊天' : sources.find(source => source.agentID === value.agentID)?.name ?? value.agentID ?? 'Agent';

  return <>
    <button ref={trigger} type="button" className="deck-owner-picker" disabled={disabled} aria-label={`${label}：${assignmentLabel(value, sources)}`} title={assignmentLabel(value, sources)} aria-haspopup="dialog" aria-controls={rootID} aria-expanded={open} onClick={() => {
      if (open) close(); else { setQuery(''); setError(''); setActiveKey(selectedKey); setOpen(true); onOpenChange?.(true); }
    }} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setError(''); setActiveKey(selectedKey); setOpen(true); onOpenChange?.(true); } }}>
      <span className="deck-owner-copy"><span>{name}</span>{(value.assignee === 'agent' || value.assignee === 'chat') && <small>{value.model?.model_id ?? '跟随设置'}</small>}</span><ChevronDown size={10} />
    </button>
    {open && createPortal(<div id={rootID} ref={menu} className="deck-assignment-menu" role="dialog" aria-label="分工选择" aria-busy={busy} style={position} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') { close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        if (!options.length) return;
        const current = options.findIndex(option => assignmentKey(option) === activeKey);
        const next = current < 0 ? event.key === 'ArrowDown' ? 0 : options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        setActiveKey(assignmentKey(options[next]));
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation();
        const option = options.find(candidate => assignmentKey(candidate) === activeKey);
        if (option) void commit(option);
      }
    }}>
      <div className="deck-owner-search-wrap"><input ref={search} role="combobox" aria-label="筛选分工" aria-controls={listID} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={activeKey && options.some(option => assignmentKey(option) === activeKey) ? `${listID}-${options.findIndex(option => assignmentKey(option) === activeKey)}` : undefined} value={query} placeholder="筛选人、Agent 或模型" disabled={busy} onChange={event => { setQuery(event.target.value); setActiveKey(null); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={event => { composing.current = false; setQuery(event.currentTarget.value); setActiveKey(null); }} />{query && <button type="button" aria-label="清空筛选" disabled={busy} onClick={() => { setQuery(''); setActiveKey(null); search.current?.focus(); }}><X size={9} /></button>}</div>
      <div className="deck-owner-results" role="listbox" id={listID} aria-label="负责人或Agent模型">
        {options.map((option, index) => { const key = assignmentKey(option); return <button key={key} id={`${listID}-${index}`} className="deck-owner-option" role="option" aria-selected={selectedKey === key} data-active={activeKey === key} tabIndex={-1} disabled={busy} title={assignmentLabel(option, sources)} aria-label={assignmentLabel(option, sources)} onPointerDown={event => event.preventDefault()} onClick={() => void commit(option)}><span>{assignmentLabel(option, sources)}</span><Check size={10} /></button>; })}
        {!options.length && <p className="deck-owner-empty" role="status">没有匹配的分工</p>}
      </div>
      {error && <p className="deck-owner-error" role="alert">{error}</p>}
    </div>, document.body)}
  </>;
}

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import './chat-model-picker.css';

/** Local saved choices only. Opening the menu never queries a provider. */
export function ChatModelPicker({ value, modelIDs, disabled, loading, state = 'default', onChange, onSettings }: {
  value: string; modelIDs: string[]; disabled?: boolean; loading?: boolean;
  state?: 'default' | 'error' | 'success'; onChange: (id: string) => void; onSettings: () => void;
}) {
  const choices = [...new Set([value, ...modelIDs].filter(Boolean))];
  const labels = [...choices, '模型设置…'];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const prefix = useRef({ text: '', time: 0 });
  const focusAfterChoice = useRef(false);
  const focusOnOpen = useRef(false);
  const menuID = useId(), blocked = !!disabled || !!loading;
  const focusItem = (index: number) => { setActive(index); items.current[index]?.focus(); };
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const expand = () => { if (!blocked) { focusOnOpen.current = true; setPosition(undefined); setActive(Math.max(0, choices.indexOf(value))); setOpen(true); } };
  useEffect(() => {
    if (blocked) setOpen(false);
    else if (focusAfterChoice.current) { focusAfterChoice.current = false; if (document.activeElement === document.body) trigger.current?.focus(); }
  }, [blocked, value]);
  useEffect(() => { setOpen(false); }, [value, modelIDs]);
  useLayoutEffect(() => {
    if (!open || !position) return;
    if (focusOnOpen.current) { focusOnOpen.current = false; items.current[active]?.focus({ preventScroll: true }); }
    items.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active, position?.maxHeight]);
  useLayoutEffect(() => {
    if (!open || blocked) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), panel = menu.current;
      if (!anchor || !panel) return;
      const width = Math.min(288, innerWidth - 16);
      const above = anchor.top > innerHeight - anchor.bottom;
      const available = above ? anchor.top : innerHeight - anchor.bottom;
      const maxHeight = Math.max(48, Math.min(320, available - 14));
      const height = Math.min(panel.scrollHeight + 2, maxHeight);
      setPosition({ width, maxHeight, left: Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8)), top: above ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6 });
    };
    place();
    const outside = (event: PointerEvent) => { const node = event.target as Node; if (!trigger.current?.contains(node) && !menu.current?.contains(node)) setOpen(false); };
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside, true); };
  }, [open, blocked, choices.length, value]);
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const next = event.key === 'ArrowDown' ? (active + 1) % labels.length : event.key === 'ArrowUp' ? (active - 1 + labels.length) % labels.length : event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); focusItem(next); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
      event.preventDefault();
      const now = Date.now(), char = event.key.toLocaleLowerCase();
      prefix.current = { text: now - prefix.current.time < 650 ? prefix.current.text + char : char, time: now };
      const order = labels.map((_, i) => (active + 1 + i) % labels.length);
      let match = order.find(i => labels[i].toLocaleLowerCase().startsWith(prefix.current.text));
      if (match === undefined) { prefix.current.text = char; match = order.find(i => labels[i].toLocaleLowerCase().startsWith(char)); }
      if (match !== undefined) focusItem(match);
    }
  };
  return <span className="chat-model-control" data-state={loading ? 'loading' : disabled ? 'disabled' : state} aria-busy={loading}>
    <button ref={trigger} type="button" className="model-select chat-model-select" aria-label="选择模型" aria-describedby={`${menuID}-value`} aria-haspopup="menu" aria-expanded={open && !blocked} aria-controls={open && !blocked ? menuID : undefined} title={value} disabled={blocked} onClick={() => open ? close() : expand()} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); expand(); } }}><span id={`${menuID}-value`}>{value}</span><ChevronDown size={12} aria-hidden="true" /></button>
    {open && !blocked && createPortal(<div id={menuID} ref={menu} role="menu" aria-label="模型选择" className="chat-model-menu" style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={keyDown}>
      {choices.map((id, index) => <button key={id} ref={node => { items.current[index] = node; }} type="button" role="menuitemradio" aria-checked={id === value} tabIndex={active === index ? 0 : -1} className="chat-model-option" title={id} onFocus={() => setActive(index)} onClick={() => { close(true); if (id !== value) { focusAfterChoice.current = true; onChange(id); } }}><span className="chat-model-option-icon">{id === value && <Check size={14} aria-hidden="true" />}</span><span className="chat-model-option-label">{id}</span></button>)}
      <div className="chat-model-menu-separator" role="separator" />
      <button ref={node => { items.current[choices.length] = node; }} type="button" role="menuitem" tabIndex={active === choices.length ? 0 : -1} className="chat-model-option" onFocus={() => setActive(choices.length)} onClick={() => { close(true); onSettings(); }}><Settings2 size={14} aria-hidden="true" /><span>模型设置…</span></button>
    </div>, document.body)}
  </span>;
}

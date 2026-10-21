import { PERMISSION_CHOICES, permissionLabel } from '../shared/agent-permissions';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ShieldCheck, Hand, FilePenLine, ShieldAlert } from 'lucide-react';
import type { AgentPermissionMode } from '../shared/agent-execution';
import './chat-model-picker.css';

const choices = PERMISSION_CHOICES;
const modeIcon = (mode: AgentPermissionMode) => mode === 'confirm-changes' ? Hand : mode === 'auto-edit' ? FilePenLine : mode === 'full-access' ? ShieldAlert : ShieldCheck;

/** Presentation only: the caller retains the Agent's existing policy mapping. */
export function AgentPermissionPicker({ value, disabled, policy, onChange }: {
  value: AgentPermissionMode; disabled: boolean; policy: string;
  onChange(value: AgentPermissionMode): void;
}) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]), focusOnOpen = useRef(false);
  const id = useId();
  const [details, setDetails] = useState(false);
  const Icon = modeIcon(value);
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus(); };
  const expand = () => {
    if (disabled) return;
    focusOnOpen.current = true; setActive(Math.max(0, choices.findIndex(item => item.value === value)));
    setPosition(undefined); setOpen(true);
  };
  useEffect(() => { setOpen(false); }, [disabled, value]);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), panel = menu.current;
      if (!anchor || !panel) return;
      const width = Math.min(350, innerWidth - 16), above = anchor.top > innerHeight - anchor.bottom;
      const available = above ? anchor.top : innerHeight - anchor.bottom;
      const maxHeight = Math.max(48, Math.min(520, available - 14));
      const height = Math.min(panel.scrollHeight + 2, maxHeight);
      setPosition({ width, maxHeight, left: Math.max(8, Math.min(anchor.left, innerWidth - width - 8)), top: above ? Math.max(8, anchor.top - height - 6) : anchor.bottom + 6 });
    };
    place();
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!trigger.current?.contains(node) && !menu.current?.contains(node)) close();
    };
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, disabled, details]);
  useLayoutEffect(() => {
    if (open && position && focusOnOpen.current) {
      focusOnOpen.current = false; items.current[active]?.focus({ preventScroll: true });
    }
  }, [open, position, active]);
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const next = event.key === 'ArrowDown' ? (active + 1) % (choices.length + 1) : event.key === 'ArrowUp' ? (active + (choices.length + 1) - 1) % (choices.length + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? (choices.length + 1) - 1 : undefined;
    if (next !== undefined) { event.preventDefault(); setActive(next); items.current[next]?.focus(); }
  };
  return <>
    <button ref={trigger} type="button" className="agent-permission-picker" data-mode={value} title={policy} aria-label="Agent 权限" aria-describedby={`${id}-value`} aria-haspopup="menu" aria-expanded={open && !disabled} aria-controls={open && !disabled ? id : undefined} disabled={disabled} onClick={() => open ? close() : expand()} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); expand(); }
    }}><Icon size={14} aria-hidden="true" /><span id={`${id}-value`}>{permissionLabel(value)}</span><ChevronDown size={12} aria-hidden="true" /></button>
    {open && !disabled && createPortal(<div ref={menu} id={id} role="menu" aria-label="Agent 权限选择" className="chat-model-menu agent-permission-menu" style={{ ...position, visibility: position ? 'visible' : 'hidden' }} onKeyDown={keyDown}>
      <div className="agent-permission-heading">选择执行权限</div>
      {choices.map((item, index) => { const RowIcon = modeIcon(item.value); return <button key={item.value} ref={node => { items.current[index] = node; }} type="button" role="menuitemradio" aria-label={item.label} aria-describedby={`${id}-${index}-description`} aria-checked={item.value === value} className="chat-model-option agent-permission-option" data-mode={item.value} tabIndex={active === index ? 0 : -1} onFocus={() => setActive(index)} onClick={() => { close(true); if (item.value !== value) onChange(item.value); }}><RowIcon size={16} aria-hidden="true" /><span className="agent-permission-copy"><span>{item.label}</span><small id={`${id}-${index}-description`}>{item.description}</small></span><Check className={item.value === value ? "agent-permission-check" : "agent-permission-check is-hidden"} size={14} aria-hidden="true" /></button>; })}
      <div className="chat-model-menu-separator" role="separator" />
      <button ref={node => { items.current[choices.length] = node; }} type="button" role="menuitem" className="chat-model-option agent-permission-details-toggle" tabIndex={active === choices.length ? 0 : -1} aria-expanded={details} onFocus={() => setActive(choices.length)} onClick={() => setDetails(value => !value)}>权限详情<ChevronDown size={12} aria-hidden="true" /></button>
      {details && <p className="agent-permission-details">{policy}</p>}
    </div>, document.body)}
  </>;
}

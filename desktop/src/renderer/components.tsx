import React, { useEffect, useRef, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertCircle, Check, Circle, Clock3, LoaderCircle, Square, X } from 'lucide-react';
import type { TurnState } from '../shared/types';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /></span>{!compact && <span>ScreenDeck</span>}</span>;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon" aria-hidden="true">{icon}</div><h2>{title}</h2>{children && <p>{children}</p>}{action && <div className="empty-action">{action}</div>}</div>;
}

export function Notice({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return <div className="notice" role="status"><AlertCircle size={16} /><span>{children}</span>{onDismiss && <button className="icon-button" aria-label="关闭提示" onClick={onDismiss}><X size={15} /></button>}</div>;
}

const stateLabels: Record<TurnState, string> = {
  prepared: '准备中', submitting: '正在提交', streaming: '正在回复', finished: '已完成',
  failed: '请求失败', cancelling: '正在停止', cancelled: '已停止', unknown: '状态未知',
};
export const isBusy = (state?: TurnState) => !!state && ['prepared', 'submitting', 'streaming', 'cancelling'].includes(state);
export function StateLabel({ state }: { state: TurnState }) {
  const Icon = state === 'finished' ? Check : state === 'failed' || state === 'unknown' ? AlertCircle : state === 'cancelled' ? Square : isBusy(state) ? LoaderCircle : Circle;
  return <span className={`state-label state-${state}`}><Icon size={13} className={isBusy(state) ? 'busy-icon' : ''} />{stateLabels[state]}</span>;
}

export function formatDate(value?: string | null, withTime = true): string {
  if (!value) return '时间未记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间无法识别';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(date);
}

/** Model output never creates image requests or interprets raw HTML. */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml components={{
    img: ({ alt }) => <span className="omitted-image">[图片{alt ? `：${alt}` : ''}]</span>,
    a: ({ children, href }) => <span className="message-link">{children}{href ? ` (${href})` : ''}</span>,
  }}>{text}</ReactMarkdown></div>;
}

export function TimelineRow({ title, date, children, state }: { title: string; date: string | null; children?: ReactNode; state?: ReactNode }) {
  return <article className="timeline-row"><div className="timeline-marker"><Clock3 size={14} /></div><div className="timeline-body"><div className="timeline-heading"><strong>{title}</strong>{state}</div><time>{formatDate(date)}</time>{children}</div></article>;
}

/** All background regions become inert while a sheet is open. */
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const initialClose = useRef(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const shell = document.getElementById('app-shell');
    shell?.setAttribute('inert', '');
    const target = dialog.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? dialog.current?.querySelector<HTMLElement>('button:not(:disabled)');
    target?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); initialClose.current(); }
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { shell?.removeAttribute('inert'); document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>{children}</div></div>;
}

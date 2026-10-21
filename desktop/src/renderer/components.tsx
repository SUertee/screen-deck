import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertCircle, Check, Circle, Clock3, Copy, LoaderCircle, ChevronDown, Square, X } from 'lucide-react';
import type { TurnState } from '../shared/types';
import './message-content.css';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><span className="brand-mark" aria-hidden="true" />{!compact && <span>ScreenDeck</span>}</span>;
}

/** A source change prepares a new chat; it never starts a runtime or moves history. */
export function ChatSourcePicker({ value, onChange, disabled = false, state = 'default' }: {
  value: 'model' | 'agent'; onChange: (value: 'model' | 'agent') => void; disabled?: boolean; state?: 'default' | 'loading' | 'error' | 'success';
}) {
  const name = value === 'agent' ? 'OpenCode' : '直接模型';
  return <span className="chat-source-control" data-source={value} data-state={disabled ? 'disabled' : state} aria-busy={state === 'loading'} title={`${name} · 切换聊天来源`}>
    <select className="chat-source-select" aria-label="聊天来源" aria-describedby="chat-source-hint" value={value} disabled={disabled} onChange={event => onChange(event.target.value === 'agent' ? 'agent' : 'model')}>
      <option value="model">直接模型</option><option value="agent">OpenCode</option>
    </select>
    <ChevronDown className="chat-source-chevron" size={12} aria-hidden="true" />
    <span id="chat-source-hint" className="visually-hidden">切换来源会进入新聊天，保留原记录与草稿。</span>
  </span>;
}

export { ChatModelPicker } from './ChatModelPicker';

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

/** Clipboard writes use the fixed main-process API and the supplied source text. */
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'default' | 'loading' | 'success' | 'error'>('default');
  const feedbackID = useId();
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const attempt = useRef(0);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current++;
      if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    };
  }, []);

  useEffect(() => {
    attempt.current++;
    inFlight.current = false;
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    setState('default');
  }, [text]);

  const copy = async () => {
    if (inFlight.current || text.length === 0) return;
    inFlight.current = true;
    const currentAttempt = ++attempt.current;
    if (resetTimer.current !== undefined) window.clearTimeout(resetTimer.current);
    setState('loading');
    try {
      const api = window.screendeck;
      if (!api?.copyText) throw new Error('Clipboard bridge unavailable.');
      await api.copyText(text);
      if (!mounted.current || attempt.current !== currentAttempt) return;
      inFlight.current = false;
      setState('success');
      resetTimer.current = window.setTimeout(() => {
        if (mounted.current && attempt.current === currentAttempt) setState('default');
      }, 1800);
    } catch {
      if (!mounted.current || attempt.current !== currentAttempt) return;
      inFlight.current = false;
      setState('error');
    }
  };

  const disabled = text.length === 0 || state === 'loading';
  const feedback = state === 'loading' ? '正在复制。' : state === 'success' ? '已复制。' : state === 'error' ? '复制失败，请点击重试。' : '';
  const Icon = state === 'loading' ? LoaderCircle : state === 'success' ? Check : state === 'error' ? AlertCircle : Copy;
  const buttonText = state === 'loading' ? '复制中…' : state === 'success' ? '已复制' : state === 'error' ? '重试复制' : label;

  return <span className="copy-control">
    <button
      className="copy-button"
      type="button"
      aria-label={label}
      aria-describedby={feedbackID}
      aria-busy={state === 'loading'}
      title={state === 'error' ? '复制失败，请点击重试。' : label}
      data-testid="copy-button"
      data-copy-state={text.length === 0 ? 'disabled' : state}
      disabled={disabled}
      onClick={() => { void copy(); }}
    >
      <Icon size={14} className="copy-button-icon" aria-hidden="true" />
      <span className="copy-button-label">{buttonText}</span>
    </button>
    <span id={feedbackID} className="copy-status" role="status" aria-live="polite" aria-atomic="true">{feedback}</span>
  </span>;
}

/** Model output never creates image requests or interprets raw HTML. */
export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml components={{
    img: ({ alt }) => <span className="omitted-image">[图片{alt ? `：${alt}` : ''}]</span>,
    a: ({ children, href }) => <span className="message-link">{children}{href ? ` (${href})` : ''}</span>,
    pre: ({ node, children }) => {
      const code = node?.children[0];
      if (code?.type !== 'element' || code.tagName !== 'code' || code.children.some(child => child.type !== 'text')) return <pre>{children}</pre>;
      const rendered = code.children.map(child => child.type === 'text' ? child.value : '').join('');
      // The installed mdast-util-to-hast code handler appends one LF to nonempty
      // blocks. Remove only that generated LF; preserve indentation and blank lines.
      const source = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
      const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
      const language = classes.find(value => typeof value === 'string' && value.startsWith('language-'))?.toString().slice(9) ?? '';
      return <section className="markdown-code-block" data-testid="markdown-code-block">
        <header className="markdown-code-header">
          <span className="markdown-code-language" title={language || '纯文本'}>{language || '纯文本'}</span>
          <CopyButton text={source} label="复制代码" />
        </header>
        <pre className="markdown-code-pre" tabIndex={0} aria-label={language ? `${language} 代码` : '代码'}><code>{source}</code></pre>
      </section>;
    },
  }}>{text}</ReactMarkdown></div>;
}

export function TimelineRow({ title, date, children, state }: { title: string; date: string | null; children?: ReactNode; state?: ReactNode }) {
  return <article className="timeline-row"><div className="timeline-marker"><Clock3 size={14} /></div><div className="timeline-body"><div className="timeline-heading"><strong>{title}</strong>{state}</div><time>{formatDate(date)}</time>{children}</div></article>;
}

/** All background regions become inert while a sheet is open. */
export function Modal({ title, children, onClose, wide = false, className, hideHeader = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; className?: string; hideHeader?: boolean }) {
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
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}><div className={`modal ${wide ? 'modal-wide' : ''} ${className ?? ''}`} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title">{hideHeader ? <h2 className="visually-hidden" id="modal-title">{title}</h2> : <header className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>}{children}</div></div>;
}

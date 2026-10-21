import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Search } from 'lucide-react';
import type { ChatPreferences } from '../shared/chat-management';
import { chatKey, isAgentChat, searchChats, type ChatMatch, type ChatRecord } from './chat-history';
import { formatDate, Modal } from './components';
import './chat-foundation.css';

function Match({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase(), index = text.toLowerCase().indexOf(needle);
  return index < 0 || !needle ? <>{text}</> : <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}
export function ChatSearch({ records, preferences, query, onQuery, onOpen, onClose, loading = false, origin }: {
  records: ChatRecord[]; preferences: ChatPreferences; query: string; onQuery: (value: string) => void;
  onOpen: (record: ChatRecord, messageID?: string) => void | Promise<void>; onClose: () => void; loading?: boolean; origin?: { x: number; y: number } | null;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState<{ message: string; match: ChatMatch } | null>(null);
  const openingRef = useRef(false);
  const mounted = useRef(true);
  const options = useRef(new Map<string, HTMLButtonElement>());
  const listID = useId();
  const content = useRef<HTMLDivElement>(null);
  // Measure the resting frame before animating; query changes never replay entry.
  useLayoutEffect(() => {
    const dialog = content.current?.closest<HTMLElement>('.chat-search-modal');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (!dialog || reduced.matches || typeof dialog.animate !== 'function') return;
    const bounds = dialog.getBoundingClientRect();
    const dx = origin ? origin.x - (bounds.left + bounds.width / 2) : 0;
    const dy = origin ? origin.y - (bounds.top + bounds.height / 2) : 12;
    const entry = dialog.animate([
      { transform: `translate3d(${dx}px, ${dy}px, 0) scale(.18)`, opacity: 0 },
      { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
    ], { duration: 260, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    const reduceMotion = () => { if (reduced.matches) entry.cancel(); };
    reduced.addEventListener('change', reduceMotion);
    return () => { reduced.removeEventListener('change', reduceMotion); entry.cancel(); };
  }, []);
  const hasQuery = !!query.trim();
  const matches: ChatMatch[] = hasQuery ? searchChats(records, preferences, query, 'all', true) : [];
  const activeIndex = Math.max(0, matches.findIndex(match => chatKey(match.record) === activeKey));
  const active = matches[activeIndex];
  const optionID = (index: number) => `${listID}-${index}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setActiveKey(null); setFailure(null); }, [query]);
  useEffect(() => { if (active) options.current.get(chatKey(active.record))?.scrollIntoView({ block: 'nearest' }); }, [active && chatKey(active.record)]);

  const open = async (match: ChatMatch) => {
    if (loading || openingRef.current) return;
    openingRef.current = true; setOpening(true); setFailure(null);
    try { await onOpen(match.record, match.messageID); if (mounted.current) onClose(); }
    catch (error) { if (mounted.current) setFailure({ message: error instanceof Error ? `无法打开聊天：${error.message}` : '无法打开聊天，请重试。', match }); }
    finally { openingRef.current = false; if (mounted.current) setOpening(false); }
  };
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || loading || openingRef.current || !matches.length) return;
    const target = event.target as HTMLElement;
    if (!target.matches('input[type="search"], [data-chat-search-key]')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      const key = chatKey(matches[index].record);
      setActiveKey(key);
      if (target.matches('[data-chat-search-key]')) options.current.get(key)?.focus();
    } else if (event.key === 'Enter' && active) { event.preventDefault(); void open(active); }
  };
  return <Modal title="搜索聊天" className="chat-search-modal" hideHeader onClose={onClose}>
    <div className="chat-search" ref={content} onKeyDown={onKey}>
      <div className="chat-search-field"><Search size={18} aria-hidden="true" /><input type="search" data-autofocus aria-label="搜索聊天" aria-controls={hasQuery ? listID : undefined} aria-activedescendant={active && !loading ? optionID(activeIndex) : undefined} placeholder="搜索聊天内容…" value={query} disabled={opening} onChange={event => onQuery(event.target.value)} /></div>
      {hasQuery && <>
        <span className="visually-hidden" role="status">{loading ? '正在读取聊天' : opening ? '正在打开聊天' : `${matches.length} 个结果`}</span>
        <div className="chat-search-results" id={listID} role="listbox" aria-label="聊天结果" aria-busy={loading || opening}>
          {loading ? <div className="chat-search-empty" role="status"><RefreshCw size={16} className="busy-icon" aria-hidden="true" /><span>正在查找…</span></div> : matches.length ? matches.map((match, index) => {
            const key = chatKey(match.record);
            return <button role="option" aria-selected={index === activeIndex} data-active={index === activeIndex} data-chat-search-key={key} id={optionID(index)} className="chat-search-result" aria-label={`聊天：${match.record.title}`} key={key} disabled={opening} ref={node => { if (node) options.current.set(key, node); else options.current.delete(key); }} onFocus={() => setActiveKey(key)} onMouseEnter={() => setActiveKey(key)} onClick={() => void open(match)}>
              <div className="chat-search-result-copy"><strong><Match text={match.record.title} query={query} /></strong>{match.snippet && <p className="chat-search-snippet"><Match text={match.snippet} query={query} /></p>}<span className="chat-search-meta">{isAgentChat(match.record) ? 'OpenCode' : '模型聊天'}{match.archived ? ' · 已归档' : ''} · {formatDate(match.record.updated_at)}</span></div><ChevronRight size={14} aria-hidden="true" />
            </button>;
          }) : <div className="chat-search-empty" role="status">没有找到相关聊天</div>}
        </div>
        {failure && <div className="chat-search-error" role="alert"><span>{failure.message}</span><button className="text-button" disabled={opening} onClick={() => void open(failure.match)}>重试打开</button></div>}
      </>}
    </div>
  </Modal>;
}

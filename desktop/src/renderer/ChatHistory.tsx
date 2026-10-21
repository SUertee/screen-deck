import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ArrowLeft, MessageSquare, MoreHorizontal, Pin, PinOff, Pencil, Plus } from 'lucide-react';
import type { ChatPreferences } from '../shared/chat-management';
import { chatKey, chatPreference, isAgentChat, orderedChats, type ChatRecord } from './chat-history';
import { isBusy, Modal } from './components';
import './chat-foundation.css';

interface Props {
  records: ChatRecord[]; preferences: ChatPreferences; selectedKey?: string; pendingKey?: string; disabled?: boolean;
  onOpen: (record: ChatRecord) => void;
  onRename: (record: ChatRecord, title: string) => Promise<void>;
  onArchive: (record: ChatRecord, archived: boolean) => Promise<void>;
  onPin: (record: ChatRecord, pinned: boolean) => Promise<void>;
  onSearch: () => void;
  onNewChat: () => void;
}
const failure = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
export function ChatHistory(props: Props) {
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState<{ record: ChatRecord; trigger: HTMLButtonElement; top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState<ChatRecord | null>(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [operating, setOperating] = useState<string | null>(null);
  const records = orderedChats(props.records, props.preferences, archived);
  const pendingRecord = props.records.find(record => chatKey(record) === props.pendingKey);
  if (!archived && pendingRecord) { const index = records.findIndex(record => chatKey(record) === props.pendingKey); if (index >= 0) records.splice(index, 1); records.unshift(pendingRecord); }
  const menuRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = () => { setMenu(null); menu.trigger.focus(); };
    const pointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && event.target !== menu.trigger) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Tab') { close(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key, true); };
  }, [menu]);
  const closeRename = () => { if (!savingRef.current) { setRenaming(null); setError(''); } };
  const operate = async (record: ChatRecord, operation: () => Promise<void>) => {
    const trigger = menu?.trigger; setMenu(null); setOperating(chatKey(record)); setError(''); trigger?.focus();
    try { await operation(); } catch (error) { setError(failure(error)); } finally { setOperating(null); }
  };
  const blocked = (record: ChatRecord) => !!props.disabled || operating === chatKey(record) || props.pendingKey === chatKey(record) || isBusy(record.turns.at(-1)?.state);
  const menuRecord = menu && props.records.find(record => chatKey(record) === chatKey(menu.record));
  return <section className="sidebar-section chat-history" aria-label={archived ? '已归档聊天列表' : '最近聊天列表'}>
    <div className="sidebar-heading"><span>{archived ? '已归档聊天' : '最近聊天'}</span><span className="chat-history-actions"><button className="icon-button" aria-label="新建聊天" title="新建聊天" onClick={() => { setArchived(false); setError(''); props.onNewChat(); }}><Plus size={15} /></button><button className="icon-button" aria-label={archived ? '返回最近聊天' : '查看已归档聊天'} title={archived ? '返回最近聊天' : '已归档聊天'} onClick={() => { setArchived(value => !value); setError(''); }}>{archived ? <ArrowLeft size={13} /> : <Archive size={13} />}</button></span></div>
    {records.slice(0, 30).map(record => <div className="chat-history-row" key={chatKey(record)}>
      <button data-chat-source={isAgentChat(record) ? 'agent' : 'model'} aria-label={isAgentChat(record) ? record.title + '，OpenCode 聊天' : record.title} title={record.title} className={`session-button ${chatKey(record) === props.selectedKey ? 'active' : ''}`} onClick={() => props.onOpen(record)}><MessageSquare size={12} aria-hidden="true" /><span className="session-button-copy">{record.title || '未命名聊天'}</span>{chatPreference(record, props.preferences).pinned && <Pin className="chat-pin" size={10} aria-label="已置顶" />}</button>
      <button className="icon-button chat-history-more" aria-label={`聊天选项：${record.title}`} aria-haspopup="menu" aria-expanded={!!menu && chatKey(menu.record) === chatKey(record)} disabled={props.disabled || !!operating} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setError(''); setMenu({ record, trigger: event.currentTarget, left: Math.min(rect.left, window.innerWidth - 188), top: Math.min(rect.bottom + 4, window.innerHeight - 152) }); }}><MoreHorizontal size={14} /></button>
    </div>)}
    {!records.length && <p className="sidebar-empty">{archived ? '没有已归档的聊天' : '还没有聊天记录'}</p>}
    {records.length > 30 && <button className="text-button chat-history-all" onClick={props.onSearch}>搜索更多聊天</button>}
    {error && !renaming && <p className="chat-action-error" role="alert">{error}</p>}
    {menu && menuRecord && createPortal(<div ref={menuRef} role="menu" aria-label="聊天选项" className="chat-menu" style={{ top: menu.top, left: Math.max(8, menu.left) }}>
      <button role="menuitem" disabled={blocked(menuRecord)} onClick={() => { menu.trigger.focus(); setRenaming(menuRecord); setTitle(menuRecord.title); setError(''); setMenu(null); }}><Pencil size={14} />重命名</button>
      <button role="menuitem" disabled={props.disabled} onClick={() => void operate(menuRecord, () => props.onPin(menuRecord, !chatPreference(menuRecord, props.preferences).pinned))}>{chatPreference(menuRecord, props.preferences).pinned ? <PinOff size={14} /> : <Pin size={14} />}{chatPreference(menuRecord, props.preferences).pinned ? '取消置顶' : '置顶'}</button>
      <button role="menuitem" disabled={blocked(menuRecord)} title={blocked(menuRecord) ? '请求处理完毕后可整理聊天' : undefined} onClick={() => void operate(menuRecord, () => props.onArchive(menuRecord, !archived))}>{archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{archived ? '恢复聊天' : '归档'}</button>
    </div>, document.body)}
    {renaming && createPortal(<Modal title="重命名聊天" onClose={closeRename}><form className="chat-rename-form" onSubmit={async event => { event.preventDefault(); if (savingRef.current || !title.trim()) return; savingRef.current = true; setSaving(true); setError(''); try { await props.onRename(renaming, title.trim()); setRenaming(null); } catch (error) { setError(failure(error)); } finally { savingRef.current = false; setSaving(false); } }}>
      <label htmlFor="chat-title">聊天名称</label><input id="chat-title" aria-label="聊天名称" data-autofocus value={title} disabled={saving} onChange={event => setTitle(event.target.value)} />
      {error && <p role="alert" className="chat-action-error">{error}</p>}<div className="chat-rename-actions"><button type="button" className="button ghost" disabled={saving} onClick={closeRename}>取消</button><button className="button primary" disabled={saving || !title.trim()} aria-busy={saving}>{saving ? '正在保存…' : '保存'}</button></div>
    </form></Modal>, document.body)}
  </section>;
}

import React, { useMemo } from 'react';
import { Quote } from 'lucide-react';
import type { SessionRecord } from '../shared/types';
import { CopyButton, formatDate, Markdown } from './components';
import './chat-message.css';

export function ChatMessage({ message, isAgent = false, observedModel, showActions, onQuote }: {
  message: SessionRecord['messages'][number];
  isAgent?: boolean;
  observedModel?: string;
  showActions: boolean;
  onQuote: (text: string) => void;
}) {
  const user = message.role === 'user';
  // Draft and toolbar updates must not remount unchanged Markdown/code blocks.
  const body = useMemo(() => user ? message.text : <Markdown text={message.text} />, [user, message.text]);
  const quoteLabel = user ? '引用这条消息' : '引用这条回复';
  return <div className="chat-message-content" data-message-role={message.role}>
    <header className="message-header chat-message-meta">
      <strong>{user ? '你' : isAgent ? 'OpenCode 回复' : '模型回复'}</strong>
      <time dateTime={message.created_at}>{formatDate(message.created_at)}</time>
      {!user && observedModel && <span className="chat-message-model" title={`响应模型：${observedModel}`}>{observedModel}</span>}
    </header>
    <div className="message-body chat-message-body">{body}</div>
    {showActions && <footer className="chat-message-actions">
      <CopyButton text={message.text} label={user ? '复制用户消息' : '复制回复'} />
      <button type="button" className="chat-message-quote" aria-label={quoteLabel} title={quoteLabel} disabled={message.text.length === 0} onClick={() => onQuote(message.text)}><Quote size={14} aria-hidden="true" /><span>引用</span></button>
    </footer>}
  </div>;
}

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import type { CodexStatus, DesktopAPI } from '../shared/desktop-api';
import { Notice } from './components';
import { AgentSettingsCard } from './AgentSettingsCard';
export function CodexSettings({ api }: { api: DesktopAPI }) {
  const [status, setStatus] = useState<CodexStatus>({ state: 'stopped' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(false), pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const refresh = () => { if (!pending.current) void api.getCodexStatus().then(value => { if (mounted.current) setStatus(value); }).catch(() => { if (mounted.current) setError('无法读取 Codex 状态。'); }); };
    refresh(); const unsubscribe = api.subscribe(event => { if (event.type === 'agent-sources-updated') refresh(); });
    return () => { mounted.current = false; unsubscribe(); };
  }, [api]);
  const run = async (operation: () => Promise<CodexStatus>) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { const value = await operation(); if (mounted.current) setStatus(value); }
    catch (value) { if (mounted.current) setError((value instanceof Error ? value.message : 'Codex 操作未完成。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); void api.getCodexStatus().then(value => { if (mounted.current) setStatus(value); }).catch(() => {}); } }
  };
  const text = busy ? '处理中' : status.state === 'ready' ? '已连接' : status.state === 'logging-in' ? '等待登录' : status.state === 'login-required' ? '待登录' : '未连接';
  const subtitle = status.state === 'ready' ? `${status.account} · ${status.model}` : status.state === 'logging-in' ? '请在浏览器中完成 ChatGPT 登录' : '使用 ChatGPT 账号登录';
  return <AgentSettingsCard name="Codex" icon={<Sparkles size={19} />} state={busy ? 'loading' : status.state === 'ready' ? 'ready' : error ? 'error' : status.state} status={text} subtitle={subtitle} busy={busy} testID="codex-runtime-card" actions={<>
    {status.state !== 'stopped' && <button type="button" className="icon-button agent-settings-refresh" title="刷新 Codex 状态" aria-label="刷新 Codex 状态" disabled={busy} onClick={() => void run(() => api.refreshCodex())}><RefreshCw size={14} /></button>}
    {status.state === 'stopped' ? <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api.startCodex())}>连接 Codex</button>
      : status.state === 'login-required' ? <button type="button" className="button primary" disabled={busy} onClick={() => void run(() => api.loginCodex())}>使用 ChatGPT 登录</button>
      : status.state === 'logging-in' ? <button type="button" className="button ghost" disabled={busy} onClick={() => void run(() => api.cancelCodexLogin())}>取消登录</button> : null}
    {status.state !== 'stopped' && <button type="button" className="button ghost" disabled={busy} onClick={() => void run(() => api.stopCodex())}>断开连接</button>}
  </>} details={<>
    <dl className="agent-settings-facts"><dt>支持版本</dt><dd>Codex CLI 0.133.0</dd><dt>接入协议</dt><dd>原生 app-server</dd><dt>登录方式</dt><dd>ChatGPT · Codex 管理登录凭据</dd><dt>工具能力</dt><dd>原生文件、命令、审批和连续对话</dd><dt>执行限制</dt><dd>原生只读或按需审批。按需审批时工作区及自有记忆目录可写；读取范围不以工作目录为界。</dd></dl>
    {status.state === 'stopped' && <button type="button" className="button ghost" disabled={busy} onClick={() => void run(() => api.chooseCodex())}>手动选择程序</button>}
  </>}>
    {error && <div className="settings-feedback"><Notice>{error}</Notice></div>}
  </AgentSettingsCard>;
}

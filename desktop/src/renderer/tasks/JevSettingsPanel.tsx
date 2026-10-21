import React, { useEffect, useRef, useState } from 'react';
import type { DesktopAPI } from '../../shared/desktop-api';
import { DEFAULT_JEV_MODEL, JEV_CONSOLE_URL, isJevModelID, jevFeedback } from './jev-feedback';
type Settings = Awaited<ReturnType<DesktopAPI['getJevSettings']>>;
/** Dedicated configuration form for the Agent Settings judgment-service area. No model calls while loading/saving. */
export function JevSettingsPanel({ api, open, onToggle, onLoaded, onSaved }: {
  api: DesktopAPI; open: boolean; onToggle: (open: boolean) => void;
  onLoaded?: (value: Settings) => void; onSaved?: (value: Settings) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [model, setModel] = useState(DEFAULT_JEV_MODEL), [key, setKey] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const generation = useRef(0), locked = useRef(false);
  useEffect(() => { const id = ++generation.current; void api.getJevSettings().then(s => {
    if (id !== generation.current) return;
    setSettings(s); setModel(typeof s.model === 'string' && s.model.trim() ? s.model : DEFAULT_JEV_MODEL); onLoaded?.(s);
  }).catch(e => { if (id === generation.current) setError(jevFeedback(e).message); }); return () => { generation.current++; }; }, [api]);
  useEffect(() => { if (!open) { setKey(''); setNotice(''); } }, [open]);
  async function save() {
    if (locked.current) return;
    if (!isJevModelID(model.trim())) { setError('请填写 Jev 模型 ID，例如 jev-latest 或官方支持的固定版本。'); return; }
    if (!key.trim() && !settings?.hasKey) { setError('请在专用密码框中填写 TypeSafe API 密钥。'); return; }
    locked.current = true; setBusy(true); setError(''); setNotice(''); const id = generation.current;
    try {
      const s = await api.saveJevSettings({ model: model.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      if (id !== generation.current) return;
      setSettings(s); setKey(''); setNotice('已保存到本机；尚未验证官方账户或发起付费请求。'); onSaved?.(s);
    } catch (e) { if (id === generation.current) setError(jevFeedback(e).message); }
    finally { locked.current = false; if (id === generation.current) setBusy(false); }
  }
  return <details open={open} onToggle={event => { if(!event.currentTarget.open)setKey('');onToggle(event.currentTarget.open); }}>
    <summary onClick={() => { if(open)setKey(''); }}>TypeSafe 官方 API 设置 · {settings ? settings.hasKey ? '已保存密钥，未验证账户' : '未配置' : '读取中'}</summary>
    <p>在 TypeSafe 官方控制台创建 API 密钥，再填写下方专用密码框。密钥保存在本机私有文件，请勿粘贴到聊天。</p>
    <p>官方控制台：<code>{JEV_CONSOLE_URL}</code> <button type="button" className="button small ghost" onClick={() => void navigator.clipboard.writeText(JEV_CONSOLE_URL).then(() => setNotice('已复制官方控制台地址。')).catch(() => setError('复制失败，请手动复制上方地址。'))}>复制控制台地址</button></p>
    <p>仅提供分工判断，执行权限由所选 Agent 另行确认。</p>
    <label className="task-field">模型 ID<input aria-label="Jev 模型版本" value={model} disabled={busy || !settings} onChange={e => setModel(e.target.value)} placeholder={DEFAULT_JEV_MODEL}/></label>
    <p>默认 jev-latest 为官方稳定别名，可能随发布变化；结果会记录服务报告的模型版本。</p>
    <label className="task-field">TypeSafe API 密钥<input aria-label="Jev API 密钥" type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy || !settings} placeholder={settings?.hasKey ? '留空保留已保存的专用密钥' : '仅在此输入 TypeSafe 专用密钥'} onChange={e => setKey(e.target.value)}/></label>
    <button type="button" className="button small ghost" disabled={busy} onClick={() => { const id=++generation.current;setError('');void api.getJevSettings().then(s=>{if(id!==generation.current)return;setSettings(s);setModel(s.model||DEFAULT_JEV_MODEL);onLoaded?.(s);}).catch(e=>{if(id===generation.current)setError(jevFeedback(e).message);}); }}>重新读取配置</button>
    <button type="button" className="button small" disabled={busy || !settings} onClick={() => void save()}>{busy ? '保存中…' : '保存 Jev 设置'}</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="task-save-error">{error}</p>}
  </details>;
}

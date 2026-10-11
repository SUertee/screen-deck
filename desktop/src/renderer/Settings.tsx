import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { ProviderSettings, SettingsInput } from '../shared/desktop-api';
import { Modal, Notice } from './components';

const hasSavedCipher = (storage: ProviderSettings['credentialStorage']) => storage === 'encrypted' || storage === 'locked';

export function Settings({ open, settings, onClose, onSave, dataRootLabel }: { open: boolean; settings: ProviderSettings; onClose: () => void; onSave: (input: SettingsInput) => Promise<ProviderSettings>; dataRootLabel: string }) {
  const [baseURL, setBaseURL] = useState(settings.baseURL);
  const [modelID, setModelID] = useState(settings.modelID);
  const [apiKey, setAPIKey] = useState('');
  const [rememberKey, setRememberKey] = useState(hasSavedCipher(settings.credentialStorage));
  const [forgetKey, setForgetKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const operationPending = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!dirty) { setBaseURL(settings.baseURL); setModelID(settings.modelID); setRememberKey(hasSavedCipher(settings.credentialStorage)); } }, [settings, dirty]);
  useEffect(() => { if (!open) { setAPIKey(''); setDirty(baseURL !== settings.baseURL || modelID !== settings.modelID || rememberKey !== hasSavedCipher(settings.credentialStorage) || forgetKey); } }, [open]);
  const edit = () => { setDirty(true); setMessage(''); setError(''); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (operationPending.current) return; setError(''); setMessage('');
    if (!modelID.trim()) { setError('请填写要请求的模型名称。'); return; }
    let url: URL;
    try { url = new URL(baseURL); } catch { setError('请填写完整的 API 地址，例如 https://example.com/v1。'); return; }
    if (url.protocol !== 'https:') { setError('API 地址需要使用 HTTPS。'); return; }
    operationPending.current = true; setBusy(true);
    try { const saved = await onSave({ baseURL: baseURL.trim(), modelID: modelID.trim(), apiKey: apiKey.trim() || undefined, rememberKey, forgetKey }); setAPIKey(''); setForgetKey(false); setDirty(false); setRememberKey(hasSavedCipher(saved.credentialStorage)); setMessage(hasSavedCipher(saved.credentialStorage) ? '连接设置已保存。发送时会自动读取已保存密钥。' : !saved.hasKey ? '连接设置已保存。发送前请填写该服务的 API 密钥。' : '连接设置已保存。密钥仅保留到应用退出。'); }
    catch (value) { setError(value instanceof Error ? value.message : '保存失败，当前输入已保留。'); }
    finally { operationPending.current = false; setBusy(false); }
  };
  if (!open) return null;
  return <Modal title="设置" onClose={onClose}><div className="modal-body"><p className="settings-intro">配置一个兼容 Chat Completions 的服务。保存连接后，实际请求会使用这里指定的模型。</p><form className="settings-form" onSubmit={event => void save(event)} aria-busy={busy}><fieldset className="plain-fieldset" disabled={busy}>
    <div className="field"><label htmlFor="provider-url">API 地址</label><input id="provider-url" type="url" autoComplete="off" spellCheck={false} value={baseURL} onChange={event => { setBaseURL(event.target.value); edit(); }} required /><p className="field-help">填写服务的基础地址；请求由桌面进程发送。</p></div>
    <div className="field"><label htmlFor="provider-model">模型名称</label><input id="provider-model" autoComplete="off" spellCheck={false} value={modelID} onChange={event => { setModelID(event.target.value); edit(); }} required /><p className="field-help">实际响应中的模型名称会单独记录。</p></div>
    <div className="field credential-field"><label htmlFor="provider-key"><KeyRound size={12} /> API 密钥</label><input id="provider-key" type="password" autoComplete="new-password" placeholder={hasSavedCipher(settings.credentialStorage) ? '已保存密钥；留空继续使用' : settings.hasKey ? '已配置密钥；留空继续使用' : '填写服务的 API 密钥'} value={apiKey} onChange={event => { setAPIKey(event.target.value); setForgetKey(false); edit(); }} /><label className="checkbox-row"><input type="checkbox" checked={rememberKey} onChange={event => { setRememberKey(event.target.checked); edit(); }} />记住 API 密钥</label><p className="field-help">通过系统加密后保存在本机；不勾选时，新密钥仅保留到应用退出。</p>{['encrypted', 'locked', 'memory'].includes(settings.credentialStorage) && <label className="checkbox-row"><input type="checkbox" checked={forgetKey} onChange={event => { setForgetKey(event.target.checked); if (event.target.checked) setAPIKey(''); edit(); }} />保存时移除已有密钥</label>}{hasSavedCipher(settings.credentialStorage) && <p className="field-help">发送时会自动读取已保存密钥；如系统提示，请完成授权。</p>}</div>
    <div className="settings-feedback" aria-live="polite">{error && <Notice>{error}</Notice>}{message && <div className="settings-test" role="status">{message}</div>}</div>
    <div className="settings-actions"><button className="button primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存连接'}</button><button className="button ghost" type="button" onClick={onClose}>完成</button>{dirty && <span className="field-help">尚未保存；关闭后保留地址和模型草稿，清除未保存的密钥</span>}</div>
  </fieldset></form><p className="field-help" style={{ marginTop: 24 }}>本地预览数据：{dataRootLabel}<br />项目历史保持只读。设置关闭不会停止正在进行的请求。</p></div></Modal>;
}

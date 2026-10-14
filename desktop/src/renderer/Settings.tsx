import React, { useEffect, useRef, useState } from 'react';
import { Database, KeyRound, Plug, SlidersHorizontal } from 'lucide-react';
import type { DesktopAPI, ProviderSettings, SettingsInput } from '../shared/desktop-api';
import { Modal, Notice } from './components';
import { OpenCodeSettings } from './OpenCodeSettings';

export type SettingsSection = 'models' | 'tools' | 'data';
const sections = [
  { id: 'models', label: '模型服务', Icon: SlidersHorizontal },
  { id: 'tools', label: '编码工具', Icon: Plug },
  { id: 'data', label: '本地数据', Icon: Database },
] as const;
const hasSavedCipher = (storage: ProviderSettings['credentialStorage']) => storage === 'encrypted' || storage === 'locked';
const credentialLabels: Record<ProviderSettings['credentialStorage'], string> = {
  encrypted: '已加密保存在本机',
  locked: '已保存，发送时按需读取',
  memory: '仅保留到应用退出',
  none: '尚未配置',
};

interface SettingsProps {
  open: boolean;
  settings: ProviderSettings;
  onClose: () => void;
  onSave: (input: SettingsInput) => Promise<ProviderSettings>;
  dataRootLabel: string;
  runtimeAPI: DesktopAPI;
  initialSection?: SettingsSection;
}

export function Settings({ open, settings, onClose, onSave, dataRootLabel, runtimeAPI, initialSection }: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? 'models');
  const [baseURL, setBaseURL] = useState(settings.baseURL);
  const [modelID, setModelID] = useState(settings.modelID);
  const [apiKey, setAPIKey] = useState('');
  const [rememberKey, setRememberKey] = useState(hasSavedCipher(settings.credentialStorage));
  const [forgetKey, setForgetKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [invalidField, setInvalidField] = useState<'url' | 'model' | undefined>();
  const operationPending = useRef(false);
  const wasOpen = useRef(false);
  const tabButtons = useRef<Partial<Record<SettingsSection, HTMLButtonElement>>>({});

  useEffect(() => {
    if (dirty) return;
    setBaseURL(settings.baseURL);
    setModelID(settings.modelID);
    setRememberKey(hasSavedCipher(settings.credentialStorage));
  }, [settings, dirty]);

  useEffect(() => {
    let frame: number | undefined;
    if (open && !wasOpen.current && initialSection) {
      setSection(initialSection);
      frame = requestAnimationFrame(() => tabButtons.current[initialSection]?.focus());
    }
    if (!open) {
      setAPIKey('');
      setDirty(baseURL !== settings.baseURL || modelID !== settings.modelID || rememberKey !== hasSavedCipher(settings.credentialStorage) || forgetKey);
    }
    wasOpen.current = open;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [open, initialSection]);

  const selectSection = (next: SettingsSection, focus = false) => {
    setSection(next);
    if (focus) tabButtons.current[next]?.focus();
  };
  const navigateTabs = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault();
    selectSection(sections[next].id, true);
  };
  const edit = () => {
    setDirty(true);
    setMessage('');
    setError('');
    setInvalidField(undefined);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (operationPending.current) return;
    setError('');
    setMessage('');
    setInvalidField(undefined);
    if (!modelID.trim()) {
      setInvalidField('model');
      setError('请填写要请求的模型名称。');
      return;
    }
    let url: URL;
    try { url = new URL(baseURL); }
    catch {
      setInvalidField('url');
      setError('请填写完整的 API 地址，例如 https://example.com/v1。');
      return;
    }
    if (url.protocol !== 'https:') {
      setInvalidField('url');
      setError('API 地址需要使用 HTTPS。');
      return;
    }
    operationPending.current = true;
    setBusy(true);
    try {
      const saved = await onSave({ baseURL: baseURL.trim(), modelID: modelID.trim(), apiKey: apiKey.trim() || undefined, rememberKey, forgetKey });
      setBaseURL(saved.baseURL);
      setModelID(saved.modelID);
      setAPIKey('');
      setForgetKey(false);
      setDirty(false);
      setRememberKey(hasSavedCipher(saved.credentialStorage));
      setMessage(hasSavedCipher(saved.credentialStorage)
        ? '连接设置已保存。发送时会自动读取已保存密钥。'
        : !saved.hasKey ? '连接设置已保存。发送前请填写该服务的 API 密钥。' : '连接设置已保存。密钥仅保留到应用退出。');
    } catch (value) {
      setError(value instanceof Error ? value.message : '保存失败，当前输入已保留。');
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <Modal title="设置" onClose={onClose} className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
          {sections.map(({ id, label, Icon }, index) => (
            <button
              key={id}
              ref={element => { tabButtons.current[id] = element ?? undefined; }}
              className={`settings-nav-item${section === id ? ' is-active' : ''}`}
              id={`settings-tab-${id}`}
              data-testid={`settings-tab-${id}`}
              data-autofocus={section === id ? '' : undefined}
              type="button"
              role="tab"
              aria-selected={section === id}
              aria-controls={`settings-panel-${id}`}
              tabIndex={section === id ? 0 : -1}
              onClick={() => selectSection(id)}
              onKeyDown={event => navigateTabs(event, index)}
            >
              <Icon size={16} aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          <section id="settings-panel-models" data-testid="settings-panel-models" role="tabpanel" aria-labelledby="settings-tab-models" hidden={section !== 'models'}>
            <header className="settings-section-header">
              <h3>模型服务</h3>
              <p>用于普通聊天，也可供 OpenCode 使用。</p>
            </header>
            <form className="settings-form" onSubmit={event => void save(event)} aria-busy={busy} data-state={busy ? 'loading' : error ? 'error' : message ? 'success' : dirty ? 'dirty' : 'default'}>
              <fieldset className="plain-fieldset" disabled={busy}>
                <div className="field">
                  <label htmlFor="provider-url">API 地址</label>
                  <input id="provider-url" type="url" autoComplete="off" spellCheck={false} value={baseURL} aria-invalid={invalidField === 'url' || undefined} aria-describedby="provider-url-help" onChange={event => { setBaseURL(event.target.value); edit(); }} required />
                  <p id="provider-url-help" className="field-help">兼容 Chat Completions 的 HTTPS 基础地址。</p>
                </div>
                <div className="field">
                  <label htmlFor="provider-model">模型名称</label>
                  <input id="provider-model" autoComplete="off" spellCheck={false} value={modelID} aria-invalid={invalidField === 'model' || undefined} aria-describedby="provider-model-help" onChange={event => { setModelID(event.target.value); edit(); }} required />
                  <p id="provider-model-help" className="field-help">填写服务支持的模型名称。</p>
                </div>
                <div className="field credential-field">
                  <label htmlFor="provider-key"><KeyRound size={14} aria-hidden="true" /> API 密钥</label>
                  <input id="provider-key" type="password" autoComplete="new-password" aria-describedby="provider-key-help" placeholder={hasSavedCipher(settings.credentialStorage) ? '已保存密钥；留空继续使用' : settings.hasKey ? '已配置密钥；留空继续使用' : '填写服务的 API 密钥'} value={apiKey} onChange={event => { setAPIKey(event.target.value); setForgetKey(false); edit(); }} />
                  <p id="provider-key-help" className="field-help">已保存密钥不会显示在这里。关闭设置时清除未保存的密钥输入。</p>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={rememberKey} onChange={event => { setRememberKey(event.target.checked); edit(); }} />记住 API 密钥
                  </label>
                  <p className="field-help">勾选后通过系统加密保存在本机；不勾选时，新密钥仅保留到应用退出。</p>
                  {['encrypted', 'locked', 'memory'].includes(settings.credentialStorage) && (
                    <label className="checkbox-row">
                      <input type="checkbox" checked={forgetKey} onChange={event => { setForgetKey(event.target.checked); if (event.target.checked) setAPIKey(''); edit(); }} />保存时移除已有密钥
                    </label>
                  )}
                  {hasSavedCipher(settings.credentialStorage) && <p className="field-help">发送时按需读取已保存密钥；系统可能请求授权。</p>}
                </div>
              </fieldset>
              <div className="settings-feedback" aria-live="polite">
                {error && <Notice>{error}</Notice>}
                {message && <div className="settings-test" role="status">{message}</div>}
              </div>
              <footer className="settings-footer">
                <p className="field-help">{dirty ? '有未保存修改；切换分类保留草稿。' : '保存连接不会启动编码工具或发送请求。'}</p>
                <div className="settings-actions">
                  <button className="button ghost" type="button" onClick={onClose}>取消</button>
                  <button className="button primary" data-testid="settings-save-model" disabled={busy} type="submit">{busy ? '正在保存…' : '保存连接'}</button>
                </div>
              </footer>
            </form>
          </section>

          <section id="settings-panel-tools" data-testid="settings-panel-tools" role="tabpanel" aria-labelledby="settings-tab-tools" hidden={section !== 'tools'}>
            <header className="settings-section-header">
              <h3>编码工具</h3>
              <p>连接本机工具，在聊天中确认执行。</p>
            </header>
            <OpenCodeSettings api={runtimeAPI} settingsDirty={dirty || busy} onEditModel={() => selectSection('models', true)} />
            <footer className="settings-footer">
              <p className="field-help">关闭设置不会关闭执行器或停止正在进行的请求。</p>
              <button className="button ghost" type="button" onClick={onClose}>完成</button>
            </footer>
          </section>

          <section id="settings-panel-data" data-testid="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data" hidden={section !== 'data'}>
            <header className="settings-section-header">
              <h3>本地数据</h3>
              <p>查看数据保存位置与密钥状态。</p>
            </header>
            <dl className="settings-data-list">
              <dt>本地预览目录</dt><dd><code data-testid="settings-data-root">{dataRootLabel}</code><p className="field-help">保存聊天、计划与确认记录。</p></dd>
              <dt>项目记录</dt><dd>应用只读展示，不会更改原任务。</dd>
              <dt>API 密钥</dt><dd>{credentialLabels[settings.credentialStorage]}<p className="field-help">已保存密钥不会显示在界面中。</p></dd>
              <dt>聊天记录</dt><dd>聊天正文未加密，请保护本机数据。</dd>
            </dl>
            <footer className="settings-footer">
              <p className="field-help">这里仅展示信息，不移动或删除本地记录。</p>
              <button className="button ghost" type="button" onClick={onClose}>完成</button>
            </footer>
          </section>
        </div>
      </div>
    </Modal>
  );
}

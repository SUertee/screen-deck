import React, { useEffect, useRef, useState } from 'react';
import { Database, KeyRound, Plug, SlidersHorizontal } from 'lucide-react';
import type { DesktopAPI, ProviderSettings, SettingsInput } from '../shared/desktop-api';
import { Modal, Notice } from './components';
import { OpenCodeSettings } from './OpenCodeSettings';
import './provider-settings.css';

export type SettingsSection = 'models' | 'tools' | 'data';
const sections = [
  { id: 'models', label: '模型服务', Icon: SlidersHorizontal },
  { id: 'tools', label: 'Agent 设置', Icon: Plug },
  { id: 'data', label: '本地数据', Icon: Database },
] as const;
const credentialLabels: Record<ProviderSettings['credentialStorage'], string> = {
  file: '已保存到本机文件', memory: '仅保留到应用退出', none: '尚未配置',
};
type ModelDiscovery = { kind: 'idle' } | { kind: 'available'; baseURL: string; modelIDs: string[] }
  | { kind: 'manual'; baseURL: string; reason: 'unsupported' | 'empty' | 'custom' };
type ProviderOperation = 'checking' | 'saving';
const normalizedURL = (value: string) => { try { return new URL(value.trim()).href.replace(/\/+$/, ''); } catch { return value.trim(); } };

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
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<ProviderOperation | null>(null);
  const busy = operation !== null;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [invalidField, setInvalidField] = useState<'url' | 'model' | 'key' | undefined>();
  const [discovery, setDiscovery] = useState<ModelDiscovery>({ kind: 'idle' });
  const [cachedModels, setCachedModels] = useState<{ baseURL: string; modelIDs: string[] }>({ baseURL: '', modelIDs: [] });
  const operationPending = useRef<{ token: number; phase: ProviderOperation } | null>(null);
  const operationSerial = useRef(0);
  const cacheSerial = useRef(0);
  const openRef = useRef(open); openRef.current = open;
  const mounted = useRef(true);
  const wasOpen = useRef(false);
  const tabButtons = useRef<Partial<Record<SettingsSection, HTMLButtonElement>>>({});
  const connectionChanged = normalizedURL(baseURL) !== normalizedURL(settings.baseURL) || !!apiKey.trim();
  const cachedIDs = !connectionChanged && settings.hasKey && normalizedURL(cachedModels.baseURL) === normalizedURL(baseURL) ? cachedModels.modelIDs : [];
  const modelIDs = discovery.kind === 'available' ? discovery.modelIDs : discovery.kind === 'manual' ? [] : cachedIDs;
  const savedUnlistedModel = discovery.kind === 'idle' && !connectionChanged && settings.hasKey && modelID === settings.modelID && !!modelID && !modelIDs.includes(modelID);
  const manual = discovery.kind === 'manual';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operationSerial.current++; cacheSerial.current++; }; }, []);
  useEffect(() => {
    if (dirty) return;
    setBaseURL(settings.baseURL); setModelID(settings.modelID);
  }, [settings, dirty]);
  useEffect(() => {
    let frame: number | undefined;
    if (open && !wasOpen.current) {
      if (initialSection) { setSection(initialSection); frame = requestAnimationFrame(() => tabButtons.current[initialSection]?.focus()); }
      setOperation(operationPending.current?.phase ?? null);
      const serial = ++cacheSerial.current, operationAtRead = operationSerial.current;
      void runtimeAPI.getProviderModels().then(value => {
        if (mounted.current && openRef.current && serial === cacheSerial.current && operationAtRead === operationSerial.current) setCachedModels(value);
      }).catch(() => {
        if (mounted.current && openRef.current && serial === cacheSerial.current && operationAtRead === operationSerial.current) setError('无法读取已保存的模型列表，可重新校验连接。');
      });
    }
    if (!open) {
      operationSerial.current++; cacheSerial.current++;
      setAPIKey(''); setDiscovery({ kind: 'idle' }); setMessage(''); setError(''); setInvalidField(undefined);
      setDirty(baseURL !== settings.baseURL || modelID !== settings.modelID);
    }
    wasOpen.current = open;
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [open, initialSection, runtimeAPI]);

  const close = () => { openRef.current = false; operationSerial.current++; cacheSerial.current++; onClose(); };
  const selectSection = (next: SettingsSection, focus = false) => { setSection(next); if (focus) tabButtons.current[next]?.focus(); };
  const navigateTabs = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % sections.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = sections.length - 1;
    else return;
    event.preventDefault(); selectSection(sections[next].id, true);
  };
  const edit = (connection = false) => {
    setDirty(true); setMessage(''); setError(''); setInvalidField(undefined);
    if (connection) { operationSerial.current++; cacheSerial.current++; setDiscovery({ kind: 'idle' }); }
  };
  const current = (token: number) => mounted.current && openRef.current && operationSerial.current === token;
  const begin = (phase: ProviderOperation): number | undefined => {
    if (operationPending.current || !openRef.current) return undefined;
    const token = ++operationSerial.current; operationPending.current = { token, phase }; setOperation(phase); setError(''); setMessage(''); setInvalidField(undefined); return token;
  };
  const finish = (token: number) => {
    if (operationPending.current?.token !== token) return;
    operationPending.current = null;
    if (mounted.current && openRef.current) setOperation(null);
  };
  const showFailure = (value: unknown, token: number) => { if (current(token)) setError(value instanceof Error ? value.message : '操作失败，当前输入已保留。'); };
  const applySaved = async (token: number, saved: ProviderSettings, unverified = false) => {
    if (!current(token)) return;
    setBaseURL(saved.baseURL); setModelID(saved.modelID); setAPIKey(''); setDirty(false); setDiscovery({ kind: 'idle' });
    setCachedModels({ baseURL: saved.baseURL, modelIDs: [] });
    const success = unverified ? '连接已保存，模型未验证。' : '连接已保存。';
    setMessage(success);
    try {
      const catalog = await runtimeAPI.getProviderModels();
      if (!current(token)) return;
      if (normalizedURL(catalog.baseURL) === normalizedURL(saved.baseURL) && catalog.modelIDs.length > 0) setCachedModels(catalog);
      else if (!unverified) setMessage('连接已保存，但模型列表暂不可用，请重新校验连接。');
    } catch {
      if (current(token)) setMessage(success + '模型列表暂不可用，请重新校验连接。');
    }
  };
  const persist = async (token: number, address: string, key: string, selectedModel: string, unverified = false) => {
    if (!current(token)) return;
    if (!selectedModel.trim()) { setInvalidField('model'); setError('请选择或填写要使用的模型。'); return; }
    operationPending.current = { token, phase: 'saving' }; setOperation('saving');
    const saved = await onSave({ baseURL: address, modelID: selectedModel.trim(), apiKey: key || undefined, rememberKey: true });
    await applySaved(token, saved, unverified);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (operationPending.current) return;
    let address: string;
    try {
      const url = new URL(baseURL.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
      address = url.href.replace(/\/+$/, '');
    } catch { setInvalidField('url'); setError('请填写不含凭据或查询参数的 HTTPS API 地址。'); return; }
    const key = apiKey.trim();
    if (!key && (!settings.hasKey || address !== normalizedURL(settings.baseURL))) { setInvalidField('key'); setError('请填写该服务的 API 密钥。'); return; }
    const token = begin(discovery.kind === 'idle' ? 'checking' : 'saving');
    if (token === undefined) return;
    try {
      if (discovery.kind === 'manual') { await persist(token, address, key, modelID, true); return; }
      if (discovery.kind === 'available') {
        if (!discovery.modelIDs.includes(modelID)) { setInvalidField('model'); setError('请选择返回的模型，或切换为手工填写。'); return; }
        await persist(token, address, key, modelID); return;
      }
      const result = await runtimeAPI.listProviderModels({ baseURL: address, apiKey: key || undefined });
      if (!current(token)) return;
      if (result.kind === 'unsupported' || result.modelIDs.length === 0) {
        setDiscovery({ kind: 'manual', baseURL: address, reason: result.kind === 'unsupported' ? 'unsupported' : 'empty' });
        setMessage(result.kind === 'unsupported' ? '服务不支持模型列表。请手工填写模型，保存时不会标为已验证。' : '模型列表为空。可手工填写模型，保存为未验证连接。'); return;
      }
      setDiscovery({ kind: 'available', baseURL: address, modelIDs: result.modelIDs });
      if (result.modelIDs.includes(modelID.trim())) await persist(token, address, key, modelID);
      else { setModelID(''); setDirty(true); setMessage(`已读取 ${result.modelIDs.length} 个模型，请选择后保存。`); }
    } catch (value) { showFailure(value, token); }
    finally { finish(token); }
  };
  const chooseModel = async (selected: string) => {
    if (!selected || !modelIDs.includes(selected)) return;
    const token = begin('saving'); if (token === undefined) return;
    setModelID(selected); setDirty(true);
    try {
      if (discovery.kind === 'available') await persist(token, discovery.baseURL, apiKey.trim(), selected);
      else { const saved = await runtimeAPI.selectProviderModel({ modelID: selected }); await applySaved(token, saved); }
    } catch (value) { showFailure(value, token); }
    finally { finish(token); }
  };
  const useManualModel = () => {
    if (busy) return;
    setDiscovery({ kind: 'manual', baseURL: normalizedURL(baseURL), reason: 'custom' }); edit();
    setMessage('手工填写的模型未通过列表核对，保存时不会标为已验证。');
  };


  if (!open) return null;
  return (
    <Modal title="设置" onClose={close} className="settings-modal">
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
            </header>
            <form className="settings-form provider-connection" onSubmit={event => void save(event)} aria-busy={busy} data-state={busy ? 'loading' : error ? 'error' : manual ? 'manual' : message ? 'success' : dirty ? 'dirty' : 'default'}>
              <fieldset className="plain-fieldset" disabled={busy}>
                <div className="field">
                  <label htmlFor="provider-url">API 地址</label>
                  <input id="provider-url" type="url" autoComplete="off" spellCheck={false} value={baseURL} aria-invalid={invalidField === 'url' || undefined} onChange={event => { setBaseURL(event.target.value); edit(true); }} required />
                </div>
                <div className="field credential-field">
                  <div className="provider-field-heading"><label htmlFor="provider-key"><KeyRound size={14} aria-hidden="true" /> API 密钥</label>{settings.hasKey && <span className="provider-key-status" data-testid="provider-key-status">{settings.credentialStorage === 'file' ? '已保存' : '已配置'}</span>}</div>
                  <input id="provider-key" type="password" autoComplete="new-password" aria-invalid={invalidField === 'key' || undefined} placeholder={settings.hasKey ? '•••••• · 输入新密钥替换' : '填写服务的 API 密钥'} value={apiKey} onChange={event => { setAPIKey(event.target.value); edit(true); }} />
                </div>
                <div className="field provider-model-field">
                  <div className="provider-field-heading"><label htmlFor="provider-model">模型</label>{modelIDs.length > 0 && <button className="text-button" type="button" onClick={useManualModel}>手工填写</button>}</div>
                  {modelIDs.length > 0 ? <select id="provider-model" aria-invalid={invalidField === 'model' || undefined} value={modelIDs.includes(modelID) || savedUnlistedModel ? modelID : ''} onChange={event => void chooseModel(event.target.value)}>
                    <option value="" disabled>请选择模型</option>{savedUnlistedModel && <option value={modelID}>{modelID}（当前，未列出）</option>}{modelIDs.map(id => <option key={id} value={id}>{id}</option>)}
                  </select> : <input id="provider-model" autoComplete="off" spellCheck={false} value={modelID} aria-invalid={invalidField === 'model' || undefined} placeholder={manual ? '填写模型名称（未验证）' : '校验后获取可选模型'} onChange={event => { setModelID(event.target.value); edit(); }} />}
                </div>
              </fieldset>
              <div className="settings-feedback provider-feedback" aria-live="polite">
                {error && <Notice>{error}</Notice>}
                {message && (message === '连接已保存。' ? <span className="visually-hidden" role="status">{message}</span> : <div className={`provider-result${manual ? ' is-unverified' : ''}`} role="status">{message}</div>)}
              </div>
              <footer className="settings-footer">
                <div className="settings-actions">
                  <button className="button ghost" type="button" onClick={close}>取消</button>
                  <button className="button primary" data-testid="settings-save-model" disabled={busy} type="submit">{operation === 'checking' ? '正在校验…' : busy ? '正在保存…' : manual ? '保存（未验证）' : discovery.kind === 'available' ? '保存连接' : '校验并保存'}</button>
                </div>
              </footer>
            </form>
          </section>

          <section id="settings-panel-tools" data-testid="settings-panel-tools" role="tabpanel" aria-labelledby="settings-tab-tools" hidden={section !== 'tools'}>
            <header className="settings-section-header">
              <h3>Agent 设置</h3>
              <p>连接本机 Agent，在聊天中使用。</p>
            </header>
            <OpenCodeSettings api={runtimeAPI} settingsDirty={dirty || busy} onEditModel={() => selectSection('models', true)} />
            <footer className="settings-footer">
              <p className="field-help">关闭设置不会关闭执行器或停止正在进行的请求。</p>
              <button className="button ghost" type="button" onClick={close}>完成</button>
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
              <button className="button ghost" type="button" onClick={close}>完成</button>
            </footer>
          </section>
        </div>
      </div>
    </Modal>
  );
}

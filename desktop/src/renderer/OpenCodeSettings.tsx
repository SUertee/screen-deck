import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import type { DesktopAPI, OpenCodeBinaryCandidate, OpenCodeInstallation, OpenCodeStatus } from '../shared/desktop-api';
import { Notice } from './components';

const SUPPORTED_VERSION = '1.19.0';
type RuntimeOperation = 'start' | 'stop' | 'refresh' | 'choose' | 'guide';
interface OpenCodeSettingsProps {
  api: Pick<DesktopAPI, 'getOpenCodeStatus' | 'getOpenCodeInstallation' | 'chooseOpenCodeBinary' | 'openOpenCodeInstallGuide' | 'startOpenCode' | 'stopOpenCode'>;
  settingsDirty: boolean;
  onEditModel?: () => void;
}
const sourceLabels: Record<OpenCodeBinaryCandidate['source'], string> = { remembered: '上次连接', manual: '手动指定', path: '环境路径', standard: '常见安装位置' };
const shortPath = (filename: string) => { const parts = filename.split('/'); return parts.length > 4 ? '…/' + parts.slice(-3).join('/') : filename; };
const errorText = (value: unknown) => {
  const message = value instanceof Error ? value.message : value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : '操作未完成，请刷新状态后重试。';
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
};

export function OpenCodeSettings({ api, settingsDirty, onEditModel }: OpenCodeSettingsProps) {
  const [status, setStatus] = useState<OpenCodeStatus | null>(null);
  const [installation, setInstallation] = useState<OpenCodeInstallation>({ candidates: [] });
  const [selectedID, setSelectedID] = useState('');
  const [runtimeConfirmed, setRuntimeConfirmed] = useState(false);
  const [installationConfirmed, setInstallationConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<RuntimeOperation | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const pending = useRef(false);
  const readEpoch = useRef(0);

  const applyInstallation = (value: OpenCodeInstallation, explicitID?: string) => {
    setInstallation(value);
    setSelectedID(current => {
      const contains = (id: string | undefined) => !!id && value.candidates.some(candidate => candidate.id === id);
      if (contains(explicitID)) return explicitID!;
      if (contains(current)) return current;
      if (contains(value.preferredID)) return value.preferredID!;
      return value.candidates.length === 1 ? value.candidates[0].id : '';
    });
  };
  const read = async (epoch: number, explicitID?: string) => {
    const [runtime, found] = await Promise.allSettled([api.getOpenCodeStatus(), api.getOpenCodeInstallation()]);
    if (!mounted.current || epoch !== readEpoch.current) return;
    if (runtime.status === 'fulfilled') { setStatus(runtime.value); setRuntimeConfirmed(true); }
    else setRuntimeConfirmed(false);
    if (found.status === 'fulfilled') { applyInstallation(found.value, explicitID); setInstallationConfirmed(true); }
    else setInstallationConfirmed(false);
    const messages = [runtime.status === 'rejected' ? '无法读取执行器状态，请刷新重试。' : '', found.status === 'rejected' ? '无法读取程序位置，请刷新重试。已连接的执行器仍可关闭。' : ''];
    setError(messages.filter(Boolean).join(' '));
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readEpoch.current++; };
  }, []);
  useEffect(() => {
    if (pending.current) return;
    const epoch = ++readEpoch.current;
    setLoading(true);
    void read(epoch).catch(() => {
      if (!mounted.current || epoch !== readEpoch.current) return;
      setRuntimeConfirmed(false); setInstallationConfirmed(false); setError('无法读取程序位置或执行器状态，请刷新状态后重试。');
    }).finally(() => { if (mounted.current && epoch === readEpoch.current) setLoading(false); });
  }, [api, settingsDirty]);

  const change = async (nextOperation: RuntimeOperation, perform: (epoch: number) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    const epoch = ++readEpoch.current;
    setLoading(false); setOperation(nextOperation); setError('');
    try { await perform(epoch); }
    catch (value) {
      if (mounted.current && epoch === readEpoch.current) {
        if (nextOperation === 'start' || nextOperation === 'stop') setRuntimeConfirmed(false);
        if (nextOperation === 'refresh') { setRuntimeConfirmed(false); setInstallationConfirmed(false); }
        setError(errorText(value));
      }
    } finally { pending.current = false; if (mounted.current && epoch === readEpoch.current) setOperation(null); }
  };
  const connect = () => {
    if (!selectedID || settingsDirty || !runtimeConfirmed || !installationConfirmed) return;
    const candidateID = selectedID;
    void change('start', async epoch => {
      const value = await api.startOpenCode({ candidateID });
      if (!mounted.current || epoch !== readEpoch.current) return;
      setStatus(value); setRuntimeConfirmed(true);
      try {
        const found = await api.getOpenCodeInstallation();
        if (mounted.current && epoch === readEpoch.current) { applyInstallation(found, candidateID); setInstallationConfirmed(true); }
      } catch {
        if (mounted.current && epoch === readEpoch.current) { setInstallationConfirmed(false); setError('已连接，但程序位置无法读取。请刷新重试；关闭执行器仍可操作。'); }
      }
    });
  };
  const choose = () => void change('choose', async epoch => {
    const candidate = await api.chooseOpenCodeBinary();
    if (!candidate || !mounted.current || epoch !== readEpoch.current) return;
    await read(epoch, candidate.id);
  });
  const close = () => void change('stop', async epoch => {
    const value = await api.stopOpenCode();
    if (!mounted.current || epoch !== readEpoch.current) return;
    setStatus(value); setRuntimeConfirmed(true);
  });

  const busy = operation !== null || loading;
  const ready = status?.state === 'ready';
  const selected = installation.candidates.find(candidate => candidate.id === selectedID);
  const state = busy ? 'loading' : !runtimeConfirmed ? 'error' : ready ? status.requiresRestart ? 'requires-restart' : 'ready' : error ? 'error' : 'stopped';
  const statusText = operation === 'start' ? '正在连接…' : operation === 'stop' ? '正在关闭…'
    : busy ? operation === 'choose' ? '正在选择程序…' : operation === 'guide' ? '正在打开安装说明…' : '读取状态…'
    : !runtimeConfirmed ? '状态未确认，请刷新重试。'
    : ready ? `已连接 ${status.version} · ${status.model.model_id} · ACP · 无工具`
    : '未启动';

  return (
    <section aria-label="OpenCode 执行器" data-testid="opencode-runtime-card" data-state={state} aria-busy={busy}>
      <div className="settings-tool-row">
        <div className="settings-tool-info">
          <div className="settings-tool-heading"><Terminal size={20} aria-hidden="true" /><strong>OpenCode</strong></div>
          <p className="field-help" role="status" data-testid="opencode-runtime-status">{statusText}</p>
        </div>
        <div className="settings-tool-actions">
          {ready ? <button className="button ghost opencode-connect" data-testid="opencode-runtime-stop" type="button" disabled={busy} onClick={close}>{operation === 'stop' ? '正在关闭…' : '关闭执行器'}</button>
            : <button className="button opencode-connect" data-testid="opencode-runtime-start" type="button" disabled={busy || settingsDirty || !runtimeConfirmed || !installationConfirmed || !status || !selected} onClick={connect}>{operation === 'start' ? '正在连接…' : '连接 OpenCode'}</button>}
          <button className="button ghost" data-testid="opencode-runtime-refresh" type="button" disabled={busy} onClick={() => void change('refresh', epoch => read(epoch))}>{operation === 'refresh' ? '正在刷新…' : '刷新状态'}</button>
        </div>
      </div>

      <div className="opencode-discovery" data-testid="opencode-installation" data-state={busy ? 'loading' : !installationConfirmed ? 'error' : ready ? 'ready' : installation.candidates.length ? 'found' : 'missing'}>
        <p className="field-help opencode-installation-status" role="status" data-testid="opencode-installation-status">{busy ? '正在检测程序位置…' : !installationConfirmed ? '程序位置未确认，请刷新重试。' : ready ? '程序位置已确认' : installation.candidates.length ? '已找到，尚未连接' : '未检测到 OpenCode'}</p>
        {installation.candidates.length > 1 ? <label className="opencode-installation-label">程序位置<select className="opencode-candidate-select" aria-label="OpenCode 安装位置" value={selectedID} disabled={busy || ready} onChange={event => setSelectedID(event.target.value)}>
          <option value="" disabled>请选择安装位置</option>
          {installation.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{sourceLabels[candidate.source]} · {shortPath(candidate.path)}</option>)}
        </select></label> : selected ? <div className="opencode-installation-location"><span className="field-help">{sourceLabels[selected.source]}</span><span className="opencode-installation-path" data-testid="opencode-installation-path" title={selected.path}>{selected.path}</span></div> : null}
        {installation.candidates.length > 1 && selected && <span className="opencode-installation-path" data-testid="opencode-installation-path" title={selected.path}>{selected.path}</span>}
        {!loading && installationConfirmed && !ready && !installation.candidates.length && <p className="field-help">请先安装 OpenCode {SUPPORTED_VERSION}。已安装时可手动指定程序。</p>}
        <div className="opencode-discovery-actions">
          <button className="button ghost" data-testid="opencode-binary-choose" type="button" disabled={busy || ready} onClick={choose}>{operation === 'choose' ? '正在选择…' : '手动选择程序'}</button>
          {!ready && !installation.candidates.length && <button className="button ghost" data-testid="opencode-install-guide" type="button" disabled={busy} onClick={() => void change('guide', async () => { await api.openOpenCodeInstallGuide(); })}>安装说明</button>}
        </div>
      </div>

      <dl className="settings-tool-details">
        <dt>{ready ? '连接版本' : '支持版本'}</dt><dd title={ready ? undefined : '连接时核验此版本；发现程序位置不表示版本已通过核验。'}>{ready ? status.version : SUPPORTED_VERSION}</dd>
        <dt>接入协议</dt><dd>ACP v1</dd>
        <dt>模型来源</dt><dd>连接时使用已保存的模型服务配置。</dd>
        <dt>{ready ? '已绑定模型' : '实际模型'}</dt><dd>{ready ? `${status.model.provider_id}/${status.model.model_id}` : '连接后显示本次使用的模型。'}</dd>
        <dt>开放能力</dt><dd title="不读取关联项目文件，不附加材料，不执行文件或命令工具。">无工具文本</dd>
      </dl>
      {ready && status.requiresRestart && <p className="field-help" role="status">模型连接已更新；关闭并重新连接后可发送新消息。已提交的尝试仍绑定原连接。</p>}
      {settingsDirty && <div className="settings-tool-model-warning"><p className="field-help">模型服务有未保存修改，请先保存后再连接。关闭执行器和刷新状态仍可操作。</p>{onEditModel && <button className="button ghost" data-testid="settings-edit-model" type="button" onClick={onEditModel}>回到模型服务</button>}</div>}
      {error && <div className="settings-feedback"><Notice>{error}</Notice></div>}
    </section>
  );
}

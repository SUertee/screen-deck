import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Terminal } from 'lucide-react';
import type { DesktopAPI, OpenCodeBinaryCandidate, OpenCodeInstallation, OpenCodeStatus } from '../shared/desktop-api';
import { Notice } from './components';
import { AgentSettingsCard } from './AgentSettingsCard';

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
  const statusText = operation === 'start' ? '连接中' : operation === 'stop' ? '断开中' : busy ? '读取中' : !runtimeConfirmed ? '待确认' : ready ? status.requiresRestart ? '需重连' : '已连接' : '未连接';
  const missing = installationConfirmed && !installation.candidates.length && !ready;
  const discovery = <div className="agent-program-location" data-testid="opencode-installation" data-state={busy ? 'loading' : !installationConfirmed ? 'error' : ready ? 'ready' : installation.candidates.length ? 'found' : 'missing'}>
    <span className="agent-settings-secondary" role="status" data-testid="opencode-installation-status">{busy ? '正在检测程序位置…' : !installationConfirmed ? '程序位置未确认，请刷新重试。' : ready ? '程序位置已确认' : installation.candidates.length ? '已找到，尚未连接' : '未检测到 OpenCode'}</span>
    {installation.candidates.length > 1 ? <label className="agent-program-picker">程序位置<select aria-label="OpenCode 安装位置" value={selectedID} disabled={busy || ready} onChange={event => setSelectedID(event.target.value)}>
      <option value="" disabled>请选择安装位置</option>{installation.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{sourceLabels[candidate.source]} · {shortPath(candidate.path)}</option>)}
    </select></label> : null}
    {selected && <code className="agent-program-path" data-testid="opencode-installation-path" title={selected.path}>{selected.path}</code>}
    <div className="agent-program-actions"><button className="button ghost" data-testid="opencode-binary-choose" type="button" disabled={busy || ready} onClick={choose}>{operation === 'choose' ? '正在选择…' : '手动选择程序'}</button>
      {missing && <button className="button ghost" data-testid="opencode-install-guide" type="button" disabled={busy} onClick={() => void change('guide', async () => { await api.openOpenCodeInstallGuide(); })}>安装说明</button>}</div>
  </div>;
  return <AgentSettingsCard name="OpenCode" icon={<Terminal size={19} />} state={state} status={statusText} statusTestID="opencode-runtime-status" subtitle={ready ? status.model.model_id : '使用模型服务中的配置'} busy={busy} testID="opencode-runtime-card" actions={<>
    <button className="icon-button agent-settings-refresh" data-testid="opencode-runtime-refresh" title="刷新 OpenCode 状态" aria-label="刷新 OpenCode 状态" type="button" disabled={busy} onClick={() => void change('refresh', epoch => read(epoch))}><RefreshCw size={14} /></button>
    {ready ? <button className="button ghost" data-testid="opencode-runtime-stop" type="button" disabled={busy} onClick={close}>{operation === 'stop' ? '断开中…' : '断开连接'}</button> : <button className="button primary" data-testid="opencode-runtime-start" type="button" disabled={busy || settingsDirty || !runtimeConfirmed || !installationConfirmed || !status || !selected} title={missing ? '请先安装或选择 OpenCode 程序' : undefined} onClick={connect}>{operation === 'start' ? '连接中…' : '连接 OpenCode'}</button>}
  </>} details={<>
    {!missing && discovery}
    <dl className="agent-settings-facts"><dt>{ready ? '连接版本' : '支持版本'}</dt><dd>{ready ? status.version : SUPPORTED_VERSION}</dd><dt>接入协议</dt><dd>ACP v1</dd><dt>模型来源</dt><dd>模型服务配置</dd>{ready && <><dt>已绑定模型</dt><dd>{status.model.provider_id}/{status.model.model_id}</dd></>}<dt>工具能力</dt><dd>原生文件、命令和审批；工作项为受限文本。</dd><dt>执行限制</dt><dd>OpenCode 原生权限，没有 OS 沙箱。工作目录不等于文件隔离。</dd></dl>
  </>}>
    {missing && discovery}
    {ready && status.requiresRestart && <p className="agent-settings-inline-note" role="status">模型配置已更新，请断开后重新连接。</p>}
    {settingsDirty && <div className="agent-settings-inline-note"><span>模型服务有未保存修改。</span>{onEditModel && <button className="button ghost" data-testid="settings-edit-model" type="button" onClick={onEditModel}>回到模型服务</button>}</div>}
    {error && <div className="settings-feedback"><Notice>{error}</Notice></div>}
  </AgentSettingsCard>;
}

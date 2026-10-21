import { randomUUID } from 'node:crypto';
import { JevService, type JevCandidate, type JevPreview, type JevServiceAdvice } from './jev-service.js';
import { JevSettingsStore } from './jev-settings.js';
import { JevServiceError } from '../core/tasks/providers/jev-http-transport.js';
import { StorageError } from '../core/storage/private-storage.js';
import type { TaskOrchestrator } from '../core/tasks/task-orchestrator.js';
import type { PreviewPlan } from '../shared/types.js';
import type { LocalState } from './local-state.js';
import type { ElectronHost } from './electron-host.js';
import type { AgentChatRegistry } from '../core/agents/agent-chat-registry.js';
import type { ProviderSettingsStore } from './provider-settings.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';
type Ticket = { service: JevService; preview: JevPreview; materialIDs: string[]; model: string; expires: number; status: 'ready' | 'sending' | 'settled'; advice?: JevServiceAdvice; failure?: string; applied?: PreviewPlan; appliedCandidate?: string };
/** Fixed IPC, main-owned candidates and advice. Nothing runs when settings or tasks are opened. */
export function installTaskAdviceRoutes({ host, plans, local, drivers, provider, serviceFactory }: { host: Pick<ElectronHost,'handle'|'broadcast'>; plans: TaskOrchestrator; local: LocalState; drivers: AgentChatRegistry; provider: ProviderSettingsStore; serviceFactory?: (credentials: JevSettingsStore, model: string) => JevService }) {
  const credentials = new JevSettingsStore(local), tickets = new Map<string, Ticket>();
  const configKey = 'typesafe-jev-model-v1';
  const model = async () => {
    const value = await local.read<{ model: string }>(configKey, { model: 'jev-latest' });
    if (!value || typeof value.model !== 'string' || value.model && !/^jev-[a-zA-Z0-9.-]{1,96}$/.test(value.model)) throw new StorageError('jev-settings', 'Jev 模型配置不可读取。');
    return value.model || 'jev-latest';
  };
  const candidates = (plan: PreviewPlan, id: string): JevCandidate[] => {
    const item = plan.work_items.find(w => w.id === id); if (!item) throw new StorageError('missing-work-item', '工作项已不存在。');
    const choices: JevCandidate[] = [{ id: 'human', label: '由我处理', description: '需要人工判断、补充信息或直接处理。', assignee: 'human' }];
    if (item.kind === 'discussion' && provider.publicSettings().hasKey) choices.push({ id: 'chat', label: '直接模型讨论', description: '纯文本讨论，不提供本地文件或命令工具。', assignee: 'chat' });
    for (const source of drivers.listSources()) if (source.state === 'ready' && source.capabilities.tools) choices.push({ id: 'agent_' + source.agentID.replaceAll('-', '_'), label: source.name, description: `使用 ${source.name} 当前实际模型 ${source.model.model_id} 处理工作项；开始执行与工具权限仍需独立确认。`, assignee: 'agent', agentID: source.agentID });
    if (choices.length < 2) throw new StorageError('jev-candidates', '请先连接一个 Agent，或为讨论项配置模型，再比较分工建议。');
    return choices;
  };
  const load = async (id: string) => { const plan = await plans.loadPlan(id); if (!plan || plan.scope) throw new StorageError('missing-plan', '请选择可编辑的本地任务。'); return plan; };
  const ticket = (id: unknown) => { const current = tickets.get(uuidInput(id)); if (!current || current.expires < Date.now()) throw new StorageError('jev-expired', '建议已过期，请重新预览。'); return current; };
  const stableError = (error: unknown) => error instanceof JevServiceError ? `Jev：${error.code}${error.delivery === 'unknown' ? '，请求可能已送达，请勿直接重复提交。' : ''}` : error instanceof StorageError ? error.message : 'Jev 请求未完成，请检查设置。';
  const handle = (channel: string, run: (input: unknown) => Promise<unknown>) => host.handle(channel, async input => { try { return await run(input); } catch (error) { throw new StorageError('jev-operation', stableError(error)); } });
  handle('jev-settings', async () => ({ ...await credentials.publicSettings(), model: await model() }));
  handle('jev-save-settings', async input => {
    const value = payload(input, ['model','apiKey']); const selected = textInput(value.model, 100).trim();
    if (!/^jev-[a-zA-Z0-9.-]{1,96}$/.test(selected)) throw new StorageError('jev-model', '请填写可用的 Jev 模型版本。');
    tickets.clear(); // A failed settings write also invalidates previews tied to the old account/model.
    if (value.apiKey !== undefined) await credentials.save(textInput(value.apiKey, 4096).trim());
    await model(); await local.write(configKey, { model: selected });
    return { ...await credentials.publicSettings(), model: selected };
  });
  handle('jev-preview', async input => {
    const value = payload(input, ['planID','workItemID','materialIDs']);
    const plan = await load(uuidInput(value.planID)), selected = await model();
    if (!selected) throw new StorageError('jev-model', '请先设置 Jev 模型版本。');
    const service = serviceFactory?.(credentials, selected) ?? new JevService(credentials, { model: selected, minimumConfidence: .8 });
    const preview = service.preview(plan, uuidInput(value.workItemID), candidates(plan, String(value.workItemID)), { materialIDs: value.materialIDs as string[] });
    for (const [id,t] of tickets) if (t.expires < Date.now()) tickets.delete(id);
    if (tickets.size >= 100) throw new StorageError('jev-limit', '待处理建议过多，请完成或重启应用后再试。');
    const id = randomUUID(); tickets.set(id, { service, preview, materialIDs: value.materialIDs as string[], model: selected, expires: Date.now()+15*60_000, status:'ready' });
    return { id, preview };
  });
  handle('jev-recommend', async input => {
    const value = payload(input, ['id','budgetConfirmed']); const t = ticket(value.id);
    if (t.advice) return { id: value.id, advice: t.advice };
    if (value.budgetConfirmed !== true || t.status !== 'ready') throw new StorageError('jev-request', t.failure ?? '请确认本次外发内容与费用；请求不可重复开始。');
    const plan = await load(t.preview.base.planID);
    if (await model() !== t.model || t.service.preview(plan,t.preview.base.workItemID,candidates(plan,t.preview.base.workItemID),{ materialIDs:t.materialIDs }).base.requestDigest !== t.preview.base.requestDigest || plan.version !== t.preview.base.baseVersion) throw new StorageError('jev-stale', '任务、模型或候选已变化，请重新预览。');
    t.status = 'sending';
    try {
      const result = await t.service.recommend(plan,t.preview.base.workItemID,t.preview.candidates,{materialIDs:t.materialIDs,budgetConfirmed:true});
      if (result.kind === 'not-configured') throw new StorageError('jev-key', '请先配置 Jev 专用密钥。');
      if (tickets.get(String(value.id)) !== t || await model() !== t.model) throw new StorageError('jev-settings-changed', 'Jev 配置已变化，迟到建议未采用。');
      t.advice = result; return { id: value.id, advice: result };
    } catch (error) { t.failure = stableError(error); throw error; } finally { t.status = 'settled'; }
  });
  handle('jev-apply', async input => {
    const value = payload(input,['id','candidateID']); const t = ticket(value.id);
    if (t.applied) { if (value.candidateID !== t.appliedCandidate) throw new StorageError('jev-already-applied', '本建议已保存不同分工，请编辑任务或重新获取建议。'); return t.applied; }
    if (!t.advice) throw new StorageError('jev-advice', '尚无可确认的 Jev 建议。');
    const candidate = t.preview.candidates.find(c => c.id === value.candidateID);
    if (!candidate) throw new StorageError('jev-candidate', '请选择预览中的分工。');
    const result = await plans.transactPlan(t.preview.base.planID, async current => {
      t.service.assertCurrent(t.advice!,current,candidates(current,t.preview.base.workItemID),{materialIDs:t.materialIDs});
      const agentSource = candidate.agentID ? drivers.listSources().find(source => source.agentID === candidate.agentID) : undefined;
      if (candidate.agentID && agentSource?.state !== 'ready') throw new StorageError('jev-candidate', '原 Agent 连接已变化，请重新预览。');
      const work_items = current.work_items.map(item => {
        if (item.id !== t.preview.base.workItemID) return item;
        const { model: _model, agentID: _agent, ...rest } = item;
        return { ...rest, assignee: candidate.assignee, ...(candidate.agentID ? { agentID:candidate.agentID, model:agentSource?.state === 'ready' ? agentSource.model : undefined } : {}), ...(candidate.assignee === 'chat' ? { model:{provider_id:'chat-completions',model_id:provider.publicSettings().modelID} } : {}) };
      });
      return { plan:{...current,schema_version:current.schema_version === 1 ? 2 as const : current.schema_version,work_items},value:true };
    });
    t.appliedCandidate = String(value.candidateID); t.applied = result.plan!; host.broadcast({type:'plan-updated',plan:result.plan!}); return result.plan;
  });
}

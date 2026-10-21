import { isStoredPermissionMode } from '../../shared/agent-permissions.js';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { atomicReplace, readBytes, withExclusiveLock, StorageError } from '../storage/private-storage.js';
import { ExecutionError } from '../sessions/execution-driver.js';
import { isUUID } from '../sessions/session-schema.js';
import { validateAgentBinding, validateAgentSource } from '../sessions/agent-session-schema.js';
import type { AgentChatDriver, AgentChatLookup, AgentChatRequest, AgentChatExecutionEvent } from '../sessions/agent-chat-driver.js';
import type { AgentChatSource } from '../../shared/agent-chat.js';
import type { AgentExecutionContext, AgentExecutionRecord, AgentExecutionSelection, AgentWorkspace, AgentNativeApproval } from '../../shared/agent-execution.js';
const LIMIT = 4 * 1024 * 1024;
const id = (value: string) => { if (!isUUID(value)) throw new StorageError('input-invalid', '执行记录标识无效。'); return value.toLowerCase(); };
interface ContextFile { source: AgentChatSource; context: AgentExecutionContext; dev: number; ino: number }
interface Active { request: AgentChatRequest; driver: AgentChatDriver; record: AgentExecutionRecord; queue: Promise<void>; closing: boolean }
/** Single writer for native observations and decisions. Never performs the Agent's filesystem/command tools. */
export class AgentExecutionController {
  private observed = new Map<string, Buffer | undefined>();
  private workspaces = new Map<string, { workspace: AgentWorkspace; dev: number; ino: number }>();
  private active = new Map<string, Active>();
  constructor(private root: string, private changed: (record: AgentExecutionRecord) => void) {}
  async choose(directory: string): Promise<AgentWorkspace> {
    const filename = await realpath(directory), info = await stat(filename);
    if (!info.isDirectory() || filename === path.parse(filename).root || /[\0\r\n]/.test(filename) || Buffer.byteLength(filename) > 4096) throw new StorageError('workspace-invalid', '请选择具体的工作目录。');
    const workspace = { id: randomUUID(), path: filename, label: path.basename(filename) };
    if (this.workspaces.size >= 256) this.workspaces.delete(this.workspaces.keys().next().value!);
    this.workspaces.set(workspace.id, { workspace, dev: info.dev, ino: info.ino }); return structuredClone(workspace);
  }
  async configure(sessionID: string, source: AgentChatSource, selection: AgentExecutionSelection): Promise<void> {
    if (!selection || !isStoredPermissionMode(selection.mode)) throw new StorageError('permission-invalid', '请选择支持的权限模式。');
    const chosen = this.workspaces.get(selection.workspaceID); if (!chosen) throw new StorageError('workspace-missing', '请重新选择工作目录。');
    const record: ContextFile = { source: structuredClone(source), context: { workspace: chosen.workspace, mode: selection.mode }, dev: chosen.dev, ino: chosen.ino };
    await this.verifyWorkspace(record); await this.save(this.contextFile(sessionID), record, true);
  }
  async context(sessionID: string): Promise<AgentExecutionContext | undefined> { return (await this.readContext(sessionID))?.context; }
  async read(sessionID: string, turnID: string): Promise<AgentExecutionRecord | undefined> {
    const bytes = await readBytes(this.file(sessionID, turnID), LIMIT); if (!bytes) return undefined;
    const record = this.validate(JSON.parse(bytes.toString()));
    if (!this.observed.has(this.file(sessionID, turnID))) this.observed.set(this.file(sessionID, turnID), bytes);
    if (record.sessionID !== sessionID || record.turnID !== turnID) throw new StorageError('execution-invalid', '执行记录身份不匹配。');
    if (!this.active.has(record.clientRequestID) && (record.status === 'running' || record.approvals.some(a => a.state === 'pending'))) {
      record.status = record.status === 'running' ? 'unknown' : record.status;
      this.expire(record); await this.save(this.file(sessionID, turnID), record);
    }
    return record;
  }
  wrap(driver: AgentChatDriver): AgentChatDriver {
    return { descriptor: driver.descriptor, getSource: () => driver.getSource(), sendTurn: (request, onEvent, signal) => this.send(driver, request, onEvent, signal), cancelTurn: async lookup => {
      const active = this.active.get(lookup.clientRequestID);
      if (active) {
        try { await this.closeApprovals(active); }
        catch (error) { await driver.cancelTurn(lookup).catch(() => {}); throw error; }
      }
      return driver.cancelTurn(lookup);
    } };
  }
  async decide(input: { sessionID: string; turnID: string; approvalID: string; decision: 'allow' | 'deny' }, decider: 'user' | 'policy' = 'user'): Promise<void> {
    id(input.sessionID); id(input.turnID); id(input.approvalID);
    if (!['allow', 'deny'].includes(input.decision)) throw new StorageError('decision-invalid', '审批决定无效。');
    const active = [...this.active.values()].find(a => a.record.sessionID === input.sessionID && a.record.turnID === input.turnID);
    if (!active || active.closing) throw new StorageError('approval-expired', '原审批已失效，不会向新连接投递。');
    await this.serial(active, async () => {
      const approval = active.record.approvals.find(a => a.id === input.approvalID);
      if (!approval || approval.state !== 'pending' || !active.record.binding || !active.driver.replyPermission) throw new StorageError('approval-expired', '原审批已处理或不可继续。');
      const ready = active.driver.getSource();
      if (!ready || ready.configDigest !== active.record.source.configDigest || ready.runtimeID !== active.record.binding.runtimeID || ready.connectionGeneration !== active.record.binding.connectionGeneration) throw new StorageError('approval-expired', '原 Agent 连接已失效。');
      if (input.decision === 'allow' && (!approval.canAllow || active.record.context.mode === 'read-only')) throw new StorageError('permission-denied', '当前范围不允许批准此请求。');
      // The saved human decision is not a delivery receipt or proof of tool effect.
      approval.state = 'decided'; approval.decision = input.decision; approval.decider = decider; approval.reply = 'pending';
      try { await this.persist(active); } catch (error) { approval.state = 'pending'; delete approval.decision; delete approval.decider; delete approval.reply; throw error; }
      try { const reply = await active.driver.replyPermission(this.lookup(active), approval.id, input.decision); approval.reply = reply.status; }
      catch { approval.reply = 'unknown'; }
      await this.persist(active);
    });
  }
  private async send(driver: AgentChatDriver, request: AgentChatRequest, onEvent: (event: AgentChatExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    if (!driver.descriptor.capabilities.tools) return driver.sendTurn(request, onEvent, signal);
    let configured: ContextFile;
    try {
      const stored = await this.readContext(request.sessionID);
      if (!stored) {
        if (!driver.sendTextTurn) throw new ExecutionError('configuration', '当前连接尚未开放纯聊天，请重新连接或选择工作目录。', false);
        return driver.sendTextTurn({ ...request, execution: undefined }, onEvent, signal);
      }
      if (!isDeepStrictEqual(stored.source, request.source)) throw new StorageError('workspace-missing', '请为新 Agent 聊天选择工作目录和权限。');
      await this.verifyWorkspace(stored); configured = stored;
    } catch (error) { throw new ExecutionError('configuration', error instanceof Error ? error.message : '工作区配置不可用。', false); }
    const record: AgentExecutionRecord = { schema_version: 1, sessionID: request.sessionID, turnID: request.turnID, clientRequestID: request.clientRequestID, source: request.source, context: configured.context, ...(request.binding ? { binding: request.binding } : {}), status: 'running', tools: [], approvals: [] };
    const active: Active = { request, driver, record, queue: Promise.resolve(), closing: false }; this.active.set(request.clientRequestID, active);
    try {
      try { await this.save(this.file(record.sessionID, record.turnID), record, true); }
      catch (error) { throw new ExecutionError('configuration', error instanceof Error ? error.message : '无法保存执行记录。', false); }
      await driver.sendTurn({ ...request, execution: structuredClone(configured.context) }, async event => {
        if (event.type === 'tool') return this.serial(active, async () => {
          const tool = structuredClone(event.tool); const old = record.tools.find(t => t.id === tool.id);
          if (event.appendOutput && old) tool.output = (old.output ?? '') + (tool.output ?? '');
          if (tool.detail && Buffer.byteLength(tool.detail) > 32768) tool.detail = Buffer.from(tool.detail).subarray(0, 32768).toString('utf8');
          if (tool.output && Buffer.byteLength(tool.output) > 32768) { tool.output = Buffer.from(tool.output).subarray(-32768).toString('utf8'); tool.truncated = true; }
          if (old) Object.assign(old, tool); else record.tools.push(tool);
          await this.persist(active);
        });
        if (event.type === 'permission') {
          const automatic = event.autoApprove && event.approval.canAllow && (record.context.mode === 'full-access' || record.context.mode === 'auto-edit' && record.tools.some(tool => tool.id === event.approval.toolID && tool.kind === 'write'));
          await this.serial(active, async () => {
            if (active.closing || !record.binding || record.approvals.some(a => a.id === event.approval.id)) throw new StorageError('approval-invalid', '原生审批身份无效。');
            record.approvals.push({ ...structuredClone(event.approval), state: 'pending', ...(automatic ? { decider: 'policy' as const } : {}) }); await this.persist(active);
          });
          if (automatic) await this.decide({ sessionID: record.sessionID, turnID: record.turnID, approvalID: event.approval.id, decision: 'allow' }, 'policy');
          else if (record.context.mode === 'read-only') await this.decide({ sessionID: record.sessionID, turnID: record.turnID, approvalID: event.approval.id, decision: 'deny' }, 'policy');
          return;
        }
        await onEvent(event);
        if (event.type === 'bound') { record.binding = event.binding; await this.serial(active, () => this.persist(active)); }
        if (event.type === 'settled') { record.status = event.outcome; await this.serial(active, () => this.persist(active)); }
      }, signal);
    } catch (error) { record.status = error instanceof ExecutionError && !error.attempted ? 'failed' : 'unknown'; throw error; }
    finally {
      active.closing = true;
      try {
        await this.closeApprovals(active);
        await active.queue;
        if (record.status === 'running') record.status = 'unknown';
        this.expire(record); await this.persist(active);
      } finally { this.active.delete(request.clientRequestID); }
    }
  }
  private lookup(active: Active): AgentChatLookup { return { clientRequestID: active.request.clientRequestID, source: active.request.source, binding: active.record.binding }; }
  private async closeApprovals(active: Active): Promise<void> {
    active.closing = true;
    await this.serial(active, async () => {
      for (const approval of active.record.approvals) if (approval.state === 'pending') {
        approval.state = 'expired'; await this.persist(active);
        try { await active.driver.replyPermission?.(this.lookup(active), approval.id, 'deny'); } catch { /* Never retry a native response automatically. */ }
      }
    });
  }
  private expire(record: AgentExecutionRecord): void {
    for (const approval of record.approvals) if (approval.state === 'pending') approval.state = 'expired';
    for (const tool of record.tools) if (tool.status === 'running' || tool.status === 'pending') tool.status = 'unknown';
  }
  private serial(active: Active, operation: () => Promise<void>): Promise<void> { const next = active.queue.then(operation); active.queue = next.catch(() => {}); return next; }
  private async persist(active: Active): Promise<void> { this.validate(active.record); await this.save(this.file(active.record.sessionID, active.record.turnID), active.record); this.changed(structuredClone(active.record)); }
  private async verifyWorkspace(value: ContextFile): Promise<void> { const actual = await realpath(value.context.workspace.path), info = await stat(actual); if (actual !== value.context.workspace.path || !info.isDirectory() || info.dev !== value.dev || info.ino !== value.ino) throw new StorageError('workspace-changed', '原工作目录已变化，请明确新建聊天。'); }
  private async readContext(sessionID: string): Promise<ContextFile | undefined> {
    const bytes = await readBytes(this.contextFile(sessionID), 16_384); if (!bytes) return undefined;
    const value = JSON.parse(bytes.toString()) as ContextFile; validateAgentSource(value.source);
    if (!value.context || !isStoredPermissionMode(value.context.mode) || !isUUID(value.context.workspace?.id) || !path.isAbsolute(value.context.workspace.path) || typeof value.dev !== 'number' || typeof value.ino !== 'number') throw new StorageError('workspace-invalid', '原工作区配置无效。');
    return value;
  }
  private validate(value: AgentExecutionRecord): AgentExecutionRecord {
    if (!value || Object.keys(value).some(key => !['schema_version', 'sessionID', 'turnID', 'clientRequestID', 'source', 'context', 'binding', 'status', 'tools', 'approvals'].includes(key)) || value.schema_version !== 1 || !isUUID(value.sessionID) || !isUUID(value.turnID) || !isUUID(value.clientRequestID) || !['running', 'finished', 'failed', 'cancelled', 'unknown'].includes(value.status) || !Array.isArray(value.tools) || !Array.isArray(value.approvals)) throw new StorageError('execution-invalid', '原生执行记录无效。');
    if (!value.context || !isStoredPermissionMode(value.context.mode) || !isUUID(value.context.workspace?.id) || typeof value.context.workspace.path !== 'string' || !path.isAbsolute(value.context.workspace.path) || typeof value.context.workspace.label !== 'string' || Buffer.byteLength(value.context.workspace.label) > 1024) throw new StorageError('execution-invalid', '原生工作区记录无效。');
    validateAgentSource(value.source); if (value.binding) validateAgentBinding(value.binding);
    for (const tool of value.tools) if (!tool || typeof tool.id !== 'string' || tool.id.length > 256 || Object.keys(tool).some(key => !['id', 'title', 'kind', 'status', 'detail', 'output', 'truncated'].includes(key)) || typeof tool.title !== 'string' || Buffer.byteLength(tool.title) > 1024 || !['read', 'write', 'command', 'other'].includes(tool.kind) || !['pending', 'running', 'completed', 'failed', 'unknown'].includes(tool.status) || tool.detail !== undefined && (typeof tool.detail !== 'string' || Buffer.byteLength(tool.detail) > 32772) || tool.output !== undefined && (typeof tool.output !== 'string' || Buffer.byteLength(tool.output) > 32772)) throw new StorageError('execution-invalid', '原生工具记录无效。');
    for (const approval of value.approvals) if (Object.keys(approval).some(key => !['id', 'toolID', 'title', 'detail', 'canAllow', 'state', 'decision', 'decider', 'reply'].includes(key)) || !isUUID(approval.id) || !['pending', 'decided', 'expired'].includes(approval.state) || typeof approval.canAllow !== 'boolean' || typeof approval.title !== 'string' || typeof approval.detail !== 'string' || Buffer.byteLength(approval.detail) > 32768 || approval.decision && !['allow', 'deny'].includes(approval.decision) || approval.decider && !['user', 'policy'].includes(approval.decider) || approval.reply && !['pending', 'queued', 'unknown'].includes(approval.reply)) throw new StorageError('execution-invalid', '原生审批记录无效。');
    if (new Set(value.tools.map(t => t.id)).size !== value.tools.length || new Set(value.approvals.map(a => a.id)).size !== value.approvals.length) throw new StorageError('execution-invalid', '原生工具或审批标识重复。');
    return value;
  }
  private contextFile(sessionID: string): string { return path.join(this.root, 'agent-execution-v1', id(sessionID), 'context.json'); }
  private file(sessionID: string, turnID: string): string { return path.join(this.root, 'agent-execution-v1', id(sessionID), id(turnID) + '.json'); }
  private async save(file: string, value: unknown, create = false): Promise<void> { await withExclusiveLock(file + '.lock', async () => { const previous = await readBytes(file, LIMIT); const known = this.observed.get(file); if (this.observed.has(file) && (known === undefined ? previous !== undefined : previous === undefined || !known.equals(previous))) throw new StorageError('revision-changed', '原生执行记录已被其他写入者修改，未覆盖。'); if (create && previous) throw new StorageError('execution-exists', '原记录已存在，未替换。'); const bytes = Buffer.from(JSON.stringify(value)); await atomicReplace(file, bytes, previous, LIMIT); this.observed.set(file, bytes); }); }
}

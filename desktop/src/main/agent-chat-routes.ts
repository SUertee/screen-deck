import { isNewPermissionMode } from '../shared/agent-permissions.js';
import type { AgentExecutionSelection } from '../shared/agent-execution.js';
import { StorageError, type SessionManager } from '../core/index.js';
import type { AgentChatSourceInfo } from '../shared/agent-chat.js';
import type { SessionScope } from '../shared/types.js';
import type { ProjectWorkspaceReader } from '../projects/index.js';
import type { ElectronHost } from './electron-host.js';
import { payload, textInput, uuidInput } from './ipc-validation.js';

/** Fixed IPC for native-context chat. No credentials, executable paths or SDK handles. */
export function installAgentChatRoutes({ host, manager, projects, sources, prepareExecution }: {
  host: Pick<ElectronHost, 'handle'>;
  manager: SessionManager;
  projects: ProjectWorkspaceReader;
  sources: () => AgentChatSourceInfo[];
  prepareExecution?: (sessionID: string, source: import('../shared/agent-chat.js').AgentChatSource, selection: AgentExecutionSelection) => Promise<void>;
}): void {
  const noInput = (input: unknown) => { if (input !== undefined) throw new StorageError('ipc-input', '此操作不接受配置参数。'); };
  host.handle('agent-chat-sources', input => { noInput(input); return sources(); });
  host.handle('create-agent-session', async input => {
    const value = payload(input, ['title', 'agentID', 'scope', 'execution']);
    const agentID = textInput(value.agentID, 100);
    if (!sources().some(source => source.agentID === agentID)) throw new StorageError('agent-unregistered', 'Agent 尚未注册。');
    const scope = value.scope as SessionScope | undefined;
    if (scope?.kind === 'project') {
      const registered = projects.get(textInput(scope.project_id, 100));
      if (!registered?.project || registered.project.project_id !== scope.project_id || ['stale', 'error'].includes(registered.status) || scope.task_id && !registered.tasks.some(task => task.task_id === scope.task_id)) throw new StorageError('scope-invalid', '任务来源未确认或已失效。');
    }
    let execution: AgentExecutionSelection | undefined;
    if (value.execution !== undefined) { const selected = payload(value.execution, ['workspaceID', 'mode']); if (!isNewPermissionMode(selected.mode)) throw new StorageError('ipc-input', '权限模式无效。'); execution = { workspaceID: uuidInput(selected.workspaceID), mode: selected.mode as AgentExecutionSelection['mode'] }; }
    if (execution && !prepareExecution) throw new StorageError('tools-unavailable', '当前连接未开放本地工具。');
    const session = await manager.createAgentSession({ title: textInput(value.title, 600), agentID, ...(scope === undefined ? {} : { scope }) });
    if (execution) await prepareExecution?.(session.conversation_id, session.source, execution);
    return session;
  });
  host.handle('load-agent-session', input => manager.loadAgentSession(uuidInput(input)));
  host.handle('send-agent-message', input => {
    const value = payload(input, ['sessionID', 'text']);
    const text = textInput(value.text, 256 * 1024);
    if (!text.trim()) throw new StorageError('input-invalid', '请先填写消息。');
    return manager.sendAgentMessage({ sessionID: uuidInput(value.sessionID), text });
  });
  host.handle('stop-agent-generation', input => manager.stopAgentGeneration(uuidInput(input)));
  host.handle('retry-agent-pending-writes', input => manager.retryAgentPendingWrites(uuidInput(input)));
}

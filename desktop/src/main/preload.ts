import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, DesktopEvent } from '../shared/desktop-api.js';
import type { TaskSessionEvent, HarnessErrorCode } from '../shared/task-execution.js';
const invoke = <T>(channel: string, input?: unknown): Promise<T> => ipcRenderer.invoke(`screendeck:${channel}`, input);
const taskInvoke = async <T>(channel: string, input?: unknown): Promise<T> => {
  const result = await invoke<{ ok: true; value: T } | { ok: false; error: { code: HarnessErrorCode; message: string } }>(channel, input);
  if (result.ok) return result.value;
  // contextBridge strips custom Error properties; reject a cloneable error DTO instead.
  throw { code: result.error.code, message: result.error.message };
};
const api: DesktopAPI = {
  getTaskExecutionOptions: input => taskInvoke('task-execution-options', input),
  createTaskSession: input => taskInvoke('create-task-session', input),
  listTaskSessions: input => taskInvoke('list-task-sessions', input),
  loadTaskSession: ref => taskInvoke('load-task-session', ref),
  listExecutionApprovals: turn => taskInvoke('list-execution-approvals', turn),
  getWorkItemReview: turn => taskInvoke('get-work-item-review', turn),
  requestExecutionAuthorization: input => taskInvoke('request-execution-authorization', input),
  decideApproval: input => taskInvoke('decide-execution-approval', input),
  startExecution: input => taskInvoke('start-task-execution', input),
  cancelExecution: turn => taskInvoke('cancel-task-execution', turn),
  replyToolPermission: input => taskInvoke('reply-task-permission', input),
  reconcileExecution: turn => taskInvoke('reconcile-task-execution', turn),
  reviewWorkItem: input => taskInvoke('review-work-item', input),
  retryTaskPendingWrites: ref => taskInvoke('retry-task-pending-writes', ref),
  onTaskSessionEvent: callback => {
    const handler = (_event: unknown, value: TaskSessionEvent) => callback(value);
    ipcRenderer.on('screendeck:task-event', handler);
    return () => { ipcRenderer.removeListener('screendeck:task-event', handler); };
  },
  bootstrap: () => invoke('bootstrap'),
  getAgentSources: () => invoke('agent-chat-sources'),
  createAgentSession: input => invoke('create-agent-session', input),
  loadAgentSession: id => invoke('load-agent-session', id),
  sendAgentMessage: input => invoke('send-agent-message', input),
  stopAgentGeneration: id => invoke('stop-agent-generation', id),
  retryAgentPendingWrites: id => invoke('retry-agent-pending-writes', id),
  createSession: input => invoke('create-session', input),
  loadSession: id => invoke('load-session', id),
  setChatArchived: input => invoke('set-chat-archived', input),
  setChatPinned: input => invoke('set-chat-pinned', input),
  renameSession: input => invoke('rename-session', input),
  renameAgentSession: input => invoke('rename-agent-session', input),
  copyText: text => invoke('copy-text', text),
  sendMessage: input => invoke('send-message', input),
  stopGeneration: id => invoke('stop-generation', id),
  retryPendingWrites: id => invoke('retry-pending-writes', id),
  getSettings: () => invoke('get-settings'),
  saveSettings: input => invoke('save-settings', input),
  getProviderModels: () => invoke('get-provider-models'),
  listProviderModels: input => invoke('list-provider-models', input),
  selectProviderModel: input => invoke('select-provider-model', input),
  getOpenCodeStatus: () => invoke('opencode-status'),
  getOpenCodeInstallation: () => invoke('opencode-installation'),
  chooseOpenCodeBinary: () => invoke('choose-opencode-binary'),
  openOpenCodeInstallGuide: () => invoke('opencode-install-guide'),
  startOpenCode: input => invoke('start-opencode', input),
  stopOpenCode: () => invoke('stop-opencode'),
  chooseProject: () => invoke('choose-project'),
  refreshProject: id => invoke('refresh-project', id),
  previewArtifact: input => invoke('preview-artifact', input),
  createPlan: input => invoke('create-plan', input),
  savePlan: input => invoke('save-plan', input),
  recommendations: id => invoke('recommendations', id),
  saveDraft: input => invoke('save-draft', input),
  loadDraft: key => invoke('load-draft', key),
  openDeck: (sessionID?: string) => invoke('open-deck', sessionID),
  showWorkbench: () => invoke('show-workbench'),
  subscribe: callback => {
    const handler = (_event: unknown, value: DesktopEvent) => callback(value);
    ipcRenderer.on('screendeck:event', handler);
    return () => { ipcRenderer.removeListener('screendeck:event', handler); };
  }
};
contextBridge.exposeInMainWorld('screendeck', Object.freeze(api));

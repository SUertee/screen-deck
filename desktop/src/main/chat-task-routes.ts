import { StorageError } from '../core/storage/private-storage';
import type { ChatTaskCreateReply } from '../shared/chat-task';
import type { ElectronHost } from './electron-host';
import type { ChatTaskService } from './chat-task-service';
/** Use existing host.handle trusted-window validation, never raw ipcMain listeners. */
export function installChatTaskRoutes(host: Pick<ElectronHost,'handle'>, service: ChatTaskService): void {
  host.handle('chat-task-source', input => service.source(input));
  const create = (mode:'chat'|'draft') => async (input:unknown): Promise<ChatTaskCreateReply> => {
    try { return { ok: true, plan: await (mode==='chat'?service.create(input):service.draft(input)) }; }
    catch (error) {
      const code = error instanceof StorageError ? error.code : 'chat-task-failed';
      return { ok: false, error: { code, message: error instanceof Error ? error.message : '任务保存失败，请重试同一创建。', safeToEdit: ['ipc-input','chat-task-input','chat-task-source','chat-task-busy','chat-task-message','chat-task-changed','chat-task-excerpt'].includes(code) } };
    }
  };
  host.handle('create-task-from-chat',create('chat'));
  host.handle('create-task-draft',create('draft'));
}

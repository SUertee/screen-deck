import type { AgentExecutionController } from '../core/agents/agent-execution-controller.js';
import type { ElectronHost } from './electron-host.js';
import { StorageError } from '../core/storage/private-storage.js';
import { payload, uuidInput } from './ipc-validation.js';
export function installAgentExecutionRoutes({ host, controller, choose }: { host: Pick<ElectronHost, 'handle'>; controller: AgentExecutionController; choose(): Promise<string | undefined> }): void {
  host.handle('choose-agent-workspace', async input => { if (input !== undefined) throw new StorageError('ipc-input', '此操作不接受目录参数。'); const directory = await choose(); return directory ? controller.choose(directory) : undefined; });
  host.handle('agent-execution-context', input => controller.context(uuidInput(input)));
  host.handle('agent-execution', input => { const value = payload(input, ['sessionID', 'turnID']); return controller.read(uuidInput(value.sessionID), uuidInput(value.turnID)); });
  host.handle('decide-agent-permission', input => {
    const value = payload(input, ['sessionID', 'turnID', 'approvalID', 'decision']);
    if (value.decision !== 'allow' && value.decision !== 'deny') throw new StorageError('ipc-input', '审批决定无效。');
    return controller.decide({ sessionID: uuidInput(value.sessionID), turnID: uuidInput(value.turnID), approvalID: uuidInput(value.approvalID), decision: value.decision });
  });
}

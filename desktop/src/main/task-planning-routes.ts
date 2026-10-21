import { exactObject } from '../core/storage/execution-records.js';
import { isUUID } from '../core/sessions/session-schema.js';
import { planningFail } from '../core/tasks/task-planning-schema.js';
import type { TaskPlanningService, ConfirmTaskPlanInput } from '../core/tasks/task-planning-service.js';
import type { TaskSequentialQueueService, QueueSetup } from '../core/tasks/task-sequential-queue.js';
import type { GenerateTaskPlanInput } from '../core/tasks/task-planning-contract.js';
const ref = (input: unknown) => { const v = exactObject(input, ['taskID', 'queueID']); if (!isUUID(v.taskID) || !isUUID(v.queueID)) planningFail('队列标识无效。'); return v as unknown as { taskID: string; queueID: string }; };
/** Fixed IPC handlers only. Caller must use ElectronHost.handle's trusted frame/window guard. */
export function taskPlanningRouteHandlers(planning: TaskPlanningService, queue: TaskSequentialQueueService) {
  return {
    'task:planning:generate': (input: unknown) => planning.generate(input as GenerateTaskPlanInput),
    'task:planning:list': (input: unknown) => { const v = exactObject(input, ['taskID']); if (!isUUID(v.taskID)) planningFail('任务标识无效。'); return planning.list(v.taskID as string); },
    'task:planning:get': (input: unknown) => { const v = exactObject(input, ['taskID', 'requestID']); if (!isUUID(v.taskID) || !isUUID(v.requestID)) planningFail('规划请求标识无效。'); return planning.get(v.taskID as string, v.requestID as string); },
    'task:planning:cancel': (input: unknown) => { const v = exactObject(input, ['taskID', 'requestID']); return planning.cancel(v.taskID as string, v.requestID as string); },
    'task:planning:confirm': (input: unknown) => planning.confirm(input as ConfirmTaskPlanInput),
    'task:queue:create': (input: unknown) => queue.create(input as Parameters<typeof queue.create>[0]),
    'task:queue:inspect': (input: unknown) => { const v = ref(input); return queue.inspect(v.taskID, v.queueID); },
    'task:queue:prepare-next': (input: unknown) => { const v = exactObject(input, ['taskID', 'queueID', 'setup']), r = ref({ taskID: v.taskID, queueID: v.queueID }); return queue.prepareNext(r.taskID, r.queueID, v.setup as QueueSetup); },
    'task:queue:start-next': (input: unknown) => { const v = exactObject(input, ['taskID', 'queueID', 'approvalID']), r = ref({ taskID: v.taskID, queueID: v.queueID }); return queue.startNext(r.taskID, r.queueID, v.approvalID as string); },
    'task:queue:stop': (input: unknown) => { const v = ref(input); return queue.stop(v.taskID, v.queueID); },
    'task:queue:reconcile': (input: unknown) => { const v = ref(input); return queue.reconcile(v.taskID, v.queueID); },
  };
}

import type { AgentChatDriver, AgentChatRequest } from '../sessions/agent-chat-driver.js';
import { ExecutionError } from '../sessions/execution-driver.js';
import { canonicalDigest } from '../storage/execution-records.js';
import type { NativeWorkItemAttempt } from './native-work-item-contract.js';
const same = (a: unknown, b: unknown) => canonicalDigest(a) === canonicalDigest(b);
/** Install INSIDE AgentExecutionController.wrap(), immediately before the native adapter.
 * The owner must resolve managed session IDs durably, including after restart. */
export class NativeWorkItemDispatchGuard {
  private preparations = 0;
  beginPreparation(): () => void {
    this.preparations++; let open = true;
    return () => { if (open) { open = false; this.preparations--; } };
  }
  private permits = new Map<string, NativeWorkItemAttempt>();
  constructor(private isManagedSession: (sessionID: string) => Promise<boolean>, private validatePermit?: (attempt: NativeWorkItemAttempt) => Promise<void>) {}
  arm(attempt: NativeWorkItemAttempt): void {
    if (!attempt.sessionID || attempt.status !== 'dispatching' || this.permits.has(attempt.sessionID)) throw new ExecutionError('configuration', '工作项提交许可无效。', false);
    this.permits.set(attempt.sessionID, structuredClone(attempt));
  }
  revoke(sessionID: string): void { this.permits.delete(sessionID); }
  wrap(driver: AgentChatDriver): AgentChatDriver {
    const send: AgentChatDriver['sendTurn'] = async (request, emit, signal) => {
      const permit = this.permits.get(request.sessionID);
      if (permit || await this.isManagedSession(request.sessionID)) {
        this.permits.delete(request.sessionID);
        if (permit) await this.validatePermit?.(structuredClone(permit));
        this.check(driver, request, permit);
      }
      else if (this.preparations) throw new ExecutionError('configuration', '工作项会话正在建立绑定，请稍后重试普通聊天。', false);
      return driver.sendTurn(request, emit, signal);
    };
    return {
      descriptor: driver.descriptor, getSource: () => driver.getSource(), sendTurn: send,
      ...(driver.sendTextTurn ? { sendTextTurn: async (...args: Parameters<AgentChatDriver['sendTurn']>) => {
        if (this.preparations || this.permits.has(args[0].sessionID) || await this.isManagedSession(args[0].sessionID)) throw new ExecutionError('configuration', '原生工作项不能回退纯文本通道。', false);
        return driver.sendTextTurn!(...args);
      } } : {}),
      ...(driver.replyPermission ? { replyPermission: driver.replyPermission.bind(driver) } : {}),
      cancelTurn: driver.cancelTurn.bind(driver),
    };
  }
  private check(driver: AgentChatDriver, request: AgentChatRequest, permit?: NativeWorkItemAttempt): void {
    const source = driver.getSource();
    if (!permit || !source || !same(source, permit.source) || request.binding || request.input !== permit.prompt || !same(request.source, { agentID: permit.source.agentID, configDigest: permit.source.configDigest }) || !same(request.model, permit.source.model) || !request.execution || !same(request.execution, permit.input.context)) throw new ExecutionError('configuration', '原工作项提交范围或原生连接已变化，未执行。', false);
  }
}

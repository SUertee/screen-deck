import type { AgentChatDriver, AgentChatDriverResolver } from '../sessions/agent-chat-driver.js';
import type { AgentChatReadySource, AgentChatSourceInfo } from '../../shared/agent-chat.js';
import type { AgentDescriptor } from '../../shared/agent-capabilities.js';
import { supportsAgentChat } from '../../shared/agent-capabilities.js';
import { validateAgentBinding, validateAgentSource } from '../sessions/agent-session-schema.js';
import { validateModel } from '../sessions/session-schema.js';
import { StorageError } from '../storage/private-storage.js';

export interface AgentChatRegistration {
  driver: AgentChatDriver;
  unavailableReason?: () => 'stopped' | 'requires-restart';
}
const capabilityKeys = ['streaming', 'nativeContext', 'interrupt', 'resume', 'tools', 'approvals', 'modelSelection'];
const descriptor = (value: Readonly<AgentDescriptor>): AgentDescriptor => {
  if (!value || typeof value.agentID !== 'string' || !/^[a-z][a-z0-9-]{0,99}$/.test(value.agentID) || typeof value.name !== 'string' || !value.name.trim() || Buffer.byteLength(value.name) > 150 || /[\x00-\x1f\x7f]/.test(value.name) || !['acp', 'native'].includes(value.protocol) || !value.capabilities || Object.keys(value.capabilities).length !== capabilityKeys.length || capabilityKeys.some(key => !Object.hasOwn(value.capabilities, key) || typeof (value.capabilities as unknown as Record<string, unknown>)[key] !== 'boolean')) throw new StorageError('agent-registration', 'Agent 注册信息无效。');
  return { agentID: value.agentID, name: value.name, protocol: value.protocol, capabilities: { ...value.capabilities } };
};

/** Immutable composition registry. Reading it never starts a process or resolves credentials. */
export class AgentChatRegistry implements AgentChatDriverResolver {
  private readonly registrations = new Map<string, { driver: AgentChatDriver; descriptor: AgentDescriptor; unavailableReason?: AgentChatRegistration['unavailableReason'] }>();
  constructor(registrations: readonly AgentChatRegistration[]) {
    if (registrations.length > 32) throw new StorageError('agent-registration', 'Agent 注册数量超过上限。');
    for (const registration of registrations) {
      const info = descriptor(registration.driver.descriptor);
      if (this.registrations.has(info.agentID)) throw new StorageError('agent-registration', 'Agent 标识重复，不能替换已注册适配器。');
      this.registrations.set(info.agentID, { ...registration, descriptor: info });
    }
  }
  resolve(agentID: string): AgentChatDriver | undefined { return this.registrations.get(agentID)?.driver; }
  listSources(): AgentChatSourceInfo[] { return [...this.registrations.keys()].map(id => this.source(id)!); }
  getSource(agentID: string): AgentChatReadySource | undefined {
    const source = this.source(agentID);
    return source?.state === 'ready' ? source : undefined;
  }
  private source(agentID: string): AgentChatSourceInfo | undefined {
    const registration = this.registrations.get(agentID);
    if (!registration) return undefined;
    const info = structuredClone(registration.descriptor);
    const unavailable = (reason: Extract<AgentChatSourceInfo, { state: 'unavailable' }>['reason']): AgentChatSourceInfo => ({ ...info, state: 'unavailable', reason });
    // A native protocol is welcome, but this lifecycle cannot yet control tool execution.
    if (!supportsAgentChat(info.capabilities)) return unavailable('unsupported');
    try {
      const source = registration.driver.getSource();
      if (!source) return unavailable(registration.unavailableReason?.() ?? 'stopped');
      validateAgentSource({ agentID: source.agentID, configDigest: source.configDigest });
      validateAgentBinding({ runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, externalSessionID: 'ready' });
      validateModel(source.model);
      const actual = descriptor(source);
      if (source.state !== 'ready' || source.agentID !== agentID || actual.protocol !== info.protocol || actual.name !== info.name || capabilityKeys.some(key => actual.capabilities[key as keyof typeof actual.capabilities] !== info.capabilities[key as keyof typeof info.capabilities])) return unavailable('invalid-source');
      // Whitelist metadata: private SDK handles, URLs and credentials cannot cross IPC.
      return { ...info, state: 'ready', configDigest: source.configDigest, runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration, model: { ...source.model } };
    } catch { return unavailable('invalid-source'); }
  }
}

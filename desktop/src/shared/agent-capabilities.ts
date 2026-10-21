/** Effective adapter profile, not every feature the installed CLI may support. */
export interface AgentChatCapabilities {
  streaming: boolean;
  nativeContext: boolean;
  interrupt: boolean;
  resume: boolean;
  tools: boolean;
  approvals: boolean;
  modelSelection: boolean;
}
export interface AgentDescriptor {
  agentID: string;
  name: string;
  protocol: 'acp' | 'native';
  capabilities: Readonly<AgentChatCapabilities>;
}
/** Current text-chat pipeline has no tool/approval controller or resume operation. */
export const TEXT_AGENT_CAPABILITIES: Readonly<AgentChatCapabilities> = Object.freeze({
  streaming: true, nativeContext: true, interrupt: true,
  resume: false, tools: false, approvals: false, modelSelection: false,
});
export function supportsAgentTextChat(capabilities: Readonly<AgentChatCapabilities> | undefined): boolean {
  return capabilities?.streaming === true && capabilities.nativeContext === true && capabilities.tools === false && capabilities.approvals === false && capabilities.resume === false && capabilities.modelSelection === false;
}

export const NATIVE_AGENT_CAPABILITIES: Readonly<AgentChatCapabilities> = Object.freeze({ ...TEXT_AGENT_CAPABILITIES, tools: true, approvals: true });
/** Both native event handling and approval replies must be connected together. */
export function supportsAgentChat(c: Readonly<AgentChatCapabilities> | undefined): boolean {
  return !!c && c.streaming && c.nativeContext && !c.resume && !c.modelSelection && c.tools === c.approvals;
}

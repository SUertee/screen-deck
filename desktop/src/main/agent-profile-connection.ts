import type { AgentChatReadySource } from '../shared/agent-chat.js';
/** Public identity remains stable across the separately restricted protocol process. */
export function agentProfileConnection<T extends { configDigest: string; runtimeID: string; connectionGeneration: string; model: { provider_id: string; model_id: string } }>(getConnection: () => T | undefined, getPublic: () => AgentChatReadySource | undefined): () => T | undefined {
  let previous: T | undefined, publicSource: AgentChatReadySource | undefined, aliased: T | undefined;
  return () => {
    const connection = getConnection(), source = getPublic();
    if (!connection || !source || connection.model.provider_id !== source.model.provider_id || connection.model.model_id !== source.model.model_id) return undefined;
    if (previous !== connection || publicSource?.configDigest !== source.configDigest || publicSource?.runtimeID !== source.runtimeID || publicSource?.connectionGeneration !== source.connectionGeneration) {
      previous = connection; publicSource = source; aliased = { ...connection, configDigest: source.configDigest, runtimeID: source.runtimeID, connectionGeneration: source.connectionGeneration };
    }
    return aliased;
  };
}

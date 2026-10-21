import test from 'node:test';
import assert from 'node:assert/strict';
import { agentProfileConnection } from '../../src/main/agent-profile-connection.js';
import type { AgentChatReadySource } from '../../src/shared/agent-chat.js';
import { NATIVE_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
test('restricted connection keeps its physical transport while sharing the public source identity', () => {
  let publicSource: AgentChatReadySource | undefined = { agentID: 'fixture', name: 'Fixture', protocol: 'native', capabilities: NATIVE_AGENT_CAPABILITIES, state: 'ready', configDigest: 'public', runtimeID: 'public-runtime', connectionGeneration: 'public-generation', model: { provider_id: 'fixture', model_id: 'model' } };
  const connection = { configDigest: 'restricted', runtimeID: 'private-runtime', connectionGeneration: 'private-generation', model: publicSource.model, request: () => 'restricted-only' };
  const get = agentProfileConnection(() => connection, () => publicSource); const first = get()!; assert.equal(first.request(), 'restricted-only'); assert.equal(first.configDigest, 'public'); assert.equal(first.runtimeID, 'public-runtime'); assert.equal(get(), first);
  publicSource = { ...publicSource, connectionGeneration: 'new-generation' }; assert.notEqual(get(), first); assert.equal(get()!.connectionGeneration, 'new-generation'); publicSource = undefined; assert.equal(get(), undefined);
});
test('a model mismatch cannot silently change the public requested model', () => {
  const publicSource = { model: { provider_id: 'fixture', model_id: 'expected' } } as AgentChatReadySource;
  assert.equal(agentProfileConnection(() => ({ configDigest: 'x', runtimeID: 'x', connectionGeneration: 'x', model: { provider_id: 'fixture', model_id: 'other' } }), () => publicSource)(), undefined);
});

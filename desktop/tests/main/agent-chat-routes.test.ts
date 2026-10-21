import { NATIVE_AGENT_CAPABILITIES, TEXT_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { installAgentChatRoutes } from '../../src/main/agent-chat-routes.js';
import type { SessionManager } from '../../src/core/sessions/session-manager.js';
import type { ProjectWorkspaceReader } from '../../src/projects/index.js';
import type { AgentChatSourceInfo } from '../../src/shared/agent-chat.js';

const id = '019a0000-0000-7000-8000-000000000091';
function fixture(capabilities = TEXT_AGENT_CAPABILITIES) {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const calls: Array<{ name: string; input: unknown }> = [];
  let ready = false;
  const sources = (): AgentChatSourceInfo[] => ready ? [{ agentID: 'opencode', name: 'OpenCode', protocol: 'acp', capabilities, state: 'ready', configDigest: 'a'.repeat(64), runtimeID: 'fixture-runtime', connectionGeneration: 'fixture-generation', model: { provider_id: 'screendeck', model_id: 'fixture-model' } }] : [{ agentID: 'opencode', name: 'OpenCode', protocol: 'acp', capabilities, state: 'unavailable', reason: 'stopped' }];
  const method = (name: string) => async (input: unknown) => { calls.push({ name, input }); return { fixture: true }; };
  const manager = { createAgentSession: method('create'), loadAgentSession: method('load'), sendAgentMessage: method('send'), stopAgentGeneration: method('stop'), retryAgentPendingWrites: method('retry') } as unknown as SessionManager;
  const projects = { get: () => undefined } as unknown as ProjectWorkspaceReader;
  installAgentChatRoutes({ host: { handle: (name, operation) => { handlers.set(name, operation); } }, manager, projects, sources });
  return { calls, ready: () => { ready = true; }, invoke: async (name: string, input?: unknown) => handlers.get(name)!(input) };
}

test('reading Agent sources is metadata-only and rejects arbitrary runtime configuration', async () => {
  const h = fixture();
  assert.deepEqual(await h.invoke('agent-chat-sources'), [{ agentID: 'opencode', name: 'OpenCode', protocol: 'acp', capabilities: TEXT_AGENT_CAPABILITIES, state: 'unavailable', reason: 'stopped' }]);
  h.ready();
  const source = (await h.invoke('agent-chat-sources')) as AgentChatSourceInfo[];
  assert.equal(source[0].state, 'ready');
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.invoke('agent-chat-sources', { binaryPath: '/untrusted/agent' }));
  assert.equal(JSON.stringify(source).includes('credential'), false);
});

test('Agent IPC admits only registered identities and current input, with no renderer model/config/history', async () => {
  const h = fixture();
  for (const input of [
    { title: 'chat', agentID: 'unknown' },
    { title: 'chat', agentID: 'opencode', configDigest: 'forged' },
    { title: 'chat', agentID: 'opencode', scope: { kind: 'project', project_id: 'unregistered' } },
  ]) await assert.rejects(h.invoke('create-agent-session', input));
  for (const input of [
    { sessionID: id, text: 'current', model: { provider_id: 'forged', model_id: 'forged' } },
    { sessionID: id, text: 'current', messages: [{ content: 'other history' }] },
    { sessionID: id, text: 'current', binding: { externalSessionID: 'forged' } },
    { sessionID: id, text: ' ' }, { sessionID: '../record', text: 'current' },
    { sessionID: id, text: 'a'.repeat(256 * 1024 + 1) },
  ]) await assert.rejects(h.invoke('send-agent-message', input));
  assert.equal(h.calls.length, 0);
  await h.invoke('create-agent-session', { title: 'chat', agentID: 'opencode' });
  await h.invoke('send-agent-message', { sessionID: id, text: 'only current input' });
  assert.deepEqual(h.calls, [{ name: 'create', input: { title: 'chat', agentID: 'opencode' } }, { name: 'send', input: { sessionID: id, text: 'only current input' } }]);
});

test('load, stop and local-save retry route to distinct Agent lifecycle methods', async () => {
  const h = fixture();
  for (const name of ['load-agent-session', 'stop-agent-generation', 'retry-agent-pending-writes']) {
    await assert.rejects(h.invoke(name, { sessionID: id, binding: 'forged' }));
    await h.invoke(name, id);
  }
  assert.deepEqual(h.calls, [{ name: 'load', input: id }, { name: 'stop', input: id }, { name: 'retry', input: id }]);
});

test('tool-capable Agent can create plain chat without a project or selected directory', async () => {
  const h = fixture(NATIVE_AGENT_CAPABILITIES); h.ready(); await h.invoke('create-agent-session', { title: '你好', agentID: 'opencode' }); assert.deepEqual(h.calls, [{ name: 'create', input: { title: '你好', agentID: 'opencode' } }]);
  await assert.rejects(h.invoke('create-agent-session', { title: 'tools', agentID: 'opencode', execution: { workspaceID: id, mode: 'confirm-changes' } }), /未开放本地工具/);
});

test('new Agent sessions reject legacy and unknown permission choices before configuring tools',async()=>{const h=fixture(NATIVE_AGENT_CAPABILITIES);h.ready();for(const mode of ['read-only','ask','allow-everything'])await assert.rejects(h.invoke('create-agent-session',{title:'tools',agentID:'opencode',execution:{workspaceID:id,mode}}),/权限模式无效/);assert.deepEqual(h.calls,[]);});

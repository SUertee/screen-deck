import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { AgentChatModeRouter } from '../../src/core/agents/agent-chat-mode-router.js';
import { AgentExecutionController } from '../../src/core/agents/agent-execution-controller.js';
import { NATIVE_AGENT_CAPABILITIES, TEXT_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import type { AgentChatDriver, AgentChatRequest } from '../../src/core/sessions/agent-chat-driver.js';
const req = (): AgentChatRequest => ({ sessionID: randomUUID(), turnID: randomUUID(), clientRequestID: randomUUID(), source: { agentID: 'fixture', configDigest: 'a'.repeat(64) }, model: { provider_id: 'fixture', model_id: 'fixture' }, input: '你好' });
function fixture() {
  const sent: string[] = [], stopped: string[] = [];
  const driver = (mode: string): AgentChatDriver => ({ descriptor: { agentID: 'fixture', name: 'Fixture', protocol: 'native', capabilities: mode === 'text' ? TEXT_AGENT_CAPABILITIES : NATIVE_AGENT_CAPABILITIES }, getSource: () => undefined, sendTurn: async request => { sent.push(mode); assert.equal(!!request.execution, mode === 'tools'); }, cancelTurn: async () => { stopped.push(mode); return { status: 'confirmed' }; } });
  const native = driver('tools'), text = driver('text'); let preparations = 0;
  const router = new AgentChatModeRouter(native, text, async () => { preparations++; }); return { native, router, sent, stopped, preparations: () => preparations };
}
test('chat without workspace uses the explicitly restricted path, not the native tool driver', async t => {
  const root = await mkdtemp('/private/tmp/screendeck-optional-workspace-'); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(), controller = new AgentExecutionController(root, () => {}), wrapped = controller.wrap(f.router), request = req();
  await wrapped.sendTurn(request, async () => {}, new AbortController().signal); assert.deepEqual(f.sent, ['text']); assert.equal(f.preparations(), 1);
  assert.equal(await controller.context(request.sessionID), undefined); assert.equal(await controller.read(request.sessionID, request.turnID), undefined);
  await wrapped.cancelTurn({ clientRequestID: request.clientRequestID, source: request.source }); assert.deepEqual(f.stopped, ['text']);
});
test('conversation cannot silently upgrade from text to native tools', async () => {
  const f = fixture(), request = req(); await f.router.sendTextTurn(request, async () => {}, new AbortController().signal);
  await assert.rejects(f.router.sendTurn({ ...request, execution: { mode: 'ask', workspace: { id: randomUUID(), path: '/fixture', label: 'fixture' } } }, async () => {}, new AbortController().signal), /模式已固定/); assert.deepEqual(f.sent, ['text']);
});
test('missing context on a driver without a restricted chat implementation fails before any native call', async t => {
  const root = await mkdtemp('/private/tmp/screendeck-optional-workspace-'); t.after(() => rm(root, { recursive: true, force: true })); const f = fixture();
  await assert.rejects(new AgentExecutionController(root, () => {}).wrap(f.native).sendTurn(req(), async () => {}, new AbortController().signal), /尚未开放纯聊天/); assert.deepEqual(f.sent, []);
});

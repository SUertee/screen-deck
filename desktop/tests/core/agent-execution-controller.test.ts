import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { AgentExecutionController } from '../../src/core/agents/agent-execution-controller.js';
import { NativePermissionRequests } from '../../src/core/agents/native-tools.js';
import { NATIVE_AGENT_CAPABILITIES } from '../../src/shared/agent-capabilities.js';
import type { AgentChatDriver, AgentChatRequest } from '../../src/core/sessions/agent-chat-driver.js';
import type { AgentExecutionRecord, AgentPermissionMode } from '../../src/shared/agent-execution.js';
async function fixture(t: test.TestContext, mode: AgentPermissionMode = 'ask', automatic = false) {
  const root = await mkdtemp('/private/tmp/screendeck-native-controller-'), workspace = path.join(root, 'workspace'); await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const changes: AgentExecutionRecord[] = [], permissions = new NativePermissionRequests();
  const controller = new AgentExecutionController(root, record => { changes.push(record); });
  const source = { agentID: 'fixture', configDigest: 'a'.repeat(64) }, binding = { runtimeID: randomUUID(), connectionGeneration: randomUUID(), externalSessionID: 'native-thread' };
  const request: AgentChatRequest = { sessionID: randomUUID(), turnID: randomUUID(), clientRequestID: randomUUID(), source, model: { provider_id: 'fixture', model_id: 'fixture' }, input: 'Synthetic operation' };
  const chosen = await controller.choose(workspace); await controller.configure(request.sessionID, source, { workspaceID: chosen.id, mode });
  let connected = true, replyCount = 0;
  const driver: AgentChatDriver = {
    descriptor: { agentID: 'fixture', name: 'Fixture', protocol: 'native', capabilities: NATIVE_AGENT_CAPABILITIES },
    getSource() { return connected ? { ...this.descriptor, ...source, ...binding, state: 'ready', model: request.model } : undefined; },
    async sendTurn(req, emit) {
      assert.equal(req.execution!.workspace.path, workspace); await emit({ type: 'bound', binding }); await emit({ type: 'submitted' });
      await emit({ type: 'tool', tool: { id: 'write-tool', title: 'Write output.txt', kind: 'write', status: 'pending' } });
      const allow = await permissions.ask({ source, binding, clientRequestID: req.clientRequestID }, { toolID: 'write-tool', title: 'Write output.txt', detail: 'Synthetic write', canAllow: true }, emit, 1000, automatic);
      if (allow) await writeFile(path.join(workspace, 'output.txt'), 'approved fixture');
      await emit({ type: 'tool', tool: { id: 'write-tool', title: 'Write output.txt', kind: 'write', status: allow ? 'completed' : 'failed' } });
      await emit({ type: 'settled', outcome: 'finished' });
    },
    replyPermission: async (lookup, id, decision) => { replyCount++; const stored = await controller.read(request.sessionID, request.turnID); assert.ok(stored!.approvals.some(a => a.id === id && a.state !== 'pending'), 'Decision/expiry must already be on disk'); return permissions.reply(lookup, id, decision); },
    async cancelTurn() { permissions.cancel({ source, binding, clientRequestID: request.clientRequestID }); return { status: 'unknown' }; },
  };
  const wrapped = controller.wrap(driver);
  const waitApproval = async () => { for (let n = 0; n < 200 && !changes.some(c => c.approvals.length); n++) await new Promise(r => setTimeout(r, 2)); const record = changes.find(c => c.approvals.length)!; assert.ok(record); return record.approvals[0]; };
  return { root, workspace, controller, request, changes, wrapped, waitApproval, disconnected: () => { connected = false; }, replies: () => replyCount, run: () => wrapped.sendTurn(request, async () => {}, new AbortController().signal) };
}
test('native write waits for persisted human decision; approval, protocol handoff and effect remain separate', async t => {
  const f = await fixture(t); const running = f.run(), approval = await f.waitApproval(); await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
  await f.controller.decide({ sessionID: f.request.sessionID, turnID: f.request.turnID, approvalID: approval.id, decision: 'allow' }); await running;
  assert.equal(await readFile(path.join(f.workspace, 'output.txt'), 'utf8'), 'approved fixture');
  const final = await f.controller.read(f.request.sessionID, f.request.turnID); assert.equal(final!.approvals[0].reply, 'queued'); assert.equal(final!.tools[0].status, 'completed');
  await assert.rejects(f.controller.decide({ sessionID: f.request.sessionID, turnID: f.request.turnID, approvalID: approval.id, decision: 'allow' }), /失效/); assert.equal(f.replies(), 1);
});
test('read-only policy denies pending native writes and preserves the denial without a human allow action', async t => {
  const f = await fixture(t, 'read-only'); await f.run(); await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
  const record = await f.controller.read(f.request.sessionID, f.request.turnID); assert.equal(record!.approvals[0].decision, 'deny'); assert.equal(record!.tools[0].status, 'failed');
});
test('original connection loss rejects an approval instead of rerouting it', async t => {
  const f = await fixture(t); const running = f.run(), approval = await f.waitApproval(); f.disconnected();
  await assert.rejects(f.controller.decide({ sessionID: f.request.sessionID, turnID: f.request.turnID, approvalID: approval.id, decision: 'allow' }), /失效/);
  await f.wrapped.cancelTurn({ clientRequestID: f.request.clientRequestID, source: f.request.source }); await running;
  await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
});
test('changed directory identity and forged workspace ID fail before any native operation', async t => {
  const f = await fixture(t); await assert.rejects(f.controller.configure(randomUUID(), f.request.source, { workspaceID: randomUUID(), mode: 'ask' }), /选择工作目录/);
  await rm(f.workspace, { recursive: true }); await mkdir(f.workspace); await assert.rejects(f.run(), error => error instanceof Error && error.message.includes('工作目录已变化') && 'attempted' in error && error.attempted === false); assert.equal(f.changes.length, 0);
});
test('restart expires pending native approvals and marks unfinished observations unknown without replying', async t => {
  const f = await fixture(t); const running = f.run(); await f.waitApproval();
  const restarted = new AgentExecutionController(f.root, () => {}); const restored = await restarted.read(f.request.sessionID, f.request.turnID); assert.equal(restored!.status, 'unknown'); assert.equal(restored!.approvals[0].state, 'expired'); assert.equal(f.replies(), 0);
  await f.wrapped.cancelTurn({ clientRequestID: f.request.clientRequestID, source: f.request.source }).catch(() => {}); await running.catch(() => {}); await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
});

test('a failed decision write never hands allow to the Agent and can be retried explicitly after repair', async t => {
  const f = await fixture(t); const running = f.run(), approval = await f.waitApproval();
  const directory = path.join(f.root, 'agent-execution-v1', f.request.sessionID); await chmod(directory, 0o500);
  try { await assert.rejects(f.controller.decide({ sessionID: f.request.sessionID, turnID: f.request.turnID, approvalID: approval.id, decision: 'allow' })); assert.equal(f.replies(), 0); await assert.rejects(readFile(path.join(f.workspace, 'output.txt'))); }
  finally { await chmod(directory, 0o700); }
  await f.controller.decide({ sessionID: f.request.sessionID, turnID: f.request.turnID, approvalID: approval.id, decision: 'deny' }); await running;
  await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
});

test('failed expiry persistence still requests native cancellation and does not retain a live approval', async t => {
  const f = await fixture(t); const running = f.run().catch(error => error); await f.waitApproval();
  const directory = path.join(f.root, 'agent-execution-v1', f.request.sessionID); await chmod(directory, 0o500);
  try {
    await assert.rejects(f.wrapped.cancelTurn({ clientRequestID: f.request.clientRequestID, source: f.request.source, binding: f.changes.find(c => c.binding)!.binding }));
    assert.ok(await running instanceof Error);
  } finally { await chmod(directory, 0o700); }
  const recovered = await f.controller.read(f.request.sessionID, f.request.turnID);
  assert.equal(recovered!.status, 'unknown'); assert.equal(recovered!.approvals[0].state, 'expired');
  await assert.rejects(readFile(path.join(f.workspace, 'output.txt')));
});

test('automatic file permission is persisted with policy provenance before native delivery',async t=>{const f=await fixture(t,'auto-edit',true);await f.run();const record=await f.controller.read(f.request.sessionID,f.request.turnID);assert.equal(record!.context.mode,'auto-edit');assert.equal(record!.approvals[0].decider,'policy');assert.equal(record!.approvals[0].decision,'allow');assert.equal(await readFile(path.join(f.workspace,'output.txt'),'utf8'),'approved fixture');assert.equal(f.replies(),1);});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexAgentChatAdapter } from '../../src/core/agents/codex/codex-agent-chat-adapter.js';
import type { CodexConnection, CodexNotification } from '../../src/core/agents/codex/codex-connection.js';
import type { AgentChatRequest, AgentChatExecutionEvent } from '../../src/core/sessions/agent-chat-driver.js';
import type { AgentChatBinding } from '../../src/shared/agent-chat.js';
import { ExecutionError } from '../../src/core/sessions/execution-driver.js';
function fixture(mode = 'success') {
  const listeners = new Set<(event: CodexNotification) => void>(), calls: { method: string; params: any }[] = [], events: AgentChatExecutionEvent[] = [];
  let current: CodexConnection | undefined, turn = 0;
  const emit = (method: string, params: Record<string, unknown>) => { for (const listener of listeners) listener({ method, params }); };
  const connection: CodexConnection = { runtimeID: randomUUID(), connectionGeneration: randomUUID(), configDigest: 'a'.repeat(64), model: { provider_id: 'openai', model_id: 'fixture-model' }, directory: '/fixture/empty', subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, async request(method, params) {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'fixture-model', modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: false } };
    if (method === 'turn/interrupt') { emit('turn/completed', { threadId: 'thread-1', turn: { id: `turn-${turn}`, status: 'interrupted' } }); return {}; }
    if (method !== 'turn/start') throw Error('Unexpected native method');
    const id = `turn-${++turn}`;
    if (mode === 'disconnect') { emit('screendeck/disconnected', {}); throw Error('private-fixture-token'); }
    emit('item/agentMessage/delta', { threadId: 'unrelated', turnId: id, itemId: 'foreign', delta: 'Never display' });
    emit('item/agentMessage/delta', { threadId: 'thread-1', turnId: id, itemId: `message-${turn}`, delta: `Reply ${turn}` });
    if (mode === 'accountchange') emit('account/updated', { authMode: 'chatgpt' });
    if (mode === 'tool') emit('item/started', { threadId: 'thread-1', turnId: id, item: { type: 'fileChange' } });
    if (mode !== 'hold') emit('turn/completed', { threadId: 'thread-1', turn: { id, status: mode === 'failed' ? 'failed' : 'completed' } });
    return { turn: { id, status: 'inProgress' } };
  } };
  current = connection;
  const adapter = new CodexAgentChatAdapter({ getConnection: () => current, turnTimeoutMs: 200, cancelTimeoutMs: 100 });
  const sessionID = randomUUID();
  const request = (binding?: AgentChatBinding): AgentChatRequest => ({ sessionID, turnID: randomUUID(), clientRequestID: randomUUID(), source: { agentID: 'codex', configDigest: connection.configDigest }, model: connection.model, input: 'Only current input', ...(binding ? { binding } : {}) });
  const binding = () => { const event = events.find(e => e.type === 'bound'); assert.ok(event && event.type === 'bound'); return event.binding; };
  return { adapter, calls, events, request, binding, emit, disconnect: () => { current = undefined; }, replace: () => { current = { ...connection, connectionGeneration: randomUUID() }; }, run: (req = request(), callback = async (event: AgentChatExecutionEvent) => { events.push(event); }) => adapter.sendTurn(req, callback, new AbortController().signal) };
}
test('Codex preserves native context, current-input-only, early notifications and exact thread correlation', async () => {
  const f = fixture(); await f.run(); await f.run(f.request(f.binding()));
  assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 1);
  assert.deepEqual(f.calls.filter(c => c.method === 'turn/start').map(c => c.params.input), [[{ type: 'text', text: 'Only current input', text_elements: [] }], [{ type: 'text', text: 'Only current input', text_elements: [] }]]);
  assert.deepEqual(f.events.filter(e => e.type === 'text-delta').map(e => e.type === 'text-delta' && e.text), ['Reply 1', 'Reply 2']);
  assert.equal(f.events.filter(e => e.type === 'settled').length, 2);
});
test('Codex must persist binding before sending, and never rebinds an old thread after replacement', async () => {
  const f = fixture(); await assert.rejects(f.run(f.request(), async event => { if (event.type === 'bound') throw Error('disk failure'); }), e => e instanceof ExecutionError && !e.attempted);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0);
  const g = fixture(); await g.run(); g.replace(); await assert.rejects(g.run(g.request(g.binding())), e => e instanceof ExecutionError && !e.attempted);
  assert.equal(g.calls.filter(c => c.method === 'thread/start').length, 1);
});
test('Codex interruption requires original native completed/interrupted receipt', async () => {
  const f = fixture('hold'), req = f.request(); const running = f.run(req);
  for (let n = 0; n < 50 && !f.calls.some(c => c.method === 'turn/start'); n++) await new Promise(r => setTimeout(r, 1));
  await new Promise(r => setTimeout(r, 1));
  assert.deepEqual(await f.adapter.cancelTurn({ clientRequestID: req.clientRequestID, source: req.source, binding: f.binding() }), { status: 'confirmed' });
  await running; assert.ok(f.events.some(e => e.type === 'settled' && e.outcome === 'cancelled'));
});
for (const mode of ['tool', 'disconnect', 'accountchange']) test(`Codex ${mode} blocks further turns and does not leak raw errors`, async () => {
  const f = fixture(mode); await assert.rejects(f.run(), e => e instanceof ExecutionError && e.attempted && !e.message.includes('private-fixture'));
  await assert.rejects(f.run(f.request(f.binding())));
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('Codex failed terminal event stays failed rather than success', async () => { const f = fixture('failed'); await f.run(); assert.ok(f.events.some(e => e.type === 'settled' && e.outcome === 'failed')); });
test('Codex disconnect waits for already delivered persistence callbacks', async () => {
  const f = fixture('hold'); let unblock!: () => void; const blocked = new Promise<void>(r => { unblock = r; }); let delivered = false, done = false;
  const run = f.run(f.request(), async event => { f.events.push(event); if (event.type === 'text-delta') { delivered = true; await blocked; } }).catch(() => {}).finally(() => { done = true; });
  for (let n = 0; n < 50 && !delivered; n++) await new Promise(r => setTimeout(r, 1));
  assert.ok(delivered); f.emit('screendeck/disconnected', {}); await new Promise(r => setTimeout(r, 10)); assert.equal(done, false); unblock(); await run;
});

test('native file approval with a truncated proposal cannot be allowed', async () => {
  const listeners = new Set<(event: CodexNotification) => void>();
  let handler: Parameters<NonNullable<CodexConnection['onServerRequest']>>[0] | undefined;
  const emit = (method: string, params: Record<string, unknown>) => { for (const fn of listeners) fn({ method, params }); };
  const connection: CodexConnection = {
    runtimeID: randomUUID(), connectionGeneration: randomUUID(), configDigest: 'b'.repeat(64), directory: '/fixture/workspace', model: { provider_id: 'openai', model_id: 'native' },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }, onServerRequest(fn) { handler = fn; return () => { handler = undefined; }; },
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread' }, cwd: '/fixture/workspace', model: 'native', modelProvider: 'openai', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeSlashTmp: true, excludeTmpdirEnvVar: true } };
      if (method === 'turn/start') {
        emit('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'file', type: 'fileChange', changes: [{ path: '/fixture/workspace/file', diff: 'x'.repeat(20000) }] } });
        setImmediate(() => { void handler?.('item/fileChange/requestApproval', { threadId: 'thread', turnId: 'turn', itemId: 'file' })?.then(result => { assert.deepEqual(result, { decision: 'decline' }); emit('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } }); }); });
        return { turn: { id: 'turn', status: 'inProgress' } };
      }
      throw Error('Unexpected method');
    },
  };
  const adapter = new CodexAgentChatAdapter({ getConnection: () => connection, nativeTools: true, turnTimeoutMs: 500 });
  const req: AgentChatRequest = { sessionID: randomUUID(), turnID: randomUUID(), clientRequestID: randomUUID(), source: { agentID: 'codex', configDigest: connection.configDigest }, model: connection.model, input: 'Fixture', execution: { mode: 'ask', workspace: { id: randomUUID(), path: connection.directory, label: 'workspace' } } };
  let binding: AgentChatBinding | undefined, seen = false;
  await adapter.sendTurn(req, async event => {
    if (event.type === 'bound') binding = event.binding;
    if (event.type === 'permission') { seen = true; assert.equal(event.approval.canAllow, false); const lookup = { clientRequestID: req.clientRequestID, source: req.source, binding }; assert.equal((await adapter.replyPermission(lookup, event.approval.id, 'allow')).status, 'unknown'); await adapter.replyPermission(lookup, event.approval.id, 'deny'); }
  }, new AbortController().signal);
  assert.ok(seen);
});

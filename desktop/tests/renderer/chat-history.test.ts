import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionRecord } from '../../src/shared/types.js';
import type { AgentSessionRecord } from '../../src/shared/agent-chat.js';
import { chatKey, orderedChats, searchChats } from '../../src/renderer/chat-history.js';

const id = '00000000-0000-0000-0000-000000000001';
const messageID = '00000000-0000-0000-0000-000000000002';
const ordinary: SessionRecord = { schema_version: 1, conversation_id: id, title: '模型草稿', revision: 1, scope: { kind: 'local_chat', local_chat_id: id }, created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z', turns: [], messages: [{ message_id: messageID, turn_id: id, role: 'assistant', text: '  Keep indent\n第二行：Needle is here\n末尾  ', created_at: '2026-10-18T00:00:00.000Z', updated_at: '2026-10-18T00:00:00.000Z' }] };
const { binding: _binding, ...ordinaryFields } = ordinary;
const agent: AgentSessionRecord = { ...ordinaryFields, kind: 'electron_agent_chat', title: '原生 Agent', source: { agentID: 'opencode', configDigest: 'a'.repeat(64) } };

test('history preferences qualify the same UUID by source and never mutate histories', () => {
  const originals = JSON.stringify([ordinary, agent]);
  const preferences = { revision: 1, entries: { [`agent:${id}`]: { archived: true as const } } };
  assert.notEqual(chatKey(ordinary), chatKey(agent));
  assert.deepEqual(orderedChats([ordinary, agent], preferences), [ordinary]);
  assert.deepEqual(orderedChats([ordinary, agent], preferences, true), [agent]);
  assert.equal(JSON.stringify([ordinary, agent]), originals);
});

test('pinned chats appear first without rewriting update timestamps; archived pins stay archived', () => {
  const newer = { ...ordinary, conversation_id: '00000000-0000-0000-0000-000000000003', updated_at: '2026-10-18T01:00:00.000Z' };
  const preferences = { revision: 2, entries: { [chatKey(ordinary)]: { pinned: true as const }, [chatKey(agent)]: { archived: true as const, pinned: true as const } } };
  assert.deepEqual(orderedChats([newer, ordinary, agent], preferences), [ordinary, newer]);
  assert.equal(ordinary.updated_at, '2026-10-18T00:00:00.000Z');
});

test('search trims queries, finds content and returns its exact message anchor and original snippet', () => {
  const results = searchChats([ordinary], { revision: 0, entries: {} }, '  nEeDlE  ', 'all', false);
  assert.equal(results.length, 1); assert.equal(results[0].messageID, messageID);
  assert.equal(results[0].snippet, ordinary.messages[0].text);
  assert.deepEqual(searchChats([ordinary], { revision: 0, entries: {} }, '  ', 'all', false), []);
});

test('search independently applies source and archive filters, including title-only hits', () => {
  const preferences = { revision: 1, entries: { [chatKey(agent)]: { archived: true as const } } };
  assert.equal(searchChats([ordinary, agent], preferences, 'needle', 'all', false).length, 1);
  assert.equal(searchChats([ordinary, agent], preferences, 'needle', 'all', true).length, 2);
  assert.equal(searchChats([ordinary, agent], preferences, 'needle', 'agent', false).length, 0);
  const results = searchChats([ordinary, agent], preferences, '原生', 'agent', true);
  assert.equal(results.length, 1); assert.equal(results[0].messageID, undefined); assert.equal(results[0].archived, true);
});

// Preferences do not cancel execution. A send racing a preference disk write
// must retain a visible route back to its Stop control.
test('an archived chat that becomes active remains in the recent list', () => {
  const running = { ...ordinary, turns: [{ turn_id: id, client_request_id: id, requested_model: { provider_id: 'fixture', model_id: 'fixture' }, state: 'streaming' as const, created_at: ordinary.created_at, updated_at: ordinary.updated_at, draft_revision: 0 }] };
  const preferences: import('../../src/shared/chat-management.js').ChatPreferences = { revision: 2, entries: { [chatKey(running)]: { archived: true as const } } };
  assert.deepEqual(orderedChats([running], preferences), [running]);
  const manyPins = Array.from({ length: 35 }, (_, i) => ({ ...ordinary, conversation_id: 'pinned-' + i }));
  for (const pinned of manyPins) preferences.entries[chatKey(pinned)] = { pinned: true };
  assert.equal(orderedChats([...manyPins, running], preferences)[0], running);
});

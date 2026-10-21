import assert from 'node:assert/strict';
import test from 'node:test';
import { listChatCompletionsModels } from '../../src/core/providers/chat-completions-models.js';
import { StorageError } from '../../src/core/storage/private-storage.js';

const credential = 'synthetic-provider-models-key';
const input = { baseURL: 'https://provider.example/v1', credential };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const mockFetch = (respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch =>
  (async (url, init) => respond(String(url), init)) as typeof fetch;
const failure = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof StorageError);
  assert.equal(error.code, code);
  assert.equal(String(error).includes(credential), false);
  assert.equal(String(error).includes('private-body-marker'), false);
  assert.equal('cause' in error, false);
  return true;
};
function streamed(chunks: Uint8Array[], onCancel?: () => void): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() { onCancel?.(); },
  }));
}

test('model listing sends one authenticated GET to the normalized endpoint and returns only ordered IDs', async () => {
  let calls = 0;
  const result = await listChatCompletionsModels({ ...input, baseURL: 'https://PROVIDER.example/v1///' }, {
    fetch: mockFetch((url, init) => {
      calls += 1;
      assert.equal(url, 'https://provider.example/v1/models');
      assert.equal(init?.method, 'GET');
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, 'manual');
      assert.ok(init?.signal instanceof AbortSignal);
      assert.deepEqual(new Headers(init?.headers).get('authorization'), `Bearer ${credential}`);
      assert.equal(new Headers(init?.headers).get('accept'), 'application/json');
      return json({ object: 'list', data: [
        { id: 'first-model', owned_by: 'fixture', tools: true, context_length: 999999 },
        { id: 'second-model', modalities: ['image'], metadata: { secret: credential } },
        { id: 'first-model' },
        { id: 'FIRST-model' },
      ] });
    }),
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: 'available', modelIDs: ['first-model', 'second-model', 'FIRST-model'] });
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test('an empty data list is available and the origin root is normalized without a double slash', async () => {
  assert.deepEqual(await listChatCompletionsModels({ ...input, baseURL: 'https://provider.example/' }, {
    fetch: mockFetch(url => { assert.equal(url, 'https://provider.example/models'); return json({ data: [] }); }),
  }), { kind: 'available', modelIDs: [] });
});

test('only unsupported endpoint statuses return unsupported and their bodies are cancelled', async () => {
  for (const status of [404, 405, 501]) {
    let calls = 0;
    let cancelled = 0;
    const result = await listChatCompletionsModels(input, { fetch: mockFetch(() => {
      calls += 1;
      return new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status });
    }) });
    assert.deepEqual(result, { kind: 'unsupported' });
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
});

test('HTTP errors and redirects are rejected without following a second destination or exposing the body', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 429, 500]) {
    let calls = 0;
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch((_url, init) => {
      calls += 1;
      assert.equal(init?.redirect, 'manual');
      return new Response(`${credential} private-body-marker`, { status, headers: { Location: `https://other.example/${credential}` } });
    }) }), error => {
      failure('provider-models-http')(error);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('other.example'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('invalid URLs, credentials and timeout options fail before any request', async () => {
  let calls = 0;
  const fetch = mockFetch(() => { calls += 1; return json({ data: [] }); });
  for (const baseURL of [
    'http://provider.example/v1', 'file:///tmp/provider', 'not-a-url',
    `https://user:${credential}@provider.example/v1`,
    `https://provider.example/v1?key=${credential}`, 'https://provider.example/v1?',
    'https://provider.example/v1#fragment', 'https://provider.example/v1#',
    'https://provider.example/line\nbreak', 'https://provider.example/v1 trailing',
    `https://provider.example/${'x'.repeat(2048)}`,
  ]) await assert.rejects(listChatCompletionsModels({ baseURL, credential }, { fetch }), failure('provider-models-configuration'));
  for (const key of ['', '  ', `line\n${credential}`, `null\0${credential}`, `tab\t${credential}`, 'x'.repeat(8193)]) {
    await assert.rejects(listChatCompletionsModels({ ...input, credential: key }, { fetch }), failure('provider-models-configuration'));
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 600_001]) {
    await assert.rejects(listChatCompletionsModels(input, { fetch, timeoutMs }), failure('provider-models-configuration'));
  }
  assert.equal(calls, 0);
});

test('unsupported JSON shapes are rejected rather than guessing another provider schema', async () => {
  for (const value of [null, [], false, {}, { models: ['model'] }, { data: null }, { data: 'model' }, { data: [null] }, { data: ['model'] }, { data: [[]] }, { data: [{}] }, { data: [{ id: 123 }] }]) {
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => json(value)) }), failure('provider-models-protocol'));
  }
});

test('invalid, oversized and credential-echoing IDs never cross the result boundary', async () => {
  for (const id of ['', ' ', 'line\nbreak', 'null\0byte', 'tab\tbyte', 'delete\x7fbyte', 'control\u0085byte', 'x'.repeat(201), '界'.repeat(67), credential, `echo-${credential}-suffix`]) {
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => json({ data: [{ id }] })) }), failure('provider-models-protocol'));
  }
});

test('the ID byte limit and thousand-model limit accept their exact boundary', async () => {
  const id = 'é'.repeat(100);
  assert.equal(Buffer.byteLength(id), 200);
  const ids = [id, ...Array.from({ length: 999 }, (_unused, index) => `fixture-${index}`)];
  assert.deepEqual(await listChatCompletionsModels(input, { fetch: mockFetch(() => json({ data: ids.map(id => ({ id })) })) }), {
    kind: 'available', modelIDs: ids,
  });
  for (const ids of [Array.from({ length: 1001 }, (_unused, index) => `fixture-${index}`), Array<string>(1001).fill('duplicate')]) {
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => json({ data: ids.map(id => ({ id })) })) }), failure('provider-models-too-large'));
  }
});

test('split UTF-8 JSON is decoded without damaging opaque model IDs', async () => {
  const bytes = Buffer.from(JSON.stringify({ data: [{ id: '合成模型-é' }] }));
  const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
  assert.deepEqual(await listChatCompletionsModels(input, { fetch: mockFetch(() => streamed(chunks)) }), {
    kind: 'available', modelIDs: ['合成模型-é'],
  });
});

test('the streaming response byte limit accepts exactly one MiB and rejects an extra byte', async () => {
  const content = Buffer.from(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  const body = Buffer.concat([content, Buffer.alloc(1024 * 1024 - content.length, 0x20)]);
  assert.deepEqual(await listChatCompletionsModels(input, { fetch: mockFetch(() => streamed([body])) }), {
    kind: 'available', modelIDs: ['fixture-model'],
  });
  for (const chunks of [[Buffer.concat([body, Buffer.from(' ')])], [body.subarray(0, 500_000), body.subarray(500_000), Buffer.from(' ')]]) {
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => streamed(chunks)) }), failure('provider-models-too-large'));
  }
});

test('invalid JSON, incomplete UTF-8 and missing success bodies produce safe protocol errors', async () => {
  for (const response of [
    new Response(`{"private-body-marker":"${credential}"`),
    streamed([Uint8Array.of(0x7b, 0x22, 0xc3)]),
    new Response(null, { status: 204 }),
  ]) await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => response) }), failure('provider-models-protocol'));
});

test('fetch and body exceptions are sanitized even if an injected exception is a StorageError', async () => {
  for (const error of [new Error(`${credential} private-body-marker`), new StorageError('untrusted', credential)]) {
    let calls = 0;
    await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => { calls += 1; throw error; }) }), failure('provider-models-network'));
    assert.equal(calls, 1);
  }
  await assert.rejects(listChatCompletionsModels(input, { fetch: mockFetch(() => new Response(new ReadableStream({
    start(controller) { controller.error(new Error(`${credential} private-body-marker`)); },
  }))) }), failure('provider-models-network'));
});

test('the deadline bounds a fetch that ignores abort and sends no retry', async () => {
  let calls = 0;
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(listChatCompletionsModels(input, {
    timeoutMs: 20,
    fetch: mockFetch((_url, init) => {
      calls += 1;
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
  }), failure('provider-models-timeout'));
  assert.equal(calls, 1);
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test('the same deadline bounds a stalled response body and does not await a hanging cancel', async () => {
  let cancelled = 0;
  let signal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(listChatCompletionsModels(input, {
    timeoutMs: 20,
    fetch: mockFetch((_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from('{"data":[')); },
        cancel() { cancelled += 1; return new Promise<void>(() => {}); },
      }));
    }),
  }), failure('provider-models-timeout'));
  assert.equal(cancelled, 1);
  assert.equal(signal?.aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test('a response arriving after timeout is cancelled and cannot become a successful result', async () => {
  let resolve!: (response: Response) => void;
  let cancelled = 0;
  const pending = listChatCompletionsModels(input, {
    timeoutMs: 20,
    fetch: mockFetch(() => new Promise<Response>(done => { resolve = done; })),
  });
  await assert.rejects(pending, failure('provider-models-timeout'));
  const response = new Response(new ReadableStream({ cancel() { cancelled += 1; } }));
  resolve(response);
  await new Promise<void>(done => setImmediate(done));
  assert.equal(cancelled, 1);
  assert.equal(response.body?.locked, false);
});

test('credential echo detection remains bound to the credential actually sent', async () => {
  const mutable = { ...input };
  let resolve!: (response: Response) => void;
  const pending = listChatCompletionsModels(mutable, { fetch: mockFetch(() => new Promise<Response>(done => { resolve = done; })) });
  mutable.credential = 'different-fixture-key';
  resolve(json({ data: [{ id: `echo-${credential}` }] }));
  await assert.rejects(pending, failure('provider-models-protocol'));
});

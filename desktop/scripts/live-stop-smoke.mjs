import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';

if (process.env.SCREENDECK_LIVE_SMOKE !== '1') throw new Error('This test makes one authorized live request. Set SCREENDECK_LIVE_SMOKE=1 explicitly.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const options = { ...(env.SCREENDECK_APP_EXECUTABLE ? { executablePath: env.SCREENDECK_APP_EXECUTABLE } : {}), args: env.SCREENDECK_APP_EXECUTABLE ? [] : [process.cwd()], env };
let application;
try {
  application = await electron.launch(options);
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
  const result = await page.evaluate(async () => {
    const api = window.screendeck;
    const session = await api.createSession({ title: '流式停止与恢复测试' });
    const id = session.conversation_id;
    let stopPromise;
    let partialLength = 0;
    const unsubscribe = api.subscribe(event => {
      if (event.type !== 'session-updated' || event.session.conversation_id !== id) return;
      const turn = event.session.turns.at(-1);
      if (turn?.state === 'streaming' && !stopPromise) {
        partialLength = event.session.messages.at(-1)?.text.length ?? 0;
        stopPromise = api.stopGeneration(id);
      }
    });
    try {
      const sent = await api.sendMessage({ sessionID: id, text: '这是流式停止功能测试。请按行列出从1到200的数字，每行写“这是第N行测试文本”。不要调用工具或访问文件。' });
      if (stopPromise) await stopPromise;
      return { id, partialLength, state: sent.session.turns.at(-1)?.state, requested: !!stopPromise, failure: sent.session.turns.at(-1)?.failure };
    } finally { unsubscribe(); }
  });
  assert.equal(result.requested, true, 'The stop must follow a real text delta.');
  assert.ok(result.partialLength > 0);
  assert.equal(result.state, 'cancelled');
  await application.close(); application = undefined;
  application = await electron.launch(options);
  const restarted = await application.firstWindow();
  await expect(restarted.getByRole('heading', { name: '今天想推进什么？' })).toBeVisible();
  const recovered = await restarted.evaluate(id => window.screendeck.loadSession(id), result.id);
  assert.equal(recovered.turns.at(-1).state, 'cancelled');
  assert.ok(recovered.messages.at(-1).text.length >= result.partialLength);
  console.log(JSON.stringify({ realStreamingStop: 'passed', restart: 'cancelled-with-partial-reply', sessionID: result.id, partialCharacters: recovered.messages.at(-1).text.length, remoteStop: 'unknown' }));
} finally { await application?.close(); }

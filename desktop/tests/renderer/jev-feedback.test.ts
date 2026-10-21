import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_JEV_MODEL, isJevModelID, jevFeedback } from '../../src/renderer/tasks/jev-feedback.js';
test('official default model accepts pinned alternatives and rejects URLs or whitespace', () => {
  assert.equal(DEFAULT_JEV_MODEL,'jev-latest');
  for (const id of ['jev-latest','jev-1.13.0','jev-preview']) assert.equal(isJevModelID(id),true);
  for (const id of ['','secret key','https://api.typesafe.ai','other-model']) assert.equal(isJevModelID(id),false);
});
test('authentication and model rejection lead to settings; unknown delivery requires a fresh preview', () => {
  assert.equal(jevFeedback(new Error("Error invoking remote method 'jev-recommend': Error: Jev：authentication")).action,'settings');
  assert.match(jevFeedback(new Error('Jev：request-rejected')).message,/模型/);
  for (const code of ['timeout','network','cancelled']) { const state=jevFeedback(new Error('Jev：'+code)); assert.equal(state.uncertain,true); assert.match(state.message,/计费/); assert.equal(state.action,'preview'); }
  assert.equal(jevFeedback(new Error('Jev：rate-limited')).action,'wait');
});
test('raw provider messages and credentials never become UI error text', () => {
  const secret='synthetic-only-secret';
  for (const value of [new Error(secret),new Error('Jev：authentication '+secret),new Error('Jev：request-rejected '+secret)]) assert.ok(!jevFeedback(value).message.includes(secret));
});

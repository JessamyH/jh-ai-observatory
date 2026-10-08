import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels, generateInsights, DEFAULT_MODEL, FALLBACK_MODELS } from '../web/insights.js';

const reply = (status, body) => async (url, init) => {
  reply.last = { url, init };
  return { ok: status < 400, status, json: async () => body };
};

test('listModels keeps Claude models, uses display names, and sends the key header', async () => {
  const request = reply(200, { data: [
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-4-5' },
    { id: 'not-a-claude-model', display_name: 'Other' },
  ] });
  const models = await listModels(' sk-test ', request);
  assert.deepEqual(models, [
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
  ]);
  assert.match(reply.last.url, /\/v1\/models/);
  assert.equal(reply.last.init.headers['x-api-key'], 'sk-test');
});

test('listModels errors redact the key', async () => {
  const request = reply(401, { error: { message: 'invalid x-api-key sk-secret' } });
  await assert.rejects(listModels('sk-secret', request), (err) => !err.message.includes('sk-secret') && err.message.includes('[redacted]'));
});

test('listModels requires a key before calling the API', async () => {
  let called = false;
  await assert.rejects(listModels('  ', async () => { called = true; }));
  assert.equal(called, false);
});

test('the default model is one of the fallback options', () => {
  assert.ok(FALLBACK_MODELS.some((m) => m.id === DEFAULT_MODEL));
});

test('generateInsights sends the chosen model', async () => {
  const request = reply(200, { content: [{ type: 'text', text: '{}' }] });
  await generateInsights({ apiKey: 'sk-test', model: 'claude-opus-5-5', summary: { totals: {} } }, request);
  assert.equal(JSON.parse(reply.last.init.body).model, 'claude-opus-5-5');
});

// Shared fixtures for the test suite.

import { makeRecord } from '../src/core/schema.js';

/** A turn from a CLI/API source: real token counts, real model. */
export function measuredTurn({
  id = 'x',
  ts = '2026-08-30T02:00:00.000Z',
  source = 'claude-code',
  model = 'claude-sonnet-5',
  session = 's1',
  project = 'demo',
  input = 100,
  output = 50,
  cacheRead = 0,
  cacheWrite = 0,
  cost = 0.001,
} = {}) {
  return makeRecord({
    id: `${source}:${id}`,
    source,
    timestamp: ts,
    model,
    modelMeasured: true,
    session,
    tokens: { input, output, cacheRead, cacheWrite },
    tokenAvailability: 'measured',
    cost: { amount: cost, currency: 'USD', estimated: false },
    measured: true,
    meta: { project },
  });
}

/** A generic record with unavailable token usage. */
export function unavailableTurn({
  id = 'w',
  ts = '2026-08-30T02:00:00.000Z',
  source = 'unavailable-source',
  session = 'c1',
  title = 'Some chat',
} = {}) {
  return makeRecord({
    id: `${source}:${id}`,
    source,
    timestamp: ts,
    model: 'unknown',
    modelMeasured: false,
    session,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokenAvailability: 'unavailable',
    cost: { amount: null, currency: 'USD', estimated: false },
    measured: false,
    meta: { title, visibleAssistantChars: 400 },
  });
}

/** Build a Codex rollout JSONL body from cumulative token counters. */
export function codexRollout({ sessionId = '01a0505a-5998-74e1-a417-19755f9950eb', model = 'gpt-5-codex', events = [] }) {
  const lines = [
    JSON.stringify({
      timestamp: '2026-08-30T01:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { session_id: sessionId, cwd: 'E:\\side-project\\demo', model, cli_version: '0.1.0' },
    }),
  ];
  events.forEach((e, i) => {
    const info = {
      total_token_usage: {
        input_tokens: e.input,
        cached_input_tokens: e.cached || 0,
        cache_write_input_tokens: e.cacheWrite || 0,
        output_tokens: e.output || 0,
      },
    };
    if (e.last) {
      info.last_token_usage = {
        input_tokens: e.last.input,
        cached_input_tokens: e.last.cached || 0,
        cache_write_input_tokens: e.last.cacheWrite || 0,
        output_tokens: e.last.output || 0,
      };
    }
    lines.push(
      JSON.stringify({
        timestamp: `2026-08-30T01:0${i + 1}:00.000Z`,
        ordinal: i + 1,
        type: 'event_msg',
        payload: { type: 'token_count', info },
      })
    );
  });
  return lines.join('\n') + '\n';
}

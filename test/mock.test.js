import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMockRecords, MOCK_ROOT } from '../src/mock.js';
import { Pricing } from '../src/core/pricing.js';
import { validateRecord } from '../src/core/schema.js';
import { scopeRecords } from '../src/core/scope.js';

const now = new Date(2026, 8, 29, 12);
const make = (seed = 42) => generateMockRecords({ pricing: new Pricing(), now, seed });

test('mock data is deterministic for a seed', () => {
  assert.deepEqual(make(), make());
  assert.notDeepEqual(make(1), make(2));
});

test('mock records are valid, priced, unique, and inside the mock root', () => {
  const records = make();
  assert.ok(records.length > 500);
  assert.equal(new Set(records.map((r) => r.id)).size, records.length);
  for (const r of records) {
    assert.deepEqual(validateRecord(r), []);
    assert.ok(r.cost.amount > 0, `${r.model} is priced`);
    assert.ok(new Date(r.timestamp) <= new Date(2026, 8, 30), 'no future turns');
  }
  assert.equal(scopeRecords(records, [MOCK_ROOT]).length, records.length);
});

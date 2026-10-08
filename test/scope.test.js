import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scopeRecords } from '../src/core/scope.js';
import { summarize, facets } from '../src/core/aggregate.js';
import { measuredTurn } from './helpers.js';

test('selected directories scope totals and facets without deleting or modifying history', () => {
  const root = path.resolve('scope-fixture');
  const make = (id, cwd) => ({ ...measuredTurn({ id }), meta: { cwd, project: 'old-name' } });
  const records = [
    make('a', path.join(root, 'personal', 'alpha', 'src')),
    make('b', path.join(root, 'work', 'beta')),
    make('c', path.join(root, 'personal-other', 'gamma')),
    make('d', null),
    make('e', path.join(root, 'personal')),
  ];
  const before = JSON.stringify(records);
  const selected = scopeRecords(records, [path.join(root, 'personal')]);
  assert.deepEqual(selected.map((r) => r.id), ['claude-code:a']);
  assert.equal(summarize(selected).totals.turns, 1);
  assert.deepEqual(facets(selected).projects, ['alpha']);
  assert.equal(JSON.stringify(records), before);
  const both = scopeRecords(records, [path.join(root, 'personal'), path.join(root, 'work')]);
  assert.deepEqual(facets(both).projects, ['alpha', 'beta']);
  assert.equal(scopeRecords(records, []).length, 0);
  assert.equal(scopeRecords(records, [path.join(root, 'missing')]).length, 0);
});

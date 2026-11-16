import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathSettings, resolveConfigRoots } from '../src/settings.js';
import { trackedProject } from '../src/core/util.js';

test('multiple path selections persist, normalize and preserve other settings; invalid paths do not write', async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), 'obs-settings-'));
  try {
    await mkdir(path.join(baseDir, 'first'));
    await mkdir(path.join(baseDir, 'second'));
    const configPath = path.join(baseDir, 'config.json');
    const config = { server: { port: 5858 }, display: { currency: 'AUD' }, projectRoots: [] };
    await writeFile(configPath, JSON.stringify(config));
    const settings = pathSettings({ config, configPath, baseDir });
    const result = await settings.save({ projectRoots: ['first', 'second', './first'], availableRoots: ['first', 'second'] });
    assert.deepEqual(result.projectRoots, ['first', 'second'].map((p) => path.join(baseDir, p)));
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(disk.server, { port: 5858 });
    assert.deepEqual(disk.display, { currency: 'AUD' });
    assert.deepEqual(config.projectRoots, disk.projectRoots);
    await settings.save({ projectRoots: ['second'], availableRoots: ['first', 'second'] });
    assert.equal(settings.get().availableRoots.length, 2);
    assert.equal(settings.get().projectRoots.length, 1);
    const before = await readFile(configPath, 'utf8');
    await assert.rejects(settings.save({ projectRoots: ['missing'], availableRoots: ['missing'] }), /Directory not found/);
    await assert.rejects(settings.save({ projectRoots: [], availableRoots: [] }), /at least one/);
    await assert.rejects(settings.save({ projectRoots: ['first'], availableRoots: ['second'] }), /belong/);
    assert.equal(await readFile(configPath, 'utf8'), before);
  } finally { await rm(baseDir, { recursive: true, force: true }); }
});

test('hand-edited ~ and relative projectRoots in config.json resolve and match projects', () => {
  const home = os.homedir();
  const baseDir = path.join(home, 'obs-config-dir');
  const config = {
    projectRoots: ['~/Developer', '~/Developer', 'work', ' ', 42],
    availableProjectRoots: ['~/Developer', '/abs/other'],
    server: { port: 5858 },
  };
  const out = resolveConfigRoots(config, baseDir);
  assert.equal(out, config);
  assert.deepEqual(config.projectRoots, [path.join(home, 'Developer'), path.join(baseDir, 'work')]);
  assert.deepEqual(config.availableProjectRoots, [path.join(home, 'Developer'), '/abs/other']);
  assert.deepEqual(config.server, { port: 5858 });
  // Before the fix a literal "~/Developer" root matched nothing.
  assert.equal(trackedProject(path.join(home, 'Developer', 'my-app', 'src'), config.projectRoots), 'my-app');
  // A config without the keys, or with an empty list, is left as-is.
  assert.deepEqual(resolveConfigRoots({ projectRoots: [] }, baseDir), { projectRoots: [] });
  assert.deepEqual(resolveConfigRoots({}, baseDir), {});
});

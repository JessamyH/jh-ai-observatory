// Claude Code source.
//
// Claude Code writes one JSONL file per session under ~/.claude/projects/<slug>/.
// Every assistant turn carries a real `message.usage` block from the API, so this
// source is fully MEASURED - the numbers here are as accurate as the provider's.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { makeRecord } from '../core/schema.js';
import { resolvePath, walkFiles, isDirectory, partitionChangedFiles, trackedProject } from '../core/util.js';

export const name = 'claude-code';

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export async function collect(ctx) {
  const { sourceConfig = {}, baseDir, pricing, projectRoots = [], cache, log } = ctx;
  const warnings = [];
  const dir = sourceConfig.projectsDir
    ? resolvePath(sourceConfig.projectsDir, baseDir)
    : defaultProjectsDir();

  if (!(await isDirectory(dir))) {
    warnings.push(`claude-code: projects dir not found: ${dir}`);
    return { records: [], warnings };
  }

  const all = await walkFiles(dir, (f) => f.endsWith('.jsonl'));
  const { changed: files, skipped } = await partitionChangedFiles(all, cache);
  log?.(
    `claude-code: ${files.length} of ${all.length} transcript file(s) changed in ${dir}` +
      (skipped ? ` (${skipped} unchanged)` : '')
  );

  const records = [];
  const seen = new Set();
  let lines = 0;
  let assistantTurns = 0;
  let skippedSynthetic = 0;

  for (const file of files) {
    for await (const rec of parseFile(file, pricing, seen, warnings, projectRoots)) {
      lines++;
      if (rec === 'synthetic') {
        skippedSynthetic++;
        continue;
      }
      if (rec) {
        assistantTurns++;
        records.push(rec);
      }
    }
  }

  log?.(
    `claude-code: ${assistantTurns} assistant turns (${skippedSynthetic} synthetic skipped) from ${files.length} files`
  );
  return { records, warnings, skipped };
}

async function* parseFile(file, pricing, seen, warnings, projectRoots) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const projectSlug = path.basename(path.dirname(file));

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partial write / non-JSON line
    }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;

    const msg = obj.message;
    const model = msg.model || 'unknown';
    if (model === '<synthetic>') {
      yield 'synthetic';
      continue;
    }

    const tracked = trackedProject(obj.cwd, projectRoots);
    if (projectRoots.length && !tracked) continue;

    const nativeId = msg.id || obj.uuid;
    if (!nativeId) continue;
    const id = `${name}:${nativeId}`;
    if (seen.has(id)) continue; // same turn replayed into a resumed session
    seen.add(id);

    const u = msg.usage;
    const cacheWrite = num(u.cache_creation_input_tokens);
    const cw5m = u.cache_creation ? num(u.cache_creation.ephemeral_5m_input_tokens) : null;
    const cw1h = u.cache_creation ? num(u.cache_creation.ephemeral_1h_input_tokens) : null;

    const tokens = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite,
    };

    const cost = pricing.cost(model, {
      ...tokens,
      cacheWrite5m: cw5m,
      cacheWrite1h: cw1h,
    });
    if (cost.amount == null) {
      warnings.push(`claude-code: no price for model "${model}" (cost left blank)`);
    }

    yield makeRecord({
      id,
      source: name,
      timestamp: obj.timestamp || new Date().toISOString(),
      model,
      modelMeasured: true,
      session: obj.sessionId || projectSlug,
      tokens,
      tokenAvailability: 'measured',
      cost: { amount: cost.amount, currency: 'USD', estimated: false },
      measured: true,
      meta: {
        project: tracked || shortProject(obj.cwd, projectSlug),
        cwd: obj.cwd || null,
        gitBranch: obj.gitBranch || null,
        appVersion: obj.version || null,
        thinkingTokens: u.output_tokens_details ? num(u.output_tokens_details.thinking_tokens) : 0,
        serviceTier: u.service_tier || null,
        requestId: obj.requestId || null,
      },
    });
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function shortProject(cwd, slug) {
  if (cwd) {
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return slug;
}

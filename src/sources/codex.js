// Codex CLI / IDE source (OpenAI's coding agent).
//
// Codex writes one "rollout" JSONL per session under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (default ~/.codex).
// Each turn ends with an `event_msg` of type `token_count` carrying a real
// `total_token_usage` (cumulative) and `last_token_usage`. That makes Codex a
// **measured** source, like Claude Code.
//
// Per-turn usage is derived as the delta of the cumulative `total_token_usage`
// between consecutive token_count events — robust whether Codex emits one event
// per turn or several.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { makeRecord } from '../core/schema.js';
import { resolvePath, walkFiles, isDirectory, partitionChangedFiles, trackedProject } from '../core/util.js';

export const name = 'codex';

function defaultSessionsDir() {
  const home = process.env.CODEX_HOME
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
  return path.join(home, 'sessions');
}

export async function collect(ctx) {
  const { sourceConfig = {}, baseDir, pricing, projectRoots = [], cache, log } = ctx;
  const warnings = [];
  const dir = sourceConfig.sessionsDir
    ? resolvePath(sourceConfig.sessionsDir, baseDir)
    : defaultSessionsDir();

  if (!(await isDirectory(dir))) {
    warnings.push(`codex: sessions dir not found: ${dir}`);
    return { records: [], warnings };
  }

  const all = await walkFiles(dir, (f) => f.endsWith('.jsonl') && path.basename(f).startsWith('rollout-'));
  const { changed: files, skipped } = await partitionChangedFiles(all, cache);
  log?.(
    `codex: ${files.length} of ${all.length} rollout file(s) changed in ${dir}` +
      (skipped ? ` (${skipped} unchanged)` : '')
  );

  const records = [];
  let turns = 0;
  for (const file of files) {
    for await (const rec of parseRollout(file, pricing, warnings, projectRoots)) {
      turns++;
      records.push(rec);
    }
  }
  log?.(`codex: ${turns} billed turn(s) from ${files.length} sessions`);
  // The sessions directory existed and every rollout was considered. This lets
  // an explicit --prune remove old records even when the configured project
  // roots intentionally filter the current result down to zero.
  return { records, warnings, skipped, authoritative: true };
}

async function* parseRollout(file, pricing, warnings, projectRoots) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  let sessionId = path.basename(file).replace(/^rollout-.*?-([0-9a-f-]{36})\.jsonl$/i, '$1');
  let cwd = null;
  let activityCwd = null;
  let model = 'unknown';
  let cliVersion = null;
  const prev = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  let sawUsage = false;
  let usageEventIndex = 0; // stable within a file — never random, so re-ingest is idempotent
  let resetWarned = false;

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    const p = obj.payload || {};

    // Codex sessions can be opened at a workspace container while individual
    // commands run in a real child project. Prefer that concrete workdir for
    // the following usage event, so the container itself never becomes a
    // project and the turn is not discarded.
    const toolCwd = workdirFromEvent(obj.type, p);
    if (toolCwd) activityCwd = toolCwd;

    if (obj.type === 'session_meta') {
      sessionId = p.session_id || p.id || sessionId;
      cwd = p.cwd || cwd;
      model = p.model || (p.base_instructions && p.base_instructions.provenance && p.base_instructions.provenance.model) || model;
      cliVersion = p.cli_version || cliVersion;
      continue;
    }

    if (obj.type === 'turn_context') {
      if (p.model) model = p.model;
      if (p.cwd) cwd = p.cwd;
      continue;
    }

    if (obj.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = p.info.total_token_usage || p.info.last_token_usage;
      if (!total) continue;
      // Mark before the project filter: an untracked session has usage, it's just not ours.
      sawUsage = true;
      const tracked = trackedProject(activityCwd || cwd, projectRoots);
      if (projectRoots.length && !tracked) continue;
      usageEventIndex += 1;

      const cur = {
        input: n(total.input_tokens),
        cached: n(total.cached_input_tokens),
        cacheWrite: n(total.cache_write_input_tokens),
        output: n(total.output_tokens),
      };

      // The counter is cumulative per session, but compaction / restart can reset
      // it. A plain max(0, cur - prev) would silently drop that whole turn, so
      // detect the reset and fall back to the provider's own per-turn figure.
      const counterReset =
        cur.input < prev.input ||
        cur.cached < prev.cached ||
        cur.cacheWrite < prev.cacheWrite ||
        cur.output < prev.output;

      let delta;
      if (counterReset) {
        const last = p.info.last_token_usage;
        delta = last
          ? {
              input: n(last.input_tokens),
              cached: n(last.cached_input_tokens),
              cacheWrite: n(last.cache_write_input_tokens),
              output: n(last.output_tokens),
            }
          : { ...cur }; // no per-turn figure — treat the new counter as this turn
        if (!resetWarned) {
          warnings.push(`codex: cumulative token counter reset detected in session ${sessionId}`);
          resetWarned = true;
        }
      } else {
        delta = {
          input: cur.input - prev.input,
          cached: cur.cached - prev.cached,
          cacheWrite: cur.cacheWrite - prev.cacheWrite,
          output: cur.output - prev.output,
        };
      }

      Object.assign(prev, cur);
      if (delta.input + delta.cached + delta.output + delta.cacheWrite === 0) continue;

      // `input_tokens` includes the cached portion; split it out for pricing.
      const uncachedInput = Math.max(0, delta.input - delta.cached);
      const tokens = {
        input: uncachedInput,
        output: delta.output,
        cacheRead: delta.cached,
        cacheWrite: delta.cacheWrite,
      };
      const cost = pricing.cost(model, tokens);
      if (cost.amount == null) {
        warnings.push(`codex: no price for model "${model}" (cost left blank — add it to config.pricingOverrides)`);
      }

      const eventKey = obj.ordinal != null ? `ordinal-${obj.ordinal}` : `usage-${usageEventIndex}`;
      yield makeRecord({
        id: `${name}:${sessionId}:${eventKey}`,
        source: name,
        timestamp: obj.timestamp || new Date().toISOString(),
        model,
        modelMeasured: model !== 'unknown',
        session: sessionId,
        tokens,
        tokenAvailability: 'measured',
        cost: { amount: cost.amount, currency: 'USD', estimated: false },
        measured: true,
        meta: {
          project: tracked || shortProject(cwd),
          cwd: activityCwd || cwd,
          cliVersion,
          reasoningTokens: n((p.info.last_token_usage || {}).reasoning_output_tokens),
          ...(counterReset ? { counterReset: true } : {}),
        },
      });
    }
  }

  if (!sawUsage) warnings.push(`codex: no token_count events in ${path.basename(file)} (older Codex build?)`);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
}

function shortProject(cwd) {
  if (!cwd) return '(unknown)';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function workdirFromEvent(type, payload) {
  let value = null;
  if (type === 'event_msg' && payload.type === 'item_completed') {
    value = payload.item && payload.item.cwd;
  } else if (type === 'response_item' && payload.type === 'custom_tool_call' && typeof payload.input === 'string') {
    const match = payload.input.match(/["']workdir["']\s*:\s*["']([^"']+)["']/i);
    value = match && match[1];
  }
  if (!value) return null;
  const s = String(value).replace(/\\\\/g, '\\');
  if (/^file:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
    } catch {
      return null;
    }
  }
  return s;
}

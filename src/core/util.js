// Small shared helpers. No dependencies.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/** Resolve a path that may be absolute, relative to `baseDir`, or start with `~`. */
export function resolvePath(p, baseDir) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

/**
 * Return the first folder below a configured tracking root. The root itself is
 * only a container, never a project; paths outside every root return null.
 */
export function trackedProject(cwd, roots = []) {
  if (!cwd || !Array.isArray(roots) || roots.length === 0) return null;
  const target = path.resolve(String(cwd));
  const targetKey = path.normalize(target).toLowerCase();

  for (const root of roots) {
    const resolvedRoot = path.resolve(String(root));
    const rootKey = path.normalize(resolvedRoot).toLowerCase();
    const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
    if (!targetKey.startsWith(prefix)) continue;

    const first = path.relative(resolvedRoot, target).split(path.sep).filter(Boolean)[0];
    if (first && first !== '..') return first;
  }
  return null;
}

/** Recursively list files under `dir` matching `predicate(fullPath)`. Missing dir => []. */
export async function walkFiles(dir, predicate) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, predicate)));
    } else if (entry.isFile() && (!predicate || predicate(full))) {
      out.push(full);
    }
  }
  return out;
}

export async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Split `files` into the ones a source still needs to parse and the ones whose
 * records are already in the store, using a { mtimeMs, size } fingerprint.
 *
 * `cache` is the object handed to sources as `ctx.cache`; when it is null (a
 * forced full re-scan) every file is returned as changed.
 *
 * @returns {Promise<{changed: string[], skipped: number}>}
 */
export async function partitionChangedFiles(files, cache) {
  if (!cache) return { changed: files, skipped: 0 };
  const changed = [];
  let skipped = 0;
  for (const f of files) {
    let st;
    try {
      st = await stat(f);
    } catch {
      continue; // vanished between listing and stat
    }
    const fp = { mtimeMs: Math.round(st.mtimeMs), size: st.size };
    if (cache.unchanged(f, fp)) {
      skipped++;
      cache.keep(f);
      continue;
    }
    changed.push(f);
    cache.note(f, fp);
  }
  return { changed, skipped };
}

/** Rough token estimate from a string. Used only for sources that ship no real counts. */
export function estimateTokens(text, charsPerToken = 4) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / Math.max(1, charsPerToken)));
}

/** ISO string -> Date, tolerant of epoch seconds / ms numbers. Returns null if unparseable. */
export function toDate(value) {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value === 'number') {
    // Heuristic: < 10^12 => seconds, else ms.
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

export function round(n, dp = 6) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function sum(arr, pick = (x) => x) {
  return arr.reduce((acc, x) => acc + (pick(x) || 0), 0);
}

/** Group array items by a string key. */
export function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

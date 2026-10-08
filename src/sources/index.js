// Source registry. Adding a platform = drop a module in this folder and register
// it here. Each source exports:
//
//   export const name = "my-platform";
//   export async function collect(ctx) => { records: UsageRecord[], warnings: string[] }
//
// ctx = { sourceConfig, baseDir, pricing, log }

import * as claudeCode from './claude-code.js';
import * as codex from './codex.js';

const REGISTRY = [claudeCode, codex];

export function allSources() {
  return REGISTRY.map((m) => m.name);
}

export function getSource(name) {
  return REGISTRY.find((m) => m.name === name) || null;
}

/** Sources enabled in config, optionally narrowed to `only`. */
export function enabledSources(config, only = null) {
  return REGISTRY.filter((m) => {
    const sc = (config.sources && config.sources[m.name]) || {};
    if (only && m.name !== only) return false;
    return sc.enabled !== false;
  });
}

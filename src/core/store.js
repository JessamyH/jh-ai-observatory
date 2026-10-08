// Canonical store: a single JSON file of deduped UsageRecords.
//
// A flat JSON file is deliberate for v1 - it is easy to inspect, diff, back up,
// and trust. The read/write surface here is small so a future swap to SQLite or
// Parquet only touches this file.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { STORE_VERSION, validateRecord } from './schema.js';

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = [];
    this.byId = new Map();
    this.generatedAt = null;
    // Per-source-file { mtimeMs, size } of everything already parsed. Lives in
    // the store itself so the two can never drift: delete the store and the
    // incremental cache resets with it.
    this.fileCache = {};
    this.projectRoots = null;
    this.pricingKey = null;
  }

  async load() {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.projectRoots = parsed.projectRoots || null;
      this.pricingKey = parsed.pricingKey || null;
      // Retired website imports must not appear in CLI usage statistics.
      this.records = Array.isArray(parsed.records)
        ? parsed.records.filter((r) => !['chatgpt', 'claude-web'].includes(r.source))
        : [];
      this.generatedAt = parsed.generatedAt || null;
      this.fileCache = parsed.fileCache && typeof parsed.fileCache === 'object' ? parsed.fileCache : {};
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.records = [];
      this.fileCache = {};
    }
    this.byId = new Map(this.records.map((r) => [r.id, r]));
    return this;
  }

  /**
   * Merge incoming records. Existing ids are replaced (re-ingest picks up
   * corrected prices). Returns { added, updated, skipped, invalid }.
   */
  merge(incoming) {
    let added = 0;
    let updated = 0;
    let invalid = 0;
    for (const rec of incoming) {
      const problems = validateRecord(rec);
      if (problems.length) {
        invalid++;
        continue;
      }
      if (this.byId.has(rec.id)) {
        const idx = this.records.indexOf(this.byId.get(rec.id));
        this.records[idx] = rec;
        this.byId.set(rec.id, rec);
        updated++;
      } else {
        this.records.push(rec);
        this.byId.set(rec.id, rec);
        added++;
      }
    }
    return { added, updated, invalid, total: this.records.length };
  }

  /** Drop every record matching `predicate`. Returns how many were removed. */
  prune(predicate) {
    const before = this.records.length;
    this.records = this.records.filter((r) => {
      if (!predicate(r)) return true;
      this.byId.delete(r.id);
      return false;
    });
    return before - this.records.length;
  }

  async save() {
    this.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    this.generatedAt = new Date().toISOString();
    const payload = {
      version: STORE_VERSION,
      generatedAt: this.generatedAt,
      count: this.records.length,
      fileCache: this.fileCache,
      projectRoots: this.projectRoots,
      pricingKey: this.pricingKey,
      records: this.records,
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, this.filePath);
    return payload;
  }
}

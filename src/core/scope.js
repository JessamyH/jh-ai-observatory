import { trackedProject } from './util.js';

/** Scope a dashboard snapshot without changing its persisted history. */
export function scopeRecords(records, roots = []) {
  if (!roots.length) return [];
  return records.flatMap((record) => {
    const project = trackedProject(record.meta?.cwd, roots);
    return project ? [{ ...record, meta: { ...record.meta, project } }] : [];
  });
}

import { readFile, writeFile, rename, stat, copyFile, constants } from 'node:fs/promises';
import path from 'node:path';
import { resolvePath } from './core/util.js';

/** Create config.json from config.example.json when it doesn't exist yet. */
export async function ensureConfig(configPath) {
  const example = path.join(path.dirname(configPath), 'config.example.json');
  try {
    await copyFile(example, configPath, constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOENT') return false;
    throw err;
  }
}

export function pathSettings({ config, configPath, baseDir }) {
  return {
    get() {
      return { projectRoots: config.projectRoots || [], availableRoots: config.availableProjectRoots || config.projectRoots || [] };
    },
    async save(body) {
      if (!body || !Array.isArray(body.projectRoots) || !Array.isArray(body.availableRoots)) throw new Error('Expected path lists.');
      const normalize = (values) => {
        if (values.length > 100 || values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 4096)) throw new Error('Enter up to 100 valid directory paths.');
        return [...new Set(values.map((v) => resolvePath(v.trim(), baseDir)))];
      };
      const roots = normalize(body.projectRoots);
      const available = normalize(body.availableRoots);
      if (!roots.length) throw new Error('Select at least one detection directory.');
      if (roots.some((r) => !available.includes(r))) throw new Error('Selected paths must belong to the path list.');
      for (const root of roots) {
        let directory = false;
        try { directory = (await stat(root)).isDirectory(); } catch {}
        if (!directory) throw new Error(`Directory not found: ${root}`);
      }
      const disk = JSON.parse(await readFile(configPath, 'utf8'));
      disk.projectRoots = roots;
      disk.availableProjectRoots = available;
      const temp = `${configPath}.tmp`;
      await writeFile(temp, JSON.stringify(disk, null, 2) + '\n');
      await rename(temp, configPath);
      config.projectRoots = roots;
      config.availableProjectRoots = available;
      return this.get();
    },
  };
}

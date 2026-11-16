import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// What the UI learned about the plan limits (dollars per 1%p, per plan and window) and each chat's reference readings. It lives on disk next to the other app data:
// the app's origin changes on every launch (random port), so the browser's localStorage forgot all of it at each restart.
const KEY = /^ade:usage-[\w:.\/-]{1,200}$/, MAX_KEYS = 5000;
export function createUsageShareStore(file) {
  let cache = null, writing = Promise.resolve();
  const load = async () => {
    if (cache) return cache;
    try { const value = JSON.parse(await fs.readFile(file, 'utf8')); cache = value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { cache = {}; } // missing or torn: start over, the values are re-learned
    return cache;
  };
  const persist = () => {
    const data = JSON.stringify(cache), tmp = `${file}.${randomUUID()}.tmp`;
    writing = writing.then(async () => {
      try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
      finally { await fs.unlink(tmp).catch(() => {}); }
    }).catch(() => {}); // a failed save only means the next launch learns again
    return writing;
  };
  // `set`: key -> value (null removes). Returns the whole store.
  return {
    async update(set) {
      const data = await load();
      if (set && typeof set === 'object') {
        let changed = false;
        for (const [key, value] of Object.entries(set)) {
          if (!KEY.test(key)) continue;
          if (value === null) { changed = delete data[key] || changed; continue; }
          if (!(key in data) && Object.keys(data).length >= MAX_KEYS) continue;
          data[key] = value; changed = true;
        }
        if (changed) await persist();
      }
      return data;
    },
  };
}

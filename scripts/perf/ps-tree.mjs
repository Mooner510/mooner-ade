// Process-tree helpers for perf scripts (CPU time and RSS on macOS/Linux).
import { execSync } from 'node:child_process';

function rows() {
  return execSync('ps -A -o pid=,ppid=,rss=,time=,args=', { maxBuffer: 1 << 24 }).toString().trim().split('\n')
    .map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
}

export function treePids(root) {
  const list = rows(), ids = new Set([String(root)]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of list) if (ids.has(r[2]) && !ids.has(r[1])) { ids.add(r[1]); grew = true; }
  }
  return ids;
}

const sec = t => t.split(':').reduce((a, v) => a * 60 + +v, 0);

/** CPU seconds per Chromium --type under root pid (same meaning as frame-cost.mjs). */
export function cpuByType(root) {
  const ids = treePids(root), out = {};
  for (const r of rows()) if (ids.has(r[2])) { const k = /--type=(\S+)/.exec(r[5])?.[1] ?? 'browser'; out[k] = (out[k] ?? 0) + sec(r[4]); }
  return out;
}

/** Sum RSS (KiB) for the whole tree and per Chromium type. */
export function rssByType(root) {
  const ids = treePids(root), out = { total: 0 };
  for (const r of rows()) if (ids.has(r[2])) {
    const rss = +r[3]; out.total += rss;
    const k = /--type=(\S+)/.exec(r[5])?.[1] ?? 'browser';
    out[k] = (out[k] ?? 0) + rss;
  }
  return out;
}

export function rssKb(pid) {
  try { return +execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim() || 0; } catch { return 0; }
}
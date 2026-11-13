// Restart only the servers of the verify session in VERIFY_OUT; the Chrome stays (window, tabs, position) and its first tab is pointed at the new address.
// Use after changing apps/local-server (web edits need nothing: HMR). Keeps the data, home and repo (saved chats, keys); a new server gets a new port and token, so the tab is re-navigated.
// It only touches the PIDs recorded in this VERIFY_OUT's env.json, never anything else.
import { spawn } from 'node:child_process'; import { readFile } from 'node:fs/promises'; import { realpathSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { basename, join, sep } from 'node:path';
import { S, ROOT, sleep } from './lib.mjs';
const old = JSON.parse(await readFile(join(S, 'env.json'), 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// SIGKILL so start-ui's stop handler (which would also close its Chrome) never runs; Chrome is not a descendant that dies with it.
for (const pid of [old.pid, ...(old.serverPids ?? [])]) if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
// the killed start-ui never ran its exit hook, so the old second server's folder is removed here (the new start-ui makes a fresh one)
if (old.temp2 && basename(old.temp2).startsWith('ade-verify-') && old.temp2.startsWith(realpathSync(tmpdir()) + sep)) rmSync(old.temp2, { recursive: true, force: true });
if (!(await fetch(`${old.cdp}/json/version`).then(r => r.ok, () => false))) throw new Error(`Chrome at ${old.cdp} is gone: start a whole new session with start-ui.mjs instead.`);
const child = spawn(process.execPath, [join(ROOT, 'scripts/verify/start-ui.mjs')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, VERIFY_OUT: S, VERIFY_TEMP: old.temp, VERIFY_CHROME: old.cdp } });
await new Promise((resolve, reject) => { let out = ''; child.stdout.on('data', c => { out += c; if (/READY/.test(out)) resolve(); }); child.once('exit', c => reject(new Error(`start-ui exited (${c})`))); setTimeout(() => reject(new Error('startup timeout')), 60000); });
child.stdout.destroy(); child.unref();
const now = JSON.parse(await readFile(join(S, 'env.json'), 'utf8')); console.log('RESTARTED', now.origin, 'pid', now.pid, '(Chrome kept:', now.cdp + ')');

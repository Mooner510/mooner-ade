/** Explicit opt-in; real model calls through the same transports the server uses, with the OS user's own logins. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppAgent, ClaudeSdkAgent } from '../apps/local-server/src/agents.js';

if (process.env.ADE_LIVE_TEST !== '1') {
  console.error('Live agent invocation is disabled. Set ADE_LIVE_TEST=1 to opt in to actual model calls.');
  process.exit(2);
}

async function run(agent, cwd, prompt, extra = {}) {
  const events = [];
  const request = { prompt, cwd, signal: new AbortController().signal, ...extra,
    requestApproval: async ({ onRequest }) => { onRequest({ id: `live-${events.length}` }); return true; } };
  for await (const event of agent.run(request)) events.push(event);
  const text = events.filter(e => e.kind === 'text').map(e => e.text).join('');
  return { events, text, threadId: events.find(e => e.kind === 'session')?.threadId,
    approvals: events.filter(e => e.kind === 'approval' && e.phase === 'requested').length };
}

function expect(condition, message) { if (!condition) throw new Error(message); }

let failed = false;
for (const agent of [new CodexAppAgent(), new ClaudeSdkAgent()]) {
  const cwd = await mkdtemp(join(tmpdir(), 'ade-live-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const first = await run(agent, cwd, 'Run a shell command that writes the text ADE_LIVE_OK into a file named live-1.txt, then reply DONE.');
    expect(first.threadId, 'no session/thread id was reported');
    expect(first.approvals >= 1, 'default mode never asked for approval');
    expect((await readFile(join(cwd, 'live-1.txt'), 'utf8')).includes('ADE_LIVE_OK'), 'approved command did not run');
    const resumed = await run(agent, cwd, 'Reply with only the name of the file you created earlier.', { threadId: first.threadId });
    expect(resumed.text.includes('live-1.txt'), `resume lost context: ${resumed.text.slice(0, 120)}`);
    const full = await run(agent, cwd, 'Run a shell command that writes the text ADE_LIVE_OK into a file named live-2.txt, then reply DONE.', { fullAccess: true });
    expect(full.approvals === 0, 'fullAccess still asked for approval');
    expect((await readFile(join(cwd, 'live-2.txt'), 'utf8')).includes('ADE_LIVE_OK'), 'fullAccess command did not run');
    console.log(`${agent.id}: live run, approval, resume and full-access passed`);
  } catch (error) {
    failed = true;
    console.error(`${agent.id}: ${error.message}`);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
process.exit(failed ? 1 : 0);

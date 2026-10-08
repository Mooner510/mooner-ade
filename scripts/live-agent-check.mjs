/** Explicit opt-in; uses the current operating system user's own authenticated CLIs. */
import { CodexAgent } from '../packages/agent-codex/src/index.js';
import { ClaudeAgent } from '../packages/agent-claude/src/index.js';

if (process.env.ADE_LIVE_TEST !== '1') {
  console.error('Live CLI invocation is disabled. Set ADE_LIVE_TEST=1 to opt in to actual model calls.');
  process.exitCode = 2;
} else {
  const cwd = process.cwd();
  let failed = false;
  for (const agent of [new CodexAgent(), new ClaudeAgent()]) {
    const events = [];
    try {
      for await (const event of agent.run({
        cwd,
        prompt: 'Reply only ADE_LIVE_OK. Do not read, write, or modify any files.',
        fullAccess: false
      })) events.push(event);
      const response = events.filter(e => e.kind === 'text' || e.kind === 'result').map(e => e.text).filter(Boolean).join('\n');
      if (!response.includes('ADE_LIVE_OK') || events.some(e => e.kind === 'error')) {
        throw new Error('Expected response absent or CLI reported an error');
      }
      console.log(`${agent.id}: live CLI streaming passed`);
    } catch (error) {
      failed = true;
      console.error(`${agent.id}: ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

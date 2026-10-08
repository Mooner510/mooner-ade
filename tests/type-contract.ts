import { AdeEngine, AllowAllPolicy, type AdeRuntime, type AgentEvent } from '../packages/core/src/index.js';
import { envelope, parseEnvelope } from '../packages/protocol/src/index.js';
import { createLocalRuntime } from '../packages/runtime-local/src/index.js';
import { CodexAgent } from '../packages/agent-codex/src/index.js';
import { ClaudeAgent } from '../packages/agent-claude/src/index.js';
const runtime: AdeRuntime = createLocalRuntime();
const engine = new AdeEngine({ runtime, policy: new AllowAllPolicy(), agents: [new CodexAgent(), new ClaudeAgent()] });
const message = envelope('agent', 'text', { text: 'hello' });
parseEnvelope(message);
for await (const event of engine.runAgent('codex', 'hello')) {
  const typed: AgentEvent = event;
  console.log(typed.kind);
}

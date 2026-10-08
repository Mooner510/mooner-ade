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
// P1 public type API compilation contracts
await engine.gitDiff('.', { staged: true });
await engine.gitStage(['README.md']);
await engine.gitUnstage(['README.md']);
const nativeThreadId: string | null = engine.sessions[0]?.nativeThreadId ?? null;
console.log(nativeThreadId);

import { parseAgentEvent, AGENT_EVENT_SCHEMA_VERSION, type AgentEventWire } from '../packages/protocol/src/index.js';
import { RecordedAgentRunner } from '../packages/session-runner/src/index.js';
import { FileSessionStore } from '../packages/session-store/src/index.js';
const wire: AgentEventWire = { schemaVersion: 1, kind: 'text', text: 'hi', sequence: 1, timestamp: 123, sessionId: 'x', agent: 'codex' };
const parsed: AgentEventWire = parseAgentEvent(wire);
console.log(parsed.kind, AGENT_EVENT_SCHEMA_VERSION);
const runner = new RecordedAgentRunner({ engine, store: new FileSessionStore('.sessions') });
const replay: AgentEventWire[] = await runner.replay('x');
console.log(replay.length);

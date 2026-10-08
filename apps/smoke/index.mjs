import { AdeEngine, AllowAllPolicy } from '../../packages/core/src/index.js';
import { createLocalRuntime } from '../../packages/runtime-local/src/index.js';
import { CodexAgent } from '../../packages/agent-codex/src/index.js';
import { ClaudeAgent } from '../../packages/agent-claude/src/index.js';
const engine = new AdeEngine({ runtime: createLocalRuntime({ root: process.cwd() }), policy: new AllowAllPolicy(), agents: [new CodexAgent(), new ClaudeAgent()] });
const files = await engine.listFiles();
const proc = await engine.execute(process.execPath, ['-p', '21*2']);
console.log(JSON.stringify({ agents: engine.agents, sampleFiles: files.slice(0, 3), runtime: proc.stdout.trim() }, null, 2));

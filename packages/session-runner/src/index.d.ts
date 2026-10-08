import type { AdeEngine, AgentRequest, SequencedAgentEvent } from '../../core/src/index.js';
import type { FileSessionStore, SessionRecord } from '../../session-store/src/index.js';
import type { AgentEventWire } from '../../protocol/src/index.js';
export declare class RecordedAgentRunner {
  constructor(options: { engine: AdeEngine; store: FileSessionStore });
  runAgent(agentId: string, prompt: string, options?: AgentRequest): AsyncIterable<SequencedAgentEvent & AgentEventWire>;
  replay(sessionId: string, options?: { afterSequence?: number }): Promise<AgentEventWire[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  recover(sessionId: string): Promise<SessionRecord>;
  stopAgent(sessionId: string): boolean;
}

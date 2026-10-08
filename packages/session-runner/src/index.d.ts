import type { AdeEngine, AgentRequest, SequencedAgentEvent } from '../../core/src/index.js';
import type { FileSessionStore, SessionRecord, StoredEvent } from '../../session-store/src/index.js';
export declare class RecordedAgentRunner {
  constructor(options: { engine: AdeEngine; store: FileSessionStore });
  runAgent(agentId: string, prompt: string, options?: AgentRequest): AsyncIterable<StoredEvent & SequencedAgentEvent>;
  replay(sessionId: string, options?: { afterSequence?: number }): Promise<StoredEvent[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  recover(sessionId: string): Promise<SessionRecord>;
  stopAgent(sessionId: string): boolean;
}

export declare const PROTOCOL_VERSION: 1;
export declare class AdeError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown);
}
export interface Envelope<T = unknown> {
  v: 1;
  id: string;
  channel: string;
  kind: string;
  payload: T;
  timestamp: number;
}
export declare function envelope<T>(channel: string, kind: string, payload: T, id?: string): Envelope<T>;
export declare function parseEnvelope(value: unknown): Envelope;

export declare const AGENT_EVENT_SCHEMA_VERSION: 1;
export interface AgentEventBase {
  schemaVersion: 1;
  sessionId: string;
  agent: string;
  sequence: number;
  timestamp: number;
}
export type AgentEventWire = AgentEventBase & (
  | { kind: 'lifecycle'; phase: 'started' | 'completed' | 'failed' | 'cancelled' }
  | { kind: 'session'; threadId?: string }
  | { kind: 'text'; text: string; mode?: 'append' | 'replace'; itemId?: string }
  | { kind: 'tool'; tool?: string }
  | { kind: 'usage'; usage?: unknown }
  | { kind: 'result'; status?: string }
  | { kind: 'error'; message: string }
  | { kind: 'raw'; data?: unknown }
  | { kind: 'progress'; phase?: string }
  | { kind: 'approval'; phase: 'requested' | 'approved' | 'denied'; approvalId?: string; tool: string; summary?: string }
);
export declare function parseAgentEvent(value: unknown, options?: { allowLegacy?: boolean }): AgentEventWire;

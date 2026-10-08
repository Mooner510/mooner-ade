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

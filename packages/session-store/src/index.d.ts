export interface StoredSession {
  id: string;
  status: 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  updatedAt?: number;
  [key: string]: unknown;
}
export interface StoredEvent {
  sessionId: string;
  sequence: number;
  timestamp: number;
  kind?: string;
  [key: string]: unknown;
}
export interface SessionRecord {
  version: 1;
  session: StoredSession;
  events: StoredEvent[];
}
export declare class FileSessionStore {
  constructor(directory: string);
  create(session: StoredSession): Promise<SessionRecord>;
  load(id: string): Promise<SessionRecord | null>;
  list(): Promise<StoredSession[]>;
  recoverAll(): Promise<SessionRecord[]>;
  append(id: string, event: Record<string, unknown>): Promise<StoredEvent>;
  setStatus(id: string, status: StoredSession['status']): Promise<StoredSession>;
  replay(id: string, options?: { afterSequence?: number }): Promise<StoredEvent[]>;
  recover(id: string): Promise<SessionRecord>;
}

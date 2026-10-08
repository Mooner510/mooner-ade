export interface CapabilityPolicy { authorize(action: string, context: Record<string, unknown>): Promise<boolean> | boolean; }
export interface AgentEvent { kind: string; [key: string]: unknown; }
export interface AgentRequest { prompt: string; cwd?: string; signal?: AbortSignal; threadId?: string; approvalMode?: 'interactive' | 'noninteractive'; onApprovalRequest?: (request: ApprovalRequest) => void; requestApproval?: (request: { tool: string; summary?: string }) => Promise<boolean>; [key: string]: unknown; }
export interface AgentAdapter { id: string; capabilities?: { interactiveApprovals: boolean }; run(request: AgentRequest): AsyncIterable<AgentEvent>; }
export interface WorkspacePort { readFile(path: string): Promise<string>; writeFile(path: string, content: string): Promise<void>; listFiles(path?: string): Promise<unknown[]>; }
export interface ProcessPort { exec(file: string, args?: string[], options?: object): Promise<unknown>; }
export interface GitPort {
  status(path?: string): Promise<unknown>;
  diff(path?: string, options?: { staged?: boolean }): Promise<string>;
  stage(files: string[], path?: string): Promise<void>;
  unstage(files: string[], path?: string): Promise<void>;
  commit(message: string, path?: string): Promise<string>;
}
export interface TerminalPort { open(options?: object): Promise<unknown>; }
export interface AdeRuntime { workspace: WorkspacePort; processes: ProcessPort; git: GitPort; terminal: TerminalPort; }
export interface AdeSession { id: string; agentId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt: number; finishedAt?: number; eventCount: number; nativeThreadId: string | null; }
export interface ApprovalRequest { id: string; sessionId: string; tool: string; summary: string; requestedAt?: number; }
export declare class ApprovalBroker {
  constructor(options?: { timeoutMs?: number });
  readonly pending: ApprovalRequest[];
  request(input: { sessionId: string; tool: string; summary?: string; signal?: AbortSignal; onRequest(request: ApprovalRequest): void }): Promise<boolean>;
  decide(id: string, approved?: boolean): boolean;
}
export interface SequencedAgentEvent extends AgentEvent { sessionId: string; agent: string; sequence: number; timestamp: number; }
export declare class AllowAllPolicy implements CapabilityPolicy { authorize(): Promise<boolean>; }
export declare class DenyAllPolicy implements CapabilityPolicy { authorize(): Promise<boolean>; }
export declare class AdeEngine {
  constructor(options: { runtime: AdeRuntime; policy?: CapabilityPolicy; agents?: AgentAdapter[]; approvalBroker?: ApprovalBroker });
  registerAgent(agent: AgentAdapter): void;
  readonly agents: string[];
  readonly approvalRequests: ApprovalRequest[];
  decideApproval(id: string, approved?: boolean): Promise<boolean>;
  readonly sessions: AdeSession[];
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<unknown[]>;
  gitStatus(path?: string): Promise<unknown>;
  gitDiff(path?: string, options?: { staged?: boolean }): Promise<string>;
  gitStage(files: string[], path?: string): Promise<void>;
  gitUnstage(files: string[], path?: string): Promise<void>;
  gitCommit(message: string, path?: string): Promise<string>;
  execute(file: string, args?: string[], options?: object): Promise<unknown>;
  openTerminal(options?: object): Promise<unknown>;
  runAgent(agentId: string, prompt: string, options?: AgentRequest): AsyncIterable<SequencedAgentEvent>;
  stopAgent(sessionId: string): boolean;
}

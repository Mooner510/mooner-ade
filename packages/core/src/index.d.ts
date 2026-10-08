export interface CapabilityPolicy { authorize(action: string, context: Record<string, unknown>): Promise<boolean> | boolean; }
export interface AgentEvent { kind: string; [key: string]: unknown; }
export interface AgentRequest { prompt: string; cwd?: string; signal?: AbortSignal; threadId?: string; [key: string]: unknown; }
export interface AgentAdapter { id: string; run(request: AgentRequest): AsyncIterable<AgentEvent>; }
export interface WorkspacePort { readFile(path: string): Promise<string>; writeFile(path: string, content: string): Promise<void>; listFiles(path?: string): Promise<unknown[]>; }
export interface ProcessPort { exec(file: string, args?: string[], options?: object): Promise<unknown>; }
export interface GitPort { status(path?: string): Promise<unknown>; }
export interface TerminalPort { open(options?: object): Promise<unknown>; }
export interface AdeRuntime { workspace: WorkspacePort; processes: ProcessPort; git: GitPort; terminal: TerminalPort; }
export declare class AllowAllPolicy implements CapabilityPolicy { authorize(): Promise<boolean>; }
export declare class DenyAllPolicy implements CapabilityPolicy { authorize(): Promise<boolean>; }
export declare class AdeEngine {
  constructor(options: { runtime: AdeRuntime; policy?: CapabilityPolicy; agents?: AgentAdapter[] });
  registerAgent(agent: AgentAdapter): void;
  readonly agents: string[];
  readonly sessions: object[];
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<unknown[]>;
  gitStatus(path?: string): Promise<unknown>;
  execute(file: string, args?: string[], options?: object): Promise<unknown>;
  openTerminal(options?: object): Promise<unknown>;
  runAgent(agentId: string, prompt: string, options?: AgentRequest): AsyncIterable<AgentEvent>;
  stopAgent(sessionId: string): boolean;
}

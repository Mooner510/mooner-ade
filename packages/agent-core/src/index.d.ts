export declare function parseJsonLines(chunks: AsyncIterable<Uint8Array | string>, options?: { maxLineBytes?: number }): AsyncIterable<unknown>;
export interface CliAgentConfig {
  id: string;
  executable: string;
  buildArgs(request: { threadId?: string; [key: string]: unknown }): string[];
  normalize(raw: unknown): { kind: string; [key: string]: unknown }[];
  spawnProcess?: Function;
  maxStderrBytes?: number;
}
export declare class JsonlCliAgent {
  readonly id: string;
  constructor(options: CliAgentConfig);
  run(request: { prompt: string; cwd?: string; threadId?: string; signal?: AbortSignal; env?: Record<string, string>; [key: string]: unknown }): AsyncIterable<{ kind: string; [key: string]: unknown }>;
}

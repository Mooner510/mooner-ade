import { JsonlCliAgent } from '@mooner/ade-agent-core';
export declare function normalizeClaude(raw: any): { kind: string; [key: string]: unknown }[];
export declare function buildClaudeArgs(request?: { threadId?: string; fullAccess?: boolean; model?: string; maxTurns?: number }): string[];
export declare class ClaudeAgent extends JsonlCliAgent {
  constructor(options?: { executable?: string; spawnProcess?: Function });
}

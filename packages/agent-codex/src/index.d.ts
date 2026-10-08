import { JsonlCliAgent } from '@mooner/ade-agent-core';
export declare function normalizeCodex(raw: any): { kind: string; [key: string]: unknown }[];
export declare function buildCodexArgs(request?: { threadId?: string; fullAccess?: boolean; model?: string }): string[];
export declare class CodexAgent extends JsonlCliAgent {
  constructor(options?: { executable?: string; spawnProcess?: Function });
}

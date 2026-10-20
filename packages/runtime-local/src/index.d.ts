export declare class LocalWorkspace {
  constructor(root?: string, options?: { scope?: 'unrestricted' | 'root' });
  readonly root: string;
  readonly scope: string;
  resolve(path?: string): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<{ name: string; kind: 'directory' | 'symlink' | 'file' }[]>;
  watch(path?: string, options?: { signal?: AbortSignal }): AsyncIterable<{ kind: string; path: string | null }>;
}
export interface ExecuteOptions { cwd?: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; }
export declare class LocalProcesses {
  constructor(options?: { cwd?: string });
  exec(file: string, args?: string[], options?: ExecuteOptions): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}
export declare class LocalGit {
  constructor(processes: LocalProcesses, workspace: LocalWorkspace);
  status(path?: string): Promise<{ branch: string; changes: string[]; clean: boolean }>;
  diff(path?: string, options?: { staged?: boolean }): Promise<string>;
  stage(files: string[], path?: string): Promise<void>;
  unstage(files: string[], path?: string): Promise<void>;
  commit(message: string, path?: string): Promise<string>;
  worktrees(): Promise<Record<string, string | boolean>[]>;
  createWorktree(target: string, branch: string): Promise<void>;
  removeWorktree(target: string): Promise<void>;
  integrateWorktree(branch: string): Promise<void>;
}
export interface PtySession {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** Stop listening but keep the terminal alive when it lives in a separate PTY host; otherwise same as close(). */
  detach(): void;
  onData(fn: (data: string) => void): { dispose(): void };
  onExit(fn: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}
export declare class LocalTerminal {
  constructor(options?: { shell?: string; ptyFactory?: { spawn(file: string, args: string[], options: object): unknown } });
  shell: string;
  open(options?: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string>; args?: string[]; meta?: object }): Promise<PtySession>;
}
export declare function createLocalRuntime(options?: { root?: string; scope?: 'unrestricted' | 'root'; shell?: string; ptyFactory?: { spawn(file: string, args: string[], options: object): unknown } }): {
  workspace: LocalWorkspace; processes: LocalProcesses; git: LocalGit; terminal: LocalTerminal; platform: { type: 'local'; os: string };
};

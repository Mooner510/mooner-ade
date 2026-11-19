export type FileVersion = { revision: string; content: string };
type BufferState = {
  file?: FileVersion | null;
  draft?: string;
  conflict?: { file: FileVersion | null };
  error?: string;
  busy?: boolean;
};

export class FileBuffer {
  private state: BufferState = {};
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private operation: Promise<void> | null = null;
  private writing = false;
  readonly path: string;
  private call: <T>(action: string, input: object) => Promise<T>;

  constructor(path: string, call: FileBuffer['call']) {
    this.path = path;
    this.call = call;
  }

  get = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get dirty() { return this.writing || Boolean(this.state.conflict) || (this.state.draft !== undefined && this.state.draft !== this.state.file?.content); }

  private update(state: Partial<BufferState>) {
    this.state = { ...this.state, ...state };
    this.listeners.forEach(listener => listener());
  }

  private accept(file: FileVersion | null) {
    this.update({ file, draft: file?.content, conflict: undefined, error: undefined });
  }

  private run(task: () => Promise<void>) {
    if (this.operation) return this.operation;
    this.operation = task().catch(cause => {
      if (!(cause instanceof Error && 'code' in cause && cause.code === 'FILE_CHANGING')) this.update({ error: (cause as Error).message || String(cause) });
      else if (this.dirty && !this.state.conflict) this.schedule();
    }).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  refresh = () => this.run(async () => {
    const { file } = await this.call<{ file: FileVersion | null }>('files/read', { path: this.path });
    if (this.state.conflict) return;
    if (this.dirty && file?.content !== this.state.draft) {
      if (file?.revision !== this.state.file?.revision) this.update({ conflict: { file }, error: undefined });
    } else if (file?.revision !== this.state.file?.revision || this.state.file === undefined || this.state.error) {
      this.accept(file);
    }
  });

  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.save(); }, 350);
  }

  edit = (draft: string) => {
    if (draft === this.state.draft) return;
    this.update({ draft, error: undefined });
    if (!this.state.conflict) this.schedule();
  };

  save = (overwrite = false): Promise<void> => {
    const { file, draft, conflict, busy } = this.state;
    if (busy || !this.dirty || draft === undefined || (!!conflict !== overwrite)) return Promise.resolve();
    if (this.operation && !overwrite) return this.operation.then(() => this.save());
    clearTimeout(this.timer);
    this.update({ error: undefined, busy: overwrite });
    const write = () => this.run(async () => {
      this.writing = true;
      try {
        const revision = (conflict ? conflict.file : file)?.revision ?? null;
        const result = await this.call<{ file: FileVersion | null; conflict: boolean }>('files/write', { path: this.path, revision, content: draft });
        const latestDraft = this.state.draft;
        if (result.conflict && result.file?.content !== latestDraft) this.update({ conflict: { file: result.file } });
        else if (result.file?.content === latestDraft) this.accept(result.file);
        else this.update({ file: result.file, conflict: undefined });
      } finally { this.writing = false; }
    });
    const saved = this.operation ? this.operation.then(write) : write();
    return overwrite ? saved.finally(() => this.update({ busy: false })) : saved;
  };

  reload = () => {
    if (!this.state.conflict || this.state.busy) return;
    // Wait for an ordinary read already in progress before explicitly discarding the draft.
    this.update({ busy: true });
    const load = () => this.run(async () => {
      const { file } = await this.call<{ file: FileVersion | null }>('files/read', { path: this.path });
      this.accept(file);
    });
    return (this.operation ? this.operation.then(load) : load()).finally(() => this.update({ busy: false }));
  };
}

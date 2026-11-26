// "선택 영역을 채팅으로 보내기" and "ADE에서 복사한 것은 참조로 붙여넣기": what goes into the chat composer, as plain functions so
// tests/chat-send.test.mjs can load this file directly (no imports, no DOM).
//
// Line references follow Claude Code's own @-mention form, `@src/a.ts#5-10` (what its IDE extensions insert for a selection; the CLI reads
// the range). Codex and Cursor get the same text and read it as a path plus a line range. A path with spaces is `@"a b.ts"`, as the
// composer already writes dropped files.

export type LineRange = { start: number; end: number };
/** A path as a source knows it: relative to the project root, to the Git repository the diff came from, or already absolute. */
export type SourcePath = { path: string; base: 'project' | 'repo' | 'abs'; folder?: boolean };
export type DiffRev = string; // a diff tab's revision: `<sha>` (against its parent), `<a>..<b>`, `<a>..` (against the working tree)

export type SendPayload =
  /** A file of the editor, or part of it. No range: the whole file. */
  | { kind: 'file'; file: SourcePath; range?: LineRange }
  /** Files and folders picked in the project tree. */
  | { kind: 'paths'; paths: SourcePath[] }
  /** Text that is not a file (terminal output), sent in a fence. */
  | { kind: 'text'; text: string; label: string; lang?: string }
  /** One file's diff. `selection` when the user selected lines in it; `rev` absent for an agent's edit in the chat. */
  | { kind: 'diff'; file: SourcePath; rev?: DiffRev; patch: string; ranges: LineRange[]; selection?: { text: string; range: LineRange; side: 'original' | 'modified' } }
  /** Commits picked in the Git graph, with their patch when it was fetched. */
  | { kind: 'commits'; commits: { sha: string; subject: string }[]; patch?: string };

/** Payload with every path made absolute (what the chat formats against its own working folder). */
export type Roots = { project: string; repo?: string };

// ---- paths ----
const slashes = (path: string) => path.replace(/\\/g, '/');
const isAbsolute = (path: string) => /^(?:[a-zA-Z]:)?[\\/]/.test(path);
const trimEnd = (path: string) => path.length > 1 && !/^[a-zA-Z]:\/$/.test(path) ? path.replace(/\/+$/, '') : path;
/** Joins a root and a relative path with forward slashes, resolving `.` and `..` segments. An absolute `path` is kept. */
export function joinPath(root: string, path: string): string {
  if (isAbsolute(path)) return slashes(path);
  const parts = trimEnd(slashes(root)).split('/');
  for (const part of slashes(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length > 1) parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
/** Windows paths compare without case (drive letters and folders); POSIX ones exactly. */
const samePrefix = (a: string, b: string) => /^[a-zA-Z]:\//.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
/** `abs` relative to `cwd` when it is inside it (`.` for cwd itself), otherwise the absolute path, always with forward slashes. */
export function relativeTo(cwd: string, abs: string): string {
  const base = trimEnd(slashes(cwd)), path = trimEnd(slashes(abs));
  if (!base) return path;
  if (samePrefix(base, path)) return '.';
  const head = base.endsWith('/') ? base : `${base}/`;
  return path.length > head.length && samePrefix(path.slice(0, head.length), head) ? path.slice(head.length) : path;
}
export function absolutePath(file: SourcePath, roots: Roots): string {
  return file.base === 'abs' ? slashes(file.path) : joinPath(file.base === 'repo' ? roots.repo || roots.project : roots.project, file.path);
}

// ---- text pieces ----
/** The lines a Monaco selection covers. A selection that ends at the very start of a line (a drag down to it) does not include that line. */
export function selectionLines(selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): LineRange {
  const end = selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
  return { start: selection.startLineNumber, end };
}
/** `10` for one line, `10-20` for several. */
export const rangeLabel = (range: LineRange) => range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
/** `@path`, `@path/` for a folder, `@"a b.ts"` when the path has spaces, with `#10-20` for a line range. */
export function mention(path: string, options: { folder?: boolean; range?: LineRange } = {}): string {
  const shown = options.folder && !path.endsWith('/') && path !== '.' ? `${path}/` : path;
  return `${/\s/.test(shown) ? `@"${shown}"` : `@${shown}`}${options.range ? `#${rangeLabel(options.range)}` : ''}`;
}
/** A fence long enough that no backtick run inside the text closes it. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}
const EXT_LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', md: 'md', css: 'css', scss: 'scss', html: 'html', py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', sh: 'sh', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', swift: 'swift', xml: 'xml', vue: 'vue' };
/** The fence language for a file name, or '' when unknown. */
export const langOf = (path: string) => EXT_LANG[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? '';

/** Keeps the first `head` and last `tail` lines of a long text, with a line saying how much was left out; a short one is unchanged. */
export function shorten(text: string, { maxLines = 400, head = 80, tail = 300, maxChars = 40_000 }: { maxLines?: number; head?: number; tail?: number; maxChars?: number } = {}): { text: string; omitted: number } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  let kept = lines, omitted = 0;
  if (lines.length > maxLines) { omitted = lines.length - head - tail; kept = [...lines.slice(0, head), `… (${omitted}줄 생략) …`, ...lines.slice(-tail)]; }
  let out = kept.join('\n');
  if (out.length > maxChars) {
    // Very long lines: cut by characters too, still keeping both ends (the end of terminal output is usually what matters).
    const front = Math.floor(maxChars / 4), back = maxChars - front, cut = out.length - front - back;
    out = `${out.slice(0, front)}\n… (${cut.toLocaleString('en-US')}자 생략) …\n${out.slice(-back)}`;
    omitted = Math.max(omitted, 1);
  }
  return { text: out, omitted };
}

/** The git command that shows a diff tab's change, so a large one can be named instead of pasted. */
export function gitCommandFor(rev: DiffRev, path: string): string {
  const quoted = /[\s"'$`]/.test(path) ? `"${path.replace(/(["\\$`])/g, '\\$1')}"` : path;
  if (!rev.includes('..')) return `git show ${rev.slice(0, 12)} -- ${quoted}`;
  const [from, to] = rev.split('..');
  return to ? `git diff ${from.slice(0, 12)} ${to.slice(0, 12)} -- ${quoted}` : `git diff ${from.slice(0, 12)} -- ${quoted}`;
}
const revLabel = (rev: DiffRev) => {
  if (!rev.includes('..')) return `커밋 ${rev.slice(0, 7)}`;
  const [from, to] = rev.split('..');
  return to ? `${from.slice(0, 7)}..${to.slice(0, 7)}` : `${from.slice(0, 7)} ↔ 작업 트리`;
};

/** A patch up to this many lines goes into the message; a longer one is named by file, ranges and a git command. */
export const PATCH_LINES = 300;

/** The composer text for a payload, with paths relative to the chat's working folder (`cwd`). */
export function formatForChat(payload: SendPayload, roots: Roots, cwd: string): string {
  const rel = (file: SourcePath) => relativeTo(cwd, absolutePath(file, roots));
  switch (payload.kind) {
    case 'file': return mention(rel(payload.file), { range: payload.range });
    case 'paths': return payload.paths.map(file => mention(rel(file), { folder: file.folder })).join(' ');
    case 'text': {
      const { text } = shorten(payload.text);
      return `${payload.label}:\n${fence(text, payload.lang ?? '')}`;
    }
    case 'diff': {
      const path = rel(payload.file), where = payload.rev ? revLabel(payload.rev) : '에이전트가 수정한 부분';
      if (payload.selection) {
        const { text, range, side } = payload.selection;
        // The working tree's file at these lines is the file itself: a reference is enough. Elsewhere the lines belong to another version.
        if (payload.rev?.endsWith('..') && side === 'modified') return mention(path, { range });
        // An agent's edit card shows only the edited snippet, so its line numbers are not the file's: those are left out.
        const version = `${where}, ${side === 'original' ? '변경 전' : '변경 후'}${payload.rev ? `, ${rangeLabel(range)}행` : ''}`;
        return `${mention(path)} (${version}):\n${fence(shorten(text).text, langOf(path))}`;
      }
      const lines = payload.patch.split('\n').length;
      if (lines <= PATCH_LINES) return `${mention(path)}의 변경 (${where}):\n${fence(payload.patch, 'diff')}`;
      const ranges = payload.rev && payload.ranges.length ? ` 바뀐 줄(변경 후 기준): ${payload.ranges.slice(0, 20).map(rangeLabel).join(', ')}${payload.ranges.length > 20 ? ` 외 ${payload.ranges.length - 20}곳` : ''}.` : '';
      return `${mention(path)}의 변경 (${where}, ${lines}줄이라 패치 대신 위치만).${ranges}${payload.rev ? ` 전체는 \`${gitCommandFor(payload.rev, slashes(payload.file.path))}\`로 볼 수 있습니다.` : ''}`;
    }
    case 'commits': {
      const list = payload.commits.map(commit => `${commit.sha.slice(0, 7)} ${commit.subject}`.trim());
      const head = payload.commits.length === 1 ? `커밋 ${list[0]}` : `커밋 ${payload.commits.length}개:\n${list.map(line => `- ${line}`).join('\n')}`;
      if (payload.patch && payload.patch.split('\n').length <= PATCH_LINES) return `${head}\n${fence(payload.patch, 'diff')}`;
      const shas = payload.commits.map(commit => commit.sha.slice(0, 12)).join(' ');
      return `${head}\n(패치가 길어 생략, \`git show ${shas}\`로 볼 수 있습니다.)`;
    }
  }
}

/** The composer after adding `insert`: replaces an empty draft; a one-line reference joins with a space, a block starts on its own paragraph. */
export function joinDraft(current: string, insert: string): string {
  const block = insert.includes('\n');
  const tail = block ? '\n' : ' ';
  if (!current.trim()) return insert + tail;
  if (block) return `${current.replace(/\s+$/, '')}\n\n${insert}${tail}`;
  return `${current}${/\s$/.test(current) ? '' : ' '}${insert}${tail}`;
}

// ---- unified diff from Monaco's line changes ----
/** Monaco's ILineChange: an end of 0 means nothing on that side (a pure insertion or deletion after that line). */
export type LineChange = { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number };
/** A unified diff (`--- a/`, `+++ b/`, `@@` hunks with `context` lines around changes) of two texts, from the changes Monaco computed. */
export function unifiedPatch(path: string, original: string, modified: string, changes: LineChange[], context = 3): string {
  const a = original.replace(/\r\n?/g, '\n').split('\n'), b = modified.replace(/\r\n?/g, '\n').split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  // Each change as half-open 0-based spans [aStart, aEnd) and [bStart, bEnd).
  const spans = changes.map(change => {
    const aStart = change.originalEndLineNumber === 0 ? change.originalStartLineNumber : change.originalStartLineNumber - 1;
    const bStart = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber : change.modifiedStartLineNumber - 1;
    return { aStart, aEnd: change.originalEndLineNumber === 0 ? aStart : change.originalEndLineNumber, bStart, bEnd: change.modifiedEndLineNumber === 0 ? bStart : change.modifiedEndLineNumber };
  }).sort((x, y) => x.aStart - y.aStart);
  const hunks: string[] = [];
  let index = 0;
  while (index < spans.length) {
    // Changes whose context would touch go into one hunk.
    let last = index;
    while (last + 1 < spans.length && spans[last + 1].aStart - spans[last].aEnd <= context * 2) last++;
    const first = spans[index], end = spans[last];
    const aFrom = Math.max(0, first.aStart - context), bFrom = Math.max(0, first.bStart - context);
    const aTo = Math.min(a.length, end.aEnd + context), bTo = Math.min(b.length, end.bEnd + context);
    const body: string[] = [];
    let ai = aFrom;
    for (let k = index; k <= last; k++) {
      const span = spans[k];
      for (; ai < span.aStart; ai++) body.push(` ${a[ai]}`);
      // Monaco names an empty side (a new or deleted file) as one line it does not have: only lines that exist go in.
      for (let i = span.aStart; i < Math.min(span.aEnd, a.length); i++) body.push(`-${a[i]}`);
      for (let i = span.bStart; i < Math.min(span.bEnd, b.length); i++) body.push(`+${b[i]}`);
      ai = span.aEnd;
    }
    for (; ai < aTo; ai++) body.push(` ${a[ai]}`);
    const count = (from: number, to: number) => to - from;
    const aCount = count(aFrom, aTo), bCount = count(bFrom, bTo);
    hunks.push(`@@ -${aCount ? aFrom + 1 : aFrom},${aCount} +${bCount ? bFrom + 1 : bFrom},${bCount} @@`, ...body);
    index = last + 1;
  }
  const name = slashes(path);
  return hunks.length ? [`--- a/${name}`, `+++ b/${name}`, ...hunks].join('\n') : '';
}
/** The changed lines on the modified side, for naming a large diff by location. Pure deletions point at the line after them. */
export const changedRanges = (changes: LineChange[]): LineRange[] => changes.map(change => change.modifiedEndLineNumber === 0
  ? { start: Math.max(1, change.modifiedStartLineNumber), end: Math.max(1, change.modifiedStartLineNumber) }
  : { start: change.modifiedStartLineNumber, end: change.modifiedEndLineNumber });

// ---- which chat ----
export type ChatCandidate = { id: string; tabId: string; focusedAt: number };
/**
 * Where "send to chat" goes: the focused pane when it is a chat; else the chat of the active tab that had the focus last; else the chat of
 * the project that had it last (any tab). `chats` is in tab and pane order, which breaks ties (never-focused chats are 0). Null: none.
 */
export function pickTarget(chats: ChatCandidate[], activeTab: string, focused: string): ChatCandidate | null {
  const here = chats.find(chat => chat.id === focused && chat.tabId === activeTab);
  if (here) return here;
  const latest = (list: ChatCandidate[]) => list.reduce<ChatCandidate | null>((best, chat) => !best || chat.focusedAt > best.focusedAt ? chat : best, null);
  return latest(chats.filter(chat => chat.tabId === activeTab)) ?? latest(chats);
}

// ---- copied in ADE, pasted in a chat ----
/** What an ADE copy put on the clipboard and what it stands for. Only a hash of the text is kept. */
export type CopyRecord = { hash: string; length: number; at: number; ref: Extract<SendPayload, { kind: 'file' | 'paths' }> };
/** Copies older than this paste as text again: by then the user has most likely forgotten where the clipboard came from. */
export const COPY_RECORD_MS = 60 * 60 * 1000;
/** Line endings and the final newline differ between where text is copied and how the clipboard hands it back. */
export const normalizeClip = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
/** FNV-1a over the normalized text: enough to tell "the same text" from "something else", without keeping the text itself. */
export function hashText(text: string): string {
  const value = normalizeClip(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${hash.toString(16)}:${value.length}`;
}
export function copyRecord(text: string, ref: CopyRecord['ref'], at: number): CopyRecord {
  return { hash: hashText(text), length: normalizeClip(text).length, at, ref };
}
/**
 * Whether a selection copied from the editor should paste as a reference. A word or part of one line is usually copied to be typed
 * around ("왜 fooBar가 …"), so it stays text; lines (several, or a whole line copied with no selection) become a reference.
 */
export const copyIsReference = (text: string, wholeLine: boolean) => wholeLine || normalizeClip(text).includes('\n');
/** The reference to paste instead of `clipboard`, or null to paste it as it is (no record, another text, or too old). */
export function pasteReference(record: CopyRecord | null, clipboard: string, now: number): CopyRecord['ref'] | null {
  if (!record || !clipboard || now - record.at > COPY_RECORD_MS || now < record.at) return null;
  return hashText(clipboard) === record.hash ? record.ref : null;
}

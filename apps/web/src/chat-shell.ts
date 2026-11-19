// `!command` in the chat composer: what a typed line means, and how a run is worded on its card. Pure functions, so tests/chat-model.test.mjs can load it.

export type ShellInput =
  | { kind: 'run'; command: string }
  | { kind: 'ambiguous'; command: string } // `!중요`: looks like a message that happens to start with `!`
  | { kind: 'escaped'; text: string } // `\!중요`: a message, sent without the backslash
  | { kind: 'empty' } // a bare `!`
  | null; // an ordinary message

/**
 * `!` + a command runs it in a shell; `\!` sends a message that starts with `!`. A first word with letters outside ASCII (a Korean sentence)
 * is most likely a message, so the composer asks before running it.
 */
export function parseShellInput(raw: string): ShellInput {
  const text = raw.replace(/^\s+/, '');
  if (text.startsWith('\\!')) return { kind: 'escaped', text: text.slice(1) };
  if (!text.startsWith('!')) return null;
  const command = text.slice(1).trim();
  if (!command) return { kind: 'empty' };
  const first = command.split(/\s+/)[0];
  return /[^\x00-\x7f]/.test(first) ? { kind: 'ambiguous', command } : { kind: 'run', command };
}

/** True while the composer holds a `!` command (the composer shows its shell mode then). */
export const isShellDraft = (text: string) => /^\s*!/.test(text);

// Terminal colour and cursor sequences some programs print even without a terminal; the stored output keeps them, the card does not draw them.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\r(?!\n)/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

/** "0.4초", "12초", "2분 5초". */
export function shellDuration(ms: number): string {
  if (ms < 1000) return `${(Math.max(0, ms) / 1000).toFixed(1)}초`;
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
}

export type ShellRun = { status: string; exitCode?: number | null; signal?: string | null; error?: string };
/** The card's one-line verdict next to the command: how it ended. */
export function shellVerdict(run: ShellRun): { text: string; tone: 'ok' | 'bad' | 'warn' | 'run' } {
  switch (run.status) {
    case 'running': return { text: '실행 중', tone: 'run' };
    case 'done': return { text: '완료 · 종료 코드 0', tone: 'ok' };
    case 'failed': return { text: run.exitCode != null ? `실패 · 종료 코드 ${run.exitCode}` : `실패${run.signal ? ` · ${run.signal}` : ''}`, tone: 'bad' };
    case 'stopped': return { text: '중단함', tone: 'warn' };
    case 'timeout': return { text: '시간 초과로 중단됨', tone: 'bad' };
    case 'limit': return { text: '출력이 너무 많아 중단됨', tone: 'bad' };
    case 'interrupted': return { text: '앱이 종료되어 중단됨', tone: 'warn' };
    default: return { text: run.error ? `실행하지 못함 · ${run.error}` : '실행하지 못함', tone: 'bad' };
  }
}

/** How long a running command may be silent before the card suggests the terminal tab (a program waiting for typed input never prints again). */
export const SHELL_STALL_MS = 20_000;
export const shellStalled = (item: { status: string; startedAt: number; lastOutputAt?: number }, now: number) => item.status === 'running' && now - Math.max(item.startedAt, item.lastOutputAt ?? 0) >= SHELL_STALL_MS;

/** The note under a finished or stalled card that points to the terminal tab, or ''. */
export function terminalAdvice(item: { status: string; needsTerminal?: boolean }, stalled: boolean): string {
  if (item.needsTerminal) return '이 명령은 터미널(키보드 입력)이 필요해 보입니다. 터미널 탭에서 실행하세요.';
  if (stalled) return '출력이 없고 입력을 기다리는 중일 수 있습니다. 로그인처럼 대화형 입력이 필요한 명령은 중단하고 터미널 탭에서 실행하세요.';
  return '';
}

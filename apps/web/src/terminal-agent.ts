export type Agent = 'claude' | 'codex' | 'cursor';

// Task text and generic spinners can mention either provider; only a named title is evidence.
export const detectAgent = (title = ''): Agent | undefined => /^\s*(?:[✳⠀-⣿]\s*)?claude(?: code)?\b/i.test(title) ? 'claude' : /^\s*(?:[✳⠀-⣿]\s*)?(?:OpenAI\s+)?codex\b/i.test(title) ? 'codex'
  : /^\s*(?:[✳⠀-⣿]\s*)?cursor[- ]agent\b/i.test(title) ? 'cursor' : undefined;
// Agent CLIs animate a spinner glyph in front of their title while they work. Only the rest names the pane: passing every frame on
// re-rendered the whole workspace and sidebar several times a second per working agent.
export const stableTitle = (title: string) => title.replace(/^\s*[✳⠀-⣿]\s*/, '');
export const ANSI =/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

export function hasAgentQuestion(screen: string, title = ''): boolean {
  // Match CLI controls, rather than question marks in an agent's ordinary answer.
  // shortcut: CLI UI text is the signal; update these markers if providers change their prompt layouts.
  const composer = [...screen.matchAll(/^[ \t]*[›❯](?:[ \t]*$|[ \t]+(?![ \t]|\d+[.)](?:[ \t]|$))\S)/gm)].at(-1);
  if (composer) screen = screen.slice(composer.index);
  return !composer && /\baction required\b/i.test(title)
    || /^\s*(?:[│┃╭╰─ ]*)action required\s*[│┃ ]*$/im.test(screen)
    || /\benter\s+to\s+(?:confirm|select|submit)\b/i.test(screen) && /\besc(?:ape)?\s+to\s+(?:cancel|exit|dismiss|go back)\b/i.test(screen)
    || /(?:do you want to|would you like to)\b[^\n]*\?/i.test(screen) && /[❯›>]\s*\d+[.)]\s/.test(screen);
}

export function createQuestionTracker() {
  let pending = false, currentTitle = '', answeredTitle: string | undefined;
  return {
    input(data: string) { if (pending && /^[\r\n\x1b\x03yn1-9]$/i.test(data)) answeredTitle = currentTitle; },
    observe(screen: string, title = '') {
      if (title !== currentTitle) answeredTitle = undefined;
      currentTitle = title;
      if (!screen.trim() && !title) return pending; // A cleared frame during a TUI redraw is not a resolved question.
      pending = hasAgentQuestion(screen, title === answeredTitle ? '' : title);
      return pending;
    },
    reset() { pending = false; currentTitle = ''; answeredTitle = undefined; }
  };
}

// The server's answer (`process`) wins once it has one: the process table locally, the terminal output over ssh.
// Titles and the launcher only fill the gap before its first report.
// Over ssh the server only has the terminal output to go on, so what the window saw on its own screen (`remembered`) still counts.
// An agent that exits clears `remembered` when the server reports it gone.
export function resolveAgent(process: Agent | null | undefined, remembered: Agent | undefined, title: string | undefined, ssh = false): Agent | undefined {
  if (process) return process;
  if (process !== undefined && !ssh) return undefined;
  return detectAgent(title) || remembered;
}

export function createBannerDetector() {
  let pending = '';
  return (data: string, reset = false): Agent | undefined => {
    if (reset) pending = '';
    const raw = pending + data, plain = raw.replace(ANSI, '');
    const matches = [...plain.matchAll(/OpenAI Codex|Claude Code\s+v?\d/gi)], last = matches.at(-1);
    pending = (last ? plain.slice(last.index! + last[0].length) : raw).slice(-256);
    return last ? /^OpenAI/i.test(last[0]) ? 'codex' : 'claude' : undefined;
  };
}

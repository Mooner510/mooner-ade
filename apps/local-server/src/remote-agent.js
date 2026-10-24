// Over ssh the agent runs on the remote host, out of reach of the process table, so it is read from the terminal output instead:
// the startup banner or an agent-named title starts it, and the empty title an agent CLI restores on exit ends it.
// Kept on the server so it survives window reloads and replays that no longer hold the banner.
const OSC_TITLE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;
const BANNER = /OpenAI Codex|Claude Code\s+v?\d/gi;

const titleAgent = title => /^\s*(?:[✳⠀-⣿]\s*)?claude(?: code)?\b/i.test(title) ? 'claude' : /^\s*(?:[✳⠀-⣿]\s*)?(?:OpenAI\s+)?codex\b/i.test(title) ? 'codex'
  : /^\s*(?:[✳⠀-⣿]\s*)?cursor[- ]agent\b/i.test(title) ? 'cursor' : undefined;

export function createRemoteAgent() {
  let agent = null, pending = '';
  const banner = text => { const last = [...text.replace(ANSI, '').matchAll(BANNER)].at(-1); if (last) agent = /^OpenAI/i.test(last[0]) ? 'codex' : 'claude'; };
  return {
    get agent() { return agent; },
    // Returns whether the agent changed. The tail of the previous chunk is scanned again so a banner or title split across chunks is
    // still seen; replaying its events in order ends in the same state.
    feed(data) {
      const before = agent, raw = pending + data;
      let index = 0;
      for (const match of raw.matchAll(OSC_TITLE)) {
        banner(raw.slice(index, match.index)); index = match.index + match[0].length;
        if (!match[1].trim()) agent = null; else agent = titleAgent(match[1]) ?? agent;
      }
      banner(raw.slice(index));
      pending = raw.slice(-256);
      return agent !== before;
    },
    reset() { agent = null; pending = ''; }
  };
}

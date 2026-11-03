// OSC 7501: https://www.superlogical.com/rex/docs/build/program-status
// OSC 9;4 (ConEmu progress) is the fallback for a CLI that cannot negotiate 7501, e.g. Claude inside tmux: tmux drops the 7501 query, but
// Claude wraps its progress in tmux passthrough. Progress names no program, so it only counts once `agentOf()` has identified the agent,
// and never in a terminal whose CLI already speaks 7501 (Claude sends both locally).
const PROGRESS_STATE = { 1: 'working', 2: 'error', 3: 'working', 4: 'working' };
export function createTerminalStatus(reply, agentOf = () => null) {
  const records = new Map();
  let body = null, escaped = false, progress = null, speaks7501 = false;
  const report = (value, replay) => {
    if (value === '7501;?') { if (!replay) reply('\x1b]7501;?\x1b\\'); return; }
    if (value.startsWith('133;A')) {
      for (const [id, record] of records) if (['working', 'blocked', 'idle'].includes(record.state)) records.delete(id);
      // Back at a shell prompt: whatever runs next may be a CLI that only reports progress.
      if (progress === 'working') progress = null;
      speaks7501 = false;
      return;
    }
    const bar = /^9;4(?:;(\d*))?(?:;|$)/.exec(value);
    if (bar) {
      const next = PROGRESS_STATE[bar[1]];
      // Clearing a running bar is the end of the turn; clearing an idle one (startup, exit) changes nothing.
      progress = next ?? (progress === 'working' ? 'done' : progress ?? 'idle');
      return;
    }
    if (!value.startsWith('7501;') || Buffer.byteLength(value) + 4 > 4096) return;
    const fields = {};
    for (const pair of value.slice(5).split(':')) {
      const match = /^\s*([a-z]+)\s*=\s*([A-Za-z0-9_.,+/=-]*)\s*$/.exec(pair);
      if (!match) continue;
      if (match[1].length > 16) return;
      fields[match[1]] = match[2];
    }
    for (const [key, limit] of [['msg', 2048], ['title', 192]]) {
      if (fields[key] === undefined) continue;
      const encoded = fields[key];
      if (encoded.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(encoded)) return;
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > limit) return;
      try { if (/[\x00-\x1f\x7f-\x9f]/.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) return; }
      catch { return; }
    }
    const id = fields.id ?? '';
    if (fields.id !== undefined && (id.length > 128 || id.split('/').length > 8 || !/^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32})*$/.test(id))) return;
    if (fields.app?.length > 32) return;
    if (!['idle', 'working', 'done', 'blocked', 'error', 'clear'].includes(fields.state)) return;
    speaks7501 = true; progress = null;
    if (fields.state === 'clear') {
      for (const key of records.keys()) if (!id || key === id || key.startsWith(`${id}/`)) records.delete(key);
      return;
    }
    if (fields.app && !/^[A-Za-z0-9_.+-]{1,32}$/.test(fields.app)) delete fields.app;
    records.delete(id); records.set(id, { state: fields.state, app: fields.app });
    if (records.size > 256) records.delete(records.keys().next().value);
  };
  return {
    // What the CLI said about itself over 7501, the only report that names its program. Agent identification reads this, not `status`,
    // which would otherwise echo the identification back through the progress fallback.
    get reported() {
      let result = null;
      const priority = ['idle', 'done', 'error', 'working', 'blocked'];
      for (const [id, record] of records) {
        let parent = id, app = record.app;
        while (!app && parent) { parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; app = records.get(parent)?.app; }
        const agent = app === 'claude-code' ? 'claude' : app === 'codex' ? 'codex' : undefined;
        if (agent && (!result || priority.indexOf(record.state) > priority.indexOf(result.state))) result = { agent, state: record.state };
      }
      return result;
    },
    // `source: 'progress'` tells the window that questions are not reported and must still be read from the screen.
    get status() {
      const reported = this.reported;
      if (reported || speaks7501 || !progress) return reported;
      const agent = agentOf();
      return agent ? { agent, state: progress, source: 'progress' } : null;
    },
    feed(data, replay = false) {
      for (const char of data) {
        if (escaped) {
          escaped = false;
          if (body !== null && char === '\\') { report(body, replay); body = null; }
          else if (char === ']') body = '';
          else { body = null; if (char === 'c') { records.clear(); progress = null; speaks7501 = false; } escaped = char === '\x1b'; }
        } else if (char === '\x1b') escaped = true;
        else if (body !== null) {
          if (char === '\x07') { report(body, replay); body = null; }
          else if (body.length >= 4096) body = null;
          else body += char;
        }
      }
    },
    clear() { records.clear(); progress = null; speaks7501 = false; }
  };
}

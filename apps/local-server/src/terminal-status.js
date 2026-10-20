// OSC 7501: https://www.superlogical.com/rex/docs/build/program-status
export function createTerminalStatus(reply) {
  const records = new Map();
  let body = null, escaped = false;
  const report = (value, replay) => {
    if (value === '7501;?') { if (!replay) reply('\x1b]7501;?\x1b\\'); return; }
    if (value.startsWith('133;A')) {
      for (const [id, record] of records) if (['working', 'blocked', 'idle'].includes(record.state)) records.delete(id);
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
    if (fields.state === 'clear') {
      for (const key of records.keys()) if (!id || key === id || key.startsWith(`${id}/`)) records.delete(key);
      return;
    }
    if (fields.app && !/^[A-Za-z0-9_.+-]{1,32}$/.test(fields.app)) delete fields.app;
    records.delete(id); records.set(id, { state: fields.state, app: fields.app });
    if (records.size > 256) records.delete(records.keys().next().value);
  };
  return {
    get status() {
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
    feed(data, replay = false) {
      for (const char of data) {
        if (escaped) {
          escaped = false;
          if (body !== null && char === '\\') { report(body, replay); body = null; }
          else if (char === ']') body = '';
          else { body = null; if (char === 'c') records.clear(); escaped = char === '\x1b'; }
        } else if (char === '\x1b') escaped = true;
        else if (body !== null) {
          if (char === '\x07') { report(body, replay); body = null; }
          else if (body.length >= 4096) body = null;
          else body += char;
        }
      }
    },
    clear() { records.clear(); }
  };
}

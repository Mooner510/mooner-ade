// Append-only record of Chat turns and plan-limit snapshots.
// Chat folders can be deleted; this directory is not. Lines are never rewritten.
// A turn copied by /clear has the same provider session, time, status and tokens, so the second copy is skipped.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tokenWeight } from './chat-stats.js';
import { createAccountBook, dirAccountKey, identityFromProfile, keyAccount, providers, unknownKeyAccount } from './usage-accounts.js';
import { EVAL_HOLD, EVAL_WORDING, buildReport, evaluationFingerprint, scopeKey } from './usage-report.js';

const sha = value => createHash('sha256').update(String(value)).digest('hex');
const num = value => Number.isFinite(value) ? value : 0;
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const tokenOf = raw => ({ input: num(raw?.input), output: num(raw?.output), cacheRead: num(raw?.cacheRead), cacheCreate: num(raw?.cacheCreate) });
const tokenSum = tokens => [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreate].join(',');
const add = (left, right) => ({ input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cacheCreate: left.cacheCreate + right.cacheCreate });
const diff = (next, prev) => ({ input: Math.max(0, next.input - prev.input), output: Math.max(0, next.output - prev.output), cacheRead: Math.max(0, next.cacheRead - prev.cacheRead), cacheCreate: Math.max(0, next.cacheCreate - prev.cacheCreate) });
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max) : '';
const STATUSES = new Set(['success', 'interrupted', 'failed']);
const SNAPSHOT_GAP = 15 * 60_000;
const TOOL_KEEP = 8;

export function turnIdentity({ projectId, chatId, seq, at, provider, sessionId, status, tokens }) {
  const sum = tokenSum(tokens);
  const id = Number.isSafeInteger(seq) ? sha(`${projectId}\0${chatId}\0${seq}`) : sha(`${projectId}\0${chatId}\0${at}\0${status}\0${sum}`);
  const dedupe = sha(`${provider}\0${sessionId || projectId || ''}\0${at}\0${status}\0${sum}`);
  return { id, dedupe };
}

const blankCursor = () => ({ tokens: zero(), cost: null, model: '', context: 0, tools: {}, toolIds: {}, calls: 0, errors: 0, compactions: 0, sawSnapshot: false });

// One pass over chat events. `usage` tokens are a cumulative snapshot (Codex, Cursor).
// `result.usage` is that turn's own tokens (Claude) and is used only when no snapshot arrived since the previous result.
export function consumeEvents(events, start, ctx) {
  const cursor = { ...blankCursor(), ...start, tokens: { ...zero(), ...(start?.tokens || {}) }, tools: { ...(start?.tools || {}) }, toolIds: { ...(start?.toolIds || {}) } };
  const turns = [], marks = [];
  const resetTools = () => { cursor.tools = {}; cursor.calls = 0; cursor.errors = 0; cursor.compactions = 0; };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.model) cursor.model = clean(event.model, 120);
    if (event.kind === 'settings' && event.model) cursor.model = clean(event.model, 120);
    if (event.kind === 'session' && event.model) cursor.model = clean(event.model, 120);
    if (event.kind === 'title') {
      const title = clean(event.text, 120);
      if (title) marks.push({ kind: 'title', projectId: ctx.projectId, chatId: ctx.chatId, title, at: event.at || 0, provider: ctx.provider });
    }
    if (event.kind === 'rewind' && event.uuid) marks.push({ kind: 'rewind', projectId: ctx.projectId, chatId: ctx.chatId, uuid: clean(event.uuid, 80), at: event.at || 0 });
    if (event.kind === 'compact') cursor.compactions += 1;
    if (event.kind === 'divider') { cursor.tokens = zero(); cursor.cost = null; cursor.sawSnapshot = false; resetTools(); continue; }
    if (event.kind === 'message') for (const block of event.blocks || []) {
      if (block?.type !== 'tool_use' || !block.name || cursor.toolIds[block.id]) continue;
      const name = clean(block.name, 80) || 'tool';
      if (block.id) cursor.toolIds[block.id] = name;
      const row = cursor.tools[name] ?? { name, count: 0, errors: 0 };
      row.count += 1; cursor.tools[name] = row; cursor.calls += 1;
    }
    if (event.kind === 'tool_result' && event.isError) {
      const name = cursor.toolIds[event.toolUseId];
      if (name && cursor.tools[name]) cursor.tools[name].errors += 1;
      cursor.errors += 1;
    }
    if (event.kind === 'usage' && event.tokens) { cursor.pending = tokenOf(event.tokens); cursor.sawSnapshot = true; if (Number.isFinite(event.contextTokens)) cursor.context = event.contextTokens; }
    if (event.kind !== 'result' || !STATUSES.has(event.status)) continue;
    const own = tokenOf(event.usage);
    const tokens = cursor.sawSnapshot && cursor.pending ? diff(cursor.pending, cursor.tokens) : own;
    if (cursor.sawSnapshot && cursor.pending) cursor.tokens = { ...cursor.pending };
    else cursor.tokens = add(cursor.tokens, own);
    cursor.sawSnapshot = false;
    let turnCostUsd = null;
    if (Number.isFinite(event.turnCostUsd)) turnCostUsd = event.turnCostUsd;
    else if (Number.isFinite(event.costUsd)) turnCostUsd = cursor.cost === null ? event.costUsd : Math.max(0, event.costUsd - cursor.cost);
    if (Number.isFinite(event.costUsd) && event.costUsd >= 0) cursor.cost = event.costUsd;
    const tools = Object.values(cursor.tools).sort((a, b) => b.count - a.count).slice(0, TOOL_KEEP).map(tool => ({ name: tool.name, count: tool.count, errors: tool.errors }));
    turns.push({
      at: event.at || 0, seq: event.seq, projectId: ctx.projectId, chatId: ctx.chatId, sessionId: clean(event.sessionId || ctx.sessionId, 120),
      provider: ctx.provider, accountKey: ctx.accountKey, auth: ctx.auth === 'key' ? 'key' : 'login', model: cursor.model || 'unknown',
      tokens, turnCostUsd, status: event.status, durationMs: num(event.durationMs), toolCalls: cursor.calls, toolErrors: cursor.errors,
      tools, compactions: cursor.compactions, contextTokens: cursor.context, source: ctx.source, deviceId: ctx.deviceId, projectLabel: ctx.projectLabel
    });
    resetTools();
  }
  const ids = Object.keys(cursor.toolIds);
  if (ids.length > 400) for (const id of ids.slice(0, ids.length - 400)) delete cursor.toolIds[id];
  delete cursor.pending;
  return { turns, marks, cursor };
}

const zoneOf = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const partsOf = (at, timeZone) => {
  const bag = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(new Date(at))) bag[part.type] = part.value;
  return bag;
};
const dayKey = (at, timeZone) => { const part = partsOf(at, timeZone); return `${part.year}-${part.month}-${part.day}`; };
const weekKey = (at, timeZone) => {
  const part = partsOf(at, timeZone);
  const index = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[part.weekday] ?? 0;
  const date = new Date(Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day)));
  date.setUTCDate(date.getUTCDate() - index);
  return date.toISOString().slice(0, 10);
};
const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : 0;

const rowAdd = (map, key, label, turn) => {
  const row = map.get(key) ?? { key, label, turns: 0, weight: 0, costUsd: null };
  row.turns += 1; row.weight += tokenWeight(turn.tokens);
  if (turn.turnCostUsd !== null) row.costUsd = (row.costUsd ?? 0) + turn.turnCostUsd;
  map.set(key, row);
};

export function summarize(records, { from = 0, to = Infinity, providers: wanted, projectId, accountKey, auth, device, deviceLabel, devices, timeZone = zoneOf(), book, sessionOffset = 0, sessionLimit = 50, snapshots = [], projectLabel = '', marks = [] } = {}) {
  const turns = records.filter(turn => {
    if (turn.at < from || turn.at > to) return false;
    if (wanted?.length && !wanted.includes(turn.provider)) return false;
    if (projectId && turn.projectId !== projectId) return false;
    if (auth && turn.auth !== auth) return false;
    if (device && device !== 'all' && device !== 'local' && turn.deviceId !== device) return false;
    if (device === 'local' && turn.remote) return false;
    if (accountKey && book.resolve(turn.accountKey) !== accountKey && turn.accountKey !== accountKey) return false;
    return true;
  });
  const tokens = zero();
  let weight = 0, costUsd = 0, costTurns = 0, unknownCostTurns = 0, success = 0, failed = 0, interrupted = 0, activeMs = 0, compactions = 0, unknownTurns = 0, aliasedTurns = 0;
  const byDay = new Map(), byWeek = new Map(), byProject = new Map(), byProvider = new Map(), byAccount = new Map(), byModel = new Map(), byTool = new Map(), sessions = new Map();
  for (const turn of turns) {
    tokens.input += turn.tokens.input; tokens.output += turn.tokens.output; tokens.cacheRead += turn.tokens.cacheRead; tokens.cacheCreate += turn.tokens.cacheCreate;
    const weighed = tokenWeight(turn.tokens); weight += weighed; activeMs += turn.durationMs || 0; compactions += turn.compactions || 0;
    if (turn.status === 'failed') failed += 1; else if (turn.status === 'interrupted') interrupted += 1; else success += 1;
    if (turn.turnCostUsd === null) unknownCostTurns += 1; else { costTurns += 1; costUsd += turn.turnCostUsd; }
    const resolved = book.resolve(turn.accountKey);
    if (String(turn.accountKey).startsWith('unknown:')) {
      if (book.aliased(turn.accountKey)) aliasedTurns += 1;
      else unknownTurns += 1;
    }
    const day = dayKey(turn.at, timeZone), week = weekKey(turn.at, timeZone);
    byDay.set(day, { day, turns: (byDay.get(day)?.turns || 0) + 1, weight: (byDay.get(day)?.weight || 0) + weighed });
    byWeek.set(week, { week, turns: (byWeek.get(week)?.turns || 0) + 1, weight: (byWeek.get(week)?.weight || 0) + weighed });
    rowAdd(byProject, turn.projectId, turn.projectLabel || turn.projectId.slice(0, 8), turn);
    rowAdd(byProvider, turn.provider, turn.provider === 'claude' ? 'Claude Code' : turn.provider === 'codex' ? 'Codex' : turn.provider === 'cursor' ? 'Cursor' : turn.provider, turn);
    const account = book.get(resolved);
    rowAdd(byAccount, resolved, account?.label || (String(resolved).startsWith('unknown:') ? '당시 계정 미기록' : resolved), turn);
    rowAdd(byModel, turn.model || 'unknown', turn.model || 'unknown', turn);
    for (const tool of turn.tools || []) {
      const row = byTool.get(tool.name) ?? { name: tool.name, count: 0, errors: 0 };
      row.count += tool.count; row.errors += tool.errors; byTool.set(tool.name, row);
    }
    const sessionKey = `${turn.deviceId}\0${turn.projectId}\0${turn.chatId}`;
    const session = sessions.get(sessionKey) ?? { deviceId: turn.deviceId, projectId: turn.projectId, chatId: turn.chatId, title: turn.projectLabel ? '' : '', provider: turn.provider, accountKey: resolved, model: turn.model, turns: 0, weight: 0, costUsd: null, firstAt: turn.at, lastAt: turn.at, projectLabel: turn.projectLabel || '' };
    session.turns += 1; session.weight += weighed; session.lastAt = Math.max(session.lastAt, turn.at); session.firstAt = Math.min(session.firstAt, turn.at);
    session.model = turn.model || session.model; session.accountKey = resolved; session.provider = turn.provider;
    if (turn.turnCostUsd !== null) session.costUsd = (session.costUsd ?? 0) + turn.turnCostUsd;
    sessions.set(sessionKey, session);
  }
  for (const mark of marks) {
    if (mark.kind !== 'title') continue;
    const session = sessions.get(`${mark.deviceId || ''}\0${mark.projectId}\0${mark.chatId}`);
    if (session && mark.title) session.title = mark.title;
  }
  const rows = [...sessions.values()].sort((a, b) => b.lastAt - a.lastAt);
  for (const row of rows) if (!row.title) row.title = `대화 ${row.chatId.slice(0, 8)}`;
  const lengths = rows.map(row => row.turns).sort((a, b) => a - b);
  const inputFamily = tokens.input + tokens.cacheRead + tokens.cacheCreate;
  const labelOf = key => book.get(key)?.label || key;
  const summary = {
    timeZone, from, to, device: device || 'local', deviceLabel, devices, providersFilter: wanted || [], projectFilter: projectId || '', projectLabel, accountFilter: accountKey || '', accountLabel: accountKey ? labelOf(accountKey) : '', authFilter: auth || '',
    turns: turns.length, sessions: rows.length, tokens, weight, costUsd: costTurns ? costUsd : null, costTurns, unknownCostTurns,
    success, failed, interrupted, activeMs, compactions, unknownTurns, aliasedTurns,
    cacheHitRate: inputFamily > 0 ? tokens.cacheRead / inputFamily : null, inputFamily,
    tools: [...byTool.values()].sort((a, b) => b.count - a.count),
    models: [...byModel.values()].sort((a, b) => b.weight - a.weight),
    providers: [...byProvider.values()].sort((a, b) => b.turns - a.turns),
    accounts: [...byAccount.values()].sort((a, b) => b.turns - a.turns),
    projects: [...byProject.values()].sort((a, b) => b.turns - a.turns),
    days: [...byDay.values()].sort((a, b) => a.day < b.day ? -1 : 1),
    weeks: [...byWeek.values()].sort((a, b) => a.week < b.week ? -1 : 1),
    sessionSpread: { count: rows.length, median: quantile(lengths, 0.5), p90: quantile(lengths, 0.9), long: [...rows].sort((a, b) => b.turns - a.turns).slice(0, 5).map(row => ({ title: row.title, turns: row.turns, chatId: row.chatId, projectId: row.projectId })) },
    sessionPage: { total: rows.length, offset: sessionOffset, rows: rows.slice(sessionOffset, sessionOffset + sessionLimit) },
    snapshots: snapshots.filter(shot => shot.at >= from && shot.at <= to && (!wanted?.length || wanted.includes(shot.provider)) && (!accountKey || book.resolve(shot.accountKey) === accountKey || shot.accountKey === accountKey) && !(device === 'local' && shot.remote) && !(device && device !== 'all' && device !== 'local' && shot.deviceId !== device))
  };
  return summary;
}

const appendLine = async (file, line) => {
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.appendFile(`${line}\n`); await handle.sync(); }
  finally { await handle.close(); }
};

const readJsonl = async file => {
  const text = await fs.readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped; the next append continues after it */ }
  }
  return rows;
};

export function createUsageLedger({ root, deviceId, now = Date.now, keyOf = (_provider, key) => key, timeZone = zoneOf }) {
  const turnsFile = path.join(root, 'turns.jsonl');
  const snapshotsFile = path.join(root, 'snapshots.jsonl');
  const marksFile = path.join(root, 'marks.jsonl');
  const stateFile = path.join(root, 'state.json');
  const daysFile = path.join(root, 'days', 'index.json');
  const evalFile = path.join(root, 'evaluations.json');
  const remoteDir = path.join(root, 'remote');
  const book = createAccountBook({ file: path.join(root, 'accounts.json'), now });
  const deviceName = clean(os.hostname(), 80) || '이 기기';
  let turns = [], snapshots = [], marks = [], remote = [], evals = { entries: {} }, state = { cursors: {}, hubSent: 0, seq: 0, remoteSince: {}, remoteAfter: {} };
  const ids = new Set(), dedupes = new Set();
  let chain = Promise.resolve();
  let opened = null;
  const exclusive = job => {
    const run = chain.then(job, job);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const open = () => { opened ??= load(); return opened; };

  async function load() {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.mkdir(remoteDir, { recursive: true, mode: 0o700 });
    await book.load();
    try { state = { cursors: {}, hubSent: 0, seq: 0, remoteSince: {}, remoteAfter: {}, ...JSON.parse(await fs.readFile(stateFile, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`사용 기록 상태를 읽지 못했습니다: ${error.message}`); }
    try { const saved = JSON.parse(await fs.readFile(evalFile, 'utf8')); if (saved?.entries) evals = saved; }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`사용 평가를 읽지 못했습니다: ${error.message}`); }
    turns = await readJsonl(turnsFile);
    snapshots = await readJsonl(snapshotsFile);
    marks = await readJsonl(marksFile);
    for (const turn of turns) { ids.add(turn.id); if (turn.dedupe) dedupes.add(turn.dedupe); }
    for (const mark of marks) ids.add(mark.id);
    for (const shot of snapshots) ids.add(shot.id);
    const files = await fs.readdir(remoteDir).catch(() => []);
    for (const name of files) if (name.endsWith('.jsonl')) remote.push(...(await readJsonl(path.join(remoteDir, name))).map(row => ({ ...row, remote: true, deviceId: row.deviceId || name.replace(/\.jsonl$/, '') })));
  }
  // Same scope keeps its sentences for EVAL_HOLD after the numbers move, and after that while the fingerprint is unchanged.
  const remember = async (key, summary) => {
    const fingerprint = evaluationFingerprint(summary);
    const stored = evals.entries[key];
    const hasTurns = summary.turns > 0;
    if (stored?.wording === EVAL_WORDING && stored.hasTurns === hasTurns && (now() - stored.at < EVAL_HOLD || stored.fingerprint === fingerprint)) return stored.report;
    const report = buildReport(summary);
    evals.entries[key] = { at: now(), wording: EVAL_WORDING, fingerprint, report, hasTurns };
    const keys = Object.keys(evals.entries);
    if (keys.length > 80) for (const old of keys.sort((a, b) => evals.entries[a].at - evals.entries[b].at).slice(0, keys.length - 80)) delete evals.entries[old];
    const tmp = `${evalFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(evals), { mode: 0o600 });
    await fs.rename(tmp, evalFile);
    return report;
  };
  const persistState = async () => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, stateFile);
  };

  const accountFor = (meta, info, source) => {
    const provider = providers.includes(meta?.agent) ? meta.agent : providers.includes(info.agent) ? info.agent : 'claude';
    const configDir = meta?.configDir || info.configDir || '';
    const auth = info.auth || meta?.auth || 'login';
    if (auth === 'key') {
      if (source === 'live' && info.apiKey) {
        const identity = keyAccount(provider, keyOf(provider, info.apiKey));
        book.note(identity);
        return identity;
      }
      const identity = unknownKeyAccount(provider, configDir);
      book.note(identity);
      return identity;
    }
    const dirKey = dirAccountKey(provider, configDir);
    if (source === 'live') {
      const resolved = book.resolve(dirKey);
      const known = book.get(resolved);
      if (known && resolved !== dirKey) return { ...known, auth: 'login' };
    }
    const identity = book.get(dirKey) || identityFromProfile(provider, null, configDir);
    book.note({ ...identity, accountKey: dirKey, stable: false, label: identity.label || '당시 계정 미기록' });
    return { accountKey: dirKey, label: '당시 계정 미기록', stable: false, provider, auth: 'login' };
  };

  async function ingestFile(info) {
    return exclusive(async () => {
      await open();
      const file = info.file;
      let stat; try { stat = await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') return { wrote: 0 }; throw error; }
      const saved = state.cursors[file] || { offset: 0, cursor: blankCursor() };
      let offset = Number(saved.offset) || 0;
      if (offset > stat.size) offset = 0;
      const handle = await fs.open(file, 'r');
      let text;
      try {
        const length = stat.size - offset;
        if (length <= 0) return { wrote: 0 };
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, offset);
        text = buffer.toString('utf8');
      } finally { await handle.close(); }
      const source = offset > 0 ? 'live' : 'backfill';
      let meta = info.meta;
      if (!meta) {
        try { meta = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'meta.json'), 'utf8')); } catch { meta = {}; }
      }
      const identity = accountFor(meta, info, source);
      const events = [];
      let consumed = 0;
      const lines = text.split('\n');
      const complete = text.endsWith('\n') ? lines.length - 1 : Math.max(0, lines.length - 1);
      for (let index = 0; index < complete; index++) {
        const line = lines[index];
        consumed += Buffer.byteLength(line) + 1;
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* skip a bad line and keep going */ }
      }
      if (!events.length && consumed === 0) return { wrote: 0 };
      const projectLabel = clean(path.basename(meta?.cwd || meta?.worktreePath || info.cwd || ''), 80) || info.projectId.slice(0, 8);
      const { turns: found, marks: foundMarks, cursor } = consumeEvents(events, offset > 0 ? saved.cursor : blankCursor(), {
        projectId: info.projectId, chatId: info.chatId, provider: identity.provider, accountKey: identity.accountKey,
        auth: identity.auth, sessionId: info.sessionId || meta?.sessionId || '', source, deviceId, projectLabel
      });
      let wrote = 0;
      for (const turn of found) {
        const identityKey = turnIdentity(turn);
        const row = { ...turn, ...identityKey, deviceId };
        if (ids.has(row.id) || dedupes.has(row.dedupe)) continue;
        row.n = ++state.seq;
        await appendLine(turnsFile, JSON.stringify(row));
        ids.add(row.id); dedupes.add(row.dedupe); turns.push(row); wrote += 1;
      }
      for (const mark of foundMarks) {
        const id = sha(`${mark.kind}\0${mark.projectId}\0${mark.chatId}\0${mark.at}\0${mark.title || mark.uuid || ''}`);
        if (ids.has(id)) continue;
        const row = { ...mark, id, n: ++state.seq, deviceId };
        await appendLine(marksFile, JSON.stringify(row));
        ids.add(id); marks.push(row); wrote += 1;
      }
      state.cursors[file] = { offset: offset + consumed, cursor };
      await persistState();
      await writeDays();
      return { wrote };
    });
  }

  async function writeDays() {
    const stat = await fs.stat(turnsFile).catch(() => null);
    const days = new Map();
    for (const turn of turns) {
      const day = dayKey(turn.at, timeZone());
      const row = days.get(day) ?? { day, turns: 0, weight: 0 };
      row.turns += 1; row.weight += tokenWeight(turn.tokens); days.set(day, row);
    }
    await fs.mkdir(path.dirname(daysFile), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ sourceBytes: stat?.size ?? 0, days: [...days.values()] });
    await fs.writeFile(daysFile, body, { mode: 0o600 });
  }

  const localTurns = () => turns.map(turn => ({ ...turn, remote: false, deviceId: turn.deviceId || deviceId }));
  const remoteTurns = () => remote.filter(row => row.tokens && row.kind !== 'snapshot');
  const poolOf = device => device === 'all' ? [...localTurns(), ...remoteTurns()] : device === 'local' ? localTurns() : remoteTurns().filter(row => row.deviceId === device);
  const shotsOf = device => device === 'all' ? [...snapshots, ...remote.filter(row => row.kind === 'snapshot')] : device === 'local' ? snapshots : remote.filter(row => row.kind === 'snapshot' && row.deviceId === device);
  const titleMarks = () => [...marks.map(mark => ({ ...mark, deviceId: mark.deviceId || deviceId })), ...remote.filter(row => row.kind === 'title')];

  return {
    root, deviceId, deviceName,
    open, ingestFile,
    async backfill(dataRoot) {
      await open();
      const entries = await fs.readdir(dataRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'usage-ledger') continue;
        const chatRoot = path.join(dataRoot, entry.name, 'chat');
        const chats = await fs.readdir(chatRoot, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
        for (const chat of chats) {
          if (!chat.isDirectory()) continue;
          await ingestFile({ file: path.join(chatRoot, chat.name, 'events.jsonl'), projectId: entry.name, chatId: chat.name });
        }
      }
    },
    observeLogin(identity, configDir) {
      return exclusive(async () => {
        await open();
        if (!identity?.accountKey) return;
        book.note(identity);
        if (identity.stable) book.aliasSingle(dirAccountKey(identity.provider, configDir || ''), identity.accountKey);
        await book.flush();
      });
    },
    observeSnapshot(reading) {
      return exclusive(async () => {
        await open();
        if (!reading?.identity || !providers.includes(reading.provider)) return false;
        const identity = reading.identity;
        book.note(identity);
        if (identity.stable) book.aliasSingle(dirAccountKey(identity.provider, reading.account?.dir || ''), identity.accountKey);
        const windows = (reading.windows || []).map(item => ({ key: item.key, label: item.label, percent: item.percent, resetsAt: item.resetsAt ?? null }));
        if (!windows.length && !reading.plan) return false;
        const accountKey = identity.accountKey;
        const at = reading.at || now();
        const signature = JSON.stringify(windows);
        const previous = [...snapshots].reverse().find(shot => shot.provider === reading.provider && shot.accountKey === accountKey && !shot.remote);
        if (previous && previous.signature === signature && at - previous.at < SNAPSHOT_GAP) return false;
        const row = { id: sha(`${deviceId}\0${reading.provider}\0${accountKey}\0${at}\0${signature}`), kind: 'snapshot', at, provider: reading.provider, accountKey, plan: clean(reading.plan, 80), windows, deviceId, deviceName, signature, n: 0 };
        if (ids.has(row.id)) return false;
        row.n = ++state.seq;
        await appendLine(snapshotsFile, JSON.stringify(row));
        ids.add(row.id); snapshots.push(row); await persistState();
        return true;
      });
    },
    review(input = {}) {
      return exclusive(async () => {
        await open();
        const stat = await fs.stat(turnsFile).catch(() => null);
        const cache = await fs.readFile(daysFile, 'utf8').then(text => JSON.parse(text), () => null);
        if (!cache || cache.sourceBytes !== (stat?.size ?? 0)) await writeDays();
        const from = Number.isFinite(input.from) ? input.from : 0;
        const to = Number.isFinite(input.to) ? input.to : now();
        const wanted = Array.isArray(input.providers) ? input.providers.filter(item => providers.includes(item)) : [];
        const device = input.device === 'all' || (typeof input.device === 'string' && input.device && input.device !== 'local') ? input.device : 'local';
        const pool = poolOf(device);
        const catalog = { projects: [...new Map(pool.map(turn => [turn.projectId, turn.projectLabel || turn.projectId.slice(0, 8)])).entries()].map(([id, label]) => ({ id, label })), accounts: book.list().map(item => ({ accountKey: item.accountKey, label: item.label, provider: item.provider, auth: item.auth })) };
        const summary = summarize(pool, {
          from, to, providers: wanted, projectId: clean(input.projectId, 80), accountKey: clean(input.accountKey, 160), auth: input.auth === 'key' || input.auth === 'login' ? input.auth : '',
          device, deviceLabel: device === 'local' ? deviceName : remoteName(device), devices: deviceList(), timeZone: timeZone(), book, marks: titleMarks(),
          sessionOffset: Number.isSafeInteger(input.sessionOffset) ? input.sessionOffset : 0, sessionLimit: Math.min(100, Number.isSafeInteger(input.sessionLimit) ? input.sessionLimit : 50),
          snapshots: shotsOf(device), projectLabel: clean(input.projectLabel, 80)
        });
        summary.report = await remember(scopeKey({ from, to, providers: wanted, projectId: summary.projectFilter, accountKey: summary.accountFilter, auth: input.auth === 'key' || input.auth === 'login' ? input.auth : '', device }, now()), summary);
        return { ...summary, deviceId, deviceName, catalog };
      });
    },
    session(input = {}) {
      return exclusive(async () => {
        await open();
        const projectId = clean(input.projectId, 80), chatId = clean(input.chatId, 80);
        const device = input.deviceId && input.deviceId !== deviceId ? input.deviceId : 'local';
        const pool = device === 'local' ? localTurns() : remote.filter(row => row.deviceId === device && row.tokens);
        const rows = pool.filter(turn => turn.projectId === projectId && turn.chatId === chatId).sort((a, b) => a.at - b.at);
        const summary = summarize(rows, { from: 0, to: Infinity, device, deviceLabel: device === 'local' ? deviceName : remoteName(device), devices: deviceList(), timeZone: timeZone(), book, marks: titleMarks(), sessionLimit: 1 });
        const title = marks.find(mark => mark.kind === 'title' && mark.projectId === projectId && mark.chatId === chatId)?.title || rows[0]?.projectLabel || `대화 ${chatId.slice(0, 8)}`;
        const report = await remember(scopeKey({ session: { device, projectId, chatId } }), summary);
        return { title, turns: rows, report, summary: { turns: rows.length, weight: summary.weight, costUsd: summary.costUsd, tokens: summary.tokens, cacheHitRate: summary.cacheHitRate } };
      });
    },
    pending(limit = 80) {
      return exclusive(async () => {
        await open();
        const cap = Math.min(100, Math.max(1, limit || 80));
        const rows = [...turns, ...snapshots, ...marks].filter(row => row.n > state.hubSent).sort((a, b) => a.n - b.n).slice(0, cap);
        return {
          deviceId, deviceName, platform: process.platform, remoteSince: state.remoteSince || {}, remoteAfter: state.remoteAfter || {},
          records: rows.map(row => ({ n: row.n, id: row.id, kind: row.kind || 'turn', at: row.at, payload: payloadOf(row) })),
          upto: rows.at(-1)?.n ?? state.hubSent, more: rows.length === cap
        };
      });
    },
    ack(n) {
      return exclusive(async () => {
        await open();
        if (Number.isSafeInteger(n) && n > state.hubSent) { state.hubSent = n; await persistState(); }
        return { hubSent: state.hubSent };
      });
    },
    importRemote(body) {
      return exclusive(async () => {
        await open();
        let imported = 0;
        for (const batch of body?.batches || []) {
          const id = clean(batch.localId, 80);
          if (!id || id === deviceId) continue;
          state.remoteDevices = { ...(state.remoteDevices || {}), [id]: { name: clean(batch.name, 80) || id, platform: clean(batch.platform, 32) } };
          const file = path.join(remoteDir, `${id}.jsonl`);
          let maxAt = state.remoteSince?.[id] || 0;
          let lastId = state.remoteAfter?.[id] || '';
          for (const record of batch.records || []) {
            const recordId = clean(record.id, 80);
            const at = Number(record.at);
            if (!recordId || !Number.isFinite(at) || ids.has(`${id}:${recordId}`)) continue;
            const row = remoteRow(recordId, record.kind, at, id, record.payload);
            if (!row) continue;
            await appendLine(file, JSON.stringify(row));
            ids.add(`${id}:${recordId}`);
            remote.push(row);
            if (at > maxAt || (at === maxAt && recordId > lastId)) { maxAt = at; lastId = recordId; }
            imported += 1;
          }
          const previous = state.remoteSince?.[id] || 0;
          const cursorAt = Number.isFinite(Number(batch.since)) ? Number(batch.since) : maxAt;
          const cursorId = clean(batch.after, 80) || lastId;
          if (cursorAt >= previous) {
            state.remoteSince = { ...(state.remoteSince || {}), [id]: cursorAt };
            if (cursorId) state.remoteAfter = { ...(state.remoteAfter || {}), [id]: cursorId };
          }
        }
        await persistState();
        return { imported };
      });
    },
    async readDayCache() {
      try { return JSON.parse(await fs.readFile(daysFile, 'utf8')); } catch { return null; }
    },
    async dayCacheFresh() {
      const cache = await this.readDayCache();
      const stat = await fs.stat(turnsFile).catch(() => null);
      return Boolean(cache && stat && cache.sourceBytes === stat.size);
    },
    book
  };

  function deviceList() {
    const list = [{ id: deviceId, name: deviceName, local: true }];
    for (const [id, item] of Object.entries(state.remoteDevices || {})) list.push({ id, name: item.name, local: false });
    return list;
  }
  function remoteName(id) { return state.remoteDevices?.[id]?.name || id; }
}

const remoteRow = (recordId, kind, at, deviceId, payload) => {
  const body = payload && typeof payload === 'object' ? payload : {};
  const base = { id: recordId, kind, at, deviceId, remote: true };
  if (kind === 'snapshot') return { ...base, provider: providers.includes(body.provider) ? body.provider : '', accountKey: clean(body.accountKey, 160), plan: clean(body.plan, 80), windows: Array.isArray(body.windows) ? body.windows.slice(0, 8).map(item => ({ key: clean(item?.key, 40), label: clean(item?.label, 40), percent: num(item?.percent), resetsAt: Number.isFinite(item?.resetsAt) ? item.resetsAt : null })) : [], deviceName: clean(body.deviceName, 80) };
  if (kind === 'mark') return { ...base, projectId: clean(body.projectId, 80), chatId: clean(body.chatId, 80), title: clean(body.title, 120), uuid: clean(body.uuid, 80), provider: providers.includes(body.provider) ? body.provider : '' };
  if (kind !== 'turn' || !providers.includes(body.provider)) return null;
  return {
    ...base, projectId: clean(body.projectId, 80), chatId: clean(body.chatId, 80), sessionId: clean(body.sessionId, 80), provider: body.provider,
    accountKey: clean(body.accountKey, 160), auth: body.auth === 'key' ? 'key' : 'login', model: clean(body.model, 80), tokens: tokenOf(body.tokens),
    turnCostUsd: Number.isFinite(body.turnCostUsd) ? body.turnCostUsd : null, status: STATUSES.has(body.status) ? body.status : 'success',
    durationMs: num(body.durationMs), toolCalls: num(body.toolCalls), toolErrors: num(body.toolErrors),
    tools: Array.isArray(body.tools) ? body.tools.slice(0, 8).map(tool => ({ name: clean(tool?.name, 40), count: num(tool?.count), errors: num(tool?.errors) })).filter(tool => tool.name) : [],
    compactions: num(body.compactions), contextTokens: Number.isFinite(body.contextTokens) ? body.contextTokens : null,
    source: body.source === 'live' ? 'live' : 'backfill', projectLabel: clean(body.projectLabel, 80)
  };
};

const payloadOf = row => {
  if (row.kind === 'snapshot') return { provider: row.provider, accountKey: row.accountKey, plan: row.plan, windows: row.windows, deviceName: row.deviceName };
  if ((row.kind || 'turn') !== 'turn') return { kind: row.kind, projectId: row.projectId, chatId: row.chatId, title: row.title, uuid: row.uuid, provider: row.provider };
  return {
    projectId: row.projectId, chatId: row.chatId, sessionId: row.sessionId, provider: row.provider, accountKey: row.accountKey,
    auth: row.auth, model: row.model, tokens: row.tokens, turnCostUsd: row.turnCostUsd, status: row.status, durationMs: row.durationMs,
    toolCalls: row.toolCalls, toolErrors: row.toolErrors, tools: row.tools, compactions: row.compactions, contextTokens: row.contextTokens,
    source: row.source, projectLabel: row.projectLabel
  };
};

const count = value => Math.round(value).toLocaleString('ko-KR');
const pct = value => `${(value * 100).toFixed(1)}%`;
const providerName = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const finding = (id, tone, title, text) => ({ id, tone, title, text });

// Shown text stays put for this long even after the numbers move, and stays after that while the numbers are the same.
// Bumping the wording drops a stored paragraph once, then the hold applies to the new sentences.
export const EVAL_HOLD = 6 * 60 * 60 * 1000;
export const EVAL_WORDING = 4;
const DAY = 86_400_000;
const HOUR = 3_600_000;

export function evaluationFingerprint(summary) {
  return JSON.stringify({
    turns: summary.turns, success: summary.success, failed: summary.failed, interrupted: summary.interrupted,
    compactions: summary.compactions, cacheHitRate: summary.cacheHitRate, inputFamily: summary.inputFamily,
    tools: summary.tools, snapshots: summary.snapshots
  });
}

// The key ignores the exact clock inside a rolling window, so opening the same view again is the same evaluation.
export function scopeKey({ from = 0, to, providers, projectId, accountKey, auth, device, session } = {}, now = Date.now()) {
  if (session) return `session:${session.device || ''}:${session.projectId}:${session.chatId}`;
  const end = Number.isFinite(to) ? to : now;
  const start = Number.isFinite(from) ? from : 0;
  const span = end - start;
  const toIsNow = Math.abs(now - end) < HOUR;
  let range = `span:${Math.floor(start / DAY)}:${Math.floor(end / DAY)}`;
  if (start <= 0 && toIsNow) range = 'all';
  else if (toIsNow && Math.abs(span - 7 * DAY) < 12 * HOUR) range = '7';
  else if (toIsNow && Math.abs(span - 30 * DAY) < DAY) range = '30';
  else if (toIsNow) range = `since:${Math.floor(start / DAY)}`;
  return `${range}|${[...(providers || [])].sort().join(',')}|${projectId || ''}|${accountKey || ''}|${auth || ''}|${device || 'local'}`;
}

// Linear extension of one limit window. Fewer than three points is not extended.
export function paceOf(points, resetsAt) {
  const rows = (points || []).filter(point => Number.isFinite(point.at) && Number.isFinite(point.percent)).sort((a, b) => a.at - b.at);
  if (rows.length < 3) return { enough: false, count: rows.length, hits: false };
  const first = rows[0], last = rows.at(-1);
  const span = last.at - first.at;
  if (!(span > 0) || !(resetsAt > last.at)) return { enough: true, count: rows.length, hits: false, last: last.percent };
  const slope = (last.percent - first.percent) / span;
  if (!(slope > 0)) return { enough: true, count: rows.length, hits: false, last: last.percent };
  const predicted = last.percent + slope * (resetsAt - last.at);
  return { enough: true, count: rows.length, hits: predicted >= 100, predicted, last: last.percent, first: first.percent };
}

function paceLine(summary) {
  const groups = new Map();
  for (const shot of summary.snapshots || []) for (const window of shot.windows || []) {
    if (!Number.isFinite(window.resetsAt) || window.resetsAt <= summary.to) continue;
    const key = `${shot.deviceId}\0${shot.provider}\0${shot.accountKey}\0${window.key}\0${window.resetsAt}`;
    const row = groups.get(key) ?? { shot, window, points: [] };
    row.points.push({ at: shot.at, percent: window.percent });
    groups.set(key, row);
  }
  for (const row of groups.values()) {
    const pace = paceOf(row.points, row.window.resetsAt);
    if (!pace.enough || !pace.hits) continue;
    const label = row.window.label || row.window.key;
    const provider = providerName[row.shot.provider] || row.shot.provider;
    return finding('pace', 'improve', '리셋 전 한도 소진 가능', `${provider} ${label} 한도가 리셋 전에 소진될 수 있어요. 현재 ${Math.round(pace.last)}%, 예상 ${Math.round(pace.predicted)}%`);
  }
  return null;
}

export function buildReport(summary) {
  const good = [], improve = [];
  if (summary.turns) {
    const { success = 0, failed = 0, interrupted = 0, cacheHitRate, compactions = 0 } = summary;
    const resolved = success + failed + interrupted;
    const completion = resolved ? success / resolved : 0;
    if (resolved >= 3 && (success === resolved || (resolved >= 10 && completion >= 0.95))) {
      good.push(finding('completion', 'good', '안정적인 응답 완료', `응답 ${count(resolved)}건 중 ${count(success)}건이 정상 완료됐어요.`));
    }
    if (resolved >= 3 && completion <= 0.85) {
      improve.push(finding('failures', 'improve', '응답 끊김 줄이기', `응답 ${count(resolved)}건 중 실패 ${count(failed)}건, 중단 ${count(interrupted)}건이에요.`));
    }
    if (summary.inputFamily >= 5_000 && Number.isFinite(cacheHitRate)) {
      if (cacheHitRate >= 0.8) good.push(finding('cache', 'good', '높은 캐시 재사용', `입력 토큰의 ${pct(cacheHitRate)}를 캐시에서 읽었어요.`));
      if (cacheHitRate <= 0.2) improve.push(finding('cache', 'improve', '낮은 캐시 재사용', `캐시 읽기가 ${pct(cacheHitRate)}에 그쳤어요. 반복되는 지침은 대화 초반에 한 번 정리해 보세요.`));
    }
    const tools = summary.tools || [];
    const calls = tools.reduce((sum, tool) => sum + tool.count, 0);
    if (calls >= 8 && tools.every(tool => tool.errors === 0)) {
      good.push(finding('tools', 'good', '도구 실행이 안정적', `도구 호출 ${count(calls)}회에서 오류가 없었어요.`));
    }
    const repeated = tools.filter(tool => tool.errors >= 2 && tool.errors / tool.count >= 0.25)
      .sort((a, b) => b.errors - a.errors)[0];
    if (repeated) improve.unshift(finding('tool-errors', 'improve', '반복된 도구 오류', `${repeated.name} 호출 ${count(repeated.count)}회 중 ${count(repeated.errors)}회(${pct(repeated.errors / repeated.count)})가 실패했어요.`));
    if (compactions >= 3 && compactions / summary.turns >= 0.2) {
      improve.push(finding('compact', 'improve', '잦은 컨텍스트 압축', `${count(summary.turns)}턴 동안 ${count(compactions)}회 압축됐어요. 작업 단위로 대화를 나눠 보세요.`));
    }
    const pace = summary.projectFilter || summary.authFilter ? null : paceLine(summary);
    if (pace) improve.unshift(pace);
  }
  const findings = [...good.slice(0, 2), ...improve.slice(0, 2)];
  return { sections: [{ id: 'evaluation', title: '사용 평가', paragraphs: findings }], suggestions: findings };
}

export function buildSessionReport({ tokens, outcomes, turns, compactions, cacheHitRate, tools }) {
  return buildReport({
    ...outcomes, turns, compactions, cacheHitRate, tools,
    inputFamily: tokens.input + tokens.read + tokens.write5m + tokens.write1h
  });
}

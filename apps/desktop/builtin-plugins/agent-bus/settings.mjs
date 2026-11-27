// The agent bus settings: their defaults, how a saved or typed value is checked, and the form the settings page draws.
// Every value is a plain boolean, string or integer; the settings page sends and shows them as strings.
export const AGENTS = ['claude', 'codex', 'cursor'];
export const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

export const DEFAULTS = Object.freeze({
  scope: 'project', claude: true, codex: true, cursor: true, delivery: 'steer', broadcast: true, autoApprove: true,
  maxLength: 8000, queueSeconds: 300, logContent: false
});
const LIMITS = { maxLength: [200, 50_000], queueSeconds: [10, 3600] };
const CHOICES = { scope: ['project', 'all'], delivery: ['steer', 'idle'] };

// A saved value is trusted no further than its type and range; anything else falls back to the default.
export function cleanSettings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}, result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const wanted = input[key];
    if (key in CHOICES) { if (CHOICES[key].includes(wanted)) result[key] = wanted; }
    else if (key in LIMITS) { if (Number.isInteger(wanted)) result[key] = Math.min(LIMITS[key][1], Math.max(LIMITS[key][0], wanted)); }
    else if (typeof wanted === 'boolean') result[key] = wanted;
  }
  return result;
}

const LABELS = {
  scope: '메시지를 보낼 수 있는 범위', claude: 'Claude Code 채팅 참여', codex: 'Codex 채팅 참여', cursor: 'Cursor 채팅 참여', delivery: '작업 중인 채팅에 전달하는 방식',
  broadcast: '전체 전달(all) 허용', autoApprove: '에이전트 도구 호출 자동 허용',
  maxLength: '메시지 최대 길이(글자)', queueSeconds: '대기 메시지 보관 시간(초)', logContent: '기록에 메시지 내용 남기기'
};
// The page's form values (strings) -> settings. Throws a message the page shows next to the Save button.
export function parseValues(values, current = DEFAULTS) {
  const next = { ...current };
  for (const key of Object.keys(DEFAULTS)) {
    const raw = values?.[key];
    if (raw === undefined) continue;
    if (key in CHOICES) { if (!CHOICES[key].includes(raw)) throw new Error(`${LABELS[key]} 값이 올바르지 않습니다.`); next[key] = raw; }
    else if (key in LIMITS) {
      const [min, max] = LIMITS[key], number = Number(raw);
      if (!/^\d{1,6}$/.test(String(raw).trim()) || number < min || number > max) throw new Error(`${LABELS[key]}은(는) ${min}에서 ${max} 사이의 정수여야 합니다.`);
      next[key] = number;
    } else { if (raw !== 'true' && raw !== 'false') throw new Error(`${LABELS[key]} 값이 올바르지 않습니다.`); next[key] = raw === 'true'; }
  }
  return next;
}

const field = (key, type, settings, extra = {}) => ({ key, label: LABELS[key], type, value: String(settings[key]), ...extra });
// The settings page's inputs. Hints say what each does and when a change applies.
export function fieldsFor(settings) {
  return [
    field('scope', 'select', settings, { options: [{ value: 'project', label: '같은 프로젝트의 채팅만' }, { value: 'all', label: '열려 있는 모든 프로젝트의 채팅' }], hint: '에이전트가 list_peers로 찾고 메시지를 보낼 수 있는 채팅의 범위입니다.' }),
    field('claude', 'switch', settings, { hint: '끄면 이 에이전트는 메시지를 보내지도 받지도 않습니다.' }),
    field('codex', 'switch', settings),
    field('cursor', 'switch', settings),
    field('delivery', 'select', settings, { options: [{ value: 'steer', label: '작업 중이면 바로 끼워 넣기' }, { value: 'idle', label: '응답이 끝난 뒤에만' }], hint: 'Cursor는 작업 중 끼워 넣기를 지원하지 않아 응답이 끝난 뒤 전달합니다. 못 받은 메시지는 아래 보관 시간 동안 대기합니다.' }),
    field('broadcast', 'switch', settings, { hint: 'to에 "all"을 쓰면 보내는 채팅을 뺀 모든 참여 채팅에 한 번에 전달합니다.' }),
    field('autoApprove', 'switch', settings, { hint: '켜면 메시지·조회 도구(list_peers, send_message, request_peer, worktree_status 등)가 권한 확인 없이 실행됩니다. 저장소를 바꾸는 merge_my_worktree와 integrate_worktrees는 켜도 항상 확인합니다. 바꾼 값은 새로 시작하는 채팅부터 적용됩니다.' }),
    field('maxLength', 'number', settings, { hint: '이보다 긴 메시지는 거부합니다. 긴 내용은 파일에 쓰고 경로를 보내게 하세요.' }),
    field('queueSeconds', 'number', settings, { hint: '받는 채팅이 바빠서 대기 중인 메시지를 이 시간까지 기다렸다가, 못 보내면 버립니다.' }),
    field('logContent', 'switch', settings, { hint: '꺼져 있으면 최근 기록에 누가 누구에게 보냈는지만 남기고 내용은 남기지 않습니다.' })
  ];
}

const samples = {
  claude: {
    plan: 'Max',
    windows: [
      ['session', '5시간', 23, 3], ['weekly', '주간', 41, 72], ['fable', 'Fable', 8, 72]
    ],
    credit: { used: 3, limit: 20, percent: 15, currency: 'USD' }
  },
  codex: {
    plan: 'Pro',
    windows: [['session', '5시간', 8, 4], ['weekly', '주간', 17, 96]],
    codexCredits: { balance: 120, unlimited: false, hasCredits: true }
  },
  cursor: {
    plan: 'Pro',
    windows: [
      ['auto', 'Cursor', 20, 216], ['api', '기타', 40, 216], ['total', '전체', 25, 216],
      ['grok', 'Grok', 12, 216], ['on-demand', '추가', 5, 216]
    ]
  }
};
const at = Date.now();

export function verifyUsage(provider) {
  if (typeof provider !== 'string' || !Object.hasOwn(samples, provider)) return null;
  const { windows, ...sample } = samples[provider];
  return {
    ...sample,
    provider, source: 'api', at, error: null,
    windows: windows.map(([key, label, percent, hours]) => ({ key, label, percent, resetsAt: at + hours * 3_600_000 })),
    account: { dir: '테스트 계정', from: 'server' },
    note: '테스트 세션의 예시 사용량입니다.'
  };
}

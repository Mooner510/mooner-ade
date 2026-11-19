// Status-bar usage chips, one list per provider. A chip appears only when that account's reading includes it and the user left it on.
export type UsageProvider = 'claude' | 'codex' | 'cursor';
export type UsageStyle = 'bar' | 'text';

export const usageMeterCatalog: Record<UsageProvider, { id: string; label: string }[]> = {
  claude: [
    { id: 'session', label: '5시간' }, { id: 'weekly', label: '주간' }, { id: 'fable', label: 'Fable' },
    { id: 'credit', label: '크레딧' }
  ],
  codex: [{ id: 'session', label: '5시간' }, { id: 'weekly', label: '주간' }, { id: 'credit', label: '크레딧' }],
  cursor: [
    { id: 'auto', label: 'Cursor' }, { id: 'api', label: '기타' }, { id: 'total', label: '전체' },
    { id: 'grok', label: 'Grok' }, { id: 'on-demand', label: '추가' }
  ]
};

export const defaultUsageMeters: Record<UsageProvider, string[]> = {
  claude: ['session', 'weekly', 'fable', 'credit'],
  codex: ['session', 'weekly', 'credit'],
  cursor: ['auto', 'api', 'total']
};

export const usageMetersOf = (provider: UsageProvider, shown?: Partial<Record<UsageProvider, string[]>>) => {
  const known = new Set(usageMeterCatalog[provider].map(item => item.id));
  return (shown?.[provider] ?? defaultUsageMeters[provider]).filter(id => known.has(id));
};

// `showSession` is the Claude 5-hour switch (plans without that window hide it even when the chip is enabled).
export const barWindows = <T extends { key: string }>(windows: T[], meters: string[], showSession: boolean) =>
  windows.filter(item => meters.includes(item.key) && (item.key !== 'session' || showSession));

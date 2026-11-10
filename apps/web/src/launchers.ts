import type { IconName } from './Icon';

export type AgentMode = 'chat' | 'cli';
export const launchers: { id: string; label: string; detail: string; command: string; icon: IconName }[] = [
  { id: 'shell', label: '터미널', detail: '', command: '', icon: 'terminal' },
  { id: 'claude', label: 'Claude', detail: '', command: 'claude', icon: 'claude' },
  { id: 'codex', label: 'Codex', detail: '', command: 'codex', icon: 'codex' },
  { id: 'cursor', label: 'Cursor', detail: '', command: 'cursor-agent', icon: 'cursor' }
];
export const launchersFor = (mode: AgentMode, shellName = '') => launchers.map(item => item.id === 'shell' ? { ...item, detail: shellName } : {
  ...item, command: mode === 'chat' ? `ade:chat:${item.id}` : item.command
});

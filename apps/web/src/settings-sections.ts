// The settings window's sections, kept out of Settings.tsx so the app shell can list them (command palette, shortcut guide) without loading the window (split off).
import type { IconName } from './Icon';

export type Section = 'appearance' | 'terminal' | 'ai' | 'chat' | 'status' | 'git' | 'wakatime' | 'plugins' | 'feedback' | 'keys' | 'about';
export const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: '외관', icon: 'panelLeft' },
  { id: 'terminal', label: '터미널', icon: 'terminal' },
  { id: 'ai', label: 'AI 툴', icon: 'claude' },
  { id: 'chat', label: '채팅', icon: 'chat' },
  { id: 'status', label: '상태바', icon: 'statusBar' },
  { id: 'git', label: 'Git', icon: 'graph' },
  { id: 'wakatime', label: 'WakaTime', icon: 'clock' },
  { id: 'plugins', label: '플러그인', icon: 'plugin' },
  { id: 'feedback', label: '피드백', icon: 'feedback' },
  { id: 'keys', label: '단축키', icon: 'code' },
  { id: 'about', label: '정보', icon: 'info' }
];
// The command palette's `,` search opens these (palette entries in main.tsx).
export const settingsSections: readonly { id: Section; label: string; icon: IconName }[] = sections;

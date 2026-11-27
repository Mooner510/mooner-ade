// Windows the shell (main.tsx) owns that a project's palette or a button deep inside can ask for, like usage-review-open.ts:
// a settings section, and the shortcut guide.
import type { Section } from './Settings';

let settingsAt: (section: Section) => void = () => {};
export const bindSettingsSection = (fn: (section: Section) => void) => { settingsAt = fn; return () => { if (settingsAt === fn) settingsAt = () => {}; }; };
export const openSettingsSection = (section: Section) => settingsAt(section);

let keyGuide: () => void = () => {};
export const bindKeyGuide = (fn: () => void) => { keyGuide = fn; return () => { if (keyGuide === fn) keyGuide = () => {}; }; };
export const openKeyGuide = () => keyGuide();

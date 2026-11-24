// Raise only when existing tips should all be eligible to show once again.
export const TIPS_VERSION = 1;
export type TipCandidate = [id: string, eligible: unknown];

// `chatTipPending`: Chat has not been opened yet and the card was not dismissed. Shown while an agent CLI terminal is focused.
export const chatModeTipDue = (settings: { chatTipPending: boolean; tips: boolean }, kind: string | undefined, agent: string | undefined) =>
  settings.tips && settings.chatTipPending && (kind === 'terminal' || kind === undefined) && ['claude', 'codex', 'cursor'].includes(agent ?? '');

// Keep the acknowledged hints from older installs and hints the user learned by using their shortcuts.
export const hintCandidates = (settings: { tips: boolean; onboarded: boolean; hintsSeen: string[] }, candidates: TipCandidate[]) =>
  settings.tips && settings.onboarded ? candidates.filter(([id]) => !settings.hintsSeen.includes(id)) : [];

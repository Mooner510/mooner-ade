// Dev-only: keep the composer text across HMR and `pnpm dev` server restarts. Stripped at build time when `import.meta.env.DEV` is false.
const PREFIX = 'ade:dev:chat-draft:';

export const chatDevDraftKey = (projectId: string, chatId: string) => `${PREFIX}${projectId}:${chatId}`;

export function loadChatDevDraft(projectId: string, chatId: string, dev = import.meta.env.DEV): string | null {
  if (!dev) return null;
  try {
    const raw = localStorage.getItem(chatDevDraftKey(projectId, chatId));
    if (!raw) return null;
    const data = JSON.parse(raw) as { text?: string };
    return typeof data.text === 'string' ? data.text : null;
  } catch {
    return null;
  }
}

export function saveChatDevDraft(projectId: string, chatId: string, text: string, dev = import.meta.env.DEV) {
  if (!dev) return;
  const key = chatDevDraftKey(projectId, chatId);
  if (!text) {
    localStorage.removeItem(key);
    return;
  }
  try { localStorage.setItem(key, JSON.stringify({ text, at: Date.now() })); } catch { /* quota */ }
}

export function clearChatDevDraft(projectId: string, chatId: string, dev = import.meta.env.DEV) {
  if (!dev) return;
  try { localStorage.removeItem(chatDevDraftKey(projectId, chatId)); } catch { /* ignore */ }
}

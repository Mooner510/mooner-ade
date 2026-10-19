// shortcut: relies on Claude's OSC 9;4 turn status and prompt layout, update when the CLI changes either contract.
export function createClaudeFollowUp() {
  let working = false, ready = false, paused = false;
  const items: { id: number; text: string }[] = [];
  let sequence = 0;
  return {
    get working() { return working; },
    get paused() { return paused; },
    get items() { return [...items]; },
    progress(value: string) {
      const match = /^4;([0-4])(?:;\d*)?$/.exec(value);
      if (!match) return;
      if (match[1] === '1' || match[1] === '3') { working = true; ready = false; }
      else if (match[1] === '0') { if (working) ready = true; working = false; }
      else { paused = true; ready = false; working = false; }
    },
    enqueue(text: string) {
      if (!validClaudeDraft(text)) return false;
      items.push({ id: ++sequence, text });
      return true;
    },
    remove(id: number) { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1); },
    pause() { paused = true; ready = false; },
    reset() { working = false; ready = false; paused = items.length > 0; },
    resume() { paused = false; },
    submitted() { ready = false; working = false; },
    next(allowed: boolean) {
      if (!allowed || !ready || paused || !items.length) return;
      return items[0];
    },
    sent(id: number) { if (items[0]?.id === id) { items.shift(); ready = false; } }
  };
}

export function hasEmptyClaudeComposer(screen: string) {
  const prompt = [...screen.matchAll(/^[ \t]*❯[ \t]*(.*)$/gm)].at(-1);
  if (!prompt || prompt[1].trim()) return false;
  const below = screen.slice(prompt.index! + prompt[0].length);
  return /^\n[ \t\n]*[─━]{3}/.test(below);
}

export function claudeDraftInput(data: string): string | undefined {
  const paste = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
  const value = (paste ? paste[1] : data).replace(/\r\n?/g, '\n');
  return value && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) && (paste || !/[\n\t]/.test(value)) ? value : undefined;
}

export const claudePromptInput = (text: string) => `\x1b[200~${text}\x1b[201~\r`;
export const validClaudeDraft = (text: string) => Boolean(text.trim()) && text.length <= 16000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text);

// Earlier versions could clear progress between tool calls, which would inject the follow-up mid-task.
export function claudeFollowUpVersion(banner: string): boolean | undefined {
  const version = [...banner.matchAll(/Claude Code\s+v?(\d+)\.(\d+)\.(\d+)/g)].at(-1);
  if (!version) return;
  const [major, minor, patch] = version.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 303);
}

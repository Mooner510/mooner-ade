// shortcut: relies on Claude's OSC 9;4 turn status and prompt layout, update when the CLI changes either contract.
export function createClaudeFollowUp() {
  // `awaiting`: state was lost (replay/reconnect), so the next idle report means "the turn already ended" even without having seen it run.
  let working = false, ready = false, awaiting = false;
  const items: { id: number; text: string }[] = [];
  let sequence = 0;
  const finish = () => { if (working) ready = true; working = false; };
  return {
    get working() { return working; },
    get items() { return [...items]; },
    progress(value: string) {
      const match = /^4;([0-4])(?:;\d*)?$/.exec(value);
      if (!match) return;
      awaiting = false;
      if (match[1] === '1' || match[1] === '3') { working = true; ready = false; }
      else finish(); // 0 = idle; 2/4 = error/paused: the turn is over either way
    },
    // Turn state from OSC 7501 (the CLI's own report); same semantics as progress 3 / 0 and safe to repeat.
    turn(isWorking: boolean) {
      if (isWorking) { working = true; ready = false; awaiting = false; }
      else if (working) finish();
      else if (awaiting && items.length) { ready = true; awaiting = false; }
    },
    enqueue(text: string) {
      if (!validClaudeDraft(text)) return false;
      items.push({ id: ++sequence, text });
      return true;
    },
    edit(id: number, text: string) { const item = items.find(entry => entry.id === id); if (!item || !validClaudeDraft(text)) return false; item.text = text; return true; },
    remove(id: number) { const index = items.findIndex(item => item.id === id); if (index >= 0) items.splice(index, 1); },
    reset() { working = false; ready = false; awaiting = true; },
    submitted() { ready = false; working = false; awaiting = false; },
    next(allowed: boolean) {
      if (!allowed || !ready || !items.length) return;
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

// Text typed in Claude's own composer, read back from the screen (rows between the prompt and its bottom border).
// ponytail: Ink soft-wraps and Shift+Enter newlines look alike on screen, so rows are joined with a space.
// The `/` and `@` suggestion list under the composer marks its selected row with `❯` too, but nothing closes it with a border.
export function claudeComposerText(screen: string): string | undefined {
  for (const prompt of [...screen.matchAll(/^[ \t]*❯[ \t]?(.*)$/gm)].reverse()) {
    const rows = [prompt[1].trim()];
    for (const line of screen.slice(prompt.index! + prompt[0].length).split('\n').slice(1)) {
      if (/^[ \t]*[─━]{3}/.test(line)) return rows.filter(Boolean).join(' ') || undefined;
      rows.push(line.trim());
    }
  }
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

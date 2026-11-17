type EditKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'isComposing'>;

// Fill the editing keys xterm does not translate; all other keys keep xterm's terminal-mode handling.
export function terminalEditKey(event: EditKey, mac: boolean): string | undefined {
  if (event.isComposing) return;
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  if (ctrlKey && !altKey && !metaKey && !shiftKey && key === 'Backspace') return '\x17';
  if (!mac || ctrlKey) return;
  if (metaKey && !altKey) {
    if (key === 'ArrowLeft') return shiftKey ? '\x1b[1;2H' : '\x01';
    if (key === 'ArrowRight') return shiftKey ? '\x1b[1;2F' : '\x05';
    if (key === 'ArrowUp') return `\x1b[1;${shiftKey ? 6 : 5}H`;
    if (key === 'ArrowDown') return `\x1b[1;${shiftKey ? 6 : 5}F`;
    if (!shiftKey && key === 'Backspace') return '\x15';
    if (!shiftKey && key === 'Delete') return '\x0b';
  }
  if (altKey && !metaKey && !shiftKey && key === 'Delete') return '\x1bd';
}

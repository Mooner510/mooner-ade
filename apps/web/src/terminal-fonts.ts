/** Monospace fonts offered in setup and terminal settings (installed ones are detected at runtime). */
export const terminalFontChoices = [
  'JetBrains Mono', 'D2Coding', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Consolas', 'Source Code Pro', 'Monaco', 'IBM Plex Mono', 'Hack',
] as const;

// A font counts as installed when text set in it measures differently from both generic fallbacks.
export function isTerminalFontInstalled(name: string) {
  const context = document.createElement('canvas').getContext('2d')!;
  const sample = 'mmmmmmmmmmlli1WW가나다';
  return ['monospace', 'serif'].some(base => {
    context.font = `40px ${base}`;
    const plain = context.measureText(sample).width;
    context.font = `40px "${name}", ${base}`;
    return context.measureText(sample).width !== plain;
  });
}

export function installedTerminalFonts() {
  return terminalFontChoices.filter(isTerminalFontInstalled);
}

export function monoFontDropdownOptions(current: string, installed: readonly string[], emptyLabel: string) {
  const options: { value: string; label: string }[] = [{ value: '', label: emptyLabel }, ...installed.map(name => ({ value: name, label: name }))];
  const custom = current.trim();
  if (custom && !options.some(option => option.value === custom)) options.push({ value: custom, label: custom });
  return options;
}

// Whether a textarea's caret sits on its first / last *visual* line. Counting "\n" alone treats a long, soft-wrapped paragraph as one line,
// so ↑/↓ history recall would jump away while the caret could still move inside the wrapped text. A hidden mirror measures the wrapped height instead.
const MIRRORED = ['boxSizing', 'fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'fontVariant', 'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'tabSize', 'lineHeight', 'wordBreak', 'overflowWrap', 'direction'] as const;

export function caretEdges(field: HTMLTextAreaElement): { first: boolean; last: boolean } {
  const { value } = field, caret = field.selectionStart;
  if (!value) return { first: true, last: true };
  const style = getComputedStyle(field), mirror = document.createElement('div');
  for (const key of MIRRORED) mirror.style[key] = style[key];
  const inner = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', padding: '0', border: '0', whiteSpace: 'pre-wrap', width: `${Math.max(1, inner)}px` });
  document.body.appendChild(mirror);
  // The zero-width mark keeps a trailing line break from collapsing, so "abc\n" counts two lines.
  const lines = (text: string) => { mirror.textContent = `${text}​`; return mirror.scrollHeight; };
  const one = lines(''), before = lines(value.slice(0, caret)), full = lines(value);
  mirror.remove();
  const count = (height: number) => Math.max(1, Math.round(height / (one || 1)));
  return { first: count(before) <= 1, last: count(before) >= count(full) };
}

// The two sides a diff view gives Monaco. A file that is new (or gone) has one empty side, and Monaco's diff treats a side that is a single empty line
// as one whole-line change: an added file showed a removed blank line before its lines, and its final newline as one more added blank line.
// Such a file is shown as its lines only: the final newline is dropped from the side that has the text (it is no line of its own), the view
// renders an addition inline without the removed blank line (Editor.tsx DiffView), and `data-whole` hides the empty side's marks. Pure, so node tests load it.

export type WholeFile = 'added' | 'removed' | null;
/** The text without its final line break, unless that leaves nothing (a file that is one empty line keeps it, so it still shows as a change). */
const withoutFinalNewline = (text: string) => { const trimmed = text.replace(/\r?\n$/, ''); return trimmed === '' ? text : trimmed; };
export function diffSides(original: string, modified: string): { original: string; modified: string; whole: WholeFile } {
  if (original === '' && modified !== '') return { original, modified: withoutFinalNewline(modified), whole: 'added' };
  if (modified === '' && original !== '') return { original: withoutFinalNewline(original), modified, whole: 'removed' };
  return { original, modified, whole: null };
}

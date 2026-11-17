// A file or folder the agent mentions as [[file:src/app.ts:42]] (path relative to the project; :line and :line:column optional; a trailing / marks a folder).
// A markdown link whose target is a path instead of an address ([app.ts](src/app.ts#L42)) is read the same way. Pure text work, so the server decides what is really openable.
export type FileRef = { path: string; line?: number; column?: number; folder: boolean };

export function fileRef(raw: string): FileRef | null {
  let text = raw.trim().replace(/\\/g, '/');
  if (!text || text.length > 1024 || /[\x00-\x1f]/.test(text)) return null;
  let line: number | undefined, column: number | undefined;
  const hash = /#L(\d+)(?:C(\d+))?$/i.exec(text);
  if (hash) { text = text.slice(0, hash.index); line = Number(hash[1]); column = hash[2] ? Number(hash[2]) : undefined; }
  else {
    const colon = /^(.+?):(\d+)(?::(\d+))?$/.exec(text);
    // One letter before the colon is a drive ("C:12"), not a file at a line.
    if (colon && colon[1].length > 1) { text = colon[1]; line = Number(colon[2]); column = colon[3] ? Number(colon[3]) : undefined; }
  }
  const folder = text.endsWith('/') && text.length > 1;
  text = text.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) line = column = undefined;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) column = undefined;
  return { path: text, ...(line !== undefined && { line }), ...(column !== undefined && { column }), folder };
}

// The target of a [label](href) link when it names a place on disk, not a web address, mail link or in-page anchor.
export function fileHref(href: string): FileRef | null {
  if (href.startsWith('#') || href.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]+:/i.test(href) && !/^file:/i.test(href)) return null;
  let target = href.replace(/^file:\/{2,3}/i, '');
  try { target = decodeURIComponent(target); } catch { /* keep as written */ }
  return fileRef(target);
}

// Prints the GitHub release body for a version from apps/web/src/changelog.json, the same file the app bundles.
// Usage: node scripts/release-notes.mjs 0.5.5   (exit 1 when the version has no entry)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const kinds = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../apps/web/src/changelog-kinds.json'), 'utf8'));

export const notes = (version, changelog) => {
  const entry = changelog.find(item => item.version === version);
  // An entry with no items is no entry: it would publish an empty release body and an empty changelog page.
  if (!entry?.items?.length) return null;
  const items = [...entry.items].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  return items.map(item => `- **[${item.kind}] ${item.title}**: ${item.text}`).join('\n') + '\n';
};

// pathToFileURL: on Windows `file://${argv[1]}` never equals import.meta.url (backslashes, no third slash), so a local run printed nothing and exited 0.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = path.resolve(import.meta.dirname, '../apps/web/src/changelog.json');
  const text = notes(process.argv[2], JSON.parse(readFileSync(file, 'utf8')));
  if (text === null) { console.error(`No changelog entry for ${process.argv[2]}`); process.exit(1); }
  process.stdout.write(text);
}

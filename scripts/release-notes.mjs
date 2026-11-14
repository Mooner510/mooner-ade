// Prints the GitHub release body for a version from apps/web/src/changelog.json, the same file the app bundles.
// Usage: node scripts/release-notes.mjs 0.5.5   (exit 1 when the version has no entry)
import { readFileSync } from 'node:fs';
import path from 'node:path';

const kinds = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../apps/web/src/changelog-kinds.json'), 'utf8'));

export const notes = (version, changelog) => {
  const entry = changelog.find(item => item.version === version);
  if (!entry) return null;
  const items = [...entry.items].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
  return items.map(item => `- **[${item.kind}] ${item.title}**: ${item.text}`).join('\n') + '\n';
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = path.resolve(import.meta.dirname, '../apps/web/src/changelog.json');
  const text = notes(process.argv[2], JSON.parse(readFileSync(file, 'utf8')));
  if (text === null) { console.error(`No changelog entry for ${process.argv[2]}`); process.exit(1); }
  process.stdout.write(text);
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { notes } from '../scripts/release-notes.mjs';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const changelog = read('../apps/web/src/changelog.json');

test('changelog: newest first, stable versions only, short items', () => {
  const versions = changelog.map(entry => entry.version);
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(versions, [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
  for (const item of changelog.flatMap(entry => entry.items)) assert.ok(item.title && item.text);
});

test('release notes: one bullet per item', () => {
  assert.equal(notes('9.9.9', changelog), null);
  assert.equal(notes('0.5.5', changelog).trim().split('\n').length, changelog[0].items.length);
});

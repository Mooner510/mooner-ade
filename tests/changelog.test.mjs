import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { notes } from '../scripts/release-notes.mjs';

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const changelog = read('../apps/web/src/changelog.json');
const kinds = read('../apps/web/src/changelog-kinds.json');

test('changelog: newest first, stable versions only, short items', () => {
  const versions = changelog.map(entry => entry.version);
  for (const version of versions) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(versions, [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
  for (const item of changelog.flatMap(entry => entry.items)) {
    assert.ok(item.title && item.text);
    assert.ok(kinds.includes(item.kind), `unknown kind ${item.kind}`);
  }
});

test('release notes: one bullet per item, grouped by kind', () => {
  assert.equal(notes('9.9.9', changelog), null);
  assert.equal(notes('0.5.5', changelog).trim().split('\n').length, changelog.find(entry => entry.version === '0.5.5').items.length);
  const order = notes('0.5.5', changelog).trim().split('\n').map(line => kinds.indexOf(/\[(.+?)\]/.exec(line)[1]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

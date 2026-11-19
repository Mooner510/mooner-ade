import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnreadChangelogVersions, syncChangelogVersion } from '../apps/web/src/changelog-state.ts';

const store = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('an update with an unread note is the only launch that asks to open the changelog', () => {
  const saved = store();
  assert.equal(syncChangelogVersion('0.5.11', saved), false, 'the first launch only records the version');
  assert.equal(syncChangelogVersion('0.5.11', saved), false);
  assert.equal(hasUnreadChangelogVersions(['0.5.11', '0.5.12'], saved), false);
  assert.equal(syncChangelogVersion('0.5.12', saved), true);
  assert.equal(hasUnreadChangelogVersions(['0.5.11', '0.5.12'], saved), true);
  saved.setItem('ade-changelog-viewed', JSON.stringify(['0.5.12']));
  assert.equal(hasUnreadChangelogVersions(['0.5.11', '0.5.12'], saved), false, 'opening it clears the reason to auto-open');
  assert.equal(syncChangelogVersion('0.6.0', saved), true);
  assert.equal(hasUnreadChangelogVersions(['0.5.12'], saved), false, 'a jump with no new note stays closed');
  assert.equal(syncChangelogVersion('0.6.0-beta1', saved), false, 'a prerelease is older than its release');
});

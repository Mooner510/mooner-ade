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

test('someone who used the app but never opened the changelog is updating, not new: the notes open once', () => {
  // 0.5.x wrote no record until the window was closed once; saved settings tell this person apart from a first launch.
  const saved = store();
  assert.equal(syncChangelogVersion('0.6.0', saved, '0.5.12'), true, 'no record + saved settings: an update from the version below');
  assert.equal(hasUnreadChangelogVersions(['0.5.12', '0.6.0'], saved), true, 'only the newest note counts as new');
  assert.equal(hasUnreadChangelogVersions(['0.5.12'], saved), false, 'older notes are not marked new');
  assert.equal(syncChangelogVersion('0.6.0', saved, '0.5.12'), false, 'the next launch is quiet, with or without the hint');
  // A first launch (no saved settings, so no `before`) still only records the version.
  const fresh = store();
  assert.equal(syncChangelogVersion('0.6.0', fresh), false);
  assert.equal(hasUnreadChangelogVersions(['0.5.12', '0.6.0'], fresh), false);
  // A record that exists wins over the hint: it is not an update when the same version runs again.
  const known = store(); known.setItem('ade-changelog-seen', '0.6.0');
  assert.equal(syncChangelogVersion('0.6.0', known, '0.5.12'), false);
  // Nothing newer than `before` (a bundle whose newest note is its own first one) is not an update.
  assert.equal(syncChangelogVersion('0.0.0', store(), '0.0.0'), false);
});

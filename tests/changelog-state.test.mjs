import test from 'node:test';
import assert from 'node:assert/strict';
import { changelogIsFresh, hasUnreadChangelogVersions, LEGACY_CHANGELOG_VERSION, syncChangelogVersion } from '../apps/web/src/changelog-state.ts';

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

// A 0.5.12 profile has no record of the version that ran (that build kept it in the page's localStorage, which a desktop launch loses): a profile that was
// used before is taken to come from 0.5.12, so the first launch of 0.6.0 opens its notes once.
test('a profile from 0.5.12 sees the 0.6.0 notes once, exactly one update, not the older versions', () => {
  const saved = store(), entries = ['0.6.0', '0.5.12', '0.5.11'];
  assert.equal(syncChangelogVersion('0.6.0', saved, LEGACY_CHANGELOG_VERSION), true, 'no record, but the profile was used before: an update');
  assert.deepEqual(entries.filter(version => changelogIsFresh(version, saved)), ['0.6.0'], 'only the notes after 0.5.12 are new');
  assert.equal(hasUnreadChangelogVersions(entries, saved), true);
  saved.setItem('ade-changelog-viewed', JSON.stringify(['0.6.0']));
  assert.equal(hasUnreadChangelogVersions(entries, saved), false, 'opened once');
  assert.equal(syncChangelogVersion('0.6.0', saved, LEGACY_CHANGELOG_VERSION), false, 'the next launch stays quiet');
  assert.equal(hasUnreadChangelogVersions(entries, saved), false);
  assert.equal(syncChangelogVersion('0.6.1', saved, LEGACY_CHANGELOG_VERSION), true, 'and the next update is an update again');
  assert.deepEqual(entries.concat('0.6.1').filter(version => changelogIsFresh(version, saved)), ['0.6.1']);
});

test('a 0.6.0 beta on an old profile is quiet, and its jump to 0.6.0 shows the 0.6.0 notes once', () => {
  const saved = store(), entries = ['0.6.0', '0.5.12'];
  assert.equal(syncChangelogVersion('0.6.0-beta5', saved, LEGACY_CHANGELOG_VERSION), true);
  assert.equal(hasUnreadChangelogVersions(entries, saved), false, 'a beta has no notes of its own, and 0.6.0 is not out for it yet');
  assert.equal(syncChangelogVersion('0.6.0-beta5', saved, LEGACY_CHANGELOG_VERSION), false);
  assert.equal(syncChangelogVersion('0.6.0', saved, LEGACY_CHANGELOG_VERSION), true);
  assert.deepEqual(entries.filter(version => changelogIsFresh(version, saved)), ['0.6.0']);
  assert.equal(hasUnreadChangelogVersions(entries, saved), true);
});

test('a first launch on a new profile, or a build not newer than 0.5.12, never counts as an update', () => {
  const fresh = store();
  assert.equal(syncChangelogVersion('0.6.0', fresh), false, 'no legacy hint: a new installation');
  assert.equal(hasUnreadChangelogVersions(['0.6.0', '0.5.12'], fresh), false);
  assert.equal(syncChangelogVersion('0.5.12', store(), LEGACY_CHANGELOG_VERSION), false, 'the legacy version itself is not newer than itself');
  assert.equal(syncChangelogVersion('0.5.11', store(), LEGACY_CHANGELOG_VERSION), false);
});

test('the desktop app\'s own store is used when the preload offers one, a plain browser uses localStorage', () => {
  const desktop = store(), local = store();
  const had = { adeDesktop: globalThis.adeDesktop, localStorage: globalThis.localStorage };
  try {
    globalThis.localStorage = local;
    globalThis.adeDesktop = { changelogStore: desktop };
    assert.equal(syncChangelogVersion('0.6.0', undefined, LEGACY_CHANGELOG_VERSION), true);
    assert.equal(desktop.getItem('ade-changelog-last'), '0.6.0');
    assert.equal(local.getItem('ade-changelog-last'), null, 'localStorage of a per-launch origin is not trusted with it');
    delete globalThis.adeDesktop;
    assert.equal(syncChangelogVersion('0.6.0'), false, 'a plain browser records its first launch in localStorage');
    assert.equal(local.getItem('ade-changelog-last'), '0.6.0');
  } finally {
    for (const [name, value] of Object.entries(had)) value === undefined ? delete globalThis[name] : globalThis[name] = value;
  }
});

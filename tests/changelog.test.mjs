import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('changelog entries are ready to publish: a real date and KST time, an icon the app has, at least one item, and the current stable version is there', () => {
  const icons = readFileSync(new URL('../apps/web/src/Icon.tsx', import.meta.url), 'utf8');
  const glyphs = new Set([...icons.slice(icons.indexOf('const glyphs = {'), icons.indexOf('} as const;')).matchAll(/^  (\w+): '/gm)].map(match => match[1]));
  for (const entry of changelog) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `${entry.version} date`);
    assert.ok(!Number.isNaN(Date.parse(`${entry.date}T00:00:00+09:00`)), `${entry.version} date is a real day`);
    assert.match(entry.time, /^([01]\d|2[0-3]):[0-5]\d$/, `${entry.version} time (KST, the sidebar shows how long ago it was)`);
    assert.ok(entry.items.length > 0, `${entry.version} has items`);
    for (const item of entry.items) if (item.icon) assert.ok(glyphs.has(item.icon) || ['claude', 'codex', 'cursor'].includes(item.icon), `${entry.version} "${item.title}": no icon called ${item.icon}`);
    assert.equal(new Set(entry.items.map(item => item.title)).size, entry.items.length, `${entry.version}: item titles are the list keys, so each must be unique`);
  }
  // The release commit bumps package.json to a stable version; CI then fails until its notes exist, before anyone tags it (release.mjs checks again).
  const { version } = read('../package.json');
  if (!version.includes('-')) assert.ok(notes(version, changelog), `package.json is ${version}: add it to apps/web/src/changelog.json`);
});

// Intro rules (changelog-state.ts): a patch version (x.y.Z, Z > 0) never has one; every minor/major from 0.6.0 on has its own, unlike any earlier one.
test('minor/major notes from 0.6.0 on carry their own intro (a colour and a line), patch notes none, and every demo they name exists', () => {
  const demos = readFileSync(new URL('../apps/web/src/ChangelogDemo.tsx', import.meta.url), 'utf8');
  const known = new Set([...demos.matchAll(/^  '?([\w-]+)'?: \{ render:/gm)].map(match => match[1]));
  assert.ok(known.size >= 20, 'the demo registry is where the test looks for demo names');
  const rich = version => version.localeCompare('0.6.0', undefined, { numeric: true }) >= 0;
  const patch = version => Number(version.split('.')[2]) > 0;
  const intros = [];
  for (const entry of changelog) {
    if (rich(entry.version) && patch(entry.version)) {
      assert.ok(!entry.intro, `${entry.version}: a patch version plays no intro, so its entry has no intro`);
    } else if (rich(entry.version)) {
      assert.ok(Number.isInteger(entry.intro?.hue) && entry.intro.hue >= 0 && entry.intro.hue < 360, `${entry.version}: intro.hue is the version's colour (0-359), the intro and the page header use it`);
      assert.ok(entry.intro?.tagline?.trim(), `${entry.version}: intro.tagline is the line under the big version`);
      for (const other of intros) {
        assert.notEqual(entry.intro.tagline.trim(), other.intro.tagline.trim(), `${entry.version}: its intro line repeats ${other.version}'s; each minor/major gets its own intro`);
        assert.notEqual(entry.intro.hue, other.intro.hue, `${entry.version}: its intro colour repeats ${other.version}'s; each minor/major gets its own intro`);
      }
      intros.push(entry);
    } else {
      assert.ok(!entry.intro && entry.items.every(item => !item.demo), `${entry.version}: notes before 0.6.0 keep the plain page`);
    }
    for (const item of entry.items) {
      if (item.demo) assert.ok(known.has(item.demo), `${entry.version} "${item.title}": no demo called ${item.demo}`);
      if (item.image) assert.ok(existsSync(new URL(`../apps/web/public/changelog/${item.image}`, import.meta.url)), `${entry.version} "${item.title}": missing picture ${item.image}`);
    }
  }
});

test('the release notes script prints the body when run from the command line, on every OS, and fails for a version with no entry', () => {
  const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url));
  const known = spawnSync(process.execPath, [script, '0.5.5'], { encoding: 'utf8' });
  assert.equal(known.status, 0);
  assert.equal(known.stdout, notes('0.5.5', changelog));
  assert.match(known.stdout, /^- \*\*\[/);
  const unknown = spawnSync(process.execPath, [script, '9.9.9'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /No changelog entry for 9\.9\.9/);
});

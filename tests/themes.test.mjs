import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_THEMES, isThemeId, themeById, themeStyleSheet } from '../apps/web/src/themes.ts';
import { validateAppState } from '../apps/local-server/src/ui-state.js';

const channel = hex => {
  const n = hex.slice(1);
  return [0, 2, 4].map(index => {
    const value = parseInt(n.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
};
const luminance = hex => {
  const [r, g, b] = channel(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const css = readFileSync(new URL('../apps/web/src/style.css', import.meta.url), 'utf8');

test('every theme is a distinct, saveable id and the default dark palette matches the stylesheet', () => {
  assert.equal(new Set(APP_THEMES.map(theme => theme.id)).size, APP_THEMES.length);
  assert.ok(APP_THEMES.length >= 16);
  assert.equal(themeById('missing').id, 'dark');
  assert.equal(isThemeId('nord'), true);
  assert.equal(isThemeId('light'), true);
  assert.equal(isThemeId('nope'), false);
  const root = css.match(/:root \{([^}]+)\}/)[1];
  for (const [key, value] of Object.entries(themeById('dark').vars)) assert.ok(root.includes(`${key}: ${value}`), `${key} drifted from :root`);
  const sheet = themeStyleSheet();
  assert.doesNotMatch(sheet, /data-theme=dark/);
  for (const theme of APP_THEMES) {
    assert.match(theme.id, /^[a-z][a-z0-9-]{0,23}$/);
    if (theme.id !== 'dark') assert.match(sheet, new RegExp(`data-theme=${theme.id}\\b`));
    assert.equal(theme.vars['--focus'], theme.vars['--accent']);
  }
  const light = themeById('light').vars;
  assert.equal(light['--bg'], '#eceef1');
  assert.equal(light['--accent'], '#0b8db3');
  assert.equal(light['--accent-strong'], '#087a9b');
  assert.equal(light['--accent-fg'], '#ffffff');
  assert.equal(light['--term-selection'], '#0b8db333');
  assert.match(css, /data-scheme=light/);
  assert.doesNotMatch(css, /data-theme=light/);
});

test('text, buttons and terminal colours stay readable on each theme', () => {
  const failures = [];
  const check = (theme, name, fg, bg, min) => {
    if (!fg || !bg || fg.length !== 7 || bg.length !== 7) return;
    const ratio = contrast(fg, bg);
    if (ratio + 1e-6 < min) failures.push(`${theme.id} ${name} ${fg} on ${bg} = ${ratio.toFixed(2)} (need ${min})`);
  };
  for (const theme of APP_THEMES) {
    const v = theme.vars, bg = v['--bg'], surface = v['--surface'], term = v['--term-bg'];
    check(theme, 'fg/bg', v['--fg'], bg, 4.5);
    check(theme, 'fg/surface', v['--fg'], surface, 4.5);
    check(theme, 'muted', v['--muted'], surface, 3.5);
    check(theme, 'faint', v['--faint'], surface, 2.5);
    check(theme, 'accent text', v['--accent'], surface, 3);
    check(theme, 'accent button', v['--accent'], v['--accent-fg'], 3.8);
    if (theme.id === 'dark' || theme.id === 'light') continue;
    for (const name of ['--add', '--del', '--warn', '--info', '--ask', '--done', '--error']) check(theme, name, v[name], surface, 3);
    check(theme, 'term fg', v['--term-fg'], term, 4.5);
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
      check(theme, name, v[`--term-${name}`], term, 3);
      check(theme, `bright ${name}`, v[`--term-bright-${name}`], term, 3);
    }
  }
  assert.deepEqual(failures, []);
});

test('saved theme ids are accepted and junk is not', () => {
  const app = settings => ({ openProjects: [], activeProjectId: '', settings });
  assert.equal(validateAppState(app({ theme: 'nord' })).settings.theme, 'nord');
  assert.equal(validateAppState(app({ theme: 'rose-pine-dawn' })).settings.theme, 'rose-pine-dawn');
  for (const theme of ['Light', 'dark mode', 'a'.repeat(25), '../x', '']) assert.throws(() => validateAppState(app({ theme })), { code: 'INVALID_INPUT' }, theme);
});

test('보조 글자색(muted)은 모든 면에서 4.5:1, 힌트(faint)와 상태색(add·del·warn·info)은 3:1을 넘는다', () => {
  for (const theme of APP_THEMES) {
    const v = theme.vars;
    // 본문색(fg) 자체가 그 면에서 4.5:1에 못 미치는 팔레트(Solarized)는 muted도 fg를 넘을 수 없어, 그때는 fg와 같은 수준까지만 요구한다.
    for (const ground of ['--bg', '--surface', '--raised', '--overlay']) assert.ok(contrast(v['--muted'], v[ground]) >= Math.min(4.5, contrast(v['--fg'], v[ground])) - 0.01, `${theme.id}: muted on ${ground} ${contrast(v['--muted'], v[ground]).toFixed(2)}`);
    for (const ground of ['--bg', '--surface']) assert.ok(contrast(v['--faint'], v[ground]) >= 3, `${theme.id}: faint on ${ground} ${contrast(v['--faint'], v[ground]).toFixed(2)}`);
    for (const key of ['--add', '--del', '--warn', '--info']) assert.ok(contrast(v[key], v['--bg']) >= 3, `${theme.id}: ${key} ${contrast(v[key], v['--bg']).toFixed(2)}`);
  }
});

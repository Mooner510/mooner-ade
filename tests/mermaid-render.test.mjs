import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMermaidSvg } from '../apps/web/src/mermaid-render.ts';

test('mermaid svg strips percentage sizing that collapses in a pan/zoom canvas', () => {
  const raw = '<svg width="100%" height="100%" style="max-width: 600px;" viewBox="0 0 120 80"><rect width="10" height="10"/></svg>';
  const out = normalizeMermaidSvg(raw);
  assert.doesNotMatch(out, /width="100%"/);
  assert.doesNotMatch(out, /height="100%"/);
  assert.doesNotMatch(out, /max-width/);
  assert.match(out, /viewBox="0 0 120 80"/);
  assert.match(out, /width="120"/);
  assert.match(out, /height="80"/);
});

test('mermaid svg injects pixel size from viewBox when width and height are missing', () => {
  const raw = '<svg viewBox="4 4 200 100"><g/></svg>';
  const out = normalizeMermaidSvg(raw);
  assert.match(out, /width="200"/);
  assert.match(out, /height="100"/);
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Codex status bar and details show remaining credits, including credit-only accounts', async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const directory = await mkdtemp(join(tmpdir(), 'ade-usage-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(new URL('../apps/web/src/Workspace.tsx', import.meta.url), 'utf8');
  const outfile = join(directory, 'usage.cjs');
  await build({ stdin: { contents: `
    import { memo, useId } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { accountSources, barWindows, CodexCreditRow, codexCreditsLabel, CreditRow, defaultAccountDir, defaultUsageMeters, missingMeters, money, placeAbove, UsageRows, usageHueStyle, usageStatusShort } from './Usage';
    const Icon = () => null;
    let reading;
    const useUsage = () => ({ usage: reading, loading: false, load: async () => reading });
    ${source.slice(source.indexOf('const usageNames ='), source.indexOf('export const showKeys'))}
    export const render = (credits, windows = []) => {
      reading = { provider: 'codex', windows, codexCredits: credits, plan: 'pro', source: 'api', at: 0, error: null, account: {dir:'', from:'server'} };
      return renderToStaticMarkup(<UsageStat provider="codex" colors={false} projectId="test" active showSession refresh={180} />);
    };
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)) }, bundle: true, external: ['monaco-editor'], platform: 'node', format: 'cjs', jsx: 'automatic', outfile });
  const { render } = require(outfile);
  const credits = { balance: 1234.5, unlimited: false, hasCredits: true };
  const html = render(credits);
  assert.match(html, /<small>크레딧<\/small>1,234.5/);
  assert.match(html, /남은 크레딧<\/span><b>1,234.5/);
  assert.doesNotMatch(html, /₩|\$|월 한도|—/);
  assert.match(render({ ...credits, balance: 0, hasCredits: false }), /<small>크레딧<\/small>0/);
  assert.match(render({ ...credits, balance: null, unlimited: true }), /크레딧<\/small>무제한/);
  assert.match(render({ ...credits, balance: null }), /크레딧<\/small>잔액 있음/);
  assert.equal(render(null), '');
  const windows = [{key:'session', label:'5시간', percent:12, resetsAt:null}];
  assert.match(render(credits, windows), /12%/);
  assert.match(render(credits, windows), /주간 한도는 이 계정에 없어 표시하지 않습니다/);
  assert.doesNotMatch(render(null, windows), /크레딧/);
});

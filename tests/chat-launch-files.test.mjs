import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatLaunchFiles } from '../apps/local-server/src/chat-launch-files.js';
import { setAgentMcpServers } from '../apps/local-server/src/terminal-sessions.js';
import { UI_PROMPT } from '../apps/local-server/src/chat-ui-prompt.js';

async function setup(t, servers) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ade-launch-'));
  setAgentMcpServers(servers);
  t.after(async () => { setAgentMcpServers([]); await rm(dataRoot, { recursive: true, force: true }); });
  const chatRoot = async id => { const root = join(dataRoot, 'chat', id); await mkdir(root, { recursive: true }); return root; };
  return { dataRoot, chatRoot, prepare: chatLaunchFiles(dataRoot) };
}
const bus = { name: 'ade_bus', command: 'node', args: ['bus.mjs', '--port', '1'], chatOnly: true, autoApprove: true, disabledTools: ['send_message'] };

test('chats share one prompt file and one settings file; each keeps only its own MCP file', async t => {
  const { prepare, chatRoot } = await setup(t, [bus]);
  const [a, b] = [await chatRoot('a'), await chatRoot('b')];
  const first = await prepare(a, { chatId: 'a', projectId: 'p', agent: 'claude', interactiveUi: true });
  const second = await prepare(b, { chatId: 'b', projectId: 'p', agent: 'claude', interactiveUi: true });
  assert.equal(first.promptFile, second.promptFile);
  assert.equal(first.settingsFile, second.settingsFile);
  assert.notEqual(first.mcpFile, second.mcpFile);
  assert.equal(await readFile(first.promptFile, 'utf8'), UI_PROMPT);
  assert.deepEqual(JSON.parse(await readFile(first.settingsFile, 'utf8')), { permissions: { allow: ['mcp__ade_bus'], deny: ['mcp__ade_bus__send_message'] } });
  assert.equal(JSON.parse(await readFile(first.mcpFile, 'utf8')).mcpServers.ade_bus.env.ADE_CHAT_ID, 'a');
  assert.equal(JSON.parse(await readFile(second.mcpFile, 'utf8')).mcpServers.ade_bus.env.ADE_CHAT_ID, 'b');
  assert.deepEqual((await readdir(a)).sort(), ['claude-mcp.json'], 'nothing but the MCP file is written in the chat folder');
});

test('a restart of the same chat rewrites nothing', async t => {
  const { prepare, chatRoot } = await setup(t, [bus]);
  const root = await chatRoot('a'), context = { chatId: 'a', projectId: 'p', agent: 'claude', interactiveUi: true };
  const first = await prepare(root, context);
  const past = new Date(Date.now() - 60_000);
  for (const file of [first.mcpFile, first.settingsFile, first.promptFile]) await utimes(file, past, past);
  const again = await prepare(root, context);
  assert.deepEqual(again, first);
  for (const file of [first.mcpFile, first.settingsFile, first.promptFile]) assert.equal((await stat(file)).mtimeMs, past.getTime(), `${file} untouched`);
});

test('a changed plugin setting gets a new settings file and the old one stays readable for a running child', async t => {
  const { prepare, chatRoot } = await setup(t, [bus]);
  const root = await chatRoot('a'), context = { chatId: 'a', projectId: 'p', agent: 'claude' };
  const before = await prepare(root, context);
  setAgentMcpServers([{ ...bus, disabledTools: [] }]);
  const after = await prepare(root, context);
  assert.notEqual(after.settingsFile, before.settingsFile);
  assert.deepEqual(JSON.parse(await readFile(after.settingsFile, 'utf8')), { permissions: { allow: ['mcp__ade_bus'] } });
  assert.ok(JSON.parse(await readFile(before.settingsFile, 'utf8')).permissions.deny, 'the old file is intact');
  assert.equal(after.promptFile, undefined, 'no prompt file unless the chat uses the interactive UI');
});

test('without plugin servers only the prompt is passed, and copies old versions left in the chat folder are removed', async t => {
  const { prepare, chatRoot } = await setup(t, []);
  const root = await chatRoot('a');
  await writeFile(join(root, 'ade-ui-prompt.md'), 'old'); await writeFile(join(root, 'claude-settings.json'), '{}'); await writeFile(join(root, 'events.jsonl'), 'keep\n');
  const files = await prepare(root, { chatId: 'a', projectId: 'p', agent: 'claude', interactiveUi: true });
  assert.deepEqual(Object.keys(files).sort(), ['promptFile']);
  assert.deepEqual((await readdir(root)).sort(), ['events.jsonl'], 'only generated launch files are removed');
});

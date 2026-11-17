import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deviceUUID, feedbackIdentity } from '../apps/local-server/src/feedback-identity.js';

test('all identity fields are collected independently; email domains never leave the device', async () => {
  const calls = [];
  const identity = await feedbackIdentity(async (file, args) => {
    calls.push([file, args]);
    return file === 'gh' ? 'github-login\n' : args.at(-1) === 'user.name' ? 'Git Name\n' : 'local-part@example.com\n';
  });
  assert.deepEqual(identity, { ghLogin: 'github-login', gitName: 'Git Name', gitEmailPrefix: 'local-part' });
  assert.equal(calls.length, 3);
  assert.ok(calls.filter(([file]) => file === 'git').every(([, args]) => args.includes('--global')));
  assert.deepEqual(await feedbackIdentity(async () => ''), { ghLogin: '', gitName: '', gitEmailPrefix: '' });
  assert.deepEqual(await feedbackIdentity(async () => 'name@example.com'), { ghLogin: 'name', gitName: 'name', gitEmailPrefix: 'name' });
});

test('UUID is permanent across concurrent calls and restarts, and corruption never silently replaces it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ade-uuid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ids = await Promise.all(Array.from({ length: 8 }, () => deviceUUID(root)));
  assert.equal(new Set(ids).size, 1);
  assert.match(ids[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(await deviceUUID(root), ids[0]);
  assert.equal(JSON.parse(await readFile(join(root, 'device.json'), 'utf8')).uuid, ids[0]);
  await writeFile(join(root, 'device.json'), '{broken');
  await assert.rejects(deviceUUID(root));
  assert.equal(await readFile(join(root, 'device.json'), 'utf8'), '{broken');
});

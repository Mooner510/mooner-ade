import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nameOnly = value => String(value ?? '').replace(/<[^>]*>/g, '').split('@')[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 50);
const readCommand = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => resolve(error ? '' : stdout));
});

export async function feedbackIdentity(read = readCommand) {
  const [gh, name, email] = await Promise.all([
    read('gh', ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts', '--jq', '.hosts["github.com"][0].login // empty']),
    read('git', ['config', '--global', '--get', 'user.name']),
    read('git', ['config', '--global', '--get', 'user.email'])
  ]);
  return { ghLogin: nameOnly(gh), gitName: nameOnly(name), gitEmailPrefix: email.includes('@') ? nameOnly(email) : '' };
}

// Publishing a complete file with link prevents concurrent starts from replacing the permanent UUID.
export async function deviceUUID(root) {
  const file = path.join(root, 'device.json');
  const read = async () => {
    const { uuid } = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!UUID.test(uuid ?? '')) throw new Error('기기 UUID 파일이 올바르지 않습니다.');
    return uuid;
  };
  try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const uuid = randomUUID(), tmp = `${file}.${uuid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ uuid }), { mode: 0o600, flag: 'wx' });
    try { await fs.link(tmp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await read();
  } finally { await fs.rm(tmp, { force: true }); }
}

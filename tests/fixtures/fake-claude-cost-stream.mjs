// A fake `claude -p` whose session total grows 0.10 a turn and survives a restart (the real CLI restores its cost state on --resume): the count lives in FAKE_COST_FILE.
import readline from 'node:readline';
import fs from 'node:fs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake-model', permissionMode: 'default', slash_commands: [], tools: [] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.type !== 'user') return;
  const turns = Number(fs.existsSync(process.env.FAKE_COST_FILE) ? fs.readFileSync(process.env.FAKE_COST_FILE, 'utf8') : 0) + 1;
  fs.writeFileSync(process.env.FAKE_COST_FILE, String(turns));
  send({ type: 'assistant', message: { id: 'm' + turns, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', is_error: false, result: 'ok', session_id: 'fake-session', total_cost_usd: Math.round(turns * 10) / 100, duration_ms: 5, num_turns: turns });
});

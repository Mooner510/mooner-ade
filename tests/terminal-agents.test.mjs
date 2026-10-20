import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, terminalProcesses } from '../apps/local-server/src/terminal-processes.js';
import { createBannerDetector, createQuestionTracker, detectAgent, hasAgentQuestion, resolveAgent } from '../apps/web/src/terminal-agent.ts';

test('terminal processes detect native macOS CLIs, npm wrappers, exec and SSH without prompt false positives', () => {
  const table = parseProcessTable(`
    10 1 /bin/zsh
    11 10 /Users/me/.local/bin/claude --resume
    12 11 /opt/homebrew/bin/codex exec nested
    20 1 /bin/zsh
    21 20 node /opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js
    30 1 /bin/zsh
    31 30 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js
    40 1 /bin/zsh
    41 40 ssh host claude
    50 1 /bin/zsh
    51 50 vim /work/claude-code.md
    52 50 node app.js codex
    60 1 /Users/me/.local/bin/codex
    70 1 "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\node_modules\\@anthropic-ai\\claude-code\\cli.js"
  `);
  const inspect = terminalProcesses(table);
  assert.deepEqual(inspect(10), { agent: 'claude', ssh: false });
  assert.deepEqual(inspect(20), { agent: 'codex', ssh: false });
  assert.deepEqual(inspect(30), { agent: 'claude', ssh: false });
  assert.deepEqual(inspect(40), { agent: null, ssh: true });
  assert.deepEqual(inspect(50), { agent: null, ssh: false });
  assert.deepEqual(inspect(60), { agent: 'codex', ssh: false });
  assert.deepEqual(inspect(70), { agent: 'claude', ssh: false });
  assert.equal(terminalProcesses(table.filter(entry => entry.pid !== 11 && entry.pid !== 12))(10).agent, null);
});

test('ssh spawned by a local agent or git is a tool call, not an ssh terminal', () => {
  const inspect = terminalProcesses(parseProcessTable(`
    10 1 /bin/zsh
    11 10 /Users/me/.local/bin/claude
    12 11 /bin/zsh -c git fetch
    13 12 git fetch
    14 13 ssh git@github.com git-upload-pack repo
    20 1 /bin/zsh
    21 20 git push
    22 21 ssh git@github.com git-receive-pack repo
  `));
  assert.deepEqual(inspect(10), { agent: 'claude', ssh: false });
  assert.deepEqual(inspect(20), { agent: null, ssh: false });
});

test('process evidence wins over stale titles and launchers; exiting clears local agent identity', () => {
  assert.equal(resolveAgent('codex', 'claude', '✳ Claude migration', false), 'codex');
  assert.equal(resolveAgent('claude', 'codex', 'Codex', false), 'claude');
  assert.equal(resolveAgent(null, 'claude', 'Claude Code', false), undefined);
  assert.equal(resolveAgent(undefined, 'codex', '⠋ Claude task', false), 'claude');
  assert.equal(resolveAgent(undefined, 'claude', '⠋ Codex', false), 'codex');
  assert.equal(resolveAgent(null, 'claude', 'OpenAI Codex', true), 'codex');
  assert.equal(resolveAgent('codex', 'claude', '⠋ Claude Code', false), 'codex');
  assert.equal(resolveAgent(null, 'claude', '⠋ Working', true), 'claude');
  assert.equal(detectAgent('/work/claude-code'), undefined);
  assert.equal(detectAgent('⠋ Working on codex'), undefined);
  assert.equal(detectAgent('Claude Code'), 'claude');
  assert.equal(detectAgent('OpenAI Codex'), 'codex');
  assert.equal(detectAgent('⠋ Codex'), 'codex');
  assert.equal(detectAgent('✳ OpenAI Codex'), 'codex');
});

test('banner detection handles split ANSI sequences and uses the last session in replay', () => {
  const detect = createBannerDetector();
  assert.equal(detect('OpenAI Codex v1\r\nClaude Code v2', true), 'claude');
  assert.equal(detect('Claude Code v2\r\nOpenAI Codex v1', true), 'codex');
  assert.equal(detect('ordinary output'), undefined);
  assert.equal(detect('OpenAI Codex\r\nClau', true), 'codex');
  assert.equal(detect('de Code v2'), 'claude');
  assert.equal(detect('Clau\x1b[3', true), undefined);
  assert.equal(detect('1mde Code v2'), 'claude');
  assert.equal(detect('OpenAI Co', true), undefined);
  assert.equal(detect('dex'), 'codex');
  assert.equal(detect('Claude Code v', true), undefined);
  assert.equal(detect('2', true), undefined);
});

const codexApproval = `Would you like to run the following command?
  › 1. Yes, proceed (y)
    2. No, and tell Codex what to do differently (esc)
Press enter to confirm or esc to cancel`;
const claudeQuestion = `Which approach should we use?
  ❯ 1. Keep the current implementation
    2. Replace it
Enter to select · ↑/↓ to navigate · Esc to cancel`;

test('agent questions detect Codex action titles, approvals and Claude question controls without treating ordinary answers as questions', () => {
  assert.equal(hasAgentQuestion('', 'Codex — Action Required'), true);
  assert.equal(hasAgentQuestion('│ Action Required │'), true);
  assert.equal(hasAgentQuestion(codexApproval), true);
  assert.equal(hasAgentQuestion(claudeQuestion), true);
  assert.equal(hasAgentQuestion('Do you want to proceed?\n❯ 1. Yes\n  2. No'), true);
  assert.equal(hasAgentQuestion('Do you want to proceed?\n  1. Yes\n❯ 2. No'), true);
  assert.equal(hasAgentQuestion('Choose a value\nEnter to submit · Esc to cancel'), true);
  assert.equal(hasAgentQuestion('Choose a value\nEnter to\nselect · Esc to dismiss'), true);
  assert.equal(hasAgentQuestion('Would you like to try the change?'), false);
  assert.equal(hasAgentQuestion('The Action Required notification is now handled.'), false);
  assert.equal(hasAgentQuestion('❯ Explain the code\n? for shortcuts'), false);
  assert.equal(hasAgentQuestion('Working…', '⠋ Claude Code'), false);
});

test('questions survive focus reports, typing, navigation and blank redraws while the question UI stays present', () => {
  for (const prompt of [codexApproval, claudeQuestion]) {
    const question = createQuestionTracker();
    assert.equal(question.observe(prompt), true);
    for (const data of ['\x1b[I', '\x1b[O', '\x1b[<0;4;2M', 'answer', '\x1b[A', '\x1b[B', '\t', '\x1b\r', '\x1b[200~pasted\rtext\x1b[201~']) {
      question.input(data);
      assert.equal(question.observe(''), true);
      assert.equal(question.observe(prompt), true);
    }
    question.input('\r');
    assert.equal(question.observe(prompt), true);
    assert.equal(question.observe('Working…'), false);
    assert.equal(question.observe(claudeQuestion), true);
  }
});

test('questions clear on dismissal, including shortcut responses, without trusting stale Action Required titles', () => {
  for (const input of ['\r', '\n', '\x1b', '\x03', 'y', 'n', '1', '2']) {
    const question = createQuestionTracker();
    assert.equal(question.observe(claudeQuestion), true);
    question.input(input);
    assert.equal(question.observe('› '), false);
  }
  const question = createQuestionTracker();
  assert.equal(question.observe('', 'Action Required'), true);
  question.input('\r');
  assert.equal(question.observe(codexApproval, 'Action Required'), true);
  assert.equal(question.observe('Working…', 'Action Required'), false);
  assert.equal(question.observe('Done.\n› ', 'Action Required'), false);
  assert.equal(question.observe('', 'Codex'), false);
  assert.equal(question.observe('', 'Action Required'), true);
  question.observe(claudeQuestion);
  question.reset();
  assert.equal(question.observe(''), false);
});

test('completion bells and ordinary completed output never create or latch a question', () => {
  const question = createQuestionTracker();
  assert.equal(question.observe('Done.\x07\n› '), false);
  assert.equal(question.observe('Done.\x07', 'Codex'), false);
  assert.equal(question.observe(claudeQuestion), true);
  // Mouse selection, external approval or CLI cancellation can dismiss a question without a submitted key.
  assert.equal(question.observe('Working…'), false);
  assert.equal(question.observe('Done.\x07\n❯ '), false);
});

test('old approval text above the current composer does not keep a completed terminal in attention', () => {
  const question = createQuestionTracker();
  assert.equal(question.observe(codexApproval), true);
  assert.equal(question.observe(`${codexApproval}\nDone.\n› `, 'Action Required'), false);
  assert.equal(question.observe(`${claudeQuestion}\nDone.\n❯ Explain the changes`), false);
  assert.equal(question.observe(`${codexApproval}\n› Next task\n${claudeQuestion}`), true);
});

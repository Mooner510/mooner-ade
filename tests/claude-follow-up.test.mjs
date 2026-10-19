import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeFollowUp, hasEmptyClaudeComposer, claudeDraftInput, claudePromptInput, validClaudeDraft, claudeFollowUpVersion } from '../apps/web/src/claude-follow-up.ts';

test('automatic follow-up requires a Claude version with progress covering the whole turn', () => {
  assert.equal(claudeFollowUpVersion('Claude Code v2.1.123'), false);
  assert.equal(claudeFollowUpVersion('Claude Code v2.1.302'), false);
  for (const version of ['2.1.303', '2.1.304', '2.2.0', '3.0.0']) assert.equal(claudeFollowUpVersion(`Claude Code v${version}`), true);
  assert.equal(claudeFollowUpVersion('OpenAI Codex v2.1.303'), undefined);
  assert.equal(claudeFollowUpVersion('Claude Code v2.'), undefined);
  assert.equal(claudeFollowUpVersion('Claude Code v2.1.303\nClaude Code v2.1.123'), false);
});

test('follow-ups wait for a real working-to-idle transition and send one per turn', () => {
  const queue = createClaudeFollowUp();
  queue.enqueue('첫 번째'); queue.enqueue('두 번째');
  queue.progress('4;0;'); // Startup clear is not a completed task.
  assert.equal(queue.next(true), undefined);
  queue.progress('4;3;');
  assert.equal(queue.next(true), undefined); // Long silent tool calls stay working.
  queue.progress('4;0;'); queue.progress('4;0;');
  assert.equal(queue.next(false), undefined); // Approval, draft, or nonempty native composer.
  const first = queue.next(true);
  assert.equal(first.text, '첫 번째');
  assert.deepEqual(queue.next(true), first); // Disconnected send does not drop the item.
  queue.sent(first.id);
  assert.equal(queue.next(true), undefined);
  queue.progress('4;0;');
  assert.equal(queue.next(true), undefined); // Duplicate clear cannot consume another item.
  queue.progress('4;1;50'); queue.progress('4;0;');
  assert.equal(queue.next(true).text, '두 번째');
});

test('interrupts, errors and replay pause pending items until explicit resume', () => {
  for (const stop of [queue => queue.pause(), queue => queue.reset(), queue => queue.progress('4;2;0'), queue => queue.progress('4;4;0')]) {
    const queue = createClaudeFollowUp();
    queue.progress('4;3;'); queue.enqueue('보존'); stop(queue);
    queue.progress('4;3;'); queue.progress('4;0;');
    assert.equal(queue.next(true), undefined);
    assert.equal(queue.paused, true);
    assert.equal(queue.items[0].text, '보존');
    queue.resume();
    assert.equal(queue.next(true).text, '보존');
    queue.remove(queue.items[0].id);
    assert.equal(queue.next(true), undefined);
  }
});

test('manual submit invalidates a pending completion so it cannot merge a follow-up into the new task', () => {
  const queue = createClaudeFollowUp();
  queue.progress('4;3'); queue.progress('4;0'); queue.enqueue('나중에');
  queue.submitted();
  assert.equal(queue.next(true), undefined);
  queue.progress('4;3'); queue.progress('4;0');
  assert.equal(queue.next(true).text, '나중에');
});

test('resuming after replay does not assume that a still-running task has finished', () => {
  const queue = createClaudeFollowUp();
  queue.progress('4;3'); queue.enqueue('기다리기'); queue.reset(); queue.resume();
  assert.equal(queue.next(true), undefined);
  queue.progress('4;0');
  assert.equal(queue.next(true), undefined);
  queue.progress('4;3'); queue.progress('4;0');
  assert.equal(queue.next(true).text, '기다리기');
});

test('only a visibly empty Claude composer permits automatic input', () => {
  assert.equal(hasEmptyClaudeComposer('Done\n──────\n❯ \n──────\n? for shortcuts'), true);
  for (const screen of ['❯ text\n──────', '❯ \nsecond line\n──────', '❯ ', '$ ', '❯ 1. Yes\n  2. No\n──────']) assert.equal(hasEmptyClaudeComposer(screen), false);
  assert.equal(hasEmptyClaudeComposer('❯ old input\n──────\nDone\n❯ \n──────'), true);
});

test('draft capture preserves Unicode and multiline paste without stealing terminal controls', () => {
  assert.equal(claudeDraftInput('한글🙂'), '한글🙂');
  assert.equal(claudeDraftInput('\x1b[200~first\r\nsecond\x1b[201~'), 'first\nsecond');
  for (const input of ['\t', '\r', '\x1b[A', '\x03', '\x1b[I', '\x1b[200~bad\x1btext\x1b[201~']) assert.equal(claudeDraftInput(input), undefined);
  assert.equal(claudePromptInput('한글\nsecond'), '\x1b[200~한글\nsecond\x1b[201~\r');
  for (const input of ['', '  ', 'x'.repeat(16001), '\x1b[201~\rmalicious']) {
    assert.equal(validClaudeDraft(input), false);
    assert.equal(createClaudeFollowUp().enqueue(input), false);
  }
  assert.equal(validClaudeDraft('x'.repeat(16000)), true);
});

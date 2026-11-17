// What a chat's system prompt holds, as the fake claude logged it: an old chat (already had a session) keeps its prompt, a new chat gets the file-path instructions.
// Needs the verify session with a chat already open. Usage: VERIFY_OUT=… node scripts/verify/t-chat-prompt.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, env } from './cdp.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const c = await connect(p => p.url.includes('127.0.0.1'));
const log = join(env().temp, 'fake-claude.jsonl');
const streams = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.kind === 'stream');
let failed = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) failed++; };
// Several chats keep their composer in the page; the one on screen is the one that gets the text.
const send = async text => { await c.ev(`[...document.querySelectorAll('textarea[aria-label="메시지 입력"]')].find(e => e.offsetParent).focus()`); await c.type(text); await c.key('Enter', 'Enter'); };

// 1. the chat that is already open (it has a session, e.g. from before a server restart): its prompt must not change
let mark = streams().length;
await send('hello again'); await sleep(6000);
const old = streams().slice(mark).at(-1);
ok(old, 'the old chat started its CLI');
ok(old && /# UI blocks/.test(old.systemPrompt ?? '') && !/# File paths/.test(old.systemPrompt ?? ''), 'old chat: same prompt as before (UI blocks only, no file-path instructions)', JSON.stringify((old?.systemPrompt ?? '').slice(0, 40)));

// 2. a brand-new chat
await c.key('t', 'KeyT', 2 | 8); // Ctrl+Shift+T: new tab -> launcher
await sleep(800);
if (await c.ev(`return [...document.querySelectorAll('button')].some(b => b.offsetParent && b.textContent.includes('Chat 모드'))`)) { await c.clickSel('button', 'Chat 모드'); await sleep(400); }
await c.clickSel('button', 'Claude'); await sleep(2500);
mark = streams().length;
await send('hello new'); await sleep(6000);
const fresh = streams().slice(mark).at(-1);
ok(fresh, 'the new chat started its CLI');
ok(fresh && /# File paths/.test(fresh.systemPrompt ?? '') && /\[\[file:src\/app\.ts:42\]\]/.test(fresh.systemPrompt ?? ''), 'new chat: told to write [[file:path:line]]');
ok(fresh && /# UI blocks/.test(fresh.systemPrompt ?? ''), 'new chat: UI blocks instructions still there (setting is on)');
c.close();
process.exit(failed ? 1 : 0);

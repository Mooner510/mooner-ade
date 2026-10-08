import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdeEngine, AllowAllPolicy } from '../packages/core/src/index.js';
import { FileSessionStore } from '../packages/session-store/src/index.js';
import { RecordedAgentRunner } from '../packages/session-runner/src/index.js';
const runtime = { workspace: {}, processes: {}, git: {}, terminal: {} };
async function setup(t, agent) {
  const folder = await mkdtemp(join(tmpdir(), 'ade-runner-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const engine = new AdeEngine({ runtime, policy: new AllowAllPolicy(), agents: [agent] });
  const store = new FileSessionStore(folder);
  return { engine, store, runner: new RecordedAgentRunner({ engine, store }), folder };
}
test('completed engine execution is persisted, sequenced and replayable', async t => {
  const { runner, folder } = await setup(t, { id: 'mock', async *run() { yield {kind:'text',text:'Hi'}; } });
  const output = [];
  for await (const event of runner.runAgent('mock','hello')) output.push(event);
  assert.deepEqual(output.map(e=>e.sequence), [1,2,3]);
  assert.deepEqual(output.map(e=>e.kind), ['lifecycle','text','lifecycle']);
  const id = output[0].sessionId;
  assert.equal((await runner.getSession(id)).session.status, 'completed');
  const reader = new RecordedAgentRunner({ engine: {runAgent(){} ,stopAgent(){}},store:new FileSessionStore(folder) });
  assert.deepEqual((await reader.replay(id,{afterSequence:1})).map(e=>e.kind),['text','lifecycle']);
});
test('failed engine execution preserves failure events and terminal status', async t => {
  const { runner } = await setup(t, {id:'broken', async *run(){throw new Error('broken');}});
  const events=[]; for await (const e of runner.runAgent('broken','x')) events.push(e);
  assert.equal((await runner.getSession(events[0].sessionId)).session.status,'failed');
  assert.equal(events.at(-1).phase,'failed');
});
test('early stream disposal marks session interrupted immediately', async t => {
  const { runner } = await setup(t, {id:'partial',async *run(){yield {kind:'text',text:'started'};await new Promise(()=>{});}});
  const iter=runner.runAgent('partial','test');
  const first=await iter.next();
  assert.equal(first.value.sequence,1);
  await iter.return();
  const record=await runner.getSession(first.value.sessionId);
  assert.equal(record.session.status,'interrupted');
  const recovered=await runner.recover(first.value.sessionId);
  assert.equal(recovered.session.status,'interrupted');
});
test('does not run adapter without explicit runtime permission', async t => {
  const folder = await mkdtemp(join(tmpdir(),'ade-runner-deny-'));
  t.after(()=>rm(folder,{recursive:true,force:true}));
  let invoked=false;
  const engine=new AdeEngine({runtime,agents:[{id:'mock',async *run(){invoked=true;yield {kind:'text'};}}]});
  const runner=new RecordedAgentRunner({engine,store:new FileSessionStore(folder)});
  await assert.rejects(async()=>{for await(const _ of runner.runAgent('mock','hello')){}},/Permission denied/);
  assert.equal(invoked,false);
});

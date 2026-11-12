import test from 'node:test';
import assert from 'node:assert/strict';
import { formMessage, niceTicks, parseUi } from '../apps/web/src/ui-spec.ts';

test('known components parse, unknown or broken JSON do not', () => {
  assert.equal(parseUi('not json'), null);
  assert.equal(parseUi('["nope"]'), null);
  assert.equal(parseUi('{"t":"steps"}'), null);
  assert.equal(parseUi('[1,"x",null]'), null);
  assert.deepEqual(parseUi('["steps",["Build","done"],["Ship","weird"],"Plain"]'), [{ t: 'steps', items: [['Build', 'done'], ['Ship', 'todo'], ['Plain', 'todo']] }]);
  assert.equal(parseUi('[["stats"],["bad"],["steps"]]').length, 2);
});

test('stats take tone and sub in either order of presence', () => {
  const [stats] = parseUi('["stats",["Up","99%","ok","30d"],["Lat","24ms"],["Q","3","7 days"]]');
  assert.deepEqual(stats.items.map(i => [i.label, i.value, i.tone, i.sub]), [['Up', '99%', 'ok', '30d'], ['Lat', '24ms', '', ''], ['Q', '3', '', '7 days']]);
});

test('charts read series as [name, ...values]', () => {
  const [chart] = parseUi('["chart","line","Users",["Jan","Feb"],["Web",3,5],["App",2,"x"]]');
  assert.deepEqual([chart.kind, chart.title, chart.x, chart.y], ['line', 'Users', ['Jan', 'Feb'], [['Web', [3, 5]], ['App', [2, 0]]]]);
  assert.equal(parseUi('["chart","radar","t",["a"]]')[0].kind, 'bar');
});

test('model output is coerced and capped, never trusted', () => {
  const [stats] = parseUi(JSON.stringify(['stats', ['x'.repeat(999), 5, '<script>'], 7, null]));
  assert.equal(stats.items[0].label.length, 200); assert.equal(stats.items[0].value, '5'); assert.equal(stats.items[0].tone, ''); assert.equal(stats.items.length, 3);
  assert.equal(parseUi(JSON.stringify(['stats', ...Array(99).fill(['a', 'b'])]))[0].items.length, 12);
});

test('form fields get sane defaults and submit as a plain message', () => {
  const [form] = parseUi('["form","Plan","Go",["slider","seats","Seats",2,1],["radio","c","Billing","monthly","yearly"],["check","ok","Ok"],["text","n","Name","Ann"],["zzz"]]');
  assert.deepEqual(form.fields.map(f => [f.k, f.type, f.value, f.max]), [['seats', 'slider', '2', 2], ['c', 'radio', 'monthly', 100], ['ok', 'check', 'false', 100], ['n', 'text', 'Ann', 100]]);
  assert.equal(form.submit, 'Go'); assert.equal(form.fill, false);
  assert.equal(formMessage(form, { seats: '5', c: 'yearly', ok: 'true', n: 'Bo' }), 'Plan\n- Seats: 5\n- Billing: yearly\n- Ok: yes\n- Name: Bo');
  assert.equal(parseUi('["draft","t","s",["text","a","A"]]')[0].fill, true);
});

test('chart gridlines fall on round steps that cover every value', () => {
  assert.deepEqual(niceTicks(0, 7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(0, 100), [0, 50, 100]);
  assert.deepEqual(niceTicks(0, 1), [0, 0.5, 1]);
  assert.deepEqual(niceTicks(-3, 9), [-5, 0, 5, 10], 'negative values get their own steps below zero');
  assert.deepEqual(niceTicks(0, 0), [0]);
});

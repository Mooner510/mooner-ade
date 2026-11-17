import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { terminalEditKey } from '../apps/web/src/terminal-keys.ts';

const event = (key, modifiers = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, ...modifiers });
const cmd = { metaKey: true }, alt = { altKey: true }, ctrl = { ctrlKey: true }, shift = { shiftKey: true };
const edits = [
  ['ArrowLeft', cmd, '\x01'], ['ArrowRight', cmd, '\x05'],
  ['ArrowUp', cmd, '\x1b[1;5H'], ['ArrowDown', cmd, '\x1b[1;5F'],
  ['ArrowLeft', { ...cmd, ...shift }, '\x1b[1;2H'], ['ArrowRight', { ...cmd, ...shift }, '\x1b[1;2F'],
  ['ArrowUp', { ...cmd, ...shift }, '\x1b[1;6H'], ['ArrowDown', { ...cmd, ...shift }, '\x1b[1;6F'],
  ['Backspace', cmd, '\x15'], ['Delete', cmd, '\x0b'], ['Delete', alt, '\x1bd'], ['Backspace', ctrl, '\x17']
];

test('terminal edit translations preserve IME, other platforms and xterm-owned keys', () => {
  for (const [key, modifiers, expected] of edits) {
    assert.equal(terminalEditKey(event(key, modifiers), true), expected);
    assert.equal(terminalEditKey(event(key, { ...modifiers, isComposing: true }), true), undefined);
    assert.equal(terminalEditKey(event(key, modifiers), false), key === 'Backspace' && modifiers.ctrlKey ? expected : undefined);
  }
  for (const key of ['Tab', 'Enter', 'Home', 'End', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'b', 'd', 'e', 'f', 'h', 'k', 'u', 'w']) {
    for (const modifiers of [{}, shift, alt, ctrl, { ...ctrl, ...shift }, { ...ctrl, ...alt }, { ...cmd, ...alt }]) {
      if (edits.some(([k, mods]) => k === key && JSON.stringify(event(k, mods)) === JSON.stringify(event(key, modifiers)))) continue;
      assert.equal(terminalEditKey(event(key, modifiers), true), undefined, `${key} ${JSON.stringify(modifiers)}`);
    }
  }
});

test('native terminal and composer keys preserve editing, completion and application cursor mode', { skip: !process.env.ADE_TEST_CDP }, async t => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('vite', { paths: ['apps/web'] }))('esbuild');
  const bundle = await build({ stdin: { contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Panes } from './Panes';
    import { defaultSettings } from './Editor';
    import { demoChatState, demoModels } from './chat-demo';
    window.inputs = [];
    window.chatCalls = [];
    const noop = () => {}, bus = { buffers: new Map(), listeners: new Map(), sizes: new Map(), sizeListeners: new Map() };
    window.feed = data => bus.listeners.get('test')({data, sequence: 1});
    const call = async (action, input) => {
      if (action === 'chat/open') return {state: {...demoChatState(), effort:'medium'}, events:[], seq:0, approvals:[]};
      if (action === 'chat/models') return demoModels;
      if (action === 'chat/commands') return [{name:'help', description:'Help'}, {name:'clear', description:'Clear'}];
      if (action === 'files/list') return {files:['a.ts', 'b.ts', 'src/']};
      if (action === 'chat/set' || action === 'chat/send') chatCalls.push({action, input});
      return {};
    };
    const subscribe = () => noop;
    function App() {
      const [settings, setSettings] = useState({...defaultSettings, terminalGpu: false, tips: false});
      const [kind, setKind] = useState('terminal');
      window.renderChat = () => setKind('chat');
      window.optionMeta = value => setSettings(old => ({...old, optionAsMeta: value}));
      return <Panes pane={{id:'test',kind}} visible focus="test" zoom="" bus={bus} live={new Set(['test'])} cwds={{test:'/tmp'}} titles={{}}
        editor={{settings}} chat={{settings, onSettingsChange:setSettings, root:'/tmp', projectId:'fixture', call, subscribe, onTitle:noop, onState:noop, fail:console.error}} send={m => {if(m.type === 'terminal/input') inputs.push(m.data); return true;}}
        agentOf={noop} ssh={new Set()} working={new Set()} attention={{}} caches={{}}
        onAgent={noop} onAgentEvent={noop} onAgentResolved={noop} onAgentWorking={noop} onFocus={noop} onTitle={noop}
        onSplit={noop} onZoom={noop} onClose={noop} onModeChange={noop} />;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../apps/web/src', import.meta.url)) }, bundle: true, write: false, jsx: 'automatic', format: 'iife', loader: { '.css': 'empty' }, external: ['monaco-editor', 'monaco-editor/*'], banner: { js: 'const emptyGlob = () => ({});' }, define: { 'import.meta.env.DEV': 'false', 'import.meta.glob': 'emptyGlob' } });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : '<div id="root" style="width:900px;height:500px"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = process.env.ADE_TEST_CDP;
  const page = await (await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' })).json();
  t.after(() => fetch(`${endpoint}/json/close/${page.id}`));
  const socket = new WebSocket(page.webSocketDebuggerUrl), pending = new Map(), errors = [];
  let sequence = 0;
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data), request = pending.get(message.id);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(' '));
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  t.after(() => socket.close());
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  for (let i = 0; i < 100; i++) { if (await evaluate('!!document.querySelector(".xterm-helper-textarea")')) break; await new Promise(resolve => setTimeout(resolve, 30)); }
  assert.ok(await evaluate('!!document.querySelector(".xterm-helper-textarea")'), errors.join('\n'));
  await evaluate('document.querySelector(".xterm-helper-textarea").focus()');
  const mac = await evaluate('/Mac|iPhone|iPad/.test(navigator.platform)');
  const codes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Delete: 46, Tab: 9, Enter: 13, Home: 36, End: 35, Escape: 27 };
  const dispatch = async (key, mods, commands) => {
    const modifiers = (mods.altKey ? 1 : 0) | (mods.ctrlKey ? 2 : 0) | (mods.metaKey ? 4 : 0) | (mods.shiftKey ? 8 : 0);
    const params = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, modifiers, windowsVirtualKeyCode: codes[key] ?? key.toUpperCase().charCodeAt(0) };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params, ...(commands && { commands }) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    await settle();
  };
  const press = async (key, mods, expected) => {
    await evaluate('inputs.length = 0');
    await dispatch(key, mods);
    assert.deepEqual(await evaluate('inputs'), expected ? [expected] : [], `${key} ${JSON.stringify(mods)}`);
  };
  if (mac) for (const [key, modifiers, expected] of edits) await press(key, modifiers, expected);
  for (const [key, suffix] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D']]) {
    await press(key, {}, `\x1b[${suffix}`);
    for (const [modifiers, number] of [[shift, 2], [ctrl, 5], [{ ...ctrl, ...shift }, 6], [{ ...alt, ...shift }, 4]]) await press(key, modifiers, `\x1b[1;${number}${suffix}`);
    await press(key, alt, mac && 'CD'.includes(suffix) ? `\x1b${suffix === 'C' ? 'f' : 'b'}` : `\x1b[1;${mac ? 3 : 5}${suffix}`);
  }
  for (const [key, modifiers, expected] of [
    ['Backspace', {}, '\x7f'], ['Backspace', alt, '\x1b\x7f'], ['Backspace', ctrl, '\x17'],
    ['Delete', {}, '\x1b[3~'], ['Delete', ctrl, '\x1b[3;5~'],
    ['Home', {}, '\x1b[H'], ['End', {}, '\x1b[F'], ['Home', shift, '\x1b[1;2H'], ['End', ctrl, '\x1b[1;5F'],
    ['Tab', {}, '\t'], ['Tab', shift, '\x1b[Z'], ['Enter', {}, '\r'], ['Enter', shift, '\x1b\r'], ['Enter', alt, '\x1b\r'],
    ['Escape', {}, '\x1b'], ...['a', 'b', 'c', 'd', 'e', 'f', 'h', 'k', 'n', 'p', 'u', 'w', 'y', 'z'].map(key => [key, ctrl, String.fromCharCode(key.charCodeAt(0) - 96)])
  ]) await press(key, modifiers, expected);
  await evaluate('optionMeta(true)'); await settle();
  for (const key of ['b', 'd', 'f', 'w']) await press(key, alt, `\x1b${key}`);
  await evaluate('feed("\\x1b[?1h")'); await settle();
  for (const [key, suffix] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D']]) await press(key, {}, `\x1bO${suffix}`);

  await evaluate('renderChat()'); await settle();
  const box = 'textarea[aria-label="메시지 입력"]';
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector(${JSON.stringify(box + ':enabled')})`)) break; await new Promise(resolve => setTimeout(resolve, 30)); }
  await evaluate(`document.querySelector(${JSON.stringify(box)}).focus()`);
  const composer = () => evaluate(`(() => { const t=document.querySelector(${JSON.stringify(box)}); return {text:t.value, start:t.selectionStart, end:t.selectionEnd, calls:chatCalls}; })()`);
  const type = text => send('Input.insertText', { text }).then(settle);
  const clear = async () => { await evaluate(`document.querySelector(${JSON.stringify(box)}).focus()`); await dispatch('a', mac ? cmd : ctrl, ['selectAll']); };
  await type('alpha beta\ngamma delta');
  await dispatch('ArrowLeft', shift);
  let state = await composer(); assert.equal(state.end - state.start, 1); assert.deepEqual(state.calls, []);
  await dispatch('ArrowLeft', { ...alt, ...shift });
  state = await composer(); assert.ok(state.end - state.start > 1); assert.deepEqual(state.calls, []);
  if (mac) {
    await dispatch('ArrowLeft', { ...cmd, ...shift }, ['moveToBeginningOfLineAndModifySelection']);
    state = await composer(); assert.equal(state.start, 11); assert.equal(state.end, 22); assert.deepEqual(state.calls, []);
  }
  await dispatch('ArrowUp', shift);
  state = await composer(); assert.ok(state.end > state.start); assert.deepEqual(state.calls, []);
  await dispatch('ArrowRight', { ...ctrl, ...alt });
  assert.ok((await composer()).calls.some(call => call.action === 'chat/set' && call.input.model));
  await dispatch('ArrowUp', { ...ctrl, ...alt });
  assert.ok((await composer()).calls.some(call => call.action === 'chat/set' && call.input.effort));
  for (const text of ['/', '@']) {
    await clear(); await type(text);
    for (let i = 0; i < 100; i++) { if (await evaluate('!!document.querySelector(".chat-commands")')) break; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.ok(await evaluate('!!document.querySelector(".chat-commands")'), `${text}: ${JSON.stringify(await composer())} ${errors.join('\n')}`);
    await evaluate('chatCalls.length = 0');
    await dispatch('ArrowDown', shift);
    await dispatch('Tab', { ...ctrl, ...shift });
    state = await composer(); assert.equal(state.text, text); assert.deepEqual(state.calls, []);
  }
  await clear(); await type('draft'); await dispatch('Enter', alt, ['insertNewline']);
  state = await composer(); assert.ok(state.text.includes('\n')); assert.deepEqual(state.calls, []);
  assert.deepEqual(errors, []);
});

// Stand-in for the `electron` module, so tests can load apps/desktop/src/updater.js outside Electron (see electron-hooks.mjs).
// A test sets globalThis.__adeElectron before importing the updater:
//   { version, appPath, onMessage(options) -> response index, messages: [], errors: [], quits: 0 }
const state = () => globalThis.__adeElectron;

export const app = {
  getName: () => 'MoonerADE',
  getVersion: () => state().version,
  getAppPath: () => state().appPath,
  quit: () => { state().quits++; },
};

export const dialog = {
  // (window, options) or (options): the last argument is the options either way.
  async showMessageBox(...args) {
    const options = args.at(-1), current = state();
    current.messages.push(options);
    return { response: current.onMessage(options), checkboxChecked: false };
  },
  showErrorBox(title, content) { state().errors.push({ title, content }); },
};

export default { app, dialog };

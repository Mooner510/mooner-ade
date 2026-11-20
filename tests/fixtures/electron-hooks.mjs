// Module hooks (node:module register): `import 'electron'` resolves to electron-stub.mjs, so updater.js can run in a plain node test.
const stub = new URL('./electron-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: stub, shortCircuit: true };
  return next(specifier, context);
}

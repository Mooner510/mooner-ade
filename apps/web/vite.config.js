import { defineConfig } from 'vite';

// React's development build re-checks and profiles every render, roughly doubling the UI's CPU while agents stream output.
// `pnpm dev` (the app people work in all day) uses the production build too; ADE_REACT_DEV=1 brings the warnings back.
const reactDev = process.env.ADE_REACT_DEV === '1';

export default defineConfig(({ command }) => {
  // A NODE_ENV=development inherited from the shell (e.g. a terminal of an older dev app) would make `vite build` bundle it.
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    ...(command === 'serve' && !reactDev ? { esbuild: { jsxDev: false }, optimizeDeps: { esbuildOptions: { define: { 'process.env.NODE_ENV': '"production"' } } } } : {}),
    build: {
      // Keep the Atom Material Icons as separate files; inlining them as data URIs would add ~3 MB to the bundle.
      assetsInlineLimit: (file) => (file.includes('atom-material-icons') ? false : undefined)
    }
  };
});

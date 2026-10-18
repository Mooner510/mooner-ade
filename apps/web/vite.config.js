import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Keep the Atom Material Icons as separate files; inlining them as data URIs would add ~3 MB to the bundle.
    assetsInlineLimit: (file) => (file.includes('atom-material-icons') ? false : undefined)
  }
});

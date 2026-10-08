import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const packages = await readdir(join(root, 'packages'));
for (const name of packages) {
  const folder = join(root, 'packages', name);
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  if (!pkg.exports?.['.']?.types || !pkg.exports?.['.']?.default) throw new Error(`${name}: missing exports`);
  await import(join(folder, 'src/index.js'));
}
console.log(`Verified ${packages.length} importable ADE packages`);

import { cpSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function stagePluginApi(source, target, builtinDir) {
  const configuration = JSON.parse(readFileSync(path.join(source, 'versions.json'), 'utf8'));
  const included = new Set(configuration.supported.map(entry => `v${entry.version}`));
  const apiVersions = new Set(configuration.supported.map(entry => entry.version));
  for (const entry of readdirSync(builtinDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const { apiVersion, id } = JSON.parse(readFileSync(path.join(builtinDir, entry.name, 'plugin.json'), 'utf8'));
    if (!apiVersions.has(apiVersion)) throw new Error(`Built-in plugin ${id} requires excluded API v${apiVersion}`);
  }
  cpSync(source, target, { recursive: true, filter(file) {
    const root = path.relative(source, file).split(path.sep)[0];
    return !/^v\d+$/.test(root) || included.has(root);
  } });
}

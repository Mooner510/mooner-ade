import configuration from './versions.json' with { type: 'json' };
import { isPluginApiVersion } from './metadata.js';
import { createPluginRegistry } from './registry.js';

const contracts = await Promise.all(configuration.supported.map(async ({ version, status }) => {
  if (!isPluginApiVersion(version)) throw new Error('Invalid plugin API version');
  const { host, workspace } = await import(`./v${version}/index.js`);
  return { version, status, host, workspace };
}));

export const pluginApi = createPluginRegistry(contracts, configuration.removed);

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cursorEffortOption } from './chat-rpc.js';

const HOUR = 3_600_000;
// Last catalog and the options each model actually advertised. The screen paints this while cursor-agent is still starting.
export function createCursorModelCache({ file }) {
  let data = { entries: {} };
  let writing = Promise.resolve();
  const save = () => {
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(tmp, file);
    }).catch(() => {});
    return writing;
  };
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed?.entries && typeof parsed.entries === 'object') data = parsed;
      } catch { /* missing or torn: the next probe fills it */ }
    },
    key(configDir, signature) { return JSON.stringify([configDir || '', signature || '']); },
    get(key) { return data.entries[key] ?? null; },
    fresh(entry, now = Date.now()) { return Boolean(entry) && now - entry.at < HOUR; },
    note(key, { model, catalog, configOptions } = {}) {
      const prev = data.entries[key] ?? { byModel: {} };
      const byModel = { ...(prev.byModel ?? {}) };
      if (typeof model === 'string' && model && Array.isArray(configOptions) && configOptions.length) byModel[model] = { at: Date.now(), configOptions };
      const oldest = Object.entries(byModel).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0));
      while (oldest.length > 64) delete byModel[oldest.shift()[0]];
      data.entries[key] = {
        at: Date.now(),
        catalog: Array.isArray(catalog) && catalog.length ? catalog : prev.catalog ?? [],
        configOptions: Array.isArray(configOptions) && configOptions.length ? configOptions : prev.configOptions ?? [],
        model: model || prev.model || null,
        byModel,
      };
      const keys = Object.keys(data.entries);
      if (keys.length > 8) delete data.entries[keys[0]];
      void save();
      return data.entries[key];
    },
    flush: () => writing,
    bind(key) {
      return { get: () => data.entries[key] ?? null, note: patch => this.note(key, patch) };
    },
    payload(entry) {
      return { models: entry?.model ? { '': entry.model } : {}, catalog: entry?.catalog ?? [], configOptions: entry?.configOptions ?? [] };
    },
  };
}

// Options for `model` when that model was seen before. With no model yet, the last session's options. Catalog only when this model was never seen.
export function cursorSurface(entry, model) {
  if (!entry || typeof entry !== 'object') return null;
  const catalog = Array.isArray(entry.catalog) ? entry.catalog : [];
  const known = model ? entry.byModel?.[model]?.configOptions : entry.configOptions;
  const configOptions = Array.isArray(known) ? known : [];
  if (!catalog.length && !configOptions.length) return null;
  const effort = cursorEffortOption(configOptions);
  const modelOption = configOptions.find(option => option?.id === 'model' || option?.category === 'model');
  return {
    catalog,
    configOptions: model && modelOption ? configOptions.map(option => option === modelOption ? { ...option, currentValue: model } : option) : configOptions,
    efforts: effort?.options?.map(item => item.value).filter(value => typeof value === 'string') ?? [],
    effort: effort?.currentValue ?? null,
    effortConfigId: effort?.id,
    model: model || entry.model || null,
  };
}

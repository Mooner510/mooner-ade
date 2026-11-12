import { promises as fs } from 'node:fs';
import path from 'node:path';

// Auto Compact: Claude summarizes the conversation as context approaches a configured window (smaller than the model max).
// Settings layers match claude-cache.js: global configDir, then cwd/.claude/*. Managed settings are not read.
export function parseTokenAmount(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = String(value).trim().toLowerCase();
  if (!text || text === 'off' || text === 'false' || text === '0') return null;
  if (text === 'auto') return 'auto';
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1000 : 1;
  return Math.round(amount * unit);
}

export function modelSettingsFor(model, settings) {
  if (!model || !settings?.modelSettings || typeof settings.modelSettings !== 'object') return null;
  const map = settings.modelSettings;
  if (map[model]) return map[model];
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const hit = keys.find(key => model === key || model.startsWith(`${key}-`));
  return hit ? map[hit] : null;
}

// Returns null when auto compact is off or the effective window matches the max (gauge would duplicate the full window).
export function resolveAutoCompact({ settings = {}, env = {}, model, maxWindow = 200_000 }) {
  const get = key => env[key] ?? process.env[key];
  if (settings.autoCompactEnabled === false) return null;
  if (['1', 'true'].includes(String(get('DISABLE_AUTO_COMPACT')).toLowerCase())) return null;
  const max = Number.isFinite(maxWindow) && maxWindow > 0 ? maxWindow : 200_000;
  let raw = get('CLAUDE_CODE_AUTO_COMPACT_WINDOW') ?? settings.autoCompactWindow;
  const perModel = modelSettingsFor(model, settings);
  if (perModel?.autoCompactWindow != null) raw = perModel.autoCompactWindow;
  const parsed = parseTokenAmount(raw ?? 'auto');
  if (parsed === null) return null;
  const auto = parsed === 'auto';
  const window = auto
    ? (max >= 500_000 ? Math.min(max, 350_000) : Math.min(max, 200_000))
  : Math.min(max, parsed);
  if (window >= max) return null;
  let source = 'auto';
  if (perModel?.autoCompactWindow != null) source = 'modelSettings';
  else if (get('CLAUDE_CODE_AUTO_COMPACT_WINDOW')) source = 'env';
  else if (settings.autoCompactWindow != null) source = 'settings';
  return { window, maxWindow: max, auto, source };
}

export async function readClaudeSettingsLayers(configDir, cwd) {
  const settings = {}, env = {};
  for (const file of [path.join(configDir, 'settings.json'), ...cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []]) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      Object.assign(settings, parsed);
      Object.assign(env, parsed.env);
    } catch { /* missing or broken file */ }
  }
  return { settings, env };
}

export async function readAutoCompact(configDir, cwd, model, maxWindow) {
  const { settings, env } = await readClaudeSettingsLayers(configDir, cwd);
  return resolveAutoCompact({ settings, env, model, maxWindow });
}

// What the CLI's own /autocompact saves: modelSettings[<canonical model>].autoCompactWindow in the user settings file ("auto" or 100k–1M tokens).
// With no model known yet the top-level autoCompactWindow is used. Returns the value written.
export async function writeAutoCompact(configDir, model, value, maxWindow = 1_000_000) {
  const parsed = parseTokenAmount(value);
  if (parsed === null) throw new Error('auto 또는 토큰 수(예: 350k, 500000)를 입력하세요.');
  if (parsed !== 'auto' && (parsed < 100_000 || parsed > Math.max(maxWindow, 100_000))) throw new Error(`창 크기는 100k ~ ${Math.round(Math.max(maxWindow, 100_000) / 1000)}k 토큰 사이여야 합니다.`);
  const file = path.join(configDir, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('settings.json을 읽지 못해 바꾸지 않았습니다. 파일이 올바른 JSON인지 확인하세요.'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json 형식이 올바르지 않아 바꾸지 않았습니다.');
  const key = typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : '';
  if (key) settings.modelSettings = { ...settings.modelSettings, [key]: { ...settings.modelSettings?.[key], autoCompactWindow: parsed } };
  else settings.autoCompactWindow = parsed;
  await fs.mkdir(configDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`);
  await fs.rename(temp, file);
  return parsed;
}

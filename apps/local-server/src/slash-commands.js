import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FRONT_HEAD = 4000;
const stripQuotes = value => value?.replace(/^["']|["']$/g, '').trim();
const trimDesc = (value, max = 200) => {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function parseDescription(body) {
  const front = body.slice(0, FRONT_HEAD);
  const oneLine = stripQuotes(/^description:\s*(.+)$/m.exec(front)?.[1]);
  if (oneLine && oneLine !== '>' && oneLine !== '>-') return trimDesc(oneLine);
  if (/^description:\s*>-?\s*$/m.test(front)) {
    const lines = body.split('\n');
    const idx = lines.findIndex(line => /^description:\s*>/.test(line));
    const chunk = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '---' || /^[\w-]+:\s*/.test(line)) break;
      if (line.trim()) chunk.push(line.replace(/^\s+/, ''));
    }
    return trimDesc(chunk.join(' '));
  }
  return '';
}

/** YAML-ish frontmatter in command/skill markdown (Claude Code slash commands and skills). */
export function parseCommandFrontmatter(body) {
  const front = body.slice(0, FRONT_HEAD);
  const description = parseDescription(body);
  let hint = stripQuotes(/^argument-hint:\s*(.+)$/m.exec(front)?.[1]);
  if (!hint) {
    const args = stripQuotes(/^arguments:\s*(.+)$/m.exec(front)?.[1]);
    if (args) {
      const inline = args.match(/^\[([^\]]+)\]$/);
      if (inline) hint = inline[1].split(/,\s*/).map(part => `[${part.trim().replace(/^["']|["']$/g, '')}]`).join(' ');
      else hint = [...args.matchAll(/\[([^\]]+)\]/g)].map(match => `[${match[1]}]`).join(' ')
        || args.split(/[\s,]+/).filter(Boolean).map(part => `[${part.replace(/^["']|["']$/g, '')}]`).join(' ');
    }
  }
  const name = stripQuotes(/^name:\s*(.+)$/m.exec(front)?.[1]);
  return { description: trimDesc(description), hint: hint || undefined, declaredName: name };
}

function richer(next, prev) {
  if (!prev) return true;
  const score = item => (item.description ? 2 : 0) + (item.hint ? 1 : 0);
  return score(next) > score(prev);
}

function putMeta(map, slashName, meta) {
  if (typeof slashName !== 'string' || !/^[\w:.-]+$/.test(slashName)) return;
  const item = { name: slashName, description: meta.description ?? '', ...(meta.hint ? { hint: meta.hint } : {}) };
  const prev = map.get(slashName);
  if (!prev || richer(item, prev)) map.set(slashName, item);
}

async function readMeta(file) {
  try {
    return parseCommandFrontmatter(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

function parseTomlCommand(body) {
  const description = stripQuotes(/^description\s*=\s*(.+)$/m.exec(body.slice(0, FRONT_HEAD))?.[1]);
  const hint = stripQuotes(/^argument-hint\s*=\s*(.+)$/m.exec(body.slice(0, FRONT_HEAD))?.[1]);
  return { description: trimDesc(description), hint: hint || (/\{\{\s*args\s*\}\}/.test(body) ? '[args]' : undefined), declaredName: undefined };
}

async function walkCommands(dir, prefix, map) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await walkCommands(path.join(dir, entry.name), `${prefix}${entry.name}:`, map);
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.toml')) {
      const slash = prefix + entry.name.replace(/\.md$|\.toml$/, '');
      const file = path.join(dir, entry.name);
      const meta = entry.name.endsWith('.md') ? await readMeta(file) : parseTomlCommand(await fs.readFile(file, 'utf8').catch(() => ''));
      if (!meta) continue;
      putMeta(map, slash, meta);
      if (meta.declaredName) putMeta(map, meta.declaredName, meta);
    }
  }
}

async function walkSkills(skillsDir, map, { prefix = '', depth = 0, skipDot = false } = {}) {
  for (const entry of await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || (skipDot && entry.name.startsWith('.'))) continue;
    const dir = path.join(skillsDir, entry.name);
    const meta = await readMeta(path.join(dir, 'SKILL.md'));
    if (meta) {
      const base = meta.declaredName || entry.name;
      putMeta(map, base, meta);
      if (prefix) putMeta(map, `${prefix}:${base}`, meta);
    } else if (depth < 2) await walkSkills(dir, map, { prefix, depth: depth + 1, skipDot });
  }
}

async function pluginIdFromDir(pluginRoot) {
  for (const rel of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(pluginRoot, rel), 'utf8'));
      if (typeof json.name === 'string' && json.name) return json.name;
    } catch { /* this plugin layout is absent */ }
  }
  return path.basename(pluginRoot);
}

async function scanClaudeTree(base, map, { skillPrefix = '' } = {}) {
  await walkCommands(path.join(base, 'commands'), '', map);
  await walkSkills(path.join(base, 'skills'), map, { prefix: skillPrefix });
}

async function scanPluginRoots(configHome, map) {
  const installed = path.join(configHome, 'plugins', 'installed_plugins.json');
  try {
    const json = JSON.parse(await fs.readFile(installed, 'utf8'));
    for (const [key, entries] of Object.entries(json.plugins ?? {})) {
      const pluginKey = key.split('@')[0];
      for (const entry of entries) {
        if (!entry.installPath) continue;
        const id = await pluginIdFromDir(entry.installPath).catch(() => pluginKey) || pluginKey;
        await scanClaudeTree(entry.installPath, map, { skillPrefix: id });
      }
    }
  } catch {}
  const marketplaces = path.join(configHome, 'plugins', 'marketplaces');
  for (const marketplace of await fs.readdir(marketplaces, { withFileTypes: true }).catch(() => [])) {
    if (!marketplace.isDirectory()) continue;
    const plugins = path.join(marketplaces, marketplace.name, 'plugins');
    for (const plugin of await fs.readdir(plugins, { withFileTypes: true }).catch(() => [])) {
      if (!plugin.isDirectory()) continue;
      const root = path.join(plugins, plugin.name);
      const id = await pluginIdFromDir(root);
      await scanClaudeTree(root, map, { skillPrefix: id });
    }
  }
  const cache = path.join(configHome, 'plugins', 'cache');
  for (const org of await fs.readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!org.isDirectory()) continue;
    for (const plugin of await fs.readdir(path.join(cache, org.name), { withFileTypes: true }).catch(() => [])) {
      if (!plugin.isDirectory()) continue;
      for (const version of await fs.readdir(path.join(cache, org.name, plugin.name), { withFileTypes: true }).catch(() => [])) {
        if (!version.isDirectory()) continue;
        const root = path.join(cache, org.name, plugin.name, version.name);
        await scanClaudeTree(root, map, { skillPrefix: plugin.name });
      }
    }
  }
}

async function scanSyncedSkills(configHome, map) {
  const synced = path.join(configHome, 'skills', 'synced');
  for (const bundle of await fs.readdir(synced, { withFileTypes: true }).catch(() => [])) {
    if (!bundle.isDirectory()) continue;
    const root = path.join(synced, bundle.name);
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')); } catch { manifest = null; }
    for (const skill of manifest?.skills ?? []) {
      const id = skill.skillId || skill.name;
      if (!id) continue;
      const fromManifest = { description: trimDesc(skill.description ?? ''), hint: undefined };
      putMeta(map, id, fromManifest);
      const file = path.join(root, id, 'SKILL.md');
      const meta = await readMeta(file);
      if (meta) {
        putMeta(map, id, { description: meta.description || fromManifest.description, hint: meta.hint });
        putMeta(map, `anthropic-skills:${id}`, { description: meta.description || fromManifest.description, hint: meta.hint });
      } else putMeta(map, `anthropic-skills:${id}`, fromManifest);
    }
    await walkSkills(root, map, { prefix: 'anthropic-skills' });
  }
  const userSkills = path.join(configHome, 'skills');
  for (const entry of await fs.readdir(userSkills, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name === 'synced' || entry.name.startsWith('.')) continue;
    const meta = await readMeta(path.join(userSkills, entry.name, 'SKILL.md'));
    if (meta) putMeta(map, entry.name, meta);
  }
}

async function scanRoots(map, roots, { skipDot = false } = {}) {
  for (const root of roots) {
    await walkCommands(path.join(root, 'commands'), '', map);
    await walkSkills(path.join(root, 'skills'), map, { skipDot });
  }
}

/** Metadata from command/skill files the given provider actually loads. */
export async function collectCommandMetadata(cwd, home = os.homedir(), env = {}, agent = 'claude') {
  const map = new Map();
  if (agent === 'codex') {
    const configHome = env.CODEX_HOME || path.join(home, '.codex');
    await scanRoots(map, [configHome, path.join(cwd, '.codex'), path.join(cwd, '.agents'), path.join(home, '.agents')]);
    await scanPluginRoots(configHome, map);
    return map;
  }
  if (agent === 'cursor') {
    // cursor-agent reads project and user command dirs, skill roots, and its own plugin cache.
    await scanRoots(map, [path.join(cwd, '.cursor'), path.join(cwd, '.claude'), path.join(home, '.cursor'), path.join(home, '.claude'), path.join(cwd, '.agents'), path.join(home, '.agents')]);
    await walkSkills(path.join(home, '.cursor', 'skills-cursor'), map);
    await walkSkills(path.join(cwd, '.codex', 'skills'), map, { skipDot: true });
    await walkSkills(path.join(home, '.codex', 'skills'), map, { skipDot: true });
    await scanPluginRoots(path.join(home, '.cursor'), map);
    return map;
  }
  const configHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  await scanClaudeTree(path.join(cwd, '.claude'), map);
  await scanClaudeTree(configHome, map);
  await scanPluginRoots(configHome, map);
  await scanSyncedSkills(configHome, map);
  return map;
}

export function lookupCommandMeta(map, commandName) {
  if (map.has(commandName)) return map.get(commandName);
  const suffix = commandName.includes(':') ? commandName.slice(commandName.lastIndexOf(':') + 1) : commandName;
  if (map.has(suffix)) return { ...map.get(suffix), name: commandName };
  return null;
}

export function mergeCommandCatalog(names, metadata) {
  const out = new Map();
  const list = [...new Set(names.filter(name => typeof name === 'string' && name.length > 0))];
  for (const name of list) {
    const meta = lookupCommandMeta(metadata, name) ?? { name, description: '' };
    out.set(name, { name, description: meta.description ?? '', ...(meta.hint ? { hint: meta.hint } : {}) });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const CURSOR_BUILTIN_COMMANDS = [
  { name: 'summarize', description: 'Cursor CLI로 대화 컨텍스트를 압축합니다' },
  { name: 'compact', description: '/summarize와 같습니다' },
];

export function mergeCursorCommands(commands = []) {
  const map = new Map();
  for (const item of commands) if (item && typeof item.name === 'string') map.set(item.name, item);
  for (const item of CURSOR_BUILTIN_COMMANDS) if (!map.has(item.name)) map.set(item.name, item);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const builtinCommandNames = agent => (agent === 'cursor' ? CURSOR_BUILTIN_COMMANDS : agent === 'codex' ? [{ name: 'compact', description: '대화 컨텍스트를 압축합니다', hint: '[지침]' }] : []).map(item => item.name);

// The CLI's init event is the authoritative slash-command list for cwd + login + enabled plugins, and names the model it resolved for that folder.
// A local slash command (`/cost`) makes `claude -p` print the init event and finish with no model call; the child is stopped at init. This is the only
// kind of helper child the server starts: one answer serves both the command menu and the default model (see claudeInit in index.js).
// Resolves { model, slashCommands } or null when the CLI did not answer.
export async function probeInit({ env = {}, spawnProcess = spawn, executable = 'claude', cwd = os.tmpdir(), timeoutMs = 25_000 } = {}) {
  return new Promise(resolve => {
    let proc, buffer = '', done = false;
    const finish = init => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc?.kill(); } catch {}
      resolve(init ?? null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      proc = spawnProcess(executable, ['-p', '/cost', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
        { cwd, env: { ...process.env, ...(typeof env === 'function' ? env() : env), NO_COLOR: '1' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(null); }
    proc.once('error', () => finish(null));
    proc.once('close', () => finish(null));
    proc.stdout.on('data', chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init' && Array.isArray(event.slash_commands)) return finish({ model: typeof event.model === 'string' ? event.model : null, slashCommands: event.slash_commands });
        } catch {}
      }
    });
  });
}
export const probeSlashCommands = async options => (await probeInit(options))?.slashCommands ?? [];

export async function listCommands(cwd, home = os.homedir(), { env = {}, probe = true, names, spawnProcess = spawn, agent = 'claude' } = {}) {
  const metadata = await collectCommandMetadata(cwd, home, env, agent);
  if (agent === 'codex') putMeta(metadata, 'compact', { description: '대화 컨텍스트를 압축합니다', hint: '[지침]' });
  if (agent === 'cursor') for (const item of CURSOR_BUILTIN_COMMANDS) putMeta(metadata, item.name, item);
  const probed = agent === 'claude' && probe ? await probeSlashCommands({ env, cwd, spawnProcess }) : [];
  const extra = Array.isArray(names) ? names : [];
  let catalogNames = [...new Set([...probed, ...extra])];
  if (!catalogNames.length) catalogNames = [...metadata.keys()];
  catalogNames = [...new Set([...catalogNames, ...builtinCommandNames(agent)])];
  return mergeCommandCatalog(catalogNames, metadata);
}

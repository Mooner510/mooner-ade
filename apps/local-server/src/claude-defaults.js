import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EFFORTS, PERMISSION_MODES, uiPermissionMode } from './chat-claude.js';

// What a plain `claude` would start with: the user's settings.json, then the project's .claude/settings.json and settings.local.json (later wins).
// A new chat passes no --model/--effort/--permission-mode, so the CLI applies these itself; this read only lets the status line show the same values
// before the first init event. Nothing is stored by this app. Managed (enterprise) settings are not read, as in claude-auto-compact.js.
export async function readClaudeDefaults(configDir, cwd, env = process.env) {
  const found = {};
  for (const file of [path.join(configDir, 'settings.json'), ...cwd ? [path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')] : []]) {
    let parsed;
    try { parsed = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; /* missing or broken file */ }
    if (typeof parsed?.model === 'string' && parsed.model) found.model = parsed.model;
    if (typeof parsed?.effortLevel === 'string') found.effort = parsed.effortLevel;
    if (typeof parsed?.permissions?.defaultMode === 'string') found.permissionMode = parsed.permissions.defaultMode;
    if (typeof parsed?.env?.CLAUDE_CODE_EFFORT_LEVEL === 'string') found.effort = parsed.env.CLAUDE_CODE_EFFORT_LEVEL;
  }
  if (env.CLAUDE_CODE_EFFORT_LEVEL) found.effort = env.CLAUDE_CODE_EFFORT_LEVEL;
  const mode = found.permissionMode ? uiPermissionMode(found.permissionMode) : null;
  return {
    model: found.model ?? null,
    effort: EFFORTS.includes(found.effort) ? found.effort : null,
    permissionMode: PERMISSION_MODES.includes(mode) ? mode : null,
  };
}

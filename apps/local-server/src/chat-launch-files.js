import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTRIBUTION_OFF } from './agent-signature.js';
import { chatPrompt } from './chat-prompt.js';
import { writeIfChanged, writeShared } from './file-util.js';
import { chatMcpServers, deniedMcpTools } from './terminal-sessions.js';

// The same plugin MCP servers the terminals give `claude`, passed as a --mcp-config file next to the chat's transcript, and
// the plugin tools the user turned off as deny rules in a --settings file.
// A built-in plugin's server (the agent bus) also gets the chat it serves (ADE_CHAT_*) and its tools are allowed without a prompt.
// Every (re)start of a chat's child calls this, so nothing is written that is already there: the prompt and the settings do not depend on the chat
// and live once, content-named, in a folder shared by all chats; only the MCP file (it carries the chat's ADE_CHAT_* ids) stays per chat, and is
// rewritten only when its content changed (the agent bus port/token change with each app start).
export function chatLaunchFiles(dataRoot) {
  const shared = path.join(dataRoot, 'launch');
  return async function prepare(root, context) {
    const servers = chatMcpServers(context);
    // Copies older versions left in the chat's own folder are no longer read.
    await Promise.all(['ade-ui-prompt.md', 'claude-settings.json'].map(name => fs.rm(path.join(root, name), { force: true }).catch(() => {})));
    // The chat instructions travel as a file so the argv stays short and a resumed session gets the same text.
    const prompt = chatPrompt(context.interactiveUi, context.fileLinks, context.agent, context.mediaBlocks);
    const promptFile = prompt ? await writeShared(shared, 'ade-ui-prompt', '.md', prompt) : undefined;
    // The settings file always exists: it also tells Claude not to sign the user's commits and PRs (see agent-signature.js).
    const denied = deniedMcpTools(servers), allowed = servers.filter(server => server.autoApprove).map(server => `mcp__${server.name}`);
    const permissions = { ...(allowed.length && { allow: allowed }), ...(denied.length && { deny: denied }) };
    const settingsFile = await writeShared(shared, 'claude-settings', '.json', JSON.stringify({ ...ATTRIBUTION_OFF, ...(Object.keys(permissions).length && { permissions }) }));
    if (!servers.length) return { settingsFile, promptFile };
    const mcpFile = path.join(root, 'claude-mcp.json');
    await writeIfChanged(mcpFile, JSON.stringify({ mcpServers: Object.fromEntries(servers.map(server => [server.name, { type: 'stdio', command: server.command, args: server.args, ...(server.env && { env: server.env }) }])) }));
    return { mcpFile, settingsFile, promptFile };
  };
}

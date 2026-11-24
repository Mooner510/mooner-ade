// MCP tools the user trusts for good, per provider (settings.mcpTrust, managed in the provider's settings): `{ server }` trusts every tool of that MCP server,
// `{ server, tool }` one tool. A trusted tool is allowed on the spot, once per request (the agent's own "always" is never used), so removing the entry takes effect at once.
// Claude names an MCP tool `mcp__<server>__<tool>`.
export const claudeMcp = tool => { const match = /^mcp__(.+?)__(.+)$/.exec(typeof tool === 'string' ? tool : ''); return match ? { server: match[1], tool: match[2] } : null; };
// Cursor titles it `<server>: <tool>` with no kind (or "other"); shell, file and fetch requests (kind execute, edit, fetch...) never match.
export const cursorMcp = toolCall => {
  if (![undefined, 'other'].includes(toolCall?.kind)) return null;
  const match = /^([\w.-]+): (\S.*)$/.exec(typeof toolCall?.title === 'string' ? toolCall.title : '');
  return match ? { server: match[1], tool: match[2] } : null;
};
export const isTrusted = (list, mcp) => !!mcp && (list ?? []).some(entry => entry.server === mcp.server && (entry.tool === undefined || entry.tool === mcp.tool));
// The settings value, checked: three providers, each a short list of `{ server, tool? }`.
export function validMcpTrust(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const text = item => typeof item === 'string' && item.length > 0 && item.length <= 200 && !/[\x00-\x1f\x7f]/.test(item);
  return Object.entries(value).every(([provider, list]) => ['claude', 'codex', 'cursor'].includes(provider) && Array.isArray(list) && list.length <= 200
    && list.every(entry => entry && typeof entry === 'object' && text(entry.server) && (entry.tool === undefined || text(entry.tool)) && Object.keys(entry).every(key => key === 'server' || key === 'tool')));
}

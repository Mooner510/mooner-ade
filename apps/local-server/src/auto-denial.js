// Claude Code's auto mode: a classifier decides each tool call, and one it refuses comes back to the host only as an error tool_result whose text names the
// classifier (nothing else on the stream says so). The CLI's own /permissions "Recently blocked" tab lets the user allow such an action for the session and
// retry it; this is the host side of that: recognise the refusal, and build the session-only allow rule and the retry message from what the CLI really ran.

export const AUTO_DENIAL = /denied by the Claude Code auto mode classifier/i;
// "…classifier. Reason: [Create Unsafe Agents]. If you have other tasks…" (the bracket holds the matched rule's label; absent for some refusals).
export const autoDenialReason = (text) => (typeof text === "string" && AUTO_DENIAL.test(text) ? (/Reason:\s*\[([^\]]+)\]/.exec(text)?.[1] ?? "") : null);

// A rule that matches exactly this one call, or null when no safe exact rule exists (then only "allow and retry" by message is offered).
// Bash/PowerShell: the whole command, but only a plain one: the CLI matches a compound command (`a && b`, pipes, substitutions) piece by piece, so one rule for the
// whole string would never match; `*` is a wildcard and `(` `)` `\` are rule syntax. MCP: that one tool. WebFetch: that one host.
const PLAIN_COMMAND = /^[^\r\n*()\\;&|<>`$#{}]+$/;
export function sessionRule(tool, input) {
  if (tool === "Bash" || tool === "PowerShell") {
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    return command && command.length <= 400 && PLAIN_COMMAND.test(command) ? `${tool}(${command})` : null;
  }
  if (typeof tool === "string" && /^mcp__[^_].*__.+/.test(tool)) return tool;
  if (tool === "WebFetch" && typeof input?.url === "string") {
    try { const host = new URL(input.url).hostname; return host && /^[a-z0-9.-]+$/i.test(host) ? `WebFetch(domain:${host})` : null; } catch { return null; }
  }
  return null;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const describe = (tool, input) => {
  const text = tool === "Bash" || tool === "PowerShell" ? String(input?.command ?? "") : JSON.stringify(input ?? {});
  return `${tool}: \`${clip(text.replace(/`/g, "'"), 600)}\``;
};
// What goes to the model once the user approved. It is the user's own decision (the button they pressed), worded as a request, so the classifier reads it as
// the explicit direction auto mode honours.
export const retryText = (items) =>
  `자동 모드가 막았던 ${items.length > 1 ? `${items.length}개 작업을` : "작업을"} 제가 직접 승인합니다. 이 채팅에서는 허용하니 다시 실행해 주세요.\n${items.map((item) => `- ${describe(item.tool, item.input)}`).join("\n")}`;

// Blocked actions the user has not dealt with yet: those refused since their last message (or /clear), minus the ones they allowed since.
export function pendingBlocked(events) {
  const found = new Map();
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at];
    if (event.kind === "user" || event.kind === "divider") break;
    if (event.kind === "denial_allow") { if (event.retry !== false) for (const id of event.toolUseIds ?? []) found.set(id, null); } // allowed without a retry: still open for one
    else if (event.kind === "auto_denied" && !found.has(event.toolUseId)) found.set(event.toolUseId, event);
  }
  return [...found.values()].filter(Boolean).reverse();
}

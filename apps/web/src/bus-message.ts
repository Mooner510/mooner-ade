// A message another agent sent through the agent bus (the built-in plugin) arrives in a chat as a user message with a fixed header
// (see formatMessage in apps/desktop/builtin-plugins/agent-bus/bus.mjs). The chat draws it as a card from the other agent instead of the raw header.
export type BusMessage = { agent: string; title: string; id: string; hop: number; maxHops: number; text: string };

const HEAD = /^\[ADE agent bus\] Message from (?:"([^"\n]*)" \((\w+)\)|(\w+) chat), chat id ([^\s,]+?)(?:, reply depth (\d+)\/(\d+))?\.\n/;
// Messages that waited for a busy chat are delivered together, one turn, separated by a line of `=====`.
export function parseBusMessages(text: string): BusMessage[] | null {
  if (!text.startsWith('[ADE agent bus] ')) return null;
  const messages: BusMessage[] = [];
  for (const part of text.split('\n\n=====\n\n')) {
    const head = HEAD.exec(part);
    if (!head) return null;
    const body = part.indexOf('\n---\n', head[0].length);
    if (body < 0) return null;
    messages.push({ title: head[1] ?? '', agent: head[2] ?? head[3], id: head[4], hop: Number(head[5] ?? 0), maxHops: Number(head[6] ?? 0), text: part.slice(body + 5) });
  }
  return messages;
}
export const busAgentName = (agent: string) => agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent === 'cursor' ? 'Cursor' : agent;

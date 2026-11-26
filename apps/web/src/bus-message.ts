// A message another agent sent through the agent bus (the built-in plugin) arrives in a chat as a user message with a fixed header
// (see formatMessage in apps/desktop/builtin-plugins/agent-bus/bus.mjs). The chat draws it as a card from the other agent instead of the raw header.
export type BusMessage = { agent: string; title: string; id: string; text: string };

const HEAD = /^\[ADE agent bus\] Message from (?:"([^"\n]*)" \((\w+)\)|(\w+) chat), chat id ([^\s,]+?)(?: \(session [^\s)]+\))?(?:, reply depth \d+\/\d+)?\.\n/;
// Older chats may still carry a `reply depth n/m` header; it is read and ignored.
// Messages that waited for a busy chat are delivered together, one turn, separated by a line of `=====`.
export function parseBusMessages(text: string): BusMessage[] | null {
  if (!text.startsWith('[ADE agent bus] ')) return null;
  const messages: BusMessage[] = [];
  for (const part of text.split('\n\n=====\n\n')) {
    const head = HEAD.exec(part);
    if (!head) return null;
    const body = part.indexOf('\n---\n', head[0].length);
    if (body < 0) return null;
    messages.push({ title: head[1] ?? '', agent: head[2] ?? head[3], id: head[4], text: part.slice(body + 5) });
  }
  return messages;
}
export const busAgentName = (agent: string) => agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent === 'cursor' ? 'Cursor' : agent;
// What the sticky "요청한 내용으로 이동" bar shows for a message from another agent: who sent it and the start of what it says, not the raw `[ADE agent bus]` header the CLI received.
export const busPreview = (messages: BusMessage[]) => {
  const first = messages[0], who = `${busAgentName(first.agent)}${first.title ? ` “${first.title}”` : ''}`;
  return `${who}${messages.length > 1 ? ` 외 ${messages.length - 1}건` : ''}: ${first.text.replace(/\s+/g, ' ').trim()}`;
};

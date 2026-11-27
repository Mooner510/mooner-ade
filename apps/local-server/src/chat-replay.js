// What a phone gets of a chat's stored events on open: the same events, but without what it cannot show or never reads. Image previews (data URLs of up to
// 150,000 characters, which gzip hardly shrinks) stay on the last few messages; older ones show as a count (UserImages). A tool's output is cut at the
// length the chat shows its text up to (the page clips at 6,000 characters), with some room. The PC's stored events are not touched.
export const KEEP_PREVIEWS = 3, MAX_RESULT = 12_000;
export function slimEvents(events) {
  let keep = KEEP_PREVIEWS;
  const keepers = new Set();
  for (let index = events.length - 1; index >= 0 && keep > 0; index--) {
    const event = events[index];
    if (event.previews?.length && (event.kind === 'user' || event.kind === 'steer')) { keepers.add(index); keep--; }
  }
  return events.map((event, index) => {
    if (event.previews?.length && !keepers.has(index) && (event.kind === 'user' || event.kind === 'steer')) {
      const { previews: _dropped, ...rest } = event; return rest;
    }
    if (event.kind === 'tool_result' && typeof event.content === 'string' && event.content.length > MAX_RESULT) {
      return { ...event, content: `${event.content.slice(0, MAX_RESULT)}\n… (${event.content.length - MAX_RESULT}자 생략)` };
    }
    return event;
  });
}

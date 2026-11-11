const PASTE = /<\/?.?pasted_content(?:\s[^>]*)?>/gi;
export const cleanChatTitle = text => (typeof text === 'string' ? text.replace(PASTE, ' ').replace(/\s+/g, ' ').trim() : '');

/** `@param` events — user events since the last divider; `@param` titles — newest custom / ai / agent labels in that segment. */
export const resolveChatTitle = (titles, events = []) => {
  for (const source of ['custom', 'ai', 'agent']) {
    const value = cleanChatTitle(titles[source]);
    if (value) return value.slice(0, 80);
  }
  for (const event of events) {
    if (event.kind !== 'user') continue;
    const text = cleanChatTitle(event.text);
    if (text && !text.startsWith('/')) return text.slice(0, 80);
    if (text.startsWith('/')) continue;
  }
  const first = events.find(event => event.kind === 'user' && cleanChatTitle(event.text));
  return first ? cleanChatTitle(first.text).slice(0, 80) : '';
};

export const segmentUserEvents = (events, since = -1) =>
  events.slice(since + 1).filter(event => event.kind === 'user');

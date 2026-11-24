export const MEDIA_LANG = 'ade-media';

export type ChatMediaSpec = { type: 'image' | 'video'; src: string; alt?: string; remote: boolean };

export function parseChatMedia(code: string): ChatMediaSpec | null {
  let value;
  try { value = JSON.parse(code); } catch { return null; }
  if (!value || (value.type !== 'image' && value.type !== 'video') || typeof value.src !== 'string') return null;
  const src = value.src.trim();
  if (!src || src.length > 8192 || /[\u0000-\u001f\u007f]/.test(src)) return null;
  const alt = typeof value.alt === 'string' ? value.alt.trim().slice(0, 300) : undefined;
  if (/^https:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      if (url.username || url.password) return null;
      return { type: value.type, src: url.href, alt, remote: true };
    } catch { return null; }
  }
  if (/^[\\/]{2}|[\\/]$/.test(src) || (/^[\w+.-]+:/.test(src) && !/^[a-z]:[\\/]/i.test(src))) return null;
  return { type: value.type, src, alt, remote: false };
}

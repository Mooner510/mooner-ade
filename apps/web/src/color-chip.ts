const UNITY_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?f?$/i;
const CONTEXTUAL_CSS = /^(?:inherit|initial|unset|revert(?:-layer)?)$|\bcurrentcolor\b|\b(?:var|env|attr)\(/i;

export const COLOR_COPY_EVENT = 'ade:color-copy';
export type ColorCopyTarget = { label: string; color?: string };

export function swatchColor(label: string): string | undefined {
  const value = label.trim();
  // Use the renderer's CSS grammar, including its modern color spaces.
  if (!CONTEXTUAL_CSS.test(value) && globalThis.CSS?.supports('background-color', value)) return value;

  const argb = /^(?:0x([\da-f]{8})|Color\(\s*0x([\da-f]{8})\s*\))$/i.exec(value);
  if (argb) {
    const hex = argb[1] ?? argb[2];
    return '#' + hex.slice(2) + hex.slice(0, 2);
  }

  const unity = /^(?:new\s+)?Color(32)?\(([^()]*)\)$/.exec(value);
  if (!unity) return;
  const bytes = !!unity[1], values = unity[2].split(',').map(part => part.trim());
  if (values.length !== 4 && (bytes || values.length !== 3)) return;
  const number = bytes ? /^\d+$/ : UNITY_NUMBER;
  if (!values.every(part => number.test(part))) return;
  const channels = values.map(part => Number(part.replace(/f$/i, '')));
  const max = bytes ? 255 : 1;
  if (!channels.every(channel => channel >= 0 && channel <= max)) return;
  const [r, g, b, alpha = max] = channels;
  const scale = bytes ? 1 : 255;
  return 'rgb(' + [r * scale, g * scale, b * scale].join(' ') + ' / ' + alpha / max + ')';
}

export function colorCopyFormats(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Read sRGB channels before compositing so even a fully transparent color keeps its RGB.
  ctx.fillStyle = 'color(from ' + color + ' srgb r g b / alpha)';
  const srgb = /^color\(srgb (.+)\)$/.exec(ctx.fillStyle)?.[1];
  let rgba: Uint8ClampedArray;
  if (srgb) {
    const [r, g, b, alpha = '1'] = srgb.replace(' / ', ' ').split(' ');
    rgba = Uint8ClampedArray.from([r, g, b, alpha], channel => Math.round(Number(channel) * 255));
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    rgba = ctx.getImageData(0, 0, 1, 1).data;
  }
  const [r, g, b, alpha] = rgba;
  const hex = '#' + Array.from(alpha === 255 ? rgba.subarray(0, 3) : rgba, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  const opacity = alpha === 255 ? '' : ' / ' + Number((alpha / 255).toFixed(3));
  return { hex, rgb: 'rgb(' + [r, g, b].join(' ') + opacity + ')' };
}

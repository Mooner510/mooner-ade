// Chat images are sent inline, so anything over the Claude API's 5MB per-image cap is reduced here before it is attached.
// JPEG and WebP drop quality first (same pixels). PNG has no quality knob, so it scales down just enough. A GIF over the cap
// becomes one JPEG of its first frame: a canvas cannot keep the animation.

export const MAX_CHAT_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

export const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
export const imageWithinLimit = (byteLength: number, base64Length: number) => byteLength <= MAX_IMAGE_BYTES && base64Length <= MAX_IMAGE_BASE64;

export type FitSpec = { width: number; height: number; mime: string; quality: number };
export type FitEncoded = { mime: string; bytes: Uint8Array };

export const fitOutputMime = (mime: string) => mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';

// `encode` draws one attempt. Return null when that size cannot be drawn; the next attempt is smaller.
export async function fitImageBytes(
  input: { mime: string; byteLength: number; width: number; height: number },
  encode: (spec: FitSpec) => Promise<FitEncoded | null>,
  limit = MAX_IMAGE_BYTES,
): Promise<{ mime: string; bytes: Uint8Array }> {
  const mime = fitOutputMime(input.mime), lossy = mime !== 'image/png';
  // Quality first while the bitmap is drawable. A long edge past this is scaled before the first encode, so a phone photo does not allocate the full bitmap.
  const MAX_DRAW_EDGE = 4096;
  let scale = !lossy && input.byteLength > limit ? Math.min(1, Math.sqrt((limit * 0.92) / input.byteLength)) : 1;
  const longEdge = Math.max(input.width, input.height, 1);
  if (longEdge > MAX_DRAW_EDGE) scale = Math.min(scale, MAX_DRAW_EDGE / longEdge);
  let quality = lossy ? 0.92 : 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = Math.max(1, Math.round(input.width * scale)), height = Math.max(1, Math.round(input.height * scale));
    const encoded = await encode({ width, height, mime, quality });
    if (encoded && encoded.bytes.length > 0 && encoded.bytes.length <= limit) return { mime: encoded.mime || mime, bytes: encoded.bytes };
    if (!encoded) { scale *= 0.7; continue; }
    if (lossy && quality > 0.8 && scale >= 0.999) { quality = Math.round((quality - 0.06) * 100) / 100; continue; }
    const ratio = Math.sqrt(limit / encoded.bytes.length) * 0.96;
    scale *= Math.min(0.9, Math.max(0.45, ratio));
    if (lossy) quality = 0.86;
  }
  throw new Error('이미지를 5MB 아래로 줄이지 못했습니다. 더 작은 이미지나 화면 일부만 캡쳐해 다시 시도하세요.');
}

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error('이미지를 읽지 못했습니다.'));
  reader.readAsDataURL(file);
});

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('이미지를 열지 못했습니다. 손상되었거나 지원하지 않는 형식일 수 있어요. PNG, JPEG, WebP, GIF 파일로 다시 시도하세요.'));
  image.src = url;
});

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const encodeCanvas = async (image: CanvasImageSource, spec: FitSpec): Promise<FitEncoded | null> => {
  const canvas = document.createElement('canvas');
  canvas.width = spec.width; canvas.height = spec.height;
  const draw = canvas.getContext('2d');
  if (!draw) return null;
  if (spec.mime === 'image/jpeg') { draw.fillStyle = '#fff'; draw.fillRect(0, 0, spec.width, spec.height); }
  draw.imageSmoothingEnabled = true; draw.imageSmoothingQuality = 'high';
  draw.drawImage(image, 0, 0, spec.width, spec.height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(result => resolve(result), spec.mime, spec.quality));
  const encoded = blob ?? (spec.mime === 'image/webp'
    ? await new Promise<Blob | null>(resolve => canvas.toBlob(result => resolve(result), 'image/jpeg', spec.quality))
    : null);
  if (!encoded) return null;
  return { mime: encoded.type || spec.mime, bytes: new Uint8Array(await encoded.arrayBuffer()) };
};

export async function prepareChatImage(file: File): Promise<{ mime: string; data: string; url: string; reduced: boolean }> {
  const url = await readAsDataUrl(file), data = url.slice(url.indexOf(',') + 1);
  const byteLength = Math.max(file.size, base64Bytes(data));
  if (imageWithinLimit(byteLength, data.length)) return { mime: file.type, data, url, reduced: false };
  const image = await loadImage(url);
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('이미지를 열지 못했습니다. 손상되었거나 지원하지 않는 형식일 수 있어요. PNG, JPEG, WebP, GIF 파일로 다시 시도하세요.');
  const fitted = await fitImageBytes({ mime: file.type, byteLength, width: image.naturalWidth, height: image.naturalHeight }, spec => encodeCanvas(image, spec));
  const out = bytesToBase64(fitted.bytes);
  return { mime: fitted.mime, data: out, url: `data:${fitted.mime};base64,${out}`, reduced: true };
}

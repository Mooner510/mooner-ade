// Chat images travel inline, as base64 inside one JSON message. 5MB is the Claude API's per-image cap.
// The web client (apps/web/src/image-fit.ts) shrinks anything larger down to this before send. Keep the two copies equal.
export const MAX_CHAT_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
// One chat/send: four images, their JPEG previews, and the message text. The HTTP body cap has to fit all of that.
export const MAX_PREVIEW_CHARS = 150_000;
export const MAX_CHAT_TEXT = 200_000;
export const MAX_CHAT_SEND_BODY = MAX_CHAT_IMAGES * (MAX_IMAGE_BASE64 + MAX_PREVIEW_CHARS) + MAX_CHAT_TEXT + 256 * 1024;

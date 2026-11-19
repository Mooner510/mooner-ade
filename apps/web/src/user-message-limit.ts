export const USER_MESSAGE_CLIP_HEIGHT_PX = 525;

export function userMessageExceedsClipHeight(naturalHeight: number) {
  return naturalHeight >= USER_MESSAGE_CLIP_HEIGHT_PX;
}
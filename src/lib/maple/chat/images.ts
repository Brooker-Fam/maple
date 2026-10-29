export const CHAT_MAX_IMAGES = 8;
export const CHAT_IMAGE_MAX_BYTES = 512 * 1024;
export const CHAT_IMAGE_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const CHAT_IMAGE_MAX_DIMENSION = 1600;
export const CHAT_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";
export const CHAT_IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_URL_RE = /^\/api\/maple\/chat\/images\?id=([0-9a-f-]+)$/;

export type ChatImage = { type: "file"; mediaType: "image/jpeg"; url: string };

export function parseChatImage(raw: unknown): ChatImage | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["type", "mediaType", "url"].includes(key))) return null;
  if (value.type !== "file" || value.mediaType !== "image/jpeg" || typeof value.url !== "string") return null;
  const match = IMAGE_URL_RE.exec(value.url);
  if (!match || !CHAT_IMAGE_ID_RE.test(match[1])) return null;
  return { type: "file", mediaType: "image/jpeg", url: value.url };
}

export function isChatImage(raw: unknown): raw is ChatImage {
  return parseChatImage(raw) !== null;
}

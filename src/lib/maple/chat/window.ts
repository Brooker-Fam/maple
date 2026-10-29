import type { ChatMessage } from "./types";

/**
 * Each person has one chat that never ends, so the model reads only its
 * recent end: whole exchanges (a user message and the replies after it), newest
 * first, while they fit both limits. The newest exchange always goes, however
 * long. The window plus the cached prefix (instructions and tools) has to
 * leave room for a turn's tool results under STEP_PROMPT_LIMIT (caps.ts); a
 * check holds it to that. No server imports: the checks run this.
 */

export const WINDOW_MESSAGES = 24;
export const WINDOW_TOKENS = 12_000;
/** Messages read from the database for a turn: enough to fill the window, and an unanswered request is always the newest. */
export const HISTORY_LOAD = 60;
/** Messages per page of the chat's history on the phone. */
export const STREAM_PAGE = 40;
export const IMAGE_INPUT_TOKENS = 8192;

export function inputTokens(value: unknown): number {
  let images = 0;
  const serialized = JSON.stringify(value, (_key, part) => {
    if (part?.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/")) {
      images++;
      return { type: "file", mediaType: part.mediaType };
    }
    return part;
  });
  return Math.ceil(serialized.length / 3) + images * IMAGE_INPUT_TOKENS;
}

/** Count the tool text sent to the model, not UI-only chart/search/settings snapshots. */
export const messageTokens = (m: ChatMessage) => inputTokens(m.parts.map((p) => {
  if (!("output" in p) || !p.output || typeof p.output !== "object" || !("text" in p.output) || typeof p.output.text !== "string") return p;
  return { ...p, output: { text: p.output.text } };
}));

export function modelWindow(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return messages;
  let start = messages.length - 1;
  while (start > 0 && messages[start].role !== "user") start--;
  let tokens = 0;
  let images = 0;
  const count = (message: ChatMessage) => {
    tokens += messageTokens(message);
    images += message.parts.filter((part) => part.type === "file").length;
  };
  for (let i = messages.length - 1; i >= start; i--) count(messages[i]);
  for (let i = start - 1; i >= 0; i--) {
    count(messages[i]);
    if (messages.length - i > WINDOW_MESSAGES || tokens > WINDOW_TOKENS + Math.min(images, 2) * IMAGE_INPUT_TOKENS) break;
    if (messages[i].role === "user") start = i;
  }
  return messages.slice(start);
}

export type StreamItem = { thread: string; message: ChatMessage };

/**
 * One page of the chat's history, oldest first, from rows read newest first
 * (one more than a page, to know whether there's more). A page opens with a
 * user message, so a reply never shows without its question; the replies cut
 * off come with the next page up.
 */
export function streamPage(newestFirst: StreamItem[], size = STREAM_PAGE): { items: StreamItem[]; more: boolean } {
  const more = newestFirst.length > size;
  const items = newestFirst.slice(0, size).reverse();
  if (!more) return { items, more };
  const first = items.findIndex((i) => i.message.role === "user");
  return { items: first < 0 ? items : items.slice(first), more };
}

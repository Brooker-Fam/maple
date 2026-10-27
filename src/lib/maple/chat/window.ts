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

/** The same rough count as the turn's own (chars / 3), over everything stored on the message. */
export const messageTokens = (m: ChatMessage) => Math.ceil(JSON.stringify(m.parts).length / 3);

export function modelWindow(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.length) return messages;
  let start = messages.length - 1;
  while (start > 0 && messages[start].role !== "user") start--;
  let tokens = 0;
  for (let i = messages.length - 1; i >= start; i--) tokens += messageTokens(messages[i]);
  for (let i = start - 1; i >= 0; i--) {
    tokens += messageTokens(messages[i]);
    if (messages.length - i > WINDOW_MESSAGES || tokens > WINDOW_TOKENS) break;
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

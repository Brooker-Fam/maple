import { LIMIT_MESSAGE } from "@/lib/maple/chat/caps";
import { CHAT_MAX_IMAGES, parseChatImage, type ChatImage } from "@/lib/maple/chat/images";
import { CHAT_FAILED, CHAT_MAX_CHARS, CHAT_NO_ANSWER, CHAT_OFF, type ChatMessage } from "@/lib/maple/chat/types";

export const CHAT_QUEUE_LIMIT = 10;
const PREFIX = "maple-chat-drafts-v1:";
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export type QueuedMessage = {
  requestId: string;
  text: string;
  images?: ChatImage[];
  imagesMissing?: true;
  submittedAt: string;
  state: "queued" | "sending" | "uncertain" | "failed" | "received" | "cancelling" | "cancelled";
  threadId?: string;
  problem?: string;
};
export type ChatQueue = { draft: string; draftImages?: ChatImage[]; imageProblem?: string; items: QueuedMessage[]; paused: boolean };
export const emptyQueue = (): ChatQueue => ({ draft: "", items: [], paused: false });
export const queueScope = (family: number, member: string) => `${PREFIX}${encodeURIComponent(JSON.stringify([family, member]))}`;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function browserStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

function readImages(raw: unknown): { images: ChatImage[]; invalid: boolean } {
  if (raw === undefined) return { images: [], invalid: false };
  if (!Array.isArray(raw) || raw.length > CHAT_MAX_IMAGES) return { images: [], invalid: true };
  const images = raw.flatMap((item) => { const image = parseChatImage(item); return image ? [image] : []; });
  return { images, invalid: images.length !== raw.length };
}

/** Reload never silently delivers old text. An uncertain send must first be checked against its server receipt. */
export function readChatQueue(scope: string, storage = browserStorage(), now = Date.now()): ChatQueue {
  if (!storage) return emptyQueue();
  try {
    const raw = JSON.parse(storage.getItem(scope) ?? "null") as Partial<ChatQueue> | null;
    if (!raw || typeof raw.draft !== "string" || !Array.isArray(raw.items) || raw.items.length > CHAT_QUEUE_LIMIT) return emptyQueue();
    const draftImages = readImages(raw.draftImages);
    const ids = new Set<string>();
    const items = raw.items.flatMap((item): QueuedMessage[] => {
      const attachments = readImages(item?.images);
      if (!item || typeof item.requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(item.requestId) || ids.has(item.requestId) || typeof item.text !== "string" || (!item.text.trim() && !attachments.images.length && !attachments.invalid && !item.imagesMissing) || item.text.length > CHAT_MAX_CHARS || typeof item.submittedAt !== "string" || !Number.isFinite(Date.parse(item.submittedAt))) return [];
      ids.add(item.requestId);
      const imagesMissing = attachments.invalid || item.imagesMissing === true;
      const expired = now - Date.parse(item.submittedAt) > MAX_AGE;
      return [{ requestId: item.requestId, text: item.text, submittedAt: item.submittedAt,
        ...(attachments.images.length ? { images: attachments.images } : {}),
        ...(imagesMissing ? { imagesMissing: true } : {}),
        state: item.state === "sending" || item.state === "uncertain" || item.state === "cancelling" ? "uncertain" : item.state === "received" || item.state === "cancelled" ? item.state : imagesMissing || expired || item.state === "failed" ? "failed" : "queued",
        ...(typeof item.threadId === "string" ? { threadId: item.threadId } : {}),
        ...(imagesMissing ? { problem: "An attached photo could not be restored. Edit or discard this message before continuing." } : expired ? { problem: "This message is over a week old. Edit it before sending." } : typeof item.problem === "string" ? { problem: item.problem.slice(0, 300) } : {}),
      }];
    });
    return { draft: raw.draft.slice(0, CHAT_MAX_CHARS), items, paused: items.length > 0,
      ...(draftImages.images.length ? { draftImages: draftImages.images } : {}),
      ...(draftImages.invalid ? { imageProblem: "An attached photo could not be restored. Add it again before sending." } : raw.imageProblem ? { imageProblem: String(raw.imageProblem).slice(0, 300) } : {}),
    };
  } catch { return emptyQueue(); }
}

export function writeChatQueue(scope: string, value: ChatQueue, storage = browserStorage()): boolean {
  if (!storage) return false;
  try {
    if (!value.draft && !value.draftImages?.length && !value.imageProblem && !value.items.length) storage.removeItem(scope);
    else storage.setItem(scope, JSON.stringify(value));
    return true;
  } catch { return false; }
}

/** Signing out removes private drafts and unsent text from this browser. */
export function clearStoredChatQueues(): void {
  try {
    if (typeof window === "undefined") return;
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) window.localStorage.removeItem(key);
    }
    window.dispatchEvent(new Event("maple:chat-drafts-cleared"));
  } catch { /* Storage can be unavailable on a shared/private browser. */ }
}

export function waitingForAnswer(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.parts.some((p) =>
    (p.type === "tool-ask_user" && "state" in p && p.state === "input-available") || ("state" in p && p.state === "approval-requested")
  );
}

/** The server's own last lines for a reply that stopped (chat/turn.ts stoppedLine). */
const STOPPED_LINES = new Set([CHAT_FAILED, CHAT_NO_ANSWER, CHAT_OFF, LIMIT_MESSAGE]);

/** A saved interrupted reply is an acknowledgement, not permission to run the next queued instruction. */
export function replyFailed(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  return last?.role === "assistant" && last.parts.some((p) =>
    ("state" in p && p.state === "output-error") ||
    (p.type === "text" && (STOPPED_LINES.has(p.text.trim()) || /answer stopped|connection dropped|didn't finish|couldn't finish|temporarily unavailable|try again later/i.test(p.text)))
  );
}

/** A reply whose last words say nothing was saved (CHAT_NO_ANSWER), so the message before it can be sent again as it was. */
export function safeToSendAgain(message: ChatMessage | undefined): boolean {
  if (message?.role !== "assistant") return false;
  const texts = message.parts.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []));
  return texts.at(-1) === CHAT_NO_ANSWER;
}

import type { UIMessage } from "ai";
import type { AlertTier } from "../guidelines";

/**
 * What the in-app chat's server and sheet share. No server imports: the
 * sheet bundles this file.
 */

export const CHAT_MAX_CHARS = 2000;

/** useChat's id for a thread: made on the phone, checked on the server. */
export const THREAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type ChatAlert = { tier: AlertTier; label: string; title: string; body: string };

/** One "Saved #1234: …" line from a write, with the entry it made (Undo removes it). */
export type ChatReceipt = { id: number; line: string };

/**
 * A tool's result as the sheet reads it. `text` is what the model gets;
 * the rest is for the cards under the reply.
 */
export type ChatToolOutput = {
  ok: boolean;
  text: string;
  /** Write tools get a receipt row; reads show nothing but their alerts. */
  write: boolean;
  alerts?: ChatAlert[];
  /** Her alerts are about her OB, not the pediatrician. */
  mom?: boolean;
  saved?: ChatReceipt[];
  duplicateOf?: number;
  /** delete_entry's entry, which Restore brings back. */
  deleted?: number;
  /** show_help's card. */
  about?: HelpAbout;
};

export type HelpAbout = "maple" | "mom" | "anyone";

export type ChatData = {
  /** The app's own line on each user message (time, her age, who's signed in), for the model only. */
  context: { line: string };
  /** The help card, added by the server: after a crisis mention, or when the model declined to answer. */
  help: { reason: "crisis" | "refusal" };
};

export type ChatMessage = UIMessage<unknown, ChatData>;

export type ChatThread = { id: string; title: string | null; updated_at: string };

/** A refused POST: `code` says what the sheet should do about it. */
export type ChatRefusal = { error: string; code?: "busy" | "new_chat" | "stale" | "limit" | "off" };

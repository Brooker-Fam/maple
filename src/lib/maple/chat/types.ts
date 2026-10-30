import type { UIMessage } from "ai";
import type { AlertTier } from "../guidelines";
import type { ChatChartSnapshot } from "./charts";
import type { ChatNavigationCard } from "./navigation";
import type { ChatCareReceipt, ChatToolError } from "./receipts";
import type { ChatEntryResults } from "./search";
import type { SettingProposal, SettingsSnapshot } from "./settings";

/**
 * What the in-app chat's server and the Chat tab share. No server imports: the
 * tab bundles this file.
 */

export const CHAT_MAX_CHARS = 2000;

export const CHAT_OFF = "The chat isn't available right now. Logging works as usual.";
export const CHAT_FAILED = "Something went wrong, so the answer stopped. Check Today before trying again, so nothing is logged twice.";

/** useChat's id for a thread: made on the phone, checked on the server. */
export const THREAD_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type ChatAlert = { tier: AlertTier; label: string; title: string; body: string };

/** One "Saved #1234: …" line from a write, with the entry it made (Undo removes it). */
export type ChatReceipt = { id: number; line: string };

/** An invite invite_person made: its link stays on the card (Copy link), out of the model's text. Only that address can use it. */
export type ChatInvite = { email: string; url: string; emailed: boolean };

/** A small question in the conversation. The stored options, never the phone, supply each choice's meaning. */
export type ChatQuestionInput = { question: string; options: { id: string; label: string }[] };
export type ChatQuestionAnswer = { choiceId: string; text?: never } | { text: string; choiceId?: never };
export type ChatQuestionOutput = { status: "answered"; answer: string; choiceId?: string } | { status: "superseded" };

/**
 * A tool's result as the Chat tab reads it. `text` is what the model gets;
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
  careReceipts?: ChatCareReceipt[];
  error?: ChatToolError;
  duplicateOf?: number;
  /** delete_entry's entry, which Restore brings back. */
  deleted?: number;
  /** show_help's card. */
  about?: HelpAbout;
  /** A dated snapshot from the log, rendered by the app's chart components. */
  chart?: ChatChartSnapshot;
  entries?: ChatEntryResults;
  navigation?: ChatNavigationCard;
  setting?: SettingProposal;
  settings?: SettingsSnapshot;
  /** A family memory the tool saved or changed (memory/mcp.ts memory_change), for its card. */
  memory?: ChatMemoryChange;
  /** An invite invite_person made, for its card (Copy invite link). */
  invite?: ChatInvite;
};

/** What a memory tool did, as its card shows it: never an id. */
export type ChatMemoryChange = { status: "saved" | "supported" | "corrected" | "resolved" | "archived"; kind: string; fact: string; previous?: string };

export type HelpAbout = "maple" | "mom" | "anyone";

export type ChatData = {
  /** Stable receipt for a message submitted on this phone; never displayed as an entry number. */
  delivery: { requestId: string; submittedAt: string };
  /** The app's own lines on each user message, for the model only: `line` (time, her age, who's signed in), then `state` (the log as it stood). */
  context: { line: string; state?: string[] };
  /** The help card, added by the server: after a crisis mention, or when the model declined to answer. */
  help: { reason: "crisis" | "refusal" };
};

export type ChatMessage = UIMessage<unknown, ChatData>;

/** `busy`: a turn is still running (GET of one thread only), so its reply isn't saved yet. */
export type ChatThread = { id: string; title: string | null; updated_at: string; busy?: boolean };

/** A refused POST: `code` says what the Chat tab should do about it; `help` that the message mentioned a crisis, so the help card shows anyway. */
export type ChatRefusal = { error: string; code?: "busy" | "new_chat" | "stale" | "limit" | "off" | "terms" | "received" | "cancelled"; help?: "crisis"; requestId?: string; threadId?: string };

export const CHAT_TERMS_NEEDED = "Accept the chat's terms first. Logging works as usual.";

/**
 * Where this member stands with the chat: `terms`, they accepted its terms
 * (consent kind chat); `care`, the care person let it see her page: her
 * medicines and doses, temperatures and questions for her OB (chat_care);
 * `self`, this member is her, so the switch is theirs.
 */
export type ChatConsent = { terms: boolean; care: boolean; self: boolean };

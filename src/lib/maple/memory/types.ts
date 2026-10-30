/**
 * Family memories (docs/maple.md "Memories"): what a family asked Maple to
 * keep in mind across conversations, one record per fact, each saying who
 * said it and where. Modeled on Moku's athlete memories: a correction keeps
 * the old version as history, resolve and archive end a memory, and Forget
 * deletes its text. No server imports: the Settings page bundles this file.
 */

export const MEMORY_KINDS = ["health", "feeding", "sleep", "routine", "care_team", "background", "preference"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  health: "Health",
  feeding: "Feeding",
  sleep: "Sleep",
  routine: "Routine",
  care_team: "Care team",
  background: "Background",
  preference: "Preferences",
};

/** What each kind holds, for the tools' descriptions and the Add sheet's hint. */
export const MEMORY_KIND_HINT: Record<MemoryKind, string> = {
  health: "allergies, conditions, care instructions from the doctor",
  feeding: "the feeding plan, formula, bottles, pumping",
  sleep: "where and how the baby sleeps",
  routine: "who does what, and when",
  care_team: "doctors, lactation help, other care",
  background: "the birth and history",
  preference: "how the family likes answers",
};

/** active: in use. superseded: replaced by a correction. resolved: it ended. archived: set aside. Forgotten ones are deleted. */
export const MEMORY_STATUSES = ["active", "superseded", "resolved", "archived"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Where a memory was said or changed: Settings in the app (web), Maple's chat, or a connected assistant (one connected before it was named says mcp). */
export const MEMORY_VIAS = ["web", "chat", "claude", "chatgpt", "muse", "grok", "mcp"] as const;
export type MemoryVia = (typeof MEMORY_VIAS)[number];

export const MEMORY_VIA_LABEL: Record<MemoryVia, string> = {
  web: "Settings",
  chat: "Maple chat",
  claude: "Claude",
  chatgpt: "ChatGPT",
  muse: "Muse",
  grok: "Grok",
  mcp: "an AI assistant",
};

export type MemoryRecord = {
  id: number;
  kind: MemoryKind;
  fact: string;
  reason: string | null;
  status: MemoryStatus;
  /** Inclusive civil dates (YYYY-MM-DD) in the family's timezone. */
  valid_from: string | null;
  valid_to: string | null;
  review_on: string | null;
  /** This memory's own version, which an edit names. */
  revision: number;
  /** The version a correction replaced. */
  predecessor_id: number | null;
  /** Member id of who said it or added it. */
  said_by: string | null;
  via: MemoryVia;
  /** What it rests on: the person's own words (`source_words`) or the assistant's short note. Removed with that person's chat history. */
  source_text: string | null;
  source_words: boolean;
  stated_at: string;
  ended_at: string | null;
  ended_by: string | null;
  ended_via: MemoryVia | null;
  updated_at: string;
};

/**
 * One family's memory settings. `revision` moves on every change; `epoch`
 * on every Forget and switch change, so a chat turn that started before one
 * can't write what it read back (Moku's privacy epoch).
 */
export type MemoryState = { revision: number; epoch: number; capture: boolean; use: boolean };

export type MemoryList = { state: MemoryState; today: string; records: MemoryRecord[]; canEdit: boolean };

export const MEMORY_FACT_MAX = 500;
export const MEMORY_REASON_MAX = 300;
export const MEMORY_SOURCE_MAX = 1000;

/** How the assistants name a memory: "m12". Maple's entries are plain numbers and hers are c…/p…, so none reach another's rows. */
export const memoryRef = (id: number) => `m${id}`;

/** A memory id from "m12", "M12", "12" or 12, or null. */
export function parseMemoryRef(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  const m = /^[mM]?([1-9]\d{0,15})$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Text as it's stored: no control characters or lone surrogate halves
 * (Postgres refuses a NUL, and its error quotes the text), one line, trimmed.
 */
export function cleanMemoryText(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|[\u0000-\u001F\u007F]/g, (c) => (c.length === 2 ? c : " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** A model's way of sending nothing. */
export function isPlaceholder(text: string | null | undefined): boolean {
  return ["", "null", "none", "n/a", "na", "-", "undefined"].includes((text ?? "").trim().toLowerCase());
}

/** The same fact however it's spaced, cased or ended: two active memories never share one. */
export function normalFact(fact: string): string {
  return cleanMemoryText(fact).toLowerCase().replace(/[.!]+$/, "").trim();
}

export class MemoryInputError extends Error {}

export type MemoryInput = {
  kind: MemoryKind;
  fact: string;
  reason: string | null;
  valid_from: string | null;
  valid_to: string | null;
  review_on: string | null;
};

function realDay(key: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function optionalText(raw: unknown, max: number, label: string): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new MemoryInputError(`${label} must be text.`);
  const text = cleanMemoryText(raw);
  if (isPlaceholder(text)) return null;
  if (text.length > max) throw new MemoryInputError(`${label} is too long (at most ${max} characters).`);
  return text;
}

function optionalDay(raw: unknown, label: string): string | null {
  if (raw == null || (typeof raw === "string" && isPlaceholder(raw))) return null;
  if (typeof raw !== "string" || !realDay(raw.trim())) throw new MemoryInputError(`${label} must be a date like 2026-11-15.`);
  return raw.trim();
}

/**
 * A memory as typed in Settings or sent by an assistant, checked the same
 * way for both. `assistant`: a model wrote it, so a placeholder or a single
 * word ("Yes", "45") is refused: it says nothing on its own.
 */
export function readMemoryInput(raw: Record<string, unknown>, opts: { assistant: boolean }): MemoryInput {
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new MemoryInputError(`kind must be one of ${MEMORY_KINDS.join(", ")}.`);
  if (typeof raw.fact !== "string") throw new MemoryInputError("The memory needs its text.");
  const fact = cleanMemoryText(raw.fact);
  if (fact.length < 2 || isPlaceholder(fact)) throw new MemoryInputError("The memory needs its text.");
  if (fact.length > MEMORY_FACT_MAX) throw new MemoryInputError(`The memory is too long (at most ${MEMORY_FACT_MAX} characters). Keep it to one or two sentences.`);
  if (opts.assistant && fact.split(" ").length < 2) {
    throw new MemoryInputError("Write the memory as one self-contained sentence about who and what it concerns, not a single word.");
  }
  const input: MemoryInput = {
    kind: kind as MemoryKind,
    fact,
    reason: optionalText(raw.reason, MEMORY_REASON_MAX, "The reason"),
    valid_from: optionalDay(raw.valid_from, "valid_from"),
    valid_to: optionalDay(raw.valid_to, "valid_to"),
    review_on: optionalDay(raw.review_on, "review_on"),
  };
  if (input.valid_from && input.valid_to && input.valid_from > input.valid_to) throw new MemoryInputError("valid_to must be on or after valid_from.");
  return input;
}

/** What a memory rests on, as an assistant sent it: null when there's nothing to add. */
export function readSourceText(raw: unknown): string | null {
  return optionalText(raw, MEMORY_SOURCE_MAX, "The supporting text");
}

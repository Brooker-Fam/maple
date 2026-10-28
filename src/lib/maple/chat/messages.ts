import { isToolUIPart } from "ai";
import { CHAT_MAX_CHARS, type ChatMessage } from "./types";
import { questionAnswerText, supersedeQuestions } from "./questions";

/**
 * What the chat route takes from the phone, and how it changes stored
 * history. The phone sends only its newest message; history comes from the
 * database. A user message is plain text. An assistant message is only ever
 * a carrier for approval taps or question answers: separate mergers copy
 * only validated answers onto the server's own stored parts.
 */

export class ChatInputError extends Error {}

export type Incoming = { kind: "user"; text: string } | { kind: "continuation"; message: { id: string; parts: unknown[] } };

const MSG_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function readIncoming(raw: unknown): Incoming {
  const m = raw as { id?: unknown; role?: unknown; parts?: unknown } | null;
  if (!m || typeof m !== "object" || !Array.isArray(m.parts)) throw new ChatInputError("Expected a message");
  if (m.role === "user") return { kind: "user", text: userText(m.parts) };
  if (m.role === "assistant" && typeof m.id === "string" && MSG_ID_RE.test(m.id) && m.parts.length <= 200) return { kind: "continuation", message: { id: m.id, parts: m.parts } };
  throw new ChatInputError("Expected a message");
}

/**
 * Whatever text a user message carries, valid or not, so the crisis check can
 * read it before anything (a cap, a busy thread, a bad part) turns it away.
 */
export function roughText(raw: unknown): string {
  const m = raw as { role?: unknown; parts?: unknown } | null;
  if (!m || typeof m !== "object" || !Array.isArray(m.parts)) return "";
  if (m.role === "assistant") return questionAnswerText(m.parts);
  if (m.role !== "user") return "";
  const texts = m.parts.slice(0, 20).flatMap((p) => {
    const t = (p as { text?: unknown } | null)?.text;
    return typeof t === "string" ? [t] : [];
  });
  return texts.join("\n").slice(0, 10 * CHAT_MAX_CHARS);
}

/** A turned-away request's JSON body with the help marker added, so the Chat tab shows the help card though no answer came. A streamed answer carries its own card. */
export async function withCrisisHelp(res: Response): Promise<Response> {
  if (res.ok || !res.headers.get("content-type")?.includes("application/json")) return res;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ error: "Something went wrong", ...body, help: "crisis" }), { status: res.status, headers });
}

/**
 * Text without control characters (tab and newlines stay) or lone surrogate
 * halves: Postgres's jsonb refuses \u0000 and a lone surrogate, and its error
 * quotes the text around it.
 */
export function storable(text: string): string {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (c) => (c.length === 2 ? c : ""));
}

/** The text of a user message: text parts only, at most CHAT_MAX_CHARS once trimmed. */
export function userText(parts: unknown[]): string {
  if (!parts.length || parts.length > 20) throw new ChatInputError("Type a message first.");
  const texts = parts.map((p) => {
    const part = p as { type?: unknown; text?: unknown } | null;
    if (!part || part.type !== "text" || typeof part.text !== "string") throw new ChatInputError("Messages here are text only.");
    return part.text;
  });
  const text = storable(texts.join("\n")).trim();
  if (!text) throw new ChatInputError("Type a message first.");
  if (text.length > CHAT_MAX_CHARS) throw new ChatInputError(`That's over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters. Try a shorter message.`);
  return text;
}

/** The user message as stored: the app's context lines for the model, then their words. */
export function userMessage(id: string, text: string, line: string, state: string[] = []): ChatMessage {
  return { id, role: "user", parts: [{ type: "data-context", data: { line, ...(state.length ? { state } : {}) } }, { type: "text", text }] };
}

/** How many model steps a stored reply has run, so an approval's continuation shares the turn's step cap. */
export function stepsTaken(m: ChatMessage): number {
  return m.parts.filter((p) => p.type === "step-start").length;
}

/** A thread's title: the first line of its first message. */
export function titleFrom(text: string): string {
  const first = text.split("\n")[0].trim().replace(/\s+/g, " ");
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

type Approvable = { toolCallId: string; state: string; approval?: { id: string; approved?: boolean; reason?: string } };

function asTool(p: unknown): Approvable | null {
  return p && typeof p === "object" && isToolUIPart(p as Parameters<typeof isToolUIPart>[0]) ? (p as Approvable) : null;
}

/**
 * The stored message with the phone's answers to its approval requests, or
 * null when nothing was answered. Only parts the server stored as
 * approval-requested can change, only to approval-responded, and only by
 * their approval id; inputs, outputs, text and every other part stay as stored.
 */
export function mergeApprovals(stored: ChatMessage, incoming: { id: string; parts: unknown[] }): ChatMessage | null {
  if (stored.role !== "assistant" || stored.id !== incoming.id) return null;
  const answers = new Map<string, { approved: boolean; reason?: string }>();
  for (const p of incoming.parts) {
    const t = asTool(p);
    const a = t?.approval as { id?: unknown; approved?: unknown; reason?: unknown } | undefined;
    if (!t || !a || typeof a.id !== "string" || typeof a.approved !== "boolean") continue;
    const reason = typeof a.reason === "string" ? storable(a.reason.trim().slice(0, 200)).trim() : "";
    answers.set(`${t.toolCallId}\n${a.id}`, { approved: a.approved, ...(reason ? { reason } : {}) });
  }
  let changed = 0;
  const parts = stored.parts.map((p) => {
    const t = asTool(p);
    if (!t || t.state !== "approval-requested" || !t.approval) return p;
    const answer = answers.get(`${t.toolCallId}\n${t.approval.id}`);
    if (!answer) return p;
    changed++;
    return { ...p, state: "approval-responded", approval: { ...t.approval, ...answer } } as typeof p;
  });
  return changed ? { ...stored, parts } : null;
}

/**
 * History with every unanswered approval turned into a "no" (a new message
 * moved on without a tap), so the model gets a result for every call it
 * made. `changed` are the messages that need saving.
 */
export function denyPending(history: ChatMessage[]): { messages: ChatMessage[]; changed: ChatMessage[] } {
  const changed: ChatMessage[] = [];
  const messages = history.map((m) => {
    const superseded = supersedeQuestions(m);
    if (m.role !== "assistant" || (superseded === m && !m.parts.some((p) => asTool(p)?.state === "approval-requested"))) return m;
    const parts = superseded.parts.map((p) => {
      const t = asTool(p);
      if (!t || t.state !== "approval-requested" || !t.approval) return p;
      return { ...p, state: "approval-responded", approval: { ...t.approval, approved: false, reason: "They sent a new message instead of answering." } } as typeof p;
    });
    const next = { ...m, parts };
    changed.push(next);
    return next;
  });
  return { messages, changed };
}

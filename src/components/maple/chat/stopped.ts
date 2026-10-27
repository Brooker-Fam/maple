import { isToolUIPart } from "ai";
import { LIMIT_MESSAGE } from "@/lib/maple/chat/caps";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { CHAT_FAILED, CHAT_OFF, type ChatMessage, type ChatRefusal } from "@/lib/maple/chat/types";

/**
 * What the Chat tab makes of an answer that stopped early: a refused POST, the
 * server's own line mid-answer, or a dropped connection. No React here, so
 * the chat's checks can run it.
 */

export const DROPPED = "The connection dropped, so the answer may be cut off. It fills in here once it's saved; check Today before trying again.";

/** The only lines the server ends an answer with; any other error text (the browser's, a proxy's page) reads as DROPPED. */
const SERVER_LINES = new Set([CHAT_FAILED, CHAT_OFF, LIMIT_MESSAGE]);

export const textOf = (m: ChatMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

/**
 * Once the thread reloads: whether the tab still shows its own help card,
 * because the last message sent mentioned a crisis and the saved thread has
 * no card answering it (turned away, or its reply was never saved). An older
 * reply's card doesn't count.
 */
export function needsHelpCard(saved: ChatMessage[], sent: string | null, names: readonly (string | null | undefined)[] = []): boolean {
  if (sent == null || !mentionsCrisis(sent, names)) return false;
  const reply = saved.at(-1);
  const asked = saved.at(-2);
  return !(reply?.role === "assistant" && reply.parts.some((p) => p.type === "data-help") && asked?.role === "user" && textOf(asked) === sent);
}

/** A refused POST arrives as the response body's text (DefaultChatTransport); an error mid-answer is plain text. */
export function refusalOf(message: string): ChatRefusal | null {
  try {
    const b = JSON.parse(message) as Partial<ChatRefusal>;
    return typeof b?.error === "string" ? (b as ChatRefusal) : null;
  } catch {
    return null;
  }
}

/** The problem line under the chat for an error's message. */
export function problemFor(message: string): string {
  return refusalOf(message)?.error ?? (SERVER_LINES.has(message) ? message : DROPPED);
}

/** A turned-away tap was never taken: its card goes back to asking, as the server still has it. */
export function unanswered(m: ChatMessage): ChatMessage {
  const parts = m.parts.map((p) =>
    isToolUIPart(p) && p.state === "approval-responded" ? ({ ...p, state: "approval-requested", approval: { id: p.approval.id } } as unknown as typeof p) : p
  );
  return { ...m, parts };
}

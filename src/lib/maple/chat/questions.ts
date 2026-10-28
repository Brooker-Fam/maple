import { z } from "zod";
import { CHAT_MAX_CHARS, type ChatMessage, type ChatQuestionAnswer, type ChatQuestionInput, type ChatQuestionOutput } from "./types";

const choiceId = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const plain = (max: number) => z.string().trim().min(1).max(max);

export const questionSchema = z.object({
  question: plain(240),
  options: z.array(z.object({ id: choiceId, label: plain(100) }).strict()).min(2).max(4),
}).strict().refine((q) => new Set(q.options.map((o) => o.id)).size === q.options.length, "Each choice must have its own id.");

const answerSchema = z.union([
  z.object({ choiceId }).strict(),
  z.object({ text: plain(CHAT_MAX_CHARS) }).strict(),
]);

export const questionOutputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), answer: plain(CHAT_MAX_CHARS), choiceId: choiceId.optional() }).strict(),
  z.object({ status: z.literal("superseded") }).strict(),
]);

/** Shared by the server and card: incomplete or malformed tool input is never an actionable question. */
export function questionInput(raw: unknown): ChatQuestionInput | null {
  const parsed = questionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type QuestionPart = {
  type: "tool-ask_user";
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
};

function questionPart(raw: unknown): QuestionPart | null {
  const p = raw as Partial<QuestionPart> | null;
  return p?.type === "tool-ask_user" && typeof p.toolCallId === "string" ? p as QuestionPart : null;
}

export function hasPendingQuestion(message: ChatMessage): boolean {
  return message.parts.some((p) => questionPart(p)?.state === "input-available");
}

/** Only raw custom-answer text is user-authored; never use client-supplied labels or assistant prose. */
export function questionAnswerText(parts: unknown[]): string {
  return parts.slice(-200).flatMap((raw) => {
    const p = questionPart(raw);
    const out = p?.output as { text?: unknown } | null;
    return p?.state === "output-available" && typeof out?.text === "string" ? [out.text.slice(0, CHAT_MAX_CHARS)] : [];
  }).join("\n").slice(0, CHAT_MAX_CHARS);
}

function answerFor(input: ChatQuestionInput, raw: unknown): ChatQuestionOutput | null {
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return null;
  const answer: ChatQuestionAnswer = parsed.data;
  if (answer.choiceId !== undefined) {
    const choice = input.options.find((o) => o.id === answer.choiceId);
    return choice ? { status: "answered", choiceId: choice.id, answer: choice.label } : null;
  }
  // Match the chat's storage boundary without importing the server-side message helpers into the card.
  const text = answer.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (c) => c.length === 2 ? c : "").trim();
  return text ? { status: "answered", answer: text } : null;
}

/** Copy answers onto the server's pending calls only. Text, input, tool names and every unrelated output stay server-owned. */
export function mergeQuestionAnswers(stored: ChatMessage, incoming: { id: string; parts: unknown[] }): ChatMessage | null {
  if (stored.role !== "assistant" || stored.id !== incoming.id || incoming.parts.length > 200) return null;
  const submitted = new Map<string, unknown>();
  for (const raw of incoming.parts) {
    const p = questionPart(raw);
    if (!p || p.state !== "output-available") continue;
    if (submitted.has(p.toolCallId)) return null;
    submitted.set(p.toolCallId, p.output);
  }
  let changed = false;
  let invalid = false;
  const parts = stored.parts.map((p) => {
    const q = questionPart(p);
    if (!q || q.state !== "input-available" || !submitted.has(q.toolCallId)) return p;
    const input = questionInput(q.input);
    const output = input ? answerFor(input, submitted.get(q.toolCallId)) : null;
    if (!output) { invalid = true; return p; }
    changed = true;
    return { ...p, state: "output-available" as const, output };
  });
  return changed && !invalid ? { ...stored, parts } as ChatMessage : null;
}

/** A typed reply moves on naturally; the model reads it as the person's next message. */
export function supersedeQuestions(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !hasPendingQuestion(message)) return message;
  return { ...message, parts: message.parts.map((p) => questionPart(p)?.state === "input-available"
    ? { ...p, state: "output-available" as const, output: { status: "superseded" } satisfies ChatQuestionOutput }
    : p) } as ChatMessage;
}

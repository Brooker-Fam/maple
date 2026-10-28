import { getToolName, isToolUIPart } from "ai";
import type { ChatMessage } from "@/lib/maple/chat/types";

export type QuestionAnswer = { choiceId: string } | { text: string };

/** Only a newly submitted answer resumes a client tool; ordinary completed tools do not. */
export function hasQuestionAnswer({ messages }: { messages: ChatMessage[] }): boolean {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return false;
  const step = last.parts.slice(last.parts.findLastIndex((p) => p.type === "step-start") + 1);
  const submitted = step.some((p) => {
    if (!isToolUIPart(p) || getToolName(p) !== "ask_user" || p.state !== "output-available") return false;
    const o = p.output as Record<string, unknown> | undefined;
    return o != null && !("status" in o) && (typeof o.choiceId === "string" || typeof o.text === "string");
  });
  // Each answer is persisted separately; the server waits for any other cards.
  return submitted;
}

/** One truthful status for the whole turn, including invisible reasoning and read results. */
export function chatActivity(messages: ChatMessage[], state: { busy: boolean; recovering: boolean; recoveryPaused: boolean; checkingDelivery?: boolean; cancellingDelivery?: boolean }): string | null {
  if (state.cancellingDelivery) return "Checking whether the message can be cancelled…";
  if (state.checkingDelivery) return state.recoveryPaused ? "Waiting to reconnect…" : "Checking whether your message was received…";
  if (state.recovering) return state.recoveryPaused ? "Waiting to reconnect…" : "Finishing your previous reply…";
  if (!state.busy) return null;
  const last = messages.at(-1);
  if (last?.role !== "assistant") return "Thinking…";
  const pending = last.parts.filter(isToolUIPart).findLast((p) =>
    p.state === "input-streaming" || p.state === "input-available" || (p.state === "approval-responded" && p.approval.approved)
  );
  if (pending) {
    const name = getToolName(pending);
    if (name === "ask_user") return "Preparing a question…";
    if (name === "show_chart") return "Preparing your chart…";
    if (/^(log_|start_timer$|stop_timer$|record_birth$|add_mom_question$)/.test(name)) return "Saving…";
    if (/^(update_|delete_|restore_|fix_|undo_|reopen_|switch_side$|pause_nursing$)/.test(name)) return "Updating the log…";
    return "Checking the log…";
  }
  return last.parts.some((p) => (p.type === "text" && p.text.trim()) || isToolUIPart(p)) ? "Finishing your reply…" : "Thinking…";
}

/** Hidden reasoning need not move the scroll position or trigger a live announcement. */
export function visibleRevision(message: ChatMessage | undefined): string {
  return message?.parts.flatMap((p) => p.type === "text" ? [`text:${p.text.length}`] : isToolUIPart(p) ? [`${p.toolCallId}:${p.state}`] : p.type === "data-help" ? ["help"] : []).join("|") ?? "";
}

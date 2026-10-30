"use client";

import { useState } from "react";
import { feedbackDestination, FEEDBACK_TOPICS, replyableMember, TOPIC_LABEL, type FeedbackTopic } from "@/lib/maple/feedback/types";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * The chat's Send card before send_feedback (chat/feedback-tools.ts): the
 * exact message stored with the call, and where it goes. Send is the
 * person's yes; the server runs only the stored call.
 */

/** What the card says once it's been passed by, answered no, or answered yes without a result yet. */
export const FEEDBACK_WORDS = { idle: "Nothing was sent.", kept: "Not sent.", unknown: "That didn't finish, so it may not have been sent. Ask again to send it." };

export function FeedbackApproval({ input, onAnswer }: { input: unknown; onAnswer: (approved: boolean) => void }) {
  const { state } = useMaple();
  const [answered, setAnswered] = useState(false);
  const raw = (input ?? {}) as { message?: unknown; topic?: unknown };
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  const topic = FEEDBACK_TOPICS.includes(raw.topic as FeedbackTopic) && raw.topic !== "other" ? TOPIC_LABEL[raw.topic as FeedbackTopic] : null;
  const answer = (ok: boolean) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(ok);
  };
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label="Send this feedback?">
      <p className="text-[13px] font-semibold text-mp-ink-2">Send this feedback?{topic ? ` · ${topic}` : ""}</p>
      <p className={cx(tone.body, "text-[15px] leading-snug whitespace-pre-wrap wrap-anywhere")}>{message || "No message"}</p>
      <p className={cx(tone.muted, "text-[13px] leading-snug")}>{feedbackDestination(!!state && replyableMember(state.me.email))}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" onClick={() => answer(false)} disabled={answered}>
          Don&apos;t send
        </Button>
        <Button onClick={() => answer(true)} disabled={answered || !message}>
          Send
        </Button>
      </div>
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { FEEDBACK_NOT_SENT, FEEDBACK_QUESTION, FEEDBACK_RATINGS, FEEDBACK_THANKS, feedbackDestination, RATING_LABEL, type FeedbackAsk, type FeedbackRating } from "@/lib/maple/feedback/types";
import { isFamilyOne } from "./familyWords";
import { useNightActive } from "./nightLook";
import { Button, Chip, Field, TextArea, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Feedback for the person who makes Maple (/api/maple/feedback): the
 * question Today asks once. Settings → Send feedback is
 * settings/FeedbackSheet.tsx, and the chat sends it from its Send card
 * (chat/ChatFeedback.tsx).
 */

/** This phone's answer for the session, so going back to Today doesn't ask the server again. */
let asked: { key: string; ask: FeedbackAsk } | null = null;

/**
 * "How is Maple working for you?" on Today, for owners and members once the
 * server says it's time (feedbackAsk). Like the day's discovery, it keeps out
 * of the way at night and while a timer runs.
 */
export function FeedbackPrompt() {
  const { state, summary, api, toast, readOnly } = useMaple();
  const night = useNightActive();
  const key = state && !readOnly && !isFamilyOne(state) ? `${state.family?.id}|${state.me.email}` : null;
  const [answer, setAnswer] = useState<{ key: string; ask: FeedbackAsk } | null>(asked);
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!key || asked?.key === key) return;
    let live = true;
    api<FeedbackAsk>("/api/maple/feedback")
      .then((ask) => {
        asked = { key, ask };
        if (live) setAnswer(asked);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, api]);
  const ask = key && answer?.key === key ? answer.ask : null;
  if (!key || !ask?.ask || night || summary?.active.length) return null;

  const close = () => {
    asked = { key, ask: { ...ask, ask: false } };
    setAnswer(asked);
  };
  const later = () => {
    close();
    void api("/api/maple/feedback", { method: "POST", body: JSON.stringify({ later: true }) }).catch(() => {});
  };
  const send = async () => {
    setBusy(true);
    try {
      await api("/api/maple/feedback", { method: "POST", body: JSON.stringify({ via: "prompt", rating, message }) });
      close();
      toast(FEEDBACK_THANKS);
    } catch (e) {
      toast(e instanceof Error ? e.message : FEEDBACK_NOT_SENT, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="feedback-ask" className={cx(tone.card, "space-y-3 p-4")}>
      <div>
        <h2 id="feedback-ask" className={cx(tone.heading, "text-[17px]")}>
          {FEEDBACK_QUESTION}
        </h2>
        <p className={cx(tone.muted, "mt-0.5 text-[14px] leading-snug")}>A quick answer helps decide what to fix next.</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={FEEDBACK_QUESTION}>
        {FEEDBACK_RATINGS.map((r) => (
          <Chip key={r} selected={rating === r} onClick={() => setRating(rating === r ? null : r)} disabled={busy}>
            {RATING_LABEL[r]}
          </Chip>
        ))}
      </div>
      <Field label="Anything confusing, missing or great? (optional)">
        <TextArea value={message} onChange={setMessage} rows={2} />
      </Field>
      <p className={cx(tone.faint, "text-[13px] leading-snug")}>{feedbackDestination(ask.replyable)}</p>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" onClick={later} disabled={busy}>
          Not now
        </Button>
        <Button onClick={() => void send()} disabled={busy || (!rating && !message.trim())}>
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </section>
  );
}

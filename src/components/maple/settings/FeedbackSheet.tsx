"use client";

import { useState } from "react";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { FEEDBACK_NOT_SENT, FEEDBACK_THANKS, feedbackDestination, replyableMember, type FeedbackTopic } from "@/lib/maple/feedback/types";
import { Button, Chip, Field, Sheet, TextArea, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/** Email stays one tap away for anyone who'd rather write from their own app. */
const MAILTO = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Maple feedback")}`;

const TOPICS: [FeedbackTopic, string][] = [
  ["problem", "Something's wrong"],
  ["idea", "An idea"],
  ["praise", "Something I like"],
];

/** Settings → Send feedback (/api/maple/feedback): anyone signed in, guests included. */
export function FeedbackSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, api, toast } = useMaple();
  const [topic, setTopic] = useState<FeedbackTopic | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api("/api/maple/feedback", { method: "POST", body: JSON.stringify({ via: "app", topic: topic ?? "other", message }) });
      setTopic(null);
      setMessage("");
      onClose();
      toast(FEEDBACK_THANKS);
    } catch (e) {
      toast(e instanceof Error ? e.message : FEEDBACK_NOT_SENT, { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dirty={!busy && !!message.trim()}
      title="Send feedback"
      footer={
        <Button className="w-full" disabled={busy || !message.trim()} onClick={() => void send()}>
          {busy ? "Sending…" : "Send"}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="What it's about">
          {TOPICS.map(([value, label]) => (
            <Chip key={value} selected={topic === value} onClick={() => setTopic(topic === value ? null : value)} disabled={busy}>
              {label}
            </Chip>
          ))}
        </div>
        <Field label="Your feedback">
          <TextArea value={message} onChange={setMessage} rows={6} placeholder="What's working, what's missing, or what went wrong?" />
        </Field>
        <p className={cx(tone.muted, "text-[13px] leading-snug")}>
          {feedbackDestination(!!state && replyableMember(state.me.email))} Leave out health details unless they&apos;re needed.
        </p>
        <a href={MAILTO} className="inline-flex min-h-[44px] items-center text-[15px] font-medium text-mp-accent-fg">
          Or email {CONTACT_EMAIL}
        </a>
      </div>
    </Sheet>
  );
}

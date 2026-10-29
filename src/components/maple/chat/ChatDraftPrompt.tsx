"use client";

import { useEffect, type RefObject } from "react";
import { CHAT_MAX_CHARS } from "@/lib/maple/chat/types";
import { Button, cx, tone } from "../ui";
import { useChatNav } from "./ChatNav";

export default function ChatDraftPrompt({ active, draft, hasAttachments = false, setDraft, composer }: {
  active: boolean;
  draft: string;
  hasAttachments?: boolean;
  setDraft: (draft: string) => void;
  composer: RefObject<HTMLDivElement | null>;
}) {
  const { pendingPrompt, dismissPrompt } = useChatNav();

  useEffect(() => {
    if (!active || !pendingPrompt || draft.trim() || hasAttachments) return;
    setDraft(pendingPrompt.prompt);
    dismissPrompt(pendingPrompt.id);
    requestAnimationFrame(() => composer.current?.querySelector("textarea")?.focus({ preventScroll: true }));
  }, [active, pendingPrompt, draft, hasAttachments, setDraft, dismissPrompt, composer]);

  if (!pendingPrompt) return null;
  const combined = `${draft.trimEnd()}\n\n${pendingPrompt.prompt}`;
  const fits = combined.length <= CHAT_MAX_CHARS;
  return (
    <section aria-label="Question from your log" className={cx(tone.inset, "mb-2 px-3 py-2")}>
      <p className={cx(tone.heading, "text-[13px]")}>{pendingPrompt.label}</p>
      <p className={cx(tone.muted, "mt-1 max-h-24 overflow-y-auto text-[13px] leading-snug")}>{pendingPrompt.prompt}</p>
      <p className={cx(tone.faint, "mt-1 text-[12px]")}>{fits ? "Your existing draft is still here." : "Send or shorten your draft to make room for this question."}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button size="sm" variant="soft" disabled={!fits} onClick={() => {
          setDraft(combined);
          dismissPrompt(pendingPrompt.id);
          composer.current?.querySelector("textarea")?.focus({ preventScroll: true });
        }}>Add to draft</Button>
        <Button size="sm" variant="ghost" onClick={() => dismissPrompt(pendingPrompt.id)}>Dismiss question</Button>
      </div>
    </section>
  );
}

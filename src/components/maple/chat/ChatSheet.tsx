"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_MAX_CHARS } from "@/lib/maple/chat/types";
import { useCareNav } from "../care/CareNav";
import { Icon } from "../icons";
import { Button, Chip, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { HelpCard, MessageView } from "./ChatParts";
import { CareNote, TermsCard } from "./ChatTerms";
import { useChatThread } from "./useChatThread";

/**
 * Ask: the in-app chat, a tall sheet from the tab bar over whichever tab is
 * showing. The newest thread from the last six hours reopens with it; New
 * chat starts over. What the assistant logs shows under its reply with Undo,
 * and Today updates once it's done.
 * Until this member accepts the chat's terms, the terms card shows and the
 * composer waits.
 */
export default function ChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { readOnly, online } = useMaple();
  const nav = useCareNav();
  const { consent } = useChatNav();
  const t = useChatThread(open);
  const needsTerms = consent?.terms === false;
  const end = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const count = t.messages.length;
  const tail = t.messages[count - 1];
  const tailLength = tail ? JSON.stringify(tail.parts).length : 0;
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, count, tailLength, t.problem, t.help, needsTerms]);

  const waiting = t.status === "submitted" || (t.status === "streaming" && tail?.role === "user");
  const suggestions = readOnly ? ["How did the night go?", "When did she last eat?"] : ["How did the night go?", "Which side next?", "Log a wet diaper"];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask"
      tall
      actions={
        <>
          <button type="button" onClick={t.newChat} disabled={t.busy || count === 0} className="min-h-[44px] rounded-xl px-2.5 text-[15px] font-semibold text-mp-accent-fg disabled:opacity-40">
            New chat
          </button>
          <button type="button" onClick={nav.openHelp} className="min-h-[44px] rounded-xl px-2.5 text-[15px] font-semibold text-mp-danger">
            Help
          </button>
        </>
      }
      footer={<Composer t={t} disabled={!t.ready || needsTerms} offline={!online} />}
    >
      {count === 0 ? (
        !needsTerms && (
          <div className="space-y-4 pt-2">
            <p className={cx(tone.body, "text-[16px] leading-relaxed")}>
              {readOnly ? "Ask how Maple's doing, in your own words." : "Tell it what happened, or ask how Maple's doing, in your own words."}
            </p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <Chip key={s} onClick={() => t.setDraft(s)} className="min-h-[44px]!">
                  {s}
                </Chip>
              ))}
            </div>
            <CareNote consent={consent} />
            <p className={cx(tone.faint, "text-[13px] leading-snug")}>
              Answers come from an AI and can be wrong; it never gives medical advice. Each saved entry shows here with Undo.
            </p>
          </div>
        )
      ) : (
        <div className="space-y-4 pt-1">
          {t.messages.map((m, i) => (
            <MessageView key={m.id} message={m} last={i === count - 1} busy={t.busy} onApprove={t.approve} />
          ))}
          {waiting && (
            <p className={cx(tone.muted, "flex items-center gap-2 text-[14px]")} aria-live="polite">
              <Icon name="clock-3" size={16} />
              Thinking…
            </p>
          )}
        </div>
      )}
      {needsTerms && consent && <TermsCard key={`${consent.self}-${consent.care}`} consent={consent} onAccepted={t.clearProblem} />}
      {t.problem && (
        <p role="status" className={cx(tone.inset, "flex items-start gap-2 px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>
          <Icon name="info" size={16} className="mt-0.5 shrink-0 text-mp-ink-2" />
          <span className="min-w-0 flex-1 wrap-anywhere">{t.problem}</span>
        </p>
      )}
      {t.help && <HelpCard reason="crisis" />}
      {count > 0 && !t.busy && !needsTerms && (
        <div className="pt-2 text-center">
          {confirmDelete ? (
            <div className="flex items-center justify-center gap-2">
              <span className={cx(tone.muted, "text-[14px]")}>Delete this chat for good?</span>
              <Button size="sm" variant="soft" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setConfirmDelete(false);
                  void t.remove();
                }}
              >
                Delete
              </Button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className={cx(tone.faint, "min-h-[44px] px-2 text-[13px]")}>
              Delete this chat
            </button>
          )}
        </div>
      )}
      <div ref={end} />
    </Sheet>
  );
}

function Composer({ t, disabled, offline }: { t: ReturnType<typeof useChatThread>; disabled: boolean; offline: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const near = t.draft.length > CHAT_MAX_CHARS - 200;
  const canSend = !disabled && !t.busy && t.draft.trim().length > 0 && t.draft.length <= CHAT_MAX_CHARS;

  // Grows with what's typed, up to about five lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [t.draft]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends with a keyboard and mouse; on a phone it's a new line, and the button sends.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !window.matchMedia("(pointer: fine)").matches) return;
    e.preventDefault();
    if (canSend) t.send(t.draft);
  };

  return (
    <div>
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          value={t.draft}
          rows={1}
          maxLength={CHAT_MAX_CHARS}
          onChange={(e) => {
            t.setDraft(e.target.value);
            if (t.problem) t.clearProblem();
          }}
          onKeyDown={onKey}
          placeholder={offline ? "Needs a connection" : "Message"}
          aria-label="Message"
          disabled={disabled}
          className={cx(tone.input, "min-h-[44px] resize-none py-2.5 leading-snug disabled:opacity-60")}
        />
        <button
          type="button"
          onClick={() => t.send(t.draft)}
          disabled={!canSend}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent transition active:scale-95 disabled:opacity-40"
        >
          <Icon name="arrow-up" size={22} strokeWidth={2.25} />
        </button>
      </div>
      {near && (
        <p className={cx(tone.faint, "mt-1 text-right text-[12px] tabular-nums")}>
          {t.draft.length.toLocaleString("en-US")} / {CHAT_MAX_CHARS.toLocaleString("en-US")}
        </p>
      )}
    </div>
  );
}

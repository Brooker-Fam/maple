"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_MAX_CHARS } from "@/lib/maple/chat/types";
import { useCareNav } from "../care/CareNav";
import { useBabyWords } from "../familyWords";
import { Icon } from "../icons";
import { Button, Chip, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { HelpCard, MessageView } from "./ChatParts";
import { CareNote, TermsCard } from "./ChatTerms";
import { NEAR_BOTTOM, TAB_BAR, usePageHold, useVisibleArea } from "./page";
import { useChatThread } from "./useChatThread";

/**
 * Chat: this member's one conversation with Maple, a tab like the others.
 * The page fills what the phone can see (visualViewport, so the iPhone
 * keyboard never covers the composer); messages scroll between the header and
 * the composer, which sits on the tab bar, or on the keyboard while it's up.
 * Mounted once it's first shown and kept, so the draft and a reply still
 * coming survive a trip to another tab. Until this member accepts the terms,
 * their card shows here and the composer waits.
 */

export default function ChatTab({ active }: { active: boolean }) {
  const { readOnly, online } = useMaple();
  const w = useBabyWords();
  const nav = useCareNav();
  const { consent, loadConsent } = useChatNav();
  const t = useChatThread(active);
  const area = useVisibleArea(active);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const prepend = useRef<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  usePageHold(active, composer);
  const needsTerms = consent?.terms === false;

  useEffect(() => {
    if (active) loadConsent();
  }, [active, loadConsent]);

  const count = t.messages.length;
  const tail = t.messages[count - 1];
  const tailLength = tail ? JSON.stringify(tail.parts).length : 0;
  const empty = count === 0 && t.earlier.length === 0;

  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  // Opening the tab shows the newest message.
  useLayoutEffect(() => {
    if (!active) return;
    pinned.current = true;
    toBottom();
  }, [active]);
  // Earlier messages go on top without moving what's on screen; anything new keeps a pinned page at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prepend.current != null) {
      el.scrollTop += el.scrollHeight - prepend.current;
      prepend.current = null;
      return;
    }
    if (pinned.current) toBottom();
  }, [t.earlier, count, tailLength, t.problem, t.help, needsTerms, area?.height]);

  const send = (text: string) => {
    pinned.current = true;
    t.send(text);
  };
  const showEarlier = () => {
    prepend.current = scroller.current?.scrollHeight ?? null;
    void t.loadEarlier();
  };

  const waiting = t.status === "submitted" || (t.status === "streaming" && tail?.role === "user");
  const suggestions = readOnly ? ["How did the night go?", `When did ${w.he} last eat?`] : ["How did the night go?", "Which side next?", "Log a wet diaper"];
  const items = [...t.earlier, ...t.messages.map((message) => ({ thread: t.threadId ?? "", message }))];

  return (
    <section
      hidden={!active}
      aria-label="Chat"
      className="fixed inset-x-0 top-0 z-[60] mx-auto flex w-full max-w-lg flex-col bg-mp-bg"
      style={area ? { height: area.height, transform: `translateY(${area.top}px)` } : { height: "100dvh" }}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-2">
        <h1 className={cx(tone.display, "flex min-h-[44px] items-center text-[34px] leading-[1.05]")}>Chat</h1>
        <button type="button" onClick={nav.openHelp} className="-mr-2.5 min-h-[44px] rounded-xl px-2.5 text-[15px] font-semibold text-mp-danger">
          Help
        </button>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
      >
        <div className="flex min-h-full flex-col justify-end gap-4 pt-2 pb-4">
          {(t.more || (!empty && !t.busy && !needsTerms)) && (
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              {t.more && (
                <button type="button" onClick={showEarlier} disabled={t.loadingEarlier} className="min-h-[44px] px-2 text-[14px] font-semibold text-mp-accent-fg disabled:opacity-50">
                  {t.loadingEarlier ? "Loading…" : "Show earlier"}
                </button>
              )}
              {!empty && !t.busy && !needsTerms && (confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className={cx(tone.muted, "text-[14px]")}>Delete your whole chat for good?</span>
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
                </span>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)} className={cx(tone.faint, "min-h-[44px] px-2 text-[13px]")}>
                  Delete chat history
                </button>
              ))}
            </div>
          )}
          {empty && !needsTerms && t.ready && (
            <div className="space-y-4 px-1">
              <p className={cx(tone.body, "text-[16px] leading-relaxed")}>
                {readOnly ? `Ask how ${w.name}'s doing, in your own words.` : `Tell it what happened, or ask how ${w.name}'s doing, in your own words.`}
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
                Answers come from an AI and can be wrong; it never gives medical advice. Only you can see your chat. Each saved entry shows here with Undo.
              </p>
            </div>
          )}
          {items.map(({ thread, message }, i) => (
            <Fragment key={message.id}>
              {i > 0 && items[i - 1].thread !== thread && <hr aria-hidden className="mx-8 border-mp-line" />}
              <MessageView message={message} last={i === items.length - 1 && i >= t.earlier.length} busy={t.busy} onApprove={t.approve} />
            </Fragment>
          ))}
          {waiting && (
            <p className={cx(tone.muted, "flex items-center gap-2 px-1 text-[14px]")} aria-live="polite">
              <Icon name="clock-3" size={16} />
              Thinking…
            </p>
          )}
          {needsTerms && consent && <TermsCard key={`${consent.self}-${consent.care}`} consent={consent} onAccepted={t.clearProblem} />}
          {t.problem && (
            <p role="status" className={cx(tone.inset, "flex items-start gap-2 px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-mp-ink-2" />
              <span className="min-w-0 flex-1 wrap-anywhere">{t.problem}</span>
            </p>
          )}
          {t.help && <HelpCard reason="crisis" />}
        </div>
      </div>

      <div
        className="shrink-0 border-t border-mp-line bg-mp-bg"
        style={{ paddingBottom: area?.keyboard ? 0 : `calc(${TAB_BAR}px + env(safe-area-inset-bottom))` }}
      >
        <div ref={composer} className="px-4 py-2">
          <Composer t={t} onSend={send} disabled={!t.ready || needsTerms} offline={!online} />
        </div>
      </div>
    </section>
  );
}

function Composer({ t, onSend, disabled, offline }: { t: ReturnType<typeof useChatThread>; onSend: (text: string) => void; disabled: boolean; offline: boolean }) {
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
    if (canSend) onSend(t.draft);
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
          className={cx(tone.input, "min-h-[44px] resize-none rounded-[22px] py-2.5 leading-snug disabled:opacity-60")}
        />
        <button
          type="button"
          onClick={() => onSend(t.draft)}
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

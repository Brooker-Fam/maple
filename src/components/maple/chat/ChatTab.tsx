"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_MAX_CHARS } from "@/lib/maple/chat/types";
import { useCareNav } from "../care/CareNav";
import { useBabyWords } from "../familyWords";
import { Icon } from "../icons";
import { Button, Chip, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import ChatDraftPrompt from "./ChatDraftPrompt";
import { HelpCard, MessageView } from "./ChatParts";
import { CareNote, TermsCard } from "./ChatTerms";
import { NEAR_BOTTOM, TAB_BAR, usePageHold, useVisibleArea } from "./page";
import { useChatThread } from "./useChatThread";
import { chatActivity, visibleRevision } from "./progress";
import type { QueuedMessage } from "./queue";

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
  const content = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const savedScroll = useRef(0);
  const prepend = useRef<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const completingReply = useRef(false);
  usePageHold(active, composer);
  const needsTerms = consent?.terms === false;

  useEffect(() => {
    if (active) loadConsent();
  }, [active, loadConsent]);

  const count = t.messages.length;
  const tail = t.messages[count - 1];
  const revision = visibleRevision(tail);
  const empty = count === 0 && t.earlier.length === 0;
  useEffect(() => {
    if (!t.ready || t.loadingHistory) return;
    if (t.busy) {
      completingReply.current = true;
      setAnnouncement("");
    } else if (completingReply.current) {
      completingReply.current = false;
      if (tail?.role === "assistant") setAnnouncement(t.awaitingAnswer ? "Maple is waiting for your answer." : "Maple's reply is ready.");
    }
  }, [t.ready, t.loadingHistory, t.busy, t.awaitingAnswer, tail]);

  const toBottom = () => {
    const el = scroller.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      savedScroll.current = el.scrollTop;
    }
  };
  // Returning to the tab keeps the place the person was reading.
  useLayoutEffect(() => {
    if (!active) return;
    if (pinned.current) toBottom();
    else if (scroller.current) scroller.current.scrollTop = savedScroll.current;
  }, [active]);
  // Earlier messages go on top without moving what's on screen; anything new keeps a pinned page at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !active) return;
    if (prepend.current != null) {
      el.scrollTop += el.scrollHeight - prepend.current;
      prepend.current = null;
      return;
    }
    if (pinned.current) toBottom();
  }, [active, t.earlier, count, revision, t.problem, t.historyProblem, t.help, needsTerms, area?.height]);

  // Charts, expanding cards and the growing composer can resize without a new message.
  useEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!active || !el || !body) return;
    const watch = new ResizeObserver(() => {
      if (prepend.current != null) return;
      if (pinned.current) {
        el.scrollTop = el.scrollHeight;
        savedScroll.current = el.scrollTop;
      }
    });
    watch.observe(body);
    watch.observe(el);
    return () => watch.disconnect();
  }, [active]);

  const send = (text: string, clearDraft = false) => {
    pinned.current = true;
    setShowLatest(false);
    t.send(text, { clearDraft });
  };
  const showEarlier = () => {
    prepend.current = scroller.current?.scrollHeight ?? null;
    void t.loadEarlier().then((loaded) => { if (!loaded) prepend.current = null; });
  };

  const activity = t.loadingHistory ? (t.ready ? "Updating your conversation…" : null) : chatActivity(t.messages, t);
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
          if (!active) return;
          const el = e.currentTarget;
          savedScroll.current = el.scrollTop;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
          setShowLatest(!pinned.current);
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4"
      >
        <div ref={content} className="flex min-h-full flex-col justify-end gap-4 pt-2 pb-4">
          {!t.ready && t.loadingHistory && !needsTerms && (
            <div role="status" className="space-y-3 px-1 py-4">
              <p className={cx(tone.muted, "text-[14px]")}>Loading your conversation…</p>
              <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
                <div className="ml-auto h-12 w-3/5 rounded-[18px] bg-mp-surface" />
                <div className="h-20 w-4/5 rounded-[18px] bg-mp-surface" />
              </div>
            </div>
          )}
          {(t.more || (!empty && !t.busy && !t.queue.length && !needsTerms)) && (
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              {t.more && (
                <button type="button" onClick={showEarlier} disabled={t.loadingEarlier} className="min-h-[44px] px-2 text-[14px] font-semibold text-mp-accent-fg disabled:opacity-50">
                  {t.loadingEarlier ? "Loading…" : "Show earlier"}
                </button>
              )}
              {!empty && !t.busy && !t.queue.length && !needsTerms && (confirmDelete ? (
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
              <MessageView threadId={thread} message={message} last={i === items.length - 1 && i >= t.earlier.length} busy={t.busy} onApprove={t.approve} onAnswerQuestion={t.answerQuestion} onAsk={send} />
            </Fragment>
          ))}
          <div role="status" aria-live="polite" aria-atomic="true" className={!activity ? "sr-only" : undefined}>
            {activity && <ChatActivity label={activity} paused={t.recoveryPaused} />}
          </div>
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
          {t.historyProblem && (
            <div className={cx(tone.inset, "flex items-center gap-3 px-3.5 py-3 text-[14px] leading-snug")}>
              <p role="status" className={cx(tone.body, "min-w-0 flex-1")}>{t.historyProblem}</p>
              <Button size="sm" variant="soft" onClick={t.retryHistory} disabled={t.loadingHistory || !online}>Check again</Button>
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
        </div>
      </div>

      {showLatest && !empty && (
        <div className="relative z-10 h-0 shrink-0">
          <button
            type="button"
            onClick={() => { pinned.current = true; setShowLatest(false); toBottom(); }}
            className={cx(tone.card, "absolute right-5 bottom-3 flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold text-mp-accent-fg shadow-md")}
          >
            Latest reply <span aria-hidden="true">↓</span>
          </button>
        </div>
      )}

      <div
        className="shrink-0 border-t border-mp-line bg-mp-bg"
        style={{ paddingBottom: area?.keyboard ? 0 : `calc(${TAB_BAR}px + env(safe-area-inset-bottom))` }}
      >
        <div ref={composer} className="px-4 py-2">
          <QueuePanel t={t} offline={!online} />
          <ChatDraftPrompt active={active} draft={t.draft} setDraft={t.setDraft} composer={composer} />
          {!needsTerms && t.ready && !t.busy && !t.draft.trim() && (
            <div className="mb-1 flex items-center gap-1 overflow-x-auto whitespace-nowrap" aria-label="Explore your log">
              <span className={cx(tone.faint, "shrink-0 pr-1 text-[12px]")}>Explore</span>
              {[
                ["Feeding", "Show feeding over the last 7 days"],
                ["Sleep", "Show sleep over the last 7 days"],
                ["Weight", "Show the weight trend"],
              ].map(([label, question]) => (
                <button key={label} type="button" onClick={() => send(question)} disabled={!online} className="min-h-[44px] shrink-0 rounded-full px-3 text-[13px] font-medium text-mp-accent-fg disabled:opacity-40">{label}</button>
              ))}
            </div>
          )}
          <Composer t={t} onSend={(text) => send(text, true)} disabled={needsTerms} offline={!online} />
        </div>
      </div>
    </section>
  );
}

function Composer({ t, onSend, disabled, offline }: { t: ReturnType<typeof useChatThread>; onSend: (text: string) => void; disabled: boolean; offline: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const near = t.draft.length > CHAT_MAX_CHARS - 200;
  const queueing = t.busy || offline || t.queuePaused || t.awaitingAnswer || t.queue.length > 0;
  const canSend = !disabled && t.queue.length < t.queueLimit && t.draft.trim().length > 0 && t.draft.length <= CHAT_MAX_CHARS;

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
          placeholder={offline ? "Message · saved until you're online" : "Message"}
          aria-label="Message"
          disabled={disabled}
          className={cx(tone.input, "min-h-[44px] resize-none rounded-[22px] py-2.5 leading-snug disabled:opacity-60")}
        />
        <button
          type="button"
          onClick={() => onSend(t.draft)}
          disabled={!canSend}
          aria-label={queueing ? "Queue message" : "Send"}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent transition active:scale-95 disabled:opacity-40"
        >
          <Icon name="arrow-up" size={22} strokeWidth={2.25} />
        </button>
      </div>
      {t.storageProblem && <p role="status" className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>This browser couldn&apos;t save your draft. Keep this page open until your messages send.</p>}
      {t.draft.trim() && queueing && <p className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>{offline ? "Queue it here, then resume when you're connected." : "Add this to the queue while Maple finishes."}</p>}
      {near && (
        <p className={cx(tone.faint, "mt-1 text-right text-[12px] tabular-nums")}>
          {t.draft.length.toLocaleString("en-US")} / {CHAT_MAX_CHARS.toLocaleString("en-US")}
        </p>
      )}
    </div>
  );
}

function QueuePanel({ t, offline }: { t: ReturnType<typeof useChatThread>; offline: boolean }) {
  const waiting = t.queue.filter((item) => item.state !== "sending");
  if (!waiting.length) return null;
  const blocked = waiting.some((item) => item.state !== "queued");
  const canResume = !t.busy && !offline && !blocked;
  return (
    <section className="mb-2 rounded-xl border border-mp-line bg-mp-surface px-3 py-2" aria-label="Message queue">
      <div className="flex min-h-[36px] items-center justify-between gap-2">
        <p className={cx(tone.body, "text-[13px] font-semibold")} role="status">{waiting.length} {waiting.length === 1 ? "message" : "messages"} waiting</p>
        {t.queuePaused && canResume ? <Button size="sm" variant="ghost" onClick={() => t.resumeQueue()}>Resume</Button>
          : !t.queuePaused && !t.awaitingAnswer && !blocked ? <Button size="sm" variant="ghost" onClick={t.pauseQueue}>Pause queue</Button> : null}
      </div>
      {offline ? <p className={cx(tone.faint, "text-[12px]")}>Saved on this device. Reconnect, then resume.</p>
        : t.awaitingAnswer && !blocked ? <div className="flex items-center gap-2"><p className={cx(tone.faint, "min-w-0 flex-1 text-[12px] leading-snug")}>Answer the card above before these messages send.</p><Button size="sm" variant="ghost" disabled={!canResume} onClick={() => t.resumeQueue(true)}>Send next instead</Button></div>
          : t.queuePaused && !blocked ? <p className={cx(tone.faint, "text-[12px]")}>Paused. Review these messages before resuming.</p> : null}
      <div className="max-h-[164px] space-y-2 overflow-y-auto overscroll-contain">
        {waiting.map((item) => <QueuedRow key={item.requestId} item={item} t={t} offline={offline} />)}
      </div>
    </section>
  );
}

function QueuedRow({ item, t, offline }: { item: QueuedMessage; t: ReturnType<typeof useChatThread>; offline: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [reviewedAt] = useState(Date.now);
  const editable = (item.state === "queued" && !item.threadId) || item.state === "failed" || item.state === "cancelled";
  const expired = reviewedAt - Date.parse(item.submittedAt) > 7 * 24 * 60 * 60 * 1000;
  return (
    <div className="border-t border-mp-line pt-2">
      {editing && editable ? <>
        <textarea aria-label="Edit queued message" value={text} onChange={(e) => setText(e.target.value)} maxLength={CHAT_MAX_CHARS} rows={2} className={cx(tone.input, "w-full text-[14px]")} />
        <div className="flex gap-2"><Button size="sm" variant="soft" disabled={!text.trim() || (!!item.threadId && item.state !== "cancelled" && offline)} onClick={async () => { if (await t.editQueued(item.requestId, text)) setEditing(false); }}>Save changes</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Keep original</Button></div>
        {item.problem && <p role="status" className={cx(tone.muted, "text-[12px] leading-snug")}>{item.problem}</p>}
      </> : <>
        <p className={cx(tone.body, "line-clamp-2 text-[13px] leading-snug whitespace-pre-wrap wrap-anywhere")}>{item.text}</p>
        {item.problem && <p role="status" className={cx(tone.muted, "mt-1 text-[12px] leading-snug")}>{item.problem}</p>}
        <div className="flex flex-wrap gap-1">
          {item.state === "uncertain" ? <Button size="sm" variant="ghost" disabled={offline || t.loadingHistory} onClick={t.retryHistory}>Check delivery</Button> : null}
          {item.state === "failed" && !expired ? <Button size="sm" variant="soft" disabled={offline || t.busy} onClick={() => t.retryQueued(item.requestId)}>Retry</Button> : null}
          {editable && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
          {(editable || item.state === "received") && <Button size="sm" variant="ghost" disabled={!!item.threadId && item.state !== "cancelled" && item.state !== "received" && offline} onClick={() => void t.discardQueued(item.requestId)}>{item.state === "received" ? "Dismiss" : "Discard"}</Button>}
        </div>
      </>}
    </div>
  );
}

function ChatActivity({ label, paused }: { label: string; paused: boolean }) {
  return (
    <p className={cx(tone.muted, "flex min-h-[28px] items-center gap-2.5 px-1 text-[14px]")}>
      <span aria-hidden="true" className={cx("flex gap-1 text-mp-accent-fg", !paused && "motion-safe:animate-pulse")}>
        <span className="h-1 w-1 rounded-full bg-current" />
        <span className="h-1 w-1 rounded-full bg-current" />
        <span className="h-1 w-1 rounded-full bg-current" />
      </span>
      {label}
    </p>
  );
}

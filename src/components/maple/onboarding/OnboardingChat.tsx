"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { LIMIT_MESSAGE } from "@/lib/maple/chat/caps";
import { CHAT_MAX_CHARS, CHAT_OFF, type ChatConsent } from "@/lib/maple/chat/types";
import { CHAT_TERMS_HELP, TRACKER_NOTE } from "@/lib/maple/guidelines";
import { ONBOARDING_HISTORY, STEP_TITLES, type OnboardingMessage, type OnboardingRefusal, type Proposal, type StepId } from "@/lib/maple/onboarding/steps";
import { HelpCard } from "../chat/ChatParts";
import { usePageHold } from "../chat/page";
import { refusalOf } from "../chat/stopped";
import { Icon } from "../icons";
import { LegalLinks } from "../Legal";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { latestProposals, proposalState } from "./proposals";
import { answerLine } from "./describe";
import { useSetupFrame } from "./SetupPage";
import type { Onboarding } from "./useOnboarding";

/**
 * Onboarding's chat voice on the setup Chat page: the conversation above the
 * question's card, and the composer in the page's bottom slot. The person can
 * answer in their own words, and each value the model understood comes back
 * as a chip they tap to save (the same POST the card makes). The phone sends
 * only its last few text messages; what's saved comes from the server each
 * turn. Loaded only when the chat is used, so the form never carries the AI SDK.
 */

const textOf = (m: OnboardingMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();

const transport = new DefaultChatTransport<OnboardingMessage>({
  api: "/api/maple/onboarding/chat",
  prepareSendMessagesRequest: ({ messages }) => ({
    body: {
      messages: messages
        .map((m) => ({ role: m.role, text: textOf(m) }))
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
        .slice(-ONBOARDING_HISTORY),
    },
  }),
});

const FALLBACK: readonly string[] = ["form", "off", "limit"];
const STOPPED = "The chat stopped there. Your answers so far are kept; carry on with the card below.";
const UNAVAILABLE = "The chat isn't available right now, so the questions carry on here with buttons.";

export default function OnboardingChat({ ob, onCare, onReview, onFallback }: { ob: Onboarding; onCare: () => void; onReview: () => void; onFallback: (why: string) => void }) {
  const { api, online } = useMaple();
  const [consent, setConsent] = useState<ChatConsent | null>(null);
  const [requestVersions, setRequestVersions] = useState(ob.versions);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const lastSent = useRef<string | null>(null);
  const frame = useSetupFrame();

  useEffect(() => {
    let live = true;
    api<ChatConsent>("/api/maple/chat/consent")
      .then((c) => live && setConsent(c))
      .catch(() => live && setConsent({ terms: false, care: false, self: false }));
    return () => {
      live = false;
    };
  }, [api]);

  const chat = useChat<OnboardingMessage>({
    transport,
    onError: (err) => {
      const refusal = refusalOf(err.message) as OnboardingRefusal | null;
      if (refusal?.code === "terms") setConsent((c) => (c ? { ...c, terms: false } : c));
      if (refusal?.help === "crisis" || (lastSent.current && mentionsCrisis(lastSent.current, [ob.view.values.baby?.name, ob.view.values.baby?.nickname]))) setHelp(true);
      if (refusal?.code && FALLBACK.includes(refusal.code)) return onFallback(refusal.code === "form" ? refusal.error : UNAVAILABLE);
      if (err.message === CHAT_OFF || err.message === LIMIT_MESSAGE) return onFallback(UNAVAILABLE);
      setProblem(refusal?.error ?? STOPPED);
    },
  });
  const busy = chat.status === "submitted" || chat.status === "streaming";

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (!online) return setProblem("Needs a connection. The card below works offline once it's loaded.");
    setProblem(null);
    setHelp(false);
    setDraft("");
    lastSent.current = text;
    setRequestVersions(ob.versions);
    void chat.sendMessage({ text });
  };

  const latest = latestProposals(chat.messages);

  if (!consent) return null;
  if (!consent.terms) return <ChatTerms onAccepted={setConsent} onDecline={() => onFallback("")} />;

  return (
    <>
      <p className={cx(tone.muted, "px-1 text-[15px] leading-relaxed")}>Rather type? Tell me in your own words, like &quot;she came Tuesday around 3am&quot;. You&apos;ll tap to confirm each answer.</p>
      {chat.messages.map((m) => (
        <div key={m.id} className={cx("space-y-2", m.role === "user" && "flex justify-end")}>
          {m.role === "user" ? (
            <p className="max-w-[85%] rounded-2xl bg-mp-accent px-3.5 py-2.5 text-[15px] leading-snug whitespace-pre-wrap text-mp-on-accent wrap-anywhere">{textOf(m)}</p>
          ) : (
            m.parts.map((p, i) => {
              if (p.type === "text") return p.text.trim() ? <p key={i} className={cx(tone.body, "text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere")}>{p.text}</p> : null;
              if (p.type === "data-help") return <HelpCard key={i} reason={p.data.reason} />;
              if (isToolUIPart(p) && p.state === "output-available") return <ProposalChip key={i} p={p.output as Proposal} id={p.toolCallId} latest={latest} requestVersions={requestVersions} ob={ob} onCare={onCare} onReview={onReview} />;
              return null;
            })
          )}
        </div>
      ))}
      {busy && chat.messages.at(-1)?.role === "user" && (
        <p className={cx(tone.muted, "flex items-center gap-2 text-[14px]")} aria-live="polite">
          <Icon name="clock-3" size={16} />
          Thinking…
        </p>
      )}
      {problem && (
        <p role="status" className={cx(tone.inset, "px-3.5 py-3 text-[14px] leading-snug text-mp-ink")}>
          {problem}
        </p>
      )}
      {help && <HelpCard reason="crisis" />}
      <p className={cx(tone.faint, "px-1 text-[13px] leading-snug")}>Answers come from an AI and can be wrong; nothing is saved until you tap it.</p>
      {frame.composer &&
        createPortal(<Composer draft={draft} setDraft={setDraft} send={send} busy={busy} online={online} keyboard={frame.keyboard} />, frame.composer)}
    </>
  );
}

function Composer({
  draft,
  setDraft,
  send,
  busy,
  online,
  keyboard,
}: {
  draft: string;
  setDraft: (text: string) => void;
  send: () => void;
  busy: boolean;
  online: boolean;
  keyboard: boolean;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  usePageHold(true, bar);

  // Grows with what's typed, up to about five lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !window.matchMedia("(pointer: fine)").matches) return;
    e.preventDefault();
    send();
  };

  return (
    <div className="border-t border-mp-line bg-mp-bg" style={{ paddingBottom: keyboard ? 0 : "env(safe-area-inset-bottom)" }}>
      <div ref={bar} className="flex items-end gap-2 px-4 py-2">
        <textarea
          ref={area}
          value={draft}
          rows={1}
          maxLength={CHAT_MAX_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={online ? "Type an answer" : "Needs a connection"}
          aria-label="Message"
          disabled={!online}
          className={cx(tone.input, "min-h-[44px] resize-none rounded-[22px] py-2.5 leading-snug disabled:opacity-60")}
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !draft.trim()}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent transition active:scale-95 disabled:opacity-40"
        >
          <Icon name="arrow-up" size={22} strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );
}

function ProposalChip({ p, id, latest, requestVersions, ob, onCare, onReview }: { p: Proposal; id: string; latest: Partial<Record<StepId, string>>; requestVersions: Partial<Record<StepId, number>>; ob: Onboarding; onCare: () => void; onReview: () => void }) {
  const [saved, setSaved] = useState(false);
  const [issuedVersion] = useState(() => p.ok && "step" in p ? (requestVersions[p.step] ?? 0) : 0);
  if (!p.ok) return null;
  if (p.kind === "help") return <HelpCard reason="crisis" />;
  if (p.kind === "finish") {
    return (
      <Button variant="soft" size="sm" onClick={onReview}>
        Review and start logging
      </Button>
    );
  }
  const step: StepId = p.step;
  const status = proposalState(id, latest[step], issuedVersion, ob.versions[step] ?? 0, saved);
  const tap = async () => {
    if (status !== "pending") return;
    if (p.kind === "answer" && step === "care" && (p.value as { choice?: string }).choice === "me") return onCare();
    const done = p.kind === "skip" ? await ob.skip(step) : await ob.answer(step, p.value);
    if (done) setSaved(true);
  };
  const line = p.kind === "skip" ? `Skip ${STEP_TITLES[step].toLowerCase()} for now` : answerLine(step, p.value);
  return (
    <div className={cx(tone.inset, "flex items-center gap-3 px-3.5 py-2.5")}>
      <div className="min-w-0 flex-1">
        <p className={tone.label}>{STEP_TITLES[step]}</p>
        <p className={cx(tone.body, "text-[15px] font-medium leading-snug wrap-anywhere")}>{line}</p>
      </div>
      {status === "replaced" ? (
        <span className={cx(tone.muted, "text-[13px]")}>Earlier answer</span>
      ) : status === "saved" ? (
        <span className="flex items-center gap-1 text-[14px] font-semibold text-mp-accent-fg">
          <Icon name="check" size={16} />
          Saved
        </span>
      ) : (
        <Button size="sm" onClick={() => void tap()} disabled={ob.busy}>
          {p.kind === "skip" ? "Skip" : "Confirm"}
        </Button>
      )}
    </div>
  );
}

function ChatTerms({ onAccepted, onDecline }: { onAccepted: (c: ChatConsent) => void; onDecline: () => void }) {
  const { api, toast } = useMaple();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      onAccepted(await api<ChatConsent>("/api/maple/chat/consent", { method: "POST", body: JSON.stringify({ terms: true }) }));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="onb-chat-terms" className={cx(tone.card, "space-y-3 p-4")}>
      <h3 id="onb-chat-terms" className={cx(tone.heading, "text-[16px]")}>
        Answer by chat?
      </h3>
      <ul className={cx(tone.body, "list-disc space-y-2 pl-5 text-[15px] leading-relaxed")}>
        <li>{TRACKER_NOTE} The chat&apos;s answers come from an AI and can be wrong, so you confirm each one with a tap.</li>
        <li>{CHAT_TERMS_HELP}</li>
        <li>What you type, and the answers you&apos;ve saved here, are sent to an AI model through Vercel AI Gateway, with zero data retention and no training on it requested.</li>
      </ul>
      <p className={cx(tone.faint, "text-[13px] leading-snug")}>These are the same terms as the app&apos;s Chat tab.</p>
      <LegalLinks className="-ml-2 justify-start" />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void accept()} disabled={busy}>
          {busy ? "Saving…" : "Accept and chat"}
        </Button>
        <Button variant="ghost" onClick={onDecline}>
          Just the questions
        </Button>
      </div>
    </section>
  );
}

"use client";

import { getToolName, isToolUIPart } from "ai";
import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { chatRefusal, emergencySigns, momHelp } from "@/lib/maple/guidelines";
import { careTime } from "@/lib/maple/care";
import { formatTime } from "@/lib/maple/time";
import { chatDisplayText, receiptText } from "@/lib/maple/chat/display";
import { isChatImage } from "@/lib/maple/chat/images";
import type { ChatAlert, ChatMessage, ChatToolOutput, HelpAbout } from "@/lib/maple/chat/types";
import { AlertNote, EMERGENCY_FILL, usePhones } from "../AlertCard";
import { useCareNav } from "../care/CareNav";
import { telHref } from "../care/CareTeam";
import { GROUP, NavRow } from "../care/parts";
import { HelpLines } from "../care/SupportScreen";
import { useVoice } from "../familyWords";
import { Icon, KindBadge } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { chatToolErrorText } from "@/lib/maple/chat/receipts";
import ChatImages from "./ChatImages";
import ChatChart from "./ChatChart";
import ChatReceipt, { CareReceipt } from "./ChatReceipt";
import ChatEntries from "./ChatEntries";
import ChatSetting, { SettingsSummary } from "./ChatSetting";
import ChatNavigation from "./ChatNavigation";
import ChatMemory from "./ChatMemory";
import ChatQuestion, { type AnswerQuestion } from "./ChatQuestion";
import { approvalWords, InviteCard, PEOPLE_APPROVALS, PeopleApproval } from "./ChatPeople";
import ChatWeb from "./ChatWeb";

/**
 * One message in the chat. The person's words sit in a bubble on the right,
 * the reply's text in one on the left, then what the tools did as compact
 * receipts (Undo for an entry this reply added), each health alert as its
 * card word for word, a Delete / Keep card before delete_entry or a delete of
 * hers, an Invite, Change or Remove card before a change to who's in the
 * family (ChatPeople.tsx), and the help card when it's called for. Reasoning
 * and the app's context line are never shown.
 */

type Part = ChatMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** `last`: the newest message, the only one whose approval card can still be answered; `busy`: an answer is coming. */
export function MessageView({ message, threadId, last, busy, onApprove, onAnswerQuestion, onAsk }: { message: ChatMessage; threadId?: string; last: boolean; busy: boolean; onApprove: (id: string, approved: boolean) => void; onAnswerQuestion: AnswerQuestion; onAsk?: (text: string) => void }) {
  if (message.role === "user") {
    const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    const images = message.parts.filter(isChatImage);
    return (
      <div className="flex justify-end pl-10">
        <div className="min-w-0 space-y-2 rounded-[18px] rounded-br-[6px] bg-mp-accent px-3.5 py-2.5 text-mp-on-accent">
          <ChatImages images={images} />
          {text && <p className="text-[16px] leading-snug whitespace-pre-wrap wrap-anywhere">{text}</p>}
        </div>
      </div>
    );
  }
  const alerts = uniqueAlerts(message.parts);
  return (
    <div className="space-y-2.5">
      {message.parts.map((p, i) => {
        if (p.type === "data-help") return <HelpCard key={i} reason={p.data.reason} />;
        if (p.type === "text") {
          const text = chatDisplayText(p.text).trim();
          return text ? (
            <div key={i} className="pr-10">
              <p className={cx(tone.body, "w-fit rounded-[18px] rounded-bl-[6px] border border-(--mp-edge) bg-mp-surface px-3.5 py-2.5 text-[16px] leading-snug whitespace-pre-wrap wrap-anywhere")}>{text}</p>
            </div>
          ) : null;
        }
        if (isToolUIPart(p)) return <ToolView key={p.toolCallId} part={p as ToolPart} threadId={threadId ?? ""} messageId={message.id} last={last} busy={busy} onApprove={onApprove} onAnswerQuestion={onAnswerQuestion} onAsk={onAsk} />;
        return null;
      })}
      {alerts.map((a) => (
        <AlertNote key={`${a.title}|${a.body}`} alert={a.alert} mom={a.mom} />
      ))}
    </div>
  );
}

function uniqueAlerts(parts: Part[]): { title: string; body: string; alert: ChatAlert; mom: boolean }[] {
  const out: { title: string; body: string; alert: ChatAlert; mom: boolean }[] = [];
  for (const p of parts) {
    if (!isToolUIPart(p) || p.state !== "output-available") continue;
    const o = p.output as ChatToolOutput | undefined;
    for (const a of o?.alerts ?? []) {
      if (!out.some((x) => x.title === a.title && x.body === a.body)) out.push({ title: a.title, body: a.body, alert: a, mom: !!o?.mom });
    }
  }
  return out;
}

const Muted = ({ icon, children }: { icon?: "clock-3" | "circle-alert" | "info" | "check" | "globe"; children: React.ReactNode }) => (
  <p className={cx(tone.muted, "flex items-start gap-2 text-[14px] leading-snug")}>
    {icon && <Icon name={icon} size={16} className="mt-0.5 shrink-0" />}
    <span className="min-w-0 wrap-anywhere">{children}</span>
  </p>
);

function ToolView({ part, threadId, messageId, last, busy, onApprove, onAnswerQuestion, onAsk }: { part: ToolPart; threadId: string; messageId: string; last: boolean; busy: boolean; onApprove: (id: string, approved: boolean) => void; onAnswerQuestion: AnswerQuestion; onAsk?: (text: string) => void }) {
  const name = getToolName(part as Parameters<typeof getToolName>[0]);
  if (name === "ask_user") {
    if (part.state === "input-streaming") return null;
    return <ChatQuestion key={part.state} input={part.input} output={"output" in part ? part.output : undefined} toolState={part.state} active={last} busy={busy} onAnswer={(answer) => onAnswerQuestion(part.toolCallId, answer)} />;
  }
  const words = approvalWords(name);
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      // Only while it's running: a search an answer never finished leaves nothing behind.
      return name === "web_search" && last && busy ? <Muted icon="globe">Searching the web…</Muted> : null;
    case "approval-requested":
      if (!last || part.approval.isAutomatic) return <Muted icon="info">{words.idle}</Muted>;
      if (busy) return null;
      if (PEOPLE_APPROVALS.has(name)) return <PeopleApproval name={name} input={part.input} onAnswer={(ok) => onApprove(part.approval.id, ok)} />;
      return <ApprovalCard name={name} input={part.input} onAnswer={(ok) => onApprove(part.approval.id, ok)} />;
    case "approval-responded":
      if (!part.approval.approved) return <Muted icon="info">{words.kept}</Muted>;
      return last && busy ? null : <Muted icon="circle-alert">{words.unknown}</Muted>;
    case "output-denied":
      return <Muted icon="info">{words.kept}</Muted>;
    case "output-error":
      return <Muted icon="circle-alert">That step didn&apos;t finish. Check the log before trying again.</Muted>;
    case "output-available":
      return <OutputView output={part.output as ChatToolOutput} busy={busy} onAsk={onAsk} threadId={threadId} messageId={messageId} toolCallId={part.toolCallId} />;
  }
  return null;
}

function OutputView({ output, busy, onAsk, threadId, messageId, toolCallId }: { output: ChatToolOutput | undefined; busy: boolean; onAsk?: (text: string) => void; threadId: string; messageId: string; toolCallId: string }) {
  if (!output) return null;
  const first = receiptText(output.text.split("\n")[0] ?? "");
  if (!output.ok) return <Muted icon="circle-alert">{chatToolErrorText(output.error, output.write)}</Muted>;
  if (output.setting) return <ChatSetting setting={output.setting} threadId={threadId} messageId={messageId} toolCallId={toolCallId} busy={busy} />;
  if (output.settings) return <SettingsSummary settings={output.settings} />;
  if (output.navigation) return <ChatNavigation navigation={output.navigation} />;
  if (output.entries) return <ChatEntries results={output.entries} disabled={busy} />;
  if (output.chart) return <ChatChart chart={output.chart} onAsk={onAsk} disabled={busy} />;
  if (output.about) return <HelpCard about={output.about} />;
  if (output.invite) return <InviteCard invite={output.invite} />;
  if (output.web) return <ChatWeb web={output.web} />;
  if (!output.write) return null;
  if (output.memory) return <ChatMemory change={output.memory} />;
  if (output.careReceipts?.length) return <div className={GROUP}>{output.careReceipts.map((receipt) => <CareReceipt key={receipt.id} receipt={receipt} />)}</div>;
  if (output.saved?.length) {
    return (
      <div className={cx(GROUP)}>
        {output.saved.map((r) => (
          <ChatReceipt key={r.id} receipt={r} />
        ))}
      </div>
    );
  }
  if (output.duplicateOf != null) return <Muted icon="info">Not saved yet: it looks like an entry already in the log.</Muted>;
  if (output.deleted != null) return <div className={GROUP}><ChatReceipt receipt={{ id: output.deleted, line: first, action: "deleted" }} /></div>;
  return <Muted icon="check">{first}</Muted>;
}

/** Delete / Keep before delete_entry or one of her entries is deleted. */
function ApprovalCard({ name, input, onAnswer }: { name: string; input: unknown; onAnswer: (approved: boolean) => void }) {
  const { state, units, now } = useMaple();
  const [answered, setAnswered] = useState(false);
  const raw = (input ?? {}) as { id?: unknown };
  const tz = state?.baby.timezone ?? "America/New_York";
  let what: React.ReactNode;
  if (name === "delete_entry") {
    const entry = typeof raw.id === "number" ? state?.entries.find((e) => e.id === raw.id) : undefined;
    const d = entry ? describeEntry(entry, { units, now: now() }) : null;
    what = entry ? (
      <div className="flex items-center gap-3">
        <KindBadge entry={entry} />
        <span className="min-w-0">
          <span className={cx(tone.body, "block text-[15px] leading-snug font-medium")}>{d!.title}</span>
          <span className={cx(tone.muted, "block text-[13px] leading-snug")}>{[formatTime(entry.started_at, tz), d!.detail].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
    ) : (
      <p className={cx(tone.body, "text-[15px]")}>The selected entry</p>
    );
  } else {
    const care = state?.care;
    const id = typeof raw.id === "string" ? Number(raw.id.replace(/^c/i, "")) : NaN;
    const e = care?.entries.find((x) => x.id === id);
    const her = care?.person.name ?? "Her";
    const label = !e ? `${her}'s selected entry`
      : e.kind === "dose" || e.kind === "drink" ? `${her}'s ${e.data.name}`
      : e.kind === "food" ? `${her}'s ${e.data.description}`
      : e.kind === "temp" ? `${her}'s temperature` : `${her}'s question for her OB`;
    what = (
      <p className={cx(tone.body, "text-[15px] leading-snug font-medium")}>
        {label}
        {e && <span className={cx(tone.muted, "block text-[13px] font-normal")}>{careTime(e.at, now(), tz)}</span>}
      </p>
    );
  }
  const answer = (ok: boolean) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(ok);
  };
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label="Delete this entry?">
      <p className="text-[13px] font-semibold text-mp-ink-2">Delete this entry?</p>
      {what}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" onClick={() => answer(false)} disabled={answered}>
          Keep
        </Button>
        <Button variant="danger" onClick={() => answer(true)} disabled={answered}>
          Delete
        </Button>
      </div>
    </section>
  );
}

/**
 * The help card. A crisis mention or a declined answer (`reason`), or
 * show_help about anyone or her: 911, 988 and the maternal line. show_help
 * about Maple: her 911 signs, Call 911 and her doctor's numbers.
 */
export function HelpCard({ reason, about }: { reason?: "crisis" | "refusal"; about?: HelpAbout }) {
  const voice = useVoice();
  const help = momHelp(voice);
  const nav = useCareNav();
  const phones = usePhones();
  const numbers = [
    phones.pediatrician && { label: "Pediatrician", phone: phones.pediatrician },
    phones.afterHours && { label: "After hours", phone: phones.afterHours },
  ].filter((n): n is { label: string; phone: string } => !!n);
  const doctor = numbers.length > 0 && (
    <div className={GROUP}>
      {numbers.map((n) => (
        <a key={n.label} href={telHref(n.phone)} className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className={cx(tone.body, "flex-1 text-[15px] font-medium")}>{n.label}</span>
          <span className={cx(tone.muted, "text-[15px] tabular-nums")}>{n.phone}</span>
        </a>
      ))}
    </div>
  );
  const more = (
    <div className={GROUP}>
      <NavRow icon="life-buoy" label="More help" note="Warning signs, help lines and doctor numbers" onClick={nav.openHelp} />
    </div>
  );

  if (about === "maple") {
    return (
      <div className="space-y-2.5">
        <div className={cx(tone.card, "p-4")}>
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-danger">
            <Icon name="siren" size={16} strokeWidth={2} className="shrink-0" />
            When to call 911
          </p>
          <p className={cx(tone.body, "mt-1.5 text-[15px] leading-relaxed")}>{emergencySigns(voice)}</p>
          <a href="tel:911" className={cx("mt-3.5 flex min-h-[52px] items-center justify-center gap-2 rounded-[14px] text-[17px] font-semibold active:scale-[0.98]", EMERGENCY_FILL)}>
            <Icon name="phone" size={20} />
            Call 911
          </a>
        </div>
        {doctor}
        {more}
      </div>
    );
  }
  return (
    <div className="space-y-2.5">
      {reason === "refusal" && <AlertNote alert={chatRefusal(voice)} />}
      <HelpLines lines={[...help.now, help.talk[0]]} />
      {reason === "refusal" && doctor}
      {more}
    </div>
  );
}

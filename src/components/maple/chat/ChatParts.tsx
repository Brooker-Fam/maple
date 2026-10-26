"use client";

import { getToolName, isToolUIPart } from "ai";
import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { CHAT_REFUSAL, EMERGENCY_SIGNS, MOM_HELP } from "@/lib/maple/guidelines";
import { careTime } from "@/lib/maple/care";
import { formatTime } from "@/lib/maple/time";
import type { ChatAlert, ChatMessage, ChatReceipt, ChatToolOutput, HelpAbout } from "@/lib/maple/chat/types";
import { AlertNote, EMERGENCY_FILL, usePhones } from "../AlertCard";
import { useCareNav } from "../care/CareNav";
import { telHref } from "../care/CareTeam";
import { GROUP, NavRow } from "../care/parts";
import { HelpLines } from "../care/SupportScreen";
import { Icon, KindBadge } from "../icons";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * One message in the chat. The person's words sit in a bubble; the reply is
 * plain text, then what the tools did as compact receipts (Undo for an entry
 * this reply added), each health alert as its card word for word, a Delete /
 * Keep card before anything is deleted, and the help card when it's called
 * for. Reasoning and the app's context line are never shown.
 */

type Part = ChatMessage["parts"][number];
type ToolPart = Extract<Part, { toolCallId: string }>;

/** `last`: the newest message, the only one whose approval card can still be answered; `busy`: an answer is coming. */
export function MessageView({ message, last, busy, onApprove }: { message: ChatMessage; last: boolean; busy: boolean; onApprove: (id: string, approved: boolean) => void }) {
  if (message.role === "user") {
    const text = message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    return (
      <div className="flex justify-end pl-10">
        <p className="rounded-[18px] rounded-br-[6px] bg-mp-accent px-3.5 py-2.5 text-[16px] leading-snug whitespace-pre-wrap text-mp-on-accent">{text}</p>
      </div>
    );
  }
  const alerts = uniqueAlerts(message.parts);
  return (
    <div className="space-y-2.5 pr-4">
      {message.parts.map((p, i) => {
        if (p.type === "data-help") return <HelpCard key={i} reason={p.data.reason} />;
        if (p.type === "text") return p.text.trim() ? <p key={i} className={cx(tone.body, "text-[16px] leading-relaxed whitespace-pre-wrap")}>{p.text.trim()}</p> : null;
        if (isToolUIPart(p)) return <ToolView key={p.toolCallId} part={p as ToolPart} last={last} busy={busy} onApprove={onApprove} />;
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

const Muted = ({ icon, children }: { icon?: "clock-3" | "circle-alert" | "info" | "check"; children: React.ReactNode }) => (
  <p className={cx(tone.muted, "flex items-start gap-2 text-[14px] leading-snug")}>
    {icon && <Icon name={icon} size={16} className="mt-0.5 shrink-0" />}
    <span>{children}</span>
  </p>
);

/** "Saved #1234: wet diaper at 3:10 AM today" (the who-and-how tail is the app's own, so it's left off). */
const receiptText = (line: string) => line.replace(/ \((logged|stopped|started) by [^)]*\)\.?$/, "").replace(/\.$/, "");

function ToolView({ part, last, busy, onApprove }: { part: ToolPart; last: boolean; busy: boolean; onApprove: (id: string, approved: boolean) => void }) {
  const name = getToolName(part as Parameters<typeof getToolName>[0]);
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return last && busy ? <Muted icon="clock-3">Working on it…</Muted> : null;
    case "approval-requested":
      if (!last || part.approval.isAutomatic) return <Muted icon="info">Nothing was deleted.</Muted>;
      if (busy) return null;
      return <ApprovalCard name={name} input={part.input} onAnswer={(ok) => onApprove(part.approval.id, ok)} />;
    case "approval-responded":
      return part.approval.approved ? <Muted icon="clock-3">Deleting…</Muted> : <Muted icon="info">Kept. Nothing was deleted.</Muted>;
    case "output-denied":
      return <Muted icon="info">Kept. Nothing was deleted.</Muted>;
    case "output-error":
      return <Muted icon="circle-alert">That step didn&apos;t work, so it changed nothing.</Muted>;
    case "output-available":
      return <OutputView output={part.output as ChatToolOutput} />;
  }
  return null;
}

function OutputView({ output }: { output: ChatToolOutput | undefined }) {
  if (!output) return null;
  if (output.about) return <HelpCard about={output.about} />;
  if (!output.write) return null;
  const first = receiptText(output.text.split("\n")[0] ?? "");
  if (!output.ok) return <Muted icon="circle-alert">{first}</Muted>;
  if (output.saved?.length) {
    return (
      <div className={cx(GROUP)}>
        {output.saved.map((r) => (
          <Receipt key={r.id} receipt={r} />
        ))}
      </div>
    );
  }
  if (output.duplicateOf != null) return <Muted icon="info">Not saved yet: it looks like #{output.duplicateOf}.</Muted>;
  if (output.deleted != null) return <Restorable id={output.deleted} line={first} />;
  return <Muted icon="check">{first}</Muted>;
}

function Receipt({ receipt }: { receipt: ChatReceipt }) {
  const { remove } = useMaple();
  const [undone, setUndone] = useState(false);
  return (
    <div className="flex min-h-[52px] items-center gap-2.5 px-3.5 py-2">
      <Icon name={undone ? "x" : "check"} size={18} strokeWidth={2.25} className={cx("shrink-0", undone ? "text-mp-ink-3" : "text-mp-accent-fg")} />
      <p className={cx(undone ? tone.faint : tone.body, "min-w-0 flex-1 text-[14px] leading-snug", undone && "line-through")}>{receiptText(receipt.line)}</p>
      {!undone && (
        <Button
          size="sm"
          variant="soft"
          onClick={() => {
            setUndone(true);
            void remove(receipt.id, { toast: "Undone" });
          }}
        >
          Undo
        </Button>
      )}
    </div>
  );
}

function Restorable({ id, line }: { id: number; line: string }) {
  const { restore } = useMaple();
  const [back, setBack] = useState(false);
  return (
    <div className={cx(GROUP, "flex min-h-[52px] items-center gap-2.5 px-3.5 py-2")}>
      <Icon name={back ? "check" : "trash-2"} size={18} className="shrink-0 text-mp-ink-2" />
      <p className={cx(tone.body, "min-w-0 flex-1 text-[14px] leading-snug")}>{back ? `Brought back #${id}` : line}</p>
      {!back && (
        <Button
          size="sm"
          variant="soft"
          onClick={() => {
            setBack(true);
            void restore(id);
          }}
        >
          Restore
        </Button>
      )}
    </div>
  );
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
      <p className={cx(tone.body, "text-[15px]")}>Entry #{String(raw.id ?? "")}</p>
    );
  } else {
    const care = state?.care;
    const id = typeof raw.id === "string" ? Number(raw.id.replace(/^c/i, "")) : NaN;
    const e = care?.entries.find((x) => x.id === id);
    const her = care?.person.name ?? "Her";
    const label = !e ? `${her}'s entry ${String(raw.id ?? "")}` : e.kind === "dose" ? `${her}'s ${e.data.name}` : e.kind === "temp" ? `${her}'s temperature` : `${her}'s question for her OB`;
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
          <p className={cx(tone.body, "mt-1.5 text-[15px] leading-relaxed")}>{EMERGENCY_SIGNS}</p>
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
      {reason === "refusal" && <AlertNote alert={CHAT_REFUSAL} />}
      <HelpLines lines={[...MOM_HELP.now, MOM_HELP.talk[0]]} />
      {reason === "refusal" && doctor}
      {more}
    </div>
  );
}

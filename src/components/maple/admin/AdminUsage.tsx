"use client";

import type { AdminFeature, AdminMetrics, AdminSource } from "@/lib/maple/admin/types";
import { Icon, type IconName } from "../icons";
import { Button, cx, tone } from "../ui";
import type { DetailsSelection } from "./AdminDetails";

/**
 * What families use and what they think, on the admin page: counts from
 * admin/usage.ts and the feedback totals. Every number that names families
 * opens their list.
 */

export const FEATURE_LABEL: Record<AdminFeature, string> = {
  feeds: "Feeds",
  diapers: "Diapers",
  sleep: "Sleep",
  pumping: "Pumping",
  growth: "Growth",
  health: "Health checks",
  moments: "Moments",
  notes: "Notes",
  routines: "Tummy time and baths",
  recovery: "Recovery page",
  chat: "Chat",
};

export const SOURCE_LABEL: Record<AdminSource, string> = { app: "The app", chat: "The chat", siri: "Siri", assistant: "Connected assistants", import: "MyChart import" };

const number = new Intl.NumberFormat("en-US");
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;

type Select = (selection: DetailsSelection) => void;

export function Stat({ label, value, onClick }: { label: string; value: number; onClick?: () => void }) {
  const content = (
    <>
      <span className="block text-3xl font-semibold tracking-tight tabular-nums">{number.format(value)}</span>
      <span className="mt-2 flex items-center gap-1 text-sm text-mp-ink-2">
        {label}
        {onClick && <Icon name="chevron-right" size={14} />}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} aria-label={`View ${label.toLowerCase()}`} className="rounded-lg text-left focus-visible:outline-2 focus-visible:outline-mp-focus">
      {content}
    </button>
  ) : (
    <div>{content}</div>
  );
}

function Heading({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <>
      <h2 id={id} className={cx(tone.heading, "text-lg")}>
        {title}
      </h2>
      <p className="mt-1 text-sm text-mp-ink-2">{note}</p>
    </>
  );
}

/** Ratings from Today's question and how much feedback came in, with the way to read it. */
export function FeedbackSummary({ metrics: m, onSelect }: { metrics: AdminMetrics; onSelect: Select }) {
  const f = m.feedback;
  const rated = f.well + f.okay + f.notWell;
  const parts: [string, number, string][] = [
    ["Really well", f.well, "bg-mp-accent"],
    ["Okay", f.okay, "bg-mp-accent/50"],
    ["Not well", f.notWell, "bg-mp-ink-3"],
  ];
  return (
    <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="feedback-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading id="feedback-title" title="What families think" note="Every message sent from the chat, Settings or the question on Today, saved in Maple and emailed to its inbox. Includes the original family's." />
        </div>
        <Button variant="soft" onClick={() => onSelect({ view: "feedback", filter: "all" })}>
          <Icon name="message-square" size={17} /> Read feedback
        </Button>
      </div>
      <div className="mt-5 grid gap-6 sm:grid-cols-[1fr_1fr_2fr] sm:gap-4">
        <Stat label="Messages and answers" value={f.total} onClick={() => onSelect({ view: "feedback", filter: "all" })} />
        <Stat label="In the last 7 days" value={f.last7d} />
        <div>
          <p className="text-sm font-medium text-mp-ink-2">How is Maple working for you?</p>
          {rated ? (
            <>
              <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-mp-sunken" aria-hidden="true">
                {parts.map(([label, n, color]) => (n ? <div key={label} className={color} style={{ width: `${percent(n, rated)}%` }} /> : null))}
              </div>
              <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-mp-ink-2">
                {parts.map(([label, n]) => (
                  <li key={label}>
                    {label} <span className="font-semibold tabular-nums text-mp-ink">{number.format(n)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-2 text-sm text-mp-ink-3">No answers yet. Owners and members are asked once they&apos;ve used Maple for a few days.</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Are they logging: set-up families by days with an entry this week, and the week's totals. */
export function LoggingSection({ metrics: m, onSelect }: { metrics: AdminMetrics; onSelect: Select }) {
  const l = m.usage.logging;
  const families = l.mostDays + l.someDays + l.noDays;
  const parts: [string, number, string][] = [
    ["Most days (4 to 7)", l.mostDays, "bg-mp-accent"],
    ["Some days (1 to 3)", l.someDays, "bg-mp-accent/50"],
    ["Not this week", l.noDays, "bg-mp-ink-3/40"],
  ];
  return (
    <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="logging-title">
      <Heading id="logging-title" title="Logging" note="Set-up families by how many of the last 7 days they saved an entry on." />
      {families ? (
        <>
          <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-mp-sunken" aria-hidden="true">
            {parts.map(([label, n, color]) => (n ? <div key={label} className={color} style={{ width: `${percent(n, families)}%` }} /> : null))}
          </div>
          <ul className="mt-3 grid gap-1 text-sm text-mp-ink-2 sm:grid-cols-3">
            {parts.map(([label, n]) => (
              <li key={label}>
                {label} <span className="font-semibold tabular-nums text-mp-ink">{plural(n, "family", "families")}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm text-mp-ink-3">No families have finished setup yet.</p>
      )}
      <div className="mt-6 grid gap-6 border-t border-mp-line pt-5 sm:grid-cols-3 sm:gap-4">
        <Stat label="Families logging in 7 days" value={l.families7d} onClick={() => onSelect({ view: "families", filter: "logged7d" })} />
        <Stat label="Entries in 7 days" value={l.entries7d} />
        <Stat label="Entries in 30 days" value={m.activity.entries30d} />
      </div>
    </section>
  );
}

/** What they use: families per part of Maple in 30 days, out of those set up. */
export function FeaturesSection({ metrics: m, onSelect }: { metrics: AdminMetrics; onSelect: Select }) {
  const of = Math.max(1, m.families.setupComplete, ...m.usage.features.map((f) => f.families));
  const rows = [...m.usage.features].sort((a, b) => b.families - a.families || b.entries - a.entries);
  return (
    <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="features-title">
      <Heading id="features-title" title="What families use" note={`Families that used each part of Maple in the last 30 days, out of ${plural(m.families.setupComplete, "set-up family", "set-up families")}.`} />
      <ul className="mt-5 grid gap-x-10 gap-y-3.5 lg:grid-cols-2">
        {rows.map((f) => (
          <li key={f.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-mp-ink">{FEATURE_LABEL[f.key]}</span>
              <span className="text-right tabular-nums text-mp-ink-2">
                {plural(f.families, "family", "families")} · {plural(f.entries, f.key === "chat" ? "message" : "entry", f.key === "chat" ? "messages" : "entries")}
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-mp-sunken" aria-hidden="true">
              <div className="h-full rounded-full bg-mp-accent" style={{ width: `${percent(f.families, of)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-relaxed text-mp-ink-3">
        Health checks are temperatures, vitals and medicine. Recovery page counts its entries; chat counts messages sent.{" "}
        <button type="button" onClick={() => onSelect({ view: "families", filter: "all" })} className="font-semibold text-mp-accent-fg">
          See each family&apos;s parts
        </button>
      </p>
    </section>
  );
}

/** How they log, and the chat on its own. */
export function SourcesAndChat({ metrics: m, onSelect }: { metrics: AdminMetrics; onSelect: Select }) {
  const total = m.usage.sources.reduce((n, s) => n + s.entries, 0);
  const c = m.usage.chat;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="sources-title">
        <Heading id="sources-title" title="How entries are added" note="Entries saved in the last 30 days, by where they came from." />
        <ul className="mt-5 divide-y divide-mp-line">
          {m.usage.sources.map((s) => (
            <li key={s.key} className="py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-mp-ink">{SOURCE_LABEL[s.key]}</span>
                <span className="font-semibold tabular-nums text-mp-ink">{percent(s.entries, total)}%</span>
              </div>
              <p className="mt-0.5 text-xs tabular-nums text-mp-ink-3">
                {plural(s.entries, "entry", "entries")} · {plural(s.families, "family", "families")}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="chat-title">
        <Heading id="chat-title" title="The chat" note="Messages people sent to Maple's chat. Deleting chat history doesn't lower these counts." />
        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          <Stat label="Families in 30 days" value={c.families30d} onClick={() => onSelect({ view: "families", filter: "chat30d" })} />
          <Stat label="People in 30 days" value={c.people30d} />
          <Stat label="Messages in 7 days" value={c.messages7d} />
          <Stat label="Messages in 30 days" value={c.messages30d} />
        </div>
      </section>
    </div>
  );
}

/** Features families have switched on now. */
export function TurnedOnSection({ metrics: m }: { metrics: AdminMetrics }) {
  const t = m.usage.turnedOn;
  const items: [IconName, string, number][] = [
    ["bell", "Notifications on a phone", t.notifications],
    ["phone", "Siri shortcuts", t.siri],
    ["heart", "A recovery page", t.recoveryPage],
    ["lightbulb", "Family memories", t.memories],
    ["users", "Two or more adults", t.shared],
  ];
  return (
    <section className={cx(tone.card, "p-5 sm:p-6")} aria-labelledby="turned-on-title">
      <Heading id="turned-on-title" title="Set up now" note="Families with each of these in place today." />
      <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {items.map(([icon, label, n]) => (
          <li key={label} className="flex items-start gap-3">
            <Icon name={icon} size={18} className="mt-1 shrink-0 text-mp-accent-fg" />
            <span>
              <span className="block text-2xl font-semibold tracking-tight tabular-nums">{number.format(n)}</span>
              <span className="text-sm text-mp-ink-2">{label}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

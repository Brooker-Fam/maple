"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { tick } from "@/components/atlas/haptics";
import { feedTotals, openSegment } from "@/lib/maple/feed";
import { VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { alertsOn, type DayStats } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatDuration, formatRelative, formatTime, localParts } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { Entry, FeedData } from "@/lib/maple/types";
import { SIDE_NAME } from "./TimerCard";
import { Segmented, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * "Right now": the 3am answers (when she last ate and which side is next, the
 * last wet and dirty diaper, how long she's been awake, vitamin D) plus "The
 * day so far" tallies and the diaper brigade. Descriptive only: nothing here
 * says "due" or "should".
 */

const ts = (e: { started_at: string }) => Date.parse(e.started_at);
/** Like formatDuration, but "<1m" instead of a ticking "12s". */
const since = (sec: number) => (sec < 60 ? "<1m" : formatDuration(sec));

function sidesLabel(d: FeedData): string {
  const order = (d.segments ?? []).map((s) => s.side).filter((s, i, a) => i === 0 || a[i - 1] !== s);
  if (order.length > 1) return order.slice(0, 3).join("→");
  if (order.length === 1) return `${order[0]} only`;
  if (d.first_side && d.last_side && d.first_side !== d.last_side) return `${d.first_side}→${d.last_side}`;
  if ((d.left_sec ?? 0) > 0 && (d.right_sec ?? 0) > 0) return d.first_side === "R" ? "R→L" : "L→R";
  if ((d.left_sec ?? 0) > 0) return "L only";
  if ((d.right_sec ?? 0) > 0) return "R only";
  return "";
}

/** Median gap between feed starts over the last 24 hours, once there's a day of data. */
function typicalGapMin(entries: Entry[], now: Date): number | null {
  const nowMs = now.getTime();
  const feeds = entries.filter((e) => e.kind === "feed").map(ts).filter((t) => t <= nowMs);
  if (!feeds.length || Math.min(...feeds) > nowMs - 24 * 3600_000) return null;
  const recent = feeds.filter((t) => t >= nowMs - 24 * 3600_000).sort((a, b) => a - b);
  if (recent.length < 4) return null;
  const gaps = recent.slice(1).map((t, i) => (t - recent[i]) / 60_000).sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

function Row({ icon, children, sub, right }: { icon: string; children: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span aria-hidden className="mt-px w-6 shrink-0 text-center text-lg leading-6">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx(tone.body, "text-[15px] leading-6 [.maple-night_&]:text-[#E0A93B]/85")}>{children}</div>
        {sub && <div className={cx(tone.muted, "text-[13px] leading-5 [.maple-night_&]:text-[#E0A93B]/55")}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export default function StatusCard() {
  const { state, summary, log, memberName, readOnly, units, isNight } = useMaple();
  const now = useNow(20_000);
  const [info, setInfo] = useState(false);
  if (!state || !summary) return null;
  const tz = state.baby.timezone ?? DEFAULT_TZ;

  const nursing = summary.active.find((e) => e.kind === "feed");
  const sleeping = summary.active.find((e) => e.kind === "sleep");
  const last = summary.lastFeed;
  const gap = typicalGapMin(state.entries, now);
  const lastSleepEnd = summary.lastSleep && !summary.lastSleep.active ? summary.lastSleep.ended_at : null;
  const hasAnything = state.entries.length > 0;

  if (!hasAnything) return null;

  // The big answer: how long since she last ate (or that she's nursing now).
  let feedLabel = "Last fed";
  let feedBig: React.ReactNode = <span className={cx(tone.muted, "text-base font-normal")}>No feeds logged yet</span>;
  let feedSub: string | null = null;
  if (nursing) {
    // The timer card has the live clock; here, just which side and how long so far.
    const d = nursing.data as FeedData;
    const side = openSegment(d.segments)?.side ?? d.last_side ?? "L";
    const sofar = feedTotals(d, now).total;
    feedLabel = "Nursing now";
    feedBig = `${SIDE_NAME[side]} side`;
    feedSub = `started ${formatTime(nursing.started_at, tz)} · ${sofar < 60 ? "just started" : `${formatDuration(sofar)} so far`}`;
  } else if (last) {
    feedBig = formatRelative(last.started_at, now);
    const bits = [`started ${formatTime(last.started_at, tz)}`];
    if (last.data.method === "bottle") {
      bits.push(last.data.amount_ml ? `${formatVolume(last.data.amount_ml, units)} bottle` : "bottle");
    } else {
      const t = summary.lastFeedTotals;
      if (t?.total) bits.push(formatDuration(t.total));
      const sides = sidesLabel(last.data);
      if (sides) bits.push(sides);
    }
    feedSub = bits.join(" · ");
  }

  const next = !nursing ? summary.nextSide : null;

  const cell = (icon: string, label: string, value: string | null) => (
    <div className="min-w-0 py-2.5">
      <p className={cx(tone.muted, "flex items-center gap-1 text-[12px] font-medium [.maple-night_&]:text-[#E0A93B]/55")}>
        <span aria-hidden className="text-[13px]">
          {icon}
        </span>
        {label}
      </p>
      <p className={cx(tone.body, "mt-0.5 truncate text-[15px] font-semibold tabular-nums [.maple-night_&]:text-[#E0A93B]/85")}>{value ?? "—"}</p>
    </div>
  );

  const logVitD = () => {
    tick();
    void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops ✓", emoji: "☀️" });
  };

  return (
    <section aria-labelledby="right-now" className={cx(tone.card, "px-4 pt-3 pb-1.5 [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#11140F]")}>
      <h2 id="right-now" className={cx(tone.label, "[.maple-night_&]:text-[#E0A93B]/60")}>
        Right now
      </h2>

      {/* Feeding: the most-asked question at 3am, and which side is next. */}
      <div className="pt-2 pb-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="w-6 shrink-0 text-center text-xl">
            {last?.data.method === "bottle" && !nursing ? "🍼" : "🤱"}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cx(tone.muted, "text-[13px] font-medium [.maple-night_&]:text-[#E0A93B]/55")}>{feedLabel}</p>
            <p className="font-[family-name:var(--font-display)] text-[28px] leading-[1.05] font-semibold text-[#1D4420] lining-nums tabular-nums dark:text-[#F5EDDF] [.maple-night_&]:text-[#E0A93B]/85">
              {feedBig}
            </p>
          </div>
          {next && (
            <span
              className="inline-flex shrink-0 flex-col items-center rounded-2xl px-3 py-1.5 text-center leading-tight text-[#3A1A0E] shadow-sm [.maple-night_&]:bg-[#D9772B]/20! [.maple-night_&]:text-[#E8A23F]"
              style={{ backgroundColor: next === "L" ? "#F0B6A6" : "#F3D58F" }}
            >
              <span className="text-[15px] font-bold whitespace-nowrap">
                <span aria-hidden>🍁 </span>
                {SIDE_NAME[next]} side
              </span>
              <span className="text-[11px] font-semibold tracking-wide uppercase opacity-75">next</span>
            </span>
          )}
        </div>
        {feedSub && (
          <p className={cx(tone.muted, "mt-1 flex flex-wrap items-center pl-9 text-[13px] [.maple-night_&]:text-[#E0A93B]/55")}>
            {feedSub}
            {!nursing && (
              <button
                type="button"
                onClick={() => setInfo((v) => !v)}
                aria-expanded={info}
                aria-label="How this is counted"
                className="-my-2 ml-0.5 inline-flex h-9 w-9 items-center justify-center rounded-full text-[13px] hover:bg-[#1D4420]/5"
              >
                ⓘ
              </button>
            )}
          </p>
        )}
        <AnimatePresence>
          {info && (
            <motion.p
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className={cx(tone.muted, "overflow-hidden pl-9 text-[13px] italic")}
            >
              Counted from when she started eating, the usual way feeds are timed.
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Diapers and sleep, side by side. */}
      <div className="grid grid-cols-3 gap-2 border-t border-[#1D4420]/[0.07] pl-9 dark:border-[#F5EDDF]/[0.07]">
        {cell("💧", "Last wet", summary.lastPee ? formatRelative(summary.lastPee.started_at, now) : null)}
        {cell("💩", "Last dirty", summary.lastPoop ? formatRelative(summary.lastPoop.started_at, now) : null)}
        {sleeping
          ? cell("🌙", "Asleep", since((now.getTime() - ts(sleeping)) / 1000))
          : cell("😴", "Awake", lastSleepEnd ? since((now.getTime() - Date.parse(lastSleepEnd)) / 1000) : null)}
      </div>

      <div className="divide-y divide-[#1D4420]/[0.07] border-t border-[#1D4420]/[0.07] dark:divide-[#F5EDDF]/[0.07] dark:border-[#F5EDDF]/[0.07]">
        {/* Drops not given yet is a daytime thing; at 3am it's just clutter (More → Vitamin D still works). */}
        {summary.born &&
          (summary.vitaminD || (!isNight() && alertsOn(state.baby))) &&
          (summary.vitaminD ? (
            <Row icon="☀️" sub="sunshine drops">
              Vitamin D ✓ {formatTime(summary.vitaminD.givenAt, tz)} ({memberName(summary.vitaminD.by)})
            </Row>
          ) : readOnly ? (
            <Row icon="☀️" sub="sunshine drops">
              Vitamin D · not yet today
            </Row>
          ) : (
            <button type="button" onClick={logVitD} className="block w-full rounded-xl text-left transition hover:bg-[#1D4420]/[0.03] active:scale-[0.99] dark:hover:bg-[#F5EDDF]/[0.04]">
              <Row
                icon="☀️"
                sub="sunshine drops · tap when given"
                right={
                  <span className="mt-0.5 shrink-0 rounded-full bg-[#C49A3C]/20 px-3.5 py-1.5 text-sm font-semibold text-[#7A5A12] dark:text-[#E0C27A]">
                    Log
                  </span>
                }
              >
                Vitamin D · not yet today
              </Row>
            </button>
          ))}
        {gap != null && (
          <Row icon="🍂">
            <span className={tone.muted}>
              Lately: about every {formatDuration(gap * 60)} <span className="whitespace-nowrap">(start to start)</span>
            </span>
          </Row>
        )}
      </div>
    </section>
  );
}

// ── The day so far ─────────────────────────────────────────────────────────

export function Tallies() {
  const { state, summary, units } = useMaple();
  const now = useNow(60_000);
  // At 3am "today" is nearly empty and misleading: before 9am show the last 24 hours.
  const [choice, setChoice] = useState<"24h" | "today" | null>(null);
  if (!state || !summary) return null;
  const tz = state.baby.timezone ?? DEFAULT_TZ;
  const mode = choice ?? (localParts(now, tz).hour < 9 ? "24h" : "today");
  const s: DayStats = mode === "24h" ? summary.last24h : summary.today;
  const t = summary.targets;
  const nursingSplit = s.leftSec + s.rightSec > 0 ? Math.round((s.leftSec / (s.leftSec + s.rightSec)) * 100) : null;

  const tiles: { key: string; label: string; emoji: string; value: string; goal: number | null; have: number; color: string }[] = [
    {
      key: "feeds",
      label: "Feeds",
      emoji: "🤱",
      value: String(s.feeds),
      have: s.feeds,
      goal: t ? t.feeds[0] : null,
      color: "#D9772B",
    },
    { key: "wet", label: "Wet", emoji: "💧", value: String(s.wet), have: s.wet, goal: t?.wet ?? null, color: "#7FA7B5" },
    {
      key: "dirty",
      label: "Dirty",
      emoji: "💩",
      value: String(s.dirty),
      have: s.dirty,
      goal: t?.dirty ?? null,
      color: "#8A5A2B",
    },
    {
      key: "tummy",
      label: "Tummy",
      emoji: "🐢",
      value: `${Math.round(s.tummySec / 60)}m`,
      have: s.tummySec / 60,
      goal: t?.tummyMin ?? null,
      color: "#6B8448",
    },
  ];

  const extras = [
    s.sleepSec > 0 && `😴 ${formatDuration(s.sleepSec)} asleep${s.longestSleepSec >= 1800 ? ` · longest ${formatDuration(s.longestSleepSec)}` : ""}`,
    s.nursingSec > 0 && `🤱 ${formatDuration(s.nursingSec)} nursing${nursingSplit != null ? ` (L ${nursingSplit}% · R ${100 - nursingSplit}%)` : ""}`,
    s.bottleMl > 0 && `🍼 ${formatVolume(s.bottleMl, units)} by bottle`,
    s.pumpMl > 0 && `🫙 ${formatVolume(s.pumpMl, units)} pumped`,
  ].filter(Boolean) as string[];

  return (
    <section aria-labelledby="day-so-far">
      <div className="mb-2 flex items-end justify-between gap-2 px-1">
        <h2 id="day-so-far" className={cx(tone.heading, "text-xl [.maple-night_&]:text-[#E0A93B]/85")}>
          The day so far
        </h2>
        <Segmented
          className="w-[172px] shrink-0 scale-95"
          value={mode}
          onChange={(v) => setChoice(v)}
          options={[
            { value: "24h", label: "Last 24h" },
            { value: "today", label: "Today" },
          ]}
        />
      </div>
      <div className={cx(tone.card, "p-3 [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#11140F]")}>
        <div className="grid grid-cols-4 gap-2">
          {tiles.map((x) => {
            const pct = x.goal ? Math.min(1, x.have / x.goal) : 0;
            return (
              <div key={x.key} className={cx(tone.inset, "flex flex-col items-center px-1 pt-2 pb-2 text-center [.maple-night_&]:bg-[#0B0F0A]")}>
                <span aria-hidden className="text-base leading-none">
                  {x.emoji}
                </span>
                <span className="mt-1 font-[family-name:var(--font-display)] text-[28px] leading-none font-semibold text-[#1D4420] lining-nums tabular-nums dark:text-[#F5EDDF] [.maple-night_&]:text-[#E0A93B]/85">
                  {x.value}
                </span>
                <span className={cx(tone.muted, "mt-0.5 text-[12px] font-semibold")}>{x.label}</span>
                {x.goal ? (
                  <span className="mt-1.5 h-1.5 w-full max-w-[56px] overflow-hidden rounded-full bg-[#1D4420]/10 dark:bg-[#F5EDDF]/10" aria-hidden>
                    <span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(pct * 100, 4)}%`, backgroundColor: x.color }} />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {t && (
          <p className={cx(tone.muted, "mt-2 px-1 text-[12px] leading-snug")}>
            For Day {summary.age?.dayOfLife}: usually {t.feeds[0]}–{t.feeds[1]} feeds, {t.wet}+ wet{t.dirty ? `, ${t.dirty}+ dirty` : ""} and about {t.tummyMin} min of tummy time a day.
          </p>
        )}
        {extras.length > 0 && (
          <ul className={cx(tone.body, "mt-2 space-y-0.5 px-1 text-[13px] [.maple-night_&]:text-[#E0A93B]/70")}>
            {extras.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── Diaper brigade ───────────────────────────────────────────────────────

const MEMBER_COLORS = ["#5C7A4A", "#8E7CB0", "#D9772B", "#6FA3B8", "#C49A3C", "#B5452B"];
// Rotates through everyone weekly: a fun title, not a prize for the most changes.
const TITLES = ["Knight of the Changing Table", "Keeper of the Wipes", "Guardian of the Snaps", "Wizard of the Onesie", "Duke of the Diaper Pail"];

export function DiaperBrigade() {
  const { state, summary, memberName } = useMaple();
  const now = useNow(300_000);
  if (!state || !summary || !summary.teamDiapers) return null;
  if ((state.baby.settings as Record<string, unknown>).show_brigade === false) return null;
  const byName = new Map(state.members.map((m, i) => [memberName(m.email), { m, i }]));
  const week = Math.floor(now.getTime() / (7 * 86_400_000));
  const people = summary.duty.map((d, i) => {
    const hit = byName.get(d.who);
    return {
      ...d,
      emoji: hit?.m.emoji ?? "🍁",
      color: hit?.m.color ?? MEMBER_COLORS[(hit?.i ?? i) % MEMBER_COLORS.length],
      title: TITLES[(week + (hit?.i ?? i)) % TITLES.length],
    };
  });
  const credited = people.reduce((a, p) => a + p.diapers, 0);
  const others = summary.teamDiapers - credited;

  return (
    <section aria-labelledby="brigade" className={cx(tone.card, "p-4 [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#11140F]")}>
      <h2 id="brigade" className={cx(tone.heading, "text-lg leading-tight [.maple-night_&]:text-[#E0A93B]/85")}>
        Diaper brigade this week
      </h2>
      <p className={cx(tone.muted, "text-sm")}>
        {summary.teamDiapers} change{summary.teamDiapers === 1 ? "" : "s"} together
      </p>
      <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-[#1D4420]/10 dark:bg-[#F5EDDF]/10" role="img" aria-label={people.map((p) => `${p.who} ${p.diapers}`).join(", ")}>
        {people.map((p) => (
          <span key={p.who} style={{ width: `${(p.diapers / summary.teamDiapers) * 100}%`, backgroundColor: p.color }} className="h-full first:rounded-l-full last:rounded-r-full" />
        ))}
        {others > 0 && <span style={{ width: `${(others / summary.teamDiapers) * 100}%` }} className="h-full bg-[#9AA58F]" />}
      </div>
      <ul className="mt-2.5 space-y-1">
        {people.map((p) => (
          <li key={p.who} className="flex items-center gap-2 text-[13px]">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
            <span className={cx(tone.body, "font-semibold")}>
              {p.who} {p.emoji}
            </span>
            <span className={cx(tone.body, "tabular-nums")}>{p.diapers}</span>
            <span className={cx(tone.muted, "min-w-0 truncate italic")}>· {p.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}


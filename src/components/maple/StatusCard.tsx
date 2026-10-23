"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { tick } from "@/components/atlas/haptics";
import { VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { alertsOn, type DayStats } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatDuration, formatRelative, formatTime, localParts } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { Entry, FeedData, Side } from "@/lib/maple/types";
import { Icon, KindBadge, type IconName } from "./icons";
import { DETAIL_COLOR, KIND_COLOR } from "./palette";
import { SIDE_COLOR, SIDE_NAME, SWITCH_STYLE } from "./TimerCard";
import { Avatar, Segmented, cx, tone } from "./ui";
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

/** A small colored dot, matching the dock's diaper buttons and the day dial. */
function Dot({ color }: { color: string }) {
  return <span aria-hidden className="mp-kind-fill h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/** One of the three "how long since" numbers: the value, with its label underneath. */
function Since({ label, value, mark }: { label: string; value: string | null; mark: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-3 first:pl-4">
      <p className="truncate text-[16px] leading-tight font-semibold tracking-[-0.01em] text-mp-ink tabular-nums">{value ?? "—"}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[12px] font-medium text-mp-ink-2">
        {mark}
        <span className="truncate">{label}</span>
      </p>
    </div>
  );
}

/** The side to offer next: its letter in the side's color, and the name. */
function NextSide({ side }: { side: Side }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-2xl bg-mp-sunken py-2 pr-3.5 pl-2">
      <span
        aria-hidden
        // At night the next-side cue is one of the few things allowed a soft amber glow.
        className="mp-kind-fill inline-flex h-7 w-7 items-center justify-center rounded-full text-[13px] font-bold [.maple-night_&]:shadow-[0_0_14px_rgb(224_169_59/0.4)]"
        style={{ backgroundColor: SIDE_COLOR[side], color: SWITCH_STYLE[side].fg }}
      >
        {side}
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold text-mp-ink">{SIDE_NAME[side]}</span>
        <span className="block text-[11px] text-mp-ink-2">next side</span>
      </span>
    </div>
  );
}

/**
 * The "Right now" card. While she nurses, the timer card above it already has
 * the side, the start and the running clock, so the feed block steps aside
 * and this card keeps only what the timer doesn't say.
 */
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

  // The big answer: how long since she last ate.
  let feedSub: string | null = null;
  if (!nursing && last) {
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

  const logVitD = () => {
    tick();
    void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops logged" });
  };

  // Drops not given yet is a daytime thing; at 3am it's just clutter (More → Vitamin D still works).
  const showVitD = summary.born && (summary.vitaminD || (!isNight() && alertsOn(state.baby)));
  const vitD = summary.vitaminD;
  const vitDText = (
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] font-medium text-mp-ink">Vitamin D</span>
      <span className="block text-[13px] text-mp-ink-2">
        {vitD ? `Given ${formatTime(vitD.givenAt, tz)} · ${memberName(vitD.by)}` : "Not yet today"}
      </span>
    </span>
  );

  return (
    <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
      {/* Feeding: the most-asked question at 3am, and which side is next. */}
      {!nursing && (
        <div className="p-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className={tone.label}>Last fed</p>
              {last ? (
                <p className="mt-0.5 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-mp-ink tabular-nums">
                  {formatRelative(last.started_at, now)}
                </p>
              ) : (
                <p className="mt-0.5 text-[17px] text-mp-ink-2">No feeds logged yet</p>
              )}
            </div>
            {next && <NextSide side={next} />}
          </div>
          {feedSub && (
            <p className="mt-0.5 flex flex-wrap items-center text-[13px] text-mp-ink-2">
              {feedSub}
              <button
                type="button"
                onClick={() => setInfo((v) => !v)}
                aria-expanded={info}
                aria-label="How this is counted"
                className="-my-3 -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-3 active:text-mp-ink-2"
              >
                <Icon name="info" size={15} />
              </button>
            </p>
          )}
          <AnimatePresence>
            {info && (
              <motion.p
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden text-[13px] text-mp-ink-3"
              >
                Counted from when she started eating, the usual way feeds are timed.
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Diapers and sleep, side by side. */}
      <div className="grid grid-cols-3 divide-x divide-mp-line">
        {/* All three are "how long since", so they share one form (and fit a third of a phone). */}
        <Since label="Since pee" mark={<Dot color={DETAIL_COLOR.pee} />} value={summary.lastPee ? since((now.getTime() - ts(summary.lastPee)) / 1000) : null} />
        <Since label="Since poop" mark={<Dot color={DETAIL_COLOR.poop} />} value={summary.lastPoop ? since((now.getTime() - ts(summary.lastPoop)) / 1000) : null} />
        {sleeping ? (
          <Since label="Asleep" mark={<Icon name="moon" size={13} className="mp-kind-ink shrink-0" style={{ color: DETAIL_COLOR.sleep }} />} value={since((now.getTime() - ts(sleeping)) / 1000)} />
        ) : (
          <Since
            label="Awake"
            mark={<Icon name="sun" size={13} className="mp-kind-ink shrink-0" style={{ color: KIND_COLOR.med }} />}
            value={lastSleepEnd ? since((now.getTime() - Date.parse(lastSleepEnd)) / 1000) : null}
          />
        )}
      </div>

      {showVitD &&
        (vitD || readOnly ? (
          <div className="flex items-center gap-3 px-4 py-3">
            <KindBadge icon="sun" color={KIND_COLOR.med} size={32} />
            {vitDText}
          </div>
        ) : (
          <button type="button" onClick={logVitD} aria-label="Vitamin D not given yet today. Log it now" className={cx(tone.row, "py-3")}>
            <KindBadge icon="sun" color={KIND_COLOR.med} size={32} />
            {vitDText}
            <span className="inline-flex min-h-[36px] shrink-0 items-center rounded-[10px] bg-mp-sunken px-3.5 text-sm font-semibold text-mp-ink">Log</span>
          </button>
        ))}
      {gap != null && (
        <div className="flex items-center gap-3 px-4 py-3">
          <span aria-hidden className="flex w-8 shrink-0 justify-center text-mp-ink-3">
            <Icon name="history" size={19} />
          </span>
          <p className="text-[14px] text-mp-ink-2">
            Lately: about every {formatDuration(gap * 60)} <span className="whitespace-nowrap">(start to start)</span>
          </p>
        </div>
      )}
    </div>
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

  // Each count's bar fills toward the usual number for her day of life (the footnote says what that is).
  const tiles: { key: string; label: string; value: string; goal: number | null; have: number; color: string }[] = [
    { key: "feeds", label: "Feeds", value: String(s.feeds), have: s.feeds, goal: t ? t.feeds[0] : null, color: DETAIL_COLOR.nursing },
    { key: "wet", label: "Wet", value: String(s.wet), have: s.wet, goal: t?.wet ?? null, color: DETAIL_COLOR.pee },
    { key: "dirty", label: "Dirty", value: String(s.dirty), have: s.dirty, goal: t?.dirty ?? null, color: DETAIL_COLOR.poop },
    {
      key: "tummy",
      label: "Tummy",
      value: `${Math.round(s.tummySec / 60)}m`,
      have: s.tummySec / 60,
      goal: t?.tummyMin ?? null,
      color: DETAIL_COLOR.tummy,
    },
  ];

  const extras = [
    s.sleepSec > 0 && {
      icon: "moon",
      color: DETAIL_COLOR.sleep,
      label: "Asleep",
      detail: s.longestSleepSec >= 1800 ? `longest ${formatDuration(s.longestSleepSec)}` : null,
      value: formatDuration(s.sleepSec),
    },
    s.nursingSec > 0 && {
      icon: "baby",
      color: DETAIL_COLOR.nursing,
      label: "Nursing",
      detail: nursingSplit != null ? `L ${nursingSplit}% · R ${100 - nursingSplit}%` : null,
      value: formatDuration(s.nursingSec),
    },
    s.bottleMl > 0 && { icon: "bottle", color: DETAIL_COLOR.bottle, label: "By bottle", detail: null, value: formatVolume(s.bottleMl, units) },
    s.pumpMl > 0 && { icon: "milk", color: KIND_COLOR.pump, label: "Pumped", detail: null, value: formatVolume(s.pumpMl, units) },
  ].filter(Boolean) as { icon: IconName; color: string; label: string; detail: string | null; value: string }[];

  return (
    <section aria-labelledby="day-so-far">
      <div className="mb-2 flex items-end justify-between gap-3 px-1">
        <h2 id="day-so-far" className={cx(tone.heading, "text-[17px]")}>
          The day so far
        </h2>
        <Segmented
          className="w-[176px] shrink-0"
          value={mode}
          onChange={(v) => setChoice(v)}
          options={[
            { value: "24h", label: "Last 24h" },
            { value: "today", label: "Today" },
          ]}
        />
      </div>
      <div className={cx(tone.card, "overflow-hidden")}>
        <div className="grid grid-cols-4 divide-x divide-mp-line">
          {tiles.map((x) => {
            const pct = x.goal ? Math.min(1, x.have / x.goal) : 0;
            return (
              <div key={x.key} className="flex flex-col items-center px-1 pt-3.5 pb-3 text-center">
                <span className="text-[28px] leading-none font-semibold tracking-[-0.02em] text-mp-ink tabular-nums">{x.value}</span>
                <span className="mt-1.5 text-[12px] font-medium text-mp-ink-2">{x.label}</span>
                {x.goal ? (
                  <span className="mt-2 h-1 w-10 overflow-hidden rounded-full bg-mp-sunken" aria-hidden>
                    <span
                      className="mp-kind-fill block h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${Math.max(pct * 100, 4)}%`, backgroundColor: x.color }}
                    />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {extras.length > 0 && (
          <ul className="divide-y divide-mp-line border-t border-mp-line">
            {extras.map((x) => (
              <li key={x.label} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
                <Icon name={x.icon} size={17} className="mp-kind-ink shrink-0" style={{ color: x.color }} />
                <span className="min-w-0 flex-1 truncate text-mp-ink">
                  {x.label}
                  {x.detail && <span className="text-mp-ink-3"> · {x.detail}</span>}
                </span>
                <span className="shrink-0 font-semibold text-mp-ink tabular-nums">{x.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {t && (
        <p className="mt-2 px-1 text-[13px] leading-snug text-mp-ink-3">
          For Day {summary.age?.dayOfLife}: usually {t.feeds[0]}–{t.feeds[1]} feeds, {t.wet}+ wet{t.dirty ? `, ${t.dirty}+ dirty` : ""} and about {t.tummyMin} min of tummy time a day.
        </p>
      )}
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
      member: hit?.m ?? null,
      color: hit?.m.color ?? MEMBER_COLORS[(hit?.i ?? i) % MEMBER_COLORS.length],
      title: TITLES[(week + (hit?.i ?? i)) % TITLES.length],
    };
  });
  const credited = people.reduce((a, p) => a + p.diapers, 0);
  const others = summary.teamDiapers - credited;

  return (
    <section aria-labelledby="brigade" className={cx(tone.card, "p-4")}>
      <h2 id="brigade" className={cx(tone.heading, "text-[17px] leading-tight")}>
        Diaper brigade this week
      </h2>
      <p className="mt-0.5 text-[13px] text-mp-ink-2">
        {summary.teamDiapers} change{summary.teamDiapers === 1 ? "" : "s"} together
      </p>
      <div className="mt-3 flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-mp-sunken" role="img" aria-label={people.map((p) => `${p.who} ${p.diapers}`).join(", ")}>
        {people.map((p) => (
          <span key={p.who} style={{ width: `${(p.diapers / summary.teamDiapers) * 100}%`, backgroundColor: p.color }} className="mp-kind-fill h-full" />
        ))}
        {others > 0 && <span style={{ width: `${(others / summary.teamDiapers) * 100}%` }} className="h-full bg-mp-ink/15" />}
      </div>
      <ul className="mt-3 space-y-2">
        {people.map((p) => (
          <li key={p.who} className="flex items-center gap-2.5 text-[14px]">
            <span aria-hidden className="mp-kind-fill h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="shrink-0 font-semibold text-mp-ink">{p.who}</span>
            {p.member?.emoji && <Avatar member={p.member} size={18} />}
            <span className="min-w-0 flex-1 truncate text-[13px] text-mp-ink-3">{p.title}</span>
            <span className="shrink-0 font-semibold text-mp-ink tabular-nums">{p.diapers}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

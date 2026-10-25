"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { tick } from "@/components/atlas/haptics";
import { VITAMIN_D_DEFAULT } from "@/lib/maple/guidelines";
import { LAST_FED_RULE, minutesShort, spanText, typicalFeedGapMin, type NextSide as NextSideInfo, type NursingRun } from "@/lib/maple/feed";
import { alertsOn, type DayStats, type Summary } from "@/lib/maple/insights";
import { DEFAULT_TZ, formatDuration, formatRelative, formatTime } from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { Side, StretchSide } from "@/lib/maple/types";
import { Icon, KindBadge, type IconName } from "./icons";
import { useNightActive } from "./nightLook";
import { DETAIL_COLOR, KIND_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { useClusterInfo } from "./sheets/ClusterInfoSheet";
import { SIDE_COLOR, SIDE_NAME, SWITCH_STYLE } from "./TimerCard";
import { Avatar, cx, memberColor, tone } from "./ui";
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

/**
 * The sides of her last feed (a run: Pauses and Dones under 10 minutes
 * apart are one feed) in the order she nursed: "Right only", "Left then
 * Right", "Left, Right, then Left"; past three, just the first and the last
 * she ended on ("Left first, ended on Right"), never a cut-off list that
 * names the wrong last side. Back and forth reads "Right first, then back
 * and forth" (or "…, back and forth, ended on Left"): the side she started
 * on is the start tap's, even when it went both sides at once.
 */
export function sidesLabel(run: Pick<NursingRun, "order" | "firstSide">): string {
  const order = run.order;
  if (!order.length) return "";
  if (order.includes("B")) {
    const first = isSide(order[0]) ? order[0] : run.firstSide;
    const end = order[order.length - 1];
    const lead = first ? `${SIDE_NAME[first]} first, ` : "";
    if (!isSide(end)) return first ? `${lead}then back and forth` : "Back and forth";
    return first ? `${lead}back and forth, ended on ${SIDE_NAME[end]}` : `Back and forth, ended on ${SIDE_NAME[end]}`;
  }
  const sides = order as Side[];
  return sides.length === 1
    ? `${SIDE_NAME[sides[0]]} only`
    : sides.length === 2
      ? `${SIDE_NAME[sides[0]]} then ${SIDE_NAME[sides[1]]}`
      : sides.length === 3
        ? `${SIDE_NAME[sides[0]]}, ${SIDE_NAME[sides[1]]}, then ${SIDE_NAME[sides[2]]}`
        : `${SIDE_NAME[sides[0]]} first, ended on ${SIDE_NAME[sides[sides.length - 1]]}`;
}

const isSide = (s: StretchSide | null | undefined): s is Side => s === "L" || s === "R";

/** A typical gap, rounded the way you'd say it: to 15 minutes under two hours, then to the half hour ("~3h", "~1h 45m"). */
function roughGap(min: number): string {
  const step = min < 120 ? 15 : 30;
  const r = Math.max(step, Math.round(min / step) * step);
  const h = Math.floor(r / 60);
  const m = r % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
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

/** The side to offer next: its letter in the side's color, and the name (after back and forth, "or the fuller side"). */
function NextSide({ next }: { next: NextSideInfo }) {
  const side = next.side;
  return (
    // relative: above the Last fed block's button, so a tap here isn't taken for "open the last feed".
    <div className="relative flex shrink-0 items-center gap-2 rounded-2xl bg-mp-sunken py-2 pr-3.5 pl-2">
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
        {/* "or fuller side" (not "or the fuller side"): the pill has to fit beside "12h 45m ago" at 375px. */}
        <span className="block text-[11px] text-mp-ink-2">
          {next.fuller ? (
            <>
              <span className="sr-only">next side, </span>or fuller side
            </>
          ) : (
            "next side"
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * The "Right now" card. While she nurses, the timer card above it already has
 * the side, the start and the running clock, so the feed block steps aside
 * and this card keeps only what the timer doesn't say. Her mom's medicines
 * aren't here: they're on the strip on top of the dock (care/CareLine).
 */
export default function StatusCard() {
  const { state, summary, log, memberLabel, readOnly, units, isNight } = useMaple();
  const { open } = useSheets();
  const now = useNow(20_000);
  const [info, setInfo] = useState(false);
  const clusterInfo = useClusterInfo();
  if (!state || !summary) return null;
  const tz = state.baby.timezone ?? DEFAULT_TZ;

  const nursing = summary.active.find((e) => e.kind === "feed");
  const sleeping = summary.active.find((e) => e.kind === "sleep");
  // Her last feed as counted (Pauses and Dones under 10 minutes apart are one feed); the newest entry in it opens.
  const fed = summary.lastFed;
  const last = fed?.entry ?? summary.lastFeed;
  // "Last fed … ago" counts from fed.at: the feed's start, or 40 minutes before a long back-and-forth one ended.
  const fedAt = fed?.at ?? last?.started_at ?? null;
  // Gaps inside a cluster are skipped, so an evening of clustering doesn't read "usually every ~45m".
  const gap = typicalFeedGapMin(state.entries, now);
  const cluster = fed?.kind === "breast" && fed.run?.cluster != null ? summary.cluster : null;
  const lastSleepEnd = summary.lastSleep && !summary.lastSleep.active ? summary.lastSleep.ended_at : null;
  const hasAnything = state.entries.length > 0;

  // Nothing of Maple's logged yet (her mom's medicines ride on the dock's strip).
  if (!hasAnything) return null;

  // The big answer: how long since she last ate.
  let feedSub: string[] | null = null;
  if (!nursing && last) {
    const bits: string[] = [];
    if (cluster) {
      // "Cluster 6:02–8:40 PM · 4 feeds · nursed 1h 52m" ("Cluster" opens the Cluster feeding sheet).
      bits.push(`${spanText(cluster.start, cluster.end, tz)}`, `${cluster.feeds} feeds`, `nursed ${minutesShort(cluster.min.total)}`);
    } else if (last.data.method === "bottle" || !fed?.run) {
      bits.push(`started ${formatTime(last.started_at, tz)}`);
      if (last.data.method === "bottle") bits.push(last.data.amount_ml ? `${formatVolume(last.data.amount_ml, units)} bottle` : "bottle");
    } else {
      const run = fed.run;
      bits.push(`started ${formatTime(run.start, tz)}`);
      if (run.min.total) bits.push(minutesShort(run.min.total));
      const sides = sidesLabel(run);
      if (sides) bits.push(sides);
    }
    if (gap != null) bits.push(`usually every ~${roughGap(gap)}`);
    feedSub = bits;
  }

  const next = !nursing ? summary.next : null;
  // A sleep (or tummy or pump) timer above this card on a short phone: the Last fed block keeps its answer and the next
  // side but folds its details, so the Since tiles still clear the dock (and her strip on it) at 375x667.
  const fold = summary.active.length > 0;

  const logVitD = () => {
    tick();
    void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops logged" });
  };

  // Drops not given yet is a daytime thing; at 3am it's just clutter (More → Vitamin D still works).
  const showVitD = summary.born && (summary.vitaminD || (!isNight() && alertsOn(state.baby)));
  const vitD = summary.vitaminD;
  // Never "Admin": the name only when it's someone else we can name.
  const vitDBy = vitD ? (vitD.by === state.me.email ? "you" : memberLabel(vitD.by)) : null;
  const vitDText = (
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] font-medium text-mp-ink">Vitamin D</span>
      <span className="block text-[13px] text-mp-ink-2">
        {vitD ? `Given ${formatTime(vitD.givenAt, tz)}${vitDBy ? ` · ${vitDBy}` : ""}` : "Not yet today"}
      </span>
    </span>
  );

  return (
    <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
      {/* Feeding: the most-asked question at 3am, and which side is next. */}
      {!nursing && (
        <div className={cx("relative p-4", fold && "[@media(max-height:719px)]:py-2.5")}>
          {last && (
            // The whole block opens that feed, so a wrong Done is fixed right where its wrong number shows. It lies
            // over the text; the next side and the info button sit above it.
            <button
              type="button"
              onClick={() => open({ kind: "feed", entry: last })}
              aria-label={`Last fed ${formatRelative(fedAt ?? last.started_at, now)}, started ${formatTime(fed?.start ?? last.started_at, tz)}. ${readOnly ? "Open that feed." : "Open that feed to fix it."}`}
              className="absolute inset-0 transition active:bg-mp-ink/[0.04]"
            />
          )}
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className={cx(tone.label, "flex items-center gap-0.5")}>
                Last fed
                {last && <Icon name="chevron-right" size={14} className="text-mp-ink-3" />}
              </p>
              {last ? (
                <p className={cx("mt-0.5 text-[28px] leading-tight font-semibold tracking-[-0.02em] text-mp-ink tabular-nums", fold && "[@media(max-height:719px)]:text-[24px]")}>
                  {formatRelative(fedAt ?? last.started_at, now)}
                </p>
              ) : (
                <p className="mt-0.5 text-[17px] text-mp-ink-2">No feeds logged yet</p>
              )}
            </div>
            {next && <NextSide next={next} />}
          </div>
          {feedSub && (
            <p className={cx("mt-0.5 text-[13px] leading-snug text-mp-ink-2", fold && "[@media(max-height:719px)]:hidden")}>
              {cluster && (
                // Above the block's button: "Cluster" opens what cluster feeding is, not the last feed.
                <>
                  <button
                    type="button"
                    onClick={() => clusterInfo.open(cluster)}
                    aria-label="Cluster feeding: what it is"
                    className="relative -my-3 inline-flex min-h-[44px] items-center font-semibold text-mp-ink underline decoration-mp-ink-3 decoration-dotted underline-offset-[3px] active:text-mp-ink-2"
                  >
                    Cluster
                  </button>{" "}
                </>
              )}
              {feedSub.slice(0, -1).map((b) => `${b} · `).join("")}
              {/* The info button rides with the last bit, so a wrap never leaves it alone on a line. */}
              <span className="whitespace-nowrap">
                {feedSub[feedSub.length - 1]}
                <button
                  type="button"
                  onClick={() => setInfo((v) => !v)}
                  aria-expanded={info}
                  aria-label="How this is counted"
                  className="relative -my-3 -mr-3 inline-flex h-11 w-11 items-center justify-center rounded-full align-middle text-mp-ink-3 active:text-mp-ink-2"
                >
                  <Icon name="info" size={15} />
                </button>
              </span>
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
                {LAST_FED_RULE}
                {gap != null && <> Lately: about every {formatDuration(gap * 60)} (start to start).</>}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Diapers and sleep, side by side (no rules between them: the columns already line up). */}
      <div>
        <div className="grid grid-cols-3">
          {/* All three are "how long since", so they share one form (and fit a third of a phone). The marks are the dock's. */}
          <Since
            label="Since pee"
            mark={<Icon name="droplet" size={14} strokeWidth={2} className="mp-kind-ink shrink-0" style={{ color: DETAIL_COLOR.pee }} />}
            value={summary.lastPee ? since((now.getTime() - ts(summary.lastPee)) / 1000) : null}
          />
          <Since
            label="Since poop"
            mark={<Icon name="poop" size={14} strokeWidth={2} className="mp-kind-ink shrink-0" style={{ color: DETAIL_COLOR.poop }} />}
            value={summary.lastPoop ? since((now.getTime() - ts(summary.lastPoop)) / 1000) : null}
          />
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
        {/*
          While she nurses the "Last fed" line (which carries this) steps aside, so it rides under the tiles as one slim
          line, in the tiles' own bottom padding: at 375x667 with a feed of several parts it still clears the dock (and
          her strip on it) without pushing the tiles down.
        */}
        {nursing && gap != null && (
          <p className="-mt-1.5 flex items-center gap-1.5 px-4 pb-2.5 text-[12px] leading-4 text-mp-ink-2">
            <Icon name="history" size={13} className="shrink-0 text-mp-ink-3" />
            <span className="min-w-0">
              Lately: about every {formatDuration(gap * 60)} <span className="whitespace-nowrap">(start to start)</span>
            </span>
          </p>
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
      {clusterInfo.sheet}
    </div>
  );
}

// ── The day so far ─────────────────────────────────────────────────────────

type Targets = NonNullable<Summary["targets"]>;

/**
 * The counts for whatever range the day dial shows (the dial owns the one
 * range control and passes the numbers down), so each number appears once.
 */
export function Tallies({
  stats: s,
  title,
  targets: t,
  targetDay,
  loading,
}: {
  stats: DayStats;
  /** What the range is: "Last 24 hours", "The day so far", "Yesterday", "Tuesday, Oct 20". */
  title: string;
  /** The usual numbers per 24 hours for her day of life (null while warnings are off). */
  targets: Targets | null;
  targetDay: number | null;
  /** An older day still on its way from the server. */
  loading?: boolean;
}) {
  const { state, units } = useMaple();
  if (!state) return null;
  // The Left/Right split leaves out back and forth (never split into made-up sides); "both" says how much there was.
  const nursingSplit = s.leftSec + s.rightSec > 0 ? Math.round((s.leftSec / (s.leftSec + s.rightSec)) * 100) : null;
  const split = nursingSplit != null ? `L ${nursingSplit}% · R ${100 - nursingSplit}%` : null;
  const both = s.bothSec >= 60 ? `both ${formatDuration(s.bothSec)}` : null;

  // Each count's bar fills toward the usual number for her day of life (the footnote says what that is).
  // Feeds count each feed in a cluster (split by 10+ minutes off the breast): "11 · 4 in a cluster".
  const tiles: { key: string; label: string; value: string; goal: number | null; have: number; color: string; note?: string; aria?: string }[] = [
    {
      key: "feeds",
      label: "Feeds",
      value: String(s.feeds),
      have: s.feeds,
      goal: t ? t.feeds[0] : null,
      color: DETAIL_COLOR.nursing,
      note: s.clusterFeeds ? `${s.clusterFeeds} in a cluster` : undefined,
      aria: s.clusterFeeds ? `${s.feeds} feeds, ${s.clusterFeeds} in a cluster` : undefined,
    },
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
      detail: both ? null : split,
      // With back and forth the split and "both" get their own line (one line truncates at 375px).
      below: both ? [split, both].filter(Boolean).join(" · ") : null,
      value: formatDuration(s.nursingSec),
    },
    s.bottleMl > 0 && { icon: "bottle", color: DETAIL_COLOR.bottle, label: "By bottle", detail: null, value: formatVolume(s.bottleMl, units) },
    s.pumpMl > 0 && { icon: "milk", color: KIND_COLOR.pump, label: "Pumped", detail: null, value: formatVolume(s.pumpMl, units) },
  ].filter(Boolean) as { icon: IconName; color: string; label: string; detail: string | null; below?: string | null; value: string }[];

  return (
    <section aria-labelledby="day-so-far" aria-busy={loading || undefined}>
      <div className="mb-2 flex min-h-[28px] items-center justify-between gap-3 px-1">
        <h2 id="day-so-far" className={cx(tone.heading, "text-[17px]")}>
          {title}
        </h2>
      </div>
      <div className={cx(tone.card, "overflow-hidden", loading && "opacity-60")}>
        <div className="grid grid-cols-4">
          {tiles.map((x) => {
            const pct = x.goal ? Math.min(1, x.have / x.goal) : 0;
            return (
              <div key={x.key} className="flex flex-col items-center px-1 pt-3.5 pb-3 text-center" aria-label={!loading && x.aria ? x.aria : undefined} role={!loading && x.aria ? "group" : undefined}>
                <span className="text-[28px] leading-none font-semibold tracking-[-0.02em] text-mp-ink tabular-nums">{loading ? "–" : x.value}</span>
                <span className="mt-1.5 text-[12px] font-medium text-mp-ink-2">{x.label}</span>
                {x.goal ? (
                  <span className="mt-2 h-1 w-10 overflow-hidden rounded-full bg-mp-sunken" aria-hidden>
                    <span
                      className="mp-kind-fill block h-full rounded-full transition-[width] duration-500"
                      style={{ width: `${loading ? 0 : Math.max(pct * 100, 4)}%`, backgroundColor: x.color }}
                    />
                  </span>
                ) : null}
                {/* Under the bar, so the bars still line up across the row. */}
                {x.note && !loading && <span className="mt-1.5 text-[11px] leading-tight text-mp-ink-3">{x.note}</span>}
              </div>
            );
          })}
        </div>
        {extras.length > 0 && !loading && (
          <ul className="divide-y divide-mp-line border-t border-mp-line">
            {extras.map((x) => (
              <li key={x.label} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
                <Icon name={x.icon} size={17} className="mp-kind-ink shrink-0" style={{ color: x.color }} />
                <span className="min-w-0 flex-1 text-mp-ink">
                  <span className="block truncate">
                    {x.label}
                    {x.detail && <span className="text-mp-ink-3"> · {x.detail}</span>}
                  </span>
                  {x.below && <span className="block truncate text-[13px] text-mp-ink-3">{x.below}</span>}
                </span>
                <span className="shrink-0 font-semibold text-mp-ink tabular-nums">{x.value}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {t && (
        <p className="mt-2 px-1 text-[13px] leading-snug text-mp-ink-3">
          For Day {targetDay}: usually {t.feeds[0]}–{t.feeds[1]} feeds, {t.wet}+ wet{t.dirty ? `, ${t.dirty}+ dirty` : ""} and about {t.tummyMin} min of tummy time a day.
        </p>
      )}
    </section>
  );
}

// ── Diaper brigade ───────────────────────────────────────────────────────

/**
 * The family's shared number this week, a thin bar of who did them, and each
 * person's own count in family order (with how many were after dark, 10pm–6am).
 * Real names and real counts, nothing to win. A daytime thing: it stays away at night.
 */
export function DiaperBrigade() {
  const { state, summary, memberName, isNight } = useMaple();
  const nightLook = useNightActive();
  if (!state || !summary || !summary.teamDiapers) return null;
  if ((state.baby.settings as Record<string, unknown>).show_brigade === false) return null;
  if (nightLook || isNight()) return null;
  const byName = new Map(state.members.map((m, i) => [memberName(m.email), { m, i }]));
  const people = summary.duty
    .map((d, i) => {
      const hit = byName.get(d.who);
      // Family order (as on the Family tab), not by count; anyone no longer a member goes last.
      return { ...d, member: hit?.m ?? null, order: hit ? hit.i : state.members.length + i, color: memberColor(hit?.m ?? null, state.members) };
    })
    .sort((a, b) => a.order - b.order);
  const credited = people.reduce((a, p) => a + p.diapers, 0);
  const others = summary.teamDiapers - credited;
  const changes = `${summary.teamDiapers} change${summary.teamDiapers === 1 ? "" : "s"}`;

  return (
    <section aria-labelledby="brigade" className={cx(tone.card, "px-4 py-3")}>
      <h2 id="brigade" className="sr-only">
        Diaper changes this week
      </h2>
      <p className="text-[14px] text-mp-ink-2">
        <span className="font-semibold text-mp-ink tabular-nums">{changes}</span> this week
      </p>
      {/* The bar only repeats the numbers below, so it's hidden from screen readers. */}
      <div className="mt-2 flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full bg-mp-sunken" aria-hidden>
        {people.map((p) => (
          <span key={p.who} style={{ width: `${(p.diapers / summary.teamDiapers) * 100}%`, backgroundColor: p.color }} className="h-full" />
        ))}
        {others > 0 && <span style={{ width: `${(others / summary.teamDiapers) * 100}%` }} className="h-full bg-mp-ink/15" />}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-mp-ink-2">
        {people.map((p) => (
          <span key={p.who} className="inline-flex items-center gap-1.5">
            {p.member && <Avatar member={p.member} size={16} />}
            <span>
              <span className="text-mp-ink">{p.who}</span> <span className="font-semibold text-mp-ink tabular-nums">{p.diapers}</span>
              {p.night > 0 && <span className="text-mp-ink-3 tabular-nums"> · {p.night} after dark</span>}
            </span>
          </span>
        ))}
        {others > 0 && (
          <span>
            Others <span className="font-semibold text-mp-ink tabular-nums">{others}</span>
          </span>
        )}
      </p>
    </section>
  );
}

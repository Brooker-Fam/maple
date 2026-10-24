"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { statsFor, type DayStats } from "@/lib/maple/insights";
import {
  DEFAULT_TZ,
  addDays,
  dayBounds,
  dayKey,
  daysBetween,
  formatDayLabel,
  formatDuration,
  formatRelative,
  formatTime,
} from "@/lib/maple/time";
import { formatVolume } from "@/lib/maple/units";
import type { Entry, EntryKind, MapleState, UnitSystem } from "@/lib/maple/types";
import EntryRow from "./EntryRow";
import { Icon, KIND_ICON, KindBadge } from "./icons";
import { KIND_COLOR } from "./palette";
import { useSheets } from "./sheets";
import { Button, Chip, EmptyState, SectionTitle, Sheet, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * Timeline (the "Log" tab): every entry, day by day, newest first. History
 * comes from /api/maple/entries a week at a time and is merged with the live
 * snapshot, so what either parent logs shows up here immediately. Tap a row
 * to edit it (the edit sheet also deletes).
 *
 * Also home to a few helpers Patterns shares: kind groups, the live merge,
 * the day summary line and DST labels.
 */

const H = 3600_000;
const PAGE_DAYS = 7;
/** /api/maple/entries refuses longer spans. */
const MAX_SPAN_DAYS = 400;
/** /api/maple/state carries the last 72 hours; inside that window it's the source of truth. */
const LIVE_WINDOW_MS = 72 * H;

// ── Shared helpers (also used by PatternsTab) ────────────────────────────

export type KindGroup = "all" | "feeds" | "diapers" | "sleep" | "health" | "other";

export const KIND_GROUPS: { id: KindGroup; label: string }[] = [
  { id: "all", label: "All" },
  { id: "feeds", label: "Feeds" },
  { id: "diapers", label: "Diapers" },
  { id: "sleep", label: "Sleep" },
  { id: "health", label: "Health" },
  { id: "other", label: "Other" },
];

const GROUP_OF: Partial<Record<EntryKind, KindGroup>> = {
  feed: "feeds",
  pump: "feeds",
  diaper: "diapers",
  sleep: "sleep",
  growth: "health",
  temp: "health",
  vitals: "health",
  med: "health",
};

/** Filter group for a kind; anything new (notes, baths, moments…) lands in Other. */
export const groupOf = (kind: EntryKind): KindGroup => GROUP_OF[kind] ?? "other";

const byNewest = (a: Entry, b: Entry) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;

/**
 * History plus the live snapshot, newest first. Inside the snapshot's window
 * the snapshot wins (so optimistic logs, edits and deletes show instantly);
 * older days come from the fetched history.
 */
export function mergeLive(history: Entry[], state: MapleState): Entry[] {
  const liveFrom = Date.parse(state.now) - LIVE_WINDOW_MS + 5 * 60_000;
  const byId = new Map<number, Entry>();
  for (const e of history) {
    if (e.active || Date.parse(e.ended_at ?? e.started_at) >= liveFrom) continue;
    byId.set(e.id, e);
  }
  for (const e of state.entries) byId.set(e.id, e);
  return [...byId.values()].sort(byNewest);
}

// History is cached in fixed Monday–Sunday weeks, so paging back or switching
// ranges only fetches weeks we don't have, and cache keys survive midnight.
const CHUNK_DAYS = 7;
const CHUNK_EPOCH = "2024-01-01"; // a Monday
/** Weeks this close to today are refetched whenever anything changes (rev moves). */
const RECENT_DAYS = 14;
/** Older weeks are refreshed on a change at most this often (edits there are rare). */
const STALE_MS = 5 * 60_000;
const PAGE_LIMIT = 5000;
const PARALLEL = 4;

const chunkOf = (key: string) => Math.floor(daysBetween(CHUNK_EPOCH, key) / CHUNK_DAYS);
const chunkFrom = (i: number) => addDays(CHUNK_EPOCH, i * CHUNK_DAYS);

type Chunk = { entries: Entry[]; at: number; rev: string | undefined; partialDays: string[] };

type Api = <T = unknown>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Every entry overlapping local days [from, to]. If the server says it hit its
 * row cap, the range is split and each half paged, down to single days; a day
 * that still overflows keeps its newest rows and is reported in partialDays.
 */
export async function fetchRange(api: Api, from: string, to: string): Promise<{ entries: Entry[]; partialDays: string[] }> {
  const res = await api<{ entries: Entry[]; truncated?: boolean }>(`/api/maple/entries?from=${from}&to=${to}&limit=${PAGE_LIMIT}`);
  const truncated = res.truncated ?? res.entries.length >= PAGE_LIMIT;
  if (!truncated) return { entries: res.entries, partialDays: [] };
  if (from === to) return { entries: res.entries, partialDays: [from] };
  const mid = addDays(from, Math.floor(daysBetween(from, to) / 2));
  const [a, b] = await Promise.all([fetchRange(api, from, mid), fetchRange(api, addDays(mid, 1), to)]);
  return { entries: [...a.entries, ...b.entries], partialDays: [...a.partialDays, ...b.partialDays] };
}

/**
 * Entries for local days [fromKey, toKey], merged with live state. Only weeks
 * not yet loaded are fetched; when the server's change token (state.rev)
 * moves, recent weeks refresh (older ones at most every few minutes), and the
 * previous data stays on screen meanwhile.
 */
export function useEntryRange(fromKey: string, toKey: string) {
  const { api, state } = useMaple();
  const [chunks, setChunks] = useState<Map<number, Chunk>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fails, setFails] = useState(0);
  const inflight = useRef(new Set<number>());
  /** Weeks holding an entry someone opened (and may have edited or deleted): refresh on the next change. */
  const dirty = useRef(new Set<number>());
  const mounted = useRef(true);
  const rev = state?.rev;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const first = chunkOf(fromKey);
  const last = chunkOf(toKey);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    const recent = chunkOf(addDays(toKey, -RECENT_DAYS));
    const missing: number[] = [];
    const stale: number[] = [];
    for (let i = last; i >= first; i--) {
      if (inflight.current.has(i)) continue;
      const c = chunks.get(i);
      if (!c) missing.push(i);
      else if (c.rev !== rev && (i >= recent || dirty.current.has(i) || now - c.at > STALE_MS)) stale.push(i);
    }

    const load = (weeks: number[]) => {
      weeks.forEach((i) => inflight.current.add(i));
      // Newest weeks first, a few at a time; each lands as soon as it arrives.
      const queue = [...weeks];
      const worker = async () => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
          try {
            const from = chunkFrom(i);
            const res = await fetchRange(api, from, addDays(from, CHUNK_DAYS - 1));
            if (!mounted.current) return;
            const chunk: Chunk = { entries: res.entries, at: Date.now(), rev, partialDays: res.partialDays };
            dirty.current.delete(i);
            setChunks((m) => new Map(m).set(i, chunk));
            setError(null);
            setFails(0);
          } catch (e) {
            if (!mounted.current) return;
            setError(e instanceof Error ? e.message : "Couldn't load the log");
            setFails((n) => n + 1);
          } finally {
            inflight.current.delete(i);
          }
        }
      };
      void Promise.all(Array.from({ length: Math.min(PARALLEL, weeks.length) }, worker));
    };

    if (missing.length) load(missing);
    if (!stale.length) return;
    // Debounce refreshes: a burst of logs moves rev several times.
    const t = setTimeout(() => load(stale), 400);
    return () => clearTimeout(t);
    // `chunks` is read to decide what's missing; fetched weeks carry the rev they were
    // fetched at, so a re-run after they land is a no-op.
  }, [api, chunks, first, last, rev, toKey, attempt]);

  // Flaky hospital Wi-Fi: retry failed weeks a few times, backing off.
  useEffect(() => {
    if (!fails || fails > 4) return;
    const t = setTimeout(() => setAttempt((a) => a + 1), 1500 * 2 ** fails);
    return () => clearTimeout(t);
  }, [fails]);

  const reload = useCallback(() => {
    setFails(0);
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  /** Call before opening or restoring an entry, so its week refreshes on the next change. */
  const touch = useCallback(
    (e: Entry) => {
      dirty.current.add(chunkOf(dayKey(Date.parse(e.started_at), tz)));
      if (e.ended_at) dirty.current.add(chunkOf(dayKey(Date.parse(e.ended_at), tz)));
    },
    [tz]
  );

  let ready = true;
  let any = false;
  for (let i = first; i <= last; i++) {
    if (chunks.has(i)) any = true;
    else ready = false;
  }
  // Start of the loaded stretch ending today: while older weeks are still on their
  // way, views stop here rather than drawing those days as empty.
  let loadedFrom: string | null = null;
  for (let i = last; i >= first && chunks.has(i); i--) loadedFrom = chunkFrom(i);
  if (loadedFrom && loadedFrom < fromKey) loadedFrom = fromKey;
  const entries = useMemo(() => {
    if (!state) return [];
    const all: Entry[] = [];
    for (let i = first; i <= last; i++) all.push(...(chunks.get(i)?.entries ?? []));
    return mergeLive(all, state); // also de-duplicates entries that span two weeks
  }, [chunks, first, last, state]);
  const partialDays = useMemo(() => {
    const out: string[] = [];
    for (let i = first; i <= last; i++) out.push(...(chunks.get(i)?.partialDays ?? []));
    return out.filter((k) => k >= fromKey && k <= toKey);
  }, [chunks, first, last, fromKey, toKey]);

  return { entries, ready, loaded: any, loadedFrom, error, reload, partialDays, touch };
}

export type TimeWindow = { key: string; start: number; end: number };

/**
 * Entries overlapping each window (windows oldest first, back to back), found
 * by binary search so a month of days doesn't rescan every entry per day.
 */
export function bucketWindows(entries: Entry[], windows: TimeWindow[], now: Date): Entry[][] {
  const out = windows.map(() => [] as Entry[]);
  const nowMs = now.getTime();
  for (const e of entries) {
    const s = Date.parse(e.started_at);
    const end = Math.max(s, e.ended_at ? Date.parse(e.ended_at) : e.active ? nowMs : s);
    let lo = 0;
    let hi = windows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (windows[mid].end <= s) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < windows.length && windows[i].start <= end; i++) out[i].push(e);
  }
  return out;
}

/** DayStats per local day, oldest first (dailyStats, minus the rescans). */
export function statsByDay(entries: Entry[], fromKey: string, toKey: string, now: Date, tz: string): DayStats[] {
  const windows: TimeWindow[] = [];
  for (let k = fromKey; k <= toKey; k = addDays(k, 1)) {
    const [a, b] = dayBounds(k, tz);
    windows.push({ key: k, start: a.getTime(), end: b.getTime() });
  }
  const buckets = bucketWindows(entries, windows, now);
  return windows.map((w, i) => statsFor(buckets[i], new Date(w.start), new Date(w.end), w.key, now));
}

/** Clock-change days in the baby's zone get a gentle label instead of a mystery gap. */
export function dstNote(key: string, tz: string): string | null {
  const [a, b] = dayBounds(key, tz);
  const hours = Math.round((b.getTime() - a.getTime()) / H);
  if (hours === 25) return "25-hour day (clocks fell back)";
  if (hours === 23) return "23-hour day (clocks sprang forward)";
  return null;
}

/** "9 feeds · 2h 05m nursing · 2 oz bottle · 6 wet · 3 dirty · 14h 20m sleep" */
export function daySummaryParts(s: DayStats, units: UnitSystem): string[] {
  const parts = [`${s.feeds} feed${s.feeds === 1 ? "" : "s"}`];
  if (s.nursingSec >= 60) parts.push(`${formatDuration(s.nursingSec)} nursing`);
  if (s.bottleMl > 0) parts.push(`${formatVolume(s.bottleMl, units)} bottle`);
  parts.push(`${s.wet} wet`, `${s.dirty} dirty`);
  if (s.sleepSec >= 60) parts.push(`${formatDuration(s.sleepSec)} sleep`);
  return parts;
}

// Patterns → Timeline: "show me that day". The Timeline reads it when it mounts.
let pendingDay: string | null = null;
export function requestTimelineDay(key: string) {
  pendingDay = key;
}

// ── The tab ──────────────────────────────────────────────────────────────

export default function LogTab() {
  const { state, units, readOnly } = useMaple();
  const now = useNow(60_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const todayKey = dayKey(now, tz);
  const bornAt = state?.baby.born_at ?? null;
  const bornKey = bornAt ? dayKey(Date.parse(bornAt), tz) : null;
  const reduceMotion = useReducedMotion();

  const [group, setGroup] = useState<KindGroup>("all");
  const [oldestKey, setOldestKey] = useState(() => addDays(todayKey, -(PAGE_DAYS - 1)));
  const [extendedFrom, setExtendedFrom] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  const { entries, ready, loadedFrom, error, reload, partialDays, touch } = useEntryRange(oldestKey, todayKey);

  const hasPreBirth = useMemo(
    () => (bornAt ? entries.some((e) => Date.parse(e.started_at) < Date.parse(bornAt) - H) : false),
    [entries, bornAt]
  );
  const reachedBirth = bornKey != null && oldestKey <= bornKey && !hasPreBirth;
  const canLoadEarlier = !exhausted && !reachedBirth && daysBetween(oldestKey, todayKey) < MAX_SPAN_DAYS - PAGE_DAYS;

  const loadEarlier = useCallback(() => {
    if (!ready) return;
    setExtendedFrom(oldestKey);
    setOldestKey(addDays(oldestKey, -PAGE_DAYS));
  }, [oldestKey, ready]);

  // A page that came back empty (before birth, or nothing logged yet) ends the scroll.
  useEffect(() => {
    if (!ready || !extendedFrom) return;
    const older = entries.some((e) => dayKey(Date.parse(e.started_at), tz) < extendedFrom);
    if (!older && (!bornKey || oldestKey <= bornKey)) setExhausted(true);
    setExtendedFrom(null);
  }, [ready, extendedFrom, entries, tz, bornKey, oldestKey]);

  const jumpTo = useCallback(
    (key: string) => {
      const k = key > todayKey ? todayKey : key;
      setPinned(k);
      setScrollTarget(k);
      setOldestKey((o) => (k < o ? k : o));
    },
    [todayKey]
  );

  // Arriving from Patterns ("show this day").
  useEffect(() => {
    if (!pendingDay) return;
    const k = pendingDay;
    pendingDay = null;
    jumpTo(k);
  }, [jumpTo]);

  // Group entries by local day (a sleep across midnight belongs to the day it started).
  const byDay = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of entries) {
      if (e.active) continue; // shown under "Happening now"
      const k = dayKey(Date.parse(e.started_at), tz);
      const list = m.get(k);
      if (list) list.push(e);
      else m.set(k, [e]);
    }
    return m;
  }, [entries, tz]);

  const stats = useMemo(() => statsByDay(entries, oldestKey, todayKey, now, tz), [entries, oldestKey, todayKey, now, tz]);

  const shownFrom = ready ? oldestKey : loadedFrom ?? todayKey;
  const days = useMemo(() => {
    const out: { key: string; rows: Entry[]; stats: DayStats; total: number }[] = [];
    for (let i = stats.length - 1; i >= 0; i--) {
      const k = stats[i].key;
      if (k < shownFrom) break; // that week hasn't arrived yet
      const all = byDay.get(k) ?? [];
      const rows = group === "all" ? all : all.filter((e) => groupOf(e.kind) === group);
      if (!rows.length && k !== todayKey && k !== pinned) continue;
      out.push({ key: k, rows, stats: stats[i], total: all.length });
    }
    return out;
  }, [stats, byDay, group, pinned, todayKey, shownFrom]);

  // Scroll to a jumped-to day once its page has loaded.
  useEffect(() => {
    if (!scrollTarget || !ready) return;
    const el = document.getElementById(`maple-day-${scrollTarget}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    setFlash(scrollTarget);
    setScrollTarget(null);
  }, [scrollTarget, ready, days, reduceMotion]);

  // The jumped-to day's header glows briefly, then settles.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  // Infinite scroll: once they've scrolled a bit, reaching the bottom loads the previous week.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canLoadEarlier || !ready) return;
    const io = new IntersectionObserver(
      ([hit]) => {
        if (hit.isIntersecting && window.scrollY > 240) loadEarlier();
      },
      { rootMargin: "320px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadEarlier, ready, loadEarlier]);

  const { glow, pill, dismissPill } = useArrivals(state);

  if (!state) return null;
  const running = state.entries.filter((e) => e.active);
  const nothingAtAll = ready && entries.length === 0;

  return (
    <div className="px-4">
      {/* px-1 lines the title up with the section and day titles below it. */}
      <header className="mb-4 px-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="flex min-h-[44px] items-center justify-between gap-3">
          <h1 className={cx(tone.display, "text-[34px] leading-[1.05]")}>Timeline</h1>
          <div className="flex items-center gap-1">
            {!readOnly && <RecentlyRemoved onRestore={touch} />}
            <JumpToDate todayKey={todayKey} minKey={hasPreBirth ? undefined : bornKey ?? undefined} onJump={jumpTo} />
          </div>
        </div>
      </header>

      {/* Six chips don't fit at phone width; the right edge fades so "Other" reads as a scroll away. */}
      <div
        className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="toolbar"
        aria-label="Show"
      >
        {KIND_GROUPS.map((g) => (
          <Chip key={g.id} selected={group === g.id} onClick={() => setGroup(g.id)} className="shrink-0">
            {g.label}
          </Chip>
        ))}
      </div>

      <RunningNow entries={running} />

      {partialDays.length > 0 && (
        <p className={cx(tone.inset, tone.muted, "mb-5 flex gap-2.5 px-4 py-3 text-[13px] leading-snug")} role="status">
          <Icon name="info" size={16} className="mt-px shrink-0 text-mp-ink-3" />
          <span>
            {partialDays.map((k) => formatDayLabel(k, todayKey)).join(", ")} had more entries than we can load at once, so
            {partialDays.length === 1 ? " that day shows" : " those days show"} the most recent ones.
          </span>
        </p>
      )}

      {error && !ready && (
        <div className={cx(tone.card, "mb-5 flex items-center gap-3 py-2.5 pr-2.5 pl-4")} role="status">
          <Icon name="cloud-off" size={20} className="shrink-0 text-mp-ink-3" />
          <p className={cx(tone.body, "flex-1 text-sm")}>Couldn&apos;t reach the forest for older pages just now. Recent entries are below.</p>
          <Button size="sm" variant="soft" onClick={reload}>
            Try again
          </Button>
        </div>
      )}

      {nothingAtAll && !running.length ? (
        <div className="mt-6">
          <EmptyState icon="leaf" title="The first page is waiting">
            Feeds, changes and naps will gather here like fallen leaves, newest on top. Zoe is keeping the page warm.
          </EmptyState>
          {!readOnly && <QuickLog />}
        </div>
      ) : (
        <div className="space-y-5">
          {days.map((d) => (
            <DaySection
              key={d.key}
              day={d.key}
              todayKey={todayKey}
              tz={tz}
              rows={d.rows}
              stats={d.stats}
              total={d.total}
              group={group}
              units={units}
              now={now}
              glow={glow}
              readOnly={readOnly}
              onOpen={touch}
              highlighted={d.key === flash}
            />
          ))}
        </div>
      )}

      <div ref={sentinel} className="py-8 text-center">
        {canLoadEarlier ? (
          <Button variant="soft" onClick={loadEarlier} disabled={!ready}>
            {ready ? "Show earlier days" : "Gathering earlier pages…"}
          </Button>
        ) : (
          !nothingAtAll && (
            <p className={cx(tone.faint, "flex flex-col items-center gap-1.5 text-[13px]")}>
              <Icon name="sprout" size={22} className="text-mp-accent-fg" />
              {bornKey && reachedBirth
                ? `${formatDayLabel(bornKey, todayKey)} · Day 1 · Maple's story starts here`
                : "That's the very first page."}
            </p>
          )
        )}
      </div>

      <NewArrivalsPill pill={pill} onDismiss={dismissPill} />
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────

function DaySection({
  day: key,
  todayKey,
  tz,
  rows,
  stats,
  total,
  group,
  units,
  now,
  glow,
  highlighted,
  readOnly,
  onOpen,
}: {
  day: string;
  todayKey: string;
  tz: string;
  rows: Entry[];
  stats: DayStats;
  total: number;
  group: KindGroup;
  units: UnitSystem;
  now: Date;
  glow: Set<number>;
  highlighted: boolean;
  readOnly: boolean;
  onOpen: (e: Entry) => void;
}) {
  const { open } = useSheets();
  const label = formatDayLabel(key, todayKey, { long: false });
  const dst = dstNote(key, tz);
  const summary = total ? daySummaryParts(stats, units) : null;
  const groupLabel = KIND_GROUPS.find((g) => g.id === group)?.label.toLowerCase();

  return (
    <section id={`maple-day-${key}`} aria-label={label} className="scroll-mt-[env(safe-area-inset-top)]">
      {/* Opaque so rows scroll cleanly under it; a jumped-to day's header warms for a moment. */}
      <div
        className={cx(
          "sticky top-[env(safe-area-inset-top)] z-10 -mx-4 mb-1 px-5 pt-2 pb-2 transition-colors duration-700",
          highlighted ? "bg-mp-sunken" : "bg-mp-bg"
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 className={cx(tone.heading, "text-[17px]")}>{label}</h2>
          {dst && (
            <span className={cx(tone.muted, "inline-flex items-center gap-1 text-xs")}>
              <Icon name="clock-3" size={12} className="self-center" />
              {dst}
            </span>
          )}
        </div>
        {summary && (
          // Each figure stays whole ("6h 34m sleep"); lines break between them.
          <p className={cx(tone.faint, "mt-0.5 text-[13px] leading-snug")}>
            {summary.map((part, i) => (
              <span key={i}>
                <span className="whitespace-nowrap">
                  {part}
                  {i < summary.length - 1 && " ·"}
                </span>{" "}
              </span>
            ))}
          </p>
        )}
      </div>

      {rows.length ? (
        <ol className={cx(tone.card, "overflow-hidden")}>
          {rows.map((e, i) => (
            <li
              key={e.id}
              data-entry-id={e.id}
              className={cx("relative transition-colors duration-700", glow.has(e.id) && "bg-mp-focus/20")}
            >
              {/*
                The day as one line: a hairline threads EntryRow's badges (36px, inset 16px)
                from one row to the next, stopping short of each badge. Dividers start at
                the text so the thread reads unbroken.
              */}
              {i > 0 && (
                <>
                  <span aria-hidden className="pointer-events-none absolute top-0 right-0 left-16 h-px bg-mp-line" />
                  <span aria-hidden className="pointer-events-none absolute top-0 left-[33.25px] h-[calc(50%-22px)] w-[1.5px] bg-mp-line" />
                </>
              )}
              {i < rows.length - 1 && (
                <span aria-hidden className="pointer-events-none absolute bottom-0 left-[33.25px] h-[calc(50%-22px)] w-[1.5px] bg-mp-line" />
              )}
              <EntryRow
                entry={e}
                now={now}
                onClick={() => {
                  onOpen(e);
                  open({ kind: e.kind, entry: e });
                }}
              />
            </li>
          ))}
        </ol>
      ) : (
        <div className={cx(tone.card, "p-4 text-center")}>
          <p className={cx(tone.muted, "text-sm")}>
            {total && groupLabel
              ? `No ${groupLabel} logged ${key === todayKey ? "yet today" : "this day"}.`
              : key === todayKey
                ? "Nothing written down for today yet."
                : `Nothing written down for ${label}.`}
          </p>
          {!total && !readOnly && <QuickLog compact />}
        </div>
      )}
    </section>
  );
}

const QUICK: { kind: EntryKind; label: string }[] = [
  { kind: "feed", label: "Feed" },
  { kind: "diaper", label: "Diaper" },
  { kind: "sleep", label: "Sleep" },
];

/** "Log an earlier one": open a sheet (each has its own time picker). */
function QuickLog({ compact }: { compact?: boolean }) {
  const { open } = useSheets();
  return (
    <div role="group" aria-label="Log an earlier one" className={cx("flex flex-wrap justify-center gap-2", compact ? "mt-3" : "mt-1")}>
      {!compact && (
        <p aria-hidden className={cx(tone.faint, "mb-1 w-full text-center text-[13px]")}>
          Log an earlier one:
        </p>
      )}
      {QUICK.map((q) => (
        <Chip key={q.kind} onClick={() => open({ kind: q.kind })}>
          <Icon name={KIND_ICON[q.kind]} size={16} className="mp-kind-ink" style={{ color: KIND_COLOR[q.kind] }} />
          {q.label}
        </Chip>
      ))}
    </div>
  );
}

function RunningNow({ entries }: { entries: Entry[] }) {
  const now = useNow(1000);
  const { open } = useSheets();
  if (!entries.length) return null;
  return (
    <section aria-label="Happening now" className="mb-5">
      <SectionTitle>Happening now</SectionTitle>
      <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {entries.map((e) => (
          <EntryRow key={e.id} entry={e} now={now} onClick={() => open({ kind: e.kind, entry: e })} />
        ))}
      </div>
    </section>
  );
}

/**
 * Last 24h of deleted entries, with Restore (in case the other parent
 * deleted the wrong one). A quiet trash button in the header, only while
 * there's something to restore; the list opens in a sheet, so it never sits
 * in the day's flow or in the way of loading older weeks.
 */
function RecentlyRemoved({ onRestore }: { onRestore: (e: Entry) => void }) {
  const { api, state, restore: restoreEntry, memberName, units } = useMaple();
  const now = useNow(60_000);
  const [items, setItems] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const rev = state?.rev;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api<{ entries: Entry[] }>("/api/maple/entries?deleted=1")
        .then((r) => {
          if (!cancelled) setItems(r.entries ?? []);
        })
        .catch(() => {
          // Optional: stay quiet if it can't load.
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [api, rev]);

  // The last one restored closes the sheet.
  useEffect(() => {
    if (!items.length) setOpen(false);
  }, [items.length]);

  if (!items.length && !open) return null;

  const restore = async (e: Entry) => {
    setBusy(e.id);
    // restore() toasts either way and refreshes the snapshot.
    onRestore(e);
    if (await restoreEntry(e.id)) setItems((xs) => xs.filter((x) => x.id !== e.id));
    setBusy(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Recently removed: ${items.length}`}
        className="inline-flex min-h-[44px] items-center gap-1 rounded-xl px-2.5 text-[15px] text-mp-ink-2 tabular-nums transition active:bg-mp-ink/5"
      >
        <Icon name="trash-2" size={18} />
        {items.length}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Recently removed">
        <p className={cx(tone.muted, "text-sm")}>Deleted in the last day. Restore puts one back where it was.</p>
        <ul className={cx(tone.card, tone.divide, "overflow-hidden")}>
          {items.map((e) => {
            const d = describeEntry(e, { units, now });
            return (
              <li key={e.id} className="flex items-center gap-3 py-2.5 pr-3 pl-4">
                <KindBadge entry={e} className="opacity-60" />
                <span className="min-w-0 flex-1">
                  <span className={cx(tone.muted, "block truncate text-[15px] font-medium line-through decoration-mp-ink-3")}>{d.title}</span>
                  <span className={cx(tone.faint, "block text-[13px] leading-snug")}>
                    {formatDayLabel(dayKey(Date.parse(e.started_at), tz), dayKey(now, tz))} {formatTime(e.started_at, tz)} · removed by{" "}
                    {memberName(e.updated_by ?? e.created_by)} {formatRelative(e.updated_at, now)}
                  </span>
                </span>
                <Button size="sm" variant="soft" onClick={() => void restore(e)} disabled={busy === e.id}>
                  Restore
                </Button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}

function JumpToDate({ todayKey, minKey, onJump }: { todayKey: string; minKey?: string; onJump: (k: string) => void }) {
  const [openPicker, setOpenPicker] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!openPicker) return;
    const el = input.current;
    el?.focus();
    try {
      el?.showPicker?.();
    } catch {
      // showPicker needs a user gesture in some browsers; the input is right there anyway.
    }
  }, [openPicker]);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {openPicker && (
        <input
          ref={input}
          type="date"
          aria-label="Jump to a day"
          max={todayKey}
          min={minKey}
          defaultValue=""
          onChange={(e) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) {
              onJump(e.target.value);
              setOpenPicker(false);
            }
          }}
          className={cx(tone.input, "h-11 w-[9.5rem] px-3 py-0 text-base [&::-webkit-calendar-picker-indicator]:opacity-50")}
        />
      )}
      {openPicker && (
        <button
          type="button"
          onClick={() => setOpenPicker(false)}
          aria-label="Close date picker"
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
            <Icon name="x" size={18} strokeWidth={2.25} />
          </span>
        </button>
      )}
      {!openPicker && (
        <Button variant="soft" size="sm" onClick={() => setOpenPicker(true)} aria-label="Jump to a day" className="min-h-[44px]">
          <Icon name="calendar-days" size={17} className="text-mp-ink-2" />
          Jump
        </Button>
      )}
    </div>
  );
}

// ── Live arrivals from the other parent ──────────────────────────────────

type Pill = { ids: number[]; text: string };

/**
 * Rows another member logs (arriving by poll) glow gold for 2 seconds; if
 * they land out of view, a pill offers to scroll up to them.
 */
function useArrivals(state: MapleState | null) {
  const seen = useRef<Set<number> | null>(null);
  const timers = useRef<number[]>([]);
  const [glow, setGlow] = useState<Set<number>>(() => new Set());
  const [pill, setPill] = useState<Pill | null>(null);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  useEffect(() => {
    if (!state) return;
    if (!seen.current) {
      seen.current = new Set(state.entries.map((e) => e.id));
      return;
    }
    const known = seen.current;
    const fresh = state.entries.filter((e) => e.id > 0 && !known.has(e.id) && e.created_by !== state.me.email);
    for (const e of state.entries) known.add(e.id);
    if (!fresh.length) return;

    const ids = fresh.map((e) => e.id);
    setGlow((g) => new Set([...g, ...ids]));
    // Not tied to this effect's cleanup: the next poll mustn't cancel the fade-out.
    timers.current.push(
      window.setTimeout(() => {
        setGlow((g) => {
          const next = new Set(g);
          ids.forEach((id) => next.delete(id));
          return next;
        });
      }, 2000)
    );

    // After paint: are any of them off screen?
    const raf = requestAnimationFrame(() => {
      const outOfView = ids.some((id) => {
        const el = document.querySelector(`[data-entry-id="${id}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.bottom < 0 || r.top > window.innerHeight;
      });
      if (!outOfView) return;
      const names = [...new Set(fresh.map((e) => memberLabel(e.created_by, state)))];
      setPill({ ids, text: `${ids.length} new from ${names.join(" & ")}` });
    });
    return () => cancelAnimationFrame(raf);
  }, [state]);

  // Pills fade on their own.
  useEffect(() => {
    if (!pill) return;
    const t = setTimeout(() => setPill(null), 10_000);
    return () => clearTimeout(t);
  }, [pill]);

  const dismissPill = useCallback(() => setPill(null), []);
  return { glow, pill, dismissPill };
}

function memberLabel(id: string | null, state: MapleState): string {
  const m = state.members.find((x) => x.email === id);
  return m?.display_name ?? (id ? id.split("@")[0] : "someone");
}

function NewArrivalsPill({ pill, onDismiss }: { pill: Pill | null; onDismiss: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <AnimatePresence>
      {pill && (
        <motion.button
          type="button"
          initial={{ opacity: 0, y: reduceMotion ? 0 : -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reduceMotion ? 0 : -12 }}
          onClick={() => {
            const el = document.querySelector(`[data-entry-id="${pill.ids[0]}"]`);
            el?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            onDismiss();
          }}
          className="fixed top-[calc(env(safe-area-inset-top)+12px)] left-1/2 z-40 inline-flex min-h-[44px] -translate-x-1/2 items-center gap-1.5 rounded-full bg-mp-accent pr-3.5 pl-4 text-sm font-semibold whitespace-nowrap text-mp-on-accent shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-mp-line"
        >
          {pill.text}
          <Icon name="chevron-up" size={16} strokeWidth={2.25} />
        </motion.button>
      )}
    </AnimatePresence>
  );
}

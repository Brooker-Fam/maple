"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { statsFor } from "@/lib/maple/insights";
import { MILESTONES, milestoneEmoji, milestoneLabel, monthlyId, monthlyNumber } from "@/lib/maple/milestones";
import {
  addDays,
  babyAge,
  dayBounds,
  dayKey,
  daysBetween,
  formatDayLabel,
  formatDuration,
  formatTime,
  localParts,
  parseDayKey,
} from "@/lib/maple/time";
import type { Entry, EntryOf, Member } from "@/lib/maple/types";
import { photoUrl } from "./EntryRow";
import { useSheets } from "./sheets";
import { Avatar, Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Moments: Maple's keepsake. A "Firsts" shelf (found vs still to come), her
 * monthly photos lined up under "Growing up", and a scrapbook of polaroids
 * grouped by week of age, newest first, that open into a lightbox.
 *
 * Photos only ever load through the family-only proxy (/api/maple/photo), by
 * position; a photo that can't load turns into a leaf instead of a broken
 * image. The whole tab is kept out of session replays (ph-no-capture).
 */

type Moment = EntryOf<"moment">;
type Slide = { entry: Moment; photo: number | null };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TAPES = ["gold", "blush", "lavender", "sage"] as const;
/** The shell adds .maple-night 8pm–7am: photos dim so they don't glare at 3am. */
const NIGHT_DIM = "[.maple-night_&]:brightness-[.55] [.maple-night_&]:saturate-[.8]";
const SHELF_COLLAPSED = 8;

const isMoment = (e: Entry): e is Moment => e.kind === "moment";
const photoCount = (m: Moment) => (m.id > 0 ? m.data.photos?.length ?? 0 : 0);
const captionOf = (m: Moment) => m.data.title || milestoneLabel(m.data.milestone) || m.note || "A little moment";

/** Stable pseudo-random 0..1 from an id, so a print keeps its tilt. */
function seeded(id: number, salt: number): number {
  const x = Math.sin(id * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function shortDate(key: string, withYear = false): string {
  const { year, month, day } = parseDayKey(key);
  return `${MON[month - 1]} ${day}${withYear ? `, ${year}` : ""}`;
}

function rangeLabel(a: string, b: string, todayKey: string): string {
  const pa = parseDayKey(a);
  const pb = parseDayKey(b);
  const year = pb.year !== parseDayKey(todayKey).year ? `, ${pb.year}` : "";
  if (pa.month === pb.month && pa.year === pb.year) return `${MON[pa.month - 1]} ${pa.day} – ${pb.day}${year}`;
  return `${shortDate(a)} – ${shortDate(b)}${year}`;
}

/** "3 days old", "2 weeks, 3 days old", "5 hours old"; null before she's born. */
function ageAt(bornAt: string | null, at: string, tz: string): string | null {
  if (!bornAt) return null;
  if (Date.parse(at) < Date.parse(bornAt)) return "Before she arrived";
  const age = babyAge(bornAt, new Date(at), tz);
  if (age.days < 1) return age.label;
  if (age.days < 14) return `${age.days} day${age.days === 1 ? "" : "s"} old`;
  return `${age.label} old`;
}

/** Compact age for the shelf: "day 3", "2w 3d", "3mo". */
function ageShort(bornAt: string | null, at: string, tz: string): string | null {
  if (!bornAt) return null;
  if (Date.parse(at) < Date.parse(bornAt)) return "before birth";
  const age = babyAge(bornAt, new Date(at), tz);
  return age.days < 14 ? `day ${age.dayOfLife}` : age.short;
}

/** Her n-month day as a day key (clamped to the month's last day: Jan 31 → Feb 28). */
function monthDayKey(bornAt: string, n: number, tz: string): string {
  const b = localParts(new Date(bornAt), tz);
  const first = new Date(Date.UTC(b.year, b.month - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(Math.min(b.day, last))}`;
}

type Week = { id: string; n: number | null; startKey?: string; endKey?: string; moments: Moment[] };

function groupByWeek(moments: Moment[], bornAt: string | null, tz: string): Week[] {
  const bornKey = bornAt ? dayKey(new Date(bornAt), tz) : null;
  const weeks = new Map<string, Week>();
  for (const m of moments) {
    let w: Week;
    if (!bornAt || !bornKey || Date.parse(m.started_at) < Date.parse(bornAt)) {
      w = weeks.get("before") ?? { id: "before", n: null, moments: [] };
    } else {
      const n = Math.floor(daysBetween(bornKey, dayKey(new Date(m.started_at), tz)) / 7) + 1;
      w = weeks.get(`w${n}`) ?? {
        id: `w${n}`,
        n,
        startKey: addDays(bornKey, (n - 1) * 7),
        endKey: addDays(bornKey, n * 7 - 1),
        moments: [],
      };
    }
    w.moments.push(m);
    weeks.set(w.id, w);
  }
  // Moments arrive newest first, so pages do too ("before" lands last).
  return [...weeks.values()];
}

export default function MomentsTab() {
  const { state, api, now, readOnly } = useMaple();
  const { open } = useSheets();
  const [fetched, setFetched] = useState<Moment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: number; photo: number | null } | null>(null);
  const seq = useRef(0);
  const rev = state?.rev;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api<{ entries: Entry[] }>("/api/maple/entries?kind=moment&limit=500");
      if (mine !== seq.current) return;
      setFetched(res.entries.filter(isMoment));
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "Couldn't load moments");
    }
  }, [api]);

  // Reload whenever anything in the log changes (a new moment from the other phone, an edit, a delete).
  useEffect(() => {
    void load();
  }, [load, rev]);

  const tz = state?.baby.timezone ?? "America/New_York";
  const bornAt = state?.baby.born_at ?? null;
  // Viewers (read-only role) can look at everything but add or edit nothing.
  const viewer = readOnly;
  const babyName = state?.baby.name?.split(" ")[0] || "Maple";

  // The fetched list plus what the shared state already knows (an optimistic
  // save, a delete a moment ago) so the scrapbook doesn't lag the toast.
  const stateEntries = state?.entries;
  const stateNow = state?.now;
  const moments = useMemo(() => {
    if (!fetched) return null;
    const recent = (stateEntries ?? []).filter(isMoment);
    const inState = new Set(recent.map((e) => e.id));
    // The state holds the 72h before its snapshot; inside that, a fetched moment it lacks was deleted.
    const cutoff = stateNow ? Date.parse(stateNow) - 71 * 3600_000 : Infinity;
    const byId = new Map<number, Moment>();
    for (const m of fetched) {
      if (Date.parse(m.started_at) > cutoff && !inState.has(m.id)) continue; // just deleted
      byId.set(m.id, m);
    }
    for (const m of recent) if (!byId.has(m.id)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  }, [fetched, stateEntries, stateNow]);

  const slides = useMemo<Slide[]>(
    () =>
      (moments ?? []).flatMap((m): Slide[] =>
        photoCount(m) ? m.data.photos!.map((_, i) => ({ entry: m, photo: i })) : [{ entry: m, photo: null }]
      ),
    [moments]
  );
  const slideIndex = viewing ? slides.findIndex((s) => s.entry.id === viewing.id && s.photo === viewing.photo) : -1;

  const show = (m: Moment, photo: number | null = photoCount(m) ? 0 : null) => setViewing({ id: m.id, photo });
  const add = (preset?: Record<string, unknown>) => open({ kind: "moment", preset });

  if (!state) return null;
  const n = now();
  const todayKey = dayKey(n, tz);

  return (
    <div className="ph-no-capture overflow-x-clip px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-8">
      <header className="mb-4">
        <h1 className={cx(tone.heading, "text-[34px] leading-tight")}>Moments</h1>
        <p className={cx(tone.muted, "text-sm")}>Little leaves for {babyName}&apos;s someday-book 🍂</p>
      </header>

      {/* The empty scrapbook has its own "Add a photo"; one invitation is enough. */}
      {!viewer && moments?.length !== 0 && (
        <Button variant="gold" size="lg" className="mb-5 w-full text-[17px]" onClick={() => add()}>
          <span aria-hidden>📷</span> Add a moment
        </Button>
      )}

      {!viewer && bornAt && (
        <MonthlyPrompt bornAt={bornAt} tz={tz} now={n} moments={moments} name={babyName} onTake={add} />
      )}

      {error && !moments && (
        <div className={cx(tone.card, "mb-5 p-4 text-center")}>
          <p className={cx(tone.body, "text-sm")}>Couldn&apos;t reach the scrapbook. {error}</p>
          <Button variant="soft" size="sm" className="mt-2" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {!moments && !error && <LoadingPrints />}

      {moments && moments.length === 0 && <EmptyScrapbook viewer={viewer} onAdd={() => add()} />}

      {moments && (
        <FirstsShelf moments={moments} bornAt={bornAt} tz={tz} viewer={viewer} onOpen={show} onAdd={(id) => add({ milestone: id })} />
      )}

      {moments && bornAt && (
        <GrowingUp moments={moments} bornAt={bornAt} tz={tz} now={n} viewer={viewer} onOpen={show} onAdd={add} />
      )}

      {moments && moments.length > 0 && (
        <Scrapbook moments={moments} bornAt={bornAt} tz={tz} todayKey={todayKey} rev={rev ?? ""} onOpen={show} />
      )}

      <Lightbox
        slides={slides}
        index={slideIndex}
        onIndex={(i) => setViewing({ id: slides[i].entry.id, photo: slides[i].photo })}
        onClose={() => setViewing(null)}
        onEdit={
          viewer
            ? undefined
            : (m) => {
                setViewing(null);
                open({ kind: "moment", entry: m });
              }
        }
        bornAt={bornAt}
        tz={tz}
      />
    </div>
  );
}

// ── Monthly photo prompt ─────────────────────────────────────────────────

function MonthlyPrompt({
  bornAt,
  tz,
  now,
  moments,
  name,
  onTake,
}: {
  bornAt: string;
  tz: string;
  now: Date;
  moments: Moment[] | null;
  name: string;
  onTake: (preset: Record<string, unknown>) => void;
}) {
  const months = babyAge(bornAt, now, tz).months;
  const skipKey = `maple-monthly-skip-${months}`;
  const [skipped, setSkipped] = useState(false);
  useEffect(() => {
    try {
      setSkipped(localStorage.getItem(skipKey) === "1");
    } catch {
      // storage blocked
    }
  }, [skipKey]);

  if (!moments || months < 1 || months > 12 || skipped) return null;
  const hour = localParts(now, tz).hour;
  if (hour < 7 || hour >= 20) return null; // daytime only; it waits for morning
  const since = daysBetween(monthDayKey(bornAt, months, tz), dayKey(now, tz));
  if (since < 0 || since > 3) return null;
  if (moments.some((m) => m.data.milestone === monthlyId(months))) return null;

  const skip = () => {
    setSkipped(true);
    try {
      localStorage.setItem(skipKey, "1");
    } catch {
      // storage blocked
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cx(tone.card, "relative mb-5 flex gap-3 overflow-hidden p-4 pr-11")}
    >
      <span className="text-4xl leading-none" aria-hidden>
        🧸
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx(tone.heading, "text-lg leading-snug lining-nums")}>
          {since === 0 ? "Today" : "This week"} is {name}&apos;s {months}-month day!
        </p>
        <p className={cx(tone.muted, "mt-0.5 text-sm")}>
          Take her monthly photo? Same spot, same blanket, and she lines up under “Growing up.”
        </p>
        <Button
          variant="primary"
          size="sm"
          className="mt-2.5"
          onClick={() =>
            onTake({ title: `${months} month${months === 1 ? "" : "s"} old`, milestone: monthlyId(months) })
          }
        >
          📷 Month {months} photo
        </Button>
      </div>
      <button
        type="button"
        onClick={skip}
        aria-label="Not this month"
        className={cx(tone.muted, "absolute top-1.5 right-1.5 flex h-11 w-11 items-center justify-center rounded-full text-base")}
      >
        ✕
      </button>
    </motion.div>
  );
}

// ── Firsts shelf ─────────────────────────────────────────────────────────

const SHORT: Record<string, string> = {
  "met-bruce": "Bruce (eventually)",
  "emmett-held": "Emmett held her",
  "sapphire-read": "Sapphire read to her",
  "cord-stump": "Cord stump off",
  "first-outing": "First walk",
  "met-grandparents": "Grandparents",
  "first-smile": "First smile",
  "crib-night": "Crib night",
};

function FirstsShelf({
  moments,
  bornAt,
  tz,
  viewer,
  onOpen,
  onAdd,
}: {
  moments: Moment[];
  bornAt: string | null;
  tz: string;
  viewer: boolean;
  onOpen: (m: Moment) => void;
  onAdd: (milestone: string) => void;
}) {
  const [all, setAll] = useState(false);
  // The earliest moment for each first.
  const found = new Map<string, Moment>();
  for (const m of moments) if (m.data.milestone && m.id > 0) found.set(m.data.milestone, m);
  const achieved = MILESTONES.filter((p) => found.has(p.id)).sort(
    (a, b) => Date.parse(found.get(a.id)!.started_at) - Date.parse(found.get(b.id)!.started_at)
  );
  const upcoming = MILESTONES.filter((p) => !found.has(p.id));
  const ordered = [...achieved, ...upcoming];
  const shown = all ? ordered : ordered.slice(0, SHELF_COLLAPSED);

  return (
    <section className={cx(tone.card, "mb-6 p-4")} aria-label="Firsts">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className={cx(tone.heading, "text-xl")}>Firsts</h2>
        <span className={cx(tone.muted, "text-xs")}>
          {achieved.length ? `${achieved.length} of ${MILESTONES.length} found` : "all still to come"}
        </span>
      </div>
      <ul className="mt-3 grid grid-cols-4 gap-x-1.5 gap-y-3">
        {shown.map((p) => {
          const m = found.get(p.id);
          const label = SHORT[p.id] ?? p.label;
          const content = (
            <>
              <span
                className={cx(
                  "relative flex h-14 w-14 items-center justify-center rounded-full text-[26px] transition",
                  m
                    ? "bg-[#C49A3C]/20 shadow-[inset_0_0_0_2px_rgba(196,154,60,0.8)] dark:bg-[#C49A3C]/25"
                    : "border-2 border-dashed border-[#5C7A4A]/35 opacity-55 grayscale-[70%] dark:border-[#A9C08F]/30"
                )}
                aria-hidden
              >
                {p.emoji}
                {m && (
                  <span className="absolute -right-0.5 -bottom-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#1D4420] text-[10px] font-bold text-white dark:bg-[#C49A3C] dark:text-[#14210F]">
                    ✓
                  </span>
                )}
              </span>
              <span className={cx(m ? tone.body : tone.muted, "line-clamp-2 text-[11px] leading-tight font-semibold")}>{label}</span>
              <span className={cx(tone.muted, "text-[10px] leading-none")}>
                {m ? ageShort(bornAt, m.started_at, tz) ?? shortDate(dayKey(new Date(m.started_at), tz)) : "someday"}
              </span>
            </>
          );
          const cls = "flex w-full flex-col items-center gap-1 rounded-2xl px-0.5 py-1 text-center";
          return (
            <li key={p.id}>
              {m ? (
                <button type="button" className={cx(cls, "active:scale-95")} onClick={() => onOpen(m)} aria-label={`${p.label}: open the moment`}>
                  {content}
                </button>
              ) : viewer ? (
                <div className={cls} aria-label={`${p.label}: still to come`}>
                  {content}
                </div>
              ) : (
                <button type="button" className={cx(cls, "active:scale-95")} onClick={() => onAdd(p.id)} aria-label={`${p.label}: add it`}>
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {ordered.length > SHELF_COLLAPSED && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-full text-sm font-semibold text-[#1D4420] dark:text-[#E0C27A]"
        >
          {all ? "Show fewer" : `Show all ${ordered.length} firsts`} <span aria-hidden className="ml-1">{all ? "▴" : "▾"}</span>
        </button>
      )}
    </section>
  );
}

// ── Growing up (monthly photos) ──────────────────────────────────────────

function GrowingUp({
  moments,
  bornAt,
  tz,
  now,
  viewer,
  onOpen,
  onAdd,
}: {
  moments: Moment[];
  bornAt: string;
  tz: string;
  now: Date;
  viewer: boolean;
  onOpen: (m: Moment) => void;
  onAdd: (preset: Record<string, unknown>) => void;
}) {
  const months = babyAge(bornAt, now, tz).months;
  const byMonth = new Map<number, Moment>();
  // Newest first, so the latest photo for a month wins.
  for (const m of moments) {
    const k = monthlyNumber(m.data.milestone);
    if (k != null && m.id > 0 && !byMonth.has(k)) byMonth.set(k, m);
  }

  return (
    <section className="mb-7" aria-label="Growing up">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className={cx(tone.heading, "text-xl")}>Growing up</h2>
        <span className={cx(tone.muted, "text-xs")}>a photo each month-day</span>
      </div>
      <div className="-mx-4 overflow-x-auto px-4 pt-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ol className="flex w-max gap-3">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((k) => {
            const m = byMonth.get(k);
            const due = k <= months;
            const date = shortDate(monthDayKey(bornAt, k, tz));
            const face = m ? (
              photoCount(m) ? (
                <SafeImg src={photoUrl(m.id, 0)} className="h-[68px] w-full object-cover" />
              ) : (
                <span className="flex h-[68px] items-center justify-center bg-[#E8C8B8]/40 text-2xl" aria-hidden>
                  🧸
                </span>
              )
            ) : (
              <span
                className={cx(
                  "flex h-[68px] items-center justify-center border-2 border-dashed text-lg",
                  due ? "border-[#C49A3C]/70 text-[#8A6A1F]" : "border-[#5C7A4A]/25 text-[#5C7A4A]/50"
                )}
                aria-hidden
              >
                {due && !viewer ? "+" : "🍃"}
              </span>
            );
            const polaroid = (
              <>
                <span
                  className={cx(
                    "block w-[76px] rounded-[3px] bg-[#FFFDF7] p-1 pb-0 shadow-[0_1px_2px_rgba(29,68,32,0.12),0_8px_16px_-10px_rgba(29,68,32,0.5)] dark:bg-[#ECE5D5]",
                    NIGHT_DIM
                  )}
                  style={{ transform: `rotate(${(seeded(k, 3) * 4 - 2).toFixed(1)}deg)` }}
                >
                  {face}
                  <span className="block py-0.5 text-center font-[family-name:var(--font-display)] text-base leading-tight font-semibold text-[#1D4420] italic lining-nums">
                    {k}
                  </span>
                </span>
                <span className={cx(tone.muted, "mt-1.5 block text-center text-[10px]")}>{date}</span>
              </>
            );
            const label = `Month ${k}, ${date}`;
            return (
              <li key={k} className={cx(!m && !due && "opacity-60")}>
                {m ? (
                  <button type="button" onClick={() => onOpen(m)} aria-label={`${label}: open`} className="block">
                    {polaroid}
                  </button>
                ) : due && !viewer ? (
                  <button
                    type="button"
                    onClick={() => onAdd({ title: `${k} month${k === 1 ? "" : "s"} old`, milestone: monthlyId(k) })}
                    aria-label={`${label}: add her month ${k} photo`}
                    className="block"
                  >
                    {polaroid}
                  </button>
                ) : (
                  <div aria-label={`${label}: not yet`}>{polaroid}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ── Scrapbook ────────────────────────────────────────────────────────────

function Scrapbook({
  moments,
  bornAt,
  tz,
  todayKey,
  rev,
  onOpen,
}: {
  moments: Moment[];
  bornAt: string | null;
  tz: string;
  todayKey: string;
  rev: string;
  onOpen: (m: Moment) => void;
}) {
  const weeks = useMemo(() => groupByWeek(moments, bornAt, tz), [moments, bornAt, tz]);
  return (
    <div className="space-y-9">
      {weeks.map((w) => (
        <section key={w.id} aria-label={w.n ? `Week ${w.n}` : "Before she arrived"}>
          <div className="mb-1 flex items-baseline gap-2 border-b border-dashed border-[#1D4420]/15 px-1 pb-1.5 dark:border-[#F5EDDF]/15">
            <h2 className={cx(tone.heading, "text-[22px] lining-nums")}>{w.n ? `Week ${w.n}` : "Before she arrived"}</h2>
            {w.startKey && w.endKey && <span className={cx(tone.muted, "text-sm")}>· {rangeLabel(w.startKey, w.endKey, todayKey)}</span>}
          </div>
          {w.n && w.startKey && w.endKey ? (
            <WeekStats n={w.n} startKey={w.startKey} endKey={w.endKey} tz={tz} current={w.endKey >= todayKey} rev={rev} />
          ) : (
            <div className="h-3" />
          )}
          <ul className="mt-4 grid grid-cols-2 items-start gap-x-4 gap-y-7 px-1">
            {w.moments.map((m, i) => (
              <li key={m.id}>
                <Print moment={m} index={i} bornAt={bornAt} tz={tz} todayKey={todayKey} onOpen={() => onOpen(m)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const statCache = new Map<string, string>();

/** "78 diapers · 61 feeds · longest sleep 3h 10m", fetched when the page scrolls into view. */
function WeekStats({
  n,
  startKey,
  endKey,
  tz,
  current,
  rev,
}: {
  n: number;
  startKey: string;
  endKey: string;
  tz: string;
  current: boolean;
  rev: string;
}) {
  const { api, now } = useMaple();
  const ref = useRef<HTMLParagraphElement>(null);
  const cacheKey = `${startKey}|${current ? rev : ""}`;
  const [line, setLine] = useState<string | null>(() => statCache.get(cacheKey) ?? null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const cached = statCache.get(cacheKey);
    if (cached != null) {
      setLine(cached);
      return;
    }
    let live = true;
    api<{ entries: Entry[] }>(`/api/maple/entries?from=${startKey}&to=${endKey}&kind=feed,diaper,sleep&limit=5000`)
      .then(({ entries }) => {
        const s = statsFor(entries, dayBounds(startKey, tz)[0], dayBounds(endKey, tz)[1], startKey, now());
        const bits: string[] = [];
        if (s.diapers) bits.push(`${s.diapers} diaper${s.diapers === 1 ? "" : "s"}`);
        if (s.feeds) bits.push(`${s.feeds} feed${s.feeds === 1 ? "" : "s"}`);
        // No sleep "records" in the first two weeks: newborns shouldn't go long stretches.
        if (n >= 3 && s.longestSleepSec >= 1800) bits.push(`longest sleep ${formatDuration(s.longestSleepSec)}`);
        const text = bits.length ? `${current ? "So far: " : ""}${bits.join(" · ")}` : "";
        statCache.set(cacheKey, text);
        if (live) setLine(text);
      })
      .catch(() => {
        // The stat line is a garnish; leave it off.
      });
    return () => {
      live = false;
    };
  }, [api, cacheKey, current, endKey, n, now, startKey, tz, visible]);

  return (
    <p ref={ref} className={cx(tone.muted, "min-h-[1.25rem] px-1 font-[family-name:var(--font-display)] text-[15px] italic")}>
      {line}
    </p>
  );
}

function Print({
  moment: m,
  index,
  bornAt,
  tz,
  todayKey,
  onOpen,
}: {
  moment: Moment;
  index: number;
  bornAt: string | null;
  tz: string;
  todayKey: string;
  onOpen: () => void;
}) {
  const count = photoCount(m);
  const saving = m.id < 0;
  const p = m.data.photos?.[0];
  const landscape = !!(p?.w && p?.h && p.w > p.h * 1.1);
  const aspect = landscape ? "aspect-[5/4]" : "aspect-[4/5]";
  const caption = captionOf(m);
  const meta = ageAt(bornAt, m.started_at, tz) ?? formatDayLabel(dayKey(new Date(m.started_at), tz), todayKey);
  const style = {
    "--tilt": `${(seeded(Math.abs(m.id), 1) * 6 - 3).toFixed(2)}deg`,
    "--delay": `${Math.min(index, 6) * 70}ms`,
    "--tape-tilt": `${(seeded(Math.abs(m.id), 2) * 8 - 4).toFixed(1)}deg`,
    padding: "0.5rem 0.5rem 0.75rem",
  } as CSSProperties;
  const tape = TAPES[Math.abs(m.id) % TAPES.length];

  return (
    <button
      type="button"
      onClick={onOpen}
      style={style}
      aria-label={`${caption}, ${meta}${count > 1 ? `, ${count} photos` : ""}`}
      className={cx(
        "print block w-full text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#C49A3C]",
        NIGHT_DIM
      )}
    >
      <span className={`print-tape print-tape--${tape}`} aria-hidden />
      <span className="relative block">
        {count ? (
          <SafeImg src={photoUrl(m.id, 0)} className={aspect} />
        ) : (
          <NoteFace moment={m} saving={saving} aspect={saving && m.data.photos?.length ? aspect : "aspect-square"} />
        )}
        {count > 1 && (
          <span className="absolute top-1.5 right-1.5 rounded-full bg-[#0B1A0D]/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
            📷 {count}
          </span>
        )}
      </span>
      <span className="mt-2 block px-0.5">
        <span className="line-clamp-2 block font-[family-name:var(--font-display)] text-[17px] leading-[1.15] font-semibold text-[#1D4420] italic">
          {caption}
        </span>
        <span className="mt-1 block text-[11px] font-medium text-[#5C6B57]">{meta}</span>
      </span>
    </button>
  );
}

/** A moment with no photo: a pressed-leaf card with its emoji and a line of the note. */
function NoteFace({ moment: m, saving, aspect }: { moment: Moment; saving: boolean; aspect: string }) {
  const emoji = saving && m.data.photos?.length ? "🍃" : milestoneEmoji(m.data.milestone) ?? "✨";
  return (
    <span
      className={cx(
        "flex w-full flex-col items-center justify-center gap-1.5 bg-[radial-gradient(circle_at_30%_20%,#F6E9DC,#E9EFE0_70%)] p-3 text-center",
        aspect,
        saving && "animate-pulse"
      )}
    >
      <span className="text-4xl" aria-hidden>
        {emoji}
      </span>
      {saving ? (
        <span className="text-[11px] font-medium text-[#5C6B57]">Saving…</span>
      ) : (
        m.note &&
        captionOf(m) !== m.note && (
          <span className="line-clamp-3 font-[family-name:var(--font-display)] text-[13px] leading-snug text-[#3D4A39] italic">
            “{m.note}”
          </span>
        )
      )}
    </span>
  );
}

/** An image that becomes a soft leaf if the proxy can't serve it. */
function SafeImg({ src, className, alt = "" }: { src: string; className?: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) {
    return (
      <span
        role="img"
        aria-label="Photo unavailable"
        className={cx(
          "flex w-full items-center justify-center bg-[linear-gradient(160deg,#E4ECD9,#F3E6D8)] text-3xl",
          className
        )}
      >
        <span aria-hidden>🍃</span>
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy, not the image optimizer
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} className={className} />;
}

// ── Empty & loading ──────────────────────────────────────────────────────

function EmptyScrapbook({ viewer, onAdd }: { viewer: boolean; onAdd: () => void }) {
  return (
    <div className="mb-8 flex flex-col items-center px-4 pt-2 text-center">
      <div
        className="print w-40"
        style={{ "--tilt": "-3deg", "--delay": "80ms", "--tape-tilt": "-4deg", padding: "0.5rem 0.5rem 0.75rem" } as CSSProperties}
        aria-hidden
      >
        <span className="print-tape print-tape--blush" />
        <span className="flex aspect-[4/5] items-center justify-center border-2 border-dashed border-[#5C7A4A]/30 bg-[#F3EFE4] text-4xl">
          🌱
        </span>
        <span className="mt-2 block font-[family-name:var(--font-display)] text-[15px] text-[#5C6B57] italic">her first photo</span>
      </div>
      <p className={cx(tone.heading, "mt-6 text-2xl")}>No moments yet.</p>
      <p className={cx(tone.muted, "mt-1 text-[15px]")}>Her first photo goes here. Tiny toes count.</p>
      {!viewer && (
        <Button variant="primary" className="mt-4" onClick={onAdd}>
          📷 Add a photo
        </Button>
      )}
    </div>
  );
}

function LoadingPrints() {
  return (
    <div className="mb-8 grid grid-cols-2 gap-x-4 gap-y-7 px-1" aria-label="Loading moments">
      {[0, 1].map((i) => (
        <div key={i} className="print animate-pulse" style={{ "--tilt": i ? "2deg" : "-2deg", "--delay": "0ms", "--tape-tilt": "0deg" } as CSSProperties}>
          <span className="block aspect-[4/5] bg-[#5C7A4A]/15" />
        </div>
      ))}
    </div>
  );
}

// ── Lightbox ─────────────────────────────────────────────────────────────

function Lightbox({
  slides,
  index,
  onIndex,
  onClose,
  onEdit,
  bornAt,
  tz,
}: {
  slides: Slide[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onEdit?: (m: Moment) => void;
  bornAt: string | null;
  tz: string;
}) {
  const { memberName, member, now } = useMaple();
  const reduce = useReducedMotion();
  const openNow = index >= 0;
  const [dir, setDir] = useState(0);
  const [night, setNight] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const go = useCallback(
    (d: number) => {
      const next = index + d;
      if (next < 0 || next >= slides.length) return;
      setDir(d);
      onIndex(next);
    },
    [index, onIndex, slides.length]
  );

  useEffect(() => {
    if (!openNow) return;
    // Portaled to <body>, so look for the night class on the page instead of an ancestor.
    setNight(!!document.querySelector(".maple-night"));
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      back?.focus?.();
    };
  }, [openNow]);

  useEffect(() => {
    if (!openNow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, onClose, openNow]);

  // Warm the neighbors so a swipe lands on a loaded photo.
  useEffect(() => {
    if (!openNow) return;
    for (const d of [1, -1]) {
      const s = slides[index + d];
      if (s && s.photo != null) new Image().src = photoUrl(s.entry.id, s.photo, "full");
    }
  }, [index, openNow, slides]);

  if (!mounted) return null;
  const slide = openNow ? slides[index] : null;

  return createPortal(
    <AnimatePresence>
      {slide && (
        <motion.div
          key="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Moment"
          className="ph-no-capture fixed inset-0 z-[85] flex flex-col bg-[#070F08] text-[#F5EDDF]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <div className="flex shrink-0 items-center gap-2 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className="flex-1 pl-3 text-sm font-semibold tabular-nums opacity-70">
              {index + 1} / {slides.length}
            </span>
            {onEdit && slide.entry.id > 0 && (
              <button
                type="button"
                onClick={() => onEdit(slide.entry)}
                className="flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-sm font-semibold hover:bg-white/10"
              >
                ✎ Edit
              </button>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-11 w-11 items-center justify-center rounded-full text-xl hover:bg-white/10"
            >
              ✕
            </button>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence initial={false} custom={dir} mode="popLayout">
              <motion.div
                key={`${slide.entry.id}-${slide.photo}`}
                custom={dir}
                className="absolute inset-0 flex items-center justify-center px-3 py-2"
                initial={reduce ? { opacity: 0 } : { x: dir >= 0 ? "60%" : "-60%", opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={reduce ? { opacity: 0 } : { x: dir >= 0 ? "-60%" : "60%", opacity: 0 }}
                transition={{ duration: reduce ? 0.1 : 0.25, ease: "easeOut" }}
                drag={slides.length > 1 ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.6}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -70 || info.velocity.x < -500) go(1);
                  else if (info.offset.x > 70 || info.velocity.x > 500) go(-1);
                }}
              >
                {slide.photo != null ? (
                  <FullPhoto entryId={slide.entry.id} index={slide.photo} dim={night} />
                ) : (
                  <div className="flex aspect-square w-full max-w-xs flex-col items-center justify-center gap-3 rounded-[4px] bg-[#ECE5D5] p-6 text-center text-[#1D4420]">
                    <span className="text-6xl" aria-hidden>
                      {milestoneEmoji(slide.entry.data.milestone) ?? "✨"}
                    </span>
                    <span className="font-[family-name:var(--font-display)] text-2xl leading-tight font-semibold italic">
                      {captionOf(slide.entry)}
                    </span>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
            {index > 0 && <NavArrow side="left" onClick={() => go(-1)} />}
            {index < slides.length - 1 && <NavArrow side="right" onClick={() => go(1)} />}
          </div>

          <Caption slide={slide} bornAt={bornAt} tz={tz} now={now()} who={memberName(slide.entry.created_by)} avatar={member(slide.entry.created_by)} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function NavArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={cx(
        "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/35 text-xl text-white/90 backdrop-blur-sm hover:bg-black/50",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}

/** Thumb first (usually cached), then the full image fades in over it. */
function FullPhoto({ entryId, index, dim }: { entryId: number; index: number; dim: boolean }) {
  const [full, setFull] = useState<"loading" | "ok" | "broken">("loading");
  const [thumbBroken, setThumbBroken] = useState(false);
  const cls = cx("max-h-full max-w-full rounded-[3px] object-contain select-none", dim && "brightness-[.55] saturate-[.8]");
  if (full === "broken" && thumbBroken) {
    return (
      <div className="flex aspect-[4/5] w-full max-w-xs flex-col items-center justify-center gap-2 rounded-[4px] bg-[linear-gradient(160deg,#2A3B25,#3A2E26)] text-center">
        <span className="text-5xl" aria-hidden>
          🍃
        </span>
        <span className="text-sm text-[#E8DCC0]/80">This photo is resting. Try again later.</span>
      </div>
    );
  }
  return (
    <div className="relative flex h-full w-full items-center justify-center" draggable={false}>
      {full !== "ok" && !thumbBroken && (
        // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy
        <img src={photoUrl(entryId, index, "thumb")} alt="" draggable={false} onError={() => setThumbBroken(true)} className={cx(cls, "absolute blur-[1px]")} />
      )}
      {full !== "broken" && (
        // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy
        <img
          src={photoUrl(entryId, index, "full")}
          alt=""
          draggable={false}
          onLoad={() => setFull("ok")}
          onError={() => setFull("broken")}
          className={cx(cls, "relative transition-opacity duration-300", full === "ok" ? "opacity-100" : "opacity-0")}
        />
      )}
    </div>
  );
}

function Caption({
  slide,
  bornAt,
  tz,
  now,
  who,
  avatar,
}: {
  slide: Slide;
  bornAt: string | null;
  tz: string;
  now: Date;
  who: string;
  avatar: Member | null;
}) {
  const m = slide.entry;
  const at = new Date(m.started_at);
  const age = ageAt(bornAt, m.started_at, tz);
  const milestone = m.data.milestone ? milestoneLabel(m.data.milestone) : null;
  const title = captionOf(m);
  const via = m.source === "claude" ? " via Claude" : m.source === "chatgpt" ? " via ChatGPT" : m.source === "mcp" ? " via AI" : "";
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {milestone && milestone !== title && (
        <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-[#C49A3C]/25 px-2.5 py-0.5 text-xs font-semibold text-[#F1D58F]">
          <span aria-hidden>{milestoneEmoji(m.data.milestone) ?? "✨"}</span> {milestone}
        </span>
      )}
      <p className="font-[family-name:var(--font-display)] text-[26px] leading-tight font-semibold italic">{title}</p>
      {m.note && m.note !== title && <p className="mt-1.5 text-[15px] leading-relaxed whitespace-pre-line text-[#E8DCC0]">{m.note}</p>}
      <p className="mt-2 text-[13px] text-[#E8DCC0]/75">
        {formatDayLabel(dayKey(at, tz), dayKey(now, tz))} · {formatTime(at, tz)}
        {age && <> · {age.charAt(0).toLowerCase() + age.slice(1)}</>}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-[#E8DCC0]/75">
        <Avatar member={avatar} size={20} /> Added by {who}
        {via}
      </p>
    </div>
  );
}

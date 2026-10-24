"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { statsFor } from "@/lib/maple/insights";
import { MILESTONES, milestoneLabel, monthlyId, monthlyNumber } from "@/lib/maple/milestones";
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
import { MAPLE_LEAF_PATH } from "./Hero";
import { Icon, KindBadge } from "./icons";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { Avatar, Button, Chip, EmptyState, SectionTitle, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Moments: Maple's keepsake. "Firsts" (found, then still to come), her
 * monthly photos lined up under "Growing up", and a scrapbook of moment
 * cards grouped by week of age, newest first, that open into a lightbox.
 * The photos carry the color; the frames stay plain.
 *
 * Photos only ever load through the family-only proxy (/api/maple/photo), by
 * position; a photo that can't load turns into a quiet placeholder instead of
 * a broken image. The whole tab is kept out of session replays (ph-no-capture).
 */

type Moment = EntryOf<"moment">;
type Slide = { entry: Moment; photo: number | null };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The shell adds .maple-night 8pm–7am: photos dim so they don't glare at 3am. */
const NIGHT_DIM = "[.maple-night_&]:brightness-[.55] [.maple-night_&]:saturate-[.8]";
/** Placeholder shimmer, still under reduced motion and at night. */
const PULSE = "animate-pulse motion-reduce:animate-none [.maple-night_&]:animate-none";
/** Found firsts listed before "Show all". */
const SHELF_COLLAPSED = 8;
/** "Still to come" chips shown before "Show all": just the next few. */
const TO_COME_COLLAPSED = 4;

const isMoment = (e: Entry): e is Moment => e.kind === "moment";
const photoCount = (m: Moment) => (m.id > 0 ? m.data.photos?.length ?? 0 : 0);
const captionOf = (m: Moment) => m.data.title || milestoneLabel(m.data.milestone) || m.note || "A little moment";
/** The note, when it says something the caption doesn't. */
const extraNote = (m: Moment) => (m.note && captionOf(m) !== m.note ? m.note : null);
/**
 * A photo-less slide in the lightbox shows a short note as its picture. A
 * long one would be cut off there, so it goes in the caption, in full.
 */
const pictureNote = (s: Slide) => {
  const note = s.photo == null ? extraNote(s.entry) : null;
  return note && note.length <= 120 && !note.includes("\n") ? note : null;
};

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

/** Compact age for the Firsts list: "Day 3", "2w 3d", "3mo". */
function ageShort(bornAt: string | null, at: string, tz: string): string | null {
  if (!bornAt) return null;
  if (Date.parse(at) < Date.parse(bornAt)) return "Before birth";
  const age = babyAge(bornAt, new Date(at), tz);
  return age.days < 14 ? `Day ${age.dayOfLife}` : age.short;
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

/** Maple's leaf: the mark for a memory kept in words rather than a photo. */
function LeafMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="-11 -11 22 22" width={size} height={size} className={cx("shrink-0 text-mp-maple", className)} aria-hidden focusable="false">
      <path d={MAPLE_LEAF_PATH} fill="currentColor" />
    </svg>
  );
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
    <div className="ph-no-capture overflow-x-clip px-4 pb-8">
      {/* px-1 lines the title up with the section titles below it. */}
      <header className="mb-5 px-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="flex min-h-[44px] items-center justify-between gap-3">
          <h1 className={cx(tone.display, "text-[34px] leading-[1.05]")}>Moments</h1>
          {/* The empty scrapbook has its own "Add a photo"; one invitation is enough. */}
          {!viewer && moments?.length !== 0 && (
            <Button className="shrink-0" onClick={() => add()} aria-label="Add a moment">
              <Icon name="plus" size={18} strokeWidth={2.25} />
              Add
            </Button>
          )}
        </div>
        <p className={cx(tone.muted, "mt-1 text-[15px] leading-snug")}>Little leaves for {babyName}&apos;s someday-book</p>
      </header>

      <div className="space-y-6">
        {!viewer && bornAt && (
          <MonthlyPrompt bornAt={bornAt} tz={tz} now={n} moments={moments} name={babyName} onTake={add} />
        )}

        {error && !moments && (
          <div className={cx(tone.card, "p-4 text-center")}>
            <p className={cx(tone.body, "text-[15px]")}>Couldn&apos;t reach the scrapbook. {error}</p>
            <Button variant="soft" size="sm" className="mt-3" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}

        {!moments && !error && <LoadingCards />}

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
      </div>

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
    <div className={cx(tone.card, "relative flex gap-3 p-4 pr-12")}>
      <KindBadge kind="moment" size={40} />
      <div className="min-w-0 flex-1">
        <p className={cx(tone.heading, "text-[17px] leading-snug lining-nums")}>
          {since === 0 ? "Today" : "This week"} is {name}&apos;s <span className="whitespace-nowrap">{months}-month day</span>
        </p>
        <p className={cx(tone.muted, "mt-0.5 text-sm leading-snug")}>
          Take her monthly photo? Same spot, same blanket, and she lines up under “Growing up.”
        </p>
        <Button
          size="sm"
          className="mt-3"
          onClick={() => onTake({ title: `${months} month${months === 1 ? "" : "s"} old`, milestone: monthlyId(months) })}
        >
          <Icon name="camera" size={16} />
          Month {months} photo
        </Button>
      </div>
      <button
        type="button"
        onClick={skip}
        aria-label="Not this month"
        className="absolute top-1.5 right-1.5 flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-3"
      >
        <Icon name="x" size={18} />
      </button>
    </div>
  );
}

// ── Firsts ───────────────────────────────────────────────────────────────

/** Shorter names for the "still to come" chips (the found list has room for the full label). */
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
  // Found ones as a list (with when), the rest as light chips to tap and add.
  // Folded, the list keeps its first few and only the next few to come show
  // (MILESTONES runs roughly in the order they happen); the rest wait behind "Show all".
  const shownFound = all ? achieved : achieved.slice(0, SHELF_COLLAPSED);
  const shownToCome = all ? upcoming : upcoming.slice(0, TO_COME_COLLAPSED);
  const folds = achieved.length > SHELF_COLLAPSED || upcoming.length > TO_COME_COLLAPSED;

  return (
    <section aria-label="Firsts">
      <SectionTitle
        action={
          <span className={cx(tone.faint, "text-[13px]")}>
            {achieved.length ? `${achieved.length} of ${MILESTONES.length} found` : "All still to come"}
          </span>
        }
      >
        Firsts
      </SectionTitle>
      <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
        {shownFound.length > 0 && (
          <ul className={tone.divide}>
            {shownFound.map((p) => {
              const m = found.get(p.id)!;
              return (
                <li key={p.id}>
                  <button type="button" className={cx(tone.row, "min-h-[52px] py-2.5")} onClick={() => onOpen(m)} aria-label={`${p.label}: open the moment`}>
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent" aria-hidden>
                      <Icon name="check" size={14} strokeWidth={2.75} />
                    </span>
                    <span className={cx(tone.body, "min-w-0 flex-1 text-[15px] leading-snug font-medium")}>{p.label}</span>
                    <span className={cx(tone.muted, "shrink-0 text-[13px] tabular-nums")}>
                      {ageShort(bornAt, m.started_at, tz) ?? shortDate(dayKey(new Date(m.started_at), tz))}
                    </span>
                    <Icon name="chevron-right" size={18} className="-mr-1 shrink-0 text-mp-ink-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {shownToCome.length > 0 && (
          <div className="px-4 pt-3.5 pb-4">
            {achieved.length > 0 && <p className={cx(tone.label, "mb-2.5")}>Still to come</p>}
            <ul className="flex flex-wrap gap-2">
              {shownToCome.map((p) => {
                const label = SHORT[p.id] ?? p.label;
                return (
                  <li key={p.id}>
                    {viewer ? (
                      // Not a button for viewers, so an outline rather than a tappable-looking chip.
                      <span className="inline-flex min-h-[40px] items-center rounded-full border border-dashed border-mp-ink-3/40 px-3.5 text-sm font-medium text-mp-ink-2">
                        <span aria-hidden>{label}</span>
                        <span className="sr-only">{p.label}: still to come</span>
                      </span>
                    ) : (
                      <Chip onClick={() => onAdd(p.id)} className="pl-3">
                        <Icon name="plus" size={15} className="text-mp-ink-3" />
                        <span aria-hidden>{label}</span>
                        <span className="sr-only">{p.label}: add it</span>
                      </Chip>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {folds && (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
            className="flex min-h-[48px] w-full items-center justify-center gap-1 text-[15px] font-medium text-mp-accent-fg"
          >
            {all ? "Show fewer" : `Show all ${ordered.length} firsts`}
            <Icon name={all ? "chevron-up" : "chevron-down"} size={16} />
          </button>
        )}
      </div>
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
  // Month-days fill in as they arrive: every one so far (a photo, or a gap to
  // fill), any photo that came early, and one quiet slot for the next one.
  // Months further off stay out of the strip rather than as empty squares.
  const next = months < 12 ? months + 1 : null;
  const shown = Array.from({ length: 12 }, (_, i) => i + 1).filter((k) => byMonth.has(k) || k <= months || k === next);

  // The newest month-days sit at the end of the strip: start there.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [months]);

  return (
    <section aria-label="Growing up">
      <SectionTitle action={<span className={cx(tone.faint, "text-[13px]")}>A photo each month-day</span>}>Growing up</SectionTitle>
      <div ref={strip} className="-mx-4 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ol className="flex w-max items-start gap-2.5">
          {shown.map((k) => {
            const m = byMonth.get(k);
            const due = k <= months;
            const canAdd = due && !viewer;
            const date = shortDate(monthDayKey(bornAt, k, tz));
            const label = `Month ${k}, ${date}`;
            if (!m && !due) {
              // The next month-day: not a button (her photo is taken on the day), just where it will go.
              return (
                <li key={k}>
                  <div className="flex h-[76px] items-center gap-3 rounded-[14px] border border-dashed border-mp-line bg-transparent pr-5 pl-4">
                    <Icon name="camera" size={22} className="shrink-0 text-mp-ink-3" />
                    <span className="whitespace-nowrap">
                      <span className={cx(tone.body, "block text-[15px] font-medium tabular-nums")}>
                        Month {k} · {date}
                      </span>
                      <span className={cx(tone.faint, "block text-[13px]")}>
                        {viewer ? "Her next monthly photo" : "Take her photo that day"}
                      </span>
                    </span>
                  </div>
                </li>
              );
            }
            const tile = (
              <>
                <span
                  className={cx(
                    "flex h-[76px] w-[76px] items-center justify-center overflow-hidden rounded-[14px]",
                    m
                      ? "border border-mp-line bg-mp-surface"
                      : canAdd
                        ? "border-[1.5px] border-dashed border-mp-accent-fg/45 text-mp-accent-fg"
                        : // A month-day that passed without a photo (viewers can't add one).
                          "border border-dashed border-mp-line bg-transparent text-mp-ink-3"
                  )}
                  aria-hidden
                >
                  {m ? (
                    photoCount(m) ? (
                      <SafeImg src={photoUrl(m.id, 0)} className="h-full w-full object-cover" />
                    ) : (
                      <LeafMark size={22} />
                    )
                  ) : canAdd ? (
                    <Icon name="plus" size={22} />
                  ) : null}
                </span>
                <span className={cx(tone.body, "mt-1.5 block text-center text-[12px] font-medium")}>Month {k}</span>
                <span className={cx(tone.faint, "block text-center text-[11px]")}>{date}</span>
              </>
            );
            return (
              <li key={k}>
                {m ? (
                  <button type="button" onClick={() => onOpen(m)} aria-label={`${label}: open`} className="block active:scale-[0.97]">
                    {tile}
                  </button>
                ) : canAdd ? (
                  <button
                    type="button"
                    onClick={() => onAdd({ title: `${k} month${k === 1 ? "" : "s"} old`, milestone: monthlyId(k) })}
                    aria-label={`${label}: add her month ${k} photo`}
                    className="block active:scale-[0.97]"
                  >
                    {tile}
                  </button>
                ) : (
                  <div>
                    {tile}
                    <span className="sr-only">No photo that month</span>
                  </div>
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
    <div className="space-y-6">
      {weeks.map((w) => (
        <section key={w.id} aria-label={w.n ? `Week ${w.n}` : "Before she arrived"}>
          <div className="mb-2.5 px-1">
            <div className="flex items-baseline gap-2">
              <h2 className={cx(tone.heading, "text-[17px]")}>{w.n ? `Week ${w.n}` : "Before she arrived"}</h2>
              {w.startKey && w.endKey && <span className={cx(tone.faint, "text-[13px]")}>{rangeLabel(w.startKey, w.endKey, todayKey)}</span>}
            </div>
            {w.n && w.startKey && w.endKey && (
              <WeekStats n={w.n} startKey={w.startKey} endKey={w.endKey} tz={tz} current={w.endKey >= todayKey} rev={rev} />
            )}
          </div>
          <ul className="grid grid-cols-2 items-start gap-3">
            {w.moments.map((m) => (
              <li key={m.id}>
                <MomentCard moment={m} bornAt={bornAt} tz={tz} todayKey={todayKey} onOpen={() => onOpen(m)} />
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
    <p ref={ref} className={cx(tone.muted, "mt-0.5 min-h-[1.25rem] text-[13px] tabular-nums")}>
      {line}
    </p>
  );
}

/**
 * One moment in the scrapbook: the photo edge to edge on a plain card with
 * the caption under it, or, with no photo, the words themselves.
 */
function MomentCard({
  moment: m,
  bornAt,
  tz,
  todayKey,
  onOpen,
}: {
  moment: Moment;
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
  // A first (or a monthly photo, a kept celebration) is named above the
  // caption, as in the lightbox, unless the caption already is its name.
  const first = milestoneLabel(m.data.milestone);
  const tag = first && first !== caption ? first : null;
  const note = count ? null : extraNote(m);
  const photosOnTheWay = saving && !!m.data.photos?.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${caption}, ${meta}${count > 1 ? `, ${count} photos` : ""}`}
      className={cx(
        tone.card,
        "block w-full overflow-hidden text-left transition active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mp-focus"
      )}
    >
      {count > 0 && (
        // Flex, so the photo sits flush (no inline-image gap) and a broken one centers its placeholder.
        <span className="relative flex">
          <SafeImg src={photoUrl(m.id, 0)} className={cx("w-full bg-mp-sunken object-cover", aspect)} />
          {count > 1 && (
            <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums [.maple-night_&]:text-mp-ink">
              <Icon name="images" size={12} strokeWidth={2} />
              {count}
            </span>
          )}
        </span>
      )}
      {photosOnTheWay && (
        <span className={cx("flex w-full flex-col items-center justify-center gap-1.5 bg-mp-sunken text-mp-ink-3", aspect, PULSE)}>
          <Icon name="image" size={24} />
          <span className="text-[12px] font-medium">Saving…</span>
        </span>
      )}
      <span className="block px-3 pt-2.5 pb-3">
        {!count && !photosOnTheWay && <LeafMark size={16} className="mb-2" />}
        {tag && <span className="mb-0.5 block text-[12px] leading-snug font-semibold text-mp-accent-fg">{tag}</span>}
        <span className={cx(tone.body, "line-clamp-2 block text-[15px] leading-snug font-semibold")}>{caption}</span>
        {note && (
          <span className={cx(tone.muted, "mt-1 line-clamp-4 block text-[14px] leading-snug")}>“{note}”</span>
        )}
        <span className={cx(tone.faint, "mt-1.5 block text-[12px]")}>
          {meta}
          {saving && !photosOnTheWay && " · Saving…"}
        </span>
      </span>
    </button>
  );
}

/** An image that becomes a quiet placeholder if the proxy can't serve it. */
function SafeImg({ src, className, alt = "" }: { src: string; className?: string; alt?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) {
    return (
      <span role="img" aria-label="Photo unavailable" className={cx("flex w-full items-center justify-center bg-mp-sunken text-mp-ink-3", className)}>
        <Icon name="image" size={22} />
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy, not the image optimizer
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} className={cx(className, NIGHT_DIM)} />;
}

// ── Empty & loading ──────────────────────────────────────────────────────

function EmptyScrapbook({ viewer, onAdd }: { viewer: boolean; onAdd: () => void }) {
  return (
    <div className={tone.card}>
      <EmptyState icon="camera" title="No moments yet">
        <p>Her first photo goes here. Tiny toes count.</p>
        {!viewer && (
          <Button className="mt-4" onClick={onAdd}>
            <Icon name="camera" size={18} />
            Add a photo
          </Button>
        )}
      </EmptyState>
    </div>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-2 items-start gap-3" role="status" aria-label="Loading moments">
      {[0, 1].map((i) => (
        <div key={i} className={cx(tone.card, "overflow-hidden", PULSE)}>
          <span className="block aspect-[4/5] bg-mp-sunken" />
          <span className="block space-y-2 p-3">
            <span className="block h-3 w-3/4 rounded-full bg-mp-sunken" />
            <span className="block h-2.5 w-1/3 rounded-full bg-mp-sunken" />
          </span>
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
  const night = useNightActive();
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
          // Photos are viewed on near-black whatever the theme: the .dark class
          // gives this layer the dark tokens. At night the page's own night
          // tokens (on <html>) already are that, in amber.
          className={cx("ph-no-capture fixed inset-0 z-[85] flex flex-col bg-mp-bg text-mp-ink", !night && "dark")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className={cx(tone.muted, "flex-1 pl-3 text-[13px] font-medium tabular-nums")}>
              {index + 1} of {slides.length}
            </span>
            {onEdit && slide.entry.id > 0 && (
              <button
                type="button"
                onClick={() => onEdit(slide.entry)}
                className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[15px] font-semibold text-mp-ink transition hover:bg-mp-ink/10"
              >
                <Icon name="pencil" size={17} />
                Edit
              </button>
            )}
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
                <Icon name="x" size={18} strokeWidth={2.25} />
              </span>
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
                  // No photo: the words are the picture (the caption below skips a note shown here).
                  <div className="flex aspect-square max-h-full w-full max-w-xs flex-col items-center justify-center gap-4 overflow-hidden rounded-[20px] border border-mp-line bg-mp-surface p-7 text-center">
                    <LeafMark size={30} />
                    <span className={cx(tone.display, "line-clamp-6 text-[24px] leading-tight lining-nums")}>
                      {pictureNote(slide) ? `“${pictureNote(slide)}”` : captionOf(slide.entry)}
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
        "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-mp-surface/80 text-mp-ink ring-1 ring-mp-line transition hover:bg-mp-surface",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      <Icon name={side === "left" ? "chevron-left" : "chevron-right"} size={22} />
    </button>
  );
}

/** Thumb first (usually cached), then the full image fades in over it. */
function FullPhoto({ entryId, index, dim }: { entryId: number; index: number; dim: boolean }) {
  const [full, setFull] = useState<"loading" | "ok" | "broken">("loading");
  const [thumbBroken, setThumbBroken] = useState(false);
  const cls = cx("max-h-full max-w-full rounded-[4px] object-contain select-none", dim && "brightness-[.55] saturate-[.8]");
  if (full === "broken" && thumbBroken) {
    return (
      <div className="flex aspect-[4/5] w-full max-w-xs flex-col items-center justify-center gap-3 rounded-[20px] border border-mp-line bg-mp-surface p-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-3">
          <Icon name="image" size={24} />
        </span>
        <span className={cx(tone.muted, "text-sm")}>This photo is resting. Try again later.</span>
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
  // A photo-less slide may already show its (short) note as the picture.
  const showNote = m.note && m.note !== title && !pictureNote(slide);
  const via = m.source === "claude" ? " via Claude" : m.source === "chatgpt" ? " via ChatGPT" : m.source === "mcp" ? " via AI" : "";
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {milestone && milestone !== title && <p className="mb-1 text-[13px] font-semibold text-mp-accent-fg">{milestone}</p>}
      <p className={cx(tone.display, "text-[26px] leading-tight lining-nums")}>{title}</p>
      {showNote && <p className={cx(tone.muted, "mt-1.5 text-[15px] leading-relaxed whitespace-pre-line")}>{m.note}</p>}
      <p className={cx(tone.faint, "mt-2.5 text-[13px]")}>
        {formatDayLabel(dayKey(at, tz), dayKey(now, tz))} · {formatTime(at, tz)}
        {age && <> · {age.charAt(0).toLowerCase() + age.slice(1)}</>}
      </p>
      <p className={cx(tone.faint, "mt-1 flex items-center gap-1.5 text-[13px]")}>
        <Avatar member={avatar} size={20} /> Added by {who}
        {via}
      </p>
    </div>
  );
}

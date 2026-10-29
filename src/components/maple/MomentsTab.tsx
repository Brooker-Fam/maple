"use client";

import AccountMenu from "./AccountMenu";

import { useEffect, useMemo, useRef, useState } from "react";
import { statsFor } from "@/lib/maple/insights";
import { milestoneLabel, milestonesFor, monthlyId, monthlyNumber } from "@/lib/maple/milestones";
import {
  addDays,
  babyAge,
  dayBounds,
  dayKey,
  daysBetween,
  formatDuration,
  localParts,
  parseDayKey,
} from "@/lib/maple/time";
import type { Entry, EntryOf } from "@/lib/maple/types";
import { photoUrl } from "./EntryRow";
import { AskChatButton } from "./chat/AskChat";
import MilestonesToNotice from "./development/MilestonesToNotice";
import { Icon, KindBadge } from "./icons";
import { LeafMark, ageShort, keptDate, keepsakeBirthAt } from "./keepsake";
import { captionOf, extraNote, Lightbox, SafeImg, type Slide } from "./MomentPhotos";
import { useMoments } from "./useMoments";
import { useSheets } from "./sheets";
import { useBabyWords, useMilestoneWords } from "./familyWords";
import { Button, Chip, EmptyState, SectionTitle, cx, tone } from "./ui";
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

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Placeholder shimmer, still under reduced motion and at night. */
const PULSE = "animate-pulse motion-reduce:animate-none [.maple-night_&]:animate-none";
/** Found firsts listed before "Show all". */
const SHELF_COLLAPSED = 8;
/** "Still to come" chips shown before "Show all": just the next few. */
const TO_COME_COLLAPSED = 4;

const photoCount = (m: Moment) => (m.id > 0 ? m.data.photos?.length ?? 0 : 0);
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
  const { state, now, readOnly } = useMaple();
  const { open } = useSheets();
  const { moments, highlights, all, error, moreError, loading, loadingMore, hasMore, load, loadMore } = useMoments();
  const [viewing, setViewing] = useState<{ id: number; photo: number | null } | null>(null);
  const rev = state?.rev;
  const tz = state?.baby.timezone ?? "America/New_York";
  const bornAt = keepsakeBirthAt(state?.baby);
  const viewer = readOnly;
  const babyName = state?.baby.name?.split(" ")[0] || "Baby";

  const slides = useMemo<Slide[]>(
    () =>
      all.flatMap((m): Slide[] =>
        photoCount(m) ? m.data.photos!.map((_, i) => ({ entry: m, photo: i })) : [{ entry: m, photo: null }]
      ),
    [all]
  );
  const slideIndex = viewing ? slides.findIndex((s) => s.entry.id === viewing.id && s.photo === viewing.photo) : -1;

  const show = (m: Moment, photo: number | null = photoCount(m) ? 0 : null) => setViewing({ id: m.id, photo });
  const add = (preset?: Record<string, unknown>) => open({ kind: "moment", preset });

  if (!state) return null;
  const n = now();
  const todayKey = dayKey(n, tz);

  return (
    <div className="ph-no-capture overflow-x-clip px-4 pb-8">
      {/* px-1 lines the title up with the section titles below it. A large title, no tagline. */}
      <header className="mb-5 px-1 pt-[max(1.25rem,env(safe-area-inset-top))]">
        <div className="flex min-h-[44px] items-center justify-between gap-3">
          <h1 className={cx(tone.display, "text-[34px] leading-[1.05]")}>Moments</h1>
          <div className="flex shrink-0 items-center gap-2">
            {!viewer && moments?.length !== 0 && (
              <Button className="shrink-0" onClick={() => add()} aria-label="Add a moment">
                <Icon name="plus" size={18} strokeWidth={2.25} />
                Add
              </Button>
            )}
            <AccountMenu />
          </div>
        </div>
      </header>

      {moments && moments.length > 0 && (
        <div className="mb-5">
          <AskChatButton
            label="Moments"
            prompt={`Can you write a short keepsake recap of ${babyName}'s saved moments and milestones from ${dayKey(new Date(moments[moments.length - 1].started_at), tz)} through ${todayKey} (${tz})? Use the saved titles and notes without inventing details or describing photos you cannot see.`}
          >
            Recap these moments in chat
          </AskChatButton>
        </div>
      )}

      <div className="space-y-6">
        {!viewer && bornAt && (
          <MonthlyPrompt bornAt={bornAt} tz={tz} now={n} moments={highlights} name={babyName} onTake={add} />
        )}

        {error && (
          <div role="alert" className={cx(tone.card, "p-4 text-center")}>
            <p className={cx(tone.body, "text-[15px]")}>{moments ? "Couldn't refresh moments. Showing the moments already loaded." : "Couldn't load moments. Check your connection and try again."}</p>
            <Button variant="soft" size="sm" className="mt-3" disabled={loading} onClick={() => void load()}>
              {loading ? "Retrying…" : "Retry"}
            </Button>
          </div>
        )}

        {!moments && !error && <LoadingCards />}

        {moments && moments.length === 0 && <EmptyScrapbook viewer={viewer} onAdd={() => add()} />}

        {highlights && (
          <MilestonesToNotice baby={state.baby} moments={highlights} viewer={viewer} onOpen={show} onAdd={add} />
        )}

        {highlights && (
          <FirstsShelf moments={highlights} bornAt={bornAt} tz={tz} viewer={viewer} onOpen={show} onAdd={(id) => add({ milestone: id })} />
        )}

        {highlights && bornAt && (
          <GrowingUp moments={highlights} bornAt={bornAt} tz={tz} now={n} viewer={viewer} onOpen={show} onAdd={add} />
        )}

        {moments && moments.length > 0 && (
          <Scrapbook moments={moments} bornAt={bornAt} tz={tz} todayKey={todayKey} rev={rev ?? ""} onOpen={show} />
        )}
        {hasMore && (
          <div className="text-center">
            {moreError && <p role="alert" className={cx(tone.muted, "mb-2 text-sm")}>Couldn&apos;t load older moments. Try again.</p>}
            <Button variant="soft" disabled={loadingMore || loading} onClick={() => void loadMore()}>
              {loadingMore ? "Loading older moments…" : "Load older moments"}
            </Button>
          </div>
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
  const w = useBabyWords();
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
          Take {w.his} monthly photo? Same spot, same blanket, and {w.he} lines up under “Growing up.”
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
const short: Record<string, string> = {
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
  const shortLabels = short;
  const presets = milestonesFor(useMilestoneWords());
  // The earliest moment for each first.
  const found = new Map<string, Moment>();
  for (const m of moments) if (m.data.milestone && m.id > 0) found.set(m.data.milestone, m);
  const achieved = presets.filter((p) => found.has(p.id)).sort(
    (a, b) => Date.parse(found.get(a.id)!.started_at) - Date.parse(found.get(b.id)!.started_at)
  );
  const upcoming = presets.filter((p) => !found.has(p.id));
  const ordered = [...achieved, ...upcoming];
  // Found ones as a list (with when), the rest as light chips to tap and add.
  // Folded, the list keeps its first few and only the next few to come show
  // (the presets run roughly in the order they happen); the rest wait behind "Show all".
  const shownFound = all ? achieved : achieved.slice(0, SHELF_COLLAPSED);
  const shownToCome = all ? upcoming : upcoming.slice(0, TO_COME_COLLAPSED);
  const folds = achieved.length > SHELF_COLLAPSED || upcoming.length > TO_COME_COLLAPSED;

  return (
    <section aria-label="Firsts">
      <SectionTitle
        action={
          <span className={cx(tone.faint, "text-[13px]")}>
            {achieved.length ? `${achieved.length} so far` : "No firsts recorded yet"}
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
                    {/* The leaf: a first, found and kept (not a to-do ticked off). */}
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden>
                      <LeafMark size={18} />
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
            {achieved.length > 0 && <p className={cx(tone.label, "mb-2.5")}>Not recorded yet</p>}
            <ul className="flex flex-wrap gap-2">
              {shownToCome.map((p) => {
                const label = shortLabels[p.id] ?? p.label;
                return (
                  <li key={p.id}>
                    {viewer ? (
                      // Not a button for viewers, so an outline rather than a tappable-looking chip.
                      <span className="inline-flex min-h-[40px] items-center rounded-full border border-dashed border-mp-ink-3/40 px-3.5 text-sm font-medium text-mp-ink-2">
                        <span aria-hidden>{label}</span>
                        <span className="sr-only">{p.label}: not recorded yet</span>
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
  const w = useBabyWords();
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
                        {viewer ? `${w.His} next monthly photo` : `Take ${w.his} photo that day`}
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
                    aria-label={`${label}: add ${w.his} month ${k} photo`}
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
  const words = useBabyWords();
  const before = `Before ${words.he} arrived`;
  return (
    <div className="space-y-6">
      {weeks.map((w) => (
        <section key={w.id} aria-label={w.n ? `Week ${w.n}` : before}>
          <div className="mb-2.5 px-1">
            <div className="flex items-baseline gap-2">
              <h2 className={cx(tone.heading, "text-[17px]")}>{w.n ? `Week ${w.n}` : before}</h2>
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
  const mw = useMilestoneWords();
  const count = photoCount(m);
  const saving = m.id < 0;
  const p = m.data.photos?.[0];
  const landscape = !!(p?.w && p?.h && p.w > p.h * 1.1);
  const aspect = landscape ? "aspect-[5/4]" : "aspect-[4/5]";
  const caption = captionOf(m, mw);
  // "Day 3 · Thu, Oct 22": the same age as the Firsts list, plus the day it happened.
  const meta = [ageShort(bornAt, m.started_at, tz), keptDate(dayKey(new Date(m.started_at), tz), todayKey)].filter(Boolean).join(" · ");
  // A first (or a monthly photo, a kept celebration) is named above the
  // caption, as in the lightbox, unless the caption already is its name.
  const first = milestoneLabel(m.data.milestone, mw);
  const tag = first && first !== caption ? first : null;
  const note = count ? null : extraNote(m, mw);
  const photosOnTheWay = saving && !!m.data.photos?.length;
  const words = !count && !photosOnTheWay;

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
        {tag && <span className="mb-0.5 block text-[12px] leading-snug font-semibold text-mp-accent-fg">{tag}</span>}
        {words ? (
          // No photo: the family's words are the keepsake, set like a note in the book.
          <span className={cx(tone.display, "line-clamp-5 block text-[19px] leading-[1.2] lining-nums")}>{caption}</span>
        ) : (
          <span className={cx(tone.body, "line-clamp-2 block text-[15px] leading-snug font-semibold")}>{caption}</span>
        )}
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

// ── Empty & loading ──────────────────────────────────────────────────────

function EmptyScrapbook({ viewer, onAdd }: { viewer: boolean; onAdd: () => void }) {
  const w = useBabyWords();
  return (
    <div className={tone.card}>
      <EmptyState icon="camera" title="No moments yet">
        <p>{w.His} first photo goes here.</p>
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

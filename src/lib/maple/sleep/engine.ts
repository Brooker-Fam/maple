/**
 * The sleep plan's engine: pure functions shared by the app, the REST routes
 * and the MCP tools (checked by scripts/maple-sleep-check.ts).
 *
 * - Her age for sleep guidance comes from born_at in her own timezone, in
 *   whole calendar days, chronological (sleep never uses corrected age).
 * - A try day runs from local noon to the next local noon, named by the date
 *   it starts, so a night's try and the next morning's nap fallback are one
 *   day. Built with zonedTimeToUtc, so a daylight-saving night is 23 or 25
 *   hours and nothing shifts.
 * - Try numbers and retries are worked out from the log (as feeds are),
 *   never stored: deleting or moving a try renumbers its day.
 * - A try never counts as sleep. It sits on one sleep entry; sleep totals
 *   come only from sleep entries, and "sleep by place" gives the try's window
 *   to the bassinet and the rest of that sleep to its own place.
 * - Nothing here changes the plan. The stage suggestion is only that.
 */
import { SLEEP_GUIDES, SLEEP_SECTIONS, sectionTitle, type GuideSource, type SleepGuide, type SleepSection, type SleepSignal } from "../guidelines/sleep";
import { addDays, babyAge, dayKey, daysBetween, DEFAULT_TZ, formatDayLabel, formatDuration, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "../time";
import type { Baby, Entry, EntryOf, SleepPlace } from "../types";
import type { Voice } from "../voice";
import { ASK_STALE_MS, MAX_SPAN_MS, PLAN_STAGES, TRY_OUTCOMES, type BassinetTry, type HoldingShift, type PlanStage, type SleepPlan, type TryOutcome, type TrySlot } from "./types";
import { OUTCOME_LABEL, SLEEP_PLACE_LABEL, TIME_OF_DAY, slotLabel, type TimeOfDay } from "./words";

const MIN = 60_000;
const HOUR = 60 * MIN;
const pad = (n: number) => String(n).padStart(2, "0");
const ms = (iso: string) => Date.parse(iso);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── age ──────────────────────────────────────────────────────────────────

export const AGE_BANDS = [
  { id: "first_weeks", label: "First two weeks", minDays: 0, maxDays: 13 },
  { id: "early", label: "2 to 6 weeks", minDays: 14, maxDays: 41 },
  { id: "settling", label: "6 weeks to 3 months", minDays: 42, maxDays: 89 },
  { id: "growing", label: "3 to 6 months", minDays: 90, maxDays: 179 },
  { id: "older", label: "6 months and up", minDays: 180, maxDays: Number.POSITIVE_INFINITY },
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export type SleepAge = {
  /** Whole calendar days since her birth date, in her timezone (0 on her birthday). */
  days: number;
  weeks: number;
  /** "13 days, 7 hours", as the rest of the app says it. */
  label: string;
  band: AgeBand;
};

/** Her age for sleep guidance, or null before she's born (or with a birth time still ahead). */
export function sleepAge(baby: Pick<Baby, "born_at" | "timezone">, now: Date): SleepAge | null {
  if (!baby.born_at) return null;
  const born = new Date(baby.born_at);
  if (!Number.isFinite(born.getTime()) || !Number.isFinite(now.getTime()) || born.getTime() > now.getTime()) return null;
  const tz = baby.timezone || DEFAULT_TZ;
  const days = Math.max(0, daysBetween(dayKey(born, tz), dayKey(now, tz)));
  const band = AGE_BANDS.find((b) => days >= b.minDays && days <= b.maxDays) ?? AGE_BANDS[AGE_BANDS.length - 1];
  return { days, weeks: Math.floor(days / 7), label: babyAge(born, now, tz).label, band };
}

// ── try days ─────────────────────────────────────────────────────────────

/** The try day an instant belongs to (local noon to the next local noon), named by the date it starts. */
export function tryDayKey(at: Date | number, tz: string): string {
  const p = localParts(at, tz);
  const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return p.hour < 12 ? addDays(key, -1) : key;
}

/** [noon, next noon) of a try day, as instants. 23 or 25 hours long across a daylight-saving change. */
export function tryDayBounds(key: string, tz: string): [Date, Date] {
  const a = parseDayKey(key);
  const b = parseDayKey(addDays(key, 1));
  return [zonedTimeToUtc(a.year, a.month, a.day, 12, 0, tz), zonedTimeToUtc(b.year, b.month, b.day, 12, 0, tz)];
}

/** "tonight", "last night", "Mon night" ("Mon, Oct 26 night" more than a week back). */
export function tryDayLabel(key: string, nowKey: string): string {
  const diff = daysBetween(key, nowKey);
  if (diff === 0) return "tonight";
  if (diff === 1) return "last night";
  const label = formatDayLabel(key, addDays(nowKey, 7));
  return `${diff < 7 ? label.split(",")[0] : label} night`;
}

// ── numbering and retries ────────────────────────────────────────────────

/** A try starting this soon after one she woke from (or was picked up from) is its retry. */
export const RETRY_WINDOW_MS = 30 * MIN;
const AWAKE_ENDINGS: ReadonlySet<TryOutcome> = new Set(["woke_calm", "woke_crying", "picked_up"]);

export type TryNumber = {
  /** Its try day. */
  day: string;
  /** 1, 2, … within its day, by start. */
  n: number;
  /** How many tries that day. */
  of: number;
  /** The second go after she woke or was picked up from the one before. */
  retry: boolean;
};

/** Rows a store read may include deleted ones; the app's state never does. */
const live = <T extends object>(xs: readonly T[]): T[] => xs.filter((x) => !(x as { deleted_at?: unknown }).deleted_at);
const byStart = (a: Pick<BassinetTry, "started_at" | "id">, b: Pick<BassinetTry, "started_at" | "id">) => ms(a.started_at) - ms(b.started_at) || a.id - b.id;

export function numberTries(tries: readonly BassinetTry[], tz: string): Map<number, TryNumber> {
  const sorted = live(tries).slice().sort(byStart);
  const out = new Map<number, TryNumber>();
  const perDay = new Map<string, number>();
  let prev: BassinetTry | null = null;
  for (const t of sorted) {
    const day = tryDayKey(ms(t.started_at), tz);
    const n = (perDay.get(day) ?? 0) + 1;
    perDay.set(day, n);
    const retry = !!prev && !!prev.ended_at && !!prev.outcome && AWAKE_ENDINGS.has(prev.outcome) && ms(t.started_at) - ms(prev.ended_at) <= RETRY_WINDOW_MS && ms(t.started_at) >= ms(prev.ended_at) - 1500;
    out.set(t.id, { day, n, of: 0, retry });
    prev = t;
  }
  for (const v of out.values()) v.of = perDay.get(v.day) ?? v.n;
  return out;
}

/** Tries counted against the plan's tries a day: a retry belongs to the try before it. */
export function plannedTriesOn(tries: readonly BassinetTry[], key: string, tz: string): number {
  const nums = numberTries(tries, tz);
  return [...nums.values()].filter((n) => n.day === key && !n.retry).length;
}

// ── the sleep entry a try sits on ────────────────────────────────────────

type SleepEntry = EntryOf<"sleep">;
const isSleep = (e: Entry): e is SleepEntry => e.kind === "sleep";
const endOf = (e: Pick<Entry, "started_at" | "ended_at" | "active">, now: number) => (e.ended_at ? ms(e.ended_at) : e.active ? now : ms(e.started_at));

export type SleepLink = { kind: "running"; entry: SleepEntry } | { kind: "overlap"; entry: SleepEntry } | { kind: "create" };

/**
 * Which sleep entry a try between `start` and `end` (null: she's still down)
 * belongs to: the running sleep timer, else the logged sleep it overlaps
 * most (nearest start on a tie), else none (the try makes one).
 */
export function chooseSleepLink(start: number, end: number | null, entries: readonly Entry[], now: number): SleepLink {
  const sleeps = entries.filter(isSleep);
  const until = end ?? now;
  const running = sleeps.find((e) => e.active && ms(e.started_at) <= until + 1000);
  if (running && end == null) return { kind: "running", entry: running };
  let best: { e: SleepEntry; overlap: number; gap: number } | null = null;
  for (const e of sleeps) {
    const s = ms(e.started_at);
    const en = endOf(e, now);
    const overlap = Math.min(en, Math.max(until, start + 1000)) - Math.max(s, start);
    if (overlap <= 0) continue;
    const gap = Math.abs(s - start);
    if (!best || overlap > best.overlap || (overlap === best.overlap && gap < best.gap)) best = { e, overlap, gap };
  }
  if (best) return { kind: best.e.active ? "running" : "overlap", entry: best.e };
  return { kind: "create" };
}

/** She woke at the try's end, so the sleep it sits on ended then too; picked up still asleep, it runs on. */
export const endsSleep = (o: TryOutcome) => o !== "picked_up";

/** Two instants this close name the same moment (JS ms against Postgres µs, a re-save). */
export const SAME_MS = 1500;

/**
 * Where a linked sleep's start and end go when a try's times change: only an
 * edge that matched the try's old one moves with it (a sleep the try made
 * starts when she was laid down; one she woke from ends when the try did).
 * Null when the sleep stays as it is.
 */
export function followSleep(
  old: { start: number; end: number | null },
  next: { start: number; end: number | null },
  sleep: { start: number; end: number | null }
): { start?: number; end?: number } | null {
  const out: { start?: number; end?: number } = {};
  if (next.start !== old.start && Math.abs(sleep.start - old.start) <= SAME_MS) out.start = next.start;
  if (old.end != null && next.end != null && next.end !== old.end && sleep.end != null && Math.abs(sleep.end - old.end) <= SAME_MS) out.end = next.end;
  const s = out.start ?? sleep.start;
  const e = out.end ?? sleep.end;
  if (e != null && e < s) return null;
  return out.start === undefined && out.end === undefined ? null : out;
}

// ── sleep by place ───────────────────────────────────────────────────────

export type PlaceKey = SleepPlace | "unknown";
export type PlaceTotal = { place: PlaceKey; label: string; sec: number; sleeps: number };
export type Stretch = { start: number; end: number; sleepId: number };

/** The union of intervals, merged and sorted. */
function union(xs: [number, number][]): [number, number][] {
  const sorted = xs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const clip = ([a, b]: [number, number], lo: number, hi: number): [number, number] => [Math.max(a, lo), Math.min(b, hi)];
const len = (xs: [number, number][]) => xs.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);

/**
 * Logged sleep in [from, to) by where it happened: the window of each try
 * that sits on a sleep counts as the bassinet, the rest of that sleep as its
 * own place ("unknown" when none was recorded). Every second of sleep counts
 * once: the places add up to the total. Bassinet stretches are each sleep's
 * bassinet parts, whole (not cut at the window), for "longest stretch".
 */
export function sleepByPlace(entries: readonly Entry[], tries: readonly BassinetTry[], from: number, to: number, now: number): { totalSec: number; places: PlaceTotal[]; stretches: Stretch[] } {
  const sec = new Map<PlaceKey, number>();
  const count = new Map<PlaceKey, number>();
  const stretches: Stretch[] = [];
  const add = (p: PlaceKey, msLen: number) => {
    if (msLen <= 0) return;
    sec.set(p, (sec.get(p) ?? 0) + msLen);
  };
  let total = 0;
  const onSleep = new Map<number, BassinetTry[]>();
  for (const t of live(tries)) if (t.sleep_entry_id != null) onSleep.set(t.sleep_entry_id, [...(onSleep.get(t.sleep_entry_id) ?? []), t]);
  for (const e of entries) {
    if (!isSleep(e)) continue;
    const s = ms(e.started_at);
    const en = endOf(e, now);
    if (en <= s) continue;
    const span = clip([s, en], from, to);
    if (span[1] <= span[0]) continue;
    total += span[1] - span[0];
    const whole: [number, number] = [s, en];
    const bassinet = e.data.place === "bassinet" ? [whole] : union((onSleep.get(e.id) ?? []).map((t) => clip([ms(t.started_at), t.ended_at ? ms(t.ended_at) : now], s, en)));
    for (const [a, b] of bassinet) stretches.push({ start: a, end: b, sleepId: e.id });
    const inWindow = bassinet.map((x) => clip(x, span[0], span[1]));
    const bassinetMs = len(inWindow);
    const restMs = span[1] - span[0] - bassinetMs;
    const rest: PlaceKey = e.data.place && e.data.place !== "bassinet" ? e.data.place : "unknown";
    add("bassinet", bassinetMs);
    add(rest, restMs);
    if (bassinetMs > 0) count.set("bassinet", (count.get("bassinet") ?? 0) + 1);
    if (restMs > 0) count.set(rest, (count.get(rest) ?? 0) + 1);
  }
  const places = [...sec.entries()]
    .map(([place, v]) => ({ place, label: SLEEP_PLACE_LABEL[place], sec: Math.round(v / 1000), sleeps: count.get(place) ?? 0 }))
    .sort((a, b) => b.sec - a.sec || a.place.localeCompare(b.place));
  return { totalSec: Math.round(total / 1000), places, stretches };
}

// ── progress ─────────────────────────────────────────────────────────────

/** Patterns stay "too early" until this many finished tries, and each group compared needs this many. */
export const EARLY_MIN_TRIES = 10;
export const EARLY_MIN_GROUP = 3;
/** Two groups must differ by at least this share before a line says so. */
const EARLY_MIN_DIFF = 0.3;

export function timeOfDay(at: number, tz: string): TimeOfDay {
  const h = localParts(at, tz).hour;
  return TIME_OF_DAY.find((b) => h >= b.from && h < b.to)!.id;
}

export type OutcomeCounts = Record<TryOutcome, number>;
const noOutcomes = (): OutcomeCounts => Object.fromEntries(TRY_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts;

export type SleepProgress = {
  from: string;
  to: string;
  /** Try days covered. */
  days: number;
  tries: number;
  finished: number;
  running: number;
  /** Try days with at least one try. */
  tryDays: number;
  outcomes: OutcomeCounts;
  stayedAsleep: { n: number; of: number };
  /** Median minutes down over finished tries, null with none. */
  medianMinutesDown: number | null;
  longestBassinet: { sec: number; start: string; end: string } | null;
  places: PlaceTotal[];
  totalSleepSec: number;
  byTimeOfDay: { part: TimeOfDay; label: string; tries: number; outcomes: OutcomeCounts }[];
  /** Plain lines, each starting "Early observation"; empty until there's enough. */
  observations: string[];
  /** Enough finished tries for early observations. */
  enough: boolean;
};

/** The last `days` try days, ending with the current one: [from, to). */
export function progressWindow(now: Date, tz: string, days = 7): { from: Date; to: Date; keys: string[] } {
  const cur = tryDayKey(now, tz);
  const first = addDays(cur, -(days - 1));
  const keys = Array.from({ length: days }, (_, i) => addDays(first, i));
  return { from: tryDayBounds(first, tz)[0], to: tryDayBounds(cur, tz)[1], keys };
}

const stayed = (ts: readonly BassinetTry[]) => ts.filter((t) => t.outcome === "stayed_asleep").length;

export function sleepProgress(input: { tries: readonly BassinetTry[]; entries: readonly Entry[]; now: Date; tz: string; days?: number }): SleepProgress {
  const { now, tz } = input;
  const w = progressWindow(now, tz, input.days ?? 7);
  const lo = w.from.getTime();
  const hi = Math.min(w.to.getTime(), now.getTime() + 1);
  const inWindow = live(input.tries).filter((t) => ms(t.started_at) >= lo && ms(t.started_at) < hi);
  const finished = inWindow.filter((t) => t.ended_at && t.outcome);
  const outcomes = noOutcomes();
  for (const t of finished) outcomes[t.outcome!]++;
  const downs = finished.map((t) => (ms(t.ended_at!) - ms(t.started_at)) / MIN).sort((a, b) => a - b);
  const median = downs.length ? Math.round(downs.length % 2 ? downs[(downs.length - 1) / 2] : (downs[downs.length / 2 - 1] + downs[downs.length / 2]) / 2) : null;
  const places = sleepByPlace(input.entries, input.tries, lo, hi, now.getTime());
  const longest = places.stretches.filter((s) => s.end > lo && s.start < hi).sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const byTimeOfDay = TIME_OF_DAY.map((b) => {
    const here = inWindow.filter((t) => timeOfDay(ms(t.started_at), tz) === b.id);
    const oc = noOutcomes();
    for (const t of here) if (t.outcome) oc[t.outcome]++;
    return { part: b.id, label: b.label, tries: here.length, outcomes: oc };
  });
  const enough = finished.length >= EARLY_MIN_TRIES;
  return {
    from: w.from.toISOString(),
    to: w.to.toISOString(),
    days: w.keys.length,
    tries: inWindow.length,
    finished: finished.length,
    running: inWindow.length - finished.length,
    tryDays: new Set(inWindow.map((t) => tryDayKey(ms(t.started_at), tz))).size,
    outcomes,
    stayedAsleep: { n: stayed(finished), of: finished.length },
    medianMinutesDown: median,
    longestBassinet: longest ? { sec: Math.round((longest.end - longest.start) / 1000), start: new Date(longest.start).toISOString(), end: new Date(longest.end).toISOString() } : null,
    places: places.places,
    totalSleepSec: places.totalSec,
    byTimeOfDay,
    observations: enough ? earlyObservations(finished, tz) : [],
    enough,
  };
}

const share = (ts: readonly BassinetTry[]) => (ts.length ? stayed(ts) / ts.length : 0);

/** Descriptive comparisons only, never a prediction or a "best time", and each with its sample sizes. */
function earlyObservations(finished: readonly BassinetTry[], tz: string): string[] {
  const out: string[] = [];
  const total = finished.length;
  const groups = TIME_OF_DAY.map((b) => ({ label: b.label.toLowerCase(), ts: finished.filter((t) => timeOfDay(ms(t.started_at), tz) === b.id) })).filter((g) => g.ts.length >= EARLY_MIN_GROUP);
  if (groups.length >= 2) {
    const sorted = groups.slice().sort((a, b) => share(b.ts) - share(a.ts));
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    if (share(hi.ts) - share(lo.ts) >= EARLY_MIN_DIFF) {
      out.push(`Early observation (${plural(total, "try", "tries")}): ${hi.label} tries stayed asleep in ${stayed(hi.ts)} of ${hi.ts.length}; ${lo.label} tries, ${stayed(lo.ts)} of ${lo.ts.length}.`);
    }
  }
  const fed = finished.filter((t) => t.tags.includes("fed"));
  const notFed = finished.filter((t) => !t.tags.includes("fed"));
  if (fed.length >= EARLY_MIN_GROUP && notFed.length >= EARLY_MIN_GROUP && Math.abs(share(fed) - share(notFed)) >= EARLY_MIN_DIFF) {
    out.push(`Early observation (${plural(total, "try", "tries")}): tries tagged recently fed stayed asleep in ${stayed(fed)} of ${fed.length}; the others, ${stayed(notFed)} of ${notFed.length}.`);
  }
  return out;
}

/** The progress view in plain words, for the app's screen readers and the tools. */
export function progressLines(p: SleepProgress, tz: string, now: Date): string[] {
  const lines: string[] = [];
  if (!p.tries) {
    lines.push(`No bassinet tries in the last ${p.days} days.`);
  } else {
    lines.push(`${plural(p.tries, "bassinet try", "bassinet tries")} in the last ${p.days} days, on ${plural(p.tryDays, "day")}${p.running ? ` (${p.running} still going)` : ""}.`);
    if (p.finished) {
      const pct = p.finished >= EARLY_MIN_TRIES ? ` (about ${Math.round((p.stayedAsleep.n / p.finished) * 100)}%)` : "";
      const rest = TRY_OUTCOMES.filter((o) => o !== "stayed_asleep" && p.outcomes[o]).map((o) => `${OUTCOME_LABEL[o].toLowerCase()} ${p.outcomes[o]}`);
      lines.push(`Stayed asleep in ${p.stayedAsleep.n} of ${p.finished} finished ${p.finished === 1 ? "try" : "tries"}${pct}${rest.length ? `; ${rest.join(", ")}` : ""}.`);
    }
  }
  if (p.longestBassinet) {
    lines.push(`Longest stretch in the bassinet: ${formatDuration(p.longestBassinet.sec)} (${tryDayLabel(tryDayKey(ms(p.longestBassinet.start), tz), tryDayKey(now, tz))}, from ${formatTime(p.longestBassinet.start, tz)}).`);
  }
  if (p.places.length) {
    lines.push(`Logged sleep by place: ${p.places.map((x) => `${x.label.toLowerCase()} ${formatDuration(x.sec)} (${plural(x.sleeps, "sleep")})`).join(", ")}. Only logged sleep counts.`);
  }
  const parts = p.byTimeOfDay.filter((b) => b.tries);
  if (parts.length) {
    lines.push(
      `By time of day: ${parts
        .map((b) => {
          const oc = TRY_OUTCOMES.filter((o) => b.outcomes[o]).map((o) => `${b.outcomes[o]} ${OUTCOME_LABEL[o].toLowerCase()}`);
          return `${b.label.toLowerCase()} ${plural(b.tries, "try", "tries")}${oc.length ? ` (${oc.join(", ")})` : ""}`;
        })
        .join("; ")}.`
    );
  }
  if (p.observations.length) lines.push(...p.observations);
  else if (p.finished) lines.push(`Too few tries to see patterns yet (${p.finished} of ${EARLY_MIN_TRIES} finished).`);
  return lines;
}

// ── the stage suggestion ─────────────────────────────────────────────────

/**
 * When recent tries support moving on (Maple's own rule of thumb, not
 * medical guidance): at least 5 finished tries at this stage on 4 or more
 * try days of the last 7, and 3 or more of the last 5 stayed asleep 30
 * minutes or longer.
 */
export const SUGGEST = { minTries: 5, minDays: 4, lookbackDays: 7, recent: 5, recentStayed: 3, stayedMinutes: 30 } as const;

export type StageSuggestion = {
  from: PlanStage;
  to: PlanStage;
  tries: number;
  days: number;
  /** Of the last `recent` tries, how many stayed asleep 30 minutes or longer. */
  stayed: number;
  recent: number;
  /** "Not now" was tapped: still true, but not shown until the snooze ends. */
  snoozed: boolean;
};

export function stageSuggestion(plan: Pick<SleepPlan, "stage" | "stage_since" | "snoozed_until"> | null, tries: readonly BassinetTry[], now: Date, tz: string): StageSuggestion | null {
  if (!plan || plan.stage >= PLAN_STAGES[PLAN_STAGES.length - 1]) return null;
  const cur = tryDayKey(now, tz);
  const since = Math.max(ms(plan.stage_since), tryDayBounds(addDays(cur, -(SUGGEST.lookbackDays - 1)), tz)[0].getTime());
  const nums = numberTries(tries, tz);
  const recent = live(tries)
    .filter((t) => t.ended_at && t.outcome && ms(t.started_at) >= since && ms(t.started_at) <= now.getTime())
    .sort(byStart);
  const days = new Set(recent.map((t) => nums.get(t.id)?.day ?? tryDayKey(ms(t.started_at), tz))).size;
  const last = recent.slice(-SUGGEST.recent);
  const good = last.filter((t) => t.outcome === "stayed_asleep" && ms(t.ended_at!) - ms(t.started_at) >= SUGGEST.stayedMinutes * MIN).length;
  if (recent.length < SUGGEST.minTries || days < SUGGEST.minDays || good < SUGGEST.recentStayed) return null;
  return { from: plan.stage, to: (plan.stage + 1) as PlanStage, tries: recent.length, days, stayed: good, recent: last.length, snoozed: !!plan.snoozed_until && cur <= plan.snoozed_until };
}

/** "Not now": the suggestion stays hidden through this try day and the next two (the family's own days, noon to noon). */
export const SNOOZE_DAYS = 3;
export function snoozeUntil(now: Date, tz: string): string {
  return addDays(tryDayKey(now, tz), SNOOZE_DAYS - 1);
}

// ── today against the plan ───────────────────────────────────────────────

export type PlanToday = {
  key: string;
  /** "tonight". */
  label: string;
  /** Tries so far this try day (retries not counted). */
  done: number;
  planned: number;
  /** The try time to aim for next, or null when today's are done. */
  next: TrySlot | null;
  /** The planned try didn't happen and it's morning: the fallback is next. */
  fallback: boolean;
};

export function planToday(plan: Pick<SleepPlan, "tries_per_day" | "try_times" | "fallback">, tries: readonly BassinetTry[], now: Date, tz: string): PlanToday {
  const key = tryDayKey(now, tz);
  const done = plannedTriesOn(tries, key, tz);
  const planned = Math.max(1, plan.tries_per_day);
  const hour = localParts(now, tz).hour;
  const morning = hour >= 6 && hour < 12;
  let next: TrySlot | null = null;
  let fallback = false;
  if (done < planned) {
    const slots = plan.try_times.length ? plan.try_times : ["first_night_stretch"];
    next = slots[Math.min(done, slots.length - 1)];
    // The night went by without the planned try: the morning nap is the backup.
    if (morning && done === 0 && plan.fallback && !slots.includes(plan.fallback) && /night/.test(next)) {
      next = plan.fallback;
      fallback = true;
    }
  }
  return { key, label: tryDayLabel(key, key), done, planned, next, fallback };
}

/** "0 of 1 tonight · next: the first long night stretch after a feed". */
export function planTodayLine(t: PlanToday): string {
  const head = `${t.done} of ${t.planned} ${t.label}`;
  if (!t.next) return `${head}.`;
  return `${head}; next: ${slotLabel(t.next).replace(/^The /, "the ")}${t.fallback ? " (the backup, since the night try didn't happen)" : ""}.`;
}

// ── holding shifts ───────────────────────────────────────────────────────

/** A planned handoff default: two hours from the start. */
export const DEFAULT_SHIFT_MS = 2 * HOUR;

export type ShiftStatus = { open: boolean; due: boolean; minutesLeft: number | null };

export function shiftStatus(s: Pick<HoldingShift, "ended_at" | "handoff_at">, now: Date): ShiftStatus {
  if (s.ended_at) return { open: false, due: false, minutesLeft: null };
  if (!s.handoff_at) return { open: true, due: false, minutesLeft: null };
  const left = Math.round((ms(s.handoff_at) - now.getTime()) / MIN);
  return { open: true, due: left <= 0, minutesLeft: left };
}

/** The next shift's planned handoff: the same length as the shift handed over (if it had one), else two hours. */
export function nextHandoff(prev: Pick<HoldingShift, "started_at" | "handoff_at">, at: number): number {
  const planned = prev.handoff_at ? ms(prev.handoff_at) - ms(prev.started_at) : DEFAULT_SHIFT_MS;
  const span = planned >= 15 * MIN && planned <= MAX_SPAN_MS ? planned : DEFAULT_SHIFT_MS;
  return at + span;
}

export type AskState = {
  /** Someone was asked to take over this open turn ("Wake [partner]"), and nobody has yet. */
  asked: boolean;
  /** Who was asked (a member id) and when. */
  to: string | null;
  at: string | null;
  /** Whole minutes since the ask. */
  minutes: number;
  /**
   * Nobody took over within ASK_STALE_MS: the holder sees the two safe
   * choices again (the bassinet now, or wake them again), never "keep holding".
   */
  stale: boolean;
};

/** A turn's ask, as the holder's phone, the other phones and the tools read it. An ended turn has none open. */
export function askState(s: Pick<HoldingShift, "ended_at" | "asked_to" | "asked_at">, now: Date): AskState {
  if (s.ended_at || !s.asked_to || !s.asked_at) return { asked: false, to: null, at: null, minutes: 0, stale: false };
  const since = now.getTime() - ms(s.asked_at);
  return { asked: true, to: s.asked_to, at: s.asked_at, minutes: Math.max(0, Math.floor(since / MIN)), stale: since >= ASK_STALE_MS };
}

// ── the try day in a phone's words ───────────────────────────────────────
//
// A try day runs noon to noon, so at 7:30 AM it's still the one that began
// last evening. The tools keep tryDayLabel's plain "tonight"; a phone says
// what a person would at that hour.

/** From this local hour until noon, the try day's night is over: its morning. */
const MORNING_HOUR = 5;
const isMorning = (at: Date | number, tz: string) => {
  const h = localParts(at, tz).hour;
  return h >= MORNING_HOUR && h < 12;
};

/** The current try day: "tonight", or in its morning (5 AM to noon) "since last night". */
export function tryDayNowLabel(now: Date, tz: string): string {
  return isMorning(now, tz) ? "since last night" : "tonight";
}

/**
 * A try's day, said at `now`: "tonight"; in the morning, "last night" for
 * the night's tries and "this morning" for the morning's, with the night
 * before named by its evening ("Tue night"); older ones as tryDayLabel.
 */
export function tryWhenLabel(startedAt: string | number, now: Date, tz: string): string {
  const start = typeof startedAt === "string" ? ms(startedAt) : startedAt;
  const key = tryDayKey(start, tz);
  const nowKey = tryDayKey(now, tz);
  const morning = isMorning(now, tz);
  if (key === nowKey) return !morning ? "tonight" : isMorning(start, tz) ? "this morning" : "last night";
  if (morning && daysBetween(key, nowKey) === 1) return `${formatDayLabel(key, addDays(nowKey, 7)).split(",")[0]} night`;
  return tryDayLabel(key, nowKey);
}

// ── recent-log signals and guidance ──────────────────────────────────────

/** How recent "after crying" and "retry done" stay. */
const RECENT_MS = 2 * HOUR;

export function sleepSignals(tries: readonly BassinetTry[], now: Date, tz: string, opts: { suggestion?: StageSuggestion | null } = {}): Set<SleepSignal> {
  const out = new Set<SleepSignal>();
  const ts = live(tries).filter((t) => ms(t.started_at) <= now.getTime() + MIN).sort(byStart);
  if (!ts.length) {
    out.add("no_tries_yet");
    return out;
  }
  const nums = numberTries(ts, tz);
  const newest = ts[ts.length - 1];
  const t = now.getTime();
  if (newest.ended_at && newest.outcome && t - ms(newest.ended_at) <= RECENT_MS) {
    const retry = nums.get(newest.id)?.retry;
    if (retry && AWAKE_ENDINGS.has(newest.outcome)) out.add("retry_done");
    else if (newest.outcome === "woke_crying") out.add("after_crying");
  }
  const day = ts.filter((x) => t - ms(x.started_at) <= 24 * HOUR && x.ended_at && x.outcome);
  if (day.length >= 2 && !day.some((x) => x.outcome === "stayed_asleep")) out.add("hard_day");
  if (t - ms(newest.started_at) >= 72 * HOUR) out.add("long_gap");
  if (newest.tags.includes("swaddled")) out.add("swaddled");
  if (opts.suggestion && !opts.suggestion.snoozed) out.add("steady");
  return out;
}

export type GuideView = {
  id: string;
  section: SleepSection;
  title: string;
  body: string;
  steps?: string[];
  sources: readonly GuideSource[];
  reviewed: string;
  needsReview: boolean;
};

export type SleepGuidance = {
  /** Picked by the recent log, most pressing first (at most three). */
  now: GuideView[];
  sections: { section: SleepSection; title: string; items: GuideView[] }[];
};

const view = (g: SleepGuide, v: Voice): GuideView => ({
  id: g.id,
  section: g.section,
  title: g.title(v),
  body: g.body(v),
  ...(g.steps ? { steps: g.steps(v) } : {}),
  sources: g.sources,
  reviewed: g.reviewed,
  needsReview: g.needsReview,
});

/** Lifted first in this order: what to do about a crying wake, then a hard day, then the rest. */
const LIFT_ORDER: SleepSignal[] = ["retry_done", "after_crying", "hard_day", "swaddled", "no_tries_yet", "steady", "long_gap"];

/**
 * The guidance for her age, the plan's stage and the recent log. Items with
 * `when` show only for those signals; items with `lift` always show, and
 * move to `now` for them. Before she's born (or without a plan's stage),
 * stage items are left out; with no age, nothing shows.
 */
export function sleepGuidance(v: Voice, ctx: { days: number | null; stage: PlanStage | null; signals: ReadonlySet<SleepSignal> }): SleepGuidance {
  if (ctx.days == null) return { now: [], sections: [] };
  const days = ctx.days;
  const fits = SLEEP_GUIDES.filter(
    (g) => days >= g.minDays && days <= g.maxDays && (!g.stages || (ctx.stage != null && g.stages.includes(ctx.stage))) && (!g.when || g.when.some((s) => ctx.signals.has(s)))
  );
  const rank = (g: SleepGuide) => {
    const hits = [...(g.when ?? []), ...(g.lift ?? [])].filter((s) => ctx.signals.has(s)).map((s) => LIFT_ORDER.indexOf(s));
    return hits.length ? Math.min(...hits) : Number.POSITIVE_INFINITY;
  };
  const lifted = fits.filter((g) => Number.isFinite(rank(g)) && g.section !== "next").sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  const now = lifted.map((g) => view(g, v));
  const sections = SLEEP_SECTIONS.map((section) => ({
    section,
    title: sectionTitle(section, v),
    items: fits.filter((g) => g.section === section && !lifted.includes(g)).map((g) => view(g, v)),
  })).filter((s) => s.items.length);
  return { now, sections };
}

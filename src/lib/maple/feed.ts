/**
 * Breastfeeding timer math. Pure and isomorphic so the server (REST + MCP)
 * and the client (optimistic updates, live clocks, previews) agree on the numbers.
 *
 * A nursing session is a list of segments, one per stretch on a side.
 * Exactly zero or one segment is open (end = null); zero open while the entry
 * is still active means "paused".
 *
 * The card and the Fix times sheet show a feed as parts (sides and breaks)
 * joined by moments (feed start, switch, pause, resume, feed end). Every edit
 * here moves exactly one moment: nothing moves past a break or eats into a
 * neighbouring side, and every result goes through normalizeSegments, so
 * sub-second double taps vanish and touching same-side stretches merge.
 */
import { DEFAULT_TZ, formatDuration, formatMinutes, formatRange, formatTime, formatTimeNear } from "./time";
import type { Entry, FeedData, Segment, Side, StretchRef } from "./types";

export type { StretchRef } from "./types";

export type Moment = "feed_start" | "switch" | "pause" | "resume" | "feed_end";

/**
 * `sec` is exact (live m:ss clocks); `min` is the whole minutes every other
 * surface shows (spanMinutes: the difference of the displayed clock times).
 */
export type Part =
  | {
      kind: "side";
      side: Side;
      start: string;
      end: string | null;
      sec: number;
      min: number;
      ref: StretchRef;
      startMoment: "feed_start" | "switch" | "resume";
      endMoment: "switch" | "pause" | "feed_end" | null;
    }
  | { kind: "break"; start: string; end: string | null; sec: number; min: number; before: StretchRef; after: StretchRef | null; legacy?: true };

export type FeedEditCode =
  | "future"
  | "too_early"
  | "before_prev_start"
  | "before_break"
  | "after_next"
  | "after_own_end"
  | "before_own_start"
  | "overlap"
  | "not_found"
  | "not_newest"
  | "use_stop"
  | "nothing_to_undo"
  | "not_timed"
  | "too_many";

/**
 * An edit that doesn't fit the feed. `params` hold sides ("L"/"R") and ISO
 * instants (t, now, asked, start, end), so feedEditCopy can word them for
 * either surface in the baby's zone. not_found / not_newest mean the feed
 * changed under the edit (the store answers 409 "changed").
 */
export class FeedEditError extends Error {
  constructor(readonly code: FeedEditCode, readonly params: Record<string, string> = {}) {
    super(code);
    this.name = "FeedEditError";
    // Readable as-is wherever only err.message is shown (the family's zone).
    this.message = feedEditCopy(this, "ui", DEFAULT_TZ);
  }
}

/**
 * The latest switch, resume or pause, as switchTo and pause record it in
 * `data.last_tap`, so undoLastTap takes back that tap and not an older one
 * the stretches happen to show: a same-side resume within a minute
 * (merged) leaves no break behind, and a switch back within 15 s (reverted)
 * leaves only the side before it. `at` is when it was tapped (how fresh a
 * "Tapped … by mistake?" offer is), not the moment it recorded; `paused_at`
 * is where a resume's break began; `undone` once undoLastTap took it back.
 */
export type LastTap = {
  kind: "switch" | "resume" | "pause";
  side: Side;
  at: string;
  paused_at?: string;
  merged?: true;
  reverted?: true;
  undone?: true;
};

/** FeedData with the tap record (kept by validate.ts; types.ts's FeedData doesn't list it). */
export type TapFeedData = FeedData & { last_tap?: LastTap };

const lastTapOf = (data: FeedData): LastTap | undefined => (data as TapFeedData).last_tap;

/** What feedParts and the edits need to know about the entry around the data. */
export type FeedCtx = { now: Date; active: boolean; endedAt: string | null; pausedAtStop?: boolean };

export function feedCtx(e: { active: boolean; ended_at: string | null; data: unknown }, now: Date): FeedCtx {
  return { now, active: e.active, endedAt: e.ended_at, pausedAtStop: (e.data as FeedData | null)?.paused_at_stop === true };
}

const SIDE_NAME: Record<Side, string> = { L: "Left", R: "Right" };
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Refs match within this, and a last end this close to ended_at ran to the stop. */
const NEAR = 1500;
const MAX_PARTS = 60;

export const other = (s: Side): Side => (s === "L" ? "R" : "L");

export function openSegment(segments: Segment[] | undefined): Segment | null {
  if (!segments?.length) return null;
  const last = segments[segments.length - 1];
  return last.end === null ? last : null;
}

/** Close any open segment at `at` (never before its own start). */
export function closeSegments(segments: Segment[] | undefined, at: Date): Segment[] {
  return (segments ?? []).map((s) => {
    if (s.end !== null) return s;
    const end = Math.max(at.getTime(), Date.parse(s.start));
    return { ...s, end: new Date(end).toISOString() };
  });
}

/** Seconds per side; an open segment counts up to `now`. */
export function sideTotals(segments: Segment[] | undefined, now: Date): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const s of segments ?? []) {
    const end = s.end ? Date.parse(s.end) : now.getTime();
    const sec = Math.max(0, (end - Date.parse(s.start)) / 1000);
    if (s.side === "L") left += sec;
    else right += sec;
  }
  return { left: Math.round(left), right: Math.round(right) };
}

// ── whole minutes ────────────────────────────────────────────────────────

/**
 * The one rule for whole minutes of nursing, on every row, total, toast and
 * preview (live m:ss clocks stay in seconds): a part counts the difference
 * of the clock minutes it's shown with, so "2:27 – 2:36 AM" is 9 min
 * whatever the seconds. A part whose two ends show the same minute counts 0
 * and reads "<1 min", even at 50 s: a rounded-up "1 min" beside "2:27 –
 * 2:27" would contradict its own range, and break the sums. Likewise a 20 s
 * break shown as "2:16 – 2:17" is 1 min, as it reads. A side is the sum
 * of its parts and a feed the sum of its sides, so "Nursed 36m (L 12 · R
 * 24)" adds up, and sides plus breaks come to the feed's own clock span.
 * (Epoch minutes are the zone's clock minutes: every offset in use is whole
 * minutes, and formatTime drops seconds rather than rounding them.)
 */
export function spanMinutes(start: Date | number | string, end: Date | number | string): number {
  const minute = (t: Date | number | string) => Math.floor(new Date(t).getTime() / MIN);
  return Math.max(0, minute(end) - minute(start));
}

/** "9 min", "1h 12m"; 0 (some time, but no whole clock minute) reads "<1 min". */
export const minutesText = (min: number): string => (min > 0 ? formatMinutes(min * 60) : "<1 min");

/** The short form lists and toasts use: "12m", "1h 05m", "<1m". */
export const minutesShort = (min: number): string => (min > 0 ? formatDuration(min * 60) : "<1m");

/** Whole minutes of a feed per side and in all (left + right); `has` is which sides she was on at all. */
export type FeedMinutes = { left: number; right: number; total: number; has: Record<Side, boolean> };

/**
 * A feed's whole minutes, its rows added up (spanMinutes), for lists, the
 * day's totals, "Last fed" and the Done toast. A running feed counts up to
 * now. Fed by typed minutes (no segments), the stored seconds round.
 */
export function feedMinutes(e: { active: boolean; ended_at: string | null; data: FeedData }, now: Date): FeedMinutes {
  const d = e.data;
  if (d.segments?.length) {
    const parts = feedParts(d, feedCtx(e, now));
    const t = partTotals(parts).min;
    const has = (side: Side) => parts.some((p) => p.kind === "side" && p.side === side);
    return { left: t.left, right: t.right, total: t.nursing, has: { L: has("L"), R: has("R") } };
  }
  const left = Math.round((d.left_sec ?? 0) / 60);
  const right = Math.round((d.right_sec ?? 0) / 60);
  return { left, right, total: left + right, has: { L: (d.left_sec ?? 0) > 0, R: (d.right_sec ?? 0) > 0 } };
}

/** "L 12 · R 24" ("L <1" for a side under a minute), the sides of "Nursed 36m (L 12 · R 24)". */
export function sideMinutesText(t: FeedMinutes, sep = " · "): string {
  return (["L", "R"] as const)
    .filter((s) => t.has[s])
    .map((s) => `${s} ${(s === "L" ? t.left : t.right) || "<1"}`)
    .join(sep);
}

// ── stretches ────────────────────────────────────────────────────────────

/** A segment in epoch ms, which is what the edits work in. */
type Stretch = { side: Side; start: number; end: number | null };

const iso = (t: number) => new Date(t).toISOString();
const toStretches = (segs: Segment[] | undefined): Stretch[] =>
  (segs ?? []).map((s) => ({ side: s.side, start: Date.parse(s.start), end: s.end === null ? null : Date.parse(s.end) }));
const toSegments = (list: Stretch[]): Segment[] =>
  list.map((s) => ({ side: s.side, start: iso(s.start), end: s.end === null ? null : iso(s.end) }));
const refOf = (s: Stretch): StretchRef => ({ side: s.side, start: iso(s.start) });
const secs = (ms: number) => Math.max(0, ms / SEC);

/**
 * The one normalization. Strict (edits, restores, PATCHes) throws on data
 * that can't be a feed; lenient (reading what's stored, stopping a timer)
 * repairs it instead, so an odd old row never breaks the card or Done.
 */
function tidy(input: Stretch[], active: boolean, strict: boolean): Stretch[] {
  const bad = (message: string) => {
    if (strict) throw new Error(message);
  };
  let segs = input
    .filter((s) => {
      const ok = (s.side === "L" || s.side === "R") && !Number.isNaN(s.start) && !(s.end !== null && Number.isNaN(s.end));
      if (!ok) bad("Each part needs a side and valid times");
      return ok;
    })
    .map((s) => ({ ...s }))
    .sort((a, b) => a.start - b.start);
  segs.forEach((s, i) => {
    if (s.end !== null && s.end < s.start) {
      bad(`${SIDE_NAME[s.side]} ends before it starts`);
      s.end = s.start;
    }
    if (s.end === null && i < segs.length - 1) {
      bad("Only the last part can still be going");
      s.end = Math.max(s.start, segs[i + 1].start);
    }
    if (s.end === null && !active) bad("A finished feed can't have a side still going");
  });
  for (;;) {
    const count = segs.length;
    // Sub-second stretches are double taps nobody saw, unless that's all there is.
    const kept = segs.filter((s) => s.end === null || s.end - s.start >= SEC);
    segs = kept.length ? kept : segs.slice(-1);
    const out: Stretch[] = [];
    for (const s of segs) {
      const a = out[out.length - 1];
      if (a && a.end !== null) {
        if (s.start < a.end - SEC) {
          if (strict) throw new FeedEditError("overlap", { side: a.side, start: iso(a.start), end: iso(a.end) });
          s.start = a.end;
          if (s.end !== null && s.end < s.start) s.end = s.start;
        }
        if (Math.abs(s.start - a.end) < SEC) s.start = a.end;
        if (s.start === a.end && s.side === a.side) {
          a.end = s.end;
          continue;
        }
      }
      out.push(s);
    }
    segs = out;
    // A snap can leave a stretch under a second; go round again until none is.
    const short = segs.length > 1 && segs.some((s) => s.end !== null && s.end - s.start < SEC);
    if (segs.length === count && !short) break;
  }
  if (strict && segs.length > MAX_PARTS) throw new FeedEditError("too_many");
  return segs;
}

/** The real stretches of what's stored. */
const real = (data: FeedData, active: boolean) => tidy(toStretches(data.segments), active, false);

/**
 * Sort, drop closed stretches under a second (unless it's the only one), snap
 * starts within a second of the previous end onto it, merge touching
 * same-side neighbours. Throws on overlaps over a second, an open stretch
 * that isn't last (or on a finished feed), an end before its start, or more
 * than 60 stretches.
 */
export function normalizeSegments(segs: Segment[], opts: { active: boolean }): Segment[] {
  return toSegments(tidy(toStretches(segs), opts.active, true));
}

function tally(S: Stretch[]) {
  let left = 0;
  let right = 0;
  for (const s of S) {
    if (s.end === null) continue;
    if (s.side === "L") left += s.end - s.start;
    else right += s.end - s.start;
  }
  return { left_sec: Math.round(left / SEC), right_sec: Math.round(right / SEC), first_side: S[0]?.side, last_side: S[S.length - 1]?.side };
}

/** Closed real stretches per side (rounded seconds) and the first/last side she was on. */
export function summarize(segs: Segment[]): { left_sec: number; right_sec: number; first_side?: Side; last_side?: Side } {
  return tally(tidy(toStretches(segs), true, false));
}

/** Store normalized stretches back on the feed: sides always, totals once it's finished. */
function settle(data: FeedData, S: Stretch[], active: boolean): FeedData {
  const t = tally(S);
  const out: FeedData = { ...data, segments: toSegments(S), first_side: t.first_side ?? data.first_side, last_side: t.last_side ?? data.last_side };
  if (!active) {
    out.left_sec = t.left_sec;
    out.right_sec = t.right_sec;
  }
  return out;
}

/**
 * When a finished feed ended, and whether it's a legacy stop-while-paused:
 * no flag, and ended_at well after the last end (a trailing break).
 */
function ending(S: Stretch[], data: FeedData, ctx: FeedCtx): { endedAt: number | null; legacy: boolean } {
  if (ctx.active) return { endedAt: null, legacy: false };
  const lastEnd = S[S.length - 1]?.end ?? null;
  const endedAt = ctx.endedAt ? Date.parse(ctx.endedAt) : lastEnd;
  const flagged = ctx.pausedAtStop ?? data.paused_at_stop === true;
  return { endedAt, legacy: !flagged && lastEnd !== null && endedAt !== null && endedAt - lastEnd >= NEAR };
}

function find(S: Stretch[], ref: StretchRef): number {
  const t = Date.parse(ref.start);
  let best = -1;
  S.forEach((s, i) => {
    const d = Math.abs(s.start - t);
    if (s.side === ref.side && d <= NEAR && (best < 0 || d < Math.abs(S[best].start - t))) best = i;
  });
  if (best < 0) throw new FeedEditError("not_found");
  return best;
}

// ── parts ────────────────────────────────────────────────────────────────

/**
 * What the card and the sheet list: a side part per real stretch, a break
 * part for each gap between them, then the open break while paused, or (on
 * legacy feeds) the trailing break up to ended_at.
 */
export function feedParts(data: FeedData, ctx: FeedCtx): Part[] {
  const S = real(data, ctx.active);
  const now = ctx.now.getTime();
  const { endedAt, legacy } = ending(S, data, ctx);
  const parts: Part[] = [];
  // Exact seconds for the live clocks, and the whole minutes everything else shows.
  const len = (a: number, b: number) => ({ sec: secs(b - a), min: spanMinutes(a, b) });
  S.forEach((s, i) => {
    const p = S[i - 1];
    const n = S[i + 1];
    if (p?.end != null && s.start > p.end) {
      parts.push({ kind: "break", start: iso(p.end), end: iso(s.start), ...len(p.end, s.start), before: refOf(p), after: refOf(s) });
    }
    parts.push({
      kind: "side",
      side: s.side,
      start: iso(s.start),
      end: s.end === null ? null : iso(s.end),
      ...len(s.start, s.end ?? (ctx.active ? now : endedAt ?? now)),
      ref: refOf(s),
      startMoment: !p ? "feed_start" : p.end === s.start ? "switch" : "resume",
      endMoment: s.end === null ? null : n ? (n.start === s.end ? "switch" : "pause") : ctx.active || legacy ? "pause" : "feed_end",
    });
  });
  const last = S[S.length - 1];
  if (last?.end != null) {
    if (ctx.active) parts.push({ kind: "break", start: iso(last.end), end: null, ...len(last.end, now), before: refOf(last), after: null });
    else if (legacy && endedAt !== null) {
      parts.push({ kind: "break", start: iso(last.end), end: iso(endedAt), ...len(last.end, endedAt), before: refOf(last), after: null, legacy: true });
    }
  }
  return parts;
}

/**
 * Seconds on each side, nursing in all, and in breaks (open ones count up to
 * now), for the live clocks; `min` is the same in whole minutes (the sums of
 * the parts' `min`), for everything else.
 */
export function partTotals(parts: Part[]): {
  left: number;
  right: number;
  nursing: number;
  breaks: number;
  breakCount: number;
  min: { left: number; right: number; nursing: number; breaks: number };
} {
  const t = { left: 0, right: 0, nursing: 0, breaks: 0, breakCount: 0, min: { left: 0, right: 0, nursing: 0, breaks: 0 } };
  for (const p of parts) {
    if (p.kind === "break") {
      t.breaks += p.sec;
      t.min.breaks += p.min;
      t.breakCount++;
    } else {
      if (p.side === "L") {
        t.left += p.sec;
        t.min.left += p.min;
      } else {
        t.right += p.sec;
        t.min.right += p.min;
      }
      t.nursing += p.sec;
      t.min.nursing += p.min;
    }
  }
  return t;
}

/** The question that titles a moment's editor. `side` is the stretch it starts (switch, resume) or ends (pause). */
export function momentQuestion(moment: Moment, side: Side): string {
  switch (moment) {
    case "feed_start":
      return "When did the feed start?";
    case "switch":
      return `When did she switch to ${SIDE_NAME[side]}?`;
    case "pause":
      return `When did she come off the ${SIDE_NAME[side]}?`;
    case "resume":
      return `When did she go back on the ${SIDE_NAME[side]}?`;
    case "feed_end":
      return "When did the feed end?";
  }
}

// ── moving one moment ────────────────────────────────────────────────────

type Edge = "start" | "end" | "ended";

type Plan = {
  S: Stretch[];
  moment: Moment;
  recorded: number;
  min: number;
  uiMin: number;
  max: number;
  floor?: number;
  low: () => FeedEditError;
  high: () => FeedEditError;
  /** Moves the moment in S; answers the finished feed's ended_at (null while active). */
  apply: (to: number) => number | null;
};

/** A FeedEditError whose epoch-ms params become ISO. */
const editError = (code: FeedEditCode, params: Record<string, string | number> = {}) =>
  new FeedEditError(code, Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === "number" ? iso(v) : v])));

/**
 * The one table of moves: what an edge of a stretch is, how far it may go,
 * and what moving it changes. moveEdge and edgeBounds both read it.
 */
function plan(data: FeedData, edge: Edge, ref: StretchRef | undefined, ctx: FeedCtx): Plan {
  const S = real(data, ctx.active);
  if (data.method !== "breast" || !S.length) throw new FeedEditError("not_timed");
  const now = ctx.now.getTime();
  const { endedAt, legacy } = ending(S, data, ctx);
  const last = S[S.length - 1];
  // A shrinking neighbour keeps a minute in the UI, unless it's already shorter (then the hard 1 s).
  const soft = (ideal: number, min: number, recorded: number) => (ideal <= recorded ? ideal : min);

  const future = () => editError("future", { now });

  const startOf = (k: number): Plan => {
    const s = S[k];
    const p = S[k - 1];
    const max = (s.end ?? now) - SEC;
    const high = s.end === null ? future : () => editError("after_own_end", { side: s.side, t: s.end! });
    if (!p) {
      const min = S[0].start - 6 * HOUR;
      const apply = (to: number) => {
        s.start = to;
        return endedAt;
      };
      return { S, moment: "feed_start", recorded: s.start, min, uiMin: min, max, low: () => editError("too_early"), high, apply };
    }
    const pEnd = p.end!;
    if (pEnd === s.start) {
      const min = p.start + SEC;
      const apply = (to: number) => {
        p.end = s.start = to;
        return endedAt;
      };
      const low = () => editError("before_prev_start", { prev: p.side, t: p.start });
      return { S, moment: "switch", recorded: s.start, min, uiMin: soft(p.start + MIN, min, s.start), max, low, high, apply };
    }
    const apply = (to: number) => {
      // Back on less than a second after she came off is no break: same side merges, the other is a switch.
      s.start = to - pEnd < SEC ? pEnd : to;
      return endedAt;
    };
    const low = () => editError("before_break", { t: pEnd });
    return { S, moment: "resume", recorded: s.start, min: pEnd, uiMin: pEnd, floor: pEnd, max, low, high, apply };
  };

  if (edge === "ended") {
    if (ctx.active || last.end === null) throw new FeedEditError("use_stop");
    const lastEnd = last.end;
    const apply = (to: number) => (to - lastEnd < NEAR ? lastEnd : to);
    const low = () => editError("before_break", { t: lastEnd });
    return { S, moment: "feed_end", recorded: endedAt ?? lastEnd, min: lastEnd, uiMin: lastEnd, max: now, low, high: future, apply };
  }
  if (edge === "start") return startOf(ref ? find(S, ref) : 0);

  const k = ref ? find(S, ref) : S.length - 1;
  const s = S[k];
  if (s.end === null) throw new FeedEditError("use_stop");
  const sEnd = s.end;
  const n = S[k + 1];
  // The end of a side she switched from is that switch.
  if (n && n.start === sEnd) return startOf(k + 1);
  const min = s.start + SEC;
  const base = { S, recorded: sEnd, min, uiMin: soft(s.start + MIN, min, sEnd), low: () => editError("before_own_start", { side: s.side, t: s.start }) };
  const endAt = (to: number, ended: number | null) => {
    s.end = to;
    return ended;
  };
  if (n) {
    // Came off less than a second before she went back on is no break.
    const apply = (to: number) => endAt(n.start - to < SEC ? n.start : to, endedAt);
    return { ...base, moment: "pause", max: n.start, high: () => editError("after_next", { next: n.side, t: n.start }), apply };
  }
  if (ctx.active) return { ...base, moment: "pause", max: now, high: future, apply: (to) => endAt(to, null) };
  if (legacy && endedAt !== null) {
    const high = () => editError("after_next", { next: "end", t: endedAt });
    return { ...base, moment: "pause", max: endedAt, high, apply: (to) => endAt(to, endedAt) };
  }
  return { ...base, moment: "feed_end", max: now, high: future, apply: (to) => endAt(to, to) };
}

/**
 * How far one edge may move. min is what the engine accepts, uiMin what the
 * sheet offers (a minute left on the side it eats into), floor the "No
 * break" time of a resume. max is capped at now. Throws as moveEdge would
 * for an edge that can't move (not_found, use_stop, not_timed).
 */
export function edgeBounds(
  data: FeedData,
  edit: { edge: Edge; ref?: StretchRef },
  ctx: FeedCtx
): { min: Date; uiMin: Date; max: Date; floor?: Date; moment: Moment; recorded: Date } {
  const p = plan(data, edit.edge, edit.ref, ctx);
  const max = Math.min(p.max, ctx.now.getTime());
  return {
    min: new Date(p.min),
    uiMin: new Date(Math.min(p.uiMin, Math.max(max, p.min))),
    max: new Date(max),
    ...(p.floor !== undefined ? { floor: new Date(p.floor) } : {}),
    moment: p.moment,
    recorded: new Date(p.recorded),
  };
}

/**
 * Move one moment: the start or end of the stretch `ref` (first stretch for
 * start, last for end, when omitted), or a finished feed's ended_at alone
 * ("ended"). `moment` is the moment that was moved, as it was before.
 */
export function moveEdge(
  data: FeedData,
  edit: { edge: Edge; ref?: StretchRef; to: Date },
  ctx: FeedCtx
): { data: FeedData; startedAt: string; endedAt: string | null; moment: Moment } {
  const p = plan(data, edit.edge, edit.ref, ctx);
  const to = edit.to.getTime();
  if (Number.isNaN(to)) throw new Error("The new time must be a valid time");
  const now = ctx.now.getTime();
  if (to > now + 5 * SEC) throw editError("future", { now });
  if (to < p.S[0].start - 6 * HOUR) throw editError("too_early");
  if (to < p.min) throw p.low();
  if (to > p.max) throw p.high();
  const endedAt = p.apply(to);
  const S = tidy(p.S, ctx.active, true);
  const out = settle(data, S, ctx.active);
  const lastEnd = S[S.length - 1].end;
  // ended_at moved off the last end: a trailing break, not a stop at the pause.
  if (!ctx.active && endedAt !== null && lastEnd !== null && endedAt - lastEnd >= NEAR) delete out.paused_at_stop;
  return { data: out, startedAt: iso(S[0].start), endedAt: ctx.active ? null : iso(endedAt ?? lastEnd ?? now), moment: p.moment };
}

/** "That was the Right": one stretch changes side; touching same-side neighbours merge. */
export function setSide(data: FeedData, ref: StretchRef, side: Side, ctx: FeedCtx): { data: FeedData; startedAt: string } {
  if (data.method !== "breast" || !data.segments?.length) throw new FeedEditError("not_timed");
  const S = real(data, ctx.active);
  S[find(S, ref)].side = side;
  const out = tidy(S, ctx.active, true);
  return { data: settle(data, out, ctx.active), startedAt: iso(out[0].start) };
}

/** "Add a side she nursed on" to a finished feed. It may touch a stretch but not overlap one by over a second. */
export function addPart(
  data: FeedData,
  part: { side: Side; start: Date | string; end: Date | string },
  ctx: FeedCtx
): { data: FeedData; startedAt: string; endedAt: string } {
  if (ctx.active) throw new Error("Sides are added once the feed has finished");
  if (data.method !== "breast" || !data.segments?.length) throw new FeedEditError("not_timed");
  const S = real(data, false);
  const start = new Date(part.start).getTime();
  const end = new Date(part.end).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("The new side needs valid times");
  if (end > ctx.now.getTime() + 5 * SEC) throw editError("future", { now: ctx.now.getTime() });
  if (start < S[0].start - 6 * HOUR) throw editError("too_early");
  if (end < start + SEC) throw editError("before_own_start", { side: part.side, t: start });
  const hit = S.find((x) => x.end !== null && start < x.end - SEC && end > x.start + SEC);
  if (hit) throw editError("overlap", { side: hit.side, start: hit.start, end: hit.end! });
  const { endedAt } = ending(S, data, ctx);
  const out = tidy([...S, { side: part.side, start, end }], false, true);
  const next = settle(data, out, false);
  const was = endedAt ?? S[S.length - 1].end!;
  // A side after the old end is where the feed now ends, not a pause.
  if (end > was) delete next.paused_at_stop;
  return { data: next, startedAt: iso(out[0].start), endedAt: iso(Math.max(was, end)) };
}

export type TapWhat = "switch" | "resume" | "pause";

/**
 * How the latest tap comes back off the stretches S (mutating them), or why
 * it can't: "only" (just the start tap), "taken_back" (it was undone, or
 * itself undid a switch), "changed" (later fixes reshaped what it made).
 * With no tap recorded (feeds from before taps were), it's read off the
 * newest stretch. `at` is when it was tapped (the moment, unrecorded).
 */
function tapUndo(S: Stretch[], tap: LastTap | undefined): { what: TapWhat; at: number; apply: () => void } | { refuse: "only" | "taken_back" | "changed" } {
  const L = S[S.length - 1];
  const P = S[S.length - 2];
  if (!L) return { refuse: "only" };
  const tapped = (moment: number) => (tap ? Date.parse(tap.at) : moment);
  const reopen = () => ({ what: "pause" as const, at: tapped(L.end!), apply: () => void (L.end = null) });
  const drop = (what: "switch" | "resume") => ({
    what,
    at: tapped(L.start),
    apply: () => {
      S.pop();
      if (what === "switch") P.end = null;
    },
  });
  if (!tap) {
    if (L.end !== null) return reopen();
    if (!P) return { refuse: "only" };
    return drop(P.end === L.start ? "switch" : "resume");
  }
  if (tap.undone || tap.reverted) return { refuse: "taken_back" };
  switch (tap.kind) {
    case "pause":
      return L.end !== null ? reopen() : { refuse: "changed" };
    case "switch":
      return L.end === null && P && P.end === L.start ? drop("switch") : { refuse: "changed" };
    case "resume": {
      if (L.end !== null) return { refuse: "changed" };
      // Back on the same side within a minute merged into it: end it again where the break began.
      const cut = tap.paused_at ? Date.parse(tap.paused_at) : NaN;
      if (cut >= L.start + SEC) return { what: "resume", at: tapped(cut), apply: () => void (L.end = cut) };
      // Its own stretch (after the break, or on the other side right at it): drop it, the break comes back.
      return P && P.end !== null && P.end <= L.start ? drop("resume") : { refuse: "changed" };
    }
  }
}

/**
 * Undo the latest tap on a running feed, if the newest stretch is still the
 * one the person saw (`expect`): a switch reopens the side before it, a
 * resume goes back to paused (a merged one ends again at its old pause), a
 * pause reopens the side. It's the tap recorded in last_tap, never an older
 * one: a tap already undone, or one that switched back, has nothing left to
 * undo (nothing_to_undo, why taken_back). A finished feed is reopened
 * instead (not_timed).
 */
export function undoLastTap(
  data: FeedData,
  expect: { side: Side; start: string; end: string | null },
  opts: { active?: boolean } = {}
): { data: FeedData; what: TapWhat } {
  if (opts.active === false || data.method !== "breast" || !data.segments?.length) throw new FeedEditError("not_timed");
  const S = real(data, true);
  const L = S[S.length - 1];
  const near = (a: number, b: string) => Math.abs(a - Date.parse(b)) <= NEAR;
  const same =
    L.side === expect.side && near(L.start, expect.start) && (L.end === null ? expect.end === null : expect.end !== null && near(L.end, expect.end));
  if (!same) throw new FeedEditError("not_newest");
  const tap = lastTapOf(data);
  const plan = tapUndo(S, tap);
  if ("refuse" in plan) throw new FeedEditError("nothing_to_undo", plan.refuse === "only" ? {} : { why: plan.refuse });
  plan.apply();
  const out: TapFeedData = settle(data, tidy(S, true, true), true);
  if (tap) out.last_tap = { ...tap, undone: true };
  return { data: out, what: plan.what };
}

/**
 * What undoLastTap would take back on this feed now, and when that tap was
 * made, or null when there's nothing to undo: for the "Tapped Switch by
 * mistake?" / "Didn't mean to pause?" offers, so they only show for the tap
 * that undo really takes back.
 */
export function undoableTap(data: FeedData, ctx: FeedCtx): { what: TapWhat; at: string } | null {
  if (!ctx.active || data.method !== "breast" || !data.segments?.length) return null;
  const plan = tapUndo(real(data, true), lastTapOf(data));
  return "refuse" in plan ? null : { what: plan.what, at: iso(plan.at) };
}

/**
 * The tap record to keep once a restore puts `segments` back: the same tap
 * if it still fits them (no longer undone: "Put it back" after an undo
 * brings the tap back), else none, so undo reads the restored stretches.
 */
export function restoredTap(data: FeedData, segments: Segment[], active: boolean): LastTap | undefined {
  const tap = lastTapOf(data);
  if (!tap || !active) return undefined;
  const { undone: _undone, ...live } = tap;
  void _undone;
  const S = tidy(toStretches(segments), true, false);
  const L = S[S.length - 1];
  if (!L || L.side !== live.side) return undefined;
  // One that undid a switch stands while she's on its side; any other has to fit the stretches as undo reads them.
  if (live.reverted) return L.end === null ? live : undefined;
  return "refuse" in tapUndo(S, live) ? undefined : live;
}

export function startBreast(side: Side, at: Date): FeedData {
  return {
    method: "breast",
    segments: [{ side, start: at.toISOString(), end: null }],
    first_side: side,
    last_side: side,
  };
}

/**
 * Switch to a side, or resume on it when paused. `explicit` is a time someone
 * gave ("she went back on at 4:20"); without it `at` is just now. `now` is
 * when it was tapped (default `at`), for last_tap.
 *   - Already on that side: noop.
 *   - Switching back within 15 s of a switch undoes it (reverted).
 *   - Resuming before the break began starts at the break (clamped); the same
 *     side within a minute of the pause erases the break (merged).
 * `resume` says the person saw the feed paused (a dock's Resume, "Already
 * back on? 5 min ago"), so finding it running means someone else resumed it
 * meanwhile: on the other side, the feed changed under the request
 * (not_newest, which the store answers 409 "changed"), never a silent
 * switch over their resume. On that side, with no time it's a noop; with an
 * explicit time, one before it went back on moves that one moment there
 * (moved; no earlier than the break began, clamped) and a later one is a noop.
 */
export function switchTo(
  data: FeedData,
  side: Side,
  at: Date,
  opts: { explicit?: boolean; resume?: boolean; now?: Date } = {}
): { data: FeedData; noop?: true; clamped?: true; merged?: true; reverted?: true; moved?: true } {
  const S = real(data, true);
  const O = S[S.length - 1]?.end === null ? S[S.length - 1] : null;
  let t = at.getTime();
  const tappedAt = iso((opts.now ?? at).getTime());
  const flags: { clamped?: true; merged?: true; reverted?: true } = {};
  let tap: LastTap;
  if (O) {
    if (opts.resume) {
      if (O.side !== side) throw new FeedEditError("not_newest");
      if (!opts.explicit || t >= O.start - SEC) return { data, noop: true };
      const P = S[S.length - 2];
      // Only a side she went back on after a break moves here; any other shape isn't what was seen.
      if (!P || P.end === null || P.end >= O.start) throw new FeedEditError("not_newest");
      const to = Math.max(t, P.end);
      const moved = moveEdge(data, { edge: "start", ref: refOf(O), to: new Date(to) }, { now: opts.now ?? at, active: true, endedAt: null });
      return { data: moved.data, moved: true, ...(t < P.end ? { clamped: true as const } : {}) };
    }
    if (O.side === side) return { data, noop: true };
    if (opts.explicit && t < O.start + SEC) throw editError("before_own_start", { side: O.side, t: O.start, asked: t, ...firstOf(S, O) });
    const P = S[S.length - 2];
    if (t - O.start < 15 * SEC && P && P.end === O.start && P.side === side) {
      S.pop();
      P.end = null;
      flags.reverted = true;
    } else {
      O.end = Math.max(t, O.start);
      S.push({ side, start: O.end, end: null });
    }
    tap = { kind: "switch", side, at: tappedAt, ...(flags.reverted ? { reverted: true } : {}) };
  } else if (S.length) {
    const L = S[S.length - 1];
    const lEnd = L.end!;
    if (t < lEnd) {
      t = lEnd;
      flags.clamped = true;
    }
    if (side === L.side && t - lEnd < MIN) {
      L.end = null;
      flags.merged = true;
    } else S.push({ side, start: t, end: null });
    tap = { kind: "resume", side, at: tappedAt, paused_at: iso(lEnd), ...(flags.merged ? { merged: true } : {}) };
  } else {
    S.push({ side, start: t, end: null });
    return { data: { ...settle(data, tidy(S, true, true), true), last_side: side }, ...flags };
  }
  const out: TapFeedData = { ...settle(data, tidy(S, true, true), true), last_side: side, last_tap: tap };
  return { data: out, ...flags };
}

/** before_own_start's `first` when the refused side is the feed's only one: then its start is the feed start, and there's no tap to take back. */
const firstOf = (S: Stretch[], s: Stretch): { first?: string } => (S[0] === s && S.length === 1 ? { first: "1" } : {});

/** Pause the open side at `at` (`now`: when it was tapped, default `at`). Already paused: noop. */
export function pause(data: FeedData, at: Date, opts: { explicit?: boolean; now?: Date } = {}): { data: FeedData; noop?: true } {
  const S = real(data, true);
  const O = S[S.length - 1]?.end === null ? S[S.length - 1] : null;
  if (!O) return { data, noop: true };
  const t = at.getTime();
  if (opts.explicit && t < O.start + SEC) throw editError("before_own_start", { side: O.side, t: O.start, asked: t, ...firstOf(S, O) });
  O.end = Math.max(t, O.start);
  const out: TapFeedData = { ...settle(data, tidy(S, true, true), true), last_tap: { kind: "pause", side: O.side, at: iso((opts.now ?? at).getTime()) } };
  return { data: out };
}

/**
 * Freeze a finished nursing session: close the open side at `at` (never
 * before it began), store totals + sides. `pausedAtStop` marks a feed that
 * ended at its pause, so reopening brings it back paused.
 */
export function finalizeBreast(data: FeedData, at: Date, opts: { pausedAtStop?: boolean } = {}): FeedData {
  let out: FeedData = { ...data };
  if (data.segments?.length) {
    const S = real(data, true);
    for (const s of S) if (s.end === null) s.end = Math.max(at.getTime(), s.start);
    // Lenient: a stop must never fail over an odd old row.
    out = settle(data, tidy(S, false, false), false);
  }
  if (opts.pausedAtStop) out.paused_at_stop = true;
  else delete out.paused_at_stop;
  return out;
}

/**
 * The one stop rule for a timed feed (Done, Fell asleep, Still nursing?,
 * stop_timer). Running: end at `at` (default now, never later), but an
 * explicit time before the current side began is refused, not clamped.
 * Paused: end at the pause; a time before the pause trims the last side to
 * it; a time before that side began is refused.
 */
export function stopBreast(data: FeedData, at: Date | undefined, now: Date): { data: FeedData; endedAt: string; pausedAtStop: boolean } {
  const S = real(data, true);
  const last = S[S.length - 1];
  const t = at?.getTime();
  if (!last || last.end === null) {
    const stopAt = Math.min(t ?? now.getTime(), now.getTime());
    if (last && t !== undefined && t < last.start + SEC) throw editError("before_own_start", { side: last.side, t: last.start, asked: t, then: "stop_timer", ...firstOf(S, last) });
    const out = finalizeBreast(data, new Date(stopAt));
    return { data: out, endedAt: iso(Math.max(stopAt, last?.start ?? stopAt)), pausedAtStop: false };
  }
  const lEnd = last.end;
  if (t === undefined || t >= lEnd) return { data: finalizeBreast(data, new Date(lEnd), { pausedAtStop: true }), endedAt: iso(lEnd), pausedAtStop: true };
  if (t < last.start + SEC) throw editError("before_own_start", { side: last.side, t: last.start, asked: t, then: "stop_timer", ...firstOf(S, last) });
  const moved = moveEdge(data, { edge: "end", ref: refOf(last), to: new Date(t) }, { now, active: true, endedAt: null });
  return { data: finalizeBreast(moved.data, new Date(t), { pausedAtStop: true }), endedAt: iso(t), pausedAtStop: true };
}

/**
 * Move a timed nursing session's start and/or end, as FeedSheet's Started
 * and Ended fields do: the start moves the first side's start, the end the
 * last side's end. A session stopped while paused before paused_at_stop
 * existed keeps its pause: an end inside the gap leaves the sides alone (only
 * ended_at moves, which the caller stores), and only an end before the pause
 * trims the last side. Both moves together can shift a one-side feed either
 * way as a whole. Throws a plain Error with the sheet's wording when a move
 * doesn't fit.
 */
export function retimeBreast(data: FeedData, change: { start?: Date; end?: Date; prevEnd?: Date | null }): FeedData {
  if (!data.segments?.length) return data;
  const ctx: FeedCtx = { now: new Date(), active: !change.prevEnd, endedAt: change.prevEnd?.toISOString() ?? null };
  const step = (d: FeedData, which: "start" | "end"): FeedData => {
    const S = real(d, ctx.active);
    const last = S[S.length - 1];
    if (which === "start") return change.start ? moveEdge(d, { edge: "start", ref: refOf(S[0]), to: change.start }, ctx).data : d;
    if (!change.end || last.end === null) return d;
    const { legacy } = ending(S, d, ctx);
    if (legacy && change.end.getTime() >= last.end) return d;
    return moveEdge(d, { edge: "end", ref: refOf(last), to: change.end }, ctx).data;
  };
  const run = (order: ("start" | "end")[]) => order.reduce(step, data);
  try {
    try {
      return run(["start", "end"]);
    } catch (first) {
      // Moving a whole feed later has to move its end first.
      if (!change.start || !change.end) throw first;
      try {
        return run(["end", "start"]);
      } catch {
        throw first;
      }
    }
  } catch (e) {
    throw e instanceof FeedEditError ? new Error(e.message) : e;
  }
}

/** Totals for any feed: from segments when present, else the manual numbers. */
export function feedTotals(data: FeedData, now: Date): { left: number; right: number; total: number } {
  if (data.segments?.length) {
    const t = sideTotals(data.segments, now);
    return { ...t, total: t.left + t.right };
  }
  const left = Math.round(data.left_sec ?? 0);
  const right = Math.round(data.right_sec ?? 0);
  return { left, right, total: left + right };
}

// ── words ────────────────────────────────────────────────────────────────

/**
 * The preview under a moment editor: "Break 15 → 10 min · Right 5 min longer ·
 * Left unchanged". Changed items first (break, then sides), then the sides
 * that stay put. A side still going reads as a delta, so it doesn't tick.
 * Counted in the rows' whole minutes (spanMinutes), so a move is measured
 * from the displayed minute: Right's start 2:52 → 2:44 is "8 min longer"
 * whatever the seconds, and the numbers match the rows before and after.
 */
export function describeChange(beforeParts: Part[], afterParts: Part[]): string {
  const a = partTotals(beforeParts).min;
  const b = partTotals(afterParts).min;
  // A part with time but no whole minute is "<1"; one that's gone is 0.
  const num = (m: number, present: boolean) => (m > 0 ? String(m) : present ? "<1" : "0");
  const long = (m: number, present: boolean) => (m > 0 || present ? minutesText(m) : "0 min");
  const span = (x: number, px: boolean, y: number, py: boolean) =>
    x < 60 && y < 60 ? `${num(x, px)} → ${num(y, py)} min` : `${long(x, px)} → ${long(y, py)}`;
  const changed: string[] = [];
  const same: string[] = [];
  const hasBreak = (parts: Part[]) => parts.some((p) => p.kind === "break");
  if (a.breaks !== b.breaks) {
    changed.push(!hasBreak(afterParts) ? `No break (was ${minutesText(a.breaks)})` : `Break ${span(a.breaks, hasBreak(beforeParts), b.breaks, true)}`);
  }
  for (const side of ["L", "R"] as const) {
    const has = (parts: Part[]) => parts.some((p) => p.kind === "side" && p.side === side);
    if (!has(beforeParts) && !has(afterParts)) continue;
    const open = [...beforeParts, ...afterParts].some((p) => p.kind === "side" && p.side === side && p.end === null);
    const x = side === "L" ? a.left : a.right;
    const y = side === "L" ? b.left : b.right;
    const name = SIDE_NAME[side];
    if (x === y) same.push(name);
    else if (open) changed.push(`${name} ${minutesText(Math.abs(y - x))} ${y > x ? "longer" : "shorter"}`);
    else changed.push(`${name} ${span(x, has(beforeParts), y, has(afterParts))}`);
  }
  if (!changed.length) return "No change";
  return [...changed, ...same.map((n) => `${n} unchanged`)].join(" · ");
}

/**
 * The words for a FeedEditError: "ui" for the sheet and toasts, "mcp" for
 * Claude and ChatGPT (which can act on a tool name). before_own_start on MCP
 * ends "then {params.then}" ("try again" unless the caller names a tool).
 */
export function feedEditCopy(err: FeedEditError, surface: "ui" | "mcp", tz: string = DEFAULT_TZ): string {
  const p = err.params;
  const mcp = surface === "mcp";
  const t = p.t ? formatTime(p.t, tz) : "";
  const name = (k: string) => (p[k] === "L" || p[k] === "R" ? SIDE_NAME[p[k] as Side] : "");
  switch (err.code) {
    case "future":
      return mcp ? `That time is in the future; it's ${formatTime(p.now ?? new Date(), tz)} for Maple.` : "That's in the future.";
    case "too_early":
      return "That's more than 6 hours before the feed started.";
    case "before_prev_start":
      return mcp ? `${name("prev")} started at ${t}; the switch has to be after that.` : `Can't be before ${name("prev")} started (${t}).`;
    case "before_break":
      return mcp
        ? `The break began at ${t}. For no break, use at: "${t}".`
        : `Can't be before she came off (${t}). For no break, pick ${formatTimeNear(p.t, p.t, tz)}.`;
    case "after_next":
      return p.next === "end" ? `Can't be after the feed ended (${t}).` : `Can't be after ${name("next")} started (${t}).`;
    case "after_own_end":
      return `Can't be after ${name("side")} ended (${t}).`;
    case "before_own_start": {
      const side = name("side");
      if (!mcp) return `Can't be before ${side} started (${t}).`;
      const asked = p.asked ? `, after ${formatTimeNear(p.asked, p.t, tz)}` : "";
      // The feed's only side: no tap to take back, so either the start is off or the time asked is.
      if (p.first) {
        return `The feed started at ${t}${asked}. If it really started earlier, fix that first with fix_nursing_time {part:"feed_start", at:"…"}, then ${p.then ?? "try again"}; otherwise give a time after ${t}.`;
      }
      return `The ${side} side started at ${t}${asked}. If ${side} was a mistaken tap, call fix_nursing_time {undo_last_tap:true} first, then ${p.then ?? "try again"}.`;
    }
    case "overlap":
      return `That overlaps ${name("side")} ${formatRange(p.start, p.end || null, tz, { compact: true })}.`;
    case "use_stop":
      return mcp ? "The feed is still going; to end it earlier use stop_timer with at." : "Use She already finished to end the feed.";
    case "nothing_to_undo":
      if (p.why === "taken_back") {
        return mcp
          ? "The latest tap on this feed was already taken back, so there's no tap left to undo. To fix a time, use fix_nursing_time with part and at."
          : "That tap was already undone.";
      }
      if (p.why === "changed") {
        return mcp
          ? "The times were fixed after the latest tap, so there's no tap left to undo. Use fix_nursing_time with part and at instead."
          : "The times were fixed after that tap, so there's nothing to undo.";
      }
      return mcp ? "That's the only tap on this feed; delete_entry removes the whole feed." : "Nothing to undo; use Discard.";
    case "not_timed":
      return "That feed wasn't timed, so its parts can't be fixed.";
    case "too_many":
      return "Too many parts (60 max).";
    case "not_found":
    case "not_newest":
      return mcp ? "The feed changed since you looked; call maple_status and try again." : "This feed just changed, so nothing was saved. Have another look.";
  }
}

/**
 * When the feed before `e` ended: the newest finished feed that ended by
 * its start (null if none in `entries`). Start chips stop there, so a chip
 * can't lay a new feed over the last one.
 */
export function previousFeedEnd(entries: readonly Entry[] | undefined, e: { id: number; started_at: string }): number | null {
  const start = Date.parse(e.started_at);
  let best: number | null = null;
  for (const x of entries ?? []) {
    if (x.kind !== "feed" || x.id === e.id || x.active || !x.ended_at) continue;
    const t = Date.parse(x.ended_at);
    if (t <= start + SEC && (best === null || t > best)) best = t;
  }
  return best;
}

/** A break this long ended the feed, for staleFeed (Still on a break? asks at 20 min). */
const STALE_BREAK = 30 * MIN;

/**
 * When anything last happened on a feed: its start, any stretch's start or
 * end, or the latest tap (a pause tapped late records an earlier end, but
 * someone was there when they tapped it).
 */
function lastActivity(e: { started_at: string; data: FeedData }): number {
  const tap = lastTapOf(e.data);
  const tapped = tap ? Date.parse(tap.at) : NaN;
  return Math.max(Date.parse(e.started_at), ...real(e.data, true).flatMap((s) => [s.start, s.end ?? 0]), Number.isNaN(tapped) ? 0 : tapped);
}

/**
 * A running feed nobody tapped Done on, so "start a feed" (MCP start_timer,
 * Siri's nurse_left / nurse_right) must not switch sides on it, which would
 * glue two feeds together. Judged by its newest activity, not its start, so
 * a long cluster feed tapped two minutes ago is still this feed: stale when
 * nothing happened on it for an hour (a side left on, or a break that became
 * the end), or, on a break, when the start time someone gave is over 30 min
 * after she came off (a new feed). A side that's on is going on now, so a
 * time given then only switches.
 */
export function staleFeed(e: { started_at: string; data: FeedData }, now: Date, given?: Date | null): boolean {
  const newest = lastActivity(e);
  const S = real(e.data, true);
  const onBreak = S.length > 0 && S[S.length - 1].end !== null;
  // A time given while she's off is when she went back on: within 30 min of the pause it's this feed, however long ago.
  if (given && onBreak) return given.getTime() - newest > STALE_BREAK;
  return now.getTime() - newest > HOUR;
}

/**
 * Which side to offer first next time: the opposite of the side the last
 * nursing session started on. (L→R last time? start on R. Only L? start on R.)
 */
export function suggestNextSide(last: FeedData | null | undefined): Side | null {
  if (!last || last.method !== "breast") return null;
  const first = last.first_side ?? last.segments?.[0]?.side;
  if (first) return other(first);
  const { left_sec = 0, right_sec = 0 } = last;
  if (left_sec > 0 && right_sec === 0) return "R";
  if (right_sec > 0 && left_sec === 0) return "L";
  return null;
}

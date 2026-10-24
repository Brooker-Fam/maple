/**
 * Assertions for the nursing timer engine (src/lib/maple/feed.ts): every
 * engine-level fixture of the Fix times acceptance tests plus the edge cases
 * the engine promises (sub-second taps, snapping, merges, overlaps, the
 * switch-back rule, paused clamp/merge, each moveEdge row, legacy trailing
 * breaks, describeChange wording, feedEditCopy for every code).
 *
 *   npx tsx scripts/maple-feed-check.ts      (or pnpm check:maple-feed)
 *
 * No test runner and no dependencies: one PASS/FAIL line per case, exit 1 on
 * any failure. Times are wall clock in America/New_York on one past test
 * day (retimeBreast checks against the real now).
 */
import {
  addPart,
  describeChange,
  edgeBounds,
  feedEditCopy,
  FeedEditError,
  feedMinutes,
  feedParts,
  finalizeBreast,
  minutesShort,
  minutesText,
  momentQuestion,
  moveEdge,
  normalizeSegments,
  partTotals,
  pause,
  previousFeed,
  previousFeedEnd,
  restoredTap,
  retimeBreast,
  setSide,
  sideMinutesText,
  spanMinutes,
  staleFeed,
  stopBreast,
  summarize,
  switchTo,
  undoableTap,
  undoLastTap,
  type FeedCtx,
  type FeedEditCode,
  type Part,
  type TapFeedData,
} from "../src/lib/maple/feed";
import { timerNumbers } from "../src/components/maple/FeedParts";
import { describeEntry } from "../src/lib/maple/describe";
import { memberLabel, statsFor, summarize as summarizeDay } from "../src/lib/maple/insights";
import { formatClock, formatMinutes, formatRange, formatTimeNear, localParts, zonedTimeToUtc } from "../src/lib/maple/time";
import type { Baby, EntryOf, FeedData, Member, Segment, Side } from "../src/lib/maple/types";

const TZ = "America/New_York";

// ── harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Browsers put a narrow no-break space before AM/PM; compare as plain spaces.
const plain = (v: unknown) => (typeof v === "string" ? v.replace(/ /g, " ") : v);

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(plain(actual));
  const e = JSON.stringify(plain(expected));
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

function throwsCode(fn: () => unknown, code: FeedEditCode): FeedEditError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FeedEditError && e.code === code) return e;
    throw new Error(`expected ${code}, got ${e instanceof FeedEditError ? e.code : e instanceof Error ? `Error "${e.message}"` : String(e)}`);
  }
  throw new Error(`expected ${code}, nothing thrown`);
}

function throwsPlain(fn: () => unknown, what: string): Error {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && !(e instanceof FeedEditError)) return e;
    throw new Error(`${what}: expected a plain Error, got ${e instanceof FeedEditError ? e.code : String(e)}`);
  }
  throw new Error(`${what}: nothing thrown`);
}

// ── fixtures ─────────────────────────────────────────────────────────────

/** "16:05" / "16:05:00.4" on the test day → ISO. */
function T(hms: string): string {
  const [h, m, s = "0"] = hms.split(":");
  return new Date(zonedTimeToUtc(2026, 10, 21, Number(h), Number(m), TZ).getTime() + Number(s) * 1000).toISOString();
}
const D = (hms: string) => new Date(T(hms));

/** "L 16:00-16:10, R 16:20-" → segments (an empty end is open). */
function segs(spec: string): Segment[] {
  if (!spec.trim()) return [];
  return spec.split(",").map((x) => {
    const [side, range] = x.trim().split(/\s+/);
    const [a, b] = range.split("-");
    return { side: side as Side, start: T(a), end: b ? T(b) : null };
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
function clock(isoTime: string): string {
  const p = localParts(Date.parse(isoTime), TZ);
  const ms = Date.parse(isoTime) % 1000;
  let out = `${pad(p.hour)}:${pad(p.minute)}`;
  if (p.second || ms) out += `:${pad(p.second)}${ms ? `.${String(ms).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
  return out;
}
const show = (list: Segment[] | undefined) => (list ?? []).map((s) => `${s.side} ${clock(s.start)}-${s.end ? clock(s.end) : ""}`).join(", ");
const eqSegs = (actual: Segment[] | undefined, expected: string) => eq(show(actual), show(segs(expected)), "segments");
const eqTime = (actual: string | Date | null | undefined, expected: string | null, what: string) =>
  eq(actual == null ? null : clock(new Date(actual).toISOString()), expected === null ? null : clock(T(expected)), what);

const feed = (spec: string, extra: Partial<FeedData> = {}): FeedData => ({ method: "breast", segments: segs(spec), ...extra });
const live = (now: string): FeedCtx => ({ now: D(now), active: true, endedAt: null });
const done = (now: string, endedAt: string, pausedAtStop?: boolean): FeedCtx => ({ now: D(now), active: false, endedAt: T(endedAt), pausedAtStop });
const ref = (side: Side, at: string) => ({ side, start: T(at) });

/** Parts as readable rows, in the whole minutes the card shows: "L 16:00-16:10 10 min", "Break 16:10- 20 min". */
const rows = (parts: Part[]) =>
  parts.map((p) => `${p.kind === "side" ? p.side : p.legacy ? "Legacy" : "Break"} ${clock(p.start)}-${p.end ? clock(p.end) : ""} ${minutesText(p.min)}`);

/** describeChange of one moveEdge, both sides seen at the same now. */
function preview(data: FeedData, edit: Parameters<typeof moveEdge>[1], ctx: FeedCtx): string {
  return describeChange(feedParts(data, ctx), feedParts(moveEdge(data, edit, ctx).data, { ...ctx, endedAt: moveEdge(data, edit, ctx).endedAt }));
}

const noSigns = (s: string) => ok(!/[+−]/.test(s), `"${s}" contains + or −`);

// ── formatting (§1.4) ────────────────────────────────────────────────────

check("formatRange shares AM/PM", () => eq(formatRange(T("16:00"), T("16:10"), TZ), "4:00 – 4:10 PM"));
check("formatRange across midnight", () => eq(formatRange(T("23:50"), new Date(D("00:10").getTime() + 864e5), TZ), "11:50 PM – 12:10 AM"));
check("formatRange compact", () => {
  eq(formatRange(T("16:00"), T("16:10"), TZ, { compact: true }), "4:00–4:10");
  eq(formatRange(T("11:50"), T("12:10"), TZ, { compact: true }), "11:50 AM–12:10 PM");
});
check("formatRange open end", () => {
  eq(formatRange(T("16:25"), null, TZ), "since 4:25 PM");
  eq(formatRange(T("16:25"), null, TZ, { compact: true }), "since 4:25");
});
check("formatMinutes", () => {
  eq([0, 1, 20, 29, 30, 22 * 60, 72 * 60, 75 * 60].map(formatMinutes), ["0 min", "<1 min", "<1 min", "<1 min", "1 min", "22 min", "1h 12m", "1h 15m"]);
});
check("formatTimeNear drops a shared AM/PM only", () => {
  eq(formatTimeNear(T("16:20"), T("16:25"), TZ), "4:20");
  eq(formatTimeNear(T("11:58"), T("12:03"), TZ), "11:58 AM");
});
check("momentQuestion titles (§1.2)", () => {
  eq(momentQuestion("feed_start", "L"), "When did the feed start?");
  eq(momentQuestion("switch", "R"), "When did she switch to Right?");
  eq(momentQuestion("pause", "L"), "When did she come off the Left?");
  eq(momentQuestion("resume", "R"), "When did she go back on the Right?");
  // fix-everything NEW[2]: "back on" only when she came off that side before the break.
  eq(momentQuestion("resume", "R", "R"), "When did she go back on the Right?");
  eq(momentQuestion("resume", "R", "L"), "When did she go on the Right?");
  eq(momentQuestion("feed_end", "R"), "When did the feed end?");
});

// ── normalizeSegments (§9.1) ─────────────────────────────────────────────

check("normalize: sub-second double switch vanishes and the sides merge", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:05, R 16:05:00-16:05:00.4, L 16:05:00.4-"), { active: true }), "L 16:00-"));
check("normalize: a lone sub-second stretch is kept", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:00:00.5"), { active: false }), "L 16:00-16:00:00.5"));
check("normalize: all sub-second keeps only the last", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:00:00.3, R 16:00:00.3-16:00:00.6"), { active: false }), "R 16:00:00.3-16:00:00.6"));
check("normalize: a start within 1 s after an end snaps onto it", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:10, R 16:10:00.6-"), { active: true }), "L 16:00-16:10, R 16:10-"));
check("normalize: an overlap under 1 s snaps", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:10, R 16:09:59.5-"), { active: true }), "L 16:00-16:10, R 16:10-"));
check("normalize: touching same-side stretches merge", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:10, L 16:10-16:20, R 16:20-16:30"), { active: false }), "L 16:00-16:20, R 16:20-16:30"));
check("normalize: same side after a gap stays two stretches", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:10, L 16:11:30-"), { active: true }), "L 16:00-16:10, L 16:11:30-"));
check("normalize: sorts by start", () =>
  eqSegs(normalizeSegments(segs("R 16:10-16:20, L 16:00-16:10"), { active: false }), "L 16:00-16:10, R 16:10-16:20"));
check("normalize: a snap that leaves a sub-second stretch drops it too", () =>
  eqSegs(normalizeSegments(segs("L 16:00-16:10, R 16:09:59.5-16:10:00.6, L 16:10:01-"), { active: true }), "L 16:00-"));
check("normalize: overlap over 1 s throws overlap", () => {
  const e = throwsCode(() => normalizeSegments(segs("L 16:00-16:10, R 16:05-16:20"), { active: false }), "overlap");
  eq(feedEditCopy(e, "ui", TZ), "That overlaps Left 4:00–4:10.");
});
check("normalize: open stretch not last throws", () => throwsPlain(() => normalizeSegments(segs("L 16:00-, R 16:10-16:20"), { active: true }), "open"));
check("normalize: open stretch on a finished feed throws", () => throwsPlain(() => normalizeSegments(segs("L 16:00-"), { active: false }), "finished"));
check("normalize: end before start throws", () => throwsPlain(() => normalizeSegments(segs("L 16:10-16:00"), { active: false }), "reversed"));
check("normalize: more than 60 stretches throws too_many", () => {
  const many: Segment[] = Array.from({ length: 61 }, (_, i) => ({
    side: i % 2 ? "R" : "L",
    start: new Date(D("12:00").getTime() + i * 60_000).toISOString(),
    end: new Date(D("12:00").getTime() + (i + 1) * 60_000).toISOString(),
  }));
  throwsCode(() => normalizeSegments(many, { active: false }), "too_many");
  eq(normalizeSegments(many.slice(0, 60), { active: false }).length, 60, "60 is fine");
});
check("normalize: idempotent", () => {
  const once = normalizeSegments(segs("L 16:00-16:05, R 16:05:00.5-16:05:01, R 16:05:01.2-16:20, L 16:30-"), { active: true });
  eq(show(normalizeSegments(once, { active: true })), show(once));
  // The sub-second R goes; the 1.2 s gap left after it is a real break.
  eqSegs(once, "L 16:00-16:05, R 16:05:01.2-16:20, L 16:30-");
});

// ── summarize / feedParts (§9.2) ─────────────────────────────────────────

check("summarize: closed real stretches and first/last side", () => {
  eq(summarize(segs("L 16:00-16:15, R 16:15-16:30")), { left_sec: 900, right_sec: 900, first_side: "L", last_side: "R" });
  eq(summarize(segs("R 15:59:59.5-16:00, L 16:00-16:10")), { left_sec: 600, right_sec: 0, first_side: "L", last_side: "L" });
});
check("feedParts: screenshot case (S11-1)", () => {
  const ctx = live("23:43:02");
  const parts = feedParts(feed("L 23:04-23:26, R 23:37-"), ctx);
  eq(rows(parts), ["L 23:04-23:26 22 min", "Break 23:26-23:37 11 min", "R 23:37- 6 min"]);
  eq(formatRange(parts[0].start, parts[0].end, TZ), "11:04 – 11:26 PM");
  eq(formatRange(parts[1].start, parts[1].end, TZ), "11:26 – 11:37 PM");
  eq(formatClock(parts[2].sec), "6:02", "live clock");
  // Left 22:00 + Right 6:02 (the spec's sketch rounds this to 28:00).
  eq(formatClock(partTotals(parts).nursing), "28:02", "total nursing");
  const side = parts[0].kind === "side" ? parts[0] : null;
  eq([side?.startMoment, side?.endMoment], ["feed_start", "pause"]);
  const cur = parts[2].kind === "side" ? parts[2] : null;
  eq([cur?.startMoment, cur?.endMoment], ["resume", null]);
});
check("feedParts: paused feed ends in an open break", () => {
  const parts = feedParts(feed("L 16:00-16:10"), live("16:30"));
  eq(rows(parts), ["L 16:00-16:10 10 min", "Break 16:10- 20 min"]);
  const b = parts[1];
  eq(b.kind === "break" ? [b.before.side, b.after] : null, ["L", null]);
});
check("feedParts: switch and feed end moments", () => {
  const parts = feedParts(feed("L 16:00-16:15, R 16:15-16:30"), done("17:00", "16:30"));
  eq(parts.map((p) => (p.kind === "side" ? `${p.startMoment}/${p.endMoment}` : "break")), ["feed_start/switch", "switch/feed_end"]);
});
check("feedParts: legacy trailing break (S7e)", () => {
  const parts = feedParts(feed("L 16:00-16:10"), done("17:00", "16:30"));
  eq(rows(parts), ["L 16:00-16:10 10 min", "Legacy 16:10-16:30 20 min"]);
  eq(parts[0].kind === "side" && parts[0].endMoment, "pause");
});
check("feedParts: flagged paused stop has no trailing break", () => {
  const parts = feedParts(feed("L 16:00-16:10", { paused_at_stop: true }), done("17:00", "16:10"));
  eq(rows(parts), ["L 16:00-16:10 10 min"]);
  eq(parts[0].kind === "side" && parts[0].endMoment, "feed_end");
});
check("feedParts: break rows read their clock minutes, and <1 min within one minute", () => {
  // 4:10 – 4:11 PM is 1 min, whatever the 30 s (rounding said 2, against its own range).
  eq(rows(feedParts(switchTo(feed("L 16:00-16:10"), "L", D("16:11:30")).data, live("16:12")))[1], "Break 16:10-16:11:30 1 min");
  eq(rows(feedParts(switchTo(feed("L 16:00-16:10"), "R", D("16:10:20")).data, live("16:12")))[1], "Break 16:10-16:10:20 <1 min");
});
check("feedParts: odd stored data is repaired, not thrown", () => {
  const parts = feedParts(feed("L 16:00-16:10, R 16:05-16:20"), done("17:00", "16:20"));
  eq(rows(parts), ["L 16:00-16:10 10 min", "R 16:10-16:20 10 min"]);
});

// ── whole minutes: one rule everywhere (spanMinutes) ─────────────────────

/** A feed entry around `data`, for the list, day-total and toast helpers. */
const entryOf = (data: FeedData, ctx: FeedCtx): EntryOf<"feed"> => {
  const S = data.segments ?? [];
  const at = S[0]?.start ?? T("16:00");
  return {
    id: 1, kind: "feed", started_at: at, ended_at: ctx.active ? null : ctx.endedAt, active: ctx.active, data, note: null,
    created_by: null, updated_by: null, source: "web", created_at: at, updated_at: at,
  };
};
// The tester's feed: Left 12:30 and Right 24:26, which rounding showed as L 13 · R 24 = "36m".
const odd = feed("L 02:15:10-02:27:40, R 02:27:40-02:52:06");
const oddCtx = done("03:30", "02:52:06");

check("minutes: a part is the difference of its displayed clock minutes", () => {
  eq(spanMinutes(T("02:27:05"), T("02:36:40")), 9, "2:27 – 2:36 (9:35 of seconds)");
  eq(spanMinutes(T("02:16:50"), T("02:17:10")), 1, "2:16 – 2:17, a 20 s break");
  eq(spanMinutes(T("02:27:05"), T("02:27:55")), 0, "same minute, 50 s");
  eq(spanMinutes(T("02:30"), T("02:20")), 0, "never negative");
});
check("minutes: words", () => {
  eq([0, 1, 9, 59, 60, 72].map(minutesText), ["<1 min", "1 min", "9 min", "59 min", "1h 00m", "1h 12m"]);
  eq([0, 1, 12, 72].map(minutesShort), ["<1m", "1m", "12m", "1h 12m"]);
});
check("minutes: rows, sides, total and toast agree (the tester's feed)", () => {
  const parts = feedParts(odd, oddCtx);
  eq(rows(parts), ["L 02:15:10-02:27:40 12 min", "R 02:27:40-02:52:06 25 min"]);
  const t = feedMinutes(entryOf(odd, oddCtx), D("03:30"));
  eq([t.left, t.right, t.total], [12, 25, 37]);
  eq(t.total, t.left + t.right, "sides add up");
  eq(sideMinutesText(t), "L 12 · R 25");
  // And the feed's own range, 2:15 – 2:52 AM, is 37 min.
  eq(spanMinutes(parts[0].start, parts[1].end!), t.total, "the clock span");
  eq(partTotals(parts).min, { left: 12, right: 25, nursing: 37, breaks: 0 });
});
check("minutes: lists and the day's totals use the same numbers", () => {
  const e = entryOf(odd, oddCtx);
  eq(describeEntry(e, { now: D("03:30") }).detail, "L 12m, R 25m");
  const s = statsFor([e], D("00:00"), D("23:59"), "day", D("03:30"));
  eq([s.leftSec, s.rightSec, s.nursingSec], [12 * 60, 25 * 60, 37 * 60]);
});
check("minutes: sides and breaks add up to the feed's clock span", () => {
  const d = feed("L 02:15:10-02:27:40, R 02:27:40-02:31:20, R 02:40:45-02:52:06");
  const t = partTotals(feedParts(d, done("03:30", "02:52:06"))).min;
  eq(t, { left: 12, right: 4 + 12, nursing: 28, breaks: 9 });
  eq(t.nursing + t.breaks, spanMinutes(T("02:15:10"), T("02:52:06")), "2:15 – 2:52");
});
check("minutes: a side under a minute is <1, and counts 0", () => {
  const d = feed("L 02:00:10-02:00:50, R 02:00:50-02:10:20");
  const t = feedMinutes(entryOf(d, done("03:00", "02:10:20")), D("03:00"));
  eq([t.left, t.right, t.total], [0, 10, 10]);
  eq(sideMinutesText(t), "L <1 · R 10");
  eq(rows(feedParts(d, done("03:00", "02:10:20")))[0], "L 02:00:10-02:00:50 <1 min");
});
check("minutes: a running feed counts the live part up to now's clock minute", () => {
  const d = feed("L 02:15:10-02:27:40, R 02:27:40-");
  const now = "02:40:05";
  eq(rows(feedParts(d, live(now))), ["L 02:15:10-02:27:40 12 min", "R 02:27:40- 13 min"]);
  const t = feedMinutes(entryOf(d, live(now)), D(now));
  eq([t.left, t.right, t.total], [12, 13, 25]);
});
check("minutes: typed minutes (no segments) round their seconds", () => {
  const d: FeedData = { method: "breast", left_sec: 600, right_sec: 20 };
  const t = feedMinutes(entryOf(d, done("17:00", "16:10")), D("17:00"));
  eq([t.left, t.right, t.total, t.has], [10, 0, 10, { L: true, R: true }]);
  eq(sideMinutesText(t), "L 10 · R <1");
});
check("minutes: a move is measured from the displayed minute", () => {
  // Right started 2:52:40, moved to 2:44: "8 min longer" (the seconds said 8:40, which rounded to 9).
  const d = feed("L 02:30:00-02:52:40, R 02:52:40-");
  eq(preview(d, { edge: "start", ref: ref("R", "02:52:40"), to: D("02:44") }, live("03:01:20")), "Left 22 → 14 min · Right 8 min longer");
  // Finished: the preview's after numbers are the after rows.
  const e2 = moveEdge(odd, { edge: "start", ref: ref("R", "02:27:40"), to: D("02:24") }, oddCtx);
  const after = feedParts(e2.data, { ...oddCtx, endedAt: e2.endedAt });
  eq(describeChange(feedParts(odd, oddCtx), after), "Left 12 → 9 min · Right 25 → 28 min");
  eq(rows(after), ["L 02:15:10-02:24 9 min", "R 02:24-02:52:06 28 min"]);
});
check("minutes: a break that shrinks under a minute reads <1, gone reads No break", () => {
  const d = feed("L 16:00-16:10, R 16:15-16:30");
  const ctx = done("17:00", "16:30");
  eq(preview(d, { edge: "start", ref: ref("R", "16:15"), to: D("16:10:40") }, ctx), "Break 5 → <1 min · Right 15 → 20 min · Left unchanged");
  eq(preview(d, { edge: "start", ref: ref("R", "16:15"), to: D("16:10") }, ctx), "No break (was 5 min) · Right 15 → 20 min · Left unchanged");
});

// ── S1: Matt's case, the Right after a break ─────────────────────────────

const s1 = feed("L 16:00-16:10, R 16:25-");
check("S1a: 5 min earlier moves only the Right start", () => {
  const r = moveEdge(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:25:05"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:20-");
  eqTime(r.startedAt, "16:00", "started_at");
  eq(r.endedAt, null, "ended_at");
  eq(r.moment, "resume");
  const parts = feedParts(r.data, live("16:25:05"));
  eq(rows(parts), ["L 16:00-16:10 10 min", "Break 16:10-16:20 10 min", "R 16:20- 5 min"]);
  eq(formatRange(parts[1].start, parts[1].end, TZ), "4:10 – 4:20 PM");
  eq(formatClock(parts[2].sec), "5:05", "big number");
  eq(formatClock(partTotals(parts).nursing), "15:05", "total nursing");
});
check("S1b: resume bounds (floor = pause start)", () => {
  const b = edgeBounds(s1, { edge: "start", ref: ref("R", "16:25") }, live("16:27"));
  eqTime(b.min, "16:10", "min");
  eqTime(b.uiMin, "16:10", "uiMin");
  eqTime(b.floor, "16:10", "floor");
  eqTime(b.max, "16:26:59", "max");
  eqTime(b.recorded, "16:25", "recorded");
  eq(b.moment, "resume");
});
check("S1c: No break turns the resume into a switch", () => {
  const r = moveEdge(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:10") }, live("16:27"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:10-");
  const parts = feedParts(r.data, live("16:27"));
  eq(parts[1].kind === "side" && parts[1].startMoment, "switch");
  eq(describeChange(feedParts(s1, live("16:27")), parts), "No break (was 15 min) · Right 15 min longer · Left unchanged");
});
check("S1c: restore segments validate", () => eqSegs(normalizeSegments(s1.segments!, { active: true }), "L 16:00-16:10, R 16:25-"));
check("S1d: before the break is refused with the no-break hint", () => {
  const e = throwsCode(() => moveEdge(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:05") }, live("16:27")), "before_break");
  eq(feedEditCopy(e, "ui", TZ), "Can't be before she came off (4:10 PM). For no break, pick 4:10.");
  eq(feedEditCopy(e, "mcp", TZ), 'The break began at 4:10 PM. For no break, use at: "4:10 PM".');
});
check("S1d: preview at 4:20", () =>
  eq(preview(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:27")), "Break 15 → 10 min · Right 5 min longer · Left unchanged"));
check("S1: resume within 1 s of the pause snaps to it", () =>
  eqSegs(moveEdge(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:10:00.5") }, live("16:27")).data.segments, "L 16:00-16:10, R 16:10-"));
check("S1: same-side resume moved to the pause merges", () =>
  eqSegs(moveEdge(feed("L 16:00-16:10, L 16:25-"), { edge: "start", ref: ref("L", "16:25"), to: D("16:10") }, live("16:27")).data.segments, "L 16:00-"));
check("ref matches within 1.5 s", () =>
  eqSegs(moveEdge(s1, { edge: "start", ref: { side: "R", start: new Date(D("16:25").getTime() + 1200).toISOString() }, to: D("16:20") }, live("16:27")).data.segments, "L 16:00-16:10, R 16:20-"));
check("not_found for a ref that isn't there", () => {
  throwsCode(() => moveEdge(s1, { edge: "start", ref: ref("R", "16:00"), to: D("16:20") }, live("16:27")), "not_found");
  throwsCode(() => moveEdge(s1, { edge: "start", ref: { side: "R", start: new Date(D("16:25").getTime() + 1600).toISOString() }, to: D("16:20") }, live("16:27")), "not_found");
});

// ── S2: forgot to start ──────────────────────────────────────────────────

check("S2a: feed start 5 min earlier", () => {
  const r = moveEdge(feed("L 16:05-"), { edge: "start", ref: ref("L", "16:05"), to: D("16:00") }, live("16:05:10"));
  eqSegs(r.data.segments, "L 16:00-");
  eqTime(r.startedAt, "16:00", "started_at");
  eq(r.moment, "feed_start");
});
check("feed start: ref omitted means the first stretch", () =>
  eqSegs(moveEdge(s1, { edge: "start", to: D("15:55") }, live("16:27")).data.segments, "L 15:55-16:10, R 16:25-"));
check("feed start: more than 6 h before is too_early", () => {
  const e = throwsCode(() => moveEdge(feed("L 16:05-"), { edge: "start", to: D("10:04") }, live("16:06")), "too_early");
  eq(feedEditCopy(e, "ui", TZ), "That's more than 6 hours before the feed started.");
  eqTime(edgeBounds(feed("L 16:05-"), { edge: "start" }, live("16:06")).min, "10:05", "min");
});
check("feed start: after a closed first side ends is after_own_end", () => {
  const e = throwsCode(() => moveEdge(feed("L 16:00-16:15, R 16:15-16:30"), { edge: "start", to: D("16:15") }, done("17:00", "16:30")), "after_own_end");
  eq(feedEditCopy(e, "ui", TZ), "Can't be after Left ended (4:15 PM).");
});
check("feed start: an open side can't start in the future", () =>
  throwsCode(() => moveEdge(feed("L 16:05-"), { edge: "start", to: D("16:06:30") }, live("16:06")), "future"));
check("S2c: wrong start side", () => {
  const r = setSide(feed("L 16:05-"), ref("L", "16:05"), "R", live("16:06"));
  eqSegs(r.data.segments, "R 16:05-");
  eq([r.data.first_side, r.data.last_side], ["R", "R"]);
});

// ── S3: forgot to switch ─────────────────────────────────────────────────

check("S3: dock switch at 4:16", () => {
  const r = switchTo(feed("L 16:00-", { first_side: "L", last_side: "L" }), "R", D("16:16"));
  eqSegs(r.data.segments, "L 16:00-16:16, R 16:16-");
  eq([r.noop, r.reverted, r.data.last_side], [undefined, undefined, "R"]);
});
const s3 = feed("L 16:00-16:16, R 16:16-");
check("S3: switch bounds (uiMin keeps a minute of Left)", () => {
  const b = edgeBounds(s3, { edge: "start", ref: ref("R", "16:16") }, live("16:16:30"));
  eqTime(b.min, "16:00:01", "min");
  eqTime(b.uiMin, "16:01", "uiMin");
  eq(b.floor, undefined, "floor");
  eq(b.moment, "switch");
});
check("S3: switch 4 min earlier", () => {
  const r = moveEdge(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:12") }, live("16:16:30"));
  eqSegs(r.data.segments, "L 16:00-16:12, R 16:12-");
  eq(r.moment, "switch");
  eq(preview(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:12") }, live("16:16:30")), "Left 16 → 12 min · Right 4 min longer");
});
check("S3: switch before Left began is before_prev_start", () => {
  const e = throwsCode(() => moveEdge(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:00") }, live("16:17")), "before_prev_start");
  eq(feedEditCopy(e, "ui", TZ), "Can't be before Left started (4:00 PM).");
  eq(feedEditCopy(e, "mcp", TZ), "Left started at 4:00 PM; the switch has to be after that.");
});
check("switch: a side under a minute falls back to the 1 s floor in the UI", () => {
  const b = edgeBounds(feed("L 16:00-16:00:30, R 16:00:30-"), { edge: "start", ref: ref("R", "16:00:30") }, live("16:05"));
  eqTime(b.uiMin, "16:00:01", "uiMin");
});
check("S10a: switch moved to 4:15 (Right tapped at 4:18)", () =>
  eqSegs(moveEdge(feed("L 16:00-16:18, R 16:18-"), { edge: "start", ref: ref("R", "16:18"), to: D("16:15") }, live("16:20")).data.segments, "L 16:00-16:15, R 16:15-"));
check("S10a: switch_side minutes_ago on a single side", () =>
  eqSegs(switchTo(feed("L 16:00-"), "R", D("16:15"), { explicit: true }).data.segments, "L 16:00-16:15, R 16:15-"));
check("S10b: switch_side {at:4:12} moves the switch", () =>
  eqSegs(moveEdge(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:12") }, live("16:20")).data.segments, "L 16:00-16:12, R 16:12-"));

// ── S4: forgot to stop ───────────────────────────────────────────────────

check("S4a: Done at 4:50, then ended 20 min earlier", () => {
  const stopped = finalizeBreast(feed("L 16:00-16:15, R 16:15-"), D("16:50"));
  eqSegs(stopped.segments, "L 16:00-16:15, R 16:15-16:50");
  eq([stopped.left_sec, stopped.right_sec, stopped.paused_at_stop], [900, 2100, undefined]);
  const b = edgeBounds(stopped, { edge: "end" }, done("16:51", "16:50"));
  eq(b.moment, "feed_end");
  eqTime(b.uiMin, "16:16", "uiMin");
  eqTime(b.max, "16:51", "max");
  const r = moveEdge(stopped, { edge: "end", to: D("16:30") }, done("16:51", "16:50"));
  eqSegs(r.data.segments, "L 16:00-16:15, R 16:15-16:30");
  eqTime(r.endedAt, "16:30", "ended_at");
  eq([r.data.left_sec, r.data.right_sec, r.moment], [900, 900, "feed_end"]);
});
check("S4b: stop chip at the likely 4:30", () => {
  const r = stopBreast(feed("L 16:00-16:15, R 16:15-"), D("16:30"), D("16:50"));
  eqSegs(r.data.segments, "L 16:00-16:15, R 16:15-16:30");
  eqTime(r.endedAt, "16:30", "ended_at");
  eq(r.pausedAtStop, false);
});
check("feed end: to the future is refused", () =>
  throwsCode(() => moveEdge(feed("L 16:00-16:30"), { edge: "end", to: D("16:52") }, done("16:51", "16:30")), "future"));
check("end: an open side can't end here (use_stop)", () => {
  const e = throwsCode(() => moveEdge(s3, { edge: "end", to: D("16:30") }, live("16:40")), "use_stop");
  eq(feedEditCopy(e, "ui", TZ), "Use She already finished to end the feed.");
  throwsCode(() => edgeBounds(s3, { edge: "end" }, live("16:40")), "use_stop");
});

// ── S5: mistaken taps ────────────────────────────────────────────────────

const s5 = feed("L 16:00-16:05, R 16:05-");
check("S5a: undo the switch", () => {
  const r = undoLastTap(s5, { side: "R", start: T("16:05"), end: null });
  eqSegs(r.data.segments, "L 16:00-");
  eq([r.what, r.data.last_side], ["switch", "L"]);
});
check("S5a: switching back within 15 s reverts", () => {
  const r = switchTo(s5, "L", D("16:05:10"));
  eqSegs(r.data.segments, "L 16:00-");
  eq(r.reverted, true);
});
check("switch-back rule ends at 15 s", () => {
  const r = switchTo(s5, "L", D("16:05:20"));
  eqSegs(r.data.segments, "L 16:00-16:05, R 16:05-16:05:20, L 16:05:20-");
  eq(r.reverted, undefined);
});
check("switch-back rule needs the switch to touch", () => {
  const r = switchTo(feed("L 16:00-16:05, R 16:06-"), "L", D("16:06:05"));
  eqSegs(r.data.segments, "L 16:00-16:05, R 16:06-16:06:05, L 16:06:05-");
  eq(r.reverted, undefined);
});
check("switch-back on a sub-second switch", () => eqSegs(switchTo(feed("L 16:00-16:10, R 16:10-"), "L", D("16:10:00.5")).data.segments, "L 16:00-"));
check("S5a: Fix times mistap row (undo_tap) also within 10 min", () =>
  eqSegs(undoLastTap(s5, { side: "R", start: T("16:05"), end: null }).data.segments, "L 16:00-"));
check("S5b: pause, then a same-side resume within 60 s merges", () => {
  const paused = pause(feed("L 16:00-"), D("16:05"));
  eqSegs(paused.data.segments, "L 16:00-16:05");
  const r = switchTo(paused.data, "L", D("16:05:30"));
  eqSegs(r.data.segments, "L 16:00-");
  eq(r.merged, true);
});
check("S5b: undo the pause", () => {
  const r = undoLastTap(feed("L 16:00-16:05"), { side: "L", start: T("16:00"), end: T("16:05") });
  eqSegs(r.data.segments, "L 16:00-");
  eq(r.what, "pause");
});
check("undo a resume goes back to paused", () => {
  const r = undoLastTap(s1, { side: "R", start: T("16:25"), end: null });
  eqSegs(r.data.segments, "L 16:00-16:10");
  eq(r.what, "resume");
});
check("undo: a lone stretch is nothing_to_undo", () => {
  const e = throwsCode(() => undoLastTap(feed("L 16:00-"), { side: "L", start: T("16:00"), end: null }), "nothing_to_undo");
  eq(feedEditCopy(e, "ui", TZ), "Nothing to undo; use Discard.");
});
check("undo: a stale expect is not_newest", () => {
  throwsCode(() => undoLastTap(feed("L 16:00-16:05, R 16:05-16:06, L 16:06-"), { side: "R", start: T("16:05"), end: null }), "not_newest");
  throwsCode(() => undoLastTap(feed("L 16:00-16:05"), { side: "L", start: T("16:00"), end: null }), "not_newest");
});
check("undo: a finished feed is not_timed", () =>
  throwsCode(() => undoLastTap(feed("L 16:00-16:05"), { side: "L", start: T("16:00"), end: T("16:05") }, { active: false }), "not_timed"));
check("S5c: wrong-side resume, then It was Right", () => {
  const resumed = switchTo(feed("L 16:00-16:10"), "L", D("16:20"));
  eqSegs(resumed.data.segments, "L 16:00-16:10, L 16:20-");
  eq(resumed.merged, undefined);
  eqSegs(setSide(resumed.data, ref("L", "16:20"), "R", live("16:21")).data.segments, "L 16:00-16:10, R 16:20-");
});
check("S5c fixtures: setSide keeps a gap, merges when touching", () => {
  eqSegs(setSide(feed("L 16:00-16:10, L 16:25-"), ref("L", "16:25"), "R", live("16:26")).data.segments, "L 16:00-16:10, R 16:25-");
  eqSegs(setSide(feed("L 16:00-16:10, R 16:10-"), ref("R", "16:10"), "L", live("16:26")).data.segments, "L 16:00-");
});
check("S10c: set_side left on the Right after a break", () =>
  eqSegs(setSide(s1, ref("R", "16:25"), "L", live("16:26")).data.segments, "L 16:00-16:10, L 16:25-"));
check("setSide: not_found", () => throwsCode(() => setSide(s1, ref("L", "16:25"), "R", live("16:26")), "not_found"));

// ── switchTo / pause (§9.4) ──────────────────────────────────────────────

check("switchTo: same side is a noop", () => {
  const r = switchTo(s3, "R", D("16:20"));
  eq(r.noop, true);
  ok(r.data === s3, "data unchanged");
});
check("S8c: a second switch to the same side 2 s later is a noop", () => {
  const first = switchTo(feed("L 16:00-"), "R", D("16:16:00"));
  const second = switchTo(first.data, "R", D("16:16:02"));
  eq(second.noop, true);
  eqSegs(second.data.segments, "L 16:00-16:16, R 16:16-");
});
check("switchTo explicit before the open side began is before_own_start", () => {
  const e = throwsCode(() => switchTo(feed("L 16:00-"), "R", D("15:59"), { explicit: true }), "before_own_start");
  eq(feedEditCopy(e, "ui", TZ), "Can't be before Left started (4:00 PM).");
  throwsCode(() => switchTo(feed("L 16:00-"), "R", D("16:00:00.5"), { explicit: true }), "before_own_start");
});
check("paused: same side within 60 s merges (16:10:40)", () => {
  const r = switchTo(feed("L 16:00-16:10"), "L", D("16:10:40"));
  eqSegs(r.data.segments, "L 16:00-");
  eq(r.merged, true);
});
check("paused: same side after 60 s is a new stretch (16:11:30)", () => {
  const r = switchTo(feed("L 16:00-16:10"), "L", D("16:11:30"));
  eqSegs(r.data.segments, "L 16:00-16:10, L 16:11:30-");
  eq(r.merged, undefined);
});
check("paused: resume before the break clamps to it", () => {
  const r = switchTo(feed("L 16:00-16:10"), "R", D("16:05"), { explicit: true });
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:10-");
  eq([r.clamped, r.merged], [true, undefined]);
});
check("paused: other side within 1 s becomes a switch", () => {
  const r = switchTo(feed("L 16:00-16:10"), "R", D("16:10:00.5"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:10-");
  eq(r.clamped, undefined);
});
check("S6c: back on the Right at 4:20 (Already back on?)", () =>
  eqSegs(switchTo(feed("L 16:00-16:10"), "R", D("16:20"), { explicit: true }).data.segments, "L 16:00-16:10, R 16:20-"));
check("pause: closes the open side", () => {
  const r = pause(feed("L 16:00-"), D("16:05"));
  eqSegs(r.data.segments, "L 16:00-16:05");
  eq(r.noop, undefined);
});
check("S8c: a second pause 0.4 s later is a noop", () => {
  const first = pause(feed("L 16:00-"), D("16:30:00.0"));
  const second = pause(first.data, D("16:30:00.4"));
  eq(second.noop, true);
  eqSegs(second.data.segments, "L 16:00-16:30");
});
check("S10d: pause_nursing 3 min ago", () => eqSegs(pause(feed("L 16:00-"), D("16:07"), { explicit: true }).data.segments, "L 16:00-16:07"));
check("pause explicit before the side began is before_own_start", () =>
  throwsCode(() => pause(feed("L 16:00-"), D("15:58"), { explicit: true }), "before_own_start"));
check("S5b: pause twice is a same-side resume that merges", () => {
  const paused = pause(feed("L 16:00-"), D("16:05")).data;
  eqSegs(switchTo(paused, "L", D("16:05:01")).data.segments, "L 16:00-");
});

// ── moveEdge: end rows (§9.3) ────────────────────────────────────────────

check("end with a touching next is that switch", () => {
  const r = moveEdge(feed("L 16:00-16:15, R 16:15-16:30"), { edge: "end", ref: ref("L", "16:00"), to: D("16:12") }, done("17:00", "16:30"));
  eqSegs(r.data.segments, "L 16:00-16:12, R 16:12-16:30");
  eq(r.moment, "switch");
  eqTime(r.endedAt, "16:30", "ended_at");
});
check("end before a gap is the pause", () => {
  const r = moveEdge(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:07") }, live("16:27"));
  eqSegs(r.data.segments, "L 16:00-16:07, R 16:25-");
  eq(r.moment, "pause");
  eq(preview(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:07") }, live("16:27")), "Break 15 → 18 min · Left 10 → 7 min · Right unchanged");
});
check("pause: can't pass the resume or the side's start", () => {
  const late = throwsCode(() => moveEdge(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:26") }, live("16:27")), "after_next");
  eq(feedEditCopy(late, "ui", TZ), "Can't be after Right started (4:25 PM).");
  const early = throwsCode(() => moveEdge(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:00:00.5") }, live("16:27")), "before_own_start");
  eq(feedEditCopy(early, "ui", TZ), "Can't be before Left started (4:00 PM).");
  const b = edgeBounds(s1, { edge: "end", ref: ref("L", "16:00") }, live("16:27"));
  eqTime(b.min, "16:00:01", "min");
  eqTime(b.uiMin, "16:01", "uiMin");
  eqTime(b.max, "16:25", "max");
});
check("pause moved within 1 s of the resume closes the break", () => {
  eqSegs(moveEdge(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:24:59.5") }, live("16:27")).data.segments, "L 16:00-16:25, R 16:25-");
  eqSegs(moveEdge(feed("L 16:00-16:10, L 16:25-"), { edge: "end", ref: ref("L", "16:00"), to: D("16:25") }, live("16:27")).data.segments, "L 16:00-");
});
check("paused feed: came off earlier (trailing pause)", () => {
  const r = moveEdge(feed("L 16:00-16:10"), { edge: "end", to: D("16:07") }, live("16:30"));
  eqSegs(r.data.segments, "L 16:00-16:07");
  eq([r.moment, r.endedAt], ["pause", null]);
  eq(preview(feed("L 16:00-16:10"), { edge: "end", to: D("16:07") }, live("16:30")), "Break 20 → 23 min · Left 10 → 7 min");
  throwsCode(() => moveEdge(feed("L 16:00-16:10"), { edge: "end", to: D("16:31") }, live("16:30")), "future");
});
check("flagged paused stop: the end moves with ended_at", () => {
  const r = moveEdge(feed("L 16:00-16:10", { paused_at_stop: true }), { edge: "end", to: D("16:05") }, done("16:30", "16:10", true));
  eqSegs(r.data.segments, "L 16:00-16:05");
  eqTime(r.endedAt, "16:05", "ended_at");
  eq([r.moment, r.data.paused_at_stop, r.data.left_sec], ["feed_end", true, 300]);
});
check("legacy: the last end is a pause bounded by ended_at", () => {
  const legacy = feed("L 16:00-16:10");
  const r = moveEdge(legacy, { edge: "end", to: D("16:20") }, done("17:00", "16:30"));
  eqSegs(r.data.segments, "L 16:00-16:20");
  eqTime(r.endedAt, "16:30", "ended_at");
  eq(r.moment, "pause");
  eqTime(edgeBounds(legacy, { edge: "end" }, done("17:00", "16:30")).max, "16:30", "max");
  const e = throwsCode(() => moveEdge(legacy, { edge: "end", to: D("16:31") }, done("17:00", "16:30")), "after_next");
  eq(feedEditCopy(e, "ui", TZ), "Can't be after the feed ended (4:30 PM).");
});
check("S7e: legacy Ended edits ended_at only", () => {
  const legacy = feed("L 16:00-16:10", { left_sec: 600, right_sec: 0 });
  const r = moveEdge(legacy, { edge: "ended", to: D("16:20") }, done("17:00", "16:30"));
  eqSegs(r.data.segments, "L 16:00-16:10");
  eqTime(r.endedAt, "16:20", "ended_at");
  eq(r.moment, "feed_end");
  eqTime(moveEdge(legacy, { edge: "ended", to: D("16:10:01") }, done("17:00", "16:30")).endedAt, "16:10", "snaps to the last end");
  const e = throwsCode(() => moveEdge(legacy, { edge: "ended", to: D("16:05") }, done("17:00", "16:30")), "before_break");
  eq(feedEditCopy(e, "ui", TZ), "Can't be before she came off (4:10 PM). For no break, pick 4:10.");
  throwsCode(() => moveEdge(s3, { edge: "ended", to: D("16:30") }, live("16:40")), "use_stop");
});
check("S7e: moving only the first start keeps a legacy ended_at", () => {
  const r = moveEdge(feed("L 16:00-16:10"), { edge: "start", to: D("16:02") }, done("17:00", "16:30"));
  eqSegs(r.data.segments, "L 16:02-16:10");
  eqTime(r.endedAt, "16:30", "ended_at");
});
check("ended moved off a flagged stop drops the flag", () => {
  const r = moveEdge(feed("L 16:00-16:10", { paused_at_stop: true }), { edge: "ended", to: D("16:20") }, done("17:00", "16:10", true));
  eq(r.data.paused_at_stop, undefined);
});

// ── S6: stopping while paused ────────────────────────────────────────────

const paused = feed("L 16:00-16:10");
check("S6a: Done while paused ends at the pause", () => {
  const r = stopBreast(paused, undefined, D("16:30"));
  eqSegs(r.data.segments, "L 16:00-16:10");
  eqTime(r.endedAt, "16:10", "ended_at");
  eq([r.pausedAtStop, r.data.paused_at_stop, r.data.left_sec, r.data.right_sec, r.data.first_side, r.data.last_side], [true, true, 600, 0, "L", "L"]);
});
check("S6a: finalizeBreast with pausedAtStop", () => {
  const out = finalizeBreast(paused, D("16:10"), { pausedAtStop: true });
  eq([out.paused_at_stop, out.left_sec, out.right_sec, out.first_side, out.last_side], [true, 600, 0, "L", "L"]);
});
check("S6: a stop time during the break still ends at the pause", () => {
  const r = stopBreast(paused, D("16:20"), D("16:30"));
  eqTime(r.endedAt, "16:10", "ended_at");
  eq(r.data.paused_at_stop, true);
});
check("S6/S10d: a stop time before the pause trims Left", () => {
  const r = stopBreast(paused, D("16:05"), D("16:30"));
  eqSegs(r.data.segments, "L 16:00-16:05");
  eqTime(r.endedAt, "16:05", "ended_at");
  eq([r.data.paused_at_stop, r.data.left_sec], [true, 300]);
});
check("S6: a stop time before Left began is refused", () => {
  throwsCode(() => stopBreast(paused, D("16:00:00.5"), D("16:30")), "before_own_start");
  throwsCode(() => stopBreast(paused, D("15:50"), D("16:30")), "before_own_start");
});
check("S6/S10d: running, a stop before the Right began is refused", () => {
  const e = throwsCode(() => stopBreast(s1, D("16:10"), D("16:30")), "before_own_start");
  eq(feedEditCopy(e, "ui", TZ), "Can't be before Right started (4:25 PM).");
  eq(feedEditCopy(e, "mcp", TZ), "The Right side started at 4:25 PM, after 4:10. If Right was a mistaken tap, call fix_nursing_time {undo_last_tap:true} first, then stop_timer.");
});
check("running stop: default now, never later", () => {
  eqTime(stopBreast(s1, undefined, D("16:30")).endedAt, "16:30", "now");
  eqTime(stopBreast(s1, D("16:40"), D("16:30")).endedAt, "16:30", "capped");
});
check("S6c: Done on the Right after going back on (no flag)", () => {
  const out = finalizeBreast(feed("L 16:00-16:10, R 16:20-", { paused_at_stop: true }), D("16:40:30"));
  eqSegs(out.segments, "L 16:00-16:10, R 16:20-16:40:30");
  eq(out.paused_at_stop, undefined, "stale flag dropped");
});
check("finalize drops a sub-second last side", () => eqSegs(finalizeBreast(s3, D("16:16:00.5")).segments, "L 16:00-16:16"));

// ── S7: finished feeds (FeedSheet) ───────────────────────────────────────

const s7 = feed("L 16:00-16:15, R 16:15-16:30", { left_sec: 900, right_sec: 900, first_side: "L", last_side: "R" });
const s7ctx = done("17:00", "16:30");
check("S7a: switch 3 min earlier", () => {
  const r = moveEdge(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:12") }, s7ctx);
  eqSegs(r.data.segments, "L 16:00-16:12, R 16:12-16:30");
  eq([r.data.left_sec, r.data.right_sec], [720, 1080]);
  eqTime(r.startedAt, "16:00", "started_at");
  eqTime(r.endedAt, "16:30", "ended_at");
  eq(preview(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:12") }, s7ctx), "Left 15 → 12 min · Right 15 → 18 min");
});
check("S7b: switch 3 min later", () => {
  const r = moveEdge(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:18") }, s7ctx);
  eqSegs(r.data.segments, "L 16:00-16:18, R 16:18-16:30");
  eq([r.data.left_sec, r.data.right_sec], [1080, 720]);
  eq(preview(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:18") }, s7ctx), "Left 15 → 18 min · Right 15 → 12 min");
});
check("S7c option B: feed start 3 min later", () => {
  const r = moveEdge(s7, { edge: "start", ref: ref("L", "16:00"), to: D("16:03") }, s7ctx);
  eqSegs(r.data.segments, "L 16:03-16:15, R 16:15-16:30");
  eqTime(r.startedAt, "16:03", "started_at");
  eqTime(r.endedAt, "16:30", "ended_at");
  eq([r.data.left_sec, r.data.right_sec], [720, 900]);
  eq(preview(s7, { edge: "start", ref: ref("L", "16:00"), to: D("16:03") }, s7ctx), "Left 15 → 12 min · Right unchanged");
});
check("S7d: Left was really Right", () => {
  const r = setSide(s7, ref("L", "16:00"), "R", s7ctx);
  eqSegs(r.data.segments, "R 16:00-16:30");
  eq([r.data.first_side, r.data.left_sec, r.data.right_sec], ["R", 0, 1800]);
  eq(describeChange(feedParts(s7, s7ctx), feedParts(r.data, s7ctx)), "Left 15 → 0 min · Right 15 → 30 min");
});
check("S7d: add a missed Right after a paused stop", () => {
  const flagged = feed("L 16:00-16:10", { paused_at_stop: true, left_sec: 600, right_sec: 0 });
  const r = addPart(flagged, { side: "R", start: D("16:20"), end: D("16:40") }, done("17:00", "16:10", true));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:20-16:40");
  eqTime(r.endedAt, "16:40", "ended_at");
  eqTime(r.startedAt, "16:00", "started_at");
  eq([r.data.right_sec, r.data.last_side, r.data.paused_at_stop], [1200, "R", undefined]);
});
check("S7d: an added side that overlaps is refused", () => {
  const e = throwsCode(() => addPart(feed("L 16:00-16:10"), { side: "R", start: T("16:05"), end: T("16:20") }, done("17:00", "16:10", true)), "overlap");
  eq(feedEditCopy(e, "ui", TZ), "That overlaps Left 4:00–4:10.");
});
check("addPart: before the first side moves the start, not the end", () => {
  const r = addPart(feed("L 16:00-16:10"), { side: "R", start: D("15:50"), end: D("16:00") }, done("17:00", "16:10"));
  eqSegs(r.data.segments, "R 15:50-16:00, L 16:00-16:10");
  eqTime(r.startedAt, "15:50", "started_at");
  eqTime(r.endedAt, "16:10", "ended_at");
  eq(r.data.first_side, "R");
});
check("addPart: ended before started is refused", () =>
  throwsCode(() => addPart(feed("L 16:00-16:10"), { side: "R", start: D("16:30"), end: D("16:20") }, done("17:00", "16:10")), "before_own_start"));
check("addPart: She went back on… after a Done at the pause (add_part until the Done tap)", () => {
  // Left 4:00–4:10, Done tapped at 4:25 (ended at the pause); she was back on the Right from 4:14.
  const flagged = feed("L 16:00-16:10", { paused_at_stop: true, left_sec: 600, right_sec: 0 });
  const r = addPart(flagged, { side: "R", start: D("16:14"), end: D("16:25") }, done("16:30", "16:10", true));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:14-16:25");
  eqTime(r.endedAt, "16:25", "ends at the Done tap");
  eq(r.data.paused_at_stop, undefined, "no longer ended at a pause");
  eq(rows(feedParts(r.data, done("16:30", "16:25"))), ["L 16:00-16:10 10 min", "Break 16:10-16:14 4 min", "R 16:14-16:25 11 min"]);
  // No break: from the pause on the same side merges into it.
  eqSegs(addPart(flagged, { side: "L", start: D("16:10"), end: D("16:25") }, done("16:30", "16:10", true)).data.segments, "L 16:00-16:25");
});

// ── S8: two phones ───────────────────────────────────────────────────────

check("S8a: Matt's fix lands after Brittany's switch", () => {
  const r = moveEdge(feed("L 16:00-16:10, R 16:25-16:25:30, L 16:25:30-"), { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:25:40"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:20-16:25:30, L 16:25:30-");
});
check("S8b: switch and retime merge in either order", () => {
  const move = (d: FeedData) => moveEdge(d, { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:26")).data;
  const sw = (d: FeedData) => switchTo(d, "L", D("16:26")).data;
  const want = "L 16:00-16:10, R 16:20-16:26, L 16:26-";
  eqSegs(move(sw(s1)).segments, want);
  eqSegs(sw(move(s1)).segments, want);
});

// ── S10: voice ───────────────────────────────────────────────────────────

check("S10c: feed_start add 5 minutes", () => eqSegs(moveEdge(feed("L 16:05-"), { edge: "start", to: D("16:00") }, live("16:06")).data.segments, "L 16:00-"));
check("S10c: right add 5 minutes", () =>
  eqSegs(moveEdge(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:26")).data.segments, "L 16:00-16:10, R 16:20-"));
check("S10c: undo_last_tap on a switch", () => eqSegs(undoLastTap(s5, { side: "R", start: T("16:05"), end: null }).data.segments, "L 16:00-"));

// ── retimeBreast (kept for FeedSheet and PATCH) ──────────────────────────

check("retimeBreast: running feed start", () => eqSegs(retimeBreast(feed("L 16:05-"), { start: D("16:00") }).segments, "L 16:00-"));
check("retimeBreast: finished end moves the last side and totals", () => {
  const out = retimeBreast(feed("L 16:00-16:15, R 16:15-16:50"), { end: D("16:30"), prevEnd: D("16:50") });
  eqSegs(out.segments, "L 16:00-16:15, R 16:15-16:30");
  eq([out.left_sec, out.right_sec], [900, 900]);
});
check("retimeBreast: legacy end inside the break leaves the sides", () =>
  eqSegs(retimeBreast(feed("L 16:00-16:10"), { end: D("16:20"), prevEnd: D("16:30") }).segments, "L 16:00-16:10"));
check("retimeBreast: legacy end before the pause trims the side", () =>
  eqSegs(retimeBreast(feed("L 16:00-16:10"), { end: D("16:05"), prevEnd: D("16:30") }).segments, "L 16:00-16:05"));
check("retimeBreast: a one-side feed shifts later as a whole", () =>
  eqSegs(retimeBreast(feed("L 16:00-16:10"), { start: D("16:20"), end: D("16:30"), prevEnd: D("16:10") }).segments, "L 16:20-16:30"));
check("retimeBreast: and earlier", () =>
  eqSegs(retimeBreast(feed("L 16:00-16:10"), { start: D("15:40"), end: D("15:50"), prevEnd: D("16:10") }).segments, "L 15:40-15:50"));
check("retimeBreast: a misfit throws a plain Error with the sheet's words", () => {
  const e = throwsPlain(() => retimeBreast(feed("L 16:00-16:10, R 16:10-16:20"), { start: D("16:15"), prevEnd: D("16:20") }), "retime");
  eq(e.message, "Can't be after Left ended (4:10 PM).");
});
check("retimeBreast: untimed data passes through", () => {
  const d: FeedData = { method: "breast", left_sec: 600 };
  ok(retimeBreast(d, { start: D("16:00") }) === d, "same object");
});

// ── describeChange wording (§9.5) ────────────────────────────────────────

check("describeChange: no change", () => eq(describeChange(feedParts(s7, s7ctx), feedParts(s7, s7ctx)), "No change"));
check("describeChange: a single-side feed says nothing of the other side", () =>
  eq(preview(feed("L 16:00-16:20"), { edge: "start", to: D("16:05") }, done("17:00", "16:20")), "Left 20 → 15 min"));
check("describeChange: hours", () =>
  eq(preview(feed("L 15:00-16:20"), { edge: "start", to: D("15:10") }, done("17:00", "16:20")), "Left 1h 20m → 1h 10m"));
check("describeChange: never + or −", () => {
  const all = [
    preview(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:20") }, live("16:27")),
    preview(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:12") }, live("16:16:30")),
    preview(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:12") }, s7ctx),
    preview(s7, { edge: "start", ref: ref("R", "16:15"), to: D("16:18") }, s7ctx),
    preview(s1, { edge: "start", ref: ref("R", "16:25"), to: D("16:10") }, live("16:27")),
    preview(s1, { edge: "end", ref: ref("L", "16:00"), to: D("16:07") }, live("16:27")),
    preview(s3, { edge: "start", ref: ref("R", "16:16"), to: D("16:18") }, live("16:20")),
  ];
  all.forEach(noSigns);
  eq(all[6], "Left 16 → 18 min · Right 2 min shorter");
});

// ── feedEditCopy for every code (§9.6) ───────────────────────────────────

const copyCases: [FeedEditCode, Record<string, string>, string, string][] = [
  ["future", { now: T("16:30") }, "That's in the future.", "That time is in the future; it's 4:30 PM for Maple."],
  ["too_early", {}, "That's more than 6 hours before the feed started.", "That's more than 6 hours before the feed started."],
  ["before_prev_start", { prev: "L", t: T("16:00") }, "Can't be before Left started (4:00 PM).", "Left started at 4:00 PM; the switch has to be after that."],
  ["before_break", { t: T("16:10") }, "Can't be before she came off (4:10 PM). For no break, pick 4:10.", 'The break began at 4:10 PM. For no break, use at: "4:10 PM".'],
  ["after_next", { next: "R", t: T("16:25") }, "Can't be after Right started (4:25 PM).", "Can't be after Right started (4:25 PM)."],
  ["after_own_end", { side: "L", t: T("16:15") }, "Can't be after Left ended (4:15 PM).", "Can't be after Left ended (4:15 PM)."],
  [
    "before_own_start",
    { side: "R", t: T("16:25"), asked: T("16:10") },
    "Can't be before Right started (4:25 PM).",
    "The Right side started at 4:25 PM, after 4:10. If Right was a mistaken tap, call fix_nursing_time {undo_last_tap:true} first, then try again.",
  ],
  ["overlap", { side: "L", start: T("16:00"), end: T("16:10") }, "That overlaps Left 4:00–4:10.", "That overlaps Left 4:00–4:10."],
  ["use_stop", {}, "Use She already finished to end the feed.", "The feed is still going; to end it earlier use stop_timer with at."],
  ["nothing_to_undo", {}, "Nothing to undo; use Discard.", "That's the only tap on this feed; delete_entry removes the whole feed."],
  ["not_timed", {}, "That feed wasn't timed, so its parts can't be fixed.", "That feed wasn't timed, so its parts can't be fixed."],
  ["too_many", {}, "Too many parts (60 max).", "Too many parts (60 max)."],
  ["not_found", {}, "This feed just changed, so nothing was saved. Have another look.", "The feed changed since you looked; call maple_status and try again."],
  ["not_newest", {}, "This feed just changed, so nothing was saved. Have another look.", "The feed changed since you looked; call maple_status and try again."],
];
for (const [code, params, ui, mcp] of copyCases) {
  check(`feedEditCopy ${code}`, () => {
    const e = new FeedEditError(code, params);
    eq(feedEditCopy(e, "ui", TZ), ui, "ui");
    eq(feedEditCopy(e, "mcp", TZ), mcp, "mcp");
    eq(e.message, ui, "message");
  });
}
check("feedEditCopy covers every code", () => {
  const all: FeedEditCode[] = ["future", "too_early", "before_prev_start", "before_break", "after_next", "after_own_end", "before_own_start", "overlap", "not_found", "not_newest", "use_stop", "nothing_to_undo", "not_timed", "too_many"];
  eq(all.filter((c) => !copyCases.some(([k]) => k === c)), []);
});
check("feedEditCopy across noon keeps AM/PM on asked", () =>
  eq(
    feedEditCopy(new FeedEditError("before_own_start", { side: "L", t: T("12:05"), asked: T("11:58") }), "mcp", TZ),
    "The Left side started at 12:05 PM, after 11:58 AM. If Left was a mistaken tap, call fix_nursing_time {undo_last_tap:true} first, then try again."
  ));

// ── last_tap: undo takes back the tap that was made (review-server) ─────

const tapOf = (d: FeedData) => (d as TapFeedData).last_tap;
const newest = (d: FeedData) => {
  const L = d.segments![d.segments!.length - 1];
  return { side: L.side, start: L.start, end: L.end };
};
check("taps record last_tap: switch, pause, resume (merged), reverted", () => {
  const sw = switchTo(feed("L 16:00-"), "R", D("16:10"), { now: D("16:10:02") });
  eq(tapOf(sw.data), { kind: "switch", side: "R", at: T("16:10:02") });
  const pa = pause(sw.data, D("16:20"));
  eq(tapOf(pa.data), { kind: "pause", side: "R", at: T("16:20") });
  const re = switchTo(pa.data, "R", D("16:20:30"));
  eq(tapOf(re.data), { kind: "resume", side: "R", at: T("16:20:30"), paused_at: T("16:20"), merged: true });
  const back = switchTo(sw.data, "L", D("16:10:05"));
  eq([back.reverted, tapOf(back.data)?.reverted], [true, true]);
});
check("the reviewer's case: a merged same-side resume undoes back to paused, never the older switch", () => {
  // R 3:04–3:14, L 3:14–3:29, paused 30 s ago, Resume on Left: merged.
  const paused = pause(switchTo(feed("R 16:04-"), "L", D("16:14")).data, D("16:29")).data;
  const merged = switchTo(paused, "L", D("16:29:30"));
  eqSegs(merged.data.segments, "R 16:04-16:14, L 16:14-");
  eq(undoableTap(merged.data, live("16:30"))?.what, "resume");
  const r = undoLastTap(merged.data, newest(merged.data));
  eqSegs(r.data.segments, "R 16:04-16:14, L 16:14-16:29");
  eq([r.what, tapOf(r.data)?.undone], ["resume", true]);
  // And once undone there's nothing left, rather than the switch before it.
  const e = throwsCode(() => undoLastTap(r.data, newest(r.data)), "nothing_to_undo");
  eq(feedEditCopy(e, "ui", TZ), "That tap was already undone.");
  eq(undoableTap(r.data, live("16:30")), null);
});
check("a merged resume on the feed's only side still goes back to paused", () => {
  const merged = switchTo(pause(feed("L 16:00-"), D("16:05")).data, "L", D("16:05:30")).data;
  eqSegs(merged.segments, "L 16:00-");
  eqSegs(undoLastTap(merged, newest(merged)).data.segments, "L 16:00-16:05");
});
check("a switch back within 15 s (reverted) has no tap left to undo", () => {
  const back = switchTo(switchTo(feed("R 16:00-16:10, L 16:10-"), "R", D("16:20")).data, "L", D("16:20:05")).data;
  eqSegs(back.segments, "R 16:00-16:10, L 16:10-");
  const e = throwsCode(() => undoLastTap(back, newest(back)), "nothing_to_undo");
  eq(feedEditCopy(e, "mcp", TZ), "The latest tap on this feed was already taken back, so there's no tap left to undo. To fix a time, use fix_nursing_time with part and at.");
});
check("a clamped resume (other side, at the pause) undoes back to paused, not into the side before", () => {
  const r = switchTo(feed("L 16:00-16:10"), "R", D("16:05"), { explicit: true });
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:10-");
  const u = undoLastTap(r.data, newest(r.data));
  eqSegs(u.data.segments, "L 16:00-16:10");
  eq(u.what, "resume");
});
check("a resume turned into no break by a fix still undoes back to paused", () => {
  const resumed = switchTo(feed("L 16:00-16:10"), "L", D("16:20")).data;
  const fixed = moveEdge(resumed, { edge: "start", ref: ref("L", "16:20"), to: D("16:10") }, live("16:25")).data;
  eqSegs(fixed.segments, "L 16:00-");
  eqSegs(undoLastTap(fixed, newest(fixed)).data.segments, "L 16:00-16:10");
});
check("a switch whose time was fixed is still the tap undo takes back", () => {
  const sw = switchTo(feed("L 16:00-"), "R", D("16:16")).data;
  const fixed = moveEdge(sw, { edge: "start", ref: ref("R", "16:16"), to: D("16:12") }, live("16:20")).data;
  eqSegs(undoLastTap(fixed, newest(fixed)).data.segments, "L 16:00-");
});
check("a pause, then It was Right on that part, still undoes the pause", () => {
  const pa = pause(feed("L 16:00-"), D("16:10")).data;
  const flipped = setSide(pa, ref("L", "16:00"), "R", live("16:12")).data;
  const u = undoLastTap(flipped, newest(flipped));
  eqSegs(u.data.segments, "R 16:00-");
  eq(u.what, "pause");
});
check("a tap the stretches no longer show is refused (changed)", () => {
  // Switched to Right, then It was Left on it: Left all along, so no switch to take back.
  const sw = switchTo(feed("L 16:00-"), "R", D("16:16")).data;
  const merged = setSide(sw, ref("R", "16:16"), "L", live("16:20")).data;
  eqSegs(merged.segments, "L 16:00-");
  const e = throwsCode(() => undoLastTap(merged, newest(merged)), "nothing_to_undo");
  eq(feedEditCopy(e, "ui", TZ), "The times were fixed after that tap, so there's nothing to undo.");
});
check("undoableTap: what undo would take back, and when it was tapped", () => {
  eq(undoableTap(switchTo(feed("L 16:00-"), "R", D("16:10"), { now: D("16:10:01") }).data, live("16:11")), { what: "switch", at: T("16:10:01") });
  eq(undoableTap(pause(feed("L 16:00-"), D("16:10")).data, live("16:11")), { what: "pause", at: T("16:10") });
  eq(undoableTap(feed("L 16:00-"), live("16:11")), null);
  // Feeds from before taps were recorded: read off the newest stretch, at its moment.
  eq(undoableTap(s5, live("16:11")), { what: "switch", at: T("16:05") });
  eq(undoableTap(feed("L 16:00-16:05"), done("16:11", "16:05")), null);
});
check("restoredTap: Put it back after an undo brings the tap back; a misfit is dropped", () => {
  const sw = switchTo(feed("L 16:00-"), "R", D("16:10")).data;
  const undone = undoLastTap(sw, newest(sw)).data;
  eq(restoredTap(undone, sw.segments!, true), { kind: "switch", side: "R", at: T("16:10") });
  // A merged resume put back to its paused before: the pause is the latest tap again, read off the stretches.
  const paused = pause(feed("L 16:00-"), D("16:05")).data;
  const merged = switchTo(paused, "L", D("16:05:30")).data;
  eq(restoredTap(merged, paused.segments!, true), undefined);
  eq(restoredTap(merged, merged.segments!, false), undefined);
});
check("switchTo resume with a time: already back on that side moves when she went back on", () => {
  // Paused at 4:10; the other phone resumed Right at 4:17; this phone says she went back on at 4:12.
  const theirs = switchTo(feed("L 16:00-16:10"), "R", D("16:17")).data;
  const r = switchTo(theirs, "R", D("16:12"), { explicit: true, resume: true, now: D("16:18") });
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:12-");
  eq([r.moved, r.clamped, r.noop], [true, undefined, undefined]);
  eq(tapOf(r.data), tapOf(theirs), "the tap stays theirs");
  const early = switchTo(theirs, "R", D("16:05"), { explicit: true, resume: true, now: D("16:18") });
  eqSegs(early.data.segments, "L 16:00-16:10, R 16:10-");
  eq([early.moved, early.clamped], [true, true]);
  eq(switchTo(theirs, "R", D("16:17:30"), { explicit: true, resume: true, now: D("16:18") }).noop, true);
});
check("switchTo resume with a time: the other side is not_newest (409 changed), not before_own_start", () => {
  const theirs = switchTo(feed("L 16:00-16:10"), "L", D("16:17")).data;
  throwsCode(() => switchTo(theirs, "R", D("16:12"), { explicit: true, resume: true }), "not_newest");
  throwsCode(() => switchTo(theirs, "R", D("16:20"), { explicit: true, resume: true }), "not_newest");
  // Without resume (a switch someone asked for at a time) the old answer stands.
  throwsCode(() => switchTo(theirs, "R", D("16:12"), { explicit: true }), "before_own_start");
  // Still paused: an ordinary resume.
  eqSegs(switchTo(feed("L 16:00-16:10"), "R", D("16:12"), { explicit: true, resume: true }).data.segments, "L 16:00-16:10, R 16:12-");
});
check("switchTo resume with no time (a stale dock's Resume): the other side is not_newest, the same side a noop", () => {
  // Two-phones NEW[3]: Brittany resumed on the Left; Matt's Resume on Right must not switch her over it.
  const theirs = switchTo(feed("L 16:00-16:10"), "L", D("16:17")).data;
  throwsCode(() => switchTo(theirs, "R", D("16:18"), { resume: true }), "not_newest");
  eq(switchTo(theirs, "L", D("16:18"), { resume: true }).noop, true);
  // A plain switch (the dock's Switch) still switches.
  eqSegs(switchTo(theirs, "R", D("16:18")).data.segments, "L 16:00-16:10, L 16:17-16:18, R 16:18-");
  // Still paused: an ordinary resume, now.
  eqSegs(switchTo(feed("L 16:00-16:10"), "R", D("16:12"), { resume: true }).data.segments, "L 16:00-16:10, R 16:12-");
});
check("before_own_start on the feed's only side names feed_start (stop_timer, switch, pause)", () => {
  const stop = throwsCode(() => stopBreast(feed("L 16:17-"), D("16:15"), D("16:27")), "before_own_start");
  eq(
    feedEditCopy(stop, "mcp", TZ),
    'The feed started at 4:17 PM, after 4:15. If it really started earlier, fix that first with fix_nursing_time {part:"feed_start", at:"…"}, then stop_timer; otherwise give a time after 4:17 PM.'
  );
  eq(feedEditCopy(stop, "ui", TZ), "Can't be before Left started (4:17 PM).");
  eq(throwsCode(() => stopBreast(feed("L 16:00-16:10"), D("15:55"), D("16:27")), "before_own_start").params.first, "1");
  eq(throwsCode(() => pause(feed("L 16:00-"), D("15:58"), { explicit: true }), "before_own_start").params.first, "1");
  eq(throwsCode(() => switchTo(feed("L 16:00-"), "R", D("15:58"), { explicit: true }), "before_own_start").params.first, "1");
  // With a side before it, the mistaken-tap advice stands.
  eq(throwsCode(() => stopBreast(s1, D("16:10"), D("16:30")), "before_own_start").params.first, undefined);
});
check("staleFeed: an hour with nothing tapped, or on a break a given time 30 min past the pause", () => {
  const e = (start: string, spec: string) => ({ started_at: T(start), data: feed(spec) });
  eq(staleFeed(e("15:00", "L 15:00-"), D("16:01")), true, "a side left on for an hour");
  eq(staleFeed(e("15:30", "L 15:30-15:40, R 15:40-"), D("16:20")), false);
  eq(staleFeed(e("15:30", "L 15:30-15:40"), D("16:20"), D("16:15")), true, "on a break, a time 35 min after the pause: a new feed");
  eq(staleFeed(e("15:30", "L 15:30-15:40, R 15:50-"), D("16:20"), D("16:15")), false);
  // Two-phones NEW[5]: a cluster feed that started 70 min ago, tapped 2 min ago, is still this feed.
  eq(staleFeed(e("15:00", "L 15:00-15:20, R 15:55-16:08"), D("16:10")), false, "paused 2 min ago");
  eq(staleFeed(e("15:00", "L 15:00-15:20, R 15:55-16:08"), D("16:10"), D("16:09")), false, "with a time just now");
  eq(staleFeed(e("15:00", "L 15:00-15:30, R 15:30-"), D("16:29")), false, "open 59 min since the switch");
  eq(staleFeed(e("15:00", "L 15:00-15:30, R 15:30-"), D("16:31")), true, "open 61 min since the switch");
  // Dozed on the shoulder: a 32 min break is still this feed for "nurse right" (review: Siri refused it).
  eq(staleFeed(e("15:30", "L 15:30-15:40"), D("16:12")), false, "a 32 min break, no time given");
  eq(staleFeed(e("15:30", "L 15:30-15:40"), D("16:41")), true, "a 61 min break");
  eq(staleFeed(e("15:30", "L 15:30-15:40"), D("16:11"), D("15:45")), false, "a 31 min break, but she went back on 5 min after the pause");
  eq(staleFeed(e("15:00", "L 15:00-15:20"), D("16:30"), D("15:25")), false, "a time just after an old pause is still this feed");
  // A side that's on is going on now: a time given only switches (review: refused after 30 min on one side).
  eq(staleFeed(e("15:40", "R 15:40-"), D("16:19"), D("16:17")), false, "Right on 37 min, a time 2 min ago");
  // A pause tapped late (recorded 15:05) still counts from when it was tapped.
  const late = { started_at: T("15:00"), data: { ...feed("L 15:00-15:05"), last_tap: { kind: "pause", side: "L", at: T("15:40") } } as TapFeedData };
  eq(staleFeed(late, D("16:35")), false, "55 min since the tap");
  eq(staleFeed(late, D("16:41")), true, "61 min since the tap");
});

// ── resided: a Switch just after going back on (round 3) ─────────────────

check("resided: Switch within 15 s of a resume onto the other side changes that side, keeping the break", () => {
  // Left 4:00–4:10, break, Next side (Right) at 4:20, then Switch at 4:20:05: she went back on the Left.
  const resumed = switchTo(feed("L 16:00-16:10"), "R", D("16:20"));
  const r = switchTo(resumed.data, "L", D("16:20:05"));
  eqSegs(r.data.segments, "L 16:00-16:10, L 16:20-");
  eq([r.resided, r.reverted], [true, undefined]);
  eq(tapOf(r.data), { kind: "resume", side: "L", at: T("16:20"), paused_at: T("16:10") }, "still the resume, on its new side");
  eq(rows(feedParts(r.data, live("16:21"))), ["L 16:00-16:10 10 min", "Break 16:10-16:20 10 min", "L 16:20- 1 min"]);
  // Undo takes back the resume: paused again, as before it.
  eqSegs(undoLastTap(r.data, newest(r.data)).data.segments, "L 16:00-16:10");
  eq(undoableTap(r.data, live("16:21"))?.what, "resume");
});
check("resided: the same for a Resume on the side she came off, and a second Switch flips it back", () => {
  const resumed = switchTo(feed("L 16:00-16:10"), "L", D("16:20"));
  const r = switchTo(resumed.data, "R", D("16:20:10"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:20-");
  eq(r.resided, true);
  const again = switchTo(r.data, "L", D("16:20:14"));
  eqSegs(again.data.segments, "L 16:00-16:10, L 16:20-");
  eq(again.resided, true);
});
check("resided: 15 s or more after the resume it's an ordinary switch", () => {
  const resumed = switchTo(feed("L 16:00-16:10"), "R", D("16:20"));
  const r = switchTo(resumed.data, "L", D("16:20:15"));
  eqSegs(r.data.segments, "L 16:00-16:10, R 16:20-16:20:15, L 16:20:15-");
  eq([r.resided, tapOf(r.data)?.kind], [undefined, "switch"]);
});
check("resided: a short break keeps its break; a resume given an earlier time is a real part, so a switch is a switch", () => {
  const quick = switchTo(feed("L 16:00-16:10"), "R", D("16:10:30"));
  const r = switchTo(quick.data, "L", D("16:10:35"));
  eqSegs(r.data.segments, "L 16:00-16:10, L 16:10:30-");
  eq(r.resided, true);
  eqSegs(undoLastTap(r.data, newest(r.data)).data.segments, "L 16:00-16:10");
  // "Back on the Right 5 min ago" (or clamped to the pause), then Switch: Right was on, so it stays and Left starts now.
  const told = switchTo(feed("L 16:00-16:10"), "R", D("16:15"), { explicit: true, now: D("16:20") });
  eqSegs(switchTo(told.data, "L", D("16:20:03")).data.segments, "L 16:00-16:10, R 16:15-16:20:03, L 16:20:03-");
  const clamped = switchTo(feed("L 16:00-16:10"), "R", D("16:05"), { explicit: true, now: D("16:20") });
  eqSegs(clamped.data.segments, "L 16:00-16:10, R 16:10-");
  eq(switchTo(clamped.data, "L", D("16:20:03")).resided, undefined);
});
check("resided: not after a merged resume, a switch tapped with a time, or a switch (that's the revert rule)", () => {
  const merged = switchTo(feed("L 16:00-16:10"), "L", D("16:10:30"));
  eq(merged.merged, true);
  const r = switchTo(merged.data, "R", D("16:10:35"));
  eqSegs(r.data.segments, "L 16:00-16:10:35, R 16:10:35-");
  eq(r.resided, undefined);
  const resumed = switchTo(feed("L 16:00-16:10"), "R", D("16:20"));
  const timed = switchTo(resumed.data, "L", D("16:20:05"), { explicit: true, now: D("16:20:06") });
  eqSegs(timed.data.segments, "L 16:00-16:10, R 16:20-16:20:05, L 16:20:05-");
  eq(timed.resided, undefined);
  const sw = switchTo(switchTo(feed("L 16:00-"), "R", D("16:10")).data, "L", D("16:10:05"));
  eq([sw.reverted, sw.resided], [true, undefined]);
  eqSegs(sw.data.segments, "L 16:00-");
});

// ── previousFeed (the start toast's "Same feed as 8:30") ─────────────────

check("previousFeed: the newest finished feed that ended by this one's start", () => {
  const mk = (id: number, start: string, end: string | null, active = false) =>
    ({ ...entryOf(feed(`L ${start}-${end ?? ""}`), active ? live("17:00") : done("17:00", end!)), id }) as EntryOf<"feed">;
  const list = [mk(1, "15:00", "15:20"), mk(2, "16:00", "16:30"), mk(3, "16:50", null, true), mk(4, "16:20", "16:40")];
  const now = { id: 9, started_at: T("16:45") };
  eq(previousFeed(list, now)?.id, 4);
  eqTime(new Date(previousFeedEnd(list, now)!), "16:40", "its end");
  eq(previousFeed(list, { id: 9, started_at: T("15:10") }), null);
});

// ── memberLabel (§1.5) ───────────────────────────────────────────────────

const member = (email: string, display_name: string | null, role: Member["role"] = "member"): Member => ({ email, role, display_name, emoji: null, color: null });
const matt = member("matt@example.com", "Matt", "owner");
const brit = member("brittany@example.com", "Brittany");
const admin = member("admin", null, "owner");
const members = [matt, brit, admin];
const baby = (settings: Record<string, unknown> = {}): Baby => ({
  id: 1, name: "Maple", nickname: null, sex: "female", due_date: null, born_at: null, birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, timezone: TZ, settings,
});
check("memberLabel: the viewer is null", () => eq(memberLabel(matt.email, { members, me: matt, baby: baby() }), null));
check("memberLabel: another member is named", () => eq(memberLabel(brit.email, { members, me: matt, baby: baby() }), "Brittany"));
check("memberLabel: admin with no admin_as is null", () => eq(memberLabel("admin", { members, me: matt, baby: baby() }), null));
check("memberLabel: admin acting as the viewer is null", () => eq(memberLabel("admin", { members, me: matt, baby: baby({ admin_as: matt.email }) }), null));
check("memberLabel: admin acting as someone else is them", () => eq(memberLabel("admin", { members, me: matt, baby: baby({ admin_as: brit.email }) }), "Brittany"));
check("memberLabel: unknown and empty ids are null", () => {
  eq(memberLabel("someone@else.com", { members, me: matt, baby: baby() }), null);
  eq(memberLabel(null, { members, me: matt, baby: baby() }), null);
});
check("memberLabel: viewer signed in as admin", () => {
  eq(memberLabel("admin", { members, me: admin, baby: baby({ admin_as: brit.email }) }), null);
  eq(memberLabel(brit.email, { members, me: admin, baby: baby() }), "Brittany");
});
check("memberLabel: never prints Admin", () =>
  eq([matt.email, brit.email, "admin"].map((id) => memberLabel(id, { members, me: brit, baby: baby() })).filter((x) => x === "Admin"), []));

// ── the card's live total (timerNumbers, FeedParts.tsx) ──────────────────

check("live total: the closed rows' minutes plus the live row's (Matt's card)", () => {
  // Left 5:19:57 – 5:35:00 reads "16 min"; the old seconds total said 15:04 under it.
  const data = feed("L 05:19:57-05:35:00, R 05:35:00-");
  const ctx = live("05:35:01");
  const n = timerNumbers(entryOf(data, ctx), ctx.now);
  eq(rows(n.parts.slice(0, 1)), ["L 05:19:57-05:35 16 min"]);
  eq(formatClock(n.current.sec), "0:01", "live clock");
  eq(n.totalMin, 16, "total");
});
check("live total: every row's whole minutes, the live one counted to now, at every second of a long feed", () => {
  const data = feed("L 02:15:10-02:27:40, R 02:27:40-02:40:05, L 02:40:30-");
  for (let s = 0; s < 900; s += 7) {
    const now = new Date(D("02:40:30").getTime() + s * 1000);
    const n = timerNumbers(entryOf(data, { now, active: true, endedAt: null }), now);
    const closed = n.parts.filter((p) => p.kind === "side" && p.end !== null).reduce((a, p) => a + p.min, 0);
    eq(closed, 12 + 13, "closed rows");
    eq(n.totalMin, closed + spanMinutes(n.current.since, now), `rows + live row at +${s}s`);
  }
});
check("live total: paused, it's the closed sides' minutes (the break's clock isn't nursing)", () => {
  const data = feed("L 05:19:57-05:35:00, R 05:35:00-05:47:20");
  const ctx = live("05:50:10");
  const n = timerNumbers(entryOf(data, ctx), ctx.now);
  eq(n.paused, true, "paused");
  eq(n.totalMin, 28, "16 + 12");
  eq(n.elapsed, 15 * 60 + 3 + 12 * 60 + 20, "elapsed keeps the exact seconds");
});
check("live total: Done says the rows' minutes, the card's closed rows plus the last side's row", () => {
  const data = feed("L 05:19:57-05:35:00, R 05:35:00-05:47:20, L 05:47:20-");
  const at = D("05:48:05");
  const n = timerNumbers(entryOf(data, live("05:48:05")), at);
  const stopped = stopBreast(data, at, at);
  const t = feedMinutes(entryOf(stopped.data, { now: at, active: false, endedAt: stopped.endedAt }), at);
  eq(t.total, 16 + 12 + spanMinutes(n.current.since, at), "Done");
  eq(t.total, 29, "L 16 + 1 · R 12");
  eq(n.totalMin, 29, "the card a moment before says what Done then says");
});

check("resided: only the same person's resume; the other phone's Switch just after it is a real switch", () => {
  const resumed = switchTo(feed("L 16:00-16:10"), "R", D("16:20"), { by: "brittany@example.com" });
  eq(tapOf(resumed.data)?.by, "brittany@example.com", "the tap says who");
  const mine = switchTo(resumed.data, "L", D("16:20:05"), { by: "brittany@example.com" });
  eq(mine.resided, true, "her own quick Switch re-sides her resume");
  const theirs = switchTo(resumed.data, "L", D("16:20:05"), { by: "matt@example.com" });
  eq(theirs.resided, undefined, "his Switch switches");
  eqSegs(theirs.data.segments, "L 16:00-16:10, R 16:20-16:20:05, L 16:20:05-");
});
check("live total: a Switch or a Pause doesn't move it (the row that closes has the live side's minutes)", () => {
  const data = feed("L 05:19:57-05:35:00, R 05:35:00-");
  const at = D("05:47:56");
  const before = timerNumbers(entryOf(data, live("05:47:56")), at).totalMin;
  eq(before, 16 + 12, "before");
  const later = D("05:47:58");
  eq(timerNumbers(entryOf(switchTo(data, "L", at).data, live("05:47:58")), later).totalMin, before, "after Switch");
  eq(timerNumbers(entryOf(pause(data, at).data, live("05:47:58")), later).totalMin, before, "after Pause");
});

// ── celebrations: her firsts are lifetime firsts, not the earliest loaded ──

{
  const H = 3600_000;
  const bornAt = new Date("2026-10-19T09:00:00Z");
  const born: Baby = { ...baby(), born_at: bornAt.toISOString() };
  let nextId = 9000;
  const entry = (kind: "diaper" | "bath", at: Date, data: Record<string, unknown> = {}) =>
    ({
      id: nextId++, kind, started_at: at.toISOString(), ended_at: null, active: false, data, note: null,
      created_by: "matt@example.com", updated_by: null, source: "web", created_at: at.toISOString(), updated_at: at.toISOString(),
    }) as unknown as Parameters<typeof summarizeDay>[0]["entries"][number];
  const poop = (at: Date) => entry("diaper", at, { pee: false, poop: true });
  const ids = (now: Date, entries: ReturnType<typeof poop>[], lifetime?: Parameters<typeof summarizeDay>[0]["lifetime"]) =>
    summarizeDay({ entries, baby: born, now, lifetime }).celebrations.map((c) => c.id);
  const day5 = new Date(bornAt.getTime() + 4.5 * 24 * H);
  const lastDays = [poop(new Date(day5.getTime() - 30 * H)), poop(new Date(day5.getTime() - 5 * H))];

  check("celebrations: no 'First poop!' on day 5 when her first was on day 1 (only the last 72h are loaded)", () => {
    const firsts = { poop: new Date(bornAt.getTime() + 6 * H).toISOString(), bath: null, tummy: null };
    eq(ids(day5, lastDays, { diapers: 12, feeds: 20, firsts }).includes("first-poop"), false);
  });
  check("celebrations: an older server answer (no firsts) never calls a day-5 poop her first", () => {
    eq(ids(day5, lastDays, { diapers: 12, feeds: 20 }).includes("first-poop"), false);
    eq(ids(day5, lastDays).includes("first-poop"), false);
  });
  check("celebrations: her real first poop, on day 1, is celebrated", () => {
    const now = new Date(bornAt.getTime() + 20 * H);
    const first = poop(new Date(bornAt.getTime() + 10 * H));
    eq(ids(now, [first], { diapers: 3, feeds: 4, firsts: { poop: first.started_at, bath: null, tummy: null } }).includes("first-poop"), true);
    eq(ids(now, [first]).includes("first-poop"), true, "and from the loaded entries while they cover her whole life");
  });
  check("celebrations: a 'first' poop logged only on day 6 (logging started late) isn't the meconium", () => {
    const now = new Date(bornAt.getTime() + 6 * 24 * H);
    const late = poop(new Date(now.getTime() - 2 * H));
    eq(ids(now, [late], { diapers: 1, feeds: 0, firsts: { poop: late.started_at, bath: null, tummy: null } }).includes("first-poop"), false);
  });
  check("celebrations: a bath yesterday isn't 'First bath!' when her first was a week ago", () => {
    const now = new Date(bornAt.getTime() + 9 * 24 * H);
    const bath = entry("bath", new Date(now.getTime() - 20 * H));
    const firsts = { poop: null, bath: new Date(bornAt.getTime() + 2 * 24 * H).toISOString(), tummy: null };
    eq(ids(now, [bath], { diapers: 60, feeds: 80, firsts }).includes("first-bath"), false);
    eq(ids(now, [bath], { diapers: 60, feeds: 80, firsts: { ...firsts, bath: bath.started_at } }).includes("first-bath"), true, "unless it really was her first");
  });
}

// ── done ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

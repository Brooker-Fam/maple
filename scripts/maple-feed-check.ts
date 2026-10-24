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
  feedParts,
  finalizeBreast,
  momentQuestion,
  moveEdge,
  normalizeSegments,
  partTotals,
  pause,
  retimeBreast,
  setSide,
  stopBreast,
  summarize,
  switchTo,
  undoLastTap,
  type FeedCtx,
  type FeedEditCode,
  type Part,
} from "../src/lib/maple/feed";
import { memberLabel } from "../src/lib/maple/insights";
import { formatClock, formatMinutes, formatRange, formatTimeNear, localParts, zonedTimeToUtc } from "../src/lib/maple/time";
import type { Baby, FeedData, Member, Segment, Side } from "../src/lib/maple/types";

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

/** Parts as readable rows: "L 16:00-16:10 10 min", "Break 16:10- 20 min". */
const rows = (parts: Part[]) =>
  parts.map((p) => `${p.kind === "side" ? p.side : p.legacy ? "Legacy" : "Break"} ${clock(p.start)}-${p.end ? clock(p.end) : ""} ${formatMinutes(p.sec)}`);

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
check("feedParts: break rows read 2 min and <1 min", () => {
  eq(rows(feedParts(switchTo(feed("L 16:00-16:10"), "L", D("16:11:30")).data, live("16:12")))[1], "Break 16:10-16:11:30 2 min");
  eq(rows(feedParts(switchTo(feed("L 16:00-16:10"), "R", D("16:10:20")).data, live("16:12")))[1], "Break 16:10-16:10:20 <1 min");
});
check("feedParts: odd stored data is repaired, not thrown", () => {
  const parts = feedParts(feed("L 16:00-16:10, R 16:05-16:20"), done("17:00", "16:20"));
  eq(rows(parts), ["L 16:00-16:10 10 min", "R 16:10-16:20 10 min"]);
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

// ── done ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

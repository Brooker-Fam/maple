import assert from "node:assert/strict";
import { buildDayDialMarks } from "../src/components/maple/DayDial";
import { buildRibbon } from "../src/components/maple/PatternsTab";
import { clockContains } from "../src/lib/maple/clock-spans";
import { nursingRuns } from "../src/lib/maple/feed";
import { statsFor } from "../src/lib/maple/insights";
import { dayBounds } from "../src/lib/maple/time";
import type { Entry, EntryOf } from "../src/lib/maple/types";

const tz = "America/New_York";
const ms = Date.parse;
const now = new Date("2026-10-29T16:00:00-04:00");
const near = (a: number, b: number) => assert(Math.abs(a - b) < 0.000001, `${a} differs from ${b}`);
const base = { active: false, note: null, created_by: "example", created_at: now.toISOString(), updated_at: now.toISOString() };
const paused = { ...base, id: 1, kind: "feed", started_at: "2026-10-29T10:00:00-04:00", ended_at: "2026-10-29T11:00:00-04:00", data: { method: "breast", segments: [
  { side: "L", start: "2026-10-29T10:00:00-04:00", end: "2026-10-29T10:10:00-04:00" },
  { side: "R", start: "2026-10-29T10:50:00-04:00", end: "2026-10-29T11:00:00-04:00" },
] } } as EntryOf<"feed">;
const [start, end] = dayBounds("2026-10-29", tz);
const row = buildRibbon([paused], "2026-10-29", "2026-10-29", "days", tz, now, null, "us")[0];
assert.equal(row.feeds.length, 2);
near(row.feeds.reduce((sum, mark) => sum + (mark.x2 - mark.x1) * 1440, 0), 20);
assert.deepEqual(row.stats, statsFor([paused], start, new Date(+now + 1), row.key, now, nursingRuns([paused], now)));
const marks = buildDayDialMarks([paused], +start, +end, +now, tz);
assert.equal(marks.arcs.length, 2);
assert(!marks.arcs.some((arc) => clockContains(630 / 1440, arc.a0 / 360, arc.a0 / 360 + (arc.e - arc.s) / 86_400_000)), "10:30 pause is not a nursing hit");
console.log("PASS nursing spans leave pauses blank while run counts and totals stay unchanged");

const crossing = { ...paused, id: 2, started_at: "2026-10-28T23:50:00-04:00", ended_at: "2026-10-29T00:20:00-04:00", data: { method: "breast", segments: [{ side: "B", start: "2026-10-28T23:50:00-04:00", end: "2026-10-29T00:20:00-04:00" }] } } as EntryOf<"feed">;
const days = buildRibbon([crossing], "2026-10-28", "2026-10-29", "days", tz, now, null, "us");
assert.equal(days[0].stats.feeds, 0);
assert.equal(days[1].stats.feeds, 1);
near(days[0].feeds.reduce((sum, mark) => sum + (mark.x2 - mark.x1) * 1440, 0), 20);
near(days[1].feeds.reduce((sum, mark) => sum + (mark.x2 - mark.x1) * 1440, 0), 10);
assert.equal(days.reduce((sum, d) => sum + d.stats.bothSec, 0), 30 * 60);
console.log("PASS nursing continues visually after midnight without recounting its feed or minutes");

const fallNow = new Date("2026-11-01T12:00:00-05:00");
const sleep = { ...base, id: 3, kind: "sleep", started_at: "2026-11-01T01:30:00-04:00", ended_at: "2026-11-01T01:15:00-05:00", data: {} } as Entry;
const fall = buildRibbon([sleep], "2026-11-01", "2026-11-01", "days", tz, fallNow, null, "us")[0];
assert.equal(fall.sleeps.length, 2);
near(fall.sleeps[0].x1 * 1440, 90);
near(fall.sleeps[0].x2 * 1440, 120);
near(fall.sleeps[1].x1 * 1440, 60);
near(fall.sleeps[1].x2 * 1440, 75);
assert.equal(fall.stats.sleepSec, 45 * 60);
const [fallStart, fallEnd] = dayBounds("2026-11-01", tz);
const fallMarks = buildDayDialMarks([sleep], +fallStart, +fallEnd, +fallNow, tz);
assert.equal(fallMarks.arcs.length, 2);
assert(fallMarks.arcs.some((a) => clockContains(70 / 1440, a.a0 / 360, (a.a0 + a.span) / 360)), "Second 1:10 AM is tappable");
console.log("PASS dial and comparison split the repeated hour and keep the second occurrence tappable");

const pausedLive = { ...paused, active: true, ended_at: null, data: { method: "breast", segments: [paused.data.segments![0]] } } as EntryOf<"feed">;
const pausedLiveRow = buildRibbon([pausedLive], "2026-10-29", "2026-10-29", "days", tz, now, null, "us")[0];
assert.equal(pausedLiveRow.feeds.length, 1);
near(pausedLiveRow.feeds[0].x2 * 1440, 610);
const live = { ...paused, active: true, ended_at: null, data: { method: "breast", segments: [{ side: "L", start: "2026-10-29T15:30:00-04:00", end: null }] } } as EntryOf<"feed">;
const liveRow = buildRibbon([live], "2026-10-29", "2026-10-29", "days", tz, now, null, "us")[0];
near(liveRow.feeds[0].x2 * 1440, 960);
console.log("PASS paused and running timers stop their marks at the recorded pause or now");

const midnight = { ...base, id: 4, kind: "diaper", started_at: "2026-10-29T00:00:00-04:00", ended_at: null, data: { pee: true, poop: false } } as Entry;
const [yesterdayStart, yesterdayEnd] = dayBounds("2026-10-28", tz);
assert.equal(buildDayDialMarks([midnight], +yesterdayStart, +yesterdayEnd, +now, tz).dots.length, 0);
assert.equal(buildDayDialMarks([midnight], +start, +end, +now, tz).dots.length, 1);
const endedAtMidnight = { ...crossing, ended_at: "2026-10-29T00:00:00-04:00", data: { method: "breast", segments: [{ side: "L", start: crossing.started_at, end: "2026-10-29T00:00:00-04:00" }] } } as EntryOf<"feed">;
assert.equal(buildDayDialMarks([endedAtMidnight], +start, +end, +now, tz).arcs.length, 0);
console.log("PASS midnight point events and ended stretches stay on their correct calendar day");

const future = { ...midnight, id: 5, started_at: "2026-10-29T17:00:00-04:00" } as Entry;
const bottle = { ...paused, id: 6, started_at: now.toISOString(), ended_at: null, data: { method: "bottle", amount_ml: 60 } } as EntryOf<"feed">;
const current = buildRibbon([future, bottle], "2026-10-29", "2026-10-29", "days", tz, now, null, "us")[0];
assert.equal(current.diapers.length, 0);
assert.equal(current.stats.wet, 0);
assert.equal(current.feeds[0].x1, current.feeds[0].x2);
assert.equal(current.stats.bottleMl, 60);
assert.equal(buildDayDialMarks([future], +start, +end, +now, tz).dots.length, 0);
console.log("PASS future events are not plotted and bottles without duration remain point marks");

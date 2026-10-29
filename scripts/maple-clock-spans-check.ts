import assert from "node:assert/strict";
import { clockFraction, clockSpans } from "../src/lib/maple/clock-spans";
import { dayBounds } from "../src/lib/maple/time";

const NY = "America/New_York";
const ms = Date.parse;
const minutes = (spans: ReturnType<typeof clockSpans>) => spans.map(({ x1, x2 }) => [x1 * 1440, x2 * 1440]);
const near = (actual: number, expected: number) => assert(Math.abs(actual - expected) < 0.000001, `${actual} differs from ${expected}`);
function expectedSpans(actual: ReturnType<typeof clockSpans>, expected: number[][], elapsedMinutes: number) {
  assert.equal(actual.length, expected.length);
  minutes(actual).forEach((pair, i) => pair.forEach((value, j) => near(value, expected[i][j])));
  near(actual.reduce((sum, span) => sum + (span.end - span.start) / 60_000, 0), elapsedMinutes);
  for (const span of actual) {
    assert(span.start < span.end && span.x1 >= 0 && span.x2 <= 1 && span.x1 < span.x2);
  }
}
const inDay = (from: string, to: string, day: string, tz = NY) => {
  const [a, b] = dayBounds(day, tz);
  return clockSpans(ms(from), ms(to), +a, +b, 0, tz);
};

expectedSpans(inDay("2026-10-29T10:10:00-04:00", "2026-10-29T11:20:00-04:00", "2026-10-29"), [[610, 680]], 70);
console.log("PASS ordinary local interval keeps its recorded clock endpoints");

expectedSpans(inDay("2026-11-01T00:30:00-04:00", "2026-11-01T02:30:00-05:00", "2026-11-01"), [[30, 120], [60, 150]], 180);
expectedSpans(inDay("2026-11-01T01:30:00-04:00", "2026-11-01T01:15:00-05:00", "2026-11-01"), [[90, 120], [60, 75]], 45);
expectedSpans(inDay("2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00", "2026-11-01"), [[90, 120], [60, 90]], 60);
console.log("PASS repeated fall hour keeps both pieces, even when clock endpoints reverse or match");

expectedSpans(inDay("2026-03-08T01:30:00-05:00", "2026-03-08T03:30:00-04:00", "2026-03-08"), [[90, 120], [180, 210]], 60);
console.log("PASS spring clock change leaves the nonexistent hour unpainted");

expectedSpans(inDay("2026-04-05T01:45:00+11:00", "2026-04-05T01:45:00+10:30", "2026-04-05", "Australia/Lord_Howe"), [[105, 120], [90, 105]], 30);
expectedSpans(inDay("2026-10-04T01:45:00+10:30", "2026-10-04T02:45:00+11:00", "2026-10-04", "Australia/Lord_Howe"), [[105, 120], [150, 165]], 30);
console.log("PASS half-hour timezone changes preserve their actual gaps and overlaps");

expectedSpans(inDay("2026-10-28T23:50:00-04:00", "2026-10-29T00:20:00-04:00", "2026-10-28"), [[1430, 1440]], 10);
expectedSpans(inDay("2026-10-28T23:50:00-04:00", "2026-10-29T00:20:00-04:00", "2026-10-29"), [[0, 20]], 20);
console.log("PASS crossing midnight clips independently into both calendar days");

expectedSpans(clockSpans(ms("2026-10-28T23:50:00-04:00"), ms("2026-10-29T00:20:00-04:00"), ms("2026-10-28T12:00:00-04:00"), ms("2026-10-29T12:00:00-04:00"), 720, NY), [[710, 740]], 30);
expectedSpans(clockSpans(ms("2026-10-28T23:50:00-04:00"), ms("2026-10-29T00:20:00-04:00"), ms("2026-10-28T12:00:00-04:00"), ms("2026-10-29T12:00:00-04:00"), 0, NY), [[1430, 1440], [0, 20]], 30);
console.log("PASS night origins and rolling windows wrap only at the chosen clock origin");

expectedSpans(inDay("2026-11-01T00:00:00-04:00", "2026-11-02T00:00:00-05:00", "2026-11-01"), [[0, 120], [60, 1440]], 25 * 60);
expectedSpans(inDay("2026-03-08T00:00:00-05:00", "2026-03-09T00:00:00-04:00", "2026-03-08"), [[0, 120], [180, 1440]], 23 * 60);
console.log("PASS full clock-change days retain 23 or 25 actual hours");

assert.deepEqual(inDay("2026-10-29T00:00:00-04:00", "2026-10-29T00:00:00-04:00", "2026-10-29"), []);
assert.deepEqual(inDay("2026-10-28T22:00:00-04:00", "2026-10-29T00:00:00-04:00", "2026-10-29"), []);
assert.deepEqual(inDay("2026-10-30T00:00:00-04:00", "2026-10-30T01:00:00-04:00", "2026-10-29"), []);
near(clockFraction(ms("2026-10-29T12:00:00+05:45"), 0, "Asia/Kathmandu"), 0.5);
near(clockFraction(ms("2026-10-29T12:00:00+05:45"), 720, "Asia/Kathmandu"), 0);
console.log("PASS exclusive boundaries, zero-length events and non-hour timezone offsets");

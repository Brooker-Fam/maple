/** Synthetic checks only: numeric snapshots, missing logs, bounds, and WHO reuse. */
import assert from "node:assert/strict";
import { buildActivityChart, buildGrowthChart, CHART_GROWTH_POINTS, parseChatChart } from "../src/lib/maple/chat/charts";
import { readingFor } from "../src/lib/maple/growth";
import type { Entry } from "../src/lib/maple/types";

const now = new Date("2026-11-05T02:15:00Z");
const timezone = "America/New_York";
const row = (date: string, values: Partial<{ feeds: number; wet: number; dirty: number; sleep_hours: number }> = {}) => ({ date, feeds: 0, wet: 0, dirty: 0, sleep_hours: 0, ...values });
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
const growth = (id: number, at: string, weight_g?: number): Entry => ({ id, kind: "growth", started_at: at, ended_at: null, active: false, data: weight_g == null ? { length_cm: 54 } : { weight_g }, note: null, created_by: "example@example.com", source: "web", updated_by: null, created_at: at, updated_at: at });

async function main() {
  await check("activity retains 14 local days and marks the local today partial", () => {
    const chart = buildActivityChart({ per_day: [row("2026-11-04", { feeds: 6 })] }, { now, timezone });
    assert.equal(chart.to, "2026-11-04");
    assert.equal(chart.from, "2026-10-22");
    assert.equal(chart.days.length, 14);
    assert.equal(chart.days.at(-1)?.partial, true);
    assert.equal(chart.days.at(-1)?.feeds, 6);
    assert.equal(chart.range, 7);
    assert.equal(chart.asOf, now.toISOString());
  });
  await check("missing categories stay unknown while a logged diaper can have zero wet", () => {
    const chart = buildActivityChart({ per_day: [row("2026-11-03", { dirty: 2 }), row("2026-11-04", { feeds: 3, sleep_hours: 2.5 })] }, { now, timezone, range: 14, metric: "diapers" });
    assert.deepEqual(chart.days.at(-2), { date: "2026-11-03", partial: false, feeds: null, sleepHours: null, wet: 0, dirty: 2 });
    assert.deepEqual(chart.days.at(-1), { date: "2026-11-04", partial: true, feeds: 3, sleepHours: 2.5, wet: null, dirty: null });
    assert.equal(chart.days[0].feeds, null);
    assert.equal(chart.metric, "diapers");
  });
  await check("activity rejects nonnumeric, impossible and duplicated values", () => {
    for (const feeds of [NaN, Infinity, -1, 0.5, 2001, "5"]) assert.throws(() => buildActivityChart({ per_day: [{ ...row("2026-11-03"), feeds }] }, { now, timezone }));
    assert.throws(() => buildActivityChart({ per_day: [row("2026-11-03"), row("2026-11-03")] }, { now, timezone }));
    assert.throws(() => buildActivityChart({ per_day: [row("2026-11-03", { sleep_hours: 73 })] }, { now, timezone }));
  });
  await check("activity copies only chart numbers, never notes, care data, or IDs", () => {
    const chart = buildActivityChart({ per_day: [{ ...row("2026-11-03", { feeds: 4 }), note: "private note", id: 912 }], mom: { doses: ["private"] } }, { now, timezone });
    const serialized = JSON.stringify(chart);
    assert(!serialized.includes("private"));
    assert(!serialized.includes("912"));
    assert(!serialized.includes("mom"));
  });
  const baby = { born_at: "2026-10-21T02:15:00Z", birth_weight_g: 3400, sex: "female" as const };
  await check("growth uses stored grams and the shared WHO calculation", async () => {
    const chart = await buildGrowthChart(baby, [growth(1, "2026-11-04T02:15:00Z", 3600)], { now, timezone });
    const expected = readingFor("weight", 3600, 14, "female");
    assert.equal(chart.points.length, 2);
    assert.equal(chart.points[0].birth, true);
    assert.equal(chart.points[1].weightG, 3600);
    assert.equal(chart.points[1].percentile, expected.pct?.percentile);
    assert.equal(chart.points[1].percentileLabel, expected.pct?.label);
  });
  await check("growth without a sex has no invented percentile", async () => {
    const chart = await buildGrowthChart({ ...baby, sex: null }, [growth(1, "2026-11-04T02:15:00Z", 3600)], { now, timezone });
    assert(chart.points.every((point) => point.percentile === null && point.percentileLabel === null));
  });
  await check("growth is capped at the newest 60 weight readings plus birth", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => growth(i + 1, new Date(now.getTime() - (100 - i) * 60_000).toISOString(), 3500 + i));
    const chart = await buildGrowthChart(baby, entries, { now, timezone });
    assert.equal(chart.points.length, CHART_GROWTH_POINTS + 1);
    assert.equal(chart.truncated, true);
    assert.equal(chart.points[1].weightG, 3540);
    assert.equal(chart.points.at(-1)?.weightG, 3599);
    assert(!JSON.stringify(chart).includes("example@example.com"));
  });
  await check("growth excludes future and length-only records and orders birth chronologically", async () => {
    const beforeBirth = growth(1, "2026-10-20T02:15:00Z", 3300);
    const chart = await buildGrowthChart(baby, [growth(3, "2026-12-01T02:15:00Z", 4000), growth(2, "2026-11-03T02:15:00Z"), beforeBirth], { now, timezone });
    assert.equal(chart.points.length, 2);
    assert.equal(chart.points[0].weightG, 3300);
    assert.equal(chart.points[1].birth, true);
    assert.equal(chart.from, "2026-10-19");
  });
  await check("old or invalid chart payloads do not render", () => {
    const chart = buildActivityChart({ per_day: [] }, { now, timezone });
    assert.equal(parseChatChart({ ...chart, version: 2 }), null);
    assert.equal(parseChatChart({ ...chart, timezone: "not/a/timezone" }), null);
    assert.equal(parseChatChart({ ...chart, days: Array(15).fill(chart.days[0]) }), null);
    assert.equal(parseChatChart(null), null);
    assert.deepEqual(parseChatChart(chart), chart);
  });
  console.log(`\n${passed} chart checks passed`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

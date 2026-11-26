/**
 * Assertions for the baby's alerts that count what was logged (insights.ts
 * summarize, COUNT_ALERTS, alertSwitches): the diaper warnings and feed
 * reminders each switch off on their own under Warnings & reminders, a
 * reading or a poop color is still checked with both off, Not all logged's
 * mark (an ack) quiets only its own episode, and the switches' values are
 * checked where they're saved (the baby route's checkLogSwitches).
 *
 *   npx tsx scripts/maple-alerts-check.ts      (or pnpm check:maple-alerts)
 *
 * Pure: no database and no network. One PASS/FAIL line per case, exit 1 on
 * any failure. A synthetic baby and synthetic entries only (the repo is
 * public). Times are UTC instants; the family's zone is America/New_York.
 */
import { alertKind, alertSwitches, COUNT_ALERTS, summarize } from "../src/lib/maple/insights";
import type { Baby, Entry } from "../src/lib/maple/types";
import { checkLogSwitches } from "../src/lib/maple/validate";
import { makeVoice } from "../src/lib/maple/voice";

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

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

function throws(fn: () => void, what: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${what}: expected it to be refused`);
}

// ── a synthetic family ───────────────────────────────────────────────────

const H = 3600_000;
const TZ = "America/New_York";
const vo = makeVoice({ name: "River", pronoun: "she" });
/** 10:00 AM in New York: daytime, before the evening's vitamin D nudge. */
const NOW = Date.parse("2026-11-20T15:00:00.000Z");

const baby = (bornHoursAgo: number, settings: Record<string, unknown> = {}): Baby => ({
  id: 1, name: "River", nickname: null, sex: "female", due_date: null, born_at: new Date(NOW - bornHoursAgo * H).toISOString(),
  birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, timezone: TZ, settings: { show_alerts: true, ...settings },
});

let nextId = 100;
const entry = (kind: Entry["kind"], hoursAgo: number, data: Record<string, unknown>): Entry => {
  const at = new Date(NOW - hoursAgo * H).toISOString();
  return {
    id: nextId++, kind, started_at: at, ended_at: null, active: false, data, note: null,
    created_by: "alex@example.test", updated_by: null, source: "web", created_at: at, updated_at: at,
  } as unknown as Entry;
};
const bottle = (hoursAgo: number) => entry("feed", hoursAgo, { method: "bottle", amount_ml: 60, milk: "formula" });
/** A bottle every `every` hours, from `from` hours ago up to `to` hours ago. */
const bottles = (from: number, to: number, every: number) => {
  const out: Entry[] = [];
  for (let h = to; h <= from; h += every) out.push(bottle(h));
  return out;
};
const wet = (hoursAgo: number) => entry("diaper", hoursAgo, { pee: true, poop: false });
const dirty = (hoursAgo: number, color?: string) => entry("diaper", hoursAgo, { pee: false, poop: true, ...(color ? { color } : {}) });

const alertsFor = (b: Baby, entries: Entry[]) => summarize({ entries, baby: b, now: new Date(NOW), vo }).alerts;
const ids = (b: Baby, entries: Entry[]) => alertsFor(b, entries).map((a) => a.id);
const kinds = (b: Baby, entries: Entry[]) => alertsFor(b, entries).map((a) => alertKind(a.id));
const diaperKinds = COUNT_ALERTS.diapers as readonly string[];
const feedKinds = COUNT_ALERTS.feeds as readonly string[];

// Day 11 (10 days old), every bottle logged since yesterday morning and no diaper at all: a family that doesn't log them.
const DAY11 = 10 * 24 + 1;
const fedNoDiapers = bottles(30, 1, 2.5);

// ── the diaper warnings ──────────────────────────────────────────────────

check("summarize: with no diapers logged, Day 11 shows both diaper counts, as call-today warnings", () => {
  const a = alertsFor(baby(DAY11), fedNoDiapers);
  eq(a.map((x) => x.id), ["low-wet:11", "low-stool:11"]);
  eq(a.map((x) => x.tier), ["today", "today"]);
});

check("summarize: diaper warnings off (diaper_alerts: false) hide every diaper count, and nothing else", () => {
  eq(ids(baby(DAY11, { diaper_alerts: false }), fedNoDiapers), []);
  // Off is only false: true, or the key never saved, keeps them.
  eq(ids(baby(DAY11, { diaper_alerts: true }), fedNoDiapers), ["low-wet:11", "low-stool:11"]);
  eq(ids(baby(DAY11, { diaper_alerts: null }), fedNoDiapers), ["low-wet:11", "low-stool:11"]);
});

// Under 5 days old, every baby also gets the first checkup's note: a mention, never a count.
const counted = (k: string) => k !== "first-checkup";

check("summarize: every diaper count the engine makes is in COUNT_ALERTS.diapers, so the switch reaches it", () => {
  const seen = new Set<string>();
  // Day 11: the 24-hour counts (above). Day 3, the last wet one 9 hours ago with bottles since: no pee in 8 hours.
  for (const k of kinds(baby(DAY11), fedNoDiapers)) seen.add(k);
  const day3 = [...bottles(40, 0.5, 2.5), wet(9), wet(14), dirty(14), wet(20)];
  for (const k of kinds(baby(50), day3)) seen.add(k);
  // 30 hours old: two diapers since birth, neither wet.
  const day2 = [...bottles(28, 1, 2.5), dirty(20), dirty(5)];
  for (const k of kinds(baby(30), day2)) seen.add(k);
  // Day 3 with wet diapers but no poop in the last 24 hours.
  const noStool = [...bottles(45, 1, 2.5), wet(2), wet(6), wet(11), wet(16), wet(22), dirty(30)];
  for (const k of kinds(baby(50), noStool)) seen.add(k);
  eq([...seen].filter(counted).sort(), [...diaperKinds].sort(), "the kinds made");
  // And the switch hides every count in those scenarios, leaving the checkup's note.
  const off = { diaper_alerts: false };
  eq([...kinds(baby(50, off), day3), ...kinds(baby(30, off), day2), ...kinds(baby(50, off), noStool)], ["first-checkup", "first-checkup", "first-checkup"]);
});

check("summarize: no pee in 8 hours is a call-now warning, and diaper warnings off hide it too", () => {
  const day3 = [...bottles(40, 0.5, 2.5), wet(9), wet(14), dirty(14), wet(20)];
  const a = alertsFor(baby(50), day3).filter((x) => counted(alertKind(x.id)));
  eq(a.map((x) => [alertKind(x.id), x.tier]), [["no-pee-8h", "now"]]);
  eq(kinds(baby(50, { diaper_alerts: false }), day3), ["first-checkup"]);
});

check("summarize: a poop color is a reading, not a count: red in the diaper stays with both switches off", () => {
  const red = dirty(2, "red");
  const entries = [...fedNoDiapers, red];
  eq(ids(baby(DAY11), entries), [`red-${red.id}`, "low-wet:11", "low-stool:11"]);
  eq(ids(baby(DAY11, { diaper_alerts: false, feed_alerts: false }), entries), [`red-${red.id}`]);
});

check("summarize: a fever is a reading: it stays with both switches off", () => {
  const fever = entry("temp", 1, { temp_c: 38.6, method: "rectal" });
  const a = alertsFor(baby(DAY11, { diaper_alerts: false, feed_alerts: false }), [...fedNoDiapers, fever]);
  eq(a.map((x) => x.id), [`temp-${fever.id}`]);
  ok(a[0].tier === "now" || a[0].tier === "emergency", `a fever at 10 days old calls now (${a[0].tier})`);
});

check("summarize: Not all logged's mark quiets its own episode only (that day of life), never the other count", () => {
  const at = new Date(NOW).toISOString();
  eq(ids(baby(DAY11, { acks: { "low-wet:11": at } }), fedNoDiapers), ["low-stool:11"]);
  // Yesterday's mark (Day 10) doesn't quiet today's.
  eq(ids(baby(DAY11, { acks: { "low-wet:10": at, "low-stool:10": at } }), fedNoDiapers), ["low-wet:11", "low-stool:11"]);
});

check("summarize: with Warnings & reminders off, no switch brings a count back", () => {
  eq(ids(baby(DAY11, { show_alerts: false, diaper_alerts: true, feed_alerts: true }), fedNoDiapers), []);
  eq(ids({ ...baby(DAY11), settings: { diaper_alerts: true } }, fedNoDiapers), [], "never switched on");
});

// ── the feed reminders ───────────────────────────────────────────────────

check("summarize: 5 hours since the last feed at 10 days old is the firmer feed reminder; feed reminders off hide it", () => {
  const diapers = [wet(1), wet(4), dirty(4), wet(7), wet(10), dirty(10), wet(13), wet(16), dirty(19), wet(22)];
  const entries = [...bottles(30, 5, 2.5), ...diapers];
  const shown = alertsFor(baby(DAY11), entries);
  eq(shown.map((x) => [alertKind(x.id), x.tier]), [["feed-gap", "nudge"]]);
  ok(shown[0].id.endsWith(":firm"), `the firmer one (${shown[0].id})`);
  eq(ids(baby(DAY11, { feed_alerts: false }), entries), []);
  // The other switch leaves it.
  eq(kinds(baby(DAY11, { diaper_alerts: false }), entries), ["feed-gap"]);
});

check("summarize: fewer than 8 feeds in 24 hours is a reminder; feed reminders off hide it, diaper warnings stay", () => {
  const entries = bottles(30, 1, 4);
  eq(kinds(baby(DAY11), entries), ["low-wet", "low-stool", "few-feeds"]);
  eq(kinds(baby(DAY11, { feed_alerts: false }), entries), ["low-wet", "low-stool"]);
  ok(kinds(baby(DAY11), entries).filter((k) => feedKinds.includes(k)).length === 1, "one feed reminder");
});

check("alertSwitches: on unless saved as false", () => {
  eq(alertSwitches(baby(DAY11)), { feeds: true, diapers: true });
  eq(alertSwitches(baby(DAY11, { feed_alerts: false })), { feeds: false, diapers: true });
  eq(alertSwitches(baby(DAY11, { diaper_alerts: false })), { feeds: true, diapers: false });
  eq(alertSwitches(baby(DAY11, { diaper_alerts: "no" })), { feeds: true, diapers: true }, "only false turns one off");
});

// ── where they're saved ──────────────────────────────────────────────────

check("checkLogSwitches: the two switches take true, false or null, and nothing else", () => {
  for (const key of ["feed_alerts", "diaper_alerts"]) {
    for (const value of [true, false, null]) checkLogSwitches({ [key]: value });
    throws(() => checkLogSwitches({ [key]: "off" }), `${key}: "off"`);
    throws(() => checkLogSwitches({ [key]: 0 }), `${key}: 0`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

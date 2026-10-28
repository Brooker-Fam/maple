import assert from "node:assert/strict";
import { careNutritionSummary } from "../src/lib/maple/care-nutrition";
import type { CareEntry, CareNutritionEntry, Entry, EntryOf, Segment } from "../src/lib/maple/types";

let passed = 0;
let failed = 0;
const TZ = "America/New_York";
const now = new Date("2026-10-20T16:00:00Z");
let id = 1;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function food(at: string, meal: "meal" | "snack" = "meal"): CareNutritionEntry {
  return {
    id: id++, kind: "food", med_id: null, at, data: { description: "Example sandwich", meal },
    note: null, private: false, created_by: "synthetic", updated_by: null, source: "web", created_at: at, updated_at: at,
  };
}

function drink(at: string, amount_ml?: number | null): CareNutritionEntry {
  return {
    ...food(at), kind: "drink", data: { name: "Example water", ...(amount_ml === undefined ? {} : { amount_ml }) },
  };
}

function feed(start: string, end: string | null, options: { active?: boolean; bottle?: boolean; segments?: Segment[] } = {}): EntryOf<"feed"> {
  return {
    id: id++, kind: "feed", started_at: start, ended_at: options.active ? null : end, active: options.active ?? end === null,
    data: options.bottle ? { method: "bottle", amount_ml: 60 } : {
      method: "breast", segments: options.segments ?? [{ side: "L", start, end }],
    },
    note: null, created_by: "synthetic", updated_by: null, source: "web", created_at: start, updated_at: start,
  };
}

function summary(entries: CareEntry[] = [], babyEntries: Entry[] = [], options: { now?: Date; tz?: string; feeding?: "yes" | "no" | null } = {}) {
  return careNutritionSummary(entries, babyEntries, { now, tz: TZ, ...options });
}

function general(s: ReturnType<typeof summary>) {
  assert.equal(s.suggestion.title, "Food and drink, at your pace");
  assert.match(s.suggestion.body, /variety/i);
  assert.match(s.suggestion.sourceUrl, /^https:\/\/www\.nhs\.uk\/live-well\//);
}

check("today follows the family timezone across UTC midnight and excludes future entries", () => {
  const earlier = drink("2026-10-20T23:55:00Z", 250);
  const later = food("2026-10-21T01:00:00Z");
  const s = summary([food("2026-10-20T03:59:59Z"), earlier, later, drink("2026-10-21T02:01:00Z", 500)], [], {
    now: new Date("2026-10-21T02:00:00Z"),
  });
  assert.deepEqual(s.dayEntries.map((entry) => entry.id), [later.id, earlier.id]);
  assert.equal(s.foodCount, 1);
  assert.equal(s.fluidMl, 250);
});

check("the local day resets at midnight and retains an ongoing feed from yesterday", () => {
  const s = summary([food("2026-10-21T03:59:00Z"), drink("2026-10-21T04:00:00Z", 200)], [
    feed("2026-10-21T03:55:00Z", null),
  ], { now: new Date("2026-10-21T04:05:00Z") });
  assert.equal(s.foodCount, 0);
  assert.equal(s.drinkCount, 1);
  assert.equal(s.nursingLine, "Nursing timer running");
});

check("both occurrences of the repeated daylight-saving hour belong to today", () => {
  const s = summary([drink("2026-11-01T05:30:00Z", 200), drink("2026-11-01T06:30:00Z", 300), food("2026-11-01T03:59:00Z")], [], {
    now: new Date("2026-11-01T07:00:00Z"),
  });
  assert.equal(s.drinkCount, 2);
  assert.equal(s.fluidMl, 500);
  assert.equal(s.foodCount, 0);
});

check("an eastern family timezone includes its own midnight", () => {
  const s = summary([food("2026-10-20T14:59:59Z"), food("2026-10-20T15:00:00Z"), drink("2026-10-20T15:10:00Z", 200)], [], { tz: "Asia/Tokyo" });
  assert.equal(s.foodCount, 1);
  assert.equal(s.fluidMl, 200);
});

check("recorded drink volumes remain separate from drinks with unknown volumes", () => {
  const at = "2026-10-20T15:00:00Z";
  const s = summary([drink(at, 250), drink(at, 350), drink(at), drink(at, null), drink(at, 0), drink(at, -10), drink(at, NaN), drink(at, Infinity)]);
  assert.equal(s.drinkCount, 8);
  assert.equal(s.fluidMl, 600);
  assert.equal(s.unmeasuredDrinks, 6);
});

check("food and snacks count as food while other maternal entries stay out", () => {
  const at = "2026-10-20T15:00:00Z";
  const temp: CareEntry = { ...food(at), kind: "temp", data: { temp_c: 37 } };
  const s = summary([food(at), food(at, "snack"), temp]);
  assert.equal(s.foodCount, 2);
  assert.equal(s.dayEntries.length, 2);
});

check("an empty log offers support without claiming food or fluid was missed", () => {
  const s = summary();
  general(s);
  assert.equal(s.nursingLine, null);
  assert.doesNotMatch(s.suggestion.body, /haven.t|you need|not eaten|not drunk|dehydrat|low supply|behind|overdue/i);
});

check("a fresh open nursing segment gets a drink-within-reach suggestion", () => {
  const s = summary([], [feed("2026-10-20T15:50:00Z", null)]);
  assert.equal(s.nursingLine, "Nursing timer running");
  assert.equal(s.suggestion.title, "Keep a drink within reach");
  assert.match(s.suggestion.sourceUrl, /breastfeeding/);
});

check("a logged drink changes the suggestion to an optional easy snack", () => {
  const s = summary([drink("2026-10-20T15:55:00Z", 250)], [feed("2026-10-20T15:50:00Z", null)]);
  assert.equal(s.suggestion.title, "Something easy to eat");
  assert.match(s.suggestion.body, /if you.re hungry/i);
});

check("food and drink logged during nursing get a gentle planning suggestion", () => {
  const s = summary([food("2026-10-20T15:40:00Z"), drink("2026-10-20T15:55:00Z", 250)], [feed("2026-10-20T15:50:00Z", null)]);
  assert.equal(s.suggestion.title, "Make the next feed comfortable");
  assert.doesNotMatch(s.suggestion.body, /enough|goal|target|calori|ounces|\bml\b/i);
});

check("a paused timer is not described as active nursing", () => {
  const s = summary([], [feed("2026-10-20T15:30:00Z", "2026-10-20T15:50:00Z", { active: true })]);
  assert.equal(s.nursingLine, "Nursing timer paused");
  assert.equal(s.suggestion.title, "A moment for you");
});

check("an old paused timer asks for checking and uses general guidance", () => {
  const s = summary([], [feed("2026-10-20T12:00:00Z", "2026-10-20T12:20:00Z", { active: true })]);
  assert.equal(s.nursingLine, "Nursing timer needs checking");
  general(s);
});

check("an untouched old open timer is not treated as nursing now", () => {
  const s = summary([], [feed("2026-10-20T12:00:00Z", null)]);
  assert.equal(s.nursingLine, "Nursing timer needs checking");
  general(s);
});

check("an active bottle never produces a nursing suggestion", () => {
  const s = summary([], [feed("2026-10-20T15:50:00Z", null, { bottle: true })]);
  assert.equal(s.nursingLine, null);
  general(s);
});

check("explicitly not nursing suppresses nursing context even with a running timer", () => {
  const s = summary([drink("2026-10-20T15:55:00Z", 250)], [feed("2026-10-20T15:50:00Z", null)], { feeding: "no" });
  assert.equal(s.nursingLine, null);
  general(s);
  assert.doesNotMatch(s.suggestion.body, /nurs|breast|feed/i);
});

check("cluster context follows the existing three-run rule", () => {
  const s = summary([], [
    feed("2026-10-20T14:50:00Z", "2026-10-20T15:00:00Z"),
    feed("2026-10-20T15:15:00Z", "2026-10-20T15:25:00Z"),
    feed("2026-10-20T15:40:00Z", "2026-10-20T15:50:00Z"),
  ]);
  assert.equal(s.nursingLine, "3 nursing feeds close together");
  assert.equal(s.suggestion.title, "Keep food and drink nearby");
});

check("done and restart gaps under ten minutes do not invent a cluster", () => {
  const s = summary([], [
    feed("2026-10-20T15:10:00Z", "2026-10-20T15:20:00Z"),
    feed("2026-10-20T15:25:00Z", "2026-10-20T15:35:00Z"),
    feed("2026-10-20T15:40:00Z", "2026-10-20T15:50:00Z"),
  ]);
  assert.match(s.nursingLine ?? "", /^Last nursing logged at /);
  assert.equal(s.suggestion.title, "A moment for you");
});

check("future feed starts and future segments are ignored", () => {
  const s = summary([], [
    feed("2026-10-20T17:00:00Z", null),
    feed("2026-10-20T15:30:00Z", null, { segments: [{ side: "L", start: "2026-10-20T17:00:00Z", end: null }] }),
    feed("2026-10-20T15:00:00Z", "2026-10-20T17:00:00Z"),
  ]);
  assert.equal(s.nursingLine, null);
  general(s);
});

check("sufficient nursing history describes the usual gap as an estimate without a due time", () => {
  const feeds = ["2026-10-19T12:00:00Z", "2026-10-20T06:00:00Z", "2026-10-20T08:00:00Z", "2026-10-20T10:00:00Z", "2026-10-20T12:00:00Z"]
    .map((start) => feed(start, new Date(Date.parse(start) + 15 * 60_000).toISOString()));
  const s = summary([], feeds);
  assert.match(s.nursingLine ?? "", /usual gap about 2h.*estimate from logged feeds/i);
  assert.doesNotMatch(`${s.nursingLine} ${s.suggestion.body}`, /due|overdue|should feed|calori|\bml\b/i);
  assert.equal(s.suggestion.title, "Make the next feed comfortable");
});

check("old nursing history does not imply current nursing", () => {
  const s = summary([], [feed("2026-10-17T15:00:00Z", "2026-10-17T15:20:00Z")]);
  assert.equal(s.nursingLine, null);
  general(s);
});

check("a future tap cannot make a stale nursing timer look fresh", () => {
  const timer = feed("2026-10-20T12:00:00Z", null);
  Object.assign(timer.data, { last_tap: { kind: "resume", side: "L", at: "2026-10-20T17:00:00Z" } });
  const s = summary([], [timer]);
  assert.notEqual(s.nursingLine, "Nursing timer running");
  general(s);
});

check("a running timer without recorded nursing parts does not claim a pause", () => {
  const s = summary([], [feed("2026-10-20T15:50:00Z", null, { segments: [] })]);
  assert.equal(s.nursingLine, "Nursing timer needs checking");
  general(s);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

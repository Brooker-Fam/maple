/**
 * Assertions for the feeding plan (src/lib/maple/feeding-plan.ts): reading
 * and checking a plan as the sheet or the chat sends it, keeping feed ids
 * across revisions, refusing a stale edit, the words every surface shares,
 * and the plan read against a log (which feed is underway or next, when it's
 * due, which steps were logged, what a finished feed left unlogged, the
 * night's pump before its bottle, a late top-up that names its feed).
 *
 *   npx tsx scripts/maple-feeding-plan-check.ts   (or pnpm check:maple-feeding-plan)
 *
 * The plans here are invented examples, not any family's. One PASS/FAIL line
 * per case, exit 1 on any failure. Times are wall clock in America/New_York.
 */
import { countedFeeds, lastFedAnchor, nursingRuns, sameFeedBottleIds, topUpRunFor, TOP_UP_LINK_MS } from "../src/lib/maple/feed";
import {
  amountText,
  checkFeedingPlan,
  clockText,
  clockWords,
  dueFromText,
  dueStatus,
  dueText,
  everyText,
  feedingPlanOf,
  feedPlanNow,
  feedText,
  inNight,
  parseFeedingPlan,
  planLines,
  PlanConflict,
  PlanError,
  stepText,
  type FeedingPlan,
  type PlanFeed,
} from "../src/lib/maple/feeding-plan";
import { localParts, zonedTimeToUtc } from "../src/lib/maple/time";
import type { Entry, EntryOf, FeedData, Segment, Side } from "../src/lib/maple/types";
import { cleanData } from "../src/lib/maple/validate";

const TZ = "America/New_York";
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
const plain = (v: unknown): unknown => (typeof v === "string" ? v.replace(/[  ]/g, " ") : Array.isArray(v) ? v.map(plain) : v);
function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(plain(actual));
  const e = JSON.stringify(plain(expected));
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}
function throws<E extends Error>(fn: () => unknown, kind: new (...a: never[]) => E, match?: RegExp): E {
  try {
    fn();
  } catch (e) {
    if (e instanceof kind && (!match || match.test(e.message))) return e;
    throw new Error(`expected ${kind.name}${match ? ` ${match}` : ""}, got ${e instanceof Error ? `${e.constructor.name} "${e.message}"` : String(e)}`);
  }
  throw new Error(`expected ${kind.name}, nothing thrown`);
}

// ── fixtures ─────────────────────────────────────────────────────────────

/** "16:05" on the test day (Tue Mar 10, 2026), or "+1 02:30" / "+1d02:30" the day after → ISO. */
function T(hms: string): string {
  const m = /^(?:([+-]\d+)(?:\s+|d))?(\d{1,2}):(\d{2})$/.exec(hms.trim());
  if (!m) throw new Error(`bad time ${hms}`);
  const day = 10 + Number(m[1] ?? 0);
  return zonedTimeToUtc(2026, 3, day, Number(m[2]), Number(m[3]), TZ).toISOString();
}
const D = (hms: string) => new Date(T(hms));
const ms = (hms: string) => Date.parse(T(hms));
const clock = (t: number | string) => {
  const p = localParts(typeof t === "string" ? Date.parse(t) : t, TZ);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

let nid = 1;
const base = (kind: Entry["kind"], start: string, end: string | null, active: boolean) => ({
  id: nid++,
  kind,
  started_at: start,
  ended_at: end,
  active,
  note: null,
  created_by: null,
  updated_by: null,
  source: "web" as const,
  created_at: start,
  updated_at: start,
});

/** Nursing: "L 16:00-16:10, R 16:10-16:20" (an empty end is a running timer). */
function nurse(spec: string, extra: Partial<FeedData> = {}): EntryOf<"feed"> {
  const segments: Segment[] = spec.split(",").map((x) => {
    const [side, r] = x.trim().split(/\s+/);
    const [a, b] = r.split("-");
    return { side: side as Side, start: T(a), end: b ? T(b) : null };
  });
  const last = segments[segments.length - 1];
  const active = last.end === null;
  return { ...base("feed", segments[0].start, active ? null : last.end, active), kind: "feed", data: { method: "breast", segments, ...extra } };
}
/** A bottle at a time: ml, how, milk, and the plan's tag or a late top-up's feed. */
function bottle(at: string, ml: number, extra: Partial<FeedData> = {}): EntryOf<"feed"> {
  return { ...base("feed", T(at), null, false), kind: "feed", data: { method: "bottle", amount_ml: ml, ...extra } };
}
/** A pump: "21:50-22:00" ("21:50-" running). */
function pump(spec: string): EntryOf<"pump"> {
  const [a, b] = spec.split("-");
  return { ...base("pump", T(a), b ? T(b) : null, !b), kind: "pump", data: {} };
}

/**
 * An invented plan: by day, every 2.5 to 3.5 hours, taking turns between
 * "Nurse + SNS" (12–18 min, 20 ml of formula in the SNS, then pump 15) and
 * "Nurse, top up" (8–12 min each side, then a paced top-up of 25–35 ml);
 * at night (11 PM–5 AM), every 3 hours, waking: "Pump + bottle".
 */
const INPUT = {
  from: "Feeding clinic",
  check_in: "2026-03-13",
  unit: "ml",
  day: { every: { min: 150, max: 210 } },
  night: { from: "11 PM", to: "5:00", every: 180, wake: true, feed: "Pump + bottle" },
  feeds: [
    { name: "Nurse + SNS", steps: [{ do: "nurse", minutes: [12, 18], supplement: { via: "sns", ml: 20, milk: "formula" } }, { do: "pump", minutes: 15 }] },
    { name: "Nurse, top up", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }] },
    { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
  ],
};
const NOW0 = D("09:00");
const PLAN = parseFeedingPlan(INPUT, null, NOW0);
const [SNS, TOPUP, NIGHT] = PLAN.feeds;
const TARGET = { min: 50, max: 70 };

// ── reading a plan ───────────────────────────────────────────────────────

check("parse: ranges, clocks, names and order are normalized; new feeds get ids from the revision", () => {
  eq(PLAN.feeds.map((f) => f.id), ["p1f1", "p1f2", "p1f3"]);
  eq(PLAN.order, ["p1f1", "p1f2"], "night's feed is left out of the day's turns");
  eq(PLAN.night, { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: "p1f3" });
  eq(SNS.steps[0], { do: "nurse", minutes: { min: 12, max: 18 }, supplement: { via: "sns", ml: { min: 20, max: 20 }, milk: "formula" } });
  eq(TOPUP.steps[1], { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced" });
  eq([PLAN.rev, PLAN.v, PLAN.unit, PLAN.from, PLAN.check_in], [1, 1, "ml", "Feeding clinic", "2026-03-13"]);
  eq(PLAN.updated_at, NOW0.toISOString());
});

check("parse: clock text in either form", () => {
  eq(["22:00", "9 PM", "10:30pm", "6 am", "12 AM", "12:15 PM", "0:05"].map((s) => clockText(s, "t")), ["22:00", "21:00", "22:30", "06:00", "00:00", "12:15", "00:05"]);
  for (const bad of ["25:00", "13 PM", "noon", "7:60"]) throws(() => clockText(bad, "t"), PlanError);
});

check("parse: ounces convert to ml and the plan keeps its unit", () => {
  const p = parseFeedingPlan({ amounts_in: "oz", feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: [1, 1.5] }] }] }, null, NOW0);
  eq([p.unit, p.feeds[0].steps[0]], ["oz", { do: "bottle", ml: { min: 29.6, max: 44.4 } }]);
  eq(stepText(p.feeds[0].steps[0], p, null), "Bottle 1–1.5 oz");
});

check("parse: refuses what can't be a plan, saying what to change", () => {
  const f = (extra: Record<string, unknown>) => ({ feeds: [{ name: "A", steps: [{ do: "pump", minutes: 10 }] }], ...extra });
  throws(() => parseFeedingPlan({ feeds: [] }, null, NOW0), PlanError, /at least one feed/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [] }] }, null, NOW0), PlanError, /at least one step/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "note", text: "x" }] }] }, null, NOW0), PlanError, /besides notes/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "nurse" }, { do: "nurse" }] }] }, null, NOW0), PlanError, /nurses once/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "pump", minutes: 500 }] }] }, null, NOW0), PlanError, /between 1 and 120/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "nurse", supplement: { via: "syringe" } }] }] }, null, NOW0), PlanError, /how much milk/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "dance" }] }] }, null, NOW0), PlanError, /nurse, pump, bottle or note/);
  throws(() => parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "pump" }] }, { name: " a ", steps: [{ do: "pump" }] }] }, null, NOW0), PlanError, /same name/);
  throws(() => parseFeedingPlan(f({ order: ["Nope"] }), null, NOW0), PlanError, /isn't in the plan/);
  throws(() => parseFeedingPlan(f({ night: { from: "22:00", to: "10 PM" } }), null, NOW0), PlanError, /different times/);
  throws(() => parseFeedingPlan(f({ day: { every: 10 } }), null, NOW0), PlanError, /between 30 and 480/);
  throws(() => parseFeedingPlan(f({ check_in: "Monday" }), null, NOW0), PlanError, /YYYY-MM-DD/);
  throws(() => parseFeedingPlan(f({ notes: "x".repeat(301) }), null, NOW0), PlanError, /too long/);
});

check("parse: an edit keeps each feed's id by id or by name; a new feed gets the new revision's", () => {
  const edit = parseFeedingPlan(
    {
      ...INPUT,
      feeds: [
        { id: SNS.id, name: "Nurse + SNS (shield)", steps: INPUT.feeds[0].steps },
        { name: "nurse, TOP up", steps: INPUT.feeds[1].steps },
        { name: "Pump + bottle", steps: INPUT.feeds[2].steps },
        { name: "Paced bottle", steps: [{ do: "bottle", ml: 40, via: "paced" }] },
      ],
      order: [SNS.id, "Nurse, top up", "Paced bottle"],
    },
    PLAN,
    D("10:00")
  );
  eq(edit.feeds.map((f) => f.id), ["p1f1", "p1f2", "p1f3", "p2f1"]);
  eq([edit.rev, edit.order], [2, ["p1f1", "p1f2", "p2f1"]]);
});

check("checkFeedingPlan: a new revision; an edit from an older one is refused; null removes", () => {
  const first: Record<string, unknown> = { feeding_plan: { ...INPUT } };
  checkFeedingPlan(first, {}, NOW0);
  eq((first.feeding_plan as FeedingPlan).rev, 1);
  const saved = { feeding_plan: first.feeding_plan };
  const edit: Record<string, unknown> = { feeding_plan: { ...INPUT, base_rev: 1, notes: "Weigh on Friday" } };
  checkFeedingPlan(edit, saved, D("10:00"));
  eq([(edit.feeding_plan as FeedingPlan).rev, (edit.feeding_plan as FeedingPlan).notes], [2, "Weigh on Friday"]);
  const stale = throws(() => checkFeedingPlan({ feeding_plan: { ...INPUT, base_rev: 0 } }, { feeding_plan: edit.feeding_plan }, NOW0), PlanConflict);
  eq(stale.current?.rev, 2, "the conflict carries the plan saved now");
  throws(() => checkFeedingPlan({ feeding_plan: { ...INPUT } }, saved, NOW0), PlanConflict);
  throws(() => checkFeedingPlan({ feeding_plan: { ...INPUT, base_rev: 3 } }, {}, NOW0), PlanConflict);
  const gone: Record<string, unknown> = { feeding_plan: null };
  checkFeedingPlan(gone, saved, NOW0);
  eq(gone, { feeding_plan: null, feeding_plan_last_rev: 1 }, "removing it keeps its revision");
  throws(() => checkFeedingPlan({ feeding_plan: null, feeding_plan_base_rev: 7 }, saved, NOW0), PlanConflict);
  const untouched: Record<string, unknown> = { feed_target_ml: { min: 50, max: 70 } };
  checkFeedingPlan(untouched, saved, NOW0);
  eq(untouched, { feed_target_ml: { min: 50, max: 70 } });
  // A feed that only pumps can't be saved (a pump isn't a feed, so it would be next for good); it goes in the notes.
  const pumpOnly = { ...INPUT, base_rev: 2, feeds: [...INPUT.feeds, { name: "Power pump", steps: [{ do: "pump", minutes: 60 }] }] };
  throws(() => checkFeedingPlan({ feeding_plan: pumpOnly }, { feeding_plan: edit.feeding_plan }, NOW0), PlanError, /^"Power pump" needs nursing or a bottle: a pump on its own goes in the plan's notes/);
  // One saved before still reads, and never comes up as the next feed or as one to do instead.
  const old = parseFeedingPlan({ ...pumpOnly, order: ["Power pump", "Nurse + SNS"] }, null, NOW0);
  const n = feedPlanNow(old, [], D("09:00"), { tz: TZ, target: TARGET });
  eq([n.focus.feed.name, n.others.map((f) => f.name)], ["Nurse + SNS", ["Nurse, top up", "Pump + bottle"]]);
});

check("feedingPlanOf: what's saved, read back as saved; null for nothing or something unreadable", () => {
  const read = feedingPlanOf({ feeding_plan: PLAN });
  eq(read, PLAN);
  eq(feedingPlanOf({}), null);
  eq(feedingPlanOf({ feeding_plan: { v: 2, feeds: [] } }), null);
  eq(feedingPlanOf({ feeding_plan: { ...PLAN, feeds: [{ name: "A", steps: [{ do: "pump", minutes: 999 }] }] } }), null);
  eq(feedingPlanOf(null), null);
});

// ── words ────────────────────────────────────────────────────────────────

check("words: amounts in the plan's unit, minutes, intervals and clock times", () => {
  eq([amountText({ min: 25, max: 25 }, "ml"), amountText({ min: 25, max: 35 }, "ml"), amountText({ min: 29.6, max: 44.4 }, "oz")], ["25 ml", "25–35 ml", "1–1.5 oz"]);
  eq([everyText({ min: 120, max: 180 }), everyText({ min: 180, max: 180 }), everyText({ min: 90, max: 90 }), everyText({ min: 60, max: 60 }), everyText({ min: 135, max: 135 })], [
    "every 2–3 hours",
    "every 3 hours",
    "every 1.5 hours",
    "every 1 hour",
    "every 2h 15m",
  ]);
  eq(["22:00", "05:30", "00:00", "12:00"].map(clockWords), ["10 PM", "5:30 AM", "12 AM", "12 PM"]);
});

check("words: each step, and a feed's steps in one line", () => {
  eq(stepText(SNS.steps[0], PLAN, TARGET), "Nurse 12–18 min, 20 ml of formula in the SNS");
  eq(feedText(SNS, PLAN, TARGET), "Nurse 12–18 min, 20 ml of formula in the SNS; then pump 15 min");
  eq(feedText(TOPUP, PLAN, TARGET), "Nurse 8–12 min each side; then top up 25–35 ml, formula or breast milk, paced bottle");
  eq(feedText(NIGHT, PLAN, TARGET), "Pump 20 min; then bottle up to 50–70 ml, pumped milk first, then formula to finish. Burp halfway");
  eq(stepText(NIGHT.steps[1], PLAN, null), "Bottle up to the target, pumped milk first, then formula to finish");
  eq(stepText({ do: "nurse", shield: true, supplement: { via: "syringe", ml: { min: 15, max: 15 } } }, PLAN, null), "Nurse with the nipple shield, 15 ml in the syringe");
});

check("words: the read-back holds every value, and nothing else", () => {
  eq(planLines(PLAN, TARGET), [
    "From: Feeding clinic · check in Fri, Mar 13",
    "Target: 50–70 ml a feed",
    "Day: every 2.5–3.5 hours, taking turns: Nurse + SNS, then Nurse, top up",
    "• Nurse + SNS: Nurse 12–18 min, 20 ml of formula in the SNS; then pump 15 min",
    "• Nurse, top up: Nurse 8–12 min each side; then top up 25–35 ml, formula or breast milk, paced bottle",
    "• Pump + bottle: Pump 20 min; then bottle up to 50–70 ml, pumped milk first, then formula to finish. Burp halfway",
    "Night (11 PM–5 AM): every 3 hours, waking her: Pump + bottle",
  ]);
});

// ── the plan against the log ─────────────────────────────────────────────

const now = (plan: FeedingPlan, entries: Entry[], at: string, choose?: string) => feedPlanNow(plan, entries, D(at), { tz: TZ, target: TARGET, choose });
const states = (v: { steps: { status: string }[] }) => v.steps.map((s) => s.status);

check("no feeds yet: the order's first feed, nothing due", () => {
  const n = now(PLAN, [], "09:00");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, n.due, n.missed, n.others.map((f) => f.id)], ["upcoming", SNS.id, "order", null, null, [TOPUP.id, NIGHT.id]]);
  eq(states(n.focus), ["todo", "todo"]);
});

check("taking turns: a feed started from the plan names itself; the next is the other one, due 2.5–3.5 hours from its start", () => {
  const log = [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:15", 20, { via: "sns", milk: "formula" }), pump("08:20-08:35")];
  const n = now(PLAN, log, "09:30");
  eq([n.focus.state, n.focus.feed.id, n.focus.why], ["upcoming", TOPUP.id, "order"]);
  eq([clock(n.due!.from), clock(n.due!.to), n.due!.status, n.due!.for, n.due!.night, n.due!.wake], ["10:30", "11:30", "early", "focus", false, false]);
  eq(dueText(n.due!, D("09:30"), TZ), "Next feed 10:30 AM–11:30 AM, in 1h 00m");
  eq(dueText(n.due!, D("11:00"), TZ), "Due now, by 11:30 AM");
  eq(dueText(n.due!, D("12:10"), TZ), "Due since 11:30 AM: 4h 10m since the last feed");
});

check("underway: nursing on, then the rest of the steps, then done and on to the next", () => {
  const n1 = nurse("L 10:40-", { plan: TOPUP.id });
  let n = now(PLAN, [n1], "10:50");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, states(n.focus), n.focus.live], ["underway", TOPUP.id, "tagged", ["running", "todo"], true]);
  eq([n.due!.for, clock(n.due!.from), n.after?.feed.id], ["after", "13:10", SNS.id], "the next one counts from this one's start");
  // Done nursing: the top-up is still to give, so it stays underway.
  const n2 = nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id });
  n = now(PLAN, [n2], "11:05");
  eq([n.focus.state, states(n.focus), n.focus.steps[0].minutes], ["underway", ["done", "todo"], 20]);
  // The top-up: done, and the card moves on.
  n = now(PLAN, [n2, bottle("11:08", 30, { via: "paced", milk: "formula" })], "11:10");
  eq([n.focus.state, n.focus.feed.id, n.missed], ["upcoming", SNS.id, null]);
});

check("unlogged steps: a feed left without its top-up is mentioned for a while, and stops being underway", () => {
  const log = [nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id })];
  const n = now(PLAN, log, "12:00");
  eq([n.focus.state, n.focus.feed.id, n.missed?.view.feed.id, n.missed?.steps.map((s) => s.step.do)], ["upcoming", SNS.id, TOPUP.id, ["bottle"]]);
  eq(now(PLAN, log, "14:10").missed, null, "three hours on, it's dropped");
});

check("milk at the breast: an SNS feed done nursing without its milk logged isn't done", () => {
  const log = [nurse("L 08:00-08:15", { plan: SNS.id }), pump("08:20-08:35")];
  const n = now(PLAN, log, "08:40");
  eq([n.focus.state, n.focus.steps[0].status, n.focus.steps[0].milkMissing, n.focus.done], ["underway", "done", true, false]);
  const withMilk = now(PLAN, [...log, bottle("08:14", 20, { via: "sns", milk: "formula" })], "08:40");
  eq([withMilk.focus.state, withMilk.focus.feed.id], ["upcoming", TOPUP.id]);
});

check("feeds not started from the plan: read by what was logged with them, else the order's turn", () => {
  // SNS milk logged: the SNS feed, though it was the top-up feed's turn. Its pump wasn't logged.
  const a = [nurse("L 06:00-06:20", { plan: SNS.id }), nurse("L 08:40-08:55"), bottle("08:50", 20, { via: "sns" })];
  let n = now(PLAN, a, "09:30");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, states(n.focus)], ["underway", SNS.id, "matched", ["done", "todo"]], "still underway: its pump");
  n = now(PLAN, a, "09:45");
  eq([n.focus.feed.id, n.missed?.steps.map((s) => s.step.do)], [TOPUP.id, ["pump"]], "after an SNS feed, the top-up feed");
  // A paced top-up after it: the top-up feed.
  const b = [nurse("L 06:00-06:20", { plan: TOPUP.id }), nurse("L 08:40-08:55"), bottle("09:05", 30, { via: "paced" })];
  n = now(PLAN, b, "09:30");
  eq(n.focus.feed.id, SNS.id, "after a top-up feed, the SNS feed");
  // Nothing logged with it: it took its turn.
  const c = [nurse("L 06:00-06:20", { plan: SNS.id }), nurse("L 08:40-08:55")];
  n = now(PLAN, c, "10:30");
  eq([n.focus.feed.id, n.missed?.view.feed.id, n.missed?.view.why], [SNS.id, TOPUP.id, "order"]);
  // A shield on the nursing points to a feed whose nursing has one.
  const shield = parseFeedingPlan(
    { feeds: [{ name: "Shield", steps: [{ do: "nurse", shield: true }] }, { name: "Bare", steps: [{ do: "nurse" }] }], order: ["Shield", "Bare"] },
    null,
    NOW0
  );
  const s = feedPlanNow(shield, [nurse("L 06:00-06:20", { plan: shield.feeds[1].id }), nurse("L 08:40-08:55", { shield: true })], D("09:30"), { tz: TZ });
  eq(s.focus.feed.name, "Bare");
});

check("this phone's pick: Do the other one instead", () => {
  const n = now(PLAN, [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:15", 20, { via: "sns" }), pump("08:20-08:35")], "10:30", SNS.id);
  eq([n.focus.feed.id, n.focus.why, n.others.map((f) => f.id)], [SNS.id, "chosen", [TOPUP.id, NIGHT.id]]);
});

check("night: due counts from the last feed by the night's interval, waking her, and it's the night's feed", () => {
  const log = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05")];
  const n = now(PLAN, log, "21:30");
  // 20:30 + 2.5 h = 23:00, in the night: every 3 hours from 20:30.
  eq([n.focus.feed.id, n.focus.why, n.focus.night, clock(n.due!.from), clock(n.due!.to), n.due!.wake, n.due!.night], [NIGHT.id, "night", true, "23:30", "23:30", true, true]);
  eq(dueText(n.due!, D("21:30"), TZ), "Wake her for it at 11:30 PM, in 2h 00m");
  eq(dueText(n.due!, D("23:30"), TZ), "Due now (11:30 PM)");
  eq(dueText(n.due!, D("23:30"), TZ, "him"), "Due now (11:30 PM)");
  eq(dueText(n.due!, D("21:30"), TZ, "him"), "Wake him for it at 11:30 PM, in 2h 00m");
});

check("night: the pump before the bottle begins the feed; the bottle after it finishes it, pumped milk then formula as one", () => {
  const evening = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05")];
  let n = now(PLAN, [...evening, pump("23:20-")], "23:30");
  eq([n.focus.state, n.focus.feed.id, states(n.focus)], ["underway", NIGHT.id, ["running", "todo", "info"]]);
  // Underway, so the due is the next one's (no late line while they pump on time): from when this one was due (11:30
  // PM; the pump began a little before), until the bottle is logged.
  eq([n.due!.for, n.due!.status, clock(n.due!.base), clock(n.due!.from), n.after?.feed.id, n.after?.night], ["after", "early", "23:30", "02:30", NIGHT.id, true]);
  eq(dueText(n.due!, D("23:30"), TZ), "Wake her for it at 2:30 AM, in 3h 00m");
  // Pumped on time or late: from the pump.
  n = now(PLAN, [...evening, pump("23:40-")], "23:45");
  eq([n.focus.state, n.due!.for, clock(n.due!.base), clock(n.due!.from)], ["underway", "after", "23:40", "02:40"]);
  // Too early for a pump to be the feed's: one at 21:40 (two hours before it's due) waits.
  n = now(PLAN, [...evening, pump("21:40-21:50")], "21:55");
  eq([n.focus.state], ["upcoming"]);
  // By day a pump between feeds doesn't begin a feed that doesn't pump first.
  const day = [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:14", 20, { via: "sns" }), pump("08:20-08:35"), pump("10:40-")];
  n = now(PLAN, day, "10:45");
  eq([n.focus.state, n.focus.feed.id, states(n.focus)], ["upcoming", TOPUP.id, ["todo", "todo"]]);
  const night = [...evening, pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk" }), bottle("+1 00:05", 15, { milk: "formula" })];
  n = now(PLAN, night, "+1 00:10");
  // The second bottle 20 minutes on is the same feed: the bottle step has both. Done, so the next is up: still night,
  // counted from the feed's first bottle, not the formula to finish.
  eq([n.focus.state, n.focus.feed.id, clock(n.due!.base), clock(n.due!.from)], ["upcoming", NIGHT.id, "23:45", "02:45"]);
  eq(dueFromText(n.due!, TZ), "after the 11:45 PM feed");
  const last = feedPlanNow(PLAN, night, D("+1 00:06"), { tz: TZ, target: TARGET });
  eq([last.focus.state, last.focus.feed.id], ["upcoming", NIGHT.id]);
});

check("night: she wouldn't take the bottle, so milk went in at the breast: the night feed is still fed", () => {
  const log = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05"), pump("23:20-23:45"), nurse("L 23:50-+1d00:20"), bottle("+1 00:00", 55, { via: "syringe", milk: "formula" })];
  const n = feedPlanNow(PLAN, log, D("+1 00:25"), { tz: TZ, target: TARGET });
  eq([n.focus.state, n.focus.feed.id, n.missed], ["upcoming", NIGHT.id, null]);
  const v = feedPlanNow(PLAN, log, D("+1 00:21"), { tz: TZ, target: TARGET });
  eq(v.focus.state, "upcoming", "the night feed's bottle step counts the milk given at the breast");
  // While she was on: the night's feed (not the SNS feed, though it looked like one), nursing besides its steps.
  const on = log.map((e) => (e.kind === "feed" && e.data.method === "breast" && e.started_at === T("23:50") ? nurse("L 23:50-", {}) : e));
  const u = feedPlanNow(PLAN, on, D("+1 00:10"), { tz: TZ, target: TARGET });
  eq([u.focus.state, u.focus.feed.id, u.focus.why, u.focus.extraNursing, states(u.focus), u.focus.steps[1].ml], ["underway", NIGHT.id, "night", true, ["done", "done", "info"], 55]);
});

check("the morning: day feeds take turns from the last day feed, not the night's", () => {
  const log = [
    nurse("L 18:00-18:15", { plan: SNS.id }),
    bottle("18:14", 20, { via: "sns" }),
    pump("18:20-18:35"),
    nurse("L 20:40-20:55", { plan: TOPUP.id }),
    bottle("21:00", 30, { via: "paced" }),
    pump("23:30-23:50"),
    bottle("23:55", 55, { milk: "breastmilk" }),
  ];
  // Night feeds are the night's; at 6 the order resumes after the 20:40 top-up feed.
  log.push(pump("+1d02:40-+1d03:00"), bottle("+1 03:00", 55, { milk: "breastmilk" }));
  const n = feedPlanNow(PLAN, log, D("+1 05:30"), { tz: TZ, target: TARGET });
  eq([n.focus.feed.id, n.focus.night, clock(n.due!.from)], [SNS.id, false, "05:30"]);
});

check("the morning: a night feed late enough that the night's 3 hours reach past 5 AM makes the next one the day's, from 5", () => {
  const evening = [nurse("L 20:40-20:55", { plan: TOPUP.id }), bottle("21:00", 30, { via: "paced" }), pump("23:30-23:50"), bottle("23:55", 55, { milk: "breastmilk" })];
  // 2:10 AM + 2.5 h is 4:40, still night, but the night's own 3 hours reach 5:10: the next feed is the day's.
  const late = [...evening, pump("+1d01:50-+1d02:05"), bottle("+1 02:10", 55, { milk: "breastmilk" })];
  const n = feedPlanNow(PLAN, late, D("+1 02:30"), { tz: TZ, target: TARGET });
  eq([n.focus.feed.id, n.focus.night, clock(n.due!.from), clock(n.due!.to), n.due!.wake, n.due!.night], [SNS.id, false, "05:00", "05:40", false, false]);
  eq(plain(dueText(n.due!, D("+1 02:30"), TZ)), "Next feed 5:00 AM–5:40 AM, in 2h 30m");
  // At 1:40 the night's 3 hours (4:40) are still in the night: the night's feed, waking her.
  const early = [...evening, pump("+1d01:20-+1d01:35"), bottle("+1 01:40", 55, { milk: "breastmilk" })];
  const m = feedPlanNow(PLAN, early, D("+1 02:00"), { tz: TZ, target: TARGET });
  eq([m.focus.feed.id, m.focus.night, clock(m.due!.from), m.due!.wake], [NIGHT.id, true, "04:40", true]);
  // Nothing logged since 19:40: the day's turn is due until the night begins; then it's the night's feed, by its 3 hours.
  const evening2 = [nurse("L 19:40-19:55", { plan: TOPUP.id }), bottle("20:00", 30, { via: "paced" })];
  const before = feedPlanNow(PLAN, evening2, D("22:59"), { tz: TZ, target: TARGET });
  eq([before.focus.feed.id, before.due!.night, before.due!.status, clock(before.due!.to)], [SNS.id, false, "due", "23:10"]);
  const after = feedPlanNow(PLAN, evening2, D("23:05"), { tz: TZ, target: TARGET });
  eq([after.focus.feed.id, after.due!.night, clock(after.due!.from), after.due!.wake, after.due!.status], [NIGHT.id, true, "22:40", true, "late"]);
});

check("a late top-up names its feed: it's that feed's, not a feed of its own, and Last fed stays put", () => {
  const n1 = nurse("L 21:00-21:10, R 21:10-21:20", { plan: TOPUP.id });
  const late = bottle("22:30", 30, { via: "paced", milk: "formula", top_up_of: n1.id });
  const runs = nursingRuns([n1, late], D("22:40"));
  eq([runs[0].topUps.map((b) => b.id), clock(lastFedAnchor([n1, late], D("22:40"))!.at)], [[late.id], "21:00"]);
  const n = feedPlanNow(PLAN, [n1, late], D("22:40"), { tz: TZ, target: TARGET });
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.from)], ["upcoming", NIGHT.id, null, "00:00"]);
  // Without the link, 70 minutes after the feed ended, it's a feed of its own.
  eq(topUpRunFor(runs, Date.parse(late.started_at), D("22:40")), null);
  // The link holds up to three hours after the feed ended, and not past the next feed's start.
  eq(TOP_UP_LINK_MS, 3 * 3_600_000);
  eq(topUpRunFor(runs, ms("+1 00:21"), D("+1 01:00"), n1.id), null, "over three hours");
  const next = nurse("L 22:00-22:10");
  eq(topUpRunFor(nursingRuns([n1, next], D("22:40")), ms("22:30"), D("22:40"), n1.id)?.start, ms("22:00"), "the feed she's on wins");
});

check("a late top-up from the dock (no link): the feed that wanted it takes it, within an hour and a half, and the next counts from that feed", () => {
  const bare = nurse("L 13:00-13:10, R 13:10-13:20", { plan: TOPUP.id });
  const late = bottle("14:10", 30, { via: "paced", milk: "formula" });
  const n = feedPlanNow(PLAN, [bare, late], D("14:20"), { tz: TZ, target: TARGET });
  // Its own feed by the log's rule (Last fed moves to it), but to the plan it's the feed's top-up: the step is done,
  // nothing is missed, and the next feed counts from the feed's start, as it does when the card's Log top-up links it.
  eq(clock(lastFedAnchor([bare, late], D("14:20"))!.at), "14:10");
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.base), clock(n.due!.from), clock(n.due!.to)], ["upcoming", SNS.id, null, "13:00", "15:30", "16:30"]);
  const linked = feedPlanNow(PLAN, [bare, { ...late, data: { ...late.data, plan: TOPUP.id, top_up_of: bare.id } }], D("14:20"), { tz: TZ, target: TARGET });
  eq([linked.due!.from, linked.due!.to, linked.missed], [n.due!.from, n.due!.to, null], "the dock and the card give the same window");
  // Over an hour and a half on, it's a feed of its own (by day, outside the plan), and after it nobody is asked for
  // the 1:00 PM feed's top-up.
  const later = bottle("14:55", 30, { via: "paced" });
  const m = feedPlanNow(PLAN, [bare, later], D("15:00"), { tz: TZ, target: TARGET });
  eq([m.focus.state, m.missed, clock(m.due!.base)], ["upcoming", null, "14:55"]);
});

check("a bottle by day that fits no day feed is outside the plan: no turn taken, nothing underway", () => {
  const log = [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:14", 20, { via: "sns" }), pump("08:20-08:35"), bottle("10:40", 60, { milk: "formula" })];
  const n = now(PLAN, log, "10:50");
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.base)], ["upcoming", TOPUP.id, null, "10:40"]);
});

// ── more of a feed: nursing again, a paused timer, parts logged late, the night's second bottle ──

check("nursing again soon after a feed is more of it: comfort nursing after the night's bottle starts nothing anew", () => {
  const night = [pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id }), bottle("23:55", 15, { milk: "formula", plan: NIGHT.id })];
  // She roots 25 minutes after the bottle and nurses, started from the dock (no plan feed on it).
  const comfort = nurse("L +1d00:20-+1d00:30");
  let n = now(PLAN, [...night, comfort], "+1 00:31");
  // Not a new night feed asking for its pump: that feed is done, and the next is due 3 hours from its first bottle.
  eq([n.focus.state, n.focus.feed.id, states(n.focus), clock(n.due!.base), clock(n.due!.from), n.missed], ["upcoming", NIGHT.id, ["todo", "todo", "info"], "23:45", "02:45", null]);
  eq(now(PLAN, [...night, comfort], "+1 01:30").missed, null, "and nothing reads as not logged");
  // While she's on: the night feed going on, its steps done, nursing besides them.
  n = now(PLAN, [...night, nurse("L +1d00:20-")], "+1 00:25");
  eq([n.focus.state, n.focus.feed.id, n.focus.extraNursing, states(n.focus), n.due!.for, clock(n.due!.from)], ["underway", NIGHT.id, true, ["done", "done", "info"], "after", "02:45"]);
});

check("nursing again 20 minutes after a feed by day is more of it: the turns don't move, and its top-up is owed once", () => {
  const first = nurse("L 13:00-13:10, R 13:10-13:20", { plan: TOPUP.id });
  const again = nurse("R 13:40-13:50");
  let n = now(PLAN, [first, again], "13:51");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, states(n.focus), n.focus.steps[0].minutes, n.after?.feed.id, clock(n.due!.base)], ["underway", TOPUP.id, "tagged", ["done", "todo"], 30, SNS.id, "13:00"]);
  // The top-up after it is that feed's, and the next turn is the SNS feed's.
  n = now(PLAN, [first, again, bottle("13:55", 30, { via: "paced", milk: "formula" })], "14:00");
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.from)], ["upcoming", SNS.id, null, "15:30"]);
  // Left unlogged, the one top-up is missed once, not a second feed's steps.
  n = now(PLAN, [first, again], "14:45");
  eq([n.focus.feed.id, n.missed?.view.feed.id, n.missed?.steps.map((s) => s.step.do)], [SNS.id, TOPUP.id, ["bottle"]]);
  // With milk at the breast on it, it's the SNS feed begun early, not more of the top-up feed.
  n = now(PLAN, [first, nurse("R 13:40-13:55"), bottle("13:45", 20, { via: "sns", milk: "formula" })], "13:56");
  eq([n.focus.state, n.focus.feed.id, n.focus.why], ["underway", SNS.id, "matched"]);
});

check("an evening cluster is one plan feed: four latches close together take one turn, and its pump is asked for once", () => {
  const log = [nurse("L 17:00-17:15", { plan: SNS.id }), bottle("17:10", 20, { via: "sns", milk: "formula" }), nurse("R 17:35-17:45"), nurse("L 18:05-18:15"), nurse("R 18:35-18:50")];
  let n = now(PLAN, log, "18:51");
  eq([n.focus.state, n.focus.feed.id, states(n.focus), n.focus.steps[0].minutes, clock(n.due!.base)], ["underway", SNS.id, ["done", "todo"], 50, "17:00"]);
  n = now(PLAN, [...log, pump("18:55-19:10")], "19:15");
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.from)], ["upcoming", TOPUP.id, null, "19:30"]);
});

check("a timer paused 10 minutes or more is still one feed: its milk at the breast and both stretches count", () => {
  // One timer from the plan: on the left, a 12-minute pause, back on the right, Done; the SNS milk while on the left.
  const fed = nurse("L 10:00-10:07, R 10:19-10:27", { plan: SNS.id });
  const milk = bottle("10:04", 20, { via: "sns", milk: "formula", top_up_of: fed.id });
  let n = now(PLAN, [fed, milk], "10:28");
  eq(
    [n.focus.state, n.focus.feed.id, states(n.focus), n.focus.steps[0].milkMissing, n.focus.steps[0].minutes, n.focus.steps[0].ml, clock(n.focus.start!), clock(n.due!.base)],
    ["underway", SNS.id, ["done", "todo"], false, 15, 20, "10:00", "10:00"]
  );
  // Back on after the pause: going, with the minutes so far and the milk already given.
  const on = nurse("L 10:00-10:07, R 10:19-", { plan: SNS.id });
  n = now(PLAN, [on, { ...milk, data: { ...milk.data, top_up_of: on.id } }], "10:22");
  eq([n.focus.state, n.focus.feed.id, states(n.focus), n.focus.steps[0].minutes, n.focus.steps[0].ml], ["underway", SNS.id, ["running", "todo"], 10, 20]);
});

check("milk at the breast logged late is part of the nursing it went with: the plan's step is done, the next counts from the feed", () => {
  const fed = nurse("L 08:00-08:15", { plan: SNS.id });
  const pumped = pump("08:20-08:35");
  const late = bottle("08:50", 20, { via: "sns", milk: "formula" });
  const runs = nursingRuns([fed, late], D("09:00"));
  // 35 minutes after she came off is past the top-up rule, but SNS milk is only ever given while she nurses.
  eq([topUpRunFor(runs, ms("08:50"), D("09:00"), null, "sns")?.start, topUpRunFor(runs, ms("08:50"), D("09:00")), runs[0].topUps.map((b) => b.id)], [ms("08:00"), null, [late.id]]);
  eq([countedFeeds([fed, late], D("09:00")).length, clock(lastFedAnchor([fed, late], D("09:00"))!.at)], [1, "08:00"]);
  eq(topUpRunFor(runs, ms("11:20"), D("11:30"), null, "syringe"), null, "over three hours after it ended");
  const n = now(PLAN, [fed, pumped, late], "09:00");
  eq([n.focus.state, n.focus.feed.id, n.missed, clock(n.due!.base), clock(n.due!.from)], ["upcoming", TOPUP.id, null, "08:00", "10:30"]);
  // Logged as a plain bottle (no SNS said), it's still the feed's milk while the feed wants it: not a feed of its own.
  const m = now(PLAN, [fed, pumped, bottle("09:00", 20, { milk: "formula" })], "09:05");
  eq([m.focus.state, m.focus.feed.id, m.missed, clock(m.due!.base)], ["upcoming", TOPUP.id, null, "08:00"]);
});

check("the night's second bottle: with the same plan feed it's that feed, counted from its first bottle; late formula never starts a new night feed", () => {
  const first = bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id });
  const finish = bottle("+1 00:05", 15, { milk: "formula", plan: NIGHT.id });
  const at = D("+1 00:10");
  // The log: with the same plan feed and no nursing between, the formula to finish is more of that feed.
  eq([countedFeeds([first, finish], at).length, [...sameFeedBottleIds([first, finish], at)], clock(lastFedAnchor([first, finish], at)!.at)], [1, [finish.id], "23:45"]);
  eq(countedFeeds([first, bottle("+1 00:15", 10, { milk: "formula", plan: NIGHT.id }), bottle("+1 00:50", 10, { milk: "formula", plan: NIGHT.id })], D("+1 01:00")).length, 1, "each within 45 minutes of the one before");
  // Without a plan feed on them, each bottle is a feed, as always.
  const a = bottle("23:45", 40, { milk: "breastmilk" });
  const b = bottle("+1 00:05", 15, { milk: "formula" });
  eq([countedFeeds([a, b], at).length, sameFeedBottleIds([a, b], at).size, clock(lastFedAnchor([a, b], at)!.at)], [2, 0, "00:05"]);
  // Nursing between, or 45 minutes on, is a feed of its own.
  eq(countedFeeds([first, nurse("L 23:55-23:56"), bottle("+1 00:27", 15, { milk: "formula", plan: NIGHT.id })], D("+1 00:40")).length, 3);
  eq(countedFeeds([first, bottle("+1 00:31", 15, { milk: "formula", plan: NIGHT.id })], D("+1 00:40")).length, 2);
  // To the plan, formula logged late from the dock (55 minutes on, no plan feed on it) still finishes the night feed,
  // short of its amount until then: no new night feed asking for its pump.
  const evening = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05"), pump("23:20-23:40")];
  const n = now(PLAN, [...evening, first, bottle("+1 00:40", 15, { milk: "formula" })], "+1 00:45");
  eq([n.focus.state, n.focus.feed.id, states(n.focus), clock(n.due!.base), clock(n.due!.from), n.missed], ["upcoming", NIGHT.id, ["todo", "todo", "info"], "23:45", "02:45", null]);
});

// ── the night's edges, pumps, and when ──

check("one night rule: a feed logged without a plan feed is the night's when the card said so as it began", () => {
  const evening = [nurse("L 20:00-20:10, R 20:10-20:20", { plan: TOPUP.id }), bottle("20:25", 30, { via: "paced", milk: "formula" })];
  // At 10:58 PM the card asks for the SNS feed (its window opened at 10:30); from 11 PM, the night's.
  eq([now(PLAN, evening, "22:58").focus.feed.id, now(PLAN, evening, "23:01").focus.feed.id], [SNS.id, NIGHT.id]);
  // Started from the dock at 10:58 with the SNS milk: the SNS feed, as the card said, with its pump to do.
  const early = nurse("L 22:58-23:13");
  let n = now(PLAN, [...evening, early, bottle("23:05", 20, { via: "sns", milk: "formula", top_up_of: early.id })], "23:15");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, n.focus.night, states(n.focus)], ["underway", SNS.id, "matched", false, ["done", "todo"]]);
  // The same at 11:05: the night's feed, as the card said by then, its pump to do and the milk counted for its bottle.
  const late = nurse("L 23:05-23:20");
  n = now(PLAN, [...evening, late, bottle("23:10", 20, { via: "sns", milk: "formula", top_up_of: late.id })], "23:21");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, n.focus.night, n.focus.extraNursing], ["underway", NIGHT.id, "night", true, true]);
  // After a night feed late enough that the next is the day's, a feed at 4:45 AM (night still, by the clock) is the
  // day's turn, as the card said: the SNS feed, not the night's pump and bottle.
  const night = [pump("23:30-23:50"), bottle("23:55", 55, { milk: "breastmilk" }), pump("+1d01:50-+1d02:05"), bottle("+1 02:10", 55, { milk: "breastmilk" })];
  eq(now(PLAN, [...evening, ...night], "+1 04:40").focus.feed.id, SNS.id);
  n = now(PLAN, [...evening, ...night, nurse("L +1d04:45-+1d05:00")], "+1 05:05");
  eq([n.focus.state, n.focus.feed.id, n.focus.why, n.focus.night], ["underway", SNS.id, "order", false]);
});

check("pumps: each feed takes as many as it has pump steps; one for the next feed waits for it, and a night pump done early counts", () => {
  // By day: the SNS feed's pump, then another an hour later. The SNS feed's one pump is logged, so the finished feed
  // isn't "Now" while the second runs: the next feed is up, with its own steps.
  const day = [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:14", 20, { via: "sns" }), pump("08:20-08:35")];
  let n = now(PLAN, [...day, pump("09:30-")], "09:40");
  eq([n.focus.state, n.focus.feed.id, states(n.focus)], ["upcoming", TOPUP.id, ["todo", "todo"]]);
  // At night: the night feed, then the pumping parent pumps at 1:30 while she sleeps. That pump is the next night
  // feed's: begun while it runs, and once its bottle is given, nothing asks to pump again.
  const night = [pump("23:20-23:40"), bottle("23:45", 55, { milk: "breastmilk", plan: NIGHT.id })];
  n = now(PLAN, [...night, pump("+1d01:30-")], "+1 01:40");
  eq([n.focus.state, n.focus.feed.id, states(n.focus), n.due!.for], ["underway", NIGHT.id, ["running", "todo", "info"], "after"]);
  // Counted from when it's due (2:45 AM), since they pumped early; 2.5 hours on is past 5 AM, so the day's turn.
  eq([clock(n.due!.base), clock(n.due!.from), n.after?.feed.id, n.after?.night], ["02:45", "05:15", SNS.id, false]);
  const given = [...night, pump("+1d01:30-+1d01:50"), bottle("+1 02:45", 50, { milk: "breastmilk", plan: NIGHT.id })];
  n = now(PLAN, given, "+1 02:50");
  eq([n.focus.state, n.missed, clock(n.due!.base)], ["upcoming", null, "02:45"]);
  eq(now(PLAN, given, "+1 03:40").missed, null, "and later nothing reads as not logged");
});

check("pumps by day stay with the feed they follow: a pump between feeds of a cluster is never the next feed's", () => {
  // An invented plan whose two day feeds both pump after nursing.
  const p = parseFeedingPlan(
    {
      ...INPUT,
      feeds: [INPUT.feeds[0], { name: "Nurse, pump", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "pump", minutes: 15 }] }, INPUT.feeds[2]],
      order: ["Nurse + SNS", "Nurse, pump"],
    },
    null,
    NOW0
  );
  const [a, b] = p.feeds;
  const log = [nurse("L 17:00-17:20", { plan: a.id }), bottle("17:15", 20, { via: "sns", milk: "formula" }), pump("17:35-17:50"), nurse("L 18:20-18:30, R 18:30-18:40", { plan: b.id })];
  const n = feedPlanNow(p, log, D("18:45"), { tz: TZ, target: TARGET });
  // The 5:35 pump stays the SNS feed's; the second feed's own pump is still to do.
  eq([n.focus.state, n.focus.feed.id, states(n.focus)], ["underway", b.id, ["done", "todo"]]);
});

check("a feed due at one time reads Due now for 15 minutes, then late; a window keeps its own end", () => {
  const log = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05")];
  const n = now(PLAN, log, "21:30");
  eq([dueStatus(n.due!, D("23:30")), dueStatus(n.due!, D("23:45")), dueStatus(n.due!, D("23:46")), now(PLAN, log, "23:40").due!.status], ["due", "due", "late", "due"]);
  eq([dueText(n.due!, D("23:44"), TZ), dueText(n.due!, D("23:46"), TZ)], ["Due now (11:30 PM)", "Due since 11:30 PM: 3h 16m since the last feed"]);
  const day = now(PLAN, [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:15", 20, { via: "sns" }), pump("08:20-08:35")], "09:30");
  eq([dueStatus(day.due!, D("11:30")), dueStatus(day.due!, D("11:31"))], ["due", "late"]);
});

check("a plan removed and another added: the revision counts on, so no new feed takes an old one's id", () => {
  const removed: Record<string, unknown> = { feeding_plan: null, feeding_plan_base_rev: 2 };
  checkFeedingPlan(removed, { feeding_plan: { ...PLAN, rev: 2 } }, NOW0);
  eq(removed, { feeding_plan: null, feeding_plan_last_rev: 2 });
  const fresh: Record<string, unknown> = { feeding_plan: { ...INPUT, feeds: [INPUT.feeds[1], INPUT.feeds[0], INPUT.feeds[2]] } };
  checkFeedingPlan(fresh, { feeding_plan_last_rev: 2 }, NOW0);
  const p = fresh.feeding_plan as FeedingPlan;
  eq([p.rev, p.feeds.map((f) => f.id)], [3, ["p3f1", "p3f2", "p3f3"]]);
  // A feed started under the old plan (its p1f2) isn't read as one of the new plan's: it takes the order's turn.
  const n = feedPlanNow(p, [nurse("L 10:00-10:20", { plan: "p1f2" })], D("10:25"), { tz: TZ, target: TARGET });
  eq([n.focus.feed.name, n.focus.why], ["Nurse, top up", "order"]);
});

check("by day the night's feed is a feed like any other when it's also one of the day's turns", () => {
  // One feed for day and night: nursing from the dock by day is that feed, with its top-up to do.
  const one = parseFeedingPlan({ day: { every: [150, 210] }, night: { from: "23:00", to: "05:00", every: 180, feed: "Nurse, top up" }, feeds: [INPUT.feeds[1]], order: ["Nurse, top up"] }, null, NOW0);
  let n = feedPlanNow(one, [nurse("L 13:00-13:10, R 13:10-13:20")], D("13:25"), { tz: TZ, target: TARGET });
  eq([n.focus.state, n.focus.feed.id, n.focus.why, states(n.focus)], ["underway", one.feeds[0].id, "order", ["done", "todo"]]);
  // The top-up feed both a day turn and the night's: nursing with nothing logged with it takes the top-up feed's turn.
  const both = parseFeedingPlan({ ...INPUT, night: { ...INPUT.night, feed: "Nurse, top up" }, order: ["Nurse + SNS", "Nurse, top up"] }, null, NOW0);
  const log = [nurse("L 09:00-09:15", { plan: both.feeds[0].id }), bottle("09:10", 20, { via: "sns" }), pump("09:20-09:35"), nurse("L 12:00-12:10, R 12:10-12:20")];
  n = feedPlanNow(both, log, D("12:25"), { tz: TZ, target: TARGET });
  eq([n.focus.feed.id, n.focus.why], [both.feeds[1].id, "order"]);
});

check("parse: a night longer than 16 hours is refused, saying what was read; one saved before still reads", () => {
  const f = (night: Record<string, unknown>) => ({ ...INPUT, night: { ...INPUT.night, ...night } });
  throws(() => parseFeedingPlan(f({ from: "11:00" }), null, NOW0), PlanError, /^Night would run 11 AM to 5 AM \(18 hours\): a night is 16 hours at most, so check AM and PM \(11 PM is 23:00\)$/);
  throws(() => parseFeedingPlan(f({ from: "23:00", to: "17:00" }), null, NOW0), PlanError, /^Night would run 11 PM to 5 PM \(18 hours\).*\(5 AM is 05:00\)$/);
  throws(() => checkFeedingPlan({ feeding_plan: f({ from: "11" }) }, {}, NOW0), PlanError, /^Night would run 11 AM/);
  eq(parseFeedingPlan(f({ from: "14:00", to: "06:00" }), null, NOW0).night?.from, "14:00", "16 hours is a night");
  eq(feedingPlanOf({ feeding_plan: { ...PLAN, night: { ...PLAN.night!, from: "11:00" } } })?.night?.from, "11:00");
});

check("words: a note is a sentence of its own after the steps, never joined with then", () => {
  const f: PlanFeed = { id: "x", name: "Nurse, top up", steps: [{ do: "note", text: "Shield for the first 5 minutes." }, ...TOPUP.steps, { do: "note", text: "Only if still hungry" }] };
  eq(feedText(f, PLAN, TARGET), "Nurse 8–12 min each side; then top up 25–35 ml, formula or breast milk, paced bottle. Shield for the first 5 minutes. Only if still hungry");
});

check("in the night: across midnight, and on the clock the family keeps (a DST change)", () => {
  eq([inNight(PLAN, ms("22:59"), TZ), inNight(PLAN, ms("23:00"), TZ), inNight(PLAN, ms("+1 04:59"), TZ), inNight(PLAN, ms("+1 05:00"), TZ)], [false, true, true, false]);
  // Sunday Nov 1, 2026: 1:30 AM happens twice in New York, both in the night.
  const first = zonedTimeToUtc(2026, 11, 1, 1, 30, TZ).getTime();
  eq([inNight(PLAN, first, TZ), inNight(PLAN, first + 3_600_000, TZ)], [true, true]);
  const noNight = parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "nurse" }] }] }, null, NOW0);
  eq(inNight(noNight, first, TZ), false);
});

check("a plan without an interval: what's next, but nothing due", () => {
  const p = parseFeedingPlan({ feeds: [{ name: "A", steps: [{ do: "nurse" }] }] }, null, NOW0);
  const n = feedPlanNow(p, [nurse("L 08:00-08:15")], D("09:00"), { tz: TZ });
  eq([n.focus.feed.name, n.due], ["A", null]);
});

// ── the log's own checks ─────────────────────────────────────────────────

check("validate: a nursing feed keeps its shield and plan feed; a bottle keeps its late top-up's feed and a syringe", () => {
  const n = cleanData("feed", { method: "breast", left_sec: 600, shield: true, plan: "p1f2", top_up_of: 12 });
  eq([n.shield, n.plan, "top_up_of" in n], [true, "p1f2", false]);
  const b = cleanData("feed", { method: "bottle", amount_ml: 20, via: "syringe", top_up_of: 12, shield: true, plan: "p1f1" });
  eq([b.via, b.top_up_of, "shield" in b, b.plan], ["syringe", 12, false, "p1f1"]);
  let refused = false;
  try {
    cleanData("feed", { method: "bottle", amount_ml: 20, plan: "has spaces" });
  } catch {
    refused = true;
  }
  ok(refused, "a plan tag that isn't an id is refused");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

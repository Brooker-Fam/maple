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
import { lastFedAnchor, nursingRuns, topUpRunFor, TOP_UP_LINK_MS } from "../src/lib/maple/feed";
import {
  amountText,
  checkFeedingPlan,
  clockText,
  clockWords,
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
  eq(gone, { feeding_plan: null });
  throws(() => checkFeedingPlan({ feeding_plan: null, feeding_plan_base_rev: 7 }, saved, NOW0), PlanConflict);
  const untouched: Record<string, unknown> = { feed_target_ml: { min: 50, max: 70 } };
  checkFeedingPlan(untouched, saved, NOW0);
  eq(untouched, { feed_target_ml: { min: 50, max: 70 } });
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
  eq([amountText({ min: 30, max: 30 }, "ml"), amountText({ min: 30, max: 40 }, "ml"), amountText({ min: 29.6, max: 44.4 }, "oz")], ["30 ml", "30–40 ml", "1–1.5 oz"]);
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
  eq(feedText(NIGHT, PLAN, TARGET), "Pump 20 min; then bottle up to 50–70 ml, pumped milk first, then formula to finish; then burp halfway");
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
    "• Pump + bottle: Pump 20 min; then bottle up to 50–70 ml, pumped milk first, then formula to finish; then burp halfway",
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
  eq([n.focus.state, n.focus.feed.id, states(n.focus), n.due!.for], ["underway", NIGHT.id, ["running", "todo", "info"], "focus"]);
  // Too early for a pump to be the feed's: one at 21:40 (two hours before it's due) waits.
  n = now(PLAN, [...evening, pump("21:40-21:50")], "21:55");
  eq([n.focus.state], ["upcoming"]);
  // By day a pump between feeds doesn't begin a feed that doesn't pump first.
  const day = [nurse("L 08:00-08:15", { plan: SNS.id }), bottle("08:14", 20, { via: "sns" }), pump("08:20-08:35"), pump("10:40-")];
  n = now(PLAN, day, "10:45");
  eq([n.focus.state, n.focus.feed.id, states(n.focus)], ["upcoming", TOPUP.id, ["todo", "todo"]]);
  const night = [...evening, pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk" }), bottle("+1 00:05", 15, { milk: "formula" })];
  n = now(PLAN, night, "+1 00:10");
  // The second bottle 20 minutes on is the same feed: the bottle step has both. Done, so the next is up: still night.
  eq([n.focus.state, n.focus.feed.id, clock(n.due!.base), clock(n.due!.from)], ["upcoming", NIGHT.id, "00:05", "03:05"]);
  const last = feedPlanNow(PLAN, night, D("+1 00:06"), { tz: TZ, target: TARGET });
  eq([last.focus.state, last.focus.feed.id], ["upcoming", NIGHT.id]);
});

check("night: she wouldn't take the bottle, so milk went in at the breast: the night feed is still fed", () => {
  const log = [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns" }), pump("20:50-21:05"), pump("23:20-23:45"), nurse("L 23:50-+1d00:20"), bottle("+1 00:00", 45, { via: "syringe", milk: "formula" })];
  const n = feedPlanNow(PLAN, log, D("+1 00:25"), { tz: TZ, target: TARGET });
  eq([n.focus.state, n.focus.feed.id, n.missed], ["upcoming", NIGHT.id, null]);
  const v = feedPlanNow(PLAN, log, D("+1 00:21"), { tz: TZ, target: TARGET });
  eq(v.focus.state, "upcoming", "the night feed's bottle step counts the milk given at the breast");
  // While she was on: the night's feed (not the SNS feed, though it looked like one), nursing besides its steps.
  const on = log.map((e) => (e.kind === "feed" && e.data.method === "breast" && e.started_at === T("23:50") ? nurse("L 23:50-", {}) : e));
  const u = feedPlanNow(PLAN, on, D("+1 00:10"), { tz: TZ, target: TARGET });
  eq([u.focus.state, u.focus.feed.id, u.focus.why, u.focus.extraNursing, states(u.focus), u.focus.steps[1].ml], ["underway", NIGHT.id, "night", true, ["done", "done", "info"], 45]);
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

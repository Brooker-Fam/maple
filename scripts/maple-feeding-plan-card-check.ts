/**
 * Assertions for Today's Next feed card as data (src/components/maple/feeding/nextFeed.ts) over the plan read
 * against the log (feedPlanNow): each step's row at each state of a feed (upcoming, on the breast, off it with the
 * milk at the breast not logged, pumping, a bottle short of what it's up to), which row carries the one action (the
 * next physical step), a row's second link and its close ("She's done"), the bottle form's presets (milk and amount
 * said outright, null where the plan leaves them open), and what a finished feed left unlogged (missedItems). Then
 * what Today takes from that with this phone's memory (planReading: the dock's Bottle, its word, the missed line's
 * name for its feed), and the card's own words (a feed's base, numbers kept with their units). Setting a row aside
 * with "She's done" is the card's, on one phone: the engine never hears of it.
 *
 *   npx tsx scripts/maple-feeding-plan-card-check.ts   (part of pnpm check:maple-feeding-plan)
 *
 * The plans here are invented examples, not any family's. One PASS/FAIL line per case, exit 1 on any failure.
 * Times are wall clock in America/New_York.
 */
import { dueFromWords } from "../src/components/maple/feeding/NextFeedCard";
import {
  cardDue,
  cardDueWords,
  clockTurnText,
  keepTogether,
  missedItems,
  namedAt,
  NOT_THIS_TIME,
  nursedOnly,
  nursedWords,
  perDayLine,
  stepRows,
  whenHungry,
  type StepAction,
  type StepRow,
} from "../src/components/maple/feeding/nextFeed";
import { planReading } from "../src/components/maple/feeding/usePlanNow";
import { pause, startBreast, stopBreast, switchTo } from "../src/lib/maple/feed";
import {
  bottleNeed,
  dueFromText,
  feedPlanNow,
  parseFeedingPlan,
  planGroups,
  viewFeed,
  type BottleStep,
  type FeedingPlan,
  type PlanFeedView,
  type Range,
} from "../src/lib/maple/feeding-plan";
import { zonedTimeToUtc } from "../src/lib/maple/time";
import type { Entry, EntryOf, FeedData, Side } from "../src/lib/maple/types";
import type { FeedTarget } from "../src/lib/maple/units";

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
const plain = (v: unknown): unknown => (typeof v === "string" ? v.replace(/[  ]/g, " ") : Array.isArray(v) ? v.map(plain) : v);
function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(plain(actual));
  const e = JSON.stringify(plain(expected));
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────

/** "16:05" on the test day (Tue Mar 10, 2026), or "+1 02:30" the day after → ISO. */
function T(hms: string): string {
  const m = /^(?:([+-]\d+)\s+)?(\d{1,2}):(\d{2})$/.exec(hms.trim());
  if (!m) throw new Error(`bad time ${hms}`);
  return zonedTimeToUtc(2026, 3, 10 + Number(m[1] ?? 0), Number(m[2]), Number(m[3]), TZ).toISOString();
}
const D = (hms: string) => new Date(T(hms));

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

/**
 * A nursing timer built with the app's own taps (feed.ts): "L 08:00-08:12, R 08:12-" (an open last side: she's
 * still on; a gap between sides is a Pause, then back on), "L +1 00:30-00:50" the day after. `paused`: the last side
 * closed, the timer still going.
 */
function nurse(spec: string, extra: Partial<FeedData> = {}, opts: { paused?: boolean } = {}): EntryOf<"feed"> {
  const parts = spec.split(",").map((x) => {
    const [side, ...rest] = x.trim().split(/\s+/);
    const day = rest.length > 1 ? `${rest[0]} ` : "";
    const [a, b] = rest[rest.length - 1].split("-");
    return { side: side as Side, a: D(day + a), b: b ? D(day + b) : null };
  });
  let data = startBreast(parts[0].side, parts[0].a);
  let end = parts[0].b;
  for (const p of parts.slice(1)) {
    if (!end) throw new Error("only the last side may be open");
    if (p.a.getTime() > end.getTime()) data = pause(data, end, { explicit: true, now: end }).data;
    data = switchTo(data, p.side, p.a, { now: p.a }).data;
    end = p.b;
  }
  data = { ...data, ...extra };
  const start = parts[0].a.toISOString();
  if (!end) return { ...base("feed", start, null, true), kind: "feed", data };
  if (opts.paused) return { ...base("feed", start, null, true), kind: "feed", data: pause(data, end, { explicit: true, now: end }).data };
  const stopped = stopBreast(data, end, end);
  return { ...base("feed", start, stopped.endedAt, false), kind: "feed", data: stopped.data };
}
/** A bottle at a time: ml (null: no amount said), how, milk, and the plan's tag or the feed it's for. */
function bottle(at: string, ml: number | null, extra: Partial<FeedData> = {}): EntryOf<"feed"> {
  return { ...base("feed", T(at), null, false), kind: "feed", data: { method: "bottle", ...(ml != null ? { amount_ml: ml } : {}), ...extra } };
}
/** A pump: "21:50-22:00" ("21:50-" running). */
function pump(spec: string): EntryOf<"pump"> {
  const [a, b] = spec.split("-");
  return { ...base("pump", T(a), b ? T(b) : null, !b), kind: "pump", data: {} };
}

/**
 * The checks' invented plan: by day, every 2.5 to 3.5 hours, taking turns between "Nurse + SNS" (12–18 min, 20 ml
 * of formula in the SNS, then pump 15) and "Nurse, top up" (8–12 min each side, then a paced top-up of 25–35 ml);
 * at night (11 PM–5 AM), every 3 hours, waking: "Pump + bottle" (pump 20, then a bottle up to the target, pumped
 * milk first, then formula to finish).
 */
const NOW0 = D("09:00");
const PLAN = parseFeedingPlan(
  {
    from: "Feeding clinic",
    unit: "ml",
    day: { every: { min: 150, max: 210 } },
    night: { from: "11 PM", to: "5:00", every: 180, wake: true, feed: "Pump + bottle" },
    feeds: [
      { name: "Nurse + SNS", steps: [{ do: "nurse", minutes: [12, 18], supplement: { via: "sns", ml: 20, milk: "formula" } }, { do: "pump", minutes: 15 }] },
      { name: "Nurse, top up", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }] },
      { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
    ],
  },
  null,
  NOW0
);
const [SNS, TOPUP, NIGHT] = PLAN.feeds;
const TARGET: FeedTarget = { min: 50, max: 70 };

/**
 * Another invented plan, as a handwritten sheet often gives it: milk in a syringe with no milk named, one amount
 * ("Nurse + syringe", 15 ml) or a range ("Nurse + syringe, more", 10–15 ml), then pump 15.
 */
const SYRINGE = parseFeedingPlan(
  {
    feeds: [
      { name: "Nurse + syringe", steps: [{ do: "nurse", minutes: [10, 14], supplement: { via: "syringe", ml: 15 } }, { do: "pump", minutes: 15 }] },
      { name: "Nurse + syringe, more", steps: [{ do: "nurse", minutes: [10, 14], supplement: { via: "syringe", ml: [10, 15] } }, { do: "pump", minutes: 15 }] },
    ],
    day: { every: 180 },
  },
  null,
  NOW0
);
const [SYR, SYR_RANGE] = SYRINGE.feeds;

const at = (plan: FeedingPlan, entries: Entry[], when: string, opts: { target?: FeedTarget | null; choose?: string } = {}) =>
  feedPlanNow(plan, entries, D(when), { tz: TZ, target: opts.target === undefined ? TARGET : opts.target, choose: opts.choose });
const SHE = { Hes: "She's" };
/** Each row as [state, text, status], the shape most cases pin. */
const shape = (rows: StepRow[]) => rows.map((r) => [r.state, r.text, r.status]);
/** Which rows carry an action, a second link and a close. */
const carry = (rows: StepRow[]) => rows.map((r) => [r.action?.kind ?? null, r.secondary?.kind ?? null, r.close]);
const form = (a: StepAction | null) => (a?.kind === "form" ? { label: a.label, aria: a.aria, preset: a.preset, ...(a.hint ? { hint: a.hint } : {}) } : a);
/** What Today takes from the plan now, with nothing set aside on this phone. */
const reading = (fp: ReturnType<typeof at>, when: string) => planReading(fp, { now: D(when), tz: TZ, words: SHE });

// The evening before the night: an SNS feed from the plan at 8:30 PM, its milk, its pump.
const evening = () => [nurse("L 20:30-20:45", { plan: SNS.id }), bottle("20:44", 20, { via: "sns", milk: "formula", plan: SNS.id }), pump("20:50-21:05")];

// ── upcoming ─────────────────────────────────────────────────────────────

check("upcoming: the plan's words, numbered; the first step carries the action and nothing else does", () => {
  const fp = at(PLAN, [], "09:00");
  const rows = stepRows(fp, fp.focus, SHE);
  eq(rows.map((r) => [r.key, r.n]), [[`${SNS.id}:0`, 1], [`${SNS.id}:1`, 2]]);
  eq(shape(rows), [["todo", "Nurse 12–18 min, 20 ml of formula in the SNS", null], ["todo", "Pump 15 min", null]]);
  eq(rows[0].action, { kind: "nurse", shield: false });
  eq(carry(rows), [["nurse", null, null], [null, null, null]]);
  // The night's feed picked instead: Start pumping first; the bottle's amount is the target it's up to.
  const night = at(PLAN, [], "09:00", { choose: NIGHT.id });
  const n = stepRows(night, night.focus, SHE);
  eq(shape(n), [["todo", "Pump 20 min", null], ["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", null], ["note", "Burp halfway", null]]);
  // Its bottle beside its row, for whoever gives it (one parent pumps while the other gives the bottle).
  eq([n.map((r) => r.n), carry(n)], [[1, 2, null], [["pump", null, null], [null, "form", null], [null, null, null]]]);
  eq([night.focus.steps.map((s) => s.need), night.focus.steps[1].status], [[null, { min: 50, max: 70 }, null], "todo"], "need: the target, before any bottle");
});

// ── on the breast ────────────────────────────────────────────────────────

check("on the breast: the only action is her milk at the breast, one tap; the pump waits until she's off", () => {
  const on = nurse("L 08:00-", { plan: SNS.id });
  const fp = at(PLAN, [on], "08:08");
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["running", "Nurse 12–18 min, 20 ml of formula in the SNS", "Nursing now · 8m"], ["todo", "Pump 15 min", null]]);
  eq(carry(rows), [["log", null, null], [null, null, null]], "nothing on the pump while she's on");
  eq(rows[0].action, {
    kind: "log",
    log: { label: "Log 20 ml in the SNS", aria: "Log 20 ml in the SNS, formula", toast: "20 ml of formula in the SNS", data: { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: SNS.id, top_up_of: on.id } },
  });
  // Its milk logged while she's still on: the step says so, and there's nothing to do but feed.
  const logged = at(PLAN, [on, bottle("08:05", 20, { via: "sns", milk: "formula", plan: SNS.id, top_up_of: on.id })], "08:10");
  const after = stepRows(logged, logged.focus, SHE);
  eq(shape(after)[0], ["running", "Nurse 12–18 min, 20 ml of formula in the SNS", "Nursing now · 10m · 20 ml in the SNS"]);
  eq(carry(after), [[null, null, null], [null, null, null]]);
});

check("on the breast for each side: the status says the sides so far, and the top-up waits", () => {
  let fp = at(PLAN, [nurse("L 10:40-", { plan: TOPUP.id })], "10:46");
  let rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["running", "Nurse 8–12 min each side", "Left 6m · Right next"], ["todo", "Top up 25–35 ml, formula or breast milk, paced bottle", null]]);
  eq(carry(rows), [[null, null, null], [null, null, null]]);
  fp = at(PLAN, [nurse("L 10:40-10:50, R 10:50-", { plan: TOPUP.id })], "10:53");
  rows = stepRows(fp, fp.focus, SHE);
  eq(rows[0].status, "Left 10m · Right 3m", "both sides, in the order she took them");
  // A break after the first side (a diaper change): still going, the sides kept.
  fp = at(PLAN, [nurse("L 10:40-10:50", { plan: TOPUP.id }, { paused: true })], "10:52");
  rows = stepRows(fp, fp.focus, SHE);
  eq([rows[0].state, rows[0].status, carry(rows)], ["running", "On a break · Left 10m · Right next", [[null, null, null], [null, null, null]]]);
  // A step that isn't each side keeps the plain words.
  fp = at(PLAN, [nurse("R 08:00-08:06, L 08:06-", { plan: SNS.id })], "08:09");
  eq(stepRows(fp, fp.focus, SHE)[0].status, "Nursing now · 9m");
});

check("on the breast in a feed with no nursing step (the night's, she wouldn't take the bottle): nothing's offered until she's off", () => {
  const log = [...evening(), pump("23:20-23:45"), nurse("L 23:50-")];
  const fp = at(PLAN, log, "+1 00:05");
  eq([fp.focus.state, fp.focus.feed.id, fp.focus.extraNursing], ["underway", NIGHT.id, true]);
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows).slice(0, 2), [["done", "Pumped 25m", null], ["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", null]]);
  eq(carry(rows), [[null, null, null], [null, null, null], [null, null, null]]);
});

// ── off the breast ───────────────────────────────────────────────────────

check("off the breast with her milk at the breast not logged: the pump is next; the milk is a link on the nursing row", () => {
  const fed = nurse("L 08:00-08:15", { plan: SNS.id });
  let fp = at(PLAN, [fed], "08:16");
  let rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["todo", "Nurse 12–18 min, 20 ml of formula in the SNS", "Nursed 15m"], ["todo", "Pump 15 min", null]]);
  eq(carry(rows), [[null, "log", null], ["pump", null, null]]);
  eq(rows[0].secondary, {
    kind: "log",
    log: {
      label: "Log 20 ml in the SNS",
      aria: "Log 20 ml in the SNS, formula",
      toast: "20 ml of formula in the SNS",
      data: { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: SNS.id, top_up_of: fed.id },
      started_at: T("08:15"),
    },
  }, "given at the breast: logged at the end of her nursing");
  // Pumping, or pumped, with the milk still not logged: nothing else is left, so it's the action.
  fp = at(PLAN, [fed, pump("08:17-")], "08:20");
  rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows)[1], carry(rows)], [["running", "Pump 15 min", "Pumping now · 3m"], [["log", null, null], [null, null, null]]]);
  fp = at(PLAN, [fed, pump("08:17-08:30")], "08:31");
  eq(carry(stepRows(fp, fp.focus, SHE)), [["log", null, null], [null, null, null]]);
  // Its milk logged: the nursing row says what was, and Start pumping is the one action.
  fp = at(PLAN, [fed, bottle("08:14", 20, { via: "sns", milk: "formula", plan: SNS.id, top_up_of: fed.id })], "08:16");
  rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows)[0], carry(rows)], [["done", "Nursed 15m · 20 ml in the SNS", null], [[null, null, null], ["pump", null, null]]]);
});

check("a running pump leaves a bottle its action: one parent pumps while the other gives it", () => {
  // The night: the pump has begun the night's feed, and its first bottle is the pumped milk.
  let fp = at(PLAN, [...evening(), pump("23:20-")], "23:30");
  let rows = stepRows(fp, fp.focus, SHE);
  eq([fp.focus.state, fp.focus.feed.id, shape(rows).slice(0, 2)], ["underway", NIGHT.id, [["running", "Pump 20 min", "Pumping now · 10m"], ["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", null]]]);
  eq(carry(rows), [[null, null, null], ["form", null, null], [null, null, null]]);
  // Pumped milk first: breast milk, never the last bottle's milk; how much was pumped is the family's to say, so no
  // amount, and the hint says what the whole bottle is up to.
  eq(form(rows[1].action), {
    label: "Log bottle",
    aria: "Log bottle: up to 50–70 ml in all, opens the bottle form",
    preset: { method: "bottle", amount_ml: null, milk: "breastmilk", plan: NIGHT.id },
    hint: "Up to 50–70 ml in all",
  });
  // By day: off the breast, pumping, the top-up is next for whoever gives it.
  const fed = nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id });
  fp = at(PLAN, [fed, pump("11:01-")], "11:05");
  rows = stepRows(fp, fp.focus, SHE);
  eq(form(rows[1].action), {
    label: "Log top-up",
    aria: "Log top-up: opens the bottle form",
    preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", plan: TOPUP.id, top_up_of: fed.id },
  }, "formula or breast milk: the family's to say, so null");
});

// ── a bottle short of what it's up to ────────────────────────────────────

check("a bottle short of what it's up to stays open: what's given, formula to finish, and She's done", () => {
  const night = [...evening(), pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id })];
  const fp = at(PLAN, night, "23:50");
  eq([fp.focus.state, fp.focus.feed.id, fp.focus.done, fp.focus.steps[1].status, fp.focus.steps[1].ml, fp.focus.steps[1].need], ["underway", NIGHT.id, false, "todo", 40, { min: 50, max: 70 }]);
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows).slice(0, 2), [["done", "Pumped 20m", null], ["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", "Gave 40 ml · up to 50–70 ml"]]);
  eq(carry(rows), [[null, null, null], ["form", null, "She's done"], [null, null, null]]);
  eq(form(rows[1].action), { label: "Log formula to finish", aria: "Log formula to finish: 10 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 10, milk: "formula", plan: NIGHT.id } });
  // The close is in the baby's words; without them, the name-free form.
  eq([stepRows(fp, fp.focus, { Hes: "He's" })[1].close, stepRows(fp)[1].close], ["He's done", "The baby's done"]);
  // The pump still going (the other parent gave the pumped milk): the rest is still the bottle's action.
  const going = at(PLAN, [...evening(), pump("23:20-"), bottle("23:25", 40, { milk: "breastmilk", plan: NIGHT.id })], "23:30");
  eq(form(stepRows(going, going.focus, SHE)[1].action), { label: "Log formula to finish", aria: "Log formula to finish: 10 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 10, milk: "formula", plan: NIGHT.id } });
  // Some formula in and still short (she slowed down): the rest of the bottle, still formula, and still She's done;
  // once the feed is over, the line never says the formula to finish wasn't logged.
  const some = [...night, bottle("23:55", 5, { milk: "formula", plan: NIGHT.id })];
  const slow = at(PLAN, some, "23:58");
  const r = stepRows(slow, slow.focus, SHE)[1];
  eq([r.state, r.status, r.close], ["todo", "Gave 45 ml · up to 50–70 ml", "She's done"]);
  eq(form(r.action), { label: "Log the rest of the bottle", aria: "Log the rest of the bottle: 5 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 5, milk: "formula", plan: NIGHT.id } });
  eq(missedItems(at(PLAN, some, "+1 00:50")).map((x) => [x.what, x.logged]), [["the rest of the bottle", "Gave 45 ml"]]);
  // The formula to finish reaches the target: done, and the card moves on to the next feed.
  const finished = at(PLAN, [...night, bottle("23:55", 10, { milk: "formula", plan: NIGHT.id })], "+1 00:00");
  eq([finished.focus.state, finished.missed], ["upcoming", null]);
});

check("a short bottle left as it was: the missed line says what's short and what was given, its fix the rest at that feed", () => {
  const given = bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id });
  const fp = at(PLAN, [...evening(), pump("23:20-23:40"), given], "+1 00:40");
  eq([fp.focus.state, fp.missed?.view.feed.id, fp.missed?.steps.map((s) => s.i)], ["upcoming", NIGHT.id, [1]]);
  const m = missedItems(fp);
  eq(m.map((x) => [x.key, x.what, x.logged]), [[`${NIGHT.id}:1`, "formula to finish", "Gave 40 ml"]]);
  // A bottle-led feed's rest goes with its last bottle, so it stays that feed (never a new one at the time it's logged).
  eq(form(m[0].fix), {
    label: "Log formula to finish",
    aria: "Log formula to finish: 10 ml, opens the bottle form",
    preset: { method: "bottle", amount_ml: 10, milk: "formula", plan: NIGHT.id, started_at: given.started_at },
  });
  // The row and its missed item share the step's key (what the card sets aside, on this phone, by).
  const open = at(PLAN, [...evening(), pump("23:20-23:40"), given], "23:50");
  eq(stepRows(open, open.focus, SHE)[1].key, m[0].key);
});

check("a bottle that must reach an amount: its own amount, else the target; any other bottle is done at its first", () => {
  const night = NIGHT.steps[1] as BottleStep;
  eq([bottleNeed(night, TARGET), bottleNeed(night, null)], [{ min: 50, max: 70 }, null], "up to the target, only with one set");
  eq(bottleNeed({ do: "bottle", ml: { min: 60, max: 90 }, milk: "breastmilk_first" }, null), { min: 60, max: 90 }, "pumped milk first, with an amount of its own");
  eq(bottleNeed({ do: "bottle", to_target: true, ml: { min: 40, max: 60 } }, TARGET), { min: 40, max: 60 }, "its own amount, as its words say it");
  eq(bottleNeed(TOPUP.steps[1] as BottleStep, TARGET), null, "a plain top-up");
  // A plain top-up is done at its first bottle, whatever its amount.
  const fed = nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id });
  const n = at(PLAN, [fed, bottle("11:02", 15, { via: "paced", milk: "formula", plan: TOPUP.id, top_up_of: fed.id })], "11:05");
  eq([n.focus.state, n.missed], ["upcoming", null]);
  // No target set: the night's bottle is done at its first bottle, and its preset leaves the amount blank.
  const none = at(PLAN, [...evening(), pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id })], "23:50", { target: null });
  eq([none.focus.state, none.focus.steps[1].need], ["upcoming", null]);
  const pumping = at(PLAN, [...evening(), pump("23:20-")], "23:30", { target: null });
  eq(form(stepRows(pumping, pumping.focus, SHE)[1].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { method: "bottle", amount_ml: null, milk: "breastmilk", plan: NIGHT.id } });
  // A bottle logged without an amount can't say it's short: done.
  const unsaid = at(PLAN, [...evening(), pump("23:20-23:40"), bottle("23:45", null, { milk: "breastmilk", plan: NIGHT.id })], "23:50");
  eq([unsaid.focus.state, unsaid.missed], ["upcoming", null]);
});

check("bottle presets say the milk and the amount outright: the plan's, or null where it leaves them open", () => {
  const open = parseFeedingPlan({ feeds: [{ name: "Paced bottle", steps: [{ do: "bottle", via: "paced" }] }, { name: "Formula bottle", steps: [{ do: "bottle", ml: 60, milk: "formula" }] }] }, null, NOW0);
  let fp = at(open, [], "09:00");
  eq(form(stepRows(fp, fp.focus, SHE)[0].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { method: "bottle", amount_ml: null, milk: null, via: "paced", plan: open.feeds[0].id } });
  fp = at(open, [], "09:00", { choose: open.feeds[1].id });
  eq(form(stepRows(fp, fp.focus, SHE)[0].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { method: "bottle", amount_ml: 60, milk: "formula", plan: open.feeds[1].id } });
  // A top-up up to the target whose milk is named: the rest of it in that milk.
  const toTarget = parseFeedingPlan({ feeds: [{ name: "Nurse, then bottle", steps: [{ do: "nurse", minutes: [8, 12] }, { do: "bottle", to_target: true, milk: "breastmilk" }] }] }, null, NOW0);
  const fed = nurse("L 14:00-14:12", { plan: toTarget.feeds[0].id });
  fp = at(toTarget, [fed, bottle("14:14", 30, { milk: "breastmilk", plan: toTarget.feeds[0].id, top_up_of: fed.id })], "14:16");
  const rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows)[1], rows[1].close], [["todo", "Top up to 50–70 ml, breast milk", "Gave 30 ml · up to 50–70 ml"], "She's done"]);
  eq(form(rows[1].action), {
    label: "Log the rest of the top-up",
    aria: "Log the rest of the top-up: 20 ml, opens the bottle form",
    preset: { method: "bottle", amount_ml: 20, milk: "breastmilk", plan: toTarget.feeds[0].id, top_up_of: fed.id },
  });
});

// ── milk at the breast with no milk named ────────────────────────────────

check("milk at the breast the plan doesn't name: Formula or Breast milk, one tap each; a range opens the form with the milk blank", () => {
  const on = nurse("R 14:00-", { plan: SYR.id });
  let fp = at(SYRINGE, [on], "14:06", { target: null });
  const one = (milk: "formula" | "breastmilk", label: string) => ({
    label,
    aria: `${label}: log 15 ml in the syringe`,
    toast: `15 ml of ${milk === "formula" ? "formula" : "breast milk"} in the syringe`,
    data: { method: "bottle", amount_ml: 15, milk, via: "syringe", plan: SYR.id, top_up_of: on.id },
  });
  eq(stepRows(fp, fp.focus, SHE)[0].action, { kind: "choose", prompt: "Log 15 ml in the syringe:", options: [one("formula", "Formula"), one("breastmilk", "Breast milk")] });
  const range = nurse("R 14:00-", { plan: SYR_RANGE.id });
  fp = at(SYRINGE, [range], "14:06", { target: null, choose: SYR_RANGE.id });
  eq(form(stepRows(fp, fp.focus, SHE)[0].action), {
    label: "Log milk in the syringe",
    aria: "Log milk in the syringe: 10–15 ml, opens the bottle form",
    preset: { method: "bottle", amount_ml: 10, milk: null, via: "syringe", plan: SYR_RANGE.id, top_up_of: range.id },
  });
  // Off the breast: the choice is the nursing row's second link, logged at the end of her nursing.
  const fed = nurse("R 14:00-14:12", { plan: SYR.id });
  fp = at(SYRINGE, [fed], "14:13", { target: null });
  const rows = stepRows(fp, fp.focus, SHE);
  eq(carry(rows), [[null, "choose", null], ["pump", null, null]]);
  eq(rows[0].secondary?.kind === "choose" ? rows[0].secondary.options.map((o) => [o.label, o.started_at, o.data.milk]) : null, [["Formula", T("14:12"), "formula"], ["Breast milk", T("14:12"), "breastmilk"]]);
});

// ── what a finished feed left unlogged ───────────────────────────────────

check("missed: a top-up opens the form naming its feed; milk at the breast is one link at the end of her nursing; a pump, the pump form", () => {
  const topUp = nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id });
  let fp = at(PLAN, [topUp], "12:00");
  let m = missedItems(fp);
  eq(m.map((x) => [x.key, x.what, x.logged]), [[`${TOPUP.id}:1`, "top-up", null]]);
  eq(form(m[0].fix), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", plan: TOPUP.id, top_up_of: topUp.id } });
  // The SNS feed: its milk (named, one amount: one tap at the end of her nursing) and its pump.
  const sns = nurse("L 08:00-08:15", { plan: SNS.id });
  fp = at(PLAN, [sns], "09:30");
  m = missedItems(fp);
  eq(m.map((x) => [x.what, x.fix?.kind]), [["milk in the SNS", "log"], ["pump", "form"]]);
  eq(m[0].fix?.kind === "log" ? [m[0].fix.log.label, m[0].fix.log.started_at, m[0].fix.log.data] : null, ["Log 20 ml in the SNS", T("08:15"), { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: SNS.id, top_up_of: sns.id }]);
  eq(form(m[1].fix), { label: "Log pump", aria: "Log the pump: opens the pump form", preset: { started_at: T("08:15") } });
  // Milk at the breast with no milk named, in the missed line's single link: the form, its milk blank.
  const syr = nurse("R 14:00-14:12", { plan: SYR.id });
  fp = at(SYRINGE, [syr, pump("14:13-14:28")], "15:30", { target: null });
  m = missedItems(fp);
  eq(form(m[0].fix), {
    label: "Log milk in the syringe",
    aria: "Log milk in the syringe: 15 ml, opens the bottle form",
    preset: { method: "bottle", amount_ml: 15, milk: null, via: "syringe", plan: SYR.id, top_up_of: syr.id, started_at: T("14:12") },
  });
});

// ── a step only if needed ────────────────────────────────────────────────

/**
 * Invented plans with steps only if needed: "Nurse, top up if hungry" (8–12 min each side, then a 25–35 ml paced
 * top-up if she's still hungry); "Top up if hungry, pump" (the same, then pump 15); "Nurse + SNS, top up if hungry"
 * (12–18 min with 20 ml of formula in the SNS, then the top-up if she's still hungry); "Nurse, pump, bottle if hungry"
 * (12–18 min, pump 15, then a 60 ml top-up of breast milk if she's still hungry); every 2.5 to 3.5 hours.
 */
const OPTIONAL = parseFeedingPlan(
  {
    day: { every: [150, 210] },
    feeds: [
      { name: "Nurse, top up if hungry", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced", if_needed: true }] },
      { name: "Top up if hungry, pump", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }, { do: "pump", minutes: 15 }] },
      { name: "Nurse + SNS, top up if hungry", steps: [{ do: "nurse", minutes: [12, 18], supplement: { via: "sns", ml: 20, milk: "formula" } }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }] },
      { name: "Nurse, pump, bottle if hungry", steps: [{ do: "nurse", minutes: [12, 18] }, { do: "pump", minutes: 15 }, { do: "bottle", ml: 60, milk: "breastmilk", if_needed: true }] },
    ],
  },
  null,
  NOW0
);
const [HUNGRY, HUNGRY_PUMP, SNS_HUNGRY, PUMP_HUNGRY] = OPTIONAL.feeds;

check("only if needed: in the plan's words; before the feed the nursing has the action, and the step is marked only if needed", () => {
  const fp = at(OPTIONAL, [], "09:00");
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["todo", "Nurse 8–12 min each side", null], ["todo", "Top up 25–35 ml if still hungry, formula or breast milk, paced bottle", null]]);
  eq([carry(rows), rows.map((r) => r.optional)], [[["nurse", null, null], [null, null, null]], [false, true]]);
});

check("only if needed: off the breast it's the big button with a quiet Not needed when nothing else is left; never while she's on", () => {
  const on = nurse("L 09:00-09:10, R 09:10-", { plan: HUNGRY.id });
  let fp = at(OPTIONAL, [on], "09:15");
  eq(carry(stepRows(fp, fp.focus, SHE)), [[null, null, null], [null, null, null]], "while she's on, nothing");
  const fed = nurse("L 09:00-09:10, R 09:10-09:20", { plan: HUNGRY.id });
  fp = at(OPTIONAL, [fed], "09:25");
  const rows = stepRows(fp, fp.focus, SHE);
  eq([fp.focus.state, fp.focus.done, shape(rows)], ["underway", true, [["done", "Nursed 20m", null], ["todo", "Top up 25–35 ml if still hungry, formula or breast milk, paced bottle", null]]]);
  eq(carry(rows), [[null, null, null], ["form", null, "Not needed"]]);
  eq(form(rows[1].action), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", plan: HUNGRY.id, top_up_of: fed.id } });
  // Nobody gave it: never in the not-logged line.
  eq(missedItems(at(OPTIONAL, [fed], "10:30")), []);
});

check("only if needed never takes the big button from a step that isn't: beside its row while the pump is next, the big one once nothing else is", () => {
  const fed = nurse("L 09:00-09:10, R 09:10-09:20", { plan: HUNGRY_PUMP.id });
  let fp = at(OPTIONAL, [fed], "09:25", { choose: HUNGRY_PUMP.id });
  let rows = stepRows(fp, fp.focus, SHE);
  eq([fp.focus.feed.id, carry(rows)], [HUNGRY_PUMP.id, [[null, null, null], [null, "form", "Not needed"], ["pump", null, null]]]);
  eq(form(rows[1].secondary), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", plan: HUNGRY_PUMP.id, top_up_of: fed.id } });
  // Pumping, or pumped: the top-up is the one thing left.
  fp = at(OPTIONAL, [fed, pump("09:26-")], "09:30");
  rows = stepRows(fp, fp.focus, SHE);
  eq(carry(rows), [[null, null, null], ["form", null, "Not needed"], [null, null, null]]);
  fp = at(OPTIONAL, [fed, pump("09:26-09:41")], "09:42");
  eq(carry(stepRows(fp, fp.focus, SHE)), [[null, null, null], ["form", null, "Not needed"], [null, null, null]]);
  // Left as it was, only the pump is ever missed.
  eq(missedItems(at(OPTIONAL, [fed], "10:30")).map((m) => m.what), ["pump"]);
  // Her milk at the breast still to log isn't only if needed: it keeps the big button, the top-up beside its row.
  const sns = nurse("L 12:00-12:15", { plan: SNS_HUNGRY.id });
  fp = at(OPTIONAL, [sns], "12:16", { choose: SNS_HUNGRY.id });
  rows = stepRows(fp, fp.focus, SHE);
  eq([fp.focus.feed.id, carry(rows)], [SNS_HUNGRY.id, [["log", null, null], [null, "form", "Not needed"]]]);
});

check("only if needed after a pump: nothing while the pump waits its turn; while it runs, the bottle for whoever gives it", () => {
  const fed = nurse("L 09:00-09:15", { plan: PUMP_HUNGRY.id });
  let fp = at(OPTIONAL, [fed], "09:16", { choose: PUMP_HUNGRY.id });
  eq([fp.focus.feed.id, carry(stepRows(fp, fp.focus, SHE))], [PUMP_HUNGRY.id, [[null, null, null], ["pump", null, null], [null, null, null]]]);
  fp = at(OPTIONAL, [fed, pump("09:17-")], "09:20");
  const rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows)[2], carry(rows)[2]], [["todo", "Top up 60 ml if still hungry, breast milk", null], ["form", null, "Not needed"]]);
});

check("set aside on this phone, a step reads done and the next one's turn comes: Not needed, then the pump only if needed; She's done too", () => {
  const p = parseFeedingPlan(
    { feeds: [{ name: "Nurse, top up, pump if needed", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }, { do: "pump", minutes: 10, if_needed: true }] }], day: { every: 180 } },
    null,
    NOW0
  );
  const id = p.feeds[0].id;
  const fed = nurse("L 09:00-09:10, R 09:10-09:20", { plan: id });
  const fp = at(p, [fed], "09:25");
  eq(carry(stepRows(fp, fp.focus, SHE)), [[null, null, null], ["form", null, "Not needed"], [null, null, null]], "the top-up's turn first");
  const set = stepRows(fp, fp.focus, SHE, new Set([`${id}:1`]));
  eq([set[1].state, set[1].status, carry(set)], ["done", "Not needed", [[null, null, null], [null, null, null], ["pump", null, "Not needed"]]]);
  // She's done on a bottle short of its amount: done as it is, what was given still said, and the step after it is next.
  const night = [...evening(), pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id })];
  const n = at(PLAN, night, "23:50");
  const done = stepRows(n, n.focus, SHE, new Set([`${NIGHT.id}:1`]));
  eq([done[1].state, done[1].status, carry(done)], ["done", "Gave 40 ml · up to 50–70 ml", [[null, null, null], [null, null, null], [null, null, null]]]);
});

// ── nursing on one side ──────────────────────────────────────────────────

check("one side: the start offers only the plan's side, with its shield and feed", () => {
  const p = parseFeedingPlan(
    { feeds: [{ name: "Left, pump the right", steps: [{ do: "nurse", minutes: [15, 20], side: "left", shield: true }, { do: "pump", minutes: 15 }] }], day: { every: 180 } },
    null,
    NOW0
  );
  const fp = at(p, [], "09:00");
  const rows = stepRows(fp, fp.focus, SHE);
  eq([rows[0].text, rows[0].action], ["Nurse 15–20 min on the left with the nipple shield", { kind: "nurse", shield: true, side: "L" }]);
  // Any other plan's start has no side of its own: the suggested one, the other beside it.
  eq(stepRows(at(PLAN, [], "09:00"), undefined, SHE)[0].action, { kind: "nurse", shield: false });
});

// ── the plan's unit ──────────────────────────────────────────────────────

check("in ounces: what's given, what it's up to and the rest, in the plan's unit", () => {
  const oz = parseFeedingPlan({ amounts_in: "oz", feeds: [{ name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", to_target: true, milk: "breastmilk_first" }] }] }, null, NOW0);
  const target = { min: 59.1, max: 88.7 };
  const fp = at(oz, [pump("13:00-13:20"), bottle("13:22", 29.6, { milk: "breastmilk", plan: oz.feeds[0].id })], "13:25", { target });
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows)[1], ["todo", "Bottle up to 2–3 oz, breast milk first, then formula to finish", "Gave 1 oz · up to 2–3 oz"]);
  eq(form(rows[1].action), { label: "Log formula to finish", aria: "Log formula to finish: 1 oz, opens the bottle form", preset: { method: "bottle", amount_ml: 29.5, milk: "formula", plan: oz.feeds[0].id } });
});

// ── the night's bottle before its pump ───────────────────────────────────

/** The night's first feed, all logged: pump 11:20–11:40 PM, 55 ml of pumped milk at 11:45 and 10 ml of formula at 11:55. */
const firstNight = () => [
  ...evening(),
  pump("23:20-23:40"),
  bottle("23:45", 55, { milk: "breastmilk", plan: NIGHT.id }),
  bottle("23:55", 10, { milk: "formula", plan: NIGHT.id }),
];
/** The night bottle's preset before anything's given: breast milk, no amount, the night feed. */
const NIGHT_BOTTLE = () => ({
  label: "Log bottle",
  aria: "Log bottle: up to 50–70 ml in all, opens the bottle form",
  preset: { method: "bottle", amount_ml: null, milk: "breastmilk", plan: NIGHT.id },
  hint: "Up to 50–70 ml in all",
});

check("the night's bottle before its pump: a quiet second action once the feed is close, for whoever gives it; the dock opens the same", () => {
  // Due at 2:45 AM (3 h after the 11:45 PM bottle). An hour and a quarter before, only Start pumping.
  const early = at(PLAN, firstNight(), "+1 01:30");
  eq([early.focus.state, early.focus.feed.id, early.due?.for], ["upcoming", NIGHT.id, "focus"]);
  eq(carry(stepRows(early, early.focus, SHE, undefined, D("+1 01:30"))), [["pump", null, null], [null, null, null], [null, null, null]], "too early for the bottle");
  eq(reading(early, "+1 01:30").bottle, null, "the dock's Bottle is a plain one");
  // Forty minutes before (as a pump that early begins the feed): the bottle beside its row, and the dock opens it.
  const close = at(PLAN, firstNight(), "+1 02:05");
  const rows = stepRows(close, close.focus, SHE, undefined, D("+1 02:05"));
  eq(carry(rows), [["pump", null, null], [null, "form", null], [null, null, null]]);
  eq(form(rows[1].secondary), NIGHT_BOTTLE());
  const r = reading(close, "+1 02:05");
  eq([r.primary?.action.kind, r.bottle?.word, r.bottle?.primary, r.bottle?.preset], ["pump", "Night feed", false, NIGHT_BOTTLE().preset], "not the next step: whose bottle it is");
  // Given first, short of the target (the pump still to start): Start pumping stays the big button, the rest beside the row.
  const given = at(PLAN, [...firstNight(), bottle("+1 02:40", 40, { milk: "breastmilk" })], "+1 02:42");
  eq([given.focus.state, given.focus.feed.id], ["underway", NIGHT.id]);
  const g = stepRows(given, given.focus, SHE, undefined, D("+1 02:42"));
  eq([shape(g)[1], carry(g)], [["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", "Gave 40 ml · up to 50–70 ml"], [["pump", null, null], [null, "form", "She's done"], [null, null, null]]]);
  eq(form(g[1].secondary), { label: "Log formula to finish", aria: "Log formula to finish: 10 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 10, milk: "formula", plan: NIGHT.id } });
  eq([reading(given, "+1 02:42").bottle?.word, reading(given, "+1 02:42").bottle?.preset.amount_ml], ["To finish", 10]);
  // The pump running: the bottle is the next step, the dock's "Next step".
  const pumping = at(PLAN, [...firstNight(), pump("+1 02:40-")], "+1 02:45");
  eq([reading(pumping, "+1 02:45").bottle?.word, reading(pumping, "+1 02:45").bottle?.primary], ["Next step", true]);
});

check("a bottle feed left short: the dock opens the missed line's fix, at its last bottle, for 90 minutes; the line names it by its bottle, not its pump", () => {
  const given = bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id });
  const log = [...evening(), pump("23:20-23:40"), given];
  const fp = at(PLAN, log, "+1 00:40");
  const r = reading(fp, "+1 00:40");
  eq([r.missed.map((m) => m.what), r.missedName, fp.missed?.view.start], [["formula to finish"], Date.parse(T("23:45")), Date.parse(T("23:20"))], "named by its first bottle; kept by its start");
  eq([r.bottle?.word, r.bottle?.primary, r.bottle?.preset], ["To finish", false, { method: "bottle", amount_ml: 10, milk: "formula", plan: NIGHT.id, started_at: given.started_at }]);
  // An hour and a half after its last bottle: the missed line still says so, the dock's Bottle is a plain one again.
  const late = at(PLAN, log, "+1 01:20");
  eq([reading(late, "+1 01:20").missed.length, reading(late, "+1 01:20").bottle], [1, null]);
});

// ── she only nursed, in the night feed's place ───────────────────────────

check("she only nursed in a plan feed with no nursing: the plan's words, nothing to do, nothing owed", () => {
  // The night's first feed all logged, then she nursed 12:30–12:50 AM (from the dock): the night feed's place, nursed.
  const log = [...firstNight(), nurse("L +1 00:30-00:50")];
  const fp = at(PLAN, log, "+1 01:00");
  eq([fp.focus.feed.id, nursedOnly(fp.focus)], [NIGHT.id, true]);
  const rows = stepRows(fp, fp.focus, SHE, undefined, D("+1 01:00"));
  eq(shape(rows), [["todo", "Pump 20 min", null], ["todo", "Bottle up to 50–70 ml, breast milk first, then formula to finish", null], ["note", "Burp halfway", null]]);
  eq(carry(rows), [[null, null, null], [null, null, null], [null, null, null]]);
  const r = reading(fp, "+1 01:00");
  eq([r.primary, r.bottle, r.nurseNext], [null, null, false]);
  // Later, nothing of it is "not logged".
  const later = at(PLAN, log, "+1 01:45");
  eq([missedItems(later), reading(later, "+1 01:45").missed, reading(later, "+1 01:45").bottle], [[], [], null]);
  // The engine's word decides once it says (PlanFeedView.nursedOnly beside .named).
  const said = { ...fp, focus: { ...fp.focus, named: Date.parse(T("+1 00:30")), nursedOnly: false } };
  eq([nursedOnly(said.focus), carry(stepRows(said, said.focus, SHE))[0][0]], [false, "pump"]);
  const told = { ...fp.focus, named: Date.parse(T("+1 00:30")), nursedOnly: true };
  eq(nursedOnly(told), true);
  // What happened, in the baby's words: once she's off, and while she's on.
  eq(plain(nursedWords(fp.focus, { He: "She", Hes: "She's" }, TZ)), "She nursed 20m at 12:30 AM");
  const on = at(PLAN, [...firstNight(), nurse("L +1 00:30-")], "+1 00:42");
  eq([nursedOnly(on.focus), nursedWords(on.focus, { He: "She", Hes: "She's" }, TZ)], [true, "She's nursing now · 12m"]);
  eq(nursedWords(at(PLAN, [nurse("L 09:00-09:15", { plan: SNS.id })], "09:20").focus, { He: "She", Hes: "She's" }, TZ), null, "a feed that nurses: none");
  // Nursing with the night's bottle given isn't only nursing: she nursed too, the rest to do.
  const both = at(PLAN, [...evening(), bottle("23:20", 30, { milk: "breastmilk", plan: NIGHT.id }), nurse("L 23:30-23:45")], "23:50");
  eq([both.focus.feed.id, both.focus.extraNursing, nursedOnly(both.focus)], [NIGHT.id, true, false]);
});

// ── one name per feed ────────────────────────────────────────────────────

check("a feed is named by its first nursing or bottle, never a pump begun before it, through a re-latch too", () => {
  // The night's: pumped from 11:20, its bottle at 11:45: the 11:45 PM feed.
  const night = at(PLAN, [...evening(), pump("23:20-23:40"), bottle("23:45", 40, { milk: "breastmilk", plan: NIGHT.id })], "23:50");
  eq([night.focus.start, namedAt(night.focus)], [Date.parse(T("23:20")), Date.parse(T("23:45"))]);
  // Pumping, no bottle yet: nothing to name it by.
  eq(namedAt(at(PLAN, [...evening(), pump("23:20-")], "23:30").focus), null);
  // A top-up feed she latched again for, 20 minutes after: one feed, named by its first nursing; its top-up still names
  // the newest nursing (the one it tops up), and the form is told the feed's name.
  const fed = nurse("L 10:40-10:50, R 10:50-11:00", { plan: TOPUP.id });
  const again = nurse("L 11:20-11:28");
  const fp = at(PLAN, [fed, again], "11:40");
  eq([fp.focus.feed.id, namedAt(fp.focus)], [TOPUP.id, Date.parse(T("10:40"))]);
  const r = reading(fp, "11:40");
  eq(r.bottle?.preset, { method: "bottle", amount_ml: 25, milk: null, via: "paced", plan: TOPUP.id, top_up_of: again.id, feed_at: T("10:40") });
  // Left unlogged, the line names it the same way.
  const missed = reading(at(PLAN, [fed, again], "12:30"), "12:30");
  eq([missed.missed.map((m) => m.what), missed.missedName], [["top-up"], Date.parse(T("10:40"))]);
});

check("the due line's base: a feed's start, the night's pump before its bottle, or when the feed underway was due", () => {
  // The night feed is due at 11:30 PM (3 h after the 8:30 PM feed). Pumping from 11:40, no bottle yet: the feed after
  // counts from the pump.
  const pumping = at(PLAN, [...evening(), pump("23:40-")], "23:45");
  eq([pumping.focus.start, namedAt(pumping.focus), pumping.due?.for, pumping.due?.base], [Date.parse(T("23:40")), null, "after", Date.parse(T("23:40"))]);
  eq(plain(dueFromWords(pumping.due!, PLAN, TZ, "pump")), "3 h after the 11:40 PM pump");
  // Pumping early, from 11:20: it counts from when this one was due.
  const early = at(PLAN, [...evening(), pump("23:20-")], "23:30");
  eq([early.focus.start, early.due?.base], [Date.parse(T("23:20")), Date.parse(T("23:30"))]);
  eq(plain(dueFromWords(early.due!, PLAN, TZ, "time")), "3 h after 11:30 PM, when this one was due");
  // Its bottle in: the feed's start, as every feed's.
  const bottled = at(PLAN, [...evening(), pump("23:40-"), bottle("23:50", 40, { milk: "breastmilk", plan: NIGHT.id })], "23:55");
  eq(plain(dueFromWords(bottled.due!, PLAN, TZ)), "3 h after the 11:50 PM feed");
});

// ── a feed's parts and their plan feed ───────────────────────────────────

check("a feed's parts name the plan feed only when the log or the family said it: never for one Maple took for the order's turn", () => {
  // From the dock, untagged, on Nurse + SNS's turn: the plan's SNS milk, tied to the feed, with no plan feed.
  const dock = nurse("L 09:00-");
  let fp = at(PLAN, [dock], "09:05");
  eq([fp.focus.feed.id, fp.focus.why], [SNS.id, "order"]);
  const log = stepRows(fp, fp.focus, SHE)[0].action;
  eq(log?.kind === "log" ? log.log.data : log, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", top_up_of: dock.id });
  // Started from the card (tagged): the plan's feed too.
  const card = nurse("L 09:00-", { plan: SNS.id });
  fp = at(PLAN, [card], "09:05");
  const tagged = stepRows(fp, fp.focus, SHE)[0].action;
  eq(tagged?.kind === "log" ? tagged.log.data : tagged, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: SNS.id, top_up_of: card.id });
  // A top-up on the order's turn, and a top-up nobody logged: tied to the feed, no plan feed.
  const sns = [nurse("L 06:00-06:15", { plan: SNS.id }), bottle("06:10", 20, { via: "sns", milk: "formula", plan: SNS.id }), pump("06:20-06:35")];
  const fed = nurse("L 09:00-09:10, R 09:10-09:20");
  fp = at(PLAN, [...sns, fed], "09:25");
  eq([fp.focus.feed.id, fp.focus.why], [TOPUP.id, "order"]);
  eq(form(stepRows(fp, fp.focus, SHE)[1].action), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", top_up_of: fed.id } });
  eq(form(missedItems(at(PLAN, [...sns, fed], "10:30"))[0].fix), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 25, milk: null, via: "paced", top_up_of: fed.id } });
  // A bottle feed's own bottle keeps the plan feed (the night's second bottle joins its first by it).
  const own = stepRows(at(PLAN, [...evening(), pump("23:20-")], "23:30"))[1].action;
  eq(own?.kind === "form" ? own.preset : own, { method: "bottle", amount_ml: null, milk: "breastmilk", plan: NIGHT.id });
});

// ── the card's words ─────────────────────────────────────────────────────

check("milk counted on a nursing step says how it was given: in the SNS, by bottle, or both", () => {
  const fed = nurse("L 08:00-08:15", { plan: SNS.id });
  // Logged as a plain bottle with the feed (the dock's form, Siri): its milk, by bottle.
  let fp = at(PLAN, [fed, bottle("08:20", 20, { milk: "formula", top_up_of: fed.id })], "08:22");
  eq(shape(stepRows(fp, fp.focus, SHE))[0], ["done", "Nursed 15m · 20 ml by bottle", null]);
  // Some in the SNS, some by bottle.
  fp = at(PLAN, [fed, bottle("08:10", 10, { via: "sns", milk: "formula", plan: SNS.id, top_up_of: fed.id }), bottle("08:20", 20, { milk: "formula", top_up_of: fed.id })], "08:22");
  eq(shape(stepRows(fp, fp.focus, SHE))[0], ["done", "Nursed 15m · 10 ml in the SNS + 20 ml by bottle", null]);
  // While she's on.
  const on = nurse("L 08:00-", { plan: SNS.id });
  fp = at(PLAN, [on, bottle("08:05", 20, { milk: "formula", top_up_of: on.id })], "08:08");
  eq(stepRows(fp, fp.focus, SHE)[0].status, "Nursing now · 8m · 20 ml by bottle");
});

check("numbers keep their units on one line: each amount, minutes and hours whole", () => {
  const keep = (t: string) => keepTogether(t).filter((p) => p.keep).map((p) => p.text);
  eq(keep("Nurse 12–18 min, 20 ml of formula in the SNS"), ["12–18 min", "20 ml"]);
  eq(keep("2.5–3.5 h after the 8:00 AM feed"), ["2.5–3.5 h"]);
  eq(keep("Gave 0.68 oz · up to 2–3 oz, in 1h 05m"), ["0.68 oz", "2–3 oz", "1h 05m"]);
  eq(keepTogether("Nursed 15m · 20 ml by bottle").map((p) => p.text).join(""), "Nursed 15m · 20 ml by bottle", "the words don't change");
  eq(keep("Burp halfway"), []);
  eq(keep("4 feeds in the last 24 hours · plan: at least 8 · 240 ml · plan: 450–550 ml"), ["240 ml", "450–550 ml"]);
});

// ── plans other families bring home: the newer options on the card ──────
//
// Where the engine's own reading of an option lands with slice E (an amount she must take at least, a feed whose
// breast she wasn't offered), the view is built by hand from viewFeed, as that engine reads it.

/** A plan feed read against what was logged for it (the engine's viewFeed, as started from the plan), for a view built by hand. */
const viewOf = (feed: FeedingPlan["feeds"][number], entries: Entry[], when: string, target: FeedTarget | null = null): PlanFeedView =>
  viewFeed(feed, "tagged", false, planGroups(entries, D(when))[0] ?? null, D(when), target);

/**
 * Invented plans with the breast offered only if she wants to: "Practice, then bottle" (offer the breast 5–10 min, then
 * 60 ml of breast milk by paced bottle) and "Bottle, then the breast" (60 ml of formula, then the breast if she's
 * still hungry), every 3 hours.
 */
const OFFER = parseFeedingPlan(
  {
    day: { every: 180 },
    feeds: [
      { name: "Practice, then bottle", steps: [{ do: "nurse", minutes: [5, 10], if_needed: true }, { do: "bottle", ml: 60, milk: "breastmilk", via: "paced" }] },
      { name: "Bottle, then the breast", steps: [{ do: "bottle", ml: 60, milk: "formula" }, { do: "nurse", minutes: [5, 10], if_needed: true }] },
    ],
  },
  null,
  NOW0
);
const [PRACTICE, AFTER_BOTTLE] = OFFER.feeds;
const PRACTICE_BOTTLE = { method: "bottle", amount_ml: 60, milk: "breastmilk", via: "paced", plan: PRACTICE.id };

check("the breast offered only if she wants to: Start Left or Right with a quiet Not this time; then the bottle, the big button, never a top-up", () => {
  let fp = at(OFFER, [], "09:00");
  let rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["todo", "Offer the breast 5–10 min", null], ["todo", "Bottle 60 ml, breast milk, paced bottle", null]]);
  // In its place it's the next physical step: Start, with Not this time; the bottle waits for her chance to pass.
  eq([carry(rows), rows.map((r) => r.optional)], [[["nurse", null, NOT_THIS_TIME], [null, null, null]], [true, false]]);
  eq(rows[0].action, { kind: "nurse", shield: false });
  // The dock outlines the next side, as for any nursing next.
  const r = reading(fp, "09:00");
  eq([r.primary?.action.kind, r.nurseNext, r.bottle], ["nurse", true, null]);
  // Not this time, set aside on this phone: the offer reads done, and the bottle is the big button (the dock's Next step).
  const aside = stepRows(fp, fp.focus, SHE, new Set([`${PRACTICE.id}:0`]));
  eq([shape(aside)[0], carry(aside)], [["done", "Offer the breast 5–10 min", NOT_THIS_TIME], [[null, null, null], ["form", null, null]]]);
  eq(form(aside[1].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: PRACTICE_BOTTLE });
  // Before the feed, it's set aside by the plan's turn (no feed start yet).
  const passed = planReading(fp, { now: D("09:00"), tz: TZ, words: SHE, closed: (start, key) => start === null && key === `${PRACTICE.id}:0` });
  eq([passed.rows[0].status, passed.primary?.action.kind, passed.nurseNext, passed.bottle?.word, passed.bottle?.preset], [NOT_THIS_TIME, "form", false, "Next step", PRACTICE_BOTTLE]);
  // On the breast: nothing else while she's on.
  fp = at(OFFER, [nurse("L 09:00-", { plan: PRACTICE.id })], "09:05");
  rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows), carry(rows)], [[["running", "Offer the breast 5–10 min", "Nursing now · 5m"], ["todo", "Bottle 60 ml, breast milk, paced bottle", null]], [[null, null, null], [null, null, null]]]);
  // Off it: her bottle, the feed's own (never a top-up, so it names no nursing), with the plan's feed.
  const practised = nurse("L 09:00-09:08", { plan: PRACTICE.id });
  fp = at(OFFER, [practised], "09:10");
  rows = stepRows(fp, fp.focus, SHE);
  eq([shape(rows)[0], carry(rows)], [["done", "Nursed 8m", null], [[null, null, null], ["form", null, null]]]);
  eq(form(rows[1].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: PRACTICE_BOTTLE });
  eq([reading(fp, "09:10").bottle?.word, reading(fp, "09:10").bottle?.preset], ["Next step", PRACTICE_BOTTLE]);
  // Left as it was: the bottle wasn't logged (never the breast), logged at the end of her nursing so it's that feed's.
  eq(
    missedItems(at(OFFER, [practised], "10:30")).map((x) => [x.what, form(x.fix)]),
    [["bottle", { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { ...PRACTICE_BOTTLE, started_at: T("09:08") } }]]
  );
});

check("the breast offered: its chance passes once the bottle is in (Not this time, nothing owed); offered after a bottle, it's the big button", () => {
  // Only the bottle, from the card (too sleepy to practise): her chance at the breast has passed, and nothing is to do.
  const given = bottle("09:00", 60, { milk: "breastmilk", via: "paced", plan: PRACTICE.id });
  const fp = at(OFFER, [given], "09:05");
  const rows = stepRows(fp, viewOf(PRACTICE, [given], "09:05"), SHE);
  eq([shape(rows), carry(rows)], [[["done", "Offer the breast 5–10 min", NOT_THIS_TIME], ["done", "Gave 60 ml", null]], [[null, null, null], [null, null, null]]]);
  eq(missedItems(at(OFFER, [given], "10:30")), [], "the breast offered is never owed");
  // The breast after a bottle, if she's still hungry: once the bottle is in, its Start is the big button, with Not this time.
  const first = bottle("12:00", 60, { milk: "formula", plan: AFTER_BOTTLE.id });
  const after = stepRows(fp, viewOf(AFTER_BOTTLE, [first], "12:05"), SHE);
  eq([shape(after), carry(after)], [[["done", "Gave 60 ml", null], ["todo", "Offer the breast 5–10 min", null]], [[null, null, null], ["nurse", null, NOT_THIS_TIME]]]);
  // Before that feed: the bottle, and nothing yet for the breast, whose turn comes after it.
  const before = stepRows(at(OFFER, [], "09:00", { choose: AFTER_BOTTLE.id }), undefined, SHE);
  eq([shape(before)[1], carry(before)], [["todo", "Offer the breast 5–10 min", null], [["form", null, null], [null, null, null]]]);
});

/** An invented plan whose bottle she must take at least 60 ml of (a weight-gain plan's least), formula, every 3 hours. */
const LEAST = parseFeedingPlan({ day: { every: 180 }, feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: { min: 60 }, milk: "formula" }] }] }, null, NOW0);

check("at least: what's given against its least, the rest of the bottle and She's done; left as it is, the rest not logged", () => {
  const feed = LEAST.feeds[0];
  eq([(feed.steps[0] as BottleStep).at_least, (feed.steps[0] as BottleStep).ml], [true, { min: 60, max: 60 }]);
  const given = bottle("09:00", 40, { milk: "formula", plan: feed.id });
  const fp = at(LEAST, [given], "09:10", { target: null });
  // As slice E's engine reads an at-least step (StepView.need, its least): to do while what's logged is short of it.
  const need: Range = { min: 60, max: 60 };
  const read = viewOf(feed, [given], "09:10");
  const short: PlanFeedView = { ...read, done: false, steps: read.steps.map((s) => ({ ...s, need, status: "todo" as const })) };
  const rows = stepRows(fp, short, SHE);
  eq([shape(rows), carry(rows)], [[["todo", "Bottle at least 60 ml, formula", "Gave 40 ml · at least 60 ml"]], [["form", null, "She's done"]]]);
  eq(form(rows[0].action), { label: "Log the rest of the bottle", aria: "Log the rest of the bottle: 20 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 20, milk: "formula", plan: feed.id } });
  // She's done: as it is, what was given still said.
  const done = stepRows(fp, short, SHE, new Set([`${feed.id}:0`]));
  eq([shape(done), carry(done)], [[["done", "Bottle at least 60 ml, formula", "Gave 40 ml · at least 60 ml"]], [[null, null, null]]]);
  // Left as it is: the rest of the bottle not logged, with what was given, at its bottle (so it stays that feed).
  eq(
    missedItems({ ...fp, missed: { view: short, steps: short.steps } }).map((x) => [x.what, x.logged, form(x.fix)]),
    [["the rest of the bottle", "Gave 40 ml", { label: "Log the rest of the bottle", aria: "Log the rest of the bottle: 20 ml, opens the bottle form", preset: { method: "bottle", amount_ml: 20, milk: "formula", plan: feed.id, started_at: given.started_at } }]]
  );
  // Before it: its least, as the plan says it.
  eq(form(stepRows(at(LEAST, [], "09:00"), undefined, SHE)[0].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { method: "bottle", amount_ml: 60, milk: "formula", plan: feed.id } });
});

/**
 * Invented plans with a most: "Nurse, top up" (nurse up to 20 min, then a top-up of up to 30 ml of formula) and
 * "Bottle, pump" (up to 60 ml of formula by paced bottle, then pump up to 15 min), every 3 hours.
 */
const CAPS = parseFeedingPlan(
  {
    day: { every: 180 },
    feeds: [
      { name: "Nurse, top up", steps: [{ do: "nurse", minutes: { max: 20 } }, { do: "bottle", ml: 30, up_to: true, milk: "formula" }] },
      { name: "Bottle, pump", steps: [{ do: "bottle", ml: [0, 60], milk: "formula", via: "paced" }, { do: "pump", minutes: { max: 15 } }] },
    ],
  },
  null,
  NOW0
);

check("up to: in its words; a bottle up to an amount leaves how much she took to the family, its most the hint, and any amount is it done", () => {
  const [TOP, BOT] = CAPS.feeds;
  let fp = at(CAPS, [], "09:00");
  eq(shape(stepRows(fp, fp.focus, SHE)), [["todo", "Nurse up to 20 min", null], ["todo", "Top up to 30 ml, formula", null]]);
  const fed = nurse("L 09:00-09:15", { plan: TOP.id });
  fp = at(CAPS, [fed], "09:16");
  eq(form(stepRows(fp, fp.focus, SHE)[1].action), {
    label: "Log top-up",
    aria: "Log top-up: up to 30 ml, opens the bottle form",
    preset: { method: "bottle", amount_ml: null, milk: "formula", plan: TOP.id, top_up_of: fed.id },
    hint: "Up to 30 ml",
  });
  fp = at(CAPS, [], "09:00", { choose: BOT.id });
  const rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["todo", "Bottle up to 60 ml, formula, paced bottle", null], ["todo", "Pump up to 15 min", null]]);
  eq(form(rows[0].action), { label: "Log bottle", aria: "Log bottle: up to 60 ml, opens the bottle form", preset: { method: "bottle", amount_ml: null, milk: "formula", via: "paced", plan: BOT.id }, hint: "Up to 60 ml" });
  // Any amount given is the step done: a most never keeps it open.
  fp = at(CAPS, [bottle("09:00", 45, { milk: "formula", via: "paced", plan: BOT.id })], "09:05");
  eq([fp.focus.feed.id, fp.focus.steps[0].need, shape(stepRows(fp, fp.focus, SHE))[0]], [BOT.id, null, ["done", "Gave 45 ml", null]]);
});

/**
 * Invented plans given other than by bottle: "Cup feed" (20–30 ml of breast milk by cup), "Nurse, spoon" (nurse 10–15
 * min, then 10–15 ml of breast milk by spoon) and "Pump, finger feed" (pump 15 min, then 5 ml by finger feeding).
 */
const GIVEN = parseFeedingPlan(
  {
    day: { every: 180 },
    feeds: [
      { name: "Cup feed", steps: [{ do: "bottle", ml: [20, 30], milk: "breastmilk", by: "cup" }, { do: "note", text: "Sip by sip" }] },
      { name: "Nurse, spoon", steps: [{ do: "nurse", minutes: [10, 15] }, { do: "bottle", ml: [10, 15], milk: "breastmilk", by: "spoon" }] },
      { name: "Pump, finger feed", steps: [{ do: "pump", minutes: 15 }, { do: "bottle", ml: 5, by: "finger" }] },
    ],
  },
  null,
  NOW0
);

check("by cup, spoon or finger: Log feed, the bottle form with the step's milk and amount and no way of giving; never called a bottle", () => {
  const [CUP, SPOON, FINGER] = GIVEN.feeds;
  let fp = at(GIVEN, [], "09:00");
  let rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows), [["todo", "Cup 20–30 ml, breast milk", null], ["note", "Sip by sip", null]]);
  const cup = { method: "bottle", amount_ml: 20, milk: "breastmilk", plan: CUP.id };
  eq(form(rows[0].action), { label: "Log feed", aria: "Log feed: opens the bottle form", preset: cup });
  eq([reading(fp, "09:00").bottle?.word, reading(fp, "09:00").bottle?.preset], ["Next step", cup], "the dock's Bottle opens the same, no way of giving");
  // Given with no amount said: what it was, never a bottle.
  const unsaid = bottle("09:00", null, { milk: "breastmilk", plan: CUP.id });
  eq(shape(stepRows(fp, viewOf(CUP, [unsaid], "09:05"), SHE))[0], ["done", "Fed by cup", null]);
  // After nursing, its top-up by spoon: a top-up, named by its feed, with no way of giving.
  const fed = nurse("L 10:00-10:12", { plan: SPOON.id });
  fp = at(GIVEN, [fed], "10:13");
  rows = stepRows(fp, fp.focus, SHE);
  eq(shape(rows)[1], ["todo", "Top up 10–15 ml by spoon, breast milk", null]);
  eq(form(rows[1].action), { label: "Log top-up", aria: "Log top-up: opens the bottle form", preset: { method: "bottle", amount_ml: 10, milk: "breastmilk", plan: SPOON.id, top_up_of: fed.id } });
  // A finger feed after its pump, left unlogged: "finger feed", its fix Log feed.
  const pumped = viewFeed(FINGER, "chosen", false, null, D("12:30"), null, [pump("12:00-12:15")]);
  eq(
    missedItems({ ...fp, missed: { view: pumped, steps: [pumped.steps[1]] } }).map((x) => [x.what, form(x.fix)]),
    [["finger feed", { label: "Log feed", aria: "Log feed: opens the bottle form", preset: { method: "bottle", amount_ml: 5, milk: null, plan: FINGER.id } }]]
  );
});

/** An invented plan: every 3 hours by day, waking her; at night (10 PM–6 AM) when she's hungry; a formula bottle. */
const HUNGRY_NIGHT = parseFeedingPlan(
  { day: { every: 180, wake: true }, night: { from: "22:00", to: "06:00", on_demand: true }, feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: [60, 90], milk: "formula" }] }] },
  null,
  NOW0
);

check("a night when she's hungry: no time for a night feed, never Due since; the day's due again at the night's end", () => {
  const eve = [bottle("21:40", 70, { milk: "formula", plan: HUNGRY_NIGHT.feeds[0].id })];
  for (const when of ["22:30", "+1 00:05", "+1 02:30", "+1 05:30"]) {
    const fp = at(HUNGRY_NIGHT, eve, when, { target: null });
    eq([fp.focus.night, cardDue(fp), whenHungry(HUNGRY_NIGHT, fp.focus.night)], [true, null, true], `at ${when}`);
  }
  // The night over: the day's due, from the night's end.
  const morning = at(HUNGRY_NIGHT, eve, "+1 06:05", { target: null });
  eq([morning.focus.night, whenHungry(HUNGRY_NIGHT, false), plain(cardDueWords(cardDue(morning)!, D("+1 06:05"), TZ, "her"))], [false, false, "Due now (6:00 AM)"]);
  // A due by day is the card's as it is.
  const day = at(PLAN, [nurse("L 08:00-08:15", { plan: SNS.id })], "09:30");
  eq(cardDue(day), day.due);
  // No time between feeds at all: when hungry, day and night; a night with a time of its own, or the day's, has one.
  const hungry = parseFeedingPlan({ feeds: [{ name: "Nurse", steps: [{ do: "nurse" }] }] }, null, NOW0);
  const asByDay = parseFeedingPlan({ day: { every: 180 }, night: { from: "22:00", to: "06:00" }, feeds: [{ name: "Nurse", steps: [{ do: "nurse" }] }] }, null, NOW0);
  eq([whenHungry(hungry, false), whenHungry(hungry, true), whenHungry(PLAN, false), whenHungry(PLAN, true), whenHungry(asByDay, true)], [true, true, false, false, false]);
});

/** An invented split night: 10 PM–6 AM, the partner's bottle until 2 AM, then nursing; every 2.5–3 hours. */
const SPLIT = parseFeedingPlan(
  {
    day: { every: [150, 180] },
    night: { from: "22:00", to: "06:00", order: ["Partner's bottle", "Nurse"], starts: ["22:00", "02:00"] },
    feeds: [
      { name: "Nurse", steps: [{ do: "nurse", minutes: [10, 15], each_side: true }] },
      { name: "Partner's bottle", steps: [{ do: "bottle", ml: [60, 90], milk: "breastmilk", via: "paced" }] },
    ],
    order: ["Nurse"],
  },
  null,
  NOW0
);

check("a night by the clock: the turn's hours beside its name, until its end in its time, from its start before it", () => {
  const [NURSE, PARTNER] = SPLIT.feeds;
  const words = (id: string, when: string) => clockTurnText(SPLIT, id, D(when), TZ);
  eq([words(PARTNER.id, "21:30"), words(PARTNER.id, "22:00"), words(PARTNER.id, "+1 01:59"), words(PARTNER.id, "+1 03:00")], ["from 10 PM", "until 2 AM", "until 2 AM", "10 PM–2 AM"]);
  eq([words(NURSE.id, "23:00"), words(NURSE.id, "+1 02:00"), words(NURSE.id, "+1 05:30")], ["from 2 AM", "until 6 AM", "until 6 AM"]);
  // A feed that isn't one of the night's turns, or turns that go in order: none.
  eq([words("p0f0", "23:00"), clockTurnText(PLAN, NIGHT.id, D("23:30"), TZ)], [null, null]);
  // The card's night feed at 11 PM (after the 8 PM nursing): the partner's, with its hours.
  const fp = at(SPLIT, [nurse("L 20:00-20:15, R 20:15-20:30", { plan: NURSE.id })], "23:00");
  eq([fp.focus.night, fp.focus.feed.id, words(fp.focus.feed.id, "23:00")], [true, PARTNER.id, "until 2 AM"]);
});

check("the plan's feeds and milk in 24 hours: one quiet line of what was logged beside them, none without them", () => {
  const counted = parseFeedingPlan({ day: { every: { max: 180 } }, per_day: { feeds: { min: 8 }, ml: [450, 550] }, feeds: [{ name: "Bottle", steps: [{ do: "bottle", milk: "formula" }] }] }, null, NOW0);
  const log = ["00:30", "03:30", "06:30", "09:00"].map((t) => bottle(t, 60, { milk: "formula" }));
  eq(plain(perDayLine(counted, log, D("10:00"))), "4 feeds in the last 24 hours · plan: at least 8 · 240 ml · plan: 450–550 ml");
  eq(plain(perDayLine({ ...counted, per_day: { feeds: { min: 8, max: 12 } } }, [], D("10:00"))), "No feeds logged in the last 24 hours · plan: 8–12");
  eq(perDayLine(PLAN, log, D("10:00")), null);
});

check("the due line says what it counts from in the engine's words (dueFromText), after the plan's hours", () => {
  const fp = at(PLAN, [nurse("L 08:00-08:15", { plan: SNS.id }), pump("08:20-08:35")], "09:30");
  const d = fp.due!;
  eq([d.for, plain(dueFromText(d, TZ))], ["focus", "after the 8:00 AM feed"]);
  eq(plain(dueFromWords(d, PLAN, TZ)), plain(`2.5–3.5 h ${dueFromText(d, TZ)}`));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

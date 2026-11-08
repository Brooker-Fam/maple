/**
 * Assertions for Today's Next feed card as data (src/components/maple/feeding/nextFeed.ts) over the plan read
 * against the log (feedPlanNow): each step's row at each state of a feed (upcoming, on the breast, off it with the
 * milk at the breast not logged, pumping, a bottle short of what it's up to), which row carries the one action (the
 * next physical step), a row's second link and its close ("She's done"), the bottle form's presets (milk and amount
 * said outright, null where the plan leaves them open), and what a finished feed left unlogged (missedItems).
 * Setting a row aside with "She's done" is the card's, on one phone: the engine never hears of it.
 *
 *   npx tsx scripts/maple-feeding-plan-card-check.ts   (part of pnpm check:maple-feeding-plan)
 *
 * The plans here are invented examples, not any family's. One PASS/FAIL line per case, exit 1 on any failure.
 * Times are wall clock in America/New_York.
 */
import { missedItems, stepRows, type StepAction, type StepRow } from "../src/components/maple/feeding/nextFeed";
import { pause, startBreast, stopBreast, switchTo } from "../src/lib/maple/feed";
import { bottleNeed, feedPlanNow, parseFeedingPlan, type BottleStep, type FeedingPlan } from "../src/lib/maple/feeding-plan";
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
 * still on; a gap between sides is a Pause, then back on). `paused`: the last side closed, the timer still going.
 */
function nurse(spec: string, extra: Partial<FeedData> = {}, opts: { paused?: boolean } = {}): EntryOf<"feed"> {
  const parts = spec.split(",").map((x) => {
    const [side, r] = x.trim().split(/\s+/);
    const [a, b] = r.split("-");
    return { side: side as Side, a: D(a), b: b ? D(b) : null };
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
const form = (a: StepAction | null) => (a?.kind === "form" ? { label: a.label, aria: a.aria, preset: a.preset } : a);

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
  eq(shape(n), [["todo", "Pump 20 min", null], ["todo", "Bottle up to 50–70 ml, pumped milk first, then formula to finish", null], ["note", "Burp halfway", null]]);
  eq([n.map((r) => r.n), carry(n)], [[1, 2, null], [["pump", null, null], [null, null, null], [null, null, null]]]);
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
  eq(shape(rows).slice(0, 2), [["done", "Pumped 25m", null], ["todo", "Bottle up to 50–70 ml, pumped milk first, then formula to finish", null]]);
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
  eq([fp.focus.state, fp.focus.feed.id, shape(rows).slice(0, 2)], ["underway", NIGHT.id, [["running", "Pump 20 min", "Pumping now · 10m"], ["todo", "Bottle up to 50–70 ml, pumped milk first, then formula to finish", null]]]);
  eq(carry(rows), [[null, null, null], ["form", null, null], [null, null, null]]);
  eq(form(rows[1].action), { label: "Log bottle", aria: "Log bottle: opens the bottle form", preset: { method: "bottle", amount_ml: 50, milk: "breastmilk", plan: NIGHT.id } }, "pumped milk first: breast milk, never the last bottle's milk");
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
  eq(shape(rows).slice(0, 2), [["done", "Pumped 20m", null], ["todo", "Bottle up to 50–70 ml, pumped milk first, then formula to finish", "Gave 40 ml · up to 50–70 ml"]]);
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
  eq(shape(rows)[1], ["todo", "Bottle up to 2–3 oz, pumped milk first, then formula to finish", "Gave 1 oz · up to 2–3 oz"]);
  eq(form(rows[1].action), { label: "Log formula to finish", aria: "Log formula to finish: 1 oz, opens the bottle form", preset: { method: "bottle", amount_ml: 29.5, milk: "formula", plan: oz.feeds[0].id } });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

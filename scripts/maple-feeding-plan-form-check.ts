/**
 * Assertions for the feeding plan's form as data (src/components/maple/feeding/planDraft.ts): a saved plan opened in
 * the sheet and saved untouched comes back the same plan, in ml or oz, every newer option included (the night when
 * hungry, its turns by the clock, nursing only if she wants to, up to and at least, a cup, spoon or finger, feeds and
 * milk in 24 hours, long notes); the target per feed round-trips; switching ml and oz never changes an amount;
 * starting shapes fill in kinds of step and no numbers, the everyday ones first; taking a feed out keeps the turns and
 * the night whole; and a refusal's words point at the feed and step they're about.
 *
 *   npx tsx scripts/maple-feeding-plan-form-check.ts   (part of pnpm check:maple-feeding-plan)
 *
 * The plans here are invented examples, not any family's. One PASS/FAIL line per case, exit 1 on any failure.
 */
import { amountText, checkFeedingPlan, feedText, NOTES_OLDER, parseFeedingPlan, perDayLines, PlanError, planLines, planNotes, type FeedingPlan } from "../src/lib/maple/feeding-plan";
import {
  addFeed,
  draftAfterNursing,
  draftFromShape,
  draftOf,
  draftProblem,
  EMPTY_RANGE,
  feedSummary,
  hoursText,
  inputOf,
  leastOf,
  move,
  newFeed,
  newStep,
  nightHungry,
  PLAN_SHAPES,
  planShortLine,
  problemPlace,
  quotedList,
  removeFeed,
  samePlan,
  setNightFeed,
  setNightStart,
  setNightTurns,
  shownAmount,
  staleNameWords,
  stepTitle,
  takeOutFeed,
  typedAmount,
  upToOf,
  wakeText,
  type BottleDraft,
  type NurseDraft,
  type PlanDraft,
  type PumpDraft,
  type StepDraft,
} from "../src/components/maple/feeding/planDraft";

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

const NOW = new Date("2026-03-10T14:00:00.000Z");
const LATER = new Date("2026-03-11T14:00:00.000Z");

/** A starting shape by its id. */
const shape = (id: string) => {
  const s = PLAN_SHAPES.find((x) => x.id === id);
  if (!s) throw new Error(`no starting shape "${id}"`);
  return s;
};

/** The invented plan of maple-feeding-plan-check.ts, plus a nipple shield, waking by day and notes. */
const PLAN = parseFeedingPlan(
  {
    from: "Feeding clinic",
    check_in: "2026-03-13",
    unit: "ml",
    day: { every: { min: 150, max: 210 }, wake: true },
    night: { from: "23:00", to: "05:00", every: 180, wake: true, feed: "Pump + bottle" },
    feeds: [
      { name: "Nurse + SNS", steps: [{ do: "nurse", minutes: [12, 18], shield: true, supplement: { via: "sns", ml: 20, milk: "formula" } }, { do: "pump", minutes: 15 }] },
      { name: "Nurse, top up", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], milk: "either", via: "paced" }] },
      { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
    ],
    notes: "Weigh at the clinic on Friday.",
  },
  null,
  NOW
);
/** In ounces: amounts typed as oz on the plan sheet, kept in ml. */
const OZ = parseFeedingPlan(
  {
    amounts_in: "oz",
    feeds: [
      { name: "Nurse, then bottle", steps: [{ do: "nurse", supplement: { via: "syringe", ml: 0.5 } }, { do: "bottle", ml: [1, 1.5], via: "bottle" }] },
      { name: "Bottle only", steps: [{ do: "bottle", ml: 2 }] },
    ],
    order: ["Bottle only", "Nurse, then bottle"],
    night: { from: "10 PM", to: "6 AM" },
  },
  null,
  NOW
);
/** The least a plan can be: one feed, one step, no interval. */
const BARE = parseFeedingPlan({ feeds: [{ name: "Nurse", steps: [{ do: "nurse" }] }] }, null, NOW);

/** Opened in the sheet and saved untouched: what the server makes of what's sent. */
function roundTrip(plan: FeedingPlan, unit: "ml" | "oz" = "ml"): FeedingPlan {
  const { plan: input } = inputOf(draftOf(plan, null, unit));
  return parseFeedingPlan({ ...input, base_rev: plan.rev }, plan, LATER);
}
/** The same plan as a new revision, still saying when it began (a first save's moment, kept on every edit). */
const same = (plan: FeedingPlan) => ({ ...plan, rev: plan.rev + 1, updated_at: LATER.toISOString(), since: plan.since ?? plan.updated_at });

check("round trip: a plan opened and saved untouched comes back the same plan, ids and all", () => {
  for (const [name, plan] of [["the full plan", PLAN], ["ounces", OZ], ["the bare plan", BARE]] as const) eq(roundTrip(plan), same(plan), name);
  // The unit a phone shows doesn't touch a saved plan's unit.
  eq(roundTrip(OZ, "ml").unit, "oz");
  eq(roundTrip(BARE, "oz").unit, "ml");
});

check("round trip: one number is one box, and still one number when saved", () => {
  const d = draftOf(PLAN, { min: 60, max: 60 }, "ml");
  const pump = d.feeds[0].steps[1];
  eq(pump.do === "pump" ? pump.minutes : null, { min: 15, max: null });
  eq(d.target, { min: 60, max: null });
  eq(inputOf(d).target, { min: 60, max: 60 });
  eq(inputOf(draftOf(PLAN, { min: 50, max: 70 }, "ml")).target, { min: 50, max: 70 });
  eq(inputOf(draftOf(PLAN, null, "ml")).target, null);
});

check("the sheet sends feeds by their place: the turns and the night's feed, and each feed's id", () => {
  const { plan: input } = inputOf(draftOf(PLAN, null, "ml"));
  eq(input.order, [1, 2]);
  eq(input.night, { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: 3 });
  eq(input.feeds.map((f) => f.id), ["p1f1", "p1f2", "p1f3"]);
  eq(inputOf(draftOf(OZ, null, "ml")).plan.order, [2, 1]);
});

check("ml and oz: switching only changes how amounts show; typed ounces go as ml", () => {
  const ml = typedAmount(1.5, "oz");
  eq([shownAmount(ml, "oz"), shownAmount(ml, "ml")], [1.5, 44.4]);
  // A saved 44.4 ml shows as 1.5 oz and goes back as 44.4 ml.
  eq([shownAmount(44.4, "oz"), shownAmount(29.6, "oz")], [1.5, 1]);
  const d: PlanDraft = draftFromShape(shape("pump-bottle"), null, "oz");
  const bottle = d.feeds[0].steps[1];
  if (bottle.do !== "bottle") throw new Error("the shape's second step is a bottle");
  const typed: PlanDraft = { ...d, feeds: [{ ...d.feeds[0], steps: [d.feeds[0].steps[0], { ...bottle, ml: { min: typedAmount(1, "oz"), max: typedAmount(1.5, "oz") } }] }] };
  const asOz = inputOf(typed).plan;
  const asMl = inputOf({ ...typed, unit: "ml" }).plan;
  eq(asOz.feeds[0].steps[1], { do: "bottle", ml: { min: 29.6, max: 44.4 } });
  eq([asOz.unit, asMl.unit, asMl.feeds[0].steps[1]], ["oz", "ml", asOz.feeds[0].steps[1]]);
  const saved = parseFeedingPlan(asOz, null, NOW);
  eq(amountText((saved.feeds[0].steps[1] as { ml: { min: number; max: number } }).ml, saved.unit), "1–1.5 oz");
});

check("starting shapes: the kinds of step only, no numbers, the feeds taking turns", () => {
  const turns = draftFromShape(shape("turns"), null, "ml");
  const { plan: input } = inputOf(turns);
  eq(input.feeds, [
    { name: "Nurse, then pump", steps: [{ do: "nurse" }, { do: "pump" }] },
    { name: "Nurse, then top up", steps: [{ do: "nurse" }, { do: "bottle" }] },
  ]);
  eq([input.order, input.day, input.night, input.from], [[1, 2], {}, undefined, undefined]);
  // Saved as it is, it's a plan: what's left to add is numbers, never steps.
  eq(parseFeedingPlan(input, null, NOW).feeds.length, 2);
  const blank = inputOf(draftFromShape(shape("blank"), null, "ml")).plan;
  eq(blank.feeds, [{ name: "", steps: [] }]);
  let refused = "";
  try {
    parseFeedingPlan(blank, null, NOW);
  } catch (e) {
    refused = e instanceof PlanError ? e.message : String(e);
  }
  eq(refused, "Feed 1's name is needed");
});

check("taking a feed out keeps the turns and the night whole; the night's feed leaves the day's turns", () => {
  let d = draftOf(PLAN, null, "ml");
  const [sns, topUp, night] = d.feeds.map((f) => f.key);
  eq(removeFeed(d, night).night.order, []);
  eq(removeFeed(d, sns).order, [topUp]);
  // The last feed in the turns out: the turns take another (not the night's).
  const one = { ...d, order: [sns] };
  eq(removeFeed(one, sns).order, [topUp]);
  // A feed made the night's leaves the turns, unless it's the only one there.
  d = setNightFeed(d, topUp);
  eq([d.night.order, d.order], [[topUp], [sns]]);
  eq(setNightFeed(d, sns).order, [sns]);
  // A new feed takes a turn.
  const added = addFeed(draftOf(PLAN, null, "ml"), newFeed("Paced bottle", ["bottle"]));
  eq(inputOf(added).plan.order, [1, 2, 4]);
  // A saved plan opens in its own unit, whatever this phone shows; changing it is a change to the plan.
  eq(draftOf(PLAN, null, "oz").unit, "ml");
  eq(samePlan(draftOf(PLAN, null, "ml"), { ...draftOf(PLAN, null, "ml"), unit: "oz" }), false, "the unit is part of the plan");
  eq(samePlan(draftOf(PLAN, null, "ml"), draftOf(PLAN, { min: 1, max: 2 }, "ml")), true, "the target isn't");
});

check("Put it back: a feed taken out comes back exactly, with its turn and the night as they were", () => {
  const d = draftOf(PLAN, null, "ml");
  const [, topUp] = d.feeds.map((f) => f.key);
  const out = takeOutFeed(d, topUp);
  eq(inputOf(out.putBack(out.next)), inputOf(d));
  // The only turn taken out hands it to the night's feed for now; Put it back hands it back.
  const oneTurn = draftOf(parseFeedingPlan({ feeds: [{ name: "Day", steps: [{ do: "nurse" }] }, { name: "Night", steps: [{ do: "pump" }, { do: "bottle" }] }], order: ["Day"], night: { from: "23:00", to: "05:00", feed: "Night" } }, null, NOW), null, "ml");
  const [day, night] = oneTurn.feeds.map((f) => f.key);
  const gone = takeOutFeed(oneTurn, day);
  eq(gone.next.order, [night]);
  eq(inputOf(gone.putBack(gone.next)), inputOf(oneTurn));
  // The night's feed taken out comes back as the night's; a feed given a turn meanwhile keeps it.
  const n = takeOutFeed(d, d.feeds[2].key);
  const added = addFeed(n.next, newFeed("Paced bottle", ["bottle"]));
  const back = n.putBack(added);
  eq([back.night.order, inputOf(back).plan.order], [[d.feeds[2].key], [1, 2, 4]]);
});

check("Put it back: on the form as it is now, so turns moved, taken out or given to the night meanwhile stay that way", () => {
  // PLAN's three feeds, all taking turns by day.
  const turns = draftOf(parseFeedingPlan({ unit: "ml", feeds: PLAN.feeds.map(({ name, steps }) => ({ name, steps })), order: [1, 2, 3] }, null, NOW), null, "ml");
  const [sns, topUp, pump] = turns.feeds.map((f) => f.key);
  const out = takeOutFeed(turns, topUp);
  eq(out.next.order, [sns, pump]);
  // "Pump + bottle" moved first meanwhile: "Nurse, top up" goes back after the turn it followed, and the move stays.
  const moved = { ...out.next, order: move(out.next.order, 1, -1) };
  eq(moved.order, [pump, sns]);
  const back = out.putBack(moved);
  eq([back.feeds.map((f) => f.name), back.order], [["Nurse + SNS", "Nurse, top up", "Pump + bottle"], [pump, sns, topUp]]);
  // "Pump + bottle" made the night's feed meanwhile: it left the turns, and Put it back doesn't bring it back to them.
  const nightOn = setNightFeed({ ...out.next, night: { ...out.next.night, on: true, from: "23:00", to: "05:00" } }, pump);
  eq(nightOn.order, [sns]);
  const atNight = out.putBack(nightOn);
  eq([atNight.order, atNight.night.order], [[sns, topUp], [pump]]);
  eq(inputOf(atNight).plan.night, { from: "23:00", to: "05:00", feed: 3 });
  // A turn taken out meanwhile stays out.
  const dropped = out.putBack({ ...out.next, order: [sns] });
  eq(dropped.order, [sns, topUp]);
  // The first turn taken out goes back before the turn it came before.
  const first = takeOutFeed(turns, sns);
  eq(first.putBack(first.next).order, [sns, topUp, pump]);
  eq(first.putBack({ ...first.next, order: move(first.next.order, 1, -1) }).order, [pump, sns, topUp]);
  // Two taken out, put back newest first: exactly as it was.
  const second = takeOutFeed(out.next, sns);
  eq(second.next.order, [pump]);
  eq(inputOf(out.putBack(second.putBack(second.next))), inputOf(turns));
  // The night's feed taken out while another is picked for the night: the newer pick stays, and the feed comes back.
  const d = draftOf(PLAN, null, "ml");
  const n = takeOutFeed(d, d.feeds[2].key);
  const picked = setNightFeed(n.next, d.feeds[1].key);
  const kept = n.putBack(picked);
  eq([kept.feeds.length, kept.night.order, kept.order], [3, [d.feeds[1].key], [d.feeds[0].key]]);
});

check("Save checks the draft as the server will, in its words: a feed that only pumps is refused on that feed before anything is sent", () => {
  const d = draftOf(PLAN, null, "ml");
  eq(draftProblem(d, PLAN, LATER), null, "the plan as it is");
  eq(draftProblem(draftOf(null, null, "ml"), null, LATER), "A feeding plan needs at least one feed");
  // "Pump + bottle" without its bottle: a pump and a note.
  const dry: PlanDraft = { ...d, feeds: d.feeds.map((f, i) => (i === 2 ? { ...f, steps: f.steps.filter((s) => s.do !== "bottle") } : f)) };
  const words = draftProblem(dry, PLAN, LATER);
  eq(words, '"Pump + bottle" needs nursing or a bottle: a pump on its own goes in the plan\'s notes');
  // The server says the same of the same plan.
  let server = "";
  try {
    checkFeedingPlan({ feeding_plan: { ...inputOf(dry).plan, base_rev: PLAN.rev } }, { feeding_plan: PLAN }, LATER);
  } catch (e) {
    server = e instanceof PlanError ? e.message : String(e);
  }
  eq(server, words, "the server's words");
  eq(problemPlace(words!, dry), { feed: d.feeds[2].key, step: null });
  // A new plan's feed that only pumps, too.
  const fresh = draftFromShape(shape("pump-bottle"), null, "ml");
  eq(draftProblem({ ...fresh, feeds: [{ ...fresh.feeds[0], steps: fresh.feeds[0].steps.slice(0, 1) }] }, null, LATER), '"Pump and bottle" needs nursing or a bottle: a pump on its own goes in the plan\'s notes');
  // An untouched plan isn't sent, so only the target is checked.
  eq(draftProblem(dry, PLAN, LATER, false), null);
  eq(draftProblem({ ...dry, target: { min: 1, max: null } }, PLAN, LATER, false), "A target per feed is between 5 and 300 ml.");
  // The form's own rules first.
  eq(draftProblem({ ...d, night: { ...d.night, to: "" } }, PLAN, LATER), "Say when the night starts and ends, or switch off Different at night.");
});

check("a refusal's words point at its feed and step", () => {
  const d = draftOf(PLAN, null, "ml");
  eq(problemPlace("Feed 2's name is needed", d), { feed: d.feeds[1].key, step: null });
  eq(problemPlace('"Nurse + SNS" step 2: the minutes must be between 1 and 120', d), { feed: d.feeds[0].key, step: d.feeds[0].steps[1].key });
  eq(problemPlace('"nurse, top up" needs at least one step', d), { feed: d.feeds[1].key, step: null });
  eq(problemPlace("Night's start must be a time like 22:00", d), null);
});

check("a folded feed reads in the plan's words, and a note is a sentence of its own, never joined with \"then\"", () => {
  const d = draftOf(PLAN, null, "ml");
  const target = { min: 50, max: 70 };
  // Without notes, it's the plan's own line for the feed.
  for (const i of [0, 1]) eq(feedSummary(d.feeds[i], "ml", target), feedText(PLAN.feeds[i], PLAN, target), PLAN.feeds[i].name);
  // "Pump + bottle" ends with a note: its steps, then the note as a sentence of its own.
  const steps = PLAN.feeds[2].steps.filter((s) => s.do !== "note");
  eq(feedSummary(d.feeds[2], "ml", target), `${feedText({ ...PLAN.feeds[2], steps }, PLAN, target)}. Burp halfway`);
  // A note between steps still reads after them, never as "then …".
  const [nurse, topUp] = d.feeds[1].steps;
  const note = (text: string) => ({ ...newStep("note"), text }) as StepDraft;
  const between = feedSummary({ ...d.feeds[1], steps: [nurse, note("Only if still hungry."), topUp] }, "ml", target);
  eq(between, `${feedText(PLAN.feeds[1], PLAN, target)}. Only if still hungry`);
  if (/then only/i.test(between)) throw new Error(`a note joined with "then": ${between}`);
  const nursing = feedText({ ...PLAN.feeds[1], steps: PLAN.feeds[1].steps.slice(0, 1) }, PLAN, target);
  eq(feedSummary({ ...d.feeds[1], steps: [nurse, note("Burp halfway"), note("Pump the right side;")] }, "ml", target), `${nursing}. Burp halfway. Pump the right side`);
  // Not finished yet: an SNS with no amount is just its name, an empty note is "Note", and no steps says so.
  const sns = { ...newStep("nurse"), atBreast: "sns" } as StepDraft;
  eq(feedSummary({ ...d.feeds[0], steps: [sns, d.feeds[0].steps[1]] }, "ml", null), "Nurse; then pump 15 min");
  eq(feedSummary({ ...d.feeds[0], steps: [d.feeds[0].steps[1], note("")] }, "ml", null), "Pump 15 min. Note");
  eq(feedSummary({ ...d.feeds[0], steps: [] }, "ml", null), "No steps yet");
});

check("a feed's name that still says what an edit took out (the shield, a syringe or SNS, a top-up, a pump) is pointed out", () => {
  const d = draftOf(PLAN, null, "ml");
  const [sns, topUp, pump] = d.feeds;
  // Untouched, every name fits.
  for (const f of d.feeds) eq(staleNameWords(f, f), [], f.name);
  // "Nurse + SNS" with no milk at the breast any more.
  const noSns = { ...sns, steps: sns.steps.map((s) => (s.do === "nurse" ? { ...s, atBreast: "none" as const } : s)) };
  eq(staleNameWords(noSns, sns), ["SNS"]);
  // A syringe instead: still not what the name says.
  eq(staleNameWords({ ...sns, steps: sns.steps.map((s) => (s.do === "nurse" ? { ...s, atBreast: "syringe" as const } : s)) }, sns), ["SNS"]);
  eq(staleNameWords({ ...topUp, steps: topUp.steps.filter((s) => s.do !== "bottle") }, topUp), ["top up"]);
  eq(staleNameWords({ ...pump, steps: pump.steps.filter((s) => s.do !== "pump") }, pump), ["pump"]);
  // Two at once, in the name's own words.
  const both = { ...sns, name: "Nipple Shield and SNS" };
  eq(staleNameWords({ ...noSns, name: both.name, steps: noSns.steps.map((s) => (s.do === "nurse" ? { ...s, shield: false } : s)) }, both), ["shield", "SNS"]);
  // Renamed, or a feed this edit added, or a name that already said it of steps without it: not this edit's doing.
  eq(staleNameWords({ ...noSns, name: "Nurse, then pump" }, sns), []);
  eq(staleNameWords(noSns, null), []);
  const nursing = { ...topUp, name: "Nurse, pumped milk top up later", steps: topUp.steps.filter((s) => s.do !== "bottle") };
  eq(staleNameWords(nursing, nursing), []);
  // A name that says it's without one already fits.
  eq(staleNameWords({ ...noSns, name: "Nurse, no SNS" }, sns), []);
  eq(staleNameWords({ ...noSns, name: "Nurse without SNS, then pump" }, sns), []);
  eq([quotedList(["SNS"]), quotedList(["shield", "SNS"]), quotedList(["shield", "syringe", "pump"])], ["“SNS”", "“shield” and “SNS”", "“shield”, “syringe” and “pump”"]);
});

check("when to wake her, plainly: at the time between feeds' longer end, in hours, counted from the start of the last feed", () => {
  eq([180, 210, 60, 90, 135, 179.6].map(hoursText), ["3 hours", "3.5 hours", "1 hour", "1.5 hours", "2h 15m", "3 hours"]);
  const her = { him: "her", hes: "she's" };
  eq(wakeText({ max: 180 }, her), "wake her if she's still asleep at 3 hours");
  eq(wakeText(PLAN.day.every!, her, { from: true }), "wake her if she's still asleep at 3.5 hours from the start of the last feed");
  // No sex set: the baby's name stands in.
  eq(wakeText({ max: 180 }, { him: "River", hes: "River's" }), "wake River if River's still asleep at 3 hours");
});

/**
 * An invented plan with this wave's options: on demand by day (at least every 3 hours, waking her), "Left, pump the
 * right" (15–20 min on the left, then pump 15), "Nurse, top up if hungry" (8–12 min each side, then a 25–35 ml top-up
 * only if she's still hungry, then pump 10 only if still full); at night (11 PM–5 AM) on demand at least every 3.5
 * hours, the night's feeds taking turns: "Pump + bottle", then "Left, pump the right".
 */
const MORE = parseFeedingPlan(
  {
    from: "Feeding clinic",
    day: { every: { max: 180 }, wake: true },
    night: { from: "23:00", to: "05:00", every: [0, 210], order: ["Pump + bottle", "Left, pump the right"] },
    feeds: [
      { name: "Left, pump the right", steps: [{ do: "nurse", minutes: [15, 20], side: "left" }, { do: "pump", minutes: 15 }] },
      { name: "Nurse, top up if hungry", steps: [{ do: "nurse", minutes: [8, 12], each_side: true }, { do: "bottle", ml: [25, 35], via: "paced", if_needed: true }, { do: "pump", minutes: 10, if_needed: true }] },
      { name: "Pump + bottle", steps: [{ do: "pump", minutes: 20 }, { do: "bottle", milk: "breastmilk_first", to_target: true }] },
    ],
    order: ["Nurse, top up if hungry"],
  },
  null,
  NOW
);

check("round trip: on demand, one side, only if needed and the night's turns come back the same plan, in ml or oz", () => {
  eq(roundTrip(MORE), same(MORE));
  eq(roundTrip(MORE, "oz"), same(MORE));
  const d = draftOf(MORE, null, "ml");
  eq([d.onDemand, d.every, d.night.onDemand, d.night.every], [true, { min: null, max: 180 }, true, { min: null, max: 210 }], "on demand: its most in the Up to box");
  const [left, hungry, night] = d.feeds;
  eq(d.night.order, [night.key, left.key]);
  const s = (f: typeof left, i: number) => f.steps[i] as StepDraft & Record<string, unknown>;
  eq([s(left, 0).side, s(left, 0).each_side, s(hungry, 0).side, s(hungry, 1).if_needed, s(hungry, 2).if_needed, s(night, 0).if_needed], ["L", false, null, true, true, false]);
  const { plan } = inputOf(d);
  eq(plan.day, { every: { min: 180, max: 180 }, on_demand: true, wake: true });
  eq(plan.night, { from: "23:00", to: "05:00", every: { min: 210, max: 210 }, on_demand: true, order: [3, 1] });
  eq(plan.feeds[1].steps, [
    { do: "nurse", minutes: { min: 8, max: 12 }, each_side: true },
    { do: "bottle", ml: { min: 25, max: 35 }, via: "paced", if_needed: true },
    { do: "pump", minutes: { min: 10, max: 10 }, if_needed: true },
  ]);
  eq(feedSummary(left, "ml", null), "Nurse 15–20 min on the left; then pump 15 min");
  eq(feedSummary(hungry, "ml", null), "Nurse 8–12 min each side; then top up 25–35 ml if still hungry, paced bottle; then pump 10 min if needed");
});

check("one side and each side are never both: each side wins, and either side sends neither", () => {
  const nurse = { ...newStep("nurse"), minutes: { min: 15, max: null } } as StepDraft;
  const feed = (step: StepDraft) => inputOf({ ...draftOf(BARE, null, "ml"), feeds: [{ ...draftOf(BARE, null, "ml").feeds[0], steps: [step] }] }).plan.feeds[0].steps[0];
  eq([feed({ ...nurse, side: "R" } as StepDraft), feed({ ...nurse, side: "R", each_side: true } as StepDraft), feed(nurse)], [
    { do: "nurse", minutes: { min: 15, max: 15 }, side: "R" },
    { do: "nurse", minutes: { min: 15, max: 15 }, each_side: true },
    { do: "nurse", minutes: { min: 15, max: 15 } },
  ]);
});

check("on demand: only its most goes, switching keeps what was typed, and Save checks the most alone", () => {
  const d = draftOf(PLAN, null, "ml");
  // Every 2.5–3.5 hours; switched to on demand, the most is the To box.
  const od: PlanDraft = { ...d, onDemand: true };
  eq(inputOf(od).plan.day, { every: { min: 210, max: 210 }, on_demand: true, wake: true });
  eq(inputOf({ ...od, every: { min: 150, max: null } }).plan.day, { every: { min: 150, max: 150 }, on_demand: true, wake: true }, "a From typed alone is the most");
  eq(inputOf({ ...od, every: { min: null, max: null } }).plan.day, { wake: true }, "nothing typed: when she's hungry");
  eq(inputOf({ ...od, onDemand: false }).plan.day, inputOf(d).plan.day, "switched back, the range as it was");
  eq(draftProblem({ ...od, every: { min: 10, max: 180 } }, PLAN, LATER), null, "a From left from before isn't sent, so isn't checked");
  eq(draftProblem({ ...od, every: { min: null, max: 20 } }, PLAN, LATER), "The time between feeds is half an hour or more.");
  // The server reads what's sent as on demand at least every 3.5 hours.
  const saved = parseFeedingPlan({ ...inputOf(od).plan, base_rev: PLAN.rev }, PLAN, LATER);
  eq([saved.day, samePlan(od, draftOf(saved, null, "ml"))], [{ every: { min: 210, max: 210 }, on_demand: true, wake: true }, true]);
});

check("the night's turns: in order, each out of the day's turns (one left there), one is the night's feed, and a feed taken out comes back to its place", () => {
  const d = draftOf(PLAN, null, "ml");
  const [sns, topUp, pump] = d.feeds.map((f) => f.key);
  const two = setNightTurns(d, [pump, topUp]);
  eq([two.night.order, two.order, inputOf(two).plan.night], [[pump, topUp], [sns], { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, order: [3, 2] }]);
  // Every day turn to the night: the day keeps one.
  eq(setNightTurns(two, [pump, topUp, sns]).order, [sns]);
  // None: the same turns as by day; one: the night's feed.
  eq([inputOf(setNightTurns(two, [])).plan.night?.order, inputOf(setNightTurns(two, [])).plan.night?.feed], [undefined, undefined]);
  eq(inputOf(setNightTurns(two, [topUp])).plan.night, { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: 2 });
  // A feed taken out leaves the night's turns, and Put it back puts it back where it was, while they're as it left them.
  const out = takeOutFeed(two, pump);
  eq(out.next.night.order, [topUp]);
  eq(out.putBack(out.next).night.order, [pump, topUp]);
  eq(out.putBack(setNightTurns(out.next, [topUp, sns])).night.order, [topUp, sns], "changed since: as they are now");
  // The server reads the night's turns as sent: its first, the night's feed.
  const saved = parseFeedingPlan({ ...inputOf(two).plan, base_rev: PLAN.rev }, PLAN, LATER);
  eq([saved.night?.feed, saved.night?.order, saved.order], [PLAN.feeds[2].id, [PLAN.feeds[2].id, PLAN.feeds[1].id], [PLAN.feeds[0].id]]);
  eq(draftOf(saved, null, "ml").night.order, [pump, topUp]);
});

check("the way in's line: who it's from and how many feeds, or the invitation", () => {
  eq([planShortLine(PLAN), planShortLine(BARE), planShortLine(null)], ["From Feeding clinic · 3 feeds", "1 feed", "Add your care team's plan"]);
});

// ── the newer options (round 4) ─────────────────────────────────────────────

/** Notes longer than an older release reads (invented, general advice). */
const LONG_NOTES = "Signs of enough milk: six or more wet diapers a day by day six, and yellow stools by day five. ".repeat(6).trim();

/**
 * An invented plan with every newer option: by day every 2.5–3 hours; "Nurse" up to 20 min each side; "Practice, then
 * bottle" (the breast offered 5–10 min only if she wants to, then a paced bottle of at least 60 ml of breast milk);
 * "Partner's bottle" (up to 90 ml, paced); "Cup feed" (20–30 ml by cup); "Nurse, spoon" (nursing, then 10–15 ml by
 * spoon if still hungry, then pump up to 15 min); "Finger feed" (5 ml by finger). At night (10 PM–6 AM) every 3
 * hours, by the clock: "Partner's bottle" from 10 PM, then "Nurse" from 2 AM. At least 8 feeds and 450–550 ml in 24
 * hours. Long notes.
 */
const NEWER = parseFeedingPlan(
  {
    from: "Feeding clinic",
    day: { every: [150, 180] },
    night: { from: "22:00", to: "06:00", every: 180, order: ["Partner's bottle", "Nurse"], starts: ["22:00", "02:00"] },
    feeds: [
      { name: "Nurse", steps: [{ do: "nurse", minutes: { max: 20 }, each_side: true }] },
      { name: "Practice, then bottle", steps: [{ do: "nurse", minutes: [5, 10], if_needed: true }, { do: "bottle", ml: { min: 60 }, milk: "breastmilk", via: "paced" }] },
      { name: "Partner's bottle", steps: [{ do: "bottle", ml: { max: 90 }, milk: "breastmilk", via: "paced" }] },
      { name: "Cup feed", steps: [{ do: "bottle", ml: [20, 30], milk: "breastmilk", by: "cup" }] },
      { name: "Nurse, spoon", steps: [{ do: "nurse" }, { do: "bottle", ml: [10, 15], by: "spoon", if_needed: true }, { do: "pump", minutes: { max: 15 } }] },
      { name: "Finger feed", steps: [{ do: "bottle", ml: 5, milk: "breastmilk", by: "finger" }] },
    ],
    order: ["Nurse", "Practice, then bottle", "Cup feed", "Nurse, spoon", "Finger feed"],
    per_day: { feeds: { min: 8 }, ml: [450, 550] },
    notes: LONG_NOTES,
  },
  null,
  NOW
);
/** In ounces: every 3 hours by day, waking her; at night (10 PM–6 AM) whenever she's hungry; 8–12 feeds and up to 24 oz in 24 hours. */
const HUNGRY = parseFeedingPlan(
  {
    amounts_in: "oz",
    day: { every: 180, wake: true },
    night: { from: "10 PM", to: "6 AM", on_demand: true, feed: "Bottle" },
    feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: [2, 3], milk: "formula" }] }],
    per_day: { feeds: [8, 12], ml: { max: 24 } },
  },
  null,
  NOW
);
/** The steps of NEWER's feed `i` in the draft. */
const newerSteps = (i: number) => draftOf(NEWER, null, "ml").feeds[i].steps;
/** One feed of one step (or a few), as the form sends it. */
const sent = (...steps: StepDraft[]) => inputOf({ ...draftOf(null, null, "ml"), feeds: [{ ...newFeed("Feed"), steps }] }).plan.feeds[0].steps;
/** Why the server refuses a draft (draftProblem, as Save checks it before sending), or null. */
const refusal = (d: PlanDraft) => draftProblem(d, null, LATER);

check("round trip: every newer option comes back the same plan, in ml or oz, and the read-back says it as before", () => {
  for (const [name, plan] of [["every newer option", NEWER], ["when hungry at night, in oz", HUNGRY]] as const) {
    eq(roundTrip(plan), same(plan), name);
    eq(roundTrip(plan, "oz"), same(plan), `${name}, shown in oz`);
    eq(planLines(roundTrip(plan), { min: 50, max: 70 }), planLines(plan, { min: 50, max: 70 }), `${name}: the read-back`);
  }
  // The long notes go whole, and the plan keeps their start where an older release reads them.
  const d = draftOf(NEWER, null, "ml");
  eq([d.notes === LONG_NOTES, inputOf(d).plan.notes === LONG_NOTES, planNotes(roundTrip(NEWER)) === LONG_NOTES, (roundTrip(NEWER).notes ?? "").length <= NOTES_OLDER], [true, true, true, true]);
});

check("the night when hungry: On demand with nothing in Up to sends on_demand alone, never waking her, and opens the same way", () => {
  const d = draftOf(HUNGRY, null, "oz");
  eq([d.night.onDemand, d.night.every, nightHungry(d.night)], [true, EMPTY_RANGE, true]);
  eq(inputOf(d).plan.night, { from: "22:00", to: "06:00", on_demand: true, feed: 1 });
  // Wake to feed at night is hidden then: one left on from before isn't sent, and nothing is refused.
  const waking: PlanDraft = { ...d, night: { ...d.night, wake: true } };
  eq([inputOf(waking).plan.night, refusal(waking)], [{ from: "22:00", to: "06:00", on_demand: true, feed: 1 }, null]);
  eq(samePlan(waking, d), true, "a hidden switch changes nothing");
  // An Up to typed: at least that often, and waking her goes again.
  const most: PlanDraft = { ...waking, night: { ...waking.night, every: { min: null, max: 240 } } };
  eq([nightHungry(most.night), inputOf(most).plan.night], [false, { from: "22:00", to: "06:00", every: { min: 240, max: 240 }, on_demand: true, wake: true, feed: 1 }]);
  // Every, with nothing typed: the day's time between feeds, as before.
  const asByDay: PlanDraft = { ...d, night: { ...d.night, onDemand: false } };
  eq(inputOf(asByDay).plan.night, { from: "22:00", to: "06:00", feed: 1 });
  // The server reads each as the read-back says it.
  const night = (x: PlanDraft) => planLines(parseFeedingPlan({ ...inputOf(x).plan, base_rev: HUNGRY.rev }, HUNGRY, LATER), null).find((l) => l.startsWith("Night"));
  eq([night(d), night(most), night(asByDay)], ["Night (10 PM–6 AM): when hungry: Bottle", "Night (10 PM–6 AM): on demand, at least every 4 hours, waking her: Bottle", "Night (10 PM–6 AM): every 3 hours (as by day): Bottle"]);
  // A night every 3 hours, switched to On demand and its Up to cleared, is whenever she's hungry: the day stays as it was.
  const was = draftOf(PLAN, null, "ml");
  const cleared: PlanDraft = { ...was, night: { ...was.night, onDemand: true, every: EMPTY_RANGE } };
  eq([inputOf(cleared).plan.night, inputOf(cleared).plan.day], [{ from: "23:00", to: "05:00", on_demand: true, feed: 3 }, inputOf(was).plan.day]);
  // By day, nothing in Up to is a day with no set time between feeds (when hungry), as before.
  eq(inputOf({ ...was, onDemand: true, every: EMPTY_RANGE }).plan.day, { wake: true });
});

check("the night's turns by the clock: each turn's time goes with its turn, moved feeds take the place's time, and the form asks for one missing", () => {
  const d = draftOf(NEWER, null, "ml");
  const [nurse, , partner, cup] = d.feeds.map((f) => f.key);
  eq([d.night.byClock, d.night.order, d.night.starts], [true, [partner, nurse], ["22:00", "02:00"]]);
  eq(inputOf(d).plan.night, { from: "22:00", to: "06:00", every: { min: 180, max: 180 }, order: [3, 1], starts: ["22:00", "02:00"] });
  // Moved: the feeds change places, and the night's hours stay in order.
  const moved = setNightTurns(d, move(d.night.order, 1, -1));
  eq([moved.night.order, moved.night.starts, inputOf(moved).plan.night?.starts], [[nurse, partner], ["22:00", "02:00"], ["22:00", "02:00"]]);
  // Added, a feed has no time yet, and Save says so in the form's words; given one, it goes.
  const added = setNightTurns(d, [...d.night.order, cup]);
  eq([added.night.starts, refusal(added)], [["22:00", "02:00", ""], "Say when each of the night's feeds starts, or switch off By the clock."]);
  const timed = setNightStart(added, 2, "04:00");
  eq([refusal(timed), inputOf(timed).plan.night?.order, inputOf(timed).plan.night?.starts], [null, [3, 1, 4], ["22:00", "02:00", "04:00"]]);
  // Taken out of the night's turns, its time goes with it; one turn left is just the night's feed, with no time.
  const one = setNightTurns(d, [nurse]);
  eq([one.night.starts, inputOf(one).plan.night], [["02:00"], { from: "22:00", to: "06:00", every: { min: 180, max: 180 }, feed: 1 }]);
  // Switched off: the turns in order, no times sent (they stay in the draft, should it go back on).
  const off: PlanDraft = { ...d, night: { ...d.night, byClock: false } };
  eq([inputOf(off).plan.night?.starts, inputOf(off).plan.night?.order, off.night.starts], [undefined, [3, 1], ["22:00", "02:00"]]);
  // A feed taken out of the plan takes its time; Put it back brings both back.
  const out = takeOutFeed(d, partner);
  eq([out.next.night.order, out.next.night.starts], [[nurse], ["02:00"]]);
  eq(inputOf(out.putBack(out.next)), inputOf(d));
  eq(removeFeed(d, nurse).night.starts, ["22:00"]);
  // A time outside the night is the server's to say, in its words.
  eq(refusal(setNightStart(d, 1, "07:00")), "The night's turn 2 would start at 7 AM, outside the night (10 PM to 6 AM)");
  // A new night of two turns, By the clock on, its times still to type.
  const fresh = setNightTurns({ ...draftOf(PLAN, null, "ml"), night: { ...draftOf(PLAN, null, "ml").night, byClock: true } }, [d.feeds[0].key]);
  eq(fresh.night.starts, [""]);
});

check("nursing only if she wants to: sent as the plan's if_needed, and the bottle after it is the feed's, never a top-up", () => {
  const [practice, bottle] = newerSteps(1) as [NurseDraft, BottleDraft];
  eq([practice.if_needed, draftAfterNursing([practice, bottle], 1), stepTitle(bottle, draftAfterNursing([practice, bottle], 1))], [true, false, "Bottle"]);
  eq(sent(practice, bottle), [{ do: "nurse", minutes: { min: 5, max: 10 }, if_needed: true }, { do: "bottle", ml: { min: 60, max: 60 }, at_least: true, milk: "breastmilk", via: "paced" }]);
  const feed = draftOf(NEWER, null, "ml").feeds[1];
  eq(feedSummary(feed, "ml", null), "Offer the breast 5–10 min; then bottle at least 60 ml, breast milk, paced bottle");
  // Switched off, it's nursing again, and the bottle after it its top-up.
  const required = { ...practice, if_needed: false };
  eq([draftAfterNursing([required, bottle], 1), stepTitle(bottle, true)], [true, "Top-up"]);
  eq(feedSummary({ ...feed, steps: [required, bottle] }, "ml", null), "Nurse 5–10 min; then top up at least 60 ml, breast milk, paced bottle");
  eq(stepTitle(practice, false), "Nurse", "its switch says it's only if she wants to");
});

check("up to and at least: one number in one box, sent as the plan's one number with its flag, and switching keeps what's typed", () => {
  const bottle = { ...newStep("bottle"), ml: { min: 25, max: 35 } } as BottleDraft;
  const as = (amount: BottleDraft["amount"], ml = bottle.ml) => sent({ ...bottle, amount, ml })[0];
  eq([upToOf(bottle.ml), leastOf(bottle.ml)], [35, 25], "up to shows a range's To, at least its From");
  eq([as("up_to"), as("at_least"), as("ml"), as("target")], [
    { do: "bottle", ml: { min: 35, max: 35 }, up_to: true },
    { do: "bottle", ml: { min: 25, max: 25 }, at_least: true },
    { do: "bottle", ml: { min: 25, max: 35 } },
    { do: "bottle", to_target: true },
  ]);
  // Typed in the one box: up to sets its To, at least its From.
  eq([as("up_to", { ...bottle.ml, max: 40 }), as("at_least", { ...bottle.ml, min: 30 })], [{ do: "bottle", ml: { min: 40, max: 40 }, up_to: true }, { do: "bottle", ml: { min: 30, max: 30 }, at_least: true }]);
  // Nothing typed: the flag goes alone, and the server's words point at the step.
  const empty = { ...draftOf(null, null, "ml"), feeds: [{ ...newFeed("Bottle"), steps: [{ ...bottle, amount: "up_to", ml: EMPTY_RANGE } as StepDraft] }] };
  const words = refusal(empty);
  eq(words, '"Bottle" step 1: up to needs its number (the most milk)');
  eq(problemPlace(words!, empty), { feed: empty.feeds[0].key, step: empty.feeds[0].steps[0].key });
  // Minutes up to, on nursing and pumping.
  const [nurse] = newerSteps(0) as [NurseDraft];
  const pump = newerSteps(4)[2] as PumpDraft;
  eq([nurse.upTo, nurse.minutes, pump.upTo], [true, { min: 20, max: null }, true]);
  eq([sent(nurse)[0], sent(pump)[0]], [{ do: "nurse", minutes: { min: 20, max: 20 }, up_to: true, each_side: true }, { do: "pump", minutes: { min: 15, max: 15 }, up_to: true }]);
  eq(sent({ ...nurse, upTo: false, minutes: { min: 10, max: 20 } })[0], { do: "nurse", minutes: { min: 10, max: 20 }, each_side: true }, "switched off: the range as typed");
  eq(feedSummary(draftOf(NEWER, null, "ml").feeds[0], "ml", null), "Nurse up to 20 min each side");
  // At least 2 oz, typed in ounces, goes as ml and reads back in ounces.
  const oz = { ...draftOf(null, null, "oz"), feeds: [{ ...newFeed("Bottle"), steps: [{ ...bottle, amount: "at_least", ml: { min: typedAmount(2, "oz"), max: null } } as StepDraft] }] };
  const saved = parseFeedingPlan(inputOf(oz).plan, null, NOW);
  eq([saved.feeds[0].steps[0], feedText(saved.feeds[0], saved, null)], [{ do: "bottle", ml: { min: 59.1, max: 59.1 }, at_least: true }, "Bottle at least 2 oz"]);
});

check("how it's given: Bottle and Paced bottle are the bottle's way (via), Cup, Spoon and Finger instead of one (by), never both", () => {
  const bottle = { ...newStep("bottle"), ml: { min: 20, max: 30 } } as BottleDraft;
  const given = (g: BottleDraft["given"]) => sent({ ...bottle, given: g })[0];
  eq([given("paced"), given("bottle"), given("cup"), given("spoon"), given("finger"), given(null)], [
    { do: "bottle", ml: { min: 20, max: 30 }, via: "paced" },
    { do: "bottle", ml: { min: 20, max: 30 }, via: "bottle" },
    { do: "bottle", ml: { min: 20, max: 30 }, by: "cup" },
    { do: "bottle", ml: { min: 20, max: 30 }, by: "spoon" },
    { do: "bottle", ml: { min: 20, max: 30 }, by: "finger" },
    { do: "bottle", ml: { min: 20, max: 30 } },
  ]);
  const [cup] = newerSteps(3) as [BottleDraft];
  const [finger] = newerSteps(5) as [BottleDraft];
  const spoon = newerSteps(4)[1] as BottleDraft;
  eq([cup.given, spoon.given, finger.given, (newerSteps(2)[0] as BottleDraft).given], ["cup", "spoon", "finger", "paced"]);
  // On its own it's named for how it's given; after nursing it's the top-up, by spoon.
  eq([stepTitle(cup, false), stepTitle(finger, false), stepTitle(spoon, true), stepTitle({ ...cup, given: "paced" }, false)], ["Cup", "Finger feed", "Top-up", "Bottle"]);
  const d = draftOf(NEWER, null, "ml");
  eq([feedSummary(d.feeds[3], "ml", null), feedSummary(d.feeds[4], "ml", null), feedSummary(d.feeds[5], "ml", null)], [
    "Cup 20–30 ml, breast milk",
    "Nurse; then top up 10–15 ml by spoon if still hungry; then pump up to 15 min",
    "Finger feed 5 ml, breast milk",
  ]);
  // A name that says how it's given still says it once an edit gives it another way, as it does of a shield.
  const [cupFeed, , fingerFeed] = [d.feeds[3], d.feeds[4], d.feeds[5]];
  eq([staleNameWords(cupFeed, cupFeed), staleNameWords({ ...cupFeed, steps: [{ ...cup, given: "paced" }] }, cupFeed)], [[], ["cup"]]);
  eq(staleNameWords({ ...fingerFeed, steps: [{ ...finger, given: null }] }, fingerFeed), ["finger"]);
});

check("feeds and milk in 24 hours: at least, up to or both, the milk in ml whatever the unit, nothing at 0", () => {
  const d = draftOf(NEWER, null, "ml");
  eq(d.perDay, { feeds: { min: 8, max: null }, ml: { min: 450, max: 550 } });
  eq(inputOf(d).plan.per_day, { feeds: { min: 8 }, ml: { min: 450, max: 550 } });
  const lines = (x: PlanDraft) => perDayLines(parseFeedingPlan(inputOf(x).plan, null, NOW), false);
  eq(lines({ ...d, perDay: { feeds: { min: null, max: 10 }, ml: EMPTY_RANGE } }), ["Up to 10 feeds in 24 hours"]);
  eq(lines({ ...d, perDay: { feeds: { min: 8, max: 12 }, ml: { min: null, max: 700 } } }), ["8–12 feeds in 24 hours", "Up to 700 ml in 24 hours"]);
  eq(inputOf({ ...d, perDay: { feeds: { min: 0, max: null }, ml: EMPTY_RANGE } }).plan.per_day, undefined, "0 is nothing typed");
  eq(inputOf({ ...d, perDay: { feeds: EMPTY_RANGE, ml: EMPTY_RANGE } }).plan.per_day, undefined, "cleared: none");
  // In ounces: typed as oz, sent as ml, read back in oz.
  const oz = draftOf(HUNGRY, null, "oz");
  eq(oz.perDay, { feeds: { min: 8, max: 12 }, ml: { min: null, max: 709.8 } });
  const typed: PlanDraft = { ...oz, perDay: { ...oz.perDay, ml: { min: typedAmount(15, "oz"), max: typedAmount(18.5, "oz") } } };
  eq(inputOf(typed).plan.per_day, { feeds: { min: 8, max: 12 }, ml: { min: 443.6, max: 547.1 } });
  eq(perDayLines(parseFeedingPlan({ ...inputOf(typed).plan, base_rev: HUNGRY.rev }, HUNGRY, LATER), false), ["8–12 feeds in 24 hours", "15–18.5 oz in 24 hours"]);
  // A count that isn't whole is the server's to say.
  eq(refusal({ ...d, perDay: { feeds: { min: 8.5, max: null }, ml: EMPTY_RANGE } }), "Feeds in 24 hours is a whole number of feeds");
});

check("notes take up to 1,000 characters, sent whole", () => {
  const notes = `${LONG_NOTES} ${LONG_NOTES}`.slice(0, 1000);
  const d: PlanDraft = { ...draftOf(BARE, null, "ml"), notes };
  const saved = parseFeedingPlan({ ...inputOf(d).plan, base_rev: BARE.rev }, BARE, LATER);
  eq([planNotes(saved)?.length, (saved.notes ?? "").length <= NOTES_OLDER], [1000, true]);
  eq(refusal({ ...d, notes: `${notes}.` }), "The notes are too long (1000 characters at most)");
});

check("starting shapes: the everyday ones first (one feed each), a bottle and triple feeding among them, two feeds taking turns and Blank last", () => {
  eq(PLAN_SHAPES.map((s) => s.id), ["top-up", "bottle", "triple", "pump-bottle", "turns", "blank"]);
  eq(PLAN_SHAPES[0].feeds.length, 1, "the first is one feed, never two taking turns");
  const feeds = (id: string) => inputOf(draftFromShape(shape(id), null, "ml")).plan.feeds;
  eq(feeds("bottle"), [{ name: "Bottle", steps: [{ do: "bottle" }] }]);
  eq(feeds("triple"), [{ name: "Triple feed", steps: [{ do: "nurse" }, { do: "bottle" }, { do: "pump" }] }]);
  // Saved as they are (no numbers yet), each but Blank is a plan; triple feeding's bottle is its top-up.
  for (const s of PLAN_SHAPES.filter((x) => x.id !== "blank")) eq(refusal(draftFromShape(s, null, "ml")), null, s.title);
  const triple = draftFromShape(shape("triple"), null, "ml").feeds[0].steps;
  eq(triple.map((s, i) => stepTitle(s, draftAfterNursing(triple, i))), ["Nurse", "Top-up", "Pump"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

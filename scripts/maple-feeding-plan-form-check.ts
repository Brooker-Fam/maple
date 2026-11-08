/**
 * Assertions for the feeding plan's form as data (src/components/maple/feeding/planDraft.ts): a saved plan opened in
 * the sheet and saved untouched comes back the same plan, in ml or oz; the target per feed round-trips; switching ml
 * and oz never changes an amount; starting shapes fill in kinds of step and no numbers; taking a feed out keeps the
 * turns and the night whole; and a refusal's words point at the feed and step they're about.
 *
 *   npx tsx scripts/maple-feeding-plan-form-check.ts   (part of pnpm check:maple-feeding-plan)
 *
 * The plans here are invented examples, not any family's. One PASS/FAIL line per case, exit 1 on any failure.
 */
import { amountText, checkFeedingPlan, feedText, parseFeedingPlan, PlanError, type FeedingPlan } from "../src/lib/maple/feeding-plan";
import {
  addFeed,
  draftFromShape,
  draftOf,
  draftProblem,
  feedSummary,
  inputOf,
  move,
  newFeed,
  newStep,
  PLAN_SHAPES,
  planShortLine,
  problemPlace,
  removeFeed,
  samePlan,
  setNightFeed,
  shownAmount,
  takeOutFeed,
  typedAmount,
  type PlanDraft,
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
const same = (plan: FeedingPlan) => ({ ...plan, rev: plan.rev + 1, updated_at: LATER.toISOString() });

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
  const d: PlanDraft = draftFromShape(PLAN_SHAPES[2], null, "oz");
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
  const turns = draftFromShape(PLAN_SHAPES[0], null, "ml");
  const { plan: input } = inputOf(turns);
  eq(input.feeds, [
    { name: "Nurse, then pump", steps: [{ do: "nurse" }, { do: "pump" }] },
    { name: "Nurse, then top up", steps: [{ do: "nurse" }, { do: "bottle" }] },
  ]);
  eq([input.order, input.day, input.night, input.from], [[1, 2], {}, undefined, undefined]);
  // Saved as it is, it's a plan: what's left to add is numbers, never steps.
  eq(parseFeedingPlan(input, null, NOW).feeds.length, 2);
  const blank = inputOf(draftFromShape(PLAN_SHAPES[3], null, "ml")).plan;
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
  eq(removeFeed(d, night).night.feed, null);
  eq(removeFeed(d, sns).order, [topUp]);
  // The last feed in the turns out: the turns take another (not the night's).
  const one = { ...d, order: [sns] };
  eq(removeFeed(one, sns).order, [topUp]);
  // A feed made the night's leaves the turns, unless it's the only one there.
  d = setNightFeed(d, topUp);
  eq([d.night.feed, d.order], [topUp, [sns]]);
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
  eq([back.night.feed, inputOf(back).plan.order], [d.feeds[2].key, [1, 2, 4]]);
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
  eq([atNight.order, atNight.night.feed], [[sns, topUp], pump]);
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
  eq([kept.feeds.length, kept.night.feed, kept.order], [3, d.feeds[1].key, [d.feeds[0].key]]);
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
  const fresh = draftFromShape(PLAN_SHAPES[2], null, "ml");
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
  // "Pump + bottle" ends with a note: its steps, then the note.
  const steps = PLAN.feeds[2].steps.filter((s) => s.do !== "note");
  eq(feedSummary(d.feeds[2], "ml", target), `${feedText({ ...PLAN.feeds[2], steps }, PLAN, target)}. Burp halfway.`);
  // A note between steps still reads after them, as its own sentence.
  const [nurse, topUp] = d.feeds[1].steps;
  const note = (text: string) => ({ ...newStep("note"), text }) as StepDraft;
  const between = feedSummary({ ...d.feeds[1], steps: [nurse, note("only if still hungry"), topUp] }, "ml", target);
  eq(between, `${feedText(PLAN.feeds[1], PLAN, target)}. Only if still hungry.`);
  if (/then only/i.test(between)) throw new Error(`a note joined with "then": ${between}`);
  const nursing = feedText({ ...PLAN.feeds[1], steps: PLAN.feeds[1].steps.slice(0, 1) }, PLAN, target);
  eq(feedSummary({ ...d.feeds[1], steps: [nurse, note("Burp halfway!"), note("pump the right side;")] }, "ml", target), `${nursing}. Burp halfway! Pump the right side.`);
  // Not finished yet: an SNS with no amount is just its name, an empty note is "Note", and no steps says so.
  const sns = { ...newStep("nurse"), atBreast: "sns" } as StepDraft;
  eq(feedSummary({ ...d.feeds[0], steps: [sns, d.feeds[0].steps[1]] }, "ml", null), "Nurse; then pump 15 min");
  eq(feedSummary({ ...d.feeds[0], steps: [d.feeds[0].steps[1], note("")] }, "ml", null), "Pump 15 min. Note.");
  eq(feedSummary({ ...d.feeds[0], steps: [] }, "ml", null), "No steps yet");
});

check("the way in's line: who it's from and how many feeds, or the invitation", () => {
  eq([planShortLine(PLAN), planShortLine(BARE), planShortLine(null)], ["From Feeding clinic · 3 feeds", "1 feed", "Add your care team's plan"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

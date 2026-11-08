/**
 * The feeding plan's form, as data (FeedingPlanSheet.tsx draws it): a plan
 * (settings.feeding_plan) and the target per feed (settings.feed_target_ml)
 * turned into a draft the sheet edits, and the draft back into what PATCH
 * /api/maple/baby takes (parseFeedingPlan checks it there, and here first).
 *
 * Amounts are kept in ml and minutes in the draft, whatever the plan's unit,
 * so switching ml ↔ oz only changes how they're shown, never what they are;
 * they go to the server in ml. Feeds are referred to by their place in the
 * list sent (order and the night's feed: 1 is the first), and a feed the plan
 * already had keeps its id, so a feed logged under it stays that feed.
 *
 * Nothing here makes up a number: a starting shape fills in the kinds of
 * step and leaves every minute and amount for the family to copy from their
 * plan.
 */
import { stepText, type AtBreastVia, type FeedingPlan, type PlanBottleVia, type PlanMilk, type PlanStep, type PlanUnit, type Range } from "@/lib/maple/feeding-plan";
import { ML_PER_FL_OZ, type FeedTarget } from "@/lib/maple/units";

/** A from–to in minutes or ml; either end may be empty (one number is both ends). */
export type RangeDraft = { min: number | null; max: number | null };

export type NurseDraft = {
  key: string;
  do: "nurse";
  minutes: RangeDraft;
  each_side: boolean;
  shield: boolean;
  /** Milk at the breast: none, a syringe or an SNS. Its amount and milk stay in the draft while it's "none", so switching back keeps them. */
  atBreast: "none" | AtBreastVia;
  atBreastMl: RangeDraft;
  atBreastMilk: PlanMilk | null;
};
export type PumpDraft = { key: string; do: "pump"; minutes: RangeDraft };
export type BottleDraft = { key: string; do: "bottle"; amount: "ml" | "target"; ml: RangeDraft; milk: PlanMilk | null; via: PlanBottleVia | null };
export type NoteDraft = { key: string; do: "note"; text: string };
export type StepDraft = NurseDraft | PumpDraft | BottleDraft | NoteDraft;
export type StepKind = StepDraft["do"];

export type FeedDraft = { key: string; id: string | null; name: string; steps: StepDraft[] };
export type NightDraft = { on: boolean; from: string; to: string; every: RangeDraft; wake: boolean; feed: string | null };

export type PlanDraft = {
  from: string;
  check_in: string;
  unit: PlanUnit;
  /** The target per feed, in ml. */
  target: RangeDraft;
  /** By day, start to start, in minutes. */
  every: RangeDraft;
  wake: boolean;
  night: NightDraft;
  feeds: FeedDraft[];
  /** The day's turns, by feed key. */
  order: string[];
  notes: string;
};

/** A step as sent: a plan's step, except that milk at the breast may come without its amount (the server then says it's needed). */
export type PlanStepInput =
  | (Omit<Extract<PlanStep, { do: "nurse" }>, "supplement"> & { supplement?: { via: AtBreastVia; ml?: Range; milk?: PlanMilk } })
  | Exclude<PlanStep, { do: "nurse" }>;

/** What the sheet sends as settings.feeding_plan (base_rev is added by the sheet for an edit). */
export type PlanInput = {
  from?: string;
  check_in?: string;
  unit: PlanUnit;
  day: { every?: Range; wake?: true };
  night?: { from: string; to: string; every?: Range; wake?: true; feed?: number };
  feeds: { id?: string; name: string; steps: PlanStepInput[] }[];
  order?: number[];
  notes?: string;
};

let seq = 0;
const nextKey = (p: string) => `${p}${++seq}`;
const feedKey = (id: string) => `f:${id}`;

export const EMPTY_RANGE: RangeDraft = { min: null, max: null };
const NIGHT_OFF: NightDraft = { on: false, from: "", to: "", every: EMPTY_RANGE, wake: false, feed: null };

/** A saved range as the form shows it: one number is just the first box ("15 to [ ] min"). */
const rangeOf = (r: Range | FeedTarget | null | undefined): RangeDraft => (r ? { min: r.min, max: r.max === r.min ? null : r.max } : EMPTY_RANGE);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A from–to as the server takes it, smallest first; one end alone is both ends; nothing typed is undefined. */
export function rangeOut(r: RangeDraft): Range | undefined {
  const a = r.min ?? r.max;
  const b = r.max ?? r.min;
  if (a == null || b == null) return undefined;
  return { min: round1(Math.min(a, b)), max: round1(Math.max(a, b)) };
}

export const isEmptyRange = (r: RangeDraft) => r.min == null && r.max == null;

// ── showing amounts ────────────────────────────────────────────────────────

/** ml as shown in the plan's unit (oz to 2 places, ml to 1), for a field. */
export function shownAmount(ml: number | null, unit: PlanUnit): number | null {
  if (ml == null) return null;
  return unit === "oz" ? Math.round((ml / ML_PER_FL_OZ) * 100) / 100 : round1(ml);
}

/** A number typed in the plan's unit, as ml (unrounded, so oz → ml → oz shows what was typed). */
export const typedAmount = (n: number | null, unit: PlanUnit): number | null => (n == null ? null : unit === "oz" ? n * ML_PER_FL_OZ : n);

/** The most a field takes, in the plan's unit (PLAN_LIMITS.ml is 300 ml). */
export const amountMax = (unit: PlanUnit) => (unit === "oz" ? Math.round((300 / ML_PER_FL_OZ) * 100) / 100 : 300);

// ── a plan to a draft, and back ───────────────────────────────────────────

function stepDraftOf(s: PlanStep): StepDraft {
  const key = nextKey("s");
  if (s.do === "nurse") {
    return {
      key,
      do: "nurse",
      minutes: rangeOf(s.minutes),
      each_side: !!s.each_side,
      shield: !!s.shield,
      atBreast: s.supplement?.via ?? "none",
      atBreastMl: rangeOf(s.supplement?.ml),
      atBreastMilk: s.supplement?.milk ?? null,
    };
  }
  if (s.do === "pump") return { key, do: "pump", minutes: rangeOf(s.minutes) };
  if (s.do === "bottle") return { key, do: "bottle", amount: s.to_target && !s.ml ? "target" : "ml", ml: rangeOf(s.ml), milk: s.milk ?? null, via: s.via ?? null };
  return { key, do: "note", text: s.text };
}

/** A new step of a kind, with nothing filled in. */
export function newStep(kind: StepKind): StepDraft {
  const key = nextKey("s");
  if (kind === "nurse") return { key, do: "nurse", minutes: EMPTY_RANGE, each_side: false, shield: false, atBreast: "none", atBreastMl: EMPTY_RANGE, atBreastMilk: null };
  if (kind === "pump") return { key, do: "pump", minutes: EMPTY_RANGE };
  if (kind === "bottle") return { key, do: "bottle", amount: "ml", ml: EMPTY_RANGE, milk: null, via: null };
  return { key, do: "note", text: "" };
}

export function newFeed(name = "", kinds: StepKind[] = []): FeedDraft {
  return { key: nextKey("n"), id: null, name, steps: kinds.map(newStep) };
}

/** The saved plan (or none) and target as a draft; a new plan shows amounts in `unit`. */
export function draftOf(plan: FeedingPlan | null, target: FeedTarget | null, unit: PlanUnit): PlanDraft {
  if (!plan) return { from: "", check_in: "", unit, target: rangeOf(target), every: EMPTY_RANGE, wake: false, night: NIGHT_OFF, feeds: [], order: [], notes: "" };
  const feeds: FeedDraft[] = plan.feeds.map((f) => ({ key: feedKey(f.id), id: f.id, name: f.name, steps: f.steps.map(stepDraftOf) }));
  const known = (k: string) => feeds.some((f) => f.key === k);
  const n = plan.night;
  return {
    from: plan.from ?? "",
    check_in: plan.check_in ?? "",
    unit: plan.unit,
    target: rangeOf(target),
    every: rangeOf(plan.day.every),
    wake: !!plan.day.wake,
    night: n ? { on: true, from: n.from, to: n.to, every: rangeOf(n.every), wake: !!n.wake, feed: n.feed && known(feedKey(n.feed)) ? feedKey(n.feed) : null } : NIGHT_OFF,
    feeds,
    order: plan.order.map(feedKey).filter(known),
    notes: plan.notes ?? "",
  };
}

const text = (s: string) => s.replace(/\s+/g, " ").trim();

function stepOut(s: StepDraft): PlanStepInput {
  if (s.do === "nurse") {
    const minutes = rangeOut(s.minutes);
    const ml = rangeOut(s.atBreastMl);
    return {
      do: "nurse",
      ...(minutes ? { minutes } : {}),
      ...(s.each_side ? { each_side: true } : {}),
      ...(s.shield ? { shield: true } : {}),
      // No amount typed: sent as it is, and the check says what's missing ("say how much milk goes in the syringe").
      ...(s.atBreast !== "none" ? { supplement: { via: s.atBreast, ...(ml ? { ml } : {}), ...(s.atBreastMilk ? { milk: s.atBreastMilk } : {}) } } : {}),
    };
  }
  if (s.do === "pump") {
    const minutes = rangeOut(s.minutes);
    return { do: "pump", ...(minutes ? { minutes } : {}) };
  }
  if (s.do === "bottle") {
    const ml = s.amount === "ml" ? rangeOut(s.ml) : undefined;
    return { do: "bottle", ...(s.amount === "target" ? { to_target: true } : ml ? { ml } : {}), ...(s.milk ? { milk: s.milk } : {}), ...(s.via ? { via: s.via } : {}) };
  }
  return { do: "note", text: text(s.text) };
}

/** The draft as PATCH /api/maple/baby takes it: the plan's input (amounts in ml) and the target per feed (ml, or null for none). */
export function inputOf(d: PlanDraft): { plan: PlanInput; target: FeedTarget | null } {
  const place = (key: string | null) => (key ? d.feeds.findIndex((f) => f.key === key) + 1 : 0);
  const every = rangeOut(d.every);
  const order = d.order.map(place).filter((i) => i > 0);
  const plan: PlanInput = {
    ...(text(d.from) ? { from: text(d.from) } : {}),
    ...(d.check_in ? { check_in: d.check_in } : {}),
    unit: d.unit,
    day: { ...(every ? { every } : {}), ...(d.wake ? { wake: true as const } : {}) },
    feeds: d.feeds.map((f) => ({ ...(f.id ? { id: f.id } : {}), name: text(f.name), steps: f.steps.map(stepOut) })),
    ...(order.length ? { order } : {}),
    ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
  };
  if (d.night.on) {
    const nightEvery = rangeOut(d.night.every);
    const feed = place(d.night.feed);
    plan.night = { from: d.night.from, to: d.night.to, ...(nightEvery ? { every: nightEvery } : {}), ...(d.night.wake ? { wake: true as const } : {}), ...(feed > 0 ? { feed } : {}) };
  }
  const target = rangeOut(d.target);
  return { plan, target: target ?? null };
}

const json = (v: unknown) => JSON.stringify(v);
export const samePlan = (a: PlanDraft, b: PlanDraft) => json(inputOf(a).plan) === json(inputOf(b).plan);
export const sameTarget = (a: FeedTarget | null, b: FeedTarget | null) => json(a ? rangeOut(a) : null) === json(b ? rangeOut(b) : null);

// ── changing the draft ────────────────────────────────────────────────────

/** A feed's name for lists, or its place when it has none yet ("Feed 2"). */
export const feedLabel = (d: Pick<PlanDraft, "feeds">, key: string) => {
  const i = d.feeds.findIndex((f) => f.key === key);
  const name = d.feeds[i]?.name.trim();
  return name || `Feed ${i + 1}`;
};

/** A feed added: it takes a turn by day (most do; the night's is picked below). */
export function addFeed(d: PlanDraft, feed: FeedDraft = newFeed()): PlanDraft {
  return { ...d, feeds: [...d.feeds, feed], order: [...d.order, feed.key] };
}

/** A feed taken out: out of the turns and the night too; the turns never end up empty while there's a feed. */
export function removeFeed(d: PlanDraft, key: string): PlanDraft {
  const feeds = d.feeds.filter((f) => f.key !== key);
  const night = d.night.feed === key ? { ...d.night, feed: null } : d.night;
  let order = d.order.filter((k) => k !== key);
  if (!order.length && feeds.length) order = [(feeds.find((f) => f.key !== night.feed) ?? feeds[0]).key];
  return { ...d, feeds, night, order };
}

/**
 * `key` back among `now` where it was in `was`, among the ones still there:
 * right after the nearest one it came after, else right before the nearest one
 * it came before, else at its old place.
 */
function placeBack(now: readonly string[], was: readonly string[], key: string): string[] {
  const j = was.indexOf(key);
  const at = (i: number) => [...now.slice(0, i), key, ...now.slice(i)];
  for (let k = j - 1; k >= 0; k--) if (now.includes(was[k])) return at(now.indexOf(was[k]) + 1);
  for (let k = j + 1; k < was.length; k++) if (now.includes(was[k])) return at(now.indexOf(was[k]));
  return at(Math.min(Math.max(j, 0), now.length));
}

/**
 * A feed taken out (removeFeed), and Put it back, on the draft as it is by
 * then: the feed back in its place, its turn back where it was among the turns
 * still there (after the turn it followed), and the night's feed again if it
 * was and no other has been picked since. A turn handed to another feed only
 * because the turns would otherwise be empty is taken back. Anything else
 * changed meanwhile stays changed: turns moved, added or taken out, and a feed
 * made the night's (it stays out of the day's turns).
 */
export function takeOutFeed(before: PlanDraft, key: string): { next: PlanDraft; putBack: (d: PlanDraft) => PlanDraft } {
  const feed = before.feeds.find((f) => f.key === key);
  const next = removeFeed(before, key);
  const filled = next.order.filter((k) => !before.order.includes(k));
  const putBack = (d: PlanDraft): PlanDraft => {
    if (!feed || d.feeds.some((f) => f.key === key)) return d;
    const byKey = new Map([...d.feeds, feed].map((f) => [f.key, f]));
    const feeds = placeBack(d.feeds.map((f) => f.key), before.feeds.map((f) => f.key), key).map((k) => byKey.get(k)!);
    const turns = d.order.filter((k) => !filled.includes(k));
    const order = before.order.includes(key) ? placeBack(turns, before.order, key) : turns;
    const night = before.night.feed === key && !d.night.feed ? { ...d.night, feed: key } : d.night;
    return { ...d, feeds, order, night };
  };
  return { next, putBack };
}

/** The night's own feed: it leaves the day's turns (the night's feed doesn't take a day turn), unless it's the only one there. */
export function setNightFeed(d: PlanDraft, key: string | null): PlanDraft {
  const order = key && d.order.length > 1 ? d.order.filter((k) => k !== key) : d.order;
  return { ...d, night: { ...d.night, feed: key }, order };
}

export function move<T>(list: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ── starting shapes (a new plan) ───────────────────────────────────────────

export type PlanShape = { id: string; title: string; sub: string; feeds: { name: string; kinds: StepKind[] }[] };

/** The kinds of step only: every minute and amount is left to copy from the plan. */
export const PLAN_SHAPES: PlanShape[] = [
  {
    id: "turns",
    title: "Two feeds taking turns",
    sub: "Nurse, then pump · nurse, then top up",
    feeds: [
      { name: "Nurse, then pump", kinds: ["nurse", "pump"] },
      { name: "Nurse, then top up", kinds: ["nurse", "bottle"] },
    ],
  },
  { id: "top-up", title: "Nurse, then top up", sub: "Nursing, then a bottle", feeds: [{ name: "Nurse, then top up", kinds: ["nurse", "bottle"] }] },
  { id: "pump-bottle", title: "Pump and bottle", sub: "Pumping, then a bottle", feeds: [{ name: "Pump and bottle", kinds: ["pump", "bottle"] }] },
  { id: "blank", title: "Blank", sub: "One feed to fill in", feeds: [{ name: "", kinds: [] }] },
];

export function draftFromShape(shape: PlanShape, target: FeedTarget | null, unit: PlanUnit): PlanDraft {
  return shape.feeds.reduce((d, f) => addFeed(d, newFeed(f.name, f.kinds)), draftOf(null, target, unit));
}

// ── words ──────────────────────────────────────────────────────────────────

/** The way in's second line (Settings, More): who it's from and how many feeds, or the invitation to add one. */
export function planShortLine(plan: FeedingPlan | null): string {
  if (!plan) return "Add your care team's plan";
  const n = plan.feeds.length;
  return [plan.from ? `From ${plan.from}` : null, `${n} ${n === 1 ? "feed" : "feeds"}`].filter(Boolean).join(" · ");
}

/**
 * A feed's steps in one line, the way the plan reads them (feedText's words),
 * for a folded feed on the form; a step still missing what its words need
 * ("SNS", no amount yet) is just its name.
 */
export function feedSummary(f: FeedDraft, unit: PlanUnit, target: FeedTarget | null): string {
  let nursed = false;
  const parts = f.steps.map((s, i) => {
    const out = stepOut(s);
    let words: string;
    try {
      words = out.do === "note" ? out.text || "Note" : stepText(out as PlanStep, { unit }, target, { afterNurse: nursed });
    } catch {
      words = stepTitle(s, nursed);
    }
    if (s.do === "nurse") nursed = true;
    return i === 0 ? words : `then ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
  });
  return parts.length ? parts.join("; ") : "No steps yet";
}

/** A step's name on its card: a bottle after nursing is the top-up. */
export function stepTitle(s: StepDraft | PlanStep, afterNurse: boolean): string {
  if (s.do === "nurse") return "Nurse";
  if (s.do === "pump") return "Pump";
  if (s.do === "bottle") return afterNurse ? "Top-up" : "Bottle";
  return "Note";
}

/**
 * Which feed and step a refusal is about (parseFeedingPlan's words: "Feed 2's
 * name is needed", '"Nurse + SNS" step 3: the minutes must be between 1 and
 * 120'), so the form can mark it. Null when it's about the plan as a whole.
 */
export function problemPlace(message: string, d: Pick<PlanDraft, "feeds">): { feed: string; step: string | null } | null {
  const byIndex = /^Feed (\d+)\b/.exec(message);
  if (byIndex) {
    const f = d.feeds[Number(byIndex[1]) - 1];
    return f ? { feed: f.key, step: null } : null;
  }
  const byName = /^"(.+?)" (?:step (\d+)|needs|has|nurses)/.exec(message);
  if (!byName) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const f = d.feeds.find((x) => norm(x.name) === norm(byName[1]));
  if (!f) return null;
  const step = byName[2] ? f.steps[Number(byName[2]) - 1]?.key ?? null : null;
  return { feed: f.key, step };
}

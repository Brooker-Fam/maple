/**
 * What Today's Next feed card (NextFeedCard.tsx) shows, worked out from the
 * plan read against the log (feedingPlanOf + feedPlanNow): one row per step
 * of the feed in focus, in the plan's own words (stepText), its state (to do,
 * going, logged, a note), what was logged for it, and the one action, on the
 * next physical step: what the parent does next. While she's on the breast,
 * nothing else can be done, so only her milk at the breast (if it's still to
 * log); once she's off, the next step (Start pumping); while a pump runs, a
 * bottle still to give (one parent pumps while the other gives it). Milk at
 * the breast nobody logged becomes a small second link on the nursing row
 * once the action has moved on, and a bottle short of its amount ("up to
 * 50–70 ml", pumped milk then formula to finish) says what's given, offers
 * the rest, and a quiet "She's done" to leave it as it is. A step only if
 * needed ("if still hungry") never takes the big button from one that isn't,
 * and has a quiet "Not needed". A feed that pumps first (the night's) offers
 * its bottle as a quiet second action before the pump, so whichever parent is
 * up first can start (one pumps while the other gives the bottle). For a
 * finished feed with a step nobody logged (never one only if needed): what
 * isn't logged and the fix for each. A feed where she only nursed, in a plan
 * feed with no nursing (comfort nursing in the night feed's place,
 * PlanFeedView.nursedOnly), reads as what happened: the plan's words, nothing
 * to do and nothing owed.
 *
 * Every amount and minute here is the plan's or the log's, in the plan's
 * unit: nothing is made up. A bottle preset from the plan says its milk and
 * amount outright, null where the plan leaves them open, so the form never
 * copies the last bottle's: the milk the plan names, breast milk with no
 * amount for the first bottle of "pumped milk first, then formula to finish"
 * (what was pumped is the family's to say; the form shows the target) and
 * formula to finish it; either milk, or none named, is the family's to say.
 * A feed's part (a top-up, milk at the breast) names its feed (top_up_of),
 * and the plan feed too only when the log or the family said which it was:
 * a feed Maple only took for the order's turn gets no plan tag on its parts,
 * so what was logged with it decides.
 */
import { bottleAmount, isTracked, minutesShort, openSegment, other, type NursingRun } from "@/lib/maple/feed";
import {
  AT_BREAST_WORDS,
  amountText,
  dueText,
  ifNeeded,
  PLAN_PUMP_EARLY_MS,
  stepText,
  type BottleStep,
  type FeedingPlan,
  type FeedPlanNow,
  type NurseStep,
  type PlanDue,
  type PlanFeedView,
  type PlanMilk,
  type Range,
  type StepView,
} from "@/lib/maple/feeding-plan";
import type { Entry, EntryOf, FeedData, Side } from "@/lib/maple/types";
import type { FeedTarget } from "@/lib/maple/units";

/** The milk a plan names, as the log keeps it: formula or breast milk (either, or pumped milk then formula, is the family's to say). */
export function namedMilk(m: PlanMilk | undefined): "formula" | "breastmilk" | undefined {
  return m === "formula" || m === "breastmilk" ? m : undefined;
}

/**
 * The view's newer fields from the engine (PlanFeedView.named, .nursedOnly), read through a widened type: an engine
 * without them reads them here by the same rule.
 */
type ViewWith = PlanFeedView & { named?: number | null; nursedOnly?: boolean };
const hasNamed = (v: PlanFeedView) => "named" in v;

/**
 * The one moment a plan feed is named by in words ("the 2:00 AM feed"): its first nursing or first bottle, never a
 * pump begun before it (PlanFeedView.named); null for a feed with only a pump logged so far, or none.
 */
export function namedAt(view: PlanFeedView | null | undefined): number | null {
  if (!view) return null;
  return hasNamed(view) ? ((view as ViewWith).named ?? null) : (view.group?.start ?? null);
}

/**
 * Whether all that's logged of a plan feed is nursing, in a feed that has no nursing step (comfort nursing in the
 * night feed's place, PlanFeedView.nursedOnly): it reads as what happened, with nothing of the plan's to do or owed.
 */
export function nursedOnly(view: PlanFeedView | null | undefined): boolean {
  if (!view) return false;
  if (hasNamed(view)) return !!(view as ViewWith).nursedOnly;
  return view.extraNursing && !view.group?.bottles.length && !view.group?.pumps.length && view.steps.every((s) => s.entries.length === 0);
}

const MILK_WORD: Record<"formula" | "breastmilk", string> = { formula: "formula", breastmilk: "breast milk" };
const SIDE_WORD: Record<Side, string> = { L: "Left", R: "Right" };

/** One bottle logged in one tap: the button's words, what it saves, and the toast after. */
export type OneTapLog = {
  label: string;
  aria: string;
  /** The toast's words before " · 9:42 AM". */
  toast: string;
  data: FeedData;
  /** When it was given: the end of the nursing it went with (a feed already over), else now. */
  started_at?: string;
};

/** A step's action (the next physical step carries it, and only that one), or a row's second link. */
export type StepAction =
  /**
   * Start nursing: the suggested side big, the other beside it (the plan's shield and feed go with the start); a
   * step on one side (`side`, "left only") offers only that side.
   */
  | { kind: "nurse"; shield: boolean; side?: Side }
  | { kind: "pump" }
  /**
   * Open a form, prefilled from the plan: the bottle form ("Log bottle", "Log top-up", "Log formula to finish",
   * milk at the breast as a range), or (a pump nobody logged) the pump form. A bottle preset always says milk and
   * amount_ml: a value, or null where the plan leaves it open (the form leaves it blank). `hint`: what the amount
   * left open is up to ("Up to 50–70 ml in all", the night's pumped milk), for a button that shows it.
   */
  | { kind: "form"; sheet: "feed" | "pump"; label: string; aria: string; preset: Record<string, unknown>; hint?: string }
  /** Log it in one tap. */
  | { kind: "log"; log: OneTapLog }
  /** Formula or breast milk (the plan says either, or names none): one tap each, neither the default. */
  | { kind: "choose"; prompt: string; options: OneTapLog[] };

export type StepRow = {
  key: string;
  /** Its number among the steps that aren't notes; null for a note. */
  n: number | null;
  /** todo: still to do; running: its timer is going; done: logged; note: the plan's note, a plain line. */
  state: "todo" | "running" | "done" | "note";
  /** The plan's words for it ("Nurse 12–18 min, 20 ml of formula in the SNS"), or, once logged, what was ("Nursed 14m · 20 ml in the SNS"). */
  text: string;
  /** How it's going ("Nursing now · 8m", "Left 11m · Right next"), or what's logged of a step half done ("Nursed 14m", "Gave 40 ml · up to 50–70 ml"). */
  status: string | null;
  /** The next physical step's action: on one row at most, and on none while nothing can be done yet. */
  action: StepAction | null;
  /**
   * A small link beside the row: her milk at the breast nobody logged, once she's off and the action has moved on to
   * the next step; or a step only if needed whose turn has come while another step has the big button.
   */
  secondary: StepAction | null;
  /**
   * A quiet way to say the step is finished as it is: "She's done" on a bottle short of its amount, "Not needed" on
   * a step only if needed. The card sets the row aside on this phone (as Got it), and from then on shows it done;
   * nothing is logged.
   */
  close: string | null;
  /** A step only if needed (a top-up if she's still hungry, a pump if still full): set aside, it reads "Not needed". */
  optional: boolean;
};

/** What a step only if needed says once it's set aside on this phone. */
export const NOT_NEEDED = "Not needed";

/** The baby's words for "She's done": BabyWords.Hes ("She's", "He's", "River's"). Without them, the name-free form. */
export type RowWords = { Hes: string };
const THE_BABY: RowWords = { Hes: "The baby's" };

type Ctx = {
  plan: FeedingPlan;
  target: FeedTarget | null;
  feedId: string;
  /** The newest nursing entry of the feed (a saved one), for a late top-up's top_up_of. */
  nursingId: number | null;
  /** When its nursing ended (ISO), null while she's on the breast or with no nursing. */
  nursingEnd: string | null;
  /**
   * Whether a part of the feed (a top-up, milk at the breast) carries the plan feed's tag: not when Maple only took
   * the feed for the order's turn (why "order"), since a tag would then outrank what was logged with it.
   */
  tagParts: boolean;
};

/** The view model's context for a feed: its plan feed, its newest nursing entry and when that nursing ended. */
function ctxFor(fp: FeedPlanNow, view: PlanFeedView): Ctx {
  const nursing = nursingOf(view);
  return { plan: fp.plan, target: fp.target, feedId: view.feed.id, nursingId: nursing.id, nursingEnd: nursing.end, tagParts: view.why !== "order" };
}

const isBottle = (e: Entry): e is EntryOf<"feed"> => e.kind === "feed" && e.data.method === "bottle";
const ml1 = (ml: number) => ({ min: ml, max: ml });
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The newest saved nursing entry of a feed and when its nursing ended. */
export function nursingOf(view: PlanFeedView | null): { id: number | null; end: string | null } {
  const run = view?.group?.run;
  if (!run) return { id: null, end: null };
  const saved = run.entries.filter((e) => e.id > 0);
  const last = saved.reduce<EntryOf<"feed"> | null>((a, e) => (!a || Date.parse(e.started_at) >= Date.parse(a.started_at) ? e : a), null);
  return { id: last?.id ?? null, end: run.end !== null && !run.live ? new Date(run.end).toISOString() : null };
}

/**
 * The milk given at the breast with a nursing step: one tap when the plan's amount is one number (its milk when
 * the plan names it, else Formula or Breast milk, one tap each); a range opens the bottle form. `compact` (the
 * missed line's single link): the form instead of the two choices.
 */
function milkAction(s: NurseStep, c: Ctx, opts: { compact?: boolean } = {}): StepAction | null {
  const sup = s.supplement;
  if (!sup) return null;
  const words = AT_BREAST_WORDS[sup.via];
  const amount = amountText(sup.ml, c.plan.unit);
  const link = c.nursingId ? { top_up_of: c.nursingId } : {};
  const at = c.nursingEnd ? { started_at: c.nursingEnd } : {};
  const tag = c.tagParts ? { plan: c.feedId } : {};
  const data = (milk: "formula" | "breastmilk"): FeedData => ({ method: "bottle", amount_ml: sup.ml.min, milk, via: sup.via, ...tag, ...link });
  // Each name starts with the words on the button (what a voice-control user says to tap it).
  const one = (milk: "formula" | "breastmilk", label: string, aria: string): OneTapLog => ({
    label,
    aria,
    toast: `${amount} of ${MILK_WORD[milk]} ${words.inThe}`,
    data: data(milk),
    ...at,
  });
  const single = sup.ml.min === sup.ml.max;
  const milk = namedMilk(sup.milk);
  const log = `Log ${amount} ${words.inThe}`;
  if (single && milk) return { kind: "log", log: one(milk, log, `${log}, ${MILK_WORD[milk]}`) };
  // Either milk, none named (common on a handwritten sheet), or pumped milk first: the family says which, in one tap.
  if (single && !opts.compact) {
    const what = `log ${amount} ${words.inThe}`;
    return { kind: "choose", prompt: `${log}:`, options: [one("formula", "Formula", `Formula: ${what}`), one("breastmilk", "Breast milk", `Breast milk: ${what}`)] };
  }
  // A range (or the missed line's link): the bottle form, with the plan's amount (the smaller), its milk said outright, and how it was given.
  const preset = { method: "bottle", amount_ml: sup.ml.min, milk: milk ?? (sup.milk === "breastmilk_first" ? "breastmilk" : null), via: sup.via, ...tag, ...link, ...at };
  const label = `Log milk ${words.inThe}`;
  return { kind: "form", sheet: "feed", label, aria: `${label}: ${amount}, opens the bottle form`, preset };
}

/**
 * A bottle preset from the plan: milk and amount said outright (null: the plan leaves it open), how it's given, the
 * plan's feed, and the feed a top-up is for. A top-up is a part of its nursing feed: it carries the plan feed's tag
 * only when the feed's own was said (Ctx.tagParts); a bottle feed's own bottle always does (the night's second
 * bottle joins its first by it).
 */
function bottlePreset(s: BottleStep, afterNurse: boolean, c: Ctx, fill: { amount_ml: number | null; milk: "formula" | "breastmilk" | null }): Record<string, unknown> {
  return {
    method: "bottle",
    amount_ml: fill.amount_ml,
    milk: fill.milk,
    ...(s.via ? { via: s.via } : {}),
    ...(!afterNurse || c.tagParts ? { plan: c.feedId } : {}),
    // A top-up names its feed, so given late it's still that feed's, not a feed of its own.
    ...(afterNurse && c.nursingId ? { top_up_of: c.nursingId } : {}),
  };
}

/**
 * A bottle step nothing's logged for yet: the bottle form with the plan's amount (or the target's smaller one), the
 * milk it names, and how it's given. Pumped milk first, then formula to finish: this is the pumped milk, breast milk
 * with no amount (how much was pumped is the family's to say), and the hint says what the whole bottle is up to.
 */
function bottleAction(s: BottleStep, afterNurse: boolean, c: Ctx, need: Range | null): StepAction {
  const label = afterNurse ? "Log top-up" : "Log bottle";
  if (s.milk === "breastmilk_first") {
    const hint = need ? `Up to ${amountText(need, c.plan.unit)} in all` : undefined;
    const aria = `${label}: ${hint ? `${hint.charAt(0).toLowerCase()}${hint.slice(1)}, ` : ""}opens the bottle form`;
    return { kind: "form", sheet: "feed", label, aria, preset: bottlePreset(s, afterNurse, c, { amount_ml: null, milk: "breastmilk" }), ...(hint ? { hint } : {}) };
  }
  const amount = s.ml?.min ?? (s.to_target ? c.target?.min : undefined) ?? null;
  return { kind: "form", sheet: "feed", label, aria: `${label}: opens the bottle form`, preset: bottlePreset(s, afterNurse, c, { amount_ml: amount, milk: namedMilk(s.milk) ?? null }) };
}

/** A bottle step with some given, short of its amount (StepView.need). */
const short = (v: StepView) => v.step.do === "bottle" && v.status === "todo" && v.need !== null && v.entries.length > 0;

/**
 * The rest of a bottle short of its amount: its milk (formula for pumped milk first, else the plan's) and its words.
 * Pumped milk first, then formula to finish: "formula to finish", until some formula is in; then, as for any other
 * bottle, "the rest of the bottle" (or of the top-up), so the line never says the formula wasn't logged once it was.
 */
function restWords(s: BottleStep, v: StepView, afterNurse: boolean): { milk: "formula" | "breastmilk" | null; what: string } {
  const rest = afterNurse ? "the rest of the top-up" : "the rest of the bottle";
  if (s.milk !== "breastmilk_first") return { milk: namedMilk(s.milk) ?? null, what: rest };
  const formulaIn = v.entries.some((e) => isBottle(e) && (e.data.milk === "formula" || e.data.milk === "mixed"));
  return { milk: "formula", what: formulaIn ? rest : "formula to finish" };
}

/**
 * The rest of a bottle short of its amount, in the bottle form: the amount to reach (need.min) less what's given,
 * in its milk (restWords). `at`: when it was given, for a feed already over (the missed line).
 */
function finishAction(s: BottleStep, v: StepView, afterNurse: boolean, c: Ctx, at?: string): StepAction {
  const rest = round1((v.need?.min ?? 0) - (v.ml ?? 0));
  const { milk, what } = restWords(s, v, afterNurse);
  const label = `Log ${what}`;
  const preset = { ...bottlePreset(s, afterNurse, c, { amount_ml: rest, milk }), ...(at ? { started_at: at } : {}) };
  return { kind: "form", sheet: "feed", label, aria: `${label}: ${amountText(ml1(rest), c.plan.unit)}, opens the bottle form`, preset };
}

/**
 * The milk counted on a nursing step, by how it was given, in the plan's unit: "20 ml in the SNS", "21 ml by bottle"
 * (logged as a bottle, none of it in a syringe or an SNS), "20 ml in the syringe + 10 ml by bottle"; "milk in the
 * SNS" with no amount.
 */
function atBreastWords(s: NurseStep, entries: readonly Entry[], c: Ctx): string | null {
  if (!s.supplement) return null;
  const milk = entries.filter(isBottle);
  if (!milk.length) return null;
  const how = (e: EntryOf<"feed">) => (e.data.via === "syringe" || e.data.via === "sns" ? e.data.via : "bottle");
  return (["syringe", "sns", "bottle"] as const)
    .flatMap((way) => {
      const list = milk.filter((e) => how(e) === way);
      if (!list.length) return [];
      let ml: number | null = null;
      for (const e of list) {
        const a = bottleAmount(e.data);
        if (a != null) ml = round1((ml ?? 0) + a);
      }
      const words = way === "bottle" ? "by bottle" : AT_BREAST_WORDS[way].inThe;
      return [ml != null ? `${amountText(ml1(ml), c.plan.unit)} ${words}` : `milk ${words}`];
    })
    .join(" + ");
}

/** Whether a nursing step's milk at the breast is still to log (she's on, or done, with none logged). */
const milkLeft = (v: StepView) => v.step.do === "nurse" && !!v.step.supplement && v.status !== "todo" && !v.entries.some(isBottle);

/** "Left 11m · Right next", then "Left 12m · Right 4m": an each-side step's sides so far (null when they can't be told apart: back and forth, untimed). */
function sidesSoFar(run: NursingRun): string | null {
  if (run.backAndForth || run.min.has.B) return null;
  const sides = [...new Set(run.order.filter(isTracked))];
  if (!sides.length) return null;
  const side = (s: Side) => `${SIDE_WORD[s]} ${minutesShort(s === "L" ? run.min.left : run.min.right)}`;
  return sides.length === 1 ? `${side(sides[0])} · ${SIDE_WORD[other(sides[0])]} next` : sides.map(side).join(" · ");
}

/**
 * Which step is next: the next physical step. None while she's on the breast (or on a break in a feed still going):
 * nothing else can be done yet. While a pump runs, the first bottle still to give. Otherwise the first step still to
 * do (not logged, or a bottle short of its amount); none when nothing is. A step only if needed is next only when no
 * step that isn't is left: it never takes the big button from one.
 */
function nextStep(view: PlanFeedView, closed: (v: StepView) => boolean): number | null {
  if (view.group?.run?.live) return null;
  const pumping = view.steps.some((v) => v.step.do === "pump" && v.status === "running");
  const todo = view.steps.filter((v) => v.status === "todo" && !closed(v) && (!pumping || v.step.do === "bottle"));
  return (todo.find((v) => !ifNeeded(v.step)) ?? todo[0])?.i ?? null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The feed in focus, step by step. Upcoming: the plan's words, numbered, the
 * first step with its action. Underway: each step's state; a step logged says
 * what was ("Nursed 14m · 20 ml in the SNS", "Pumped 15m", "Gave 30 ml"), one
 * going says so ("Nursing now · 8m", "Left 11m · Right next", "Pumping now ·
 * 6m"), a bottle short of its amount says what's given against it, and the
 * next physical step carries the action. A step only if needed keeps its
 * action once its turn has come, as the big button only when no step that
 * isn't is waiting (else beside its row), with a quiet "Not needed". A feed
 * that pumps first has its bottle beside its row while the pump is still to
 * start: whichever parent is up first can begin (before the feed, once it's
 * PLAN_PUMP_EARLY_MS from due, as a pump that early begins it). A feed where
 * she only nursed in a plan feed with no nursing (nursedOnly) has the plan's
 * words and nothing to do. `words`: the baby's (BabyWords), for "She's
 * done". `closed`: the steps this phone set aside (She's done, Not needed),
 * by row key: each reads as done, and the next step moves on past it. `at`:
 * the moment it's read for (the card's clock); without it, the bottle before
 * the pump is offered whenever the feed is.
 */
export function stepRows(fp: FeedPlanNow, view: PlanFeedView = fp.focus, words: RowWords = THE_BABY, closed: ReadonlySet<string> = NONE, at?: Date): StepRow[] {
  const c = ctxFor(fp, view);
  const unit = fp.plan.unit;
  const live = view.group?.run?.live ? view.group.run : null;
  const lastEntry = live ? live.entries[live.entries.length - 1] : null;
  // Paused: a timed feed still running with no side open (an untimed one, logged by voice without sides, has none at all).
  const onBreak = !!lastEntry?.active && !!lastEntry.data.segments?.length && !openSegment(lastEntry.data.segments);
  const isClosed = (v: StepView) => v.status === "todo" && closed.has(`${view.feed.id}:${v.i}`);
  const quiet = nursedOnly(view);
  const next = quiet ? null : nextStep(view, isClosed);
  // The big button: the next step; but one only if needed never takes it from her milk at the breast still to log.
  const milkOwed = view.steps.some((v) => v.status === "done" && milkLeft(v));
  const primary = next !== null && !(ifNeeded(view.steps[next].step) && milkOwed) ? next : null;
  /** A row's action: the big button, beside it (a step only if needed whose turn has come, in a feed begun), or none. */
  const role = (v: StepView): "action" | "secondary" | null => {
    if (v.i === primary) return "action";
    return ifNeeded(v.step) && v.status === "todo" && !isClosed(v) && view.start !== null && next !== null && v.i <= next ? "secondary" : null;
  };
  // A feed that pumps first (the night's): its bottle, before the pump, for whoever gives it. Before the feed, only once
  // it's close to due (PLAN_PUMP_EARLY_MS, as a pump that early begins it), so an early tap never starts the night feed.
  const pumpFirst = view.steps.find((v) => v.step.do !== "note")?.step.do === "pump";
  const pumping = view.steps.some((v) => v.step.do === "pump" && v.status === "running");
  const firstBottle = view.steps.find((v) => v.step.do === "bottle")?.i ?? -1;
  const dueSoon = !at || !fp.due || fp.due.for !== "focus" || at.getTime() >= fp.due.from - PLAN_PUMP_EARLY_MS;
  const bottleFirst = (v: StepView, r: "action" | "secondary" | null) =>
    !quiet && r === null && pumpFirst && !pumping && !live && v.i === firstBottle && !ifNeeded(v.step) && (view.start !== null || dueSoon);
  let nursed = false;
  let count = 0;
  return view.steps.map((v): StepRow => {
    const r = rowOf(v);
    // Set aside on this phone: done, nothing to do or close; one only if needed with nothing given wasn't needed.
    if (!isClosed(v)) return r;
    return { ...r, state: "done", action: null, secondary: null, close: null, ...(r.optional && v.entries.length === 0 ? { status: NOT_NEEDED } : {}) };
  });

  function rowOf(v: StepView): StepRow {
    const afterNurse = nursed;
    if (v.step.do === "nurse") nursed = true;
    const key = `${view.feed.id}:${v.i}`;
    const text = stepText(v.step, fp.plan, fp.target, { afterNurse });
    const n = v.step.do === "note" ? null : ++count;
    const optional = ifNeeded(v.step);
    const row = (r: Pick<StepRow, "state"> & Partial<StepRow>): StepRow => ({ key, n, text, status: null, action: null, secondary: null, close: null, optional, ...r });
    if (v.step.do === "note") return row({ state: "note" });
    // She only nursed, in a feed with no nursing: the plan's words, nothing to do.
    if (quiet) return row({ state: "todo" });
    const r = role(v);
    /** The step's action where its role puts it, and (only if needed) its quiet "Not needed" while it has one. */
    const acts = (a: StepAction): Partial<StepRow> => (r ? { [r]: a, ...(optional ? { close: NOT_NEEDED } : {}) } : {});
    if (v.step.do === "nurse") {
      const s = v.step;
      const milk = atBreastWords(s, v.entries, c);
      const minutes = minutesShort(v.minutes ?? 0);
      if (v.status === "running") {
        const sides = s.each_side && live ? sidesSoFar(live) : null;
        const going = onBreak ? `On a break · ${sides ?? `nursed ${minutes}`}` : sides ?? `Nursing now · ${minutes}`;
        // She's on: her milk at the breast is the one thing to do, if it's still to log.
        return row({ state: "running", status: milk ? `${going} · ${milk}` : going, action: milkLeft(v) ? milkAction(s, c) : null });
      }
      if (v.status === "done") {
        if (!milkLeft(v)) return row({ state: "done", text: milk ? `Nursed ${minutes} · ${milk}` : `Nursed ${minutes}` });
        // Off the breast, her milk at the breast not logged: a small link beside the row while the next step has the
        // action, or the action itself when nothing else is left (or only a step only if needed).
        const fix = milkAction(s, c);
        return row({ state: "todo", status: `Nursed ${minutes}`, ...(primary === null ? { action: fix } : { secondary: fix }) });
      }
      // On one side only: that side's Start alone.
      return row({ state: "todo", ...(r === "action" ? { action: { kind: "nurse", shield: !!s.shield, ...(s.side ? { side: s.side } : {}) } } : {}) });
    }
    if (v.step.do === "pump") {
      const minutes = minutesShort(v.minutes ?? 0);
      if (v.status === "running") return row({ state: "running", status: `Pumping now · ${minutes}` });
      if (v.status === "done") return row({ state: "done", text: `Pumped ${minutes}` });
      return row({ state: "todo", ...acts({ kind: "pump" }) });
    }
    if (v.status === "done") {
      const gave = v.ml != null ? `Gave ${amountText(ml1(v.ml), unit)}` : afterNurse ? "Gave a top-up" : "Gave a bottle";
      return row({ state: "done", text: gave });
    }
    // A feed that pumps first, its pump still to start: the bottle (or the rest of it) beside its row.
    const give = (a: StepAction): Partial<StepRow> => (bottleFirst(v, r) ? { secondary: a } : acts(a));
    if (short(v)) {
      // Some given, short of what it's up to: what's given against it, the rest in the bottle form, or done as it is.
      const status = `Gave ${amountText(ml1(v.ml ?? 0), unit)} · up to ${amountText(v.need!, unit)}`;
      return row({ state: "todo", status, ...give(finishAction(v.step, v, afterNurse, c)), close: `${words.Hes} done` });
    }
    return row({ state: "todo", ...give(bottleAction(v.step, afterNurse, c, v.need)) });
  }
}

/**
 * A step a finished feed left unlogged: what it is ("top-up", "milk in the SNS", "formula to finish"), its fix
 * (null: nothing to offer here), and what was logged of it ("Gave 40 ml" for a bottle short of its amount, so the
 * line never reads as if nothing was given; else null).
 */
export type MissedItem = { key: string; what: string; fix: StepAction | null; logged: string | null };

/**
 * The steps a finished feed left unlogged (fp.missed), each with its fix: a
 * top-up opens the bottle form naming its feed (top_up_of), milk at the
 * breast logs a bottle given that way (one tap when the plan's amount is one
 * number and its milk is named, else the form), a pump opens the pump form at
 * the end of the feed, and a bottle short of its amount offers the rest
 * ("formula to finish": the amount it's up to, less what's given). A feed
 * where she only nursed, in a plan feed with no nursing (nursedOnly), owes
 * nothing.
 */
export function missedItems(fp: FeedPlanNow): MissedItem[] {
  const m = fp.missed;
  if (!m || nursedOnly(m.view)) return [];
  const view = m.view;
  const nursing = nursingOf(view);
  const c = ctxFor(fp, view);
  const firstNurse = view.feed.steps.findIndex((s) => s.do === "nurse");
  const out: MissedItem[] = [];
  for (const v of m.steps) {
    const key = `${view.feed.id}:${v.i}`;
    const afterNurse = firstNurse >= 0 && v.i > firstNurse;
    if (v.step.do === "nurse") {
      if (v.milkMissing && v.step.supplement) out.push({ key, what: `milk ${AT_BREAST_WORDS[v.step.supplement.via].inThe}`, fix: milkAction(v.step, c, { compact: true }), logged: null });
      else out.push({ key, what: "nursing", fix: null, logged: null });
    } else if (v.step.do === "pump") {
      // The pump form at the end of the feed: the family sets how long.
      const at = nursing.end ?? (view.lastAt !== null ? new Date(view.lastAt).toISOString() : null);
      out.push({ key, what: "pump", fix: { kind: "form", sheet: "pump", label: "Log pump", aria: "Log the pump: opens the pump form", preset: at ? { started_at: at } : {} }, logged: null });
    } else if (v.step.do === "bottle") {
      if (short(v)) {
        // A top-up names its feed (top_up_of); a bottle-led feed's rest goes with its last bottle, so it stays that feed.
        const last = afterNurse ? undefined : v.entries.reduce<string | undefined>((a, e) => (!a || Date.parse(e.started_at) > Date.parse(a) ? e.started_at : a), undefined);
        const logged = `Gave ${amountText(ml1(v.ml ?? 0), fp.plan.unit)}`;
        out.push({ key, what: restWords(v.step, v, afterNurse).what, fix: finishAction(v.step, v, afterNurse, c, last), logged });
      } else out.push({ key, what: afterNurse ? "top-up" : "bottle", fix: bottleAction(v.step, afterNurse, c, v.need), logged: null });
    }
  }
  return out;
}

/** A number with its unit: "20 ml", "0.68 oz", "10–15 min", "2.5–3.5 h", "1h 05m". */
const AMOUNT = /\d+(?:\.\d+)?(?:–\d+(?:\.\d+)?)? (?:ml|oz|min|h)\b|\d+h \d{2}m\b/g;

/**
 * Words split so each number keeps its unit on one line ("…with the nipple shield, 20 ml in the syringe" never
 * ends a line on "20"): the amounts (`keep`) and the text between them, in order. The words themselves don't change.
 */
export function keepTogether(text: string): { text: string; keep: boolean }[] {
  const out: { text: string; keep: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(AMOUNT)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), keep: false });
    out.push({ text: m[0], keep: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), keep: false });
  return out;
}

/** "top-up", "top-up and pump", "milk in the SNS, top-up and pump". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The due words for the card (dueText, the words every surface shares). Under
 * the card's own "Next feed" eyebrow, its leading "Next feed" goes: "10:30 AM–
 * 11:30 AM, in 1h 00m"; "Wake her for it at …", "Due now, by …" and "Due since
 * …" stay as they are.
 */
export function cardDueWords(d: PlanDue, now: Date, tz: string, her: string): string {
  const t = dueText(d, now, tz, her);
  return t.startsWith("Next feed ") ? t.slice("Next feed ".length) : t;
}

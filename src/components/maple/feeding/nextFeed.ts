/**
 * What Today's Next feed card (NextFeedCard.tsx) shows, worked out from the
 * plan read against the log (feedingPlanOf + feedPlanNow): one row per step
 * of the feed in focus, in the plan's own words (stepText), its state (to do,
 * going, logged, a note), what was logged for it, and the one action the
 * first step left to do carries; and for a finished feed with a step nobody
 * logged, what isn't logged and the one-tap fix for each.
 *
 * Every amount and minute here is the plan's or the log's, in the plan's
 * unit: nothing is made up. The milk is preset only when the plan names it
 * (formula or breast milk); anything else is the family's to say in the
 * bottle form.
 */
import { minutesShort, openSegment } from "@/lib/maple/feed";
import {
  AT_BREAST_WORDS,
  amountText,
  dueText,
  stepText,
  type BottleStep,
  type FeedingPlan,
  type FeedPlanNow,
  type NurseStep,
  type PlanDue,
  type PlanFeedView,
  type PlanMilk,
  type StepView,
} from "@/lib/maple/feeding-plan";
import type { Entry, EntryOf, FeedData } from "@/lib/maple/types";
import type { FeedTarget } from "@/lib/maple/units";

/** The milk a plan names, as the log keeps it: formula or breast milk (either, or pumped milk then formula, is the family's to say). */
export function namedMilk(m: PlanMilk | undefined): "formula" | "breastmilk" | undefined {
  return m === "formula" || m === "breastmilk" ? m : undefined;
}

const MILK_WORD: Record<"formula" | "breastmilk", string> = { formula: "formula", breastmilk: "breast milk" };

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

/** A step's one action (the first step left to do carries it, and only that one). */
export type StepAction =
  /** Start nursing: the suggested side big, the other beside it (the plan's shield and feed go with the start). */
  | { kind: "nurse"; shield: boolean }
  | { kind: "pump" }
  /** Open a form, prefilled from the plan: the bottle form, or (a pump nobody logged) the pump form. */
  | { kind: "form"; sheet: "feed" | "pump"; label: string; aria: string; preset: Record<string, unknown> }
  /** Log it in one tap. */
  | { kind: "log"; log: OneTapLog }
  /** The plan says formula or breast milk: one tap each. */
  | { kind: "choose"; prompt: string; options: OneTapLog[] };

export type StepRow = {
  key: string;
  /** Its number among the steps that aren't notes; null for a note. */
  n: number | null;
  /** todo: still to do; running: its timer is going; done: logged; note: the plan's note, a plain line. */
  state: "todo" | "running" | "done" | "note";
  /** The plan's words for it ("Nurse 12–18 min, 20 ml of formula in the SNS"), or, once logged, what was ("Nursed 14m · 20 ml in the SNS"). */
  text: string;
  /** How it's going ("Nursing now · 8m"), or what's logged of a step half done ("Nursed 14m"). */
  status: string | null;
  action: StepAction | null;
};

type Ctx = {
  plan: FeedingPlan;
  target: FeedTarget | null;
  feedId: string;
  /** The newest nursing entry of the feed (a saved one), for a late top-up's top_up_of. */
  nursingId: number | null;
  /** When its nursing ended (ISO), null while she's on the breast or with no nursing. */
  nursingEnd: string | null;
};

const isBottle = (e: Entry): e is EntryOf<"feed"> => e.kind === "feed" && e.data.method === "bottle";
const ml1 = (ml: number) => ({ min: ml, max: ml });

/** The newest saved nursing entry of a feed and when its nursing ended. */
export function nursingOf(view: PlanFeedView | null): { id: number | null; end: string | null } {
  const run = view?.group?.run;
  if (!run) return { id: null, end: null };
  const saved = run.entries.filter((e) => e.id > 0);
  const last = saved.reduce<EntryOf<"feed"> | null>((a, e) => (!a || Date.parse(e.started_at) >= Date.parse(a.started_at) ? e : a), null);
  return { id: last?.id ?? null, end: run.end !== null && !run.live ? new Date(run.end).toISOString() : null };
}

/** The milk given at the breast with a nursing step: one tap when the plan's amount is one number and its milk is named. */
function milkAction(s: NurseStep, c: Ctx, opts: { compact?: boolean } = {}): StepAction | null {
  const sup = s.supplement;
  if (!sup) return null;
  const words = AT_BREAST_WORDS[sup.via];
  const amount = amountText(sup.ml, c.plan.unit);
  const link = c.nursingId ? { top_up_of: c.nursingId } : {};
  const at = c.nursingEnd ? { started_at: c.nursingEnd } : {};
  const data = (milk?: "formula" | "breastmilk"): FeedData => ({ method: "bottle", amount_ml: sup.ml.min, ...(milk ? { milk } : {}), via: sup.via, plan: c.feedId, ...link });
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
  if (single && sup.milk === "either" && !opts.compact) {
    const what = `log ${amount} ${words.inThe}`;
    return { kind: "choose", prompt: `${log}:`, options: [one("formula", "Formula", `Formula: ${what}`), one("breastmilk", "Breast milk", `Breast milk: ${what}`)] };
  }
  // A range, or milk the family says: the bottle form, with the plan's amount (the smaller) and how it was given.
  const preset = { method: "bottle", amount_ml: sup.ml.min, ...(milk ? { milk } : {}), via: sup.via, plan: c.feedId, ...link, ...at };
  const label = `Log milk ${words.inThe}`;
  return { kind: "form", sheet: "feed", label, aria: `${label}: ${amount}, opens the bottle form`, preset };
}

/** A bottle step: the bottle form with the plan's amount (or the target's smaller amount), its milk when named, and how. */
function bottleAction(s: BottleStep, afterNurse: boolean, c: Ctx): StepAction {
  const ml = s.ml?.min ?? (s.to_target ? c.target?.min : undefined);
  const milk = namedMilk(s.milk);
  const preset: Record<string, unknown> = {
    method: "bottle",
    ...(ml != null ? { amount_ml: ml } : {}),
    ...(milk ? { milk } : {}),
    ...(s.via ? { via: s.via } : {}),
    plan: c.feedId,
    // A top-up names its feed, so given late it's still that feed's, not a feed of its own.
    ...(afterNurse && c.nursingId ? { top_up_of: c.nursingId } : {}),
  };
  const label = afterNurse ? "Log top-up" : "Log bottle";
  return { kind: "form", sheet: "feed", label, aria: `${label}: opens the bottle form`, preset };
}

/** "20 ml in the SNS" for milk logged at the breast (in the plan's unit), or "milk in the SNS" with no amount. */
function atBreastWords(s: NurseStep, entries: readonly Entry[], ml: number | null, c: Ctx): string | null {
  if (!s.supplement || !entries.some(isBottle)) return null;
  const inThe = AT_BREAST_WORDS[s.supplement.via].inThe;
  return ml != null ? `${amountText(ml1(ml), c.plan.unit)} ${inThe}` : `milk ${inThe}`;
}

/** Whether a nursing step's milk at the breast is still to log (she's on, or done, with none logged). */
const milkLeft = (v: StepView) => v.step.do === "nurse" && !!v.step.supplement && v.status !== "todo" && !v.entries.some(isBottle);

/** Whether a step is still to do: not logged, or a nursing step whose milk at the breast isn't. */
const leftToDo = (v: StepView) => v.status === "todo" || milkLeft(v);

/**
 * The feed in focus, step by step. Upcoming: the plan's words, numbered, the
 * first step with its action. Underway: each step's state; a step logged says
 * what was ("Nursed 14m · 20 ml in the SNS", "Pumped 15m", "Gave 30 ml"), one
 * going says so ("Nursing now · 8m", "Pumping now · 6m"), and the first step
 * left to do carries the action.
 */
export function stepRows(fp: FeedPlanNow, view: PlanFeedView = fp.focus): StepRow[] {
  const nursing = nursingOf(view);
  const c: Ctx = { plan: fp.plan, target: fp.target, feedId: view.feed.id, nursingId: nursing.id, nursingEnd: nursing.end };
  const live = view.group?.run?.live ? view.group.run : null;
  const lastEntry = live ? live.entries[live.entries.length - 1] : null;
  // Paused: a timed feed still running with no side open (an untimed one, logged by voice without sides, has none at all).
  const onBreak = !!lastEntry?.active && !!lastEntry.data.segments?.length && !openSegment(lastEntry.data.segments);
  let nursed = false;
  let n = 0;
  let acted = false;
  return view.steps.map((v): StepRow => {
    const afterNurse = nursed;
    if (v.step.do === "nurse") nursed = true;
    const key = `${view.feed.id}:${v.i}`;
    const words = stepText(v.step, fp.plan, fp.target, { afterNurse });
    if (v.step.do === "note") return { key, n: null, state: "note", text: words, status: null, action: null };
    n++;
    // The one action: on the first step left to do.
    let action: StepAction | null = null;
    if (!acted && leftToDo(v)) {
      acted = true;
      if (v.step.do === "nurse") action = v.status === "todo" ? { kind: "nurse", shield: !!v.step.shield } : milkAction(v.step, c);
      else if (v.step.do === "pump") action = { kind: "pump" };
      else action = bottleAction(v.step, afterNurse, c);
    }
    if (v.step.do === "nurse") {
      const milk = atBreastWords(v.step, v.entries, v.ml, c);
      const minutes = minutesShort(v.minutes ?? 0);
      if (v.status === "running") {
        const going = onBreak ? `On a break · nursed ${minutes}` : `Nursing now · ${minutes}`;
        return { key, n, state: "running", text: words, status: milk ? `${going} · ${milk}` : going, action };
      }
      if (v.status === "done") {
        // Nursed, the milk at the breast not logged yet: still to do, with what's logged so far.
        if (milkLeft(v)) return { key, n, state: "todo", text: words, status: `Nursed ${minutes}`, action };
        return { key, n, state: "done", text: milk ? `Nursed ${minutes} · ${milk}` : `Nursed ${minutes}`, status: null, action: null };
      }
      return { key, n, state: "todo", text: words, status: null, action };
    }
    if (v.step.do === "pump") {
      const minutes = minutesShort(v.minutes ?? 0);
      if (v.status === "running") return { key, n, state: "running", text: words, status: `Pumping now · ${minutes}`, action };
      if (v.status === "done") return { key, n, state: "done", text: `Pumped ${minutes}`, status: null, action: null };
      return { key, n, state: "todo", text: words, status: null, action };
    }
    if (v.status === "done") {
      const gave = v.ml != null ? `Gave ${amountText(ml1(v.ml), fp.plan.unit)}` : afterNurse ? "Gave a top-up" : "Gave a bottle";
      return { key, n, state: "done", text: gave, status: null, action: null };
    }
    return { key, n, state: "todo", text: words, status: null, action };
  });
}

/** A step a finished feed left unlogged: what it is ("top-up", "milk in the SNS") and its fix (null: nothing to offer here). */
export type MissedItem = { key: string; what: string; fix: StepAction | null };

/**
 * The steps a finished feed left unlogged (fp.missed), each with its one-tap
 * fix: a top-up opens the bottle form naming its feed (top_up_of), milk at
 * the breast logs a bottle given that way (one tap when the plan's amount is
 * one number and its milk is named, else the form), a pump opens the pump
 * form at the end of the feed.
 */
export function missedItems(fp: FeedPlanNow): MissedItem[] {
  const m = fp.missed;
  if (!m) return [];
  const view = m.view;
  const nursing = nursingOf(view);
  const c: Ctx = { plan: fp.plan, target: fp.target, feedId: view.feed.id, nursingId: nursing.id, nursingEnd: nursing.end };
  const firstNurse = view.feed.steps.findIndex((s) => s.do === "nurse");
  const out: MissedItem[] = [];
  for (const v of m.steps) {
    const key = `${view.feed.id}:${v.i}`;
    const afterNurse = firstNurse >= 0 && v.i > firstNurse;
    if (v.step.do === "nurse") {
      if (v.milkMissing && v.step.supplement) out.push({ key, what: `milk ${AT_BREAST_WORDS[v.step.supplement.via].inThe}`, fix: milkAction(v.step, c, { compact: true }) });
      else out.push({ key, what: "nursing", fix: null });
    } else if (v.step.do === "pump") {
      // The pump form at the end of the feed: the family sets how long.
      const at = nursing.end ?? (view.lastAt !== null ? new Date(view.lastAt).toISOString() : null);
      out.push({ key, what: "pump", fix: { kind: "form", sheet: "pump", label: "Log pump", aria: "Log the pump: opens the pump form", preset: at ? { started_at: at } : {} } });
    } else if (v.step.do === "bottle") {
      out.push({ key, what: afterNurse ? "top-up" : "bottle", fix: bottleAction(v.step, afterNurse, c) });
    }
  }
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

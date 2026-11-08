/**
 * The family's feeding plan (settings.feeding_plan): their care team's plan
 * for feeds, as the family entered it (by hand in the plan sheet, or read
 * back from a photo of the plan sheet in the chat and saved on a yes). Maple
 * shows it as written and never makes up a number: every amount, minute and
 * interval here came from the family.
 *
 * A plan names a few kinds of feed (`feeds`: "Shield + syringe", "Bare breast
 * + top-up", "Night: pump + bottle"), each a short list of steps (nurse, pump,
 * bottle, a note), how often to feed by day and, optionally, at night (its
 * own window, interval and feed), and the order day feeds take turns in.
 *
 * `feedPlanNow` reads the log against it, the one rule Today's Next feed
 * card, the chat, Claude and Siri all use: which feed is underway and which
 * of its steps were logged, which feed comes next (the order, or the night's
 * feed) and when it's due (start to start from the last plan feed's start,
 * which a part logged later never moves), and a step a finished feed left
 * unlogged (a top-up nobody gave). A feed started from the plan carries the
 * plan feed's id (`data.plan`); any other feed is read by what was logged
 * with it (the shield, milk at the breast, a top-up), else taken to follow
 * the order; nursing again soon after a feed is more of it.
 *
 * Amounts are stored in ml; `unit` is the unit the care team wrote them in,
 * which is how they're shown ("30 ml", "1 oz"). The target per feed stays
 * settings.feed_target_ml (checkFeedTarget), shared with the bottle form.
 */
import { bottleAmount, CLUSTER_GAP_MS, countedFeeds, lastFedAnchor, nursingRuns, runAnchor, type FeedMinutes, type NursingRun } from "./feed";
import { addDays, dayKey, DEFAULT_TZ, formatDuration, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "./time";
import type { Entry, EntryOf, StretchSide } from "./types";
import { ML_PER_FL_OZ, type FeedTarget } from "./units";

const MIN = 60_000;
const HOUR = 60 * MIN;

// ── The plan ───────────────────────────────────────────────────────────────

export const PLAN_MILKS = ["breastmilk", "formula", "either", "breastmilk_first"] as const;
export type PlanMilk = (typeof PLAN_MILKS)[number];
/** Milk given at the breast while she nurses. */
export const AT_BREAST_VIAS = ["syringe", "sns"] as const;
export type AtBreastVia = (typeof AT_BREAST_VIAS)[number];
export const PLAN_BOTTLE_VIAS = ["bottle", "paced"] as const;
export type PlanBottleVia = (typeof PLAN_BOTTLE_VIAS)[number];
export const PLAN_UNITS = ["ml", "oz"] as const;
export type PlanUnit = (typeof PLAN_UNITS)[number];

/** Minutes or ml, smallest first; one number is { min: n, max: n }. */
export type Range = { min: number; max: number };

export type NurseStep = {
  do: "nurse";
  /** Minutes at the breast (each side with each_side). */
  minutes?: Range;
  each_side?: boolean;
  /** With a nipple shield. */
  shield?: boolean;
  /** Milk given at the breast while she nurses: a syringe or an SNS, how much, which milk. */
  supplement?: { via: AtBreastVia; ml: Range; milk?: PlanMilk };
};
export type PumpStep = { do: "pump"; minutes?: Range };
export type BottleStep = {
  do: "bottle";
  ml?: Range;
  /** Up to the target per feed (settings.feed_target_ml) instead of an amount of its own. */
  to_target?: boolean;
  milk?: PlanMilk;
  via?: PlanBottleVia;
};
export type NoteStep = { do: "note"; text: string };
export type PlanStep = NurseStep | PumpStep | BottleStep | NoteStep;

export type PlanFeed = { id: string; name: string; steps: PlanStep[] };

export type FeedingPlan = {
  v: 1;
  /** Who it's from, as the family wrote it ("Lactation consultant"). */
  from?: string;
  /** The next check-in with the care team (YYYY-MM-DD, the family's day). */
  check_in?: string;
  unit: PlanUnit;
  /** Start to start, in minutes. No `every`: when she's hungry. wake: wake her by the end of the window. */
  day: { every?: Range; wake?: boolean };
  /** Night, from–to on the family's clock ("22:00"–"06:00"), with its own interval and feed (else the day's). */
  night?: { from: string; to: string; every?: Range; wake?: boolean; feed?: string };
  feeds: PlanFeed[];
  /** The day feeds' turns, by id (one id: every day feed is that one). */
  order: string[];
  notes?: string;
  /** Bumped on every save; an edit names the one it started from (base_rev) so a stale one is refused. */
  rev: number;
  updated_at?: string;
};

export const PLAN_LIMITS = {
  feeds: 6,
  steps: 8,
  name: 40,
  note: 160,
  notes: 300,
  from: 60,
  stepMinutes: [1, 120],
  everyMinutes: [30, 8 * 60],
  ml: [1, 300],
} as const;

/** A plan that can't be saved as given: the message says what to change. */
export class PlanError extends Error {}

/** Someone saved the plan since this edit began (base_rev): nothing was saved. */
export class PlanConflict extends Error {
  constructor(public current: FeedingPlan | null) {
    super("The feeding plan was changed on another phone. Here's the latest; make your change again.");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One-line text the family typed: trimmed, inner whitespace collapsed, no control characters. */
function text(v: unknown, label: string, max: number, opts: { required?: boolean } = {}): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (opts.required) throw new PlanError(`${label} is needed`);
    return undefined;
  }
  if (typeof v !== "string") throw new PlanError(`${label} must be text`);
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) {
    if (opts.required) throw new PlanError(`${label} is needed`);
    return undefined;
  }
  if (s.length > max) throw new PlanError(`${label} is too long (${max} characters at most)`);
  return s;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A range from a number, [min, max] or { min, max }; `scale` turns ounces into ml. */
function range(v: unknown, label: string, [lo, hi]: readonly [number, number], scale = 1): Range | undefined {
  if (v === undefined || v === null) return undefined;
  let min: unknown;
  let max: unknown;
  if (typeof v === "number") min = max = v;
  else if (Array.isArray(v) && v.length >= 1 && v.length <= 2) [min, max = v[0]] = v;
  else if (isObj(v)) {
    min = v.min ?? v.max;
    max = v.max ?? v.min;
  } else throw new PlanError(`${label} must be a number or a range`);
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!ok(min) || !ok(max)) throw new PlanError(`${label} must be a number or a range`);
  const a = round1(Math.min(min, max) * scale);
  const b = round1(Math.max(min, max) * scale);
  if (a < lo || b > hi) {
    const unit = scale === 1 ? "" : " (in ml)";
    throw new PlanError(`${label} must be between ${lo} and ${hi}${unit}`);
  }
  return { min: a, max: b };
}

function oneOf<T extends string>(v: unknown, list: readonly T[], label: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  throw new PlanError(`${label} must be one of: ${list.join(", ")}`);
}

const flag = (v: unknown, label: string): boolean | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new PlanError(`${label} must be true or false`);
  return v || undefined;
};

/** "22:00", "22:30", "10 PM", "10:30pm", "6 am" → "HH:MM" (24-hour). */
export function clockText(v: unknown, label: string): string {
  if (typeof v !== "string") throw new PlanError(`${label} must be a time like 22:00`);
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(v);
  if (!m) throw new PlanError(`${label} must be a time like 22:00`);
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) throw new PlanError(`${label} must be a time like 22:00`);
    h = (h % 12) + (ap === "p" ? 12 : 0);
  }
  if (h > 23 || min > 59) throw new PlanError(`${label} must be a time like 22:00`);
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function step(v: unknown, label: string, scale: number): PlanStep {
  if (!isObj(v)) throw new PlanError(`${label} must be a step`);
  const kind = v.do;
  if (kind === "nurse") {
    const out: NurseStep = { do: "nurse" };
    const minutes = range(v.minutes, `${label}: the minutes`, PLAN_LIMITS.stepMinutes);
    if (minutes) out.minutes = minutes;
    if (flag(v.each_side, `${label}: each side`)) out.each_side = true;
    if (flag(v.shield, `${label}: the nipple shield`)) out.shield = true;
    if (v.supplement !== undefined && v.supplement !== null) {
      const s = v.supplement;
      if (!isObj(s)) throw new PlanError(`${label}: milk at the breast must say how (syringe or sns) and how much`);
      const via = oneOf(s.via, AT_BREAST_VIAS, `${label}: milk at the breast`) ?? "syringe";
      const ml = range(s.ml, `${label}: the milk at the breast`, PLAN_LIMITS.ml, scale);
      if (!ml) throw new PlanError(`${label}: say how much milk goes in the ${via === "sns" ? "SNS" : "syringe"}`);
      const milk = oneOf(s.milk, PLAN_MILKS, `${label}: the milk`);
      out.supplement = { via, ml, ...(milk ? { milk } : {}) };
    }
    return out;
  }
  if (kind === "pump") {
    const out: PumpStep = { do: "pump" };
    const minutes = range(v.minutes, `${label}: the minutes`, PLAN_LIMITS.stepMinutes);
    if (minutes) out.minutes = minutes;
    return out;
  }
  if (kind === "bottle") {
    const out: BottleStep = { do: "bottle" };
    const ml = range(v.ml, `${label}: the amount`, PLAN_LIMITS.ml, scale);
    if (ml) out.ml = ml;
    if (flag(v.to_target, `${label}: up to the target`)) out.to_target = true;
    const milk = oneOf(v.milk, PLAN_MILKS, `${label}: the milk`);
    if (milk) out.milk = milk;
    const via = oneOf(v.via, PLAN_BOTTLE_VIAS, `${label}: how it's given`);
    if (via) out.via = via;
    return out;
  }
  if (kind === "note") return { do: "note", text: text(v.text, `${label}: the note`, PLAN_LIMITS.note, { required: true })! };
  throw new PlanError(`${label} must be nurse, pump, bottle or note`);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A night is this long at most: longer, and its start or end was likely read as AM for PM (11:00 for 11 PM). */
export const PLAN_NIGHT_MAX_MIN = 16 * 60;

/**
 * A night from–to ("HH:MM") no longer than PLAN_NIGHT_MAX_MIN, else a
 * PlanError saying what was read: "Night would run 11 AM to 5 AM (18 hours):
 * a night is 16 hours at most, so check AM and PM (11 PM is 23:00)".
 */
function nightLength(from: string, to: string): void {
  const a = Number(from.slice(0, 2)) * 60 + Number(from.slice(3, 5));
  const b = Number(to.slice(0, 2)) * 60 + Number(to.slice(3, 5));
  const len = (b - a + 24 * 60) % (24 * 60);
  if (len <= PLAN_NIGHT_MAX_MIN) return;
  const long = len % 60 ? `${Math.floor(len / 60)}h ${String(len % 60).padStart(2, "0")}m` : `${len / 60} hours`;
  // The other half of the day for whichever end makes a night that fits: a start in the morning, or an end in the evening.
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const fits = (x: number, y: number) => (y - x + 24 * 60) % (24 * 60) <= PLAN_NIGHT_MAX_MIN;
  const other = a < 12 * 60 && fits(a + 12 * 60, b) ? hhmm(a + 12 * 60) : b >= 12 * 60 && fits(a, b - 12 * 60) ? hhmm(b - 12 * 60) : null;
  const hint = other ? ` (${clockWords(other)} is ${other})` : "";
  throw new PlanError(`Night would run ${clockWords(from)} to ${clockWords(to)} (${long}): a night is 16 hours at most, so check AM and PM${hint}`);
}

/**
 * A plan as sent (the sheet's form, the chat's set_feeding_plan), checked and
 * normalized, or a PlanError saying what to change. Lenient where a person or
 * a model would be: ranges as a number, [min, max] or { min, max }; times as
 * "22:00" or "10 PM"; `order` and `night.feed` by id or by name; amounts in
 * `amounts_in` ("oz" converts to ml; default ml). Feeds keep their ids: by
 * id, else by name from `current`, else a new one from the new revision
 * (`p<rev>f<n>`), so a feed logged under one plan never reads as another's.
 * `lastRev`: the revision of a plan that was removed (settings.
 * feeding_plan_last_rev), which a new plan's revision, and so its new ids,
 * count on from. `stored`: re-reading a saved plan, which skips the checks
 * that only a save makes (a night over PLAN_NIGHT_MAX_MIN), so a plan saved
 * before still reads.
 */
export function parseFeedingPlan(input: unknown, current: FeedingPlan | null, now: Date, opts: { lastRev?: number; stored?: boolean } = {}): FeedingPlan {
  if (!isObj(input)) throw new PlanError("A feeding plan must be an object");
  const rev = Math.max(current?.rev ?? 0, Number.isFinite(opts.lastRev) ? Math.max(0, Math.floor(opts.lastRev!)) : 0) + 1;
  const amountsIn = oneOf(input.amounts_in, PLAN_UNITS, "amounts_in") ?? "ml";
  const scale = amountsIn === "oz" ? ML_PER_FL_OZ : 1;
  const unit = oneOf(input.unit, PLAN_UNITS, "The unit") ?? amountsIn;

  if (!Array.isArray(input.feeds) || input.feeds.length === 0) throw new PlanError("A feeding plan needs at least one feed");
  if (input.feeds.length > PLAN_LIMITS.feeds) throw new PlanError(`A feeding plan has ${PLAN_LIMITS.feeds} feeds at most`);
  const used = new Set<string>();
  let fresh = 0;
  const feeds: PlanFeed[] = input.feeds.map((f, i) => {
    const label = `Feed ${i + 1}`;
    if (!isObj(f)) throw new PlanError(`${label} must have a name and steps`);
    const name = text(f.name, `${label}'s name`, PLAN_LIMITS.name, { required: true })!;
    if (!Array.isArray(f.steps) || f.steps.length === 0) throw new PlanError(`"${name}" needs at least one step`);
    if (f.steps.length > PLAN_LIMITS.steps) throw new PlanError(`"${name}" has ${PLAN_LIMITS.steps} steps at most`);
    const steps = f.steps.map((s, j) => step(s, `"${name}" step ${j + 1}`, scale));
    if (steps.every((s) => s.do === "note")) throw new PlanError(`"${name}" needs a step besides notes`);
    const nurses = steps.filter((s) => s.do === "nurse").length;
    if (nurses > 1) throw new PlanError(`"${name}" nurses once; put both sides in one step (each side)`);
    // Its id: as sent (if it's one of this plan's), else by name from the plan it replaces, else a new one.
    const sent = typeof f.id === "string" && /^[A-Za-z0-9._-]{1,24}$/.test(f.id) ? f.id : null;
    let id = sent && current?.feeds.some((c) => c.id === sent) ? sent : current?.feeds.find((c) => norm(c.name) === norm(name))?.id ?? null;
    if (id && used.has(id)) id = null;
    if (!id) {
      do id = `p${rev}f${++fresh}`;
      while (used.has(id));
    }
    used.add(id);
    return { id, name, steps };
  });
  if (new Set(feeds.map((f) => norm(f.name))).size !== feeds.length) throw new PlanError("Two feeds in the plan have the same name");

  const ref = (v: unknown, label: string): string => {
    if (typeof v === "string") {
      const byId = feeds.find((f) => f.id === v);
      if (byId) return byId.id;
      const byName = feeds.find((f) => norm(f.name) === norm(v));
      if (byName) return byName.id;
      // An id from the plan it replaces, for a feed kept under its name.
      const old = current?.feeds.find((f) => f.id === v);
      const kept = old && feeds.find((f) => norm(f.name) === norm(old.name));
      if (kept) return kept.id;
    } else if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= feeds.length) return feeds[v - 1].id;
    throw new PlanError(`${label} names a feed that isn't in the plan`);
  };

  let night: FeedingPlan["night"];
  if (input.night !== undefined && input.night !== null) {
    const n = input.night;
    if (!isObj(n)) throw new PlanError("Night must say from and to");
    const from = clockText(n.from, "Night's start");
    const to = clockText(n.to, "Night's end");
    if (from === to) throw new PlanError("Night starts and ends at different times");
    if (!opts.stored) nightLength(from, to);
    const every = range(n.every, "Night's time between feeds", PLAN_LIMITS.everyMinutes);
    night = { from, to };
    if (every) night.every = every;
    if (flag(n.wake, "Night's wake to feed")) night.wake = true;
    if (n.feed !== undefined && n.feed !== null && n.feed !== "") night.feed = ref(n.feed, "Night's feed");
  }

  const dayIn = isObj(input.day) ? input.day : {};
  const day: FeedingPlan["day"] = {};
  const every = range(dayIn.every, "The time between feeds", PLAN_LIMITS.everyMinutes);
  if (every) day.every = every;
  if (flag(dayIn.wake, "Wake to feed")) day.wake = true;

  let order: string[];
  if (input.order === undefined || input.order === null) {
    order = feeds.filter((f) => f.id !== night?.feed).map((f) => f.id);
    if (order.length === 0) order = [feeds[0].id];
  } else {
    if (!Array.isArray(input.order) || input.order.length === 0) throw new PlanError("The order needs at least one feed");
    order = input.order.map((o, i) => ref(o, `The order's feed ${i + 1}`));
    if (new Set(order).size !== order.length) throw new PlanError("Each feed is in the order once");
  }

  const plan: FeedingPlan = { v: 1, unit, day, feeds, order, rev, updated_at: now.toISOString() };
  const from = text(input.from, "Who the plan is from", PLAN_LIMITS.from);
  if (from) plan.from = from;
  if (input.check_in !== undefined && input.check_in !== null && input.check_in !== "") {
    if (typeof input.check_in !== "string" || !DAY_KEY.test(input.check_in) || Number.isNaN(Date.parse(`${input.check_in}T12:00:00Z`))) {
      throw new PlanError("The check-in date must be YYYY-MM-DD");
    }
    plan.check_in = input.check_in;
  }
  if (night) plan.night = night;
  const notes = text(input.notes, "The notes", PLAN_LIMITS.notes);
  if (notes) plan.notes = notes;
  return plan;
}

/** The revision of the last plan removed (settings.feeding_plan_last_rev), which a new plan's revision counts on from. */
const lastRevOf = (settings: Record<string, unknown> | null | undefined): number => {
  const v = settings?.feeding_plan_last_rev;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/**
 * The PATCH /api/maple/baby check for settings.feeding_plan: null removes it;
 * anything else is parsed (parseFeedingPlan) into the patch, a new revision.
 * `base_rev` (the revision the edit began from) must still be the saved one,
 * else PlanConflict; an edit without it (a first plan) only saves over none.
 * Removing it keeps its revision (settings.feeding_plan_last_rev, additive),
 * so a later plan's revision and new feed ids never repeat a removed plan's:
 * a feed logged under that plan never reads as one of the new plan's.
 */
export function checkFeedingPlan(patch: Record<string, unknown>, settings: Record<string, unknown> | null | undefined, now: Date): void {
  if (!("feeding_plan" in patch)) return;
  const current = feedingPlanOf(settings);
  const input = patch.feeding_plan;
  if (input === null) {
    // Removing it: only the plan this phone saw.
    const base = isObj(patch) && typeof patch.feeding_plan_base_rev === "number" ? patch.feeding_plan_base_rev : undefined;
    if (current && base !== undefined && base !== current.rev) throw new PlanConflict(current);
    delete patch.feeding_plan_base_rev;
    const last = Math.max(lastRevOf(settings), current?.rev ?? 0);
    if (last > 0) patch.feeding_plan_last_rev = last;
    return;
  }
  if (!isObj(input)) throw new PlanError("A feeding plan must be an object");
  const base = input.base_rev;
  if (current && base !== current.rev) throw new PlanConflict(current);
  if (!current && base !== undefined && base !== null && base !== 0) throw new PlanConflict(null);
  const plan = parseFeedingPlan(input, current, now, { lastRev: lastRevOf(settings) });
  // A feed is milk for her: one that only pumps (a power pump, say) would be "next" for good, since a pump isn't a feed.
  // Checked on save only, so a plan saved before still reads.
  const dry = plan.feeds.find((f) => !feeds(f));
  if (dry) throw new PlanError(`"${dry.name}" needs nursing or a bottle: a pump on its own goes in the plan's notes`);
  patch.feeding_plan = plan;
  delete patch.feeding_plan_base_rev;
}

/** Whether a plan feed feeds her (nursing or a bottle), so the log can count it as a feed. */
const feeds = (f: PlanFeed) => f.steps.some((s) => s.do === "nurse" || s.do === "bottle");

/** The saved plan, or null (none, or one this release can't read). Never throws. */
export function feedingPlanOf(settings: Record<string, unknown> | null | undefined): FeedingPlan | null {
  const p = settings?.feeding_plan;
  if (!isObj(p) || p.v !== 1 || !Array.isArray(p.feeds) || p.feeds.length === 0 || !Array.isArray(p.order)) return null;
  try {
    // Re-parse what's stored so a hand-edited or partial row can't break a screen; keep its ids and revision.
    const plan = parseFeedingPlan(p, { ...(p as unknown as FeedingPlan), rev: Number(p.rev) - 1 }, new Date(String(p.updated_at ?? 0)), { stored: true });
    plan.rev = Number.isFinite(Number(p.rev)) ? Number(p.rev) : 1;
    if (typeof p.updated_at === "string") plan.updated_at = p.updated_at;
    else delete plan.updated_at;
    return plan;
  } catch {
    return null;
  }
}

export const feedById = (plan: FeedingPlan, id: string | null | undefined): PlanFeed | null => (id ? plan.feeds.find((f) => f.id === id) ?? null : null);

// ── Words ──────────────────────────────────────────────────────────────────

const trimNum = (n: number, dp = 2) => String(Number(n.toFixed(dp)));

/** "25 ml", "25–35 ml", "1 oz", "1–1.5 oz", in the plan's unit. */
export function amountText(r: Range, unit: PlanUnit): string {
  if (unit === "oz") {
    const a = trimNum(r.min / ML_PER_FL_OZ);
    const b = trimNum(r.max / ML_PER_FL_OZ);
    return a === b ? `${a} oz` : `${a}–${b} oz`;
  }
  const a = trimNum(r.min, 1);
  const b = trimNum(r.max, 1);
  return a === b ? `${a} ml` : `${a}–${b} ml`;
}

/** "10 min", "10–15 min". */
export function minutesRangeText(r: Range): string {
  return r.min === r.max ? `${trimNum(r.min, 0)} min` : `${trimNum(r.min, 0)}–${trimNum(r.max, 0)} min`;
}

const hours = (min: number) => {
  const h = min / 60;
  return Number.isInteger(h) ? String(h) : Number.isInteger(h * 2) ? String(h) : `${Math.floor(h)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
};

/** "every 2–3 hours", "every 3 hours", "every 1.5 hours", "every 2h 15m". */
export function everyText(r: Range): string {
  const a = hours(r.min);
  const b = hours(r.max);
  const unit = (s: string) => (/h/.test(s) ? "" : s === "1" ? " hour" : " hours");
  if (a === b) return `every ${a}${unit(a)}`;
  if (/h/.test(a) || /h/.test(b)) return `every ${a} to ${b}`;
  return `every ${a}–${b} hours`;
}

/** "10 PM", "10:30 PM", "6 AM" for "22:00". */
export function clockWords(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

const MILK_WORDS: Record<PlanMilk, string> = {
  breastmilk: "breast milk",
  formula: "formula",
  either: "formula or breast milk",
  breastmilk_first: "pumped milk first, then formula to finish",
};

export const AT_BREAST_WORDS: Record<AtBreastVia, { name: string; inThe: string }> = {
  syringe: { name: "Syringe", inThe: "in the syringe" },
  sns: { name: "SNS", inThe: "in the SNS" },
};

/** One step in words: "Nurse 12–18 min with the nipple shield, 20 ml of formula in the SNS", "Pump 15 min", "Top up 25–35 ml, formula or breast milk, paced". */
export function stepText(s: PlanStep, plan: Pick<FeedingPlan, "unit">, target: FeedTarget | null, opts: { afterNurse?: boolean } = {}): string {
  if (s.do === "nurse") {
    const bits = [`Nurse${s.minutes ? ` ${minutesRangeText(s.minutes)}${s.each_side ? " each side" : ""}` : s.each_side ? " on each side" : ""}${s.shield ? " with the nipple shield" : ""}`];
    if (s.supplement) {
      const milk = s.supplement.milk && s.supplement.milk !== "either" ? ` of ${MILK_WORDS[s.supplement.milk]}` : "";
      bits.push(`${amountText(s.supplement.ml, plan.unit)}${milk} ${AT_BREAST_WORDS[s.supplement.via].inThe}`);
    }
    return bits.join(", ");
  }
  if (s.do === "pump") return `Pump${s.minutes ? ` ${minutesRangeText(s.minutes)}` : ""}`;
  if (s.do === "bottle") {
    const verb = opts.afterNurse ? "Top up" : "Bottle";
    // "Bottle up to 50–70 ml", but "Top up to 50–70 ml" (never "Top up up to").
    const upTo = opts.afterNurse ? " to" : " up to";
    const amount = s.ml ? ` ${amountText(s.ml, plan.unit)}` : s.to_target ? (target ? `${upTo} ${amountText(target, plan.unit)}` : `${upTo} the target`) : "";
    const bits = [`${verb}${amount}`];
    if (s.milk) bits.push(MILK_WORDS[s.milk]);
    if (s.via === "paced") bits.push("paced bottle");
    return bits.join(", ");
  }
  return s.text;
}

/**
 * A feed's steps in one line: "Nurse 12–18 min with the nipple shield, 20 ml
 * of formula in the SNS; then pump 15 min". Notes aren't steps, so they never
 * join with "then": each is a sentence of its own after the steps ("Pump 20
 * min; then bottle up to 50–70 ml. Burp halfway"). No full stop at the end,
 * so a sentence can go on after it.
 */
export function feedText(f: PlanFeed, plan: Pick<FeedingPlan, "unit">, target: FeedTarget | null): string {
  let nursed = false;
  const steps: string[] = [];
  const notes: string[] = [];
  for (const s of f.steps) {
    if (s.do === "note") {
      const note = s.text.replace(/[\s.;,]+$/, "");
      if (note) notes.push(note);
      continue;
    }
    const t = stepText(s, plan, target, { afterNurse: nursed });
    if (s.do === "nurse") nursed = true;
    steps.push(steps.length === 0 ? t : `then ${t.charAt(0).toLowerCase()}${t.slice(1)}`);
  }
  return [steps.join("; "), ...notes].filter(Boolean).join(". ");
}

/** "Mon, Nov 10" for a check-in day. */
export function checkInText(key: string): string {
  const d = new Date(`${key}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * The whole plan as lines, the read-back before a save (chat, Claude) and the
 * sheet's summary: who it's from, the target, the day (how often, the turns),
 * each feed's steps, the night, notes. Every value the plan holds, nothing else.
 * `words`: the baby's pronouns in the family's words ("him", "he's").
 */
export function planLines(plan: FeedingPlan, target: FeedTarget | null, words: { her: string; sheIs: string } = { her: "her", sheIs: "she's" }): string[] {
  const out: string[] = [];
  if (plan.from || plan.check_in) out.push([plan.from ? `From: ${plan.from}` : null, plan.check_in ? `check in ${checkInText(plan.check_in)}` : null].filter(Boolean).join(" · "));
  out.push(target ? `Target: ${amountText(target, plan.unit)} a feed` : "Target: none set");
  const day = plan.day.every ? `${everyText(plan.day.every)}${plan.day.wake ? `, waking ${words.her} if ${words.sheIs} asleep` : ""}` : "when hungry";
  const turns = plan.order.map((id) => feedById(plan, id)?.name).filter(Boolean) as string[];
  out.push(`${plan.night ? "Day" : "Feeds"}: ${day}${turns.length > 1 ? `, taking turns: ${turns.join(", then ")}` : turns.length === 1 ? `: ${turns[0]}` : ""}`);
  for (const f of plan.feeds) out.push(`• ${f.name}: ${feedText(f, plan, target)}`);
  if (plan.night) {
    const n = plan.night;
    const how = n.every ? everyText(n.every) : plan.day.every ? `${everyText(plan.day.every)} (as by day)` : "when hungry";
    const feed = feedById(plan, n.feed)?.name;
    out.push(`Night (${clockWords(n.from)}–${clockWords(n.to)}): ${how}${n.wake ? `, waking ${words.her}` : ""}${feed ? `: ${feed}` : ", same turns as by day"}`);
  }
  if (plan.notes) out.push(`Notes: ${plan.notes}`);
  return out;
}

// ── Reading the log against the plan ───────────────────────────────────────

/** How far back the log is read to find whose turn it is. */
export const PLAN_LOOKBACK_MS = 30 * HOUR;
/**
 * A bottle given on its own this soon after the bottle before it in a feed
 * that began with a bottle (or, after nursing that's over, this soon after
 * the nursing began) is more of that feed: pumped milk, then formula to finish.
 */
export const PLAN_BOTTLE_JOIN_MS = 45 * MIN;
/** A feed with steps left stays underway until this long after anything of it was logged. */
export const PLAN_OPEN_MS = 45 * MIN;
/** A finished feed's unlogged steps are mentioned until this long after it. */
export const PLAN_MISSED_MS = 3 * HOUR;
/**
 * A bottle on its own up to this long after a feed ended, before the next
 * one is due, is more of that feed when it still wants one: its top-up, its
 * milk at the breast logged as a bottle, or formula to finish a bottle short
 * of its amount.
 */
export const PLAN_LATE_TOP_UP_MS = 90 * MIN;
/** A pump started this soon before a feed that pumps first is that feed's (pump, then the bottle). */
export const PLAN_PUMP_BEFORE_MS = 60 * MIN;
/** A pump started this soon after a feed began is that feed's, while it has a pump step left for it. */
export const PLAN_PUMP_AFTER_MS = 2 * HOUR;
/** A pump with no feed after it yet counts toward the next feed once that feed is this close to due. */
export const PLAN_PUMP_EARLY_MS = 45 * MIN;
/**
 * Nursing again this soon after anything of a plan feed was logged is more of
 * that feed (comfort nursing after the night's bottle, "she wants more", an
 * evening cluster), not the next one: feed.ts's cluster window.
 */
export const PLAN_RELATCH_MS = CLUSTER_GAP_MS;
/** A feed due at one time (a fixed interval) reads "Due now" for this long before it reads late. */
export const PLAN_DUE_NOW_MS = 15 * MIN;

type FeedEntry = EntryOf<"feed">;
type PumpEntry = EntryOf<"pump">;

/** One feed as the plan reads it: nursing or a bottle on its own, with its top-ups, extra bottles and pumps. */
export type PlanGroup = {
  /** When it began: its first nursing or bottle (a pump before it isn't the feed). */
  start: number;
  /**
   * What the next feed counts from: its first nursing's start as "Last fed"
   * counts it (runAnchor), or its first bottle's. A part joined to it later
   * (a late top-up, the night's second bottle, nursing again) never moves it.
   */
  anchor: number;
  /** Its nursing as one run (several of feed.ts's runs put together), or null. */
  run: NursingRun | null;
  /** feed.ts's runs in it, oldest first: a Pause of 10+ minutes in one timer, or nursing again soon after, is two. */
  runs: NursingRun[];
  /** Bottles given on their own as this feed (a bottle-led feed's, or extra bottles soon after). */
  bottles: FeedEntry[];
  pumps: PumpEntry[];
  /** The plan feed id it was started under (data.plan), if any. */
  tag: string | null;
};

const isPump = (e: Entry): e is PumpEntry => e.kind === "pump";
const t = (s: string) => Date.parse(s);
const atBreast = (e: FeedEntry) => e.data.via === "syringe" || e.data.via === "sns";

/** The plan feed a run was started under: its newest entry's, else a top-up's. */
const runTag = (r: NursingRun): string | null =>
  [...r.entries].reverse().find((e) => e.data.plan)?.data.plan ?? r.topUps.find((b) => b.data.plan)?.data.plan ?? null;

/** feed.ts's runs as one, for a plan feed that holds several: the first's start, every run's minutes, sides and milk. */
function joinRuns(list: readonly NursingRun[]): NursingRun {
  if (list.length === 1) return list[0];
  const first = list[0];
  const last = list[list.length - 1];
  const min: FeedMinutes = { left: 0, right: 0, both: 0, total: 0, has: { L: false, R: false, B: false } };
  const order: StretchSide[] = [];
  const entries: FeedEntry[] = [];
  for (const r of list) {
    min.left += r.min.left;
    min.right += r.min.right;
    min.both += r.min.both;
    min.total += r.min.total;
    min.has = { L: min.has.L || r.min.has.L, R: min.has.R || r.min.has.R, B: min.has.B || r.min.has.B };
    for (const s of r.order) if (order[order.length - 1] !== s) order.push(s);
    for (const e of r.entries) if (!entries.some((x) => x.id === e.id)) entries.push(e);
  }
  return {
    start: first.start,
    end: list.some((r) => r.end === null) ? null : last.end,
    entries,
    parts: list.reduce((n, r) => n + r.parts, 0),
    min,
    firstSide: first.firstSide,
    lastSide: [...list].reverse().find((r) => r.lastSide)?.lastSide ?? null,
    endSide: last.endSide,
    lastSideStart: last.lastSideStart,
    order,
    backAndForth: list.some((r) => r.backAndForth),
    live: list.some((r) => r.live),
    cluster: last.cluster,
    topUps: list.flatMap((r) => r.topUps).sort((a, b) => t(a.started_at) - t(b.started_at)),
  };
}

/** When a feed's latest part began (its nursing, nursing again, a bottle). */
const lastPartStart = (g: PlanGroup) => Math.max(g.start, ...g.runs.map((r) => r.start), ...g.bottles.map((b) => t(b.started_at)));

/**
 * Every feed in the window, oldest first, as the log counts them
 * (countedFeeds, a plan's second bottle with its first), joined the way any
 * plan reads them: a timer paused 10 minutes or more is still one feed, and a
 * bottle soon after a bottle feed's last bottle, or after nursing that's
 * over, is more of it. Pumps aren't placed here: which feed a pump is for
 * depends on the plan's steps (feedPlanNow).
 */
export function planGroups(entries: readonly Entry[], now: Date, runs: readonly NursingRun[] = nursingRuns(entries, now)): PlanGroup[] {
  const from = now.getTime() - PLAN_LOOKBACK_MS;
  const groups: PlanGroup[] = [];
  for (const c of countedFeeds(entries, now, runs)) {
    if (c.start < from) continue;
    const prev = groups[groups.length - 1];
    if (c.bottle) {
      const bottles = [c.bottle, ...c.more];
      // A second bottle soon after the one before (pumped milk, then formula to finish) is the same feed; so is a
      // bottle soon after nursing that's over (a second bottle to finish it).
      if (prev && !prev.run && c.start - lastPartStart(prev) < PLAN_BOTTLE_JOIN_MS) {
        prev.bottles.push(...bottles);
        continue;
      }
      if (prev && prev.run && prev.run.end !== null && c.start - prev.start < PLAN_BOTTLE_JOIN_MS && c.start >= prev.run.end) {
        prev.bottles.push(...bottles);
        continue;
      }
      groups.push({ start: c.start, anchor: c.start, run: null, runs: [], bottles, pumps: [], tag: c.bottle.data.plan ?? null });
    } else {
      // One timer paused 10 minutes or more is two runs to feed.ts, but one feed nobody ended: its first start, both
      // runs' minutes and milk.
      const before = prev?.runs[prev.runs.length - 1];
      if (prev && before && c.run.entries.some((e) => before.entries.some((x) => x.id === e.id))) {
        prev.runs.push(c.run);
        prev.run = joinRuns(prev.runs);
        prev.tag ??= runTag(c.run);
        continue;
      }
      groups.push({ start: c.start, anchor: runAnchor(c.run).at, run: c.run, runs: [c.run], bottles: [], pumps: [], tag: runTag(c.run) });
    }
  }
  return groups;
}

/** Minutes past midnight on the family's clock. */
const clockMinutes = (ms: number, tz: string) => {
  const p = localParts(ms, tz);
  return p.hour * 60 + p.minute;
};
const hhmmMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Whether an instant is in the plan's night (from–to on the family's clock, across midnight or not). */
export function inNight(plan: FeedingPlan, ms: number, tz: string = DEFAULT_TZ): boolean {
  if (!plan.night) return false;
  const m = clockMinutes(ms, tz);
  const a = hhmmMinutes(plan.night.from);
  const b = hhmmMinutes(plan.night.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** The first moment at or after `ms` when the night ends (its `to` on the family's clock), across a clock change too. */
function nightEndAfter(night: NonNullable<FeedingPlan["night"]>, ms: number, tz: string): number {
  const [h, m] = [Number(night.to.slice(0, 2)), Number(night.to.slice(3, 5))];
  let key = dayKey(ms, tz);
  for (let i = 0; i < 3; i++) {
    const p = parseDayKey(key);
    const at = zonedTimeToUtc(p.year, p.month, p.day, h, m, tz).getTime();
    if (at >= ms) return at;
    key = addDays(key, 1);
  }
  return ms;
}

/** What a feed's log says about which plan feed it was. */
type Evidence ={ nursed: boolean; shield: boolean; atBreast: boolean; topUp: boolean; pumped: boolean };

function evidence(g: PlanGroup): Evidence {
  const milk = [...(g.run?.topUps ?? []), ...g.bottles];
  return {
    nursed: !!g.run,
    shield: !!g.run?.entries.some((e) => e.data.shield),
    atBreast: milk.some(atBreast),
    topUp: (g.run?.topUps ?? []).some((b) => !atBreast(b)),
    pumped: g.pumps.length > 0,
  };
}

const nurseStep = (f: PlanFeed) => f.steps.find((s): s is NurseStep => s.do === "nurse") ?? null;
const hasBottle = (f: PlanFeed) => f.steps.some((s) => s.do === "bottle");
const pumpSteps = (f: PlanFeed) => f.steps.filter((s) => s.do === "pump").length;
/** A feed whose first step is a pump (the night's pump, then its bottle). */
const pumpsFirst = (f: PlanFeed) => f.steps.find((s) => s.do !== "note")?.do === "pump";

/**
 * The plan feeds a logged feed could be by how she was fed: one that nurses,
 * or a bottle (a feed with no nursing step). By day the night's own feed
 * isn't one, unless it's one of the day's turns too: a bottle by day that
 * fits no day feed (she wouldn't latch) is a feed outside the plan.
 */
const fitting = (plan: FeedingPlan, nursed: boolean) =>
  plan.feeds.filter((f) => (nursed ? !!nurseStep(f) : !nurseStep(f) && hasBottle(f)) && (f.id !== plan.night?.feed || plan.order.includes(f.id)));

/** The plan's nursing feeds whose nursing has what was logged with this one (a nipple shield, milk at the breast). */
function byNursing(plan: FeedingPlan, ev: Evidence): PlanFeed[] {
  if (!ev.nursed || !(ev.shield || ev.atBreast)) return [];
  return fitting(plan, true).filter((f) => {
    const n = nurseStep(f)!;
    return (ev.shield && n.shield) || (ev.atBreast && !!n.supplement);
  });
}

/**
 * Which plan feed a logged feed was: its tag (started from the plan), else
 * the night's feed in the night (when the plan has one), else what was logged
 * with it (a nipple shield or milk at the breast points to the feed whose
 * nursing has them; a top-up by bottle, to one with a bottle step), else the
 * one the plan expected (`expected`), when it fits how she was fed.
 */
function identify(plan: FeedingPlan, g: PlanGroup, expected: PlanFeed | null, nightFeed: PlanFeed | null): { feed: PlanFeed | null; why: PlanFeedView["why"] } {
  const tagged = feedById(plan, g.tag);
  if (tagged) return { feed: tagged, why: "tagged" };
  // In the night, a feed is the night's (the turns are the day's), however she was fed.
  if (nightFeed) return { feed: nightFeed, why: "night" };
  const ev = evidence(g);
  // How she was fed decides the candidates: a nursing feed, or a bottle (no nursing step).
  const fits = fitting(plan, ev.nursed);
  if (fits.length === 0) return { feed: null, why: "matched" };
  if (ev.nursed && (ev.shield || ev.atBreast)) {
    const want = byNursing(plan, ev);
    if (want.length) return { feed: expected && want.includes(expected) ? expected : want[0], why: "matched" };
  }
  if (ev.nursed && ev.topUp && !ev.atBreast) {
    const want = fits.filter((f) => hasBottle(f) && !nurseStep(f)!.supplement && !nurseStep(f)!.shield);
    if (want.length) return { feed: expected && want.includes(expected) ? expected : want[0], why: "matched" };
  }
  if (expected && fits.includes(expected)) return { feed: expected, why: "order" };
  return { feed: fits.length === 1 ? fits[0] : null, why: "matched" };
}

/** The day feed after `last` in the order (the first with none). */
function nextInOrder(plan: FeedingPlan, last: string | null): PlanFeed {
  const i = last ? plan.order.indexOf(last) : -1;
  // The next turn that feeds her (an older plan may hold a feed that only pumps; it never comes up).
  for (let k = 1; k <= plan.order.length; k++) {
    const f = feedById(plan, plan.order[(i + k) % plan.order.length]);
    if (f && feeds(f)) return f;
  }
  return plan.feeds.find(feeds) ?? plan.feeds[0];
}

export type StepView = {
  /** Its place in the feed's steps. */
  i: number;
  step: PlanStep;
  /** done: logged; running: its timer is going; todo: not logged yet; info: a note. */
  status: "done" | "running" | "todo" | "info";
  /** A nursing step's or a pump's minutes so far. */
  minutes: number | null;
  /** Milk logged for it (ml): a bottle step's bottles, or a nursing step's milk at the breast. */
  ml: number | null;
  /**
   * A bottle step that must reach an amount (up to the target per feed, or pumped milk first, then formula to
   * finish): that amount in ml, as its words give it (its own, else the target). It stays "todo" while `ml` is
   * under need.min, even with bottles logged. Null for every other step: a bottle step without it is done at its
   * first bottle.
   */
  need: Range | null;
  /** A nursing step with milk at the breast whose milk wasn't logged: the nursing is done, the milk isn't. */
  milkMissing: boolean;
  /** What was logged for it. */
  entries: Entry[];
};

export type PlanFeedView = {
  feed: PlanFeed;
  /**
   * How Maple knows which feed it is: tagged (started from the plan), matched
   * (by what was logged with it), order (the order's turn), night (the
   * night's feed), chosen (picked instead on this phone).
   */
  why: "tagged" | "matched" | "order" | "night" | "chosen";
  night: boolean;
  /** When it began (its first step logged), or null for one not started. */
  start: number | null;
  group: PlanGroup | null;
  steps: StepView[];
  /** Every step but notes logged (and the milk at the breast, if the plan has some). */
  done: boolean;
  /** A step's timer is going. */
  live: boolean;
  /** When anything of it was last logged (an end, or a start for one still going). */
  lastAt: number | null;
  /** She also nursed in a feed whose plan feed has no nursing (a bottle feed she ended up nursing for). */
  extraNursing: boolean;
  /** A feed that fits none of the plan's feeds (a bottle by day when every day feed nurses): no steps, no turn. */
  offPlan?: boolean;
};

/** What a feed outside the plan is viewed as: no name, no steps (never shown as a plan feed). */
const OFF_PLAN: PlanFeed = { id: "", name: "", steps: [] };

const sumMl = (list: readonly FeedEntry[]) => {
  let ml: number | null = null;
  for (const b of list) {
    const a = bottleAmount(b.data);
    if (a != null) ml = (ml ?? 0) + a;
  }
  return ml;
};

const entryMinutes = (e: Entry, nowMs: number) => Math.max(0, Math.round(((e.ended_at ? t(e.ended_at) : nowMs) - t(e.started_at)) / MIN));

/**
 * The amount a bottle step must reach before it's done (StepView.need): the amount its words give (its own, else
 * the target per feed), when it's up to the target or pumped milk first, then formula to finish. Null for any other
 * bottle step, and for one up to a target that isn't set.
 */
export function bottleNeed(s: BottleStep, target: FeedTarget | null): Range | null {
  if (!s.to_target && s.milk !== "breastmilk_first") return null;
  const amount = s.ml ?? (s.to_target ? target : null);
  return amount ? { min: amount.min, max: amount.max } : null;
}

/** A plan feed against what was logged for it (null group: not started); `target` is the target per feed, for a bottle up to it. */
export function viewFeed(feed: PlanFeed, why: PlanFeedView["why"], night: boolean, g: PlanGroup | null, now: Date, target: FeedTarget | null, pending: readonly PumpEntry[] = []): PlanFeedView {
  const nowMs = now.getTime();
  const run = g?.run ?? null;
  const milk = [...(run?.topUps ?? []), ...(g?.bottles ?? [])];
  const nurse = nurseStep(feed);
  const bottleSteps = feed.steps.filter((s) => s.do === "bottle").length;
  // Milk at the breast goes to the nursing step that asks for it; the rest to the bottle step. With no step of the
  // kind, it goes to the other: a top-up given by syringe, or the syringe's milk given by bottle, still counts.
  let breastMilk = milk.filter(atBreast);
  let bottleMilk = milk.filter((b) => !atBreast(b));
  if (!nurse?.supplement) {
    bottleMilk = [...breastMilk, ...bottleMilk];
    breastMilk = [];
  }
  if (!bottleSteps && nurse?.supplement) {
    breastMilk = [...breastMilk, ...bottleMilk];
    bottleMilk = [];
  }
  const pumps = [...(g?.pumps ?? []), ...pending];
  let pumpIndex = 0;
  let bottleUsed = false;
  const steps: StepView[] = feed.steps.map((s, i): StepView => {
    const base = { i, step: s, minutes: null, ml: null, need: null, milkMissing: false, entries: [] as Entry[] };
    if (s.do === "note") return { ...base, status: "info" };
    if (s.do === "nurse") {
      if (!run) return { ...base, status: "todo" };
      const ml = sumMl(breastMilk);
      const milkMissing = !!s.supplement && !run.live && breastMilk.length === 0;
      return { ...base, status: run.live ? "running" : "done", minutes: run.min.total, ml, milkMissing, entries: [...run.entries, ...breastMilk] };
    }
    if (s.do === "pump") {
      const p = pumps[pumpIndex++];
      if (!p) return { ...base, status: "todo" };
      return { ...base, status: p.active ? "running" : "done", minutes: entryMinutes(p, nowMs), entries: [p] };
    }
    // A bottle step: the first takes the bottles (pumped milk and formula to finish are one step). One that must reach
    // an amount stays to do while what's logged is short of it (the pumped milk given, the formula to finish not yet);
    // a bottle logged without an amount can't say, so it counts as reaching it.
    const need = bottleNeed(s, target);
    if (bottleUsed || bottleMilk.length === 0) return { ...base, need, status: "todo" };
    bottleUsed = true;
    const ml = sumMl(bottleMilk);
    const short = need !== null && bottleMilk.every((b) => bottleAmount(b.data) != null) && (ml ?? 0) < need.min;
    return { ...base, need, status: short ? "todo" : "done", ml, entries: bottleMilk };
  });
  // Going on: a step's timer, or she's on the breast in a feed whose plan has no nursing (a bottle feed she nursed in).
  const live = steps.some((s) => s.status === "running") || !!run?.live || pumps.some((p) => p.active);
  const done = !live && steps.every((s) => s.status === "done" || s.status === "info") && !steps.some((s) => s.milkMissing);
  const ends: number[] = [];
  for (const s of steps) for (const e of s.entries) ends.push(e.ended_at ? t(e.ended_at) : t(e.started_at));
  if (run) ends.push(run.end ?? nowMs);
  const firstStart = g ? Math.min(g.start, ...pumps.map((p) => t(p.started_at))) : pending.length ? Math.min(...pending.map((p) => t(p.started_at))) : null;
  return {
    feed,
    why,
    night,
    start: firstStart,
    group: g,
    steps,
    done,
    live,
    lastAt: ends.length ? Math.max(...ends) : null,
    extraNursing: !!run && !nurse,
  };
}

export type PlanDue = {
  /** The window it's due in (epoch ms): start to start from `base`, by the day's or the night's interval. */
  from: number;
  to: number;
  /** As of the plan's read; dueStatus says it as of a later moment. A window of one time reads "due" for PLAN_DUE_NOW_MS. */
  status: "early" | "due" | "late";
  /** The plan says to wake her by `to`. */
  wake: boolean;
  night: boolean;
  /**
   * What the window counts from: the start of the last plan feed as the plan
   * reads it (PlanGroup.anchor: its nursing's start as "Last fed" counts it,
   * or its first bottle), never a part joined to it later (a late top-up, the
   * night's second bottle, nursing again). While a feed that pumps first is
   * underway with no bottle yet, its pump's start (or when it was due, if
   * they pumped before that). dueFromText names it.
   */
  base: number;
  /** Which feed it's for: the focus (not begun) or the one after it (the focus is underway). */
  for: "focus" | "after";
};

export type FeedPlanNow = {
  plan: FeedingPlan;
  target: FeedTarget | null;
  /**
   * The feed to look at now: "underway" (a step running, or one logged
   * minutes ago with steps left, or the night's pump before its bottle) or
   * "upcoming" (the next feed, nothing logged for it yet).
   */
  focus: PlanFeedView & { state: "underway" | "upcoming" };
  /** When the next feed is due; null with no interval in the plan or no feed logged yet. */
  due: PlanDue | null;
  /** With the focus underway: the plan feed after it. */
  after: { feed: PlanFeed; night: boolean } | null;
  /** The last finished feed's steps nobody logged (a top-up, the syringe's milk), for a while after it. */
  missed: { view: PlanFeedView; steps: StepView[] } | null;
  /** The plan's other feeds, to do instead of an upcoming focus. */
  others: PlanFeed[];
  /**
   * Nursing started before `until` (epoch ms, PLAN_RELATCH_MS after anything
   * of the last plan feed was logged) is more of that feed (`feed`), not the
   * next one, unless a shield or milk at the breast logged with it points to
   * another. A start then from the dock or Siri should carry no plan feed, so
   * it reads that way; the card's own Start for the next feed still names it.
   */
  relatch: { feed: PlanFeed; until: number } | null;
};

/** A pump started up to this long before a feed began goes with that feed or the ones after it, not the one before. */
const PUMP_SLACK_MS = 10 * MIN;

/**
 * Whether a bottle step is still short of the amount it must reach (up to
 * the target per feed, or pumped milk first, then formula to finish: its own
 * amount, else the target), as its bottles were logged; one logged without an
 * amount can't say, so it counts as reaching it.
 */
function bottleShort(v: StepView, target: FeedTarget | null): boolean {
  const s = v.step;
  if (s.do !== "bottle" || (!s.to_target && s.milk !== "breastmilk_first")) return false;
  const need = s.ml ?? (s.to_target ? target : null);
  if (!need) return false;
  return v.entries.every((e) => e.kind !== "feed" || bottleAmount(e.data) != null) && (v.ml ?? 0) < need.min;
}

/** Whether a feed still wants what a bottle on its own could be: its top-up or bottle, formula to finish one, its milk at the breast. */
const wantsBottle = (v: PlanFeedView, target: FeedTarget | null) =>
  v.steps.some((s) => s.milkMissing || (s.step.do === "bottle" && (s.status === "todo" || bottleShort(s, target))));

/** Whether what was logged with a nursing feed (a nipple shield, milk at the breast) points to a plan feed other than `feed`. */
function pointsElsewhere(plan: FeedingPlan, g: PlanGroup, feed: PlanFeed): boolean {
  const want = byNursing(plan, evidence(g));
  return want.length > 0 && !want.includes(feed);
}

/**
 * The plan against the log, now: the feed underway or the next one, when the
 * next is due, and anything a finished feed left unlogged. `choose`: a plan
 * feed picked on this phone for the next feed (Do this one instead).
 *
 * Each feed logged is read in turn, oldest first. A bottle the feed before
 * still wants (a late top-up, formula to finish), or nursing again under
 * PLAN_RELATCH_MS after it, is more of that feed: it takes no turn, starts no
 * steps anew and never moves when the next is due. Any other feed is the
 * night's when the card would have said so as it began (the due rule from
 * the feed before it, at its start), else the one its tag, what was logged
 * with it, or the order's turn says. Each feed takes as many pumps as it has
 * pump steps, in order; a pump goes to the feed after it only when that one
 * pumps first.
 */
export function feedPlanNow(
  plan: FeedingPlan,
  entries: readonly Entry[],
  now: Date,
  opts: { tz?: string; target?: FeedTarget | null; choose?: string | null } = {}
): FeedPlanNow {
  const tz = opts.tz ?? DEFAULT_TZ;
  const target = opts.target ?? null;
  const nowMs = now.getTime();
  const runs = nursingRuns(entries, now);
  const groups = planGroups(entries, now, runs);
  const pumps = entries
    .filter(isPump)
    .filter((p) => t(p.started_at) >= nowMs - PLAN_LOOKBACK_MS)
    .sort((a, b) => t(a.started_at) - t(b.started_at));
  // Every plan feed read against what was logged for it goes through here.
  const read = (feed: PlanFeed, why: PlanFeedView["why"], night: boolean, g: PlanGroup | null, pending: readonly PumpEntry[] = []) =>
    viewFeed(feed, why, night, g, now, target, pending);

  /**
   * When the feed after one that counts from `baseMs` is due, as it reads at
   * `at` (now, or when a logged feed began), and whether it's the night's: it
   * is when the next feed falls in the night by the day's interval and by the
   * night's own, each from `at` once its window's start has passed. A night
   * feed late enough that the night's interval reaches past the night's end
   * makes the next one the day's, due once the night is over.
   */
  const dueAt = (baseMs: number | null, at: number): Omit<PlanDue, "for"> | null => {
    if (baseMs === null) return null;
    const dayEvery = plan.day.every;
    const nightEvery = plan.night?.every ?? dayEvery;
    const by = (every: Range | undefined) => Math.max(at, baseMs + (every?.min ?? 0) * MIN);
    const night = !!plan.night && inNight(plan, by(dayEvery), tz) && inNight(plan, by(nightEvery), tz);
    const every = night ? nightEvery : dayEvery;
    if (!every) return null;
    let from = baseMs + every.min * MIN;
    let to = baseMs + every.max * MIN;
    if (!night && plan.night && inNight(plan, from, tz)) {
      // A day feed after the night (the night's interval runs past its end): due once the night's over.
      const end = nightEndAfter(plan.night, from, tz);
      from = end;
      to = Math.max(to, end);
    }
    return { from, to, status: dueStatus({ from, to }, new Date(at)), wake: !!(night ? plan.night?.wake : plan.day.wake), night, base: baseMs };
  };
  /** Whether the feed after one that counts from `baseMs` is the night's, at `at` (with no interval, or none before it, `at` decides). */
  const nightAt = (baseMs: number | null, at: number) => {
    const d = dueAt(baseMs, at);
    return d ? d.night : inNight(plan, at, tz);
  };
  const nextFeed = (night: boolean, turn: string | null): { feed: PlanFeed; why: PlanFeedView["why"] } => {
    const nightFeed = night ? feedById(plan, plan.night?.feed) : null;
    if (nightFeed) return { feed: nightFeed, why: "night" };
    return { feed: nextInOrder(plan, turn), why: "order" };
  };

  // Whose turn each feed was, oldest first: the last day feed's place in the order sets the next one.
  let lastDay: string | null = null;
  const views: PlanFeedView[] = [];
  const room = (v: PlanFeedView) => (v.offPlan ? 0 : pumpSteps(v.feed) - v.group!.pumps.length);
  const addPump = (i: number, p: PumpEntry) => {
    const v = views[i];
    views[i] = read(v.feed, v.why, v.night, { ...v.group!, pumps: [...v.group!.pumps, p] });
  };
  let nextPump = 0;
  for (const found of groups) {
    const g: PlanGroup = { ...found, runs: [...found.runs], bottles: [...found.bottles], pumps: [] };
    const k = views.length - 1;
    // Read on its own: the night's when the card would have said so as it began (the due rule from the feed before
    // it, at its start; with none before it, its own start), and which plan feed it was.
    const night = nightAt(k >= 0 ? views[k].group!.anchor : null, g.start);
    const nightFeed = night ? feedById(plan, plan.night?.feed) : null;
    const own = identify(plan, g, nightFeed ?? nextInOrder(plan, lastDay), nightFeed);

    // Pumps begun before it: the feed before it's while that one has a pump step left (pumping after a feed), this
    // one's if it pumps first (the night's pump, then its bottle) and the pump was well after the one before or that
    // one has no pump step left; anything else is a pump the plan has no step for.
    const mine: PumpEntry[] = [];
    while (nextPump < pumps.length && t(pumps[nextPump].started_at) + PUMP_SLACK_MS < g.start) {
      const p = pumps[nextPump++];
      const at = t(p.started_at);
      const since = k >= 0 ? at - lastPartStart(views[k].group!) : Infinity;
      const prevTakes = k >= 0 && since <= PLAN_PUMP_AFTER_MS && room(views[k]) > 0;
      const first = !!own.feed && pumpsFirst(own.feed) && mine.length < pumpSteps(own.feed);
      const near = g.start - at <= PLAN_PUMP_BEFORE_MS;
      if (first && (near ? since > 30 * MIN || !prevTakes : k >= 0 && !prevTakes)) mine.push(p);
      else if (prevTakes) addPump(k, p);
    }

    if (k >= 0 && !views[k].offPlan) {
      const prev = views[k];
      const pg = prev.group!;
      const asTagged = !g.tag || g.tag === prev.feed.id;
      // A bottle on its own the feed before still wants (its top-up, its milk at the breast logged as a bottle, formula
      // to finish a bottle short of its amount), logged late from the dock or the chat rather than the plan's card
      // (which links it: data.top_up_of): up to PLAN_LATE_TOP_UP_MS after that feed ended, before the next is due.
      const ended = pg.run && !pg.run.live && pg.run.end !== null ? pg.run.end : prev.lastAt;
      const nextDue = dueAt(pg.anchor, g.start);
      const late =
        !g.run && asTagged && ended !== null && g.start - ended <= PLAN_LATE_TOP_UP_MS && (!nextDue || g.start < nextDue.from) && wantsBottle(prev, target);
      // A bottle soon after anything of a feed that began with a bottle (the night's: its pump can end after the bottle,
      // one parent pumping while the other feeds): more of it, as a bottle soon after the bottle before is.
      const bottleLed = pg.bottles.length > 0 && (pg.runs.length === 0 || t(pg.bottles[0].started_at) <= pg.runs[0].start);
      const more = !g.run && asTagged && bottleLed && prev.lastAt !== null && g.start - prev.lastAt < PLAN_BOTTLE_JOIN_MS;
      // Nursing again soon after it (comfort nursing after the night's bottle, a re-latch, a cluster): more of that feed,
      // unless what was logged with it (a shield, milk at the breast) points to another of the plan's feeds. In the
      // night every feed is the night's, however she was fed, so nothing points elsewhere.
      const again = !!g.run && asTagged && prev.lastAt !== null && g.start - prev.lastAt < PLAN_RELATCH_MS && (!!nightFeed || !pointsElsewhere(plan, g, prev.feed));
      if (late || more || again) {
        const runsIn = [...pg.runs, ...g.runs];
        const joined: PlanGroup = { ...pg, runs: runsIn, run: runsIn.length ? joinRuns(runsIn) : null, bottles: [...pg.bottles, ...g.bottles], pumps: [...pg.pumps] };
        for (const p of mine) if (joined.pumps.length < pumpSteps(prev.feed)) joined.pumps.push(p);
        views[k] = read(prev.feed, prev.why, prev.night, joined);
        continue;
      }
    }
    if (!own.feed) {
      // Outside the plan (a bottle by day when every day feed nurses): a feed, but no turn and no steps.
      views.push({ ...read(OFF_PLAN, "matched", night, g), done: true, live: false, offPlan: true });
      continue;
    }
    views.push(read(own.feed, own.why, night, { ...g, pumps: mine }));
    // The night's feed never takes a day turn, unless it was started as one.
    if (plan.order.includes(own.feed.id) && (own.why === "tagged" || own.feed !== nightFeed)) lastDay = own.feed.id;
  }

  // Pumps since the last feed began: its while it has a pump step left; the rest wait for the next feed (the night's
  // pump before its bottle).
  const pending: PumpEntry[] = [];
  const lastIndex = views.length - 1;
  for (; nextPump < pumps.length; nextPump++) {
    const p = pumps[nextPump];
    const at = t(p.started_at);
    const v = views[lastIndex];
    if (v && at - lastPartStart(v.group!) <= PLAN_PUMP_AFTER_MS && room(v) > 0) addPump(lastIndex, p);
    else if (!v || at > v.group!.start) pending.push(p);
  }

  const last = views[views.length - 1] ?? null;
  // What the next feed counts from: the last plan feed's start (a feed older than the window: Last fed).
  const fed = last ? null : lastFedAnchor(entries, now, runs);
  const base = last ? last.group!.anchor : fed ? t(fed.at) : null;
  const dueNext = dueAt(base, nowMs);
  const nightNow = (d: Omit<PlanDue, "for"> | null) => (d ? d.night : inNight(plan, nowMs, tz));

  const underway = !!last && !last.offPlan && (last.live || (!last.done && last.lastAt !== null && nowMs - last.lastAt < PLAN_OPEN_MS));
  let focus: FeedPlanNow["focus"];
  let after: FeedPlanNow["after"] = null;
  let due: PlanDue | null = null;
  let missed: FeedPlanNow["missed"] = null;

  // A pump with no feed after it yet begins the next feed if that feed pumps first (the night's pump, then its bottle).
  const pumpOpen = (f: PlanFeed) =>
    pending.length > 0 && pumpsFirst(f) && (pending.some((p) => p.active) || (dueNext ? nowMs >= dueNext.from - PLAN_PUMP_EARLY_MS : true));
  if (underway && last) {
    focus = { ...last, state: "underway" };
    const night = nightNow(dueNext);
    after = { feed: nextFeed(night, lastDay).feed, night };
    due = dueNext ? { ...dueNext, for: "after" } : null;
  } else {
    const night = nightNow(dueNext);
    const pick = nextFeed(night, lastDay);
    const chosen = feedById(plan, opts.choose);
    const feed = chosen ?? pick.feed;
    const why = chosen ? "chosen" : pick.why;
    if (pumpOpen(feed)) {
      // The night's pump before its bottle: this feed has begun, so the due is the one after it's, counted until the
      // bottle is logged from the pump's start, or from when this feed is due if they pumped early (the baby asleep).
      const v = read(feed, why, night, null, pending.slice(0, pumpSteps(feed)));
      focus = { ...v, state: "underway" };
      const d = dueAt(Math.max(v.start ?? nowMs, dueNext?.from ?? -Infinity), nowMs);
      const nightAfter = nightNow(d);
      const turn = plan.order.includes(feed.id) && feed !== (night ? feedById(plan, plan.night?.feed) : null) ? feed.id : lastDay;
      after = { feed: nextFeed(nightAfter, turn).feed, night: nightAfter };
      due = d ? { ...d, for: "after" } : null;
    } else {
      focus = { ...read(feed, why, night, null), state: "upcoming" };
      due = dueNext ? { ...dueNext, for: "focus" } : null;
    }
    if (last && !last.offPlan && !last.done && last.lastAt !== null && nowMs - last.lastAt < PLAN_MISSED_MS) {
      const steps = last.steps.filter((s) => s.status === "todo" || s.milkMissing);
      if (steps.length) missed = { view: last, steps };
    }
  }
  const others = focus.state === "upcoming" ? plan.feeds.filter((f) => f.id !== focus.feed.id && feeds(f)) : [];
  const relatch = last && !last.offPlan && last.lastAt !== null && nowMs < last.lastAt + PLAN_RELATCH_MS ? { feed: last.feed, until: last.lastAt + PLAN_RELATCH_MS } : null;
  return { plan, target, focus, due, after, missed, others, relatch };
}

// ── When, in words ─────────────────────────────────────────────────────────

/** Early, due or late as of `now`; a feed due at one time (a fixed interval) is "due" for PLAN_DUE_NOW_MS before it's late. */
export function dueStatus(d: Pick<PlanDue, "from" | "to">, now: Date): PlanDue["status"] {
  const nowMs = now.getTime();
  const lateAfter = d.from === d.to ? d.to + PLAN_DUE_NOW_MS : d.to;
  return nowMs < d.from ? "early" : nowMs <= lateAfter ? "due" : "late";
}

/** What the next feed counts from, for the due line: "after the 8:00 AM feed" (the last plan feed's start, PlanDue.base). */
export function dueFromText(d: Pick<PlanDue, "base">, tz: string = DEFAULT_TZ): string {
  return `after the ${formatTime(d.base, tz)} feed`;
}

const inText = (ms: number) => (ms < MIN ? "now" : `in ${formatDuration(Math.round(ms / 1000))}`);

/**
 * The next feed's time for Today's card and the chat: "Next feed 3:10–4:10 PM,
 * in 25m"; "Due now, by 4:10 PM"; "Wake her for it by 12:42 AM"; "Due since
 * 4:10 PM: 3h 25m since the last feed". `she`: the baby's object pronoun.
 */
export function dueText(d: PlanDue, now: Date, tz: string = DEFAULT_TZ, her = "her"): string {
  const nowMs = now.getTime();
  const at = (ms: number) => formatTime(ms, tz);
  const one = d.from === d.to;
  const since = formatDuration(Math.round((nowMs - d.base) / 1000));
  // As of `now` (a card's clock moves on between reads of the plan).
  const status = dueStatus(d, now);
  if (status === "early") {
    const when = one ? `at ${at(d.from)}` : `${at(d.from)}–${at(d.to)}`;
    return `${d.wake && one ? `Wake ${her} for it` : "Next feed"} ${when}, ${inText(d.from - nowMs)}`;
  }
  if (status === "due") return one ? `Due now (${at(d.from)})` : `Due now, by ${at(d.to)}${d.wake ? `: wake ${her} if asleep` : ""}`;
  return `Due since ${at(d.to)}: ${since} since the last feed`;
}

/**
 * One-line, human descriptions of entries ("Nursed · L 12m, R 8m"). Shared by
 * the app's lists, the MCP tools' replies, and the CSV export so every surface
 * words things the same way.
 */
import { bottleAmount, feedMinutes, minutesShort } from "./feed";
import { AT_BREAST_VIAS, AT_BREAST_WORDS, feedingPlanOf, type AtBreastVia } from "./feeding-plan";
import { JAUNDICE_LABEL, STOOL_COLOR_INFO } from "./guidelines";
import { milestoneLabel, NEUTRAL_MILESTONE_WORDS, type MilestoneWords } from "./milestones";
import { formatDuration } from "./time";
import { formatLength, formatTemp, formatVolume, formatWeight } from "./units";
import type { Entry, EntryKind, EntryOf, FeedData, UnitSystem } from "./types";

export const KIND_LABELS: Record<EntryKind, string> = {
  feed: "Feed",
  pump: "Pump",
  diaper: "Diaper",
  sleep: "Sleep",
  growth: "Growth",
  temp: "Temperature",
  vitals: "Vitals",
  med: "Medicine",
  tummy: "Tummy time",
  bath: "Bath",
  moment: "Moment",
  note: "Note",
};

export const KIND_EMOJI: Record<EntryKind, string> = {
  feed: "🍼",
  pump: "🫙",
  diaper: "🧷",
  sleep: "🌙",
  growth: "📏",
  temp: "🌡️",
  vitals: "💓",
  med: "☀️",
  tummy: "🐢",
  bath: "🛁",
  moment: "✨",
  note: "📝",
};

export const NOTE_TAG_LABELS: Record<string, { label: string; emoji: string }> = {
  spitup: { label: "Spit-up", emoji: "🫧" },
  hiccups: { label: "Hiccups", emoji: "🎐" },
  fussy: { label: "Fussy", emoji: "🌧️" },
  gas: { label: "Gassy", emoji: "💨" },
  nails: { label: "Trimmed nails", emoji: "✂️" },
  cord: { label: "Cord care", emoji: "🌰" },
  other: { label: "Note", emoji: "📝" },
};

/** Emoji that reflects the details (💧 vs 💩, bottle vs nursing). */
export function entryEmoji(e: Entry): string {
  if (e.kind === "diaper") {
    if (e.data.pee && e.data.poop) return "💧💩";
    if (e.data.poop) return "💩";
    if (e.data.pee) return "💧";
    return "🧷";
  }
  if (e.kind === "feed") return e.data.method === "bottle" ? "🍼" : "🤱";
  if (e.kind === "med") return /vit(amin)?\.?\s*d|sunshine/i.test(e.data.name) ? "☀️" : "💊";
  if (e.kind === "moment" && e.data.photos?.length) return "📸";
  if (e.kind === "note") return e.data.for_doctor ? "🩺" : NOTE_TAG_LABELS[e.data.tag ?? "other"]?.emoji ?? "📝";
  return KIND_EMOJI[e.kind];
}

/**
 * What was in a bottle: "breast milk", "formula", "mixed", or a Mixed one's
 * split when it's known ("30 ml breast milk + 20 ml formula", "mixed, 20 ml
 * formula"). Null when the milk wasn't said.
 */
export function milkWords(d: FeedData, units: UnitSystem = "us"): string | null {
  if (!d.milk) return null;
  if (d.milk !== "mixed") return d.milk === "breastmilk" ? "breast milk" : d.milk;
  const parts = [
    d.breastmilk_ml != null ? `${formatVolume(d.breastmilk_ml, units)} breast milk` : null,
    d.formula_ml != null ? `${formatVolume(d.formula_ml, units)} formula` : null,
  ].filter((x): x is string => !!x);
  return parts.length === 2 ? parts.join(" + ") : parts.length ? `mixed, ${parts[0]}` : "mixed";
}

/** Milk given at the breast while she nursed (an SNS or a syringe), or null for a bottle given as one. */
export function atBreastOf(d: FeedData): AtBreastVia | null {
  return d.via === "sns" || d.via === "syringe" ? d.via : null;
}

/**
 * A feed's part, the way its nursing row shows it: milk at the breast ("+ 20 ml
 * in the SNS", "+ milk in the syringe" with no amount said) or a top-up by
 * bottle ("+ 30 ml top-up", "+ top-up").
 */
export function feedPartWords(b: EntryOf<"feed">, units: UnitSystem = "us"): string {
  const ml = bottleAmount(b.data);
  const vol = ml != null ? formatVolume(ml, units) : null;
  const at = atBreastOf(b.data);
  if (at) return `+ ${vol ?? "milk"} ${AT_BREAST_WORDS[at].inThe}`;
  return vol ? `+ ${vol} top-up` : "+ top-up";
}

/** What several bottles added up to (ml), or null when none of them had an amount. */
function sumMl(list: readonly EntryOf<"feed">[]): number | null {
  let ml: number | null = null;
  for (const b of list) {
    const a = bottleAmount(b.data);
    if (a != null) ml = (ml ?? 0) + a;
  }
  return ml;
}

/**
 * A feed's parts in words, each kind once, in the order a feed goes: milk at
 * the breast by how it went in ("+ 20 ml in the syringe", "+ milk in the
 * SNS"), then its top-ups by bottle ("+ 30 ml top-up", "+ 60 ml in 2
 * top-ups", "+ 2 top-ups"). Several of one kind add up (the amounts said).
 * Milk at the breast is never called a top-up: in a plan, a top-up is its own
 * step. Last fed, Between feeds and the Timeline's clusters say a feed's parts
 * this way.
 */
export function feedPartsList(parts: readonly EntryOf<"feed">[], units: UnitSystem = "us"): string[] {
  const out: string[] = [];
  for (const via of AT_BREAST_VIAS) {
    const given = parts.filter((b) => atBreastOf(b.data) === via);
    if (!given.length) continue;
    const ml = sumMl(given);
    out.push(`+ ${ml != null ? formatVolume(ml, units) : "milk"} ${AT_BREAST_WORDS[via].inThe}`);
  }
  const tops = parts.filter((b) => !atBreastOf(b.data));
  if (tops.length === 1) out.push(feedPartWords(tops[0], units));
  else if (tops.length > 1) {
    const ml = sumMl(tops);
    out.push(ml != null ? `+ ${formatVolume(ml, units)} in ${tops.length} top-ups` : `+ ${tops.length} top-ups`);
  }
  return out;
}

/** feedPartsList in one line ("+ 20 ml in the syringe · + 30 ml top-up"), or null for a feed with no parts. */
export function feedPartsSummary(parts: readonly EntryOf<"feed">[], units: UnitSystem = "us"): string | null {
  const list = feedPartsList(parts, units);
  return list.length ? list.join(" · ") : null;
}

const planUnitsSeen = new WeakMap<object, UnitSystem | null>();

/**
 * The units a feed's parts are said in: the feeding plan's, when one is saved,
 * so the syringe its card calls "20 ml" is "20 ml" on the feed's row and in
 * Last fed too, never "0.68 oz"; else the app's. Day totals keep the app's.
 */
export function partUnits(settings: Record<string, unknown> | null | undefined, units: UnitSystem): UnitSystem {
  if (!settings) return units;
  let u = planUnitsSeen.get(settings);
  if (u === undefined) {
    const plan = feedingPlanOf(settings);
    u = plan ? (plan.unit === "ml" ? "metric" : "us") : null;
    planUnitsSeen.set(settings, u);
  }
  return u ?? units;
}

function durationOf(e: Entry, now: Date): number | null {
  if (!e.ended_at && !e.active) return null;
  const end = e.ended_at ? Date.parse(e.ended_at) : now.getTime();
  return Math.max(0, (end - Date.parse(e.started_at)) / 1000);
}

/**
 * { title, detail } for lists; `text` joins them for plain-text surfaces.
 * `removed`: a deleted entry (Recently removed). A timer deleted while it ran
 * isn't happening "now": it reads "Nursing timer · L 12m, R 5m", its minutes
 * counted to when it was removed (its updated_at), not on to the present.
 * `topUp`: a bottle given with a nursing feed (feed.ts topUpIds), which reads
 * as part of that feed, not a feed of its own: "Top-up", or for milk given at
 * the breast while she nursed, "SNS at the breast" / "Syringe at the breast".
 * A nursing feed with a nipple shield says so ("shield").
 */
export function describeEntry(
  e: Entry,
  opts: { units?: UnitSystem; now?: Date; removed?: boolean; words?: MilestoneWords; topUp?: boolean } = {}
): { title: string; detail: string; text: string } {
  const units = opts.units ?? "us";
  const stopped = !!opts.removed && e.active;
  const now = stopped ? new Date(e.updated_at) : (opts.now ?? new Date());
  const live = e.active && !stopped;
  let title: string = KIND_LABELS[e.kind];
  const bits: string[] = [];

  switch (e.kind) {
    case "feed": {
      if (e.data.method === "bottle") {
        // "Top-up · 35 ml · breast milk · paced bottle", "SNS · 30 ml · formula", "Syringe · 20 ml", "Bottle · 50 ml · 30 ml
        // breast milk + 20 ml formula". Milk given at the breast with a feed is part of that nursing: "Syringe at the
        // breast · 20 ml · formula", never a separate bottle.
        const via = e.data.via;
        const atBreast = atBreastOf(e.data);
        title = atBreast ? `${AT_BREAST_WORDS[atBreast].name}${opts.topUp ? " at the breast" : ""}` : opts.topUp ? "Top-up" : "Bottle";
        if (e.data.amount_ml != null) bits.push(formatVolume(e.data.amount_ml, units));
        const milk = milkWords(e.data, units);
        if (milk) bits.push(milk);
        // The title already names milk given at the breast.
        const how = via === "paced" ? "paced bottle" : via === "bottle" && title !== "Bottle" ? "bottle" : null;
        if (how) bits.push(how);
      } else {
        title = live ? "Nursing now" : stopped ? "Nursing timer" : "Nursed";
        // The card's rows added up (feedMinutes), so lists, the day's totals and toasts agree.
        const t = feedMinutes(e, now);
        const started = e.data.first_side && !live ? `started ${e.data.first_side === "L" ? "left" : "right"}` : "";
        const sides: string[] = [];
        if (t.has.L) sides.push(`L ${minutesShort(t.left)}`);
        if (t.has.R) sides.push(`R ${minutesShort(t.right)}`);
        if (t.has.B) {
          // Back and forth is its own bucket (never split into Left and Right): "1h 10m · back and forth, started right".
          if (t.has.L || t.has.R) sides.push(`both ${minutesShort(t.both)}`);
          else sides.push(minutesShort(t.total));
          bits.push(sides.join(", "));
          bits.push(started ? `back and forth, ${started}` : "back and forth");
        } else {
          if (sides.length) bits.push(sides.join(", "));
          if (started) bits.push(started);
        }
        if (e.data.shield) bits.push("shield");
      }
      break;
    }
    case "pump": {
      title = live ? "Pumping now" : stopped ? "Pump timer" : "Pumped";
      const hasSides = e.data.left_ml != null || e.data.right_ml != null;
      const total = e.data.total_ml ?? (hasSides ? (e.data.left_ml ?? 0) + (e.data.right_ml ?? 0) : null);
      bits.push(total != null ? formatVolume(total, units) : "Amount not logged");
      if (hasSides) {
        const side = (ml: number | undefined) => ml != null ? formatVolume(ml, units) : "not logged";
        bits.push(`L ${side(e.data.left_ml)} / R ${side(e.data.right_ml)}`);
      }
      const d = durationOf(e, now);
      if (d) bits.push(formatDuration(d));
      break;
    }
    case "diaper": {
      title = e.data.pee && e.data.poop ? "Wet + dirty diaper" : e.data.poop ? "Dirty diaper" : e.data.pee ? "Wet diaper" : "Dry diaper";
      if (e.data.color) bits.push(STOOL_COLOR_INFO[e.data.color].label.toLowerCase());
      if (e.data.texture) bits.push(e.data.texture);
      if (e.data.size) bits.push(e.data.size === "blowout" ? "blowout!" : e.data.size);
      if (e.data.rash) bits.push("rash");
      break;
    }
    case "sleep": {
      const d = durationOf(e, now);
      title = live ? "Sleeping now" : stopped ? "Sleep timer" : "Slept";
      if (d != null) bits.push(formatDuration(d));
      if (e.data.place) bits.push(`in ${e.data.place === "arms" ? "arms" : `the ${e.data.place}`}`);
      break;
    }
    case "growth": {
      title = e.data.at === "doctor" ? "Checkup measurements" : "Measured";
      if (e.data.weight_g != null) bits.push(formatWeight(e.data.weight_g, units));
      if (e.data.length_cm != null) bits.push(`${formatLength(e.data.length_cm, units)} long`);
      if (e.data.head_cm != null) bits.push(`head ${formatLength(e.data.head_cm, units)}`);
      break;
    }
    case "temp": {
      title = "Temperature";
      bits.push(formatTemp(e.data.temp_c, units));
      if (e.data.method) bits.push(e.data.method);
      break;
    }
    case "vitals": {
      title = "Vitals";
      if (e.data.heart_bpm != null) bits.push(`heart ${e.data.heart_bpm} bpm`);
      if (e.data.resp_rate != null) bits.push(`breathing ${e.data.resp_rate}/min`);
      if (e.data.spo2 != null) bits.push(`SpO₂ ${e.data.spo2}%`);
      if (e.data.jaundice) {
        if (e.data.heart_bpm == null && e.data.resp_rate == null && e.data.spo2 == null) title = "Skin check";
        bits.push(e.data.jaundice === "none" ? "no yellow" : `yellow: ${JAUNDICE_LABEL[e.data.jaundice].toLowerCase()}`);
      }
      break;
    }
    case "med": {
      title = e.data.name;
      if (e.data.dose) bits.push(e.data.dose);
      break;
    }
    case "tummy":
    case "bath": {
      title = e.kind === "tummy" ? (live ? "Tummy time now" : stopped ? "Tummy timer" : "Tummy time") : "Bath";
      const d = durationOf(e, now);
      if (d) bits.push(formatDuration(d));
      break;
    }
    case "note": {
      if (e.data.for_doctor) {
        title = e.data.done ? "Asked the doctor" : "Question for the doctor";
        if (e.data.answer) bits.push(`answer: ${e.data.answer}`);
      } else {
        title = NOTE_TAG_LABELS[e.data.tag ?? "other"]?.label ?? "Note";
        if (e.data.amount) bits.push(e.data.amount === "lots" ? "a lot" : e.data.amount === "some" ? "some" : "a little");
      }
      break;
    }
    case "moment": {
      const milestone = milestoneLabel(e.data.milestone, opts.words ?? NEUTRAL_MILESTONE_WORDS);
      title = e.data.title || milestone || "A moment";
      if (milestone && e.data.title && milestone !== e.data.title) bits.push(milestone);
      if (e.data.photos?.length) bits.push(`${e.data.photos.length} photo${e.data.photos.length === 1 ? "" : "s"}`);
      break;
    }
  }

  const detail = bits.join(" · ");
  const text = [title, detail, e.note ? `“${e.note}”` : ""].filter(Boolean).join(" · ");
  return { title, detail, text };
}

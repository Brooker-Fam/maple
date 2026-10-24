/**
 * One-line, human descriptions of entries ("Nursed · L 12m, R 8m"). Shared by
 * the app's lists, the MCP tools' replies, and the CSV export so every surface
 * words things the same way.
 */
import { feedMinutes, minutesShort } from "./feed";
import { JAUNDICE_LABEL, STOOL_COLOR_INFO } from "./guidelines";
import { milestoneLabel } from "./milestones";
import { formatDuration } from "./time";
import { formatLength, formatTemp, formatVolume, formatWeight } from "./units";
import type { Entry, EntryKind, UnitSystem } from "./types";

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

function durationOf(e: Entry, now: Date): number | null {
  if (!e.ended_at && !e.active) return null;
  const end = e.ended_at ? Date.parse(e.ended_at) : now.getTime();
  return Math.max(0, (end - Date.parse(e.started_at)) / 1000);
}

/** { title, detail } for lists; `text` joins them for plain-text surfaces. */
export function describeEntry(
  e: Entry,
  opts: { units?: UnitSystem; now?: Date } = {}
): { title: string; detail: string; text: string } {
  const units = opts.units ?? "us";
  const now = opts.now ?? new Date();
  let title: string = KIND_LABELS[e.kind];
  const bits: string[] = [];

  switch (e.kind) {
    case "feed": {
      if (e.data.method === "bottle") {
        title = "Bottle";
        if (e.data.amount_ml != null) bits.push(formatVolume(e.data.amount_ml, units));
        if (e.data.milk) bits.push(e.data.milk === "breastmilk" ? "breast milk" : e.data.milk);
      } else {
        title = e.active ? "Nursing now" : "Nursed";
        // The card's rows added up (feedMinutes), so lists, the day's totals and toasts agree.
        const t = feedMinutes(e, now);
        const sides: string[] = [];
        if (t.has.L) sides.push(`L ${minutesShort(t.left)}`);
        if (t.has.R) sides.push(`R ${minutesShort(t.right)}`);
        if (sides.length) bits.push(sides.join(", "));
        if (e.data.first_side && !e.active) bits.push(`started ${e.data.first_side === "L" ? "left" : "right"}`);
      }
      break;
    }
    case "pump": {
      title = e.active ? "Pumping now" : "Pumped";
      const total = e.data.total_ml ?? ((e.data.left_ml ?? 0) + (e.data.right_ml ?? 0) || null);
      if (total) bits.push(formatVolume(total, units));
      if (e.data.left_ml != null || e.data.right_ml != null) {
        bits.push(`L ${formatVolume(e.data.left_ml ?? 0, units)} / R ${formatVolume(e.data.right_ml ?? 0, units)}`);
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
      title = e.active ? "Sleeping now" : "Slept";
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
      title = e.kind === "tummy" ? (e.active ? "Tummy time now" : "Tummy time") : "Bath";
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
      const milestone = milestoneLabel(e.data.milestone);
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

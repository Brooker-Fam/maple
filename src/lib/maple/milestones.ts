/**
 * Milestones a moment can be tagged with (MomentData.milestone holds the id).
 *
 * Presets are the "Firsts" shelf on the Moments tab, roughly in the order they
 * tend to happen. Ids are stable slugs; labels are what people see. Other ids
 * also turn up: "monthly-N" (her monthly photo, lined up in "Growing up") and
 * celebration ids from insights.ts kept as moments ("week-1", "month-2", ...).
 *
 * Four presets name the Brookers' own people and pets, so only family 1
 * gets them (and only family 1's labels read them); every other family
 * gets the rest, and its baby's name where a label has one.
 *
 * Isomorphic: used by the app, describe.ts and the MCP tools.
 */

import type { Baby } from "./types";
import { babyFirstName } from "./voice";

export type MilestonePreset = {
  id: string;
  label: string;
  emoji: string;
  /** A soft line under the label on the shelf. */
  hint?: string;
};

export const MILESTONES: readonly MilestonePreset[] = [
  { id: "hello-world", label: "First photo", emoji: "🍁", hint: "The very first photo" },
  { id: "held-finger", label: "Held a finger", emoji: "🤲", hint: "That tiny grip" },
  { id: "met-zoe", label: "Met Zoe", emoji: "🐾", hint: "The couch commander approves" },
  { id: "met-bruce", label: "Bruce acknowledged Maple (eventually)", emoji: "🐈", hint: "From a dignified distance" },
  { id: "emmett-held", label: "Emmett held Maple", emoji: "🥋", hint: "Big brother, steady arms" },
  { id: "sapphire-read", label: "Sapphire read to Maple", emoji: "📖", hint: "A story from big sister" },
  { id: "first-bath", label: "First bath", emoji: "🛁", hint: "Sponge bath or the first real one" },
  { id: "cord-stump", label: "Cord stump fell off", emoji: "🌰", hint: "A tiny acorn moment" },
  { id: "first-checkup", label: "First checkup", emoji: "🩺" },
  { id: "first-outing", label: "First walk outside", emoji: "🍂", hint: "Leaves underfoot" },
  { id: "first-halloween", label: "First Halloween", emoji: "🎃", hint: "Smallest pumpkin in the patch" },
  { id: "met-grandparents", label: "Met the grandparents", emoji: "👵" },
  { id: "first-smile", label: "First real smile", emoji: "😊" },
  { id: "first-snow", label: "First snow", emoji: "❄️" },
  { id: "first-laugh", label: "First laugh", emoji: "🥰" },
  { id: "first-sniffles", label: "First sniffles", emoji: "🤧", hint: "Brave little nose" },
  { id: "crib-night", label: "First night in the crib", emoji: "🌙" },
  { id: "rolled-over", label: "Rolled over", emoji: "🔄" },
];

const FAMILY_ONE_ONLY = new Set(["met-zoe", "met-bruce", "emmett-held", "sapphire-read"]);

/** Whose presets a list or label uses, and the baby's first name ("the baby" before one is picked). */
export type MilestoneWords = { familyOne: boolean; name: string };

export const FAMILY_ONE_MILESTONE_WORDS: MilestoneWords = { familyOne: true, name: "Maple" };

/** One family's words, on the server: family 1's are fixed, every other family's name comes from its baby. */
export function milestoneWordsOf(familyId: number, baby: Pick<Baby, "name" | "nickname"> | null | undefined): MilestoneWords {
  return familyId === 1 ? FAMILY_ONE_MILESTONE_WORDS : { familyOne: false, name: babyFirstName(baby) };
}

/** No family to go by: no family's own presets or names. */
export const NEUTRAL_MILESTONE_WORDS: MilestoneWords = { familyOne: false, name: "the baby" };

const GENERIC = MILESTONES.filter((m) => !FAMILY_ONE_ONLY.has(m.id));

/** The presets this family gets, in shelf order. */
export function milestonesFor(w: MilestoneWords): readonly MilestonePreset[] {
  return w.familyOne ? MILESTONES : GENERIC;
}

const BY_ID = new Map(MILESTONES.map((m) => [m.id, m]));

export function milestonePreset(id: string | null | undefined, w: MilestoneWords): MilestonePreset | null {
  if (!id || (!w.familyOne && FAMILY_ONE_ONLY.has(id))) return null;
  return BY_ID.get(id) ?? null;
}

/** Monthly photo tag: "monthly-3" for her 3-month day. */
export function monthlyId(month: number): string {
  return `monthly-${month}`;
}

/** The month of a "monthly-N" tag, or null. */
export function monthlyNumber(id: string | null | undefined): number | null {
  const m = id ? /^monthly-(\d{1,2})$/.exec(id) : null;
  return m ? Number(m[1]) : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A readable label for any milestone id ("first-bath" → "First bath"). */
export function milestoneLabel(id: string | null | undefined, w: MilestoneWords): string {
  if (!id) return "";
  const preset = milestonePreset(id, w);
  if (preset) return preset.label;
  const monthly = monthlyNumber(id);
  if (monthly != null) return `Month ${monthly} photo`;
  let m: RegExpExecArray | null;
  if (id === "born") return "Hello, world";
  if ((m = /^week-(\d+)$/.exec(id))) return `${plural(Number(m[1]), "week")} old`;
  if ((m = /^month-(\d+)$/.exec(id))) return `${plural(Number(m[1]), "month")} old`;
  if ((m = /^day-(\d+)$/.exec(id))) return w.familyOne ? `${m[1]} days of Maple` : w.name === "the baby" ? `${m[1]} days old` : `${m[1]} days of ${w.name}`;
  if ((m = /^diapers-(\d+)$/.exec(id))) return `Diaper #${m[1]}`;
  if ((m = /^feeds-(\d+)$/.exec(id))) return `Feed #${m[1]}`;
  if (/^regained-/.test(id)) return "Back to birth weight";
  // Free text (or an id we don't know): de-slug it.
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Emoji for a milestone id, if it has one. */
export function milestoneEmoji(id: string | null | undefined, w: MilestoneWords): string | null {
  if (!id) return null;
  const preset = milestonePreset(id, w);
  if (preset) return preset.emoji;
  if (monthlyNumber(id) != null) return "🧸";
  if (id === "born") return "🍁";
  if (/^(week|month|day)-/.test(id)) return "🌳";
  if (/^regained-/.test(id)) return "🎈";
  if (/^(diapers|feeds)-/.test(id)) return "🎉";
  return null;
}

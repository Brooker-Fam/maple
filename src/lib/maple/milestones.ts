/**
 * Milestones a moment can be tagged with (MomentData.milestone holds the id).
 *
 * Presets are the "Firsts" shelf on the Moments tab, roughly in the order they
 * tend to happen. Ids are stable slugs; labels are what people see. Other ids
 * also turn up: "monthly-N" (her monthly photo, lined up in "Growing up") and
 * celebration ids from insights.ts kept as moments ("week-1", "month-2", ...).
 *
 * Isomorphic: used by the app, describe.ts and the MCP tools.
 */

export type MilestonePreset = {
  id: string;
  label: string;
  emoji: string;
  /** A soft line under the label on the shelf. */
  hint?: string;
};

export const MILESTONES: readonly MilestonePreset[] = [
  { id: "hello-world", label: "Hello, world", emoji: "🍁", hint: "The very first photo" },
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

const BY_ID = new Map(MILESTONES.map((m) => [m.id, m]));

export function milestonePreset(id: string | null | undefined): MilestonePreset | null {
  return id ? BY_ID.get(id) ?? null : null;
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
export function milestoneLabel(id: string | null | undefined): string {
  if (!id) return "";
  const preset = BY_ID.get(id);
  if (preset) return preset.label;
  const monthly = monthlyNumber(id);
  if (monthly != null) return `Month ${monthly} photo`;
  let m: RegExpExecArray | null;
  if (id === "born") return "Hello, world";
  if ((m = /^week-(\d+)$/.exec(id))) return `${plural(Number(m[1]), "week")} old`;
  if ((m = /^month-(\d+)$/.exec(id))) return `${plural(Number(m[1]), "month")} old`;
  if ((m = /^day-(\d+)$/.exec(id))) return `${m[1]} days of Maple`;
  if ((m = /^diapers-(\d+)$/.exec(id))) return `Diaper #${m[1]}`;
  if ((m = /^feeds-(\d+)$/.exec(id))) return `Feed #${m[1]}`;
  if (/^regained-/.test(id)) return "Back to birth weight";
  // Free text (or an id we don't know): de-slug it.
  const text = id.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Emoji for a milestone id, if it has one. */
export function milestoneEmoji(id: string | null | undefined): string | null {
  if (!id) return null;
  const preset = BY_ID.get(id);
  if (preset) return preset.emoji;
  if (monthlyNumber(id) != null) return "🧸";
  if (id === "born") return "🍁";
  if (/^(week|month|day)-/.test(id)) return "🌳";
  if (/^regained-/.test(id)) return "🎈";
  if (/^(diapers|feeds)-/.test(id)) return "🎉";
  return null;
}

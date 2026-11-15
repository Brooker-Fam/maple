import { fillExtra, type ExtraWords } from "./pick";

/**
 * Quips: one short line of whimsy for a moment that isn't a log, in the same
 * voice as the little extras (lines.ts): a milestone's fun line under its date
 * on the Celebrations card, and the thank-you at the end of While you slept.
 * Plain copy, never advice, a target or a comparison; nothing about weight or
 * health; any feeding and any family shape. Each one is picked from what it's
 * for (a milestone's id, the recap's start), never at random, so it never
 * changes between renders. The baby's words are filled in as the extras' are
 * ({name}, {he}, {his}…: fillExtra), at most two to a line, since with no sex
 * saved each one is the name. `pnpm exec tsx scripts/maple-quips-check.ts`.
 */

type Lines = readonly [string, ...string[]];

/** A stable number for a string (FNV-1a), so a pick is the same on every render. */
function seed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const pickBy = (lines: Lines, key: string) => lines[seed(key) % lines.length];

// ── Milestones (insights.ts milestonesReached) ─────────────────────────────

/** The milestones with an id of their own. */
const FIXED: Record<string, string> = {
  born: "Brand new, and already the most important person in the room.",
  "week-1": "Seven days in, and you're already fluent in tiny squeaks and sighs.",
  "week-2": "Two weeks of getting to know each other, one yawn at a time.",
  "week-3": "Three weeks of tiny stretches, big yawns and a lot of love.",
  "week-4": "Four weeks. Somehow it feels like forever and no time at all.",
  "day-100": "Triple digits. That calls for a small celebration, or a long nap.",
  // A cheer: the card offers no keepsake for this one.
  "first-poop": "The first of many. Congratulations, everyone.",
  "first-bath": "First bath done. Who got wetter, {name} or you?",
  "first-tummy": "Tummy time, take one. A whole new view of the world.",
};

/** Month-days with a line of their own ("12 months old today" is a first birthday). */
const MONTHS: Record<number, string> = {
  1: "One whole month. That's a lot of firsts, for everyone.",
  6: "Half a year of {name}. Time flies when you're this busy.",
  12: "A whole year. Happy first birthday, {name}.",
  18: "A year and a half of {name}. What a ride.",
  24: "Two whole years. Happy second birthday, {name}.",
};

/** The other month-days take these in turn, so one month never repeats the last. */
const ANY_MONTH: Lines = [
  "Happy month birthday, {name}.",
  "Another month of getting to know {him}. Look how far you've all come.",
  "The days can be long, but the months sure fly.",
  "Every month, a whole new {name} to get to know.",
];

/** Back to birth weight: a gentle cheer only, never a number or a word about size. */
const REGAINED: Lines = ["A lovely milestone. Well done, everyone.", "That's a lovely one to reach. Well done, all of you."];

/** "100 diapers" and the rest (insights.ts counts 100, 250, 500, 1,000 and 2,000). */
const DIAPERS: Record<number, string> = {
  100: "You could do this blindfolded now. Please don't.",
  250: "You could change one in your sleep by now. Some nights, you probably have.",
  500: "That's a lot of fresh starts, one tiny bottom at a time.",
  1000: "You've officially seen it all, and then some.",
  2000: "You could teach a class on this by now. Very hands-on.",
};
const ANY_DIAPERS: Lines = ["So many fresh starts. You make it look easy."];

/** "100 feeds" and the rest (100, 500 and 1,000): any feeding, so never a word about how. */
const FEEDS: Record<number, string> = {
  100: "Every one of them a little act of love. Burps included.",
  500: "Best little restaurant in town. Open around the clock, one very loyal regular.",
  1000: "Four digits, and the regular still hasn't left a tip.",
};
const ANY_FEEDS: Lines = ["That's a lot of meals, and a lot of love."];

/**
 * The fun line for a celebration, by its id (born, week-1…week-4, month-N,
 * day-100, first-poop, first-bath, first-tummy, regained-<entry id>,
 * diaper-N, feed-N), with the baby's name and pronouns filled in, or null for
 * an id this doesn't know (the card shows none).
 */
export function celebrationQuip(id: string, w: ExtraWords): string | null {
  const text = quipText(id);
  return text === null ? null : fillExtra(text, w);
}

function quipText(id: string): string | null {
  if (Object.hasOwn(FIXED, id)) return FIXED[id];
  const m = /^(month|diaper|feed)-([1-9]\d*)$/.exec(id);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === "month") return MONTHS[n] ?? ANY_MONTH[n % ANY_MONTH.length];
    if (m[1] === "diaper") return DIAPERS[n] ?? pickBy(ANY_DIAPERS, id);
    return FEEDS[n] ?? pickBy(ANY_FEEDS, id);
  }
  if (/^regained-\d+$/.test(id)) return pickBy(REGAINED, id);
  return null;
}

// ── While you slept ────────────────────────────────────────────────────────

/** Whoever logged while this person was away, by first name: one or two are named, more are the team. */
const THANKS = {
  one: ["{a} had it covered.", "{a} had it covered. Say thanks when you get a chance.", "{a} kept things running. Say thanks when you get a chance."],
  two: ["{a} and {b} had it covered.", "{a} and {b} had it covered. Say thanks when you get a chance."],
  team: ["The team had it covered.", "A real team effort. Say thanks when you get a chance."],
} satisfies Record<string, Lines>;

/**
 * The warm line that ends While you slept: `names` are the first names of the
 * others who logged while this person was away (as the card signs them, never
 * the viewer), `key` what keeps the pick steady (the recap's start). Null when
 * nobody else logged.
 */
export function handoffThanks(names: readonly string[], key: string): string | null {
  const people = names.map((n) => n.trim()).filter(Boolean);
  if (!people.length) return null;
  const lines = people.length === 1 ? THANKS.one : people.length === 2 ? THANKS.two : THANKS.team;
  // Functions, not strings, so a name with a "$" in it goes in as written.
  const line = pickBy(lines, key).replace("{a}", () => people[0]).replace("{b}", () => people[1] ?? "");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

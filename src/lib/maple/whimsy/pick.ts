import { EXTRAS } from "./lines";
import type { Extra, ExtraKind, ExtraMemory, ExtraMilk, ExtraTopic } from "./types";

/** At night (8 PM–7 AM) a quiet cheer at most this often: two diapers and a feed in ten minutes get one line, not three. */
export const NIGHT_GAP_MS = 45 * 60_000;
/** How many shown lines a phone remembers (a round of every pool, and then some). */
export const MAX_SEEN = 400;

export type PickInput = {
  /** The entry's topics, most specific first (extraTopics); null or empty: no line. */
  topics: ExtraTopic[] | null;
  /** Days old (extraAgeDays), or null before there's a birth time: only lines without ages. */
  ageDays: number | null;
  /** 8 PM–7 AM in the family's timezone, or the night look on: quiet cheers only, spaced out. */
  night: boolean;
  /** A bottle's milk (extraMilk), for lines only true of one. */
  milk?: ExtraMilk | null;
  memory: ExtraMemory;
  /** ms since the epoch. */
  now: number;
  /** For checks: a seeded random (default Math.random). */
  random?: () => number;
  /** For checks: the lines to pick from (default EXTRAS). */
  lines?: readonly Extra[];
};

/** Whether a line may follow an entry like this one, at this age, at this time of day. */
export function fits(line: Extra, o: Pick<PickInput, "topics" | "ageDays" | "night" | "milk">): boolean {
  if (!o.topics?.some((t) => line.topics.includes(t))) return false;
  if (o.night ? !line.night : line.night === "only") return false;
  if (line.ages && (o.ageDays === null || o.ageDays < line.ages[0] || o.ageDays >= line.ages[1])) return false;
  if (line.milk && line.milk !== o.milk) return false;
  return true;
}

/**
 * The line to show after an entry, and what the phone remembers after it, or
 * null for none. Every fitting line comes round once before any comes back (a
 * round over, the newest stays out so it never shows twice in a row); a line
 * about the entry's most specific topic is likelier than a general one (after
 * a poop: a poop line three times as likely as one for any log); and a kind
 * other than the last one shown goes first, so a fact, a joke and a cheer take
 * turns. At night only quiet cheers, at most one every NIGHT_GAP_MS.
 */
export function pickExtra(o: PickInput): { extra: Extra; memory: ExtraMemory } | null {
  const topics = o.topics ?? [];
  if (!topics.length) return null;
  if (o.night && o.memory.at !== null && o.now - o.memory.at < NIGHT_GAP_MS) return null;
  const pool = (o.lines ?? EXTRAS).filter((l) => fits(l, o));
  if (!pool.length) return null;
  const inPool = new Set(pool.map((l) => l.id));

  let seen = o.memory.seen;
  let fresh = pool.filter((l) => !seen.includes(l.id));
  if (!fresh.length) {
    // The round is over: forget this pool's lines but the newest, and go round again.
    const newest = [...seen].reverse().find((id) => inPool.has(id));
    seen = seen.filter((id) => !inPool.has(id) || id === newest);
    fresh = pool.filter((l) => !seen.includes(l.id));
    if (!fresh.length) fresh = pool;
  }
  const other = fresh.filter((l) => l.kind !== o.memory.kind);
  const from = other.length ? other : fresh;

  // Weighted by how specific its best topic is: the entry's first topic counts topics.length, its last 1.
  const weight = (l: Extra) => topics.length - Math.min(...l.topics.map((t) => topics.indexOf(t)).filter((i) => i >= 0));
  const total = from.reduce((a, l) => a + weight(l), 0);
  let roll = (o.random ?? Math.random)() * total;
  let extra = from[from.length - 1];
  for (const l of from) {
    roll -= weight(l);
    if (roll < 0) {
      extra = l;
      break;
    }
  }
  return { extra, memory: { seen: [...seen.filter((id) => id !== extra.id), extra.id].slice(-MAX_SEEN), at: o.now, kind: extra.kind } };
}

/** The words a line's tokens take: the same keys as familyWords' BabyWords. */
export type ExtraWords = Record<"name" | "Name" | "he" | "He" | "him" | "his" | "His" | "hes" | "Hes", string>;

export const EXTRA_TOKENS = ["name", "Name", "he", "He", "him", "his", "His", "hes", "Hes"] as const;
const TOKEN = /\{(name|Name|he|He|him|his|His|hes|Hes)\}/g;

/** A line with the baby's name and pronouns in ("{Hes} getting so good at this" → "She's getting so good at this"). */
export function fillExtra(text: string, w: ExtraWords): string {
  return text.replace(TOKEN, (_, key: keyof ExtraWords) => w[key]);
}

/** Every token a line uses, for the content checks (an unknown one stays in braces and fails them). */
export function extraTokens(text: string): string[] {
  return [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
}

/** The kinds a topic may carry: some only ever get a cheer (a question for the doctor, measurements, a bassinet try, her own food). */
export const CHEERS_ONLY: ReadonlySet<ExtraTopic> = new Set<ExtraTopic>(["doctor", "note", "growth", "try", "self"]);

export const KINDS: readonly ExtraKind[] = ["fact", "joke", "cheer"];

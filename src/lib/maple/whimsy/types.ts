/**
 * Little extras: one short line under a log's confirmation ("Pee · 3:14 PM"),
 * a fun fact, a gentle joke or a cheer for whoever is logging. They're copy,
 * never advice: a fact here is something to smile at, sourced, and never a
 * number to hold the baby up against. Anything a parent should act on belongs
 * in guidelines.ts, never here. Nothing about them is stored on the server or
 * sent anywhere: each phone keeps its own switch and the lines it has shown
 * (components/maple/extras.ts).
 */

/** A fun fact (sourced), a gentle joke, or a cheer for the person logging. */
export type ExtraKind = "fact" | "joke" | "cheer";

/**
 * What a line may follow. An entry has a few, most specific first
 * (extraTopics in topics.ts): a wet diaper is "pee", "diaper" and "care", so
 * its line can be about pee, about any change, or about any everyday log.
 */
export type ExtraTopic =
  /** Any everyday log: a diaper, a feed, pumping, a sleep, tummy time, a bath. */
  | "care"
  /** Any diaper change. */
  | "diaper"
  | "pee"
  | "poop"
  /** Any feed: nursing, a bottle, milk given at the breast. */
  | "feed"
  /** A nursing feed, finished. */
  | "nursing"
  /** A bottle (a feed of its own or a top-up). */
  | "bottle"
  | "pump"
  /** A sleep logged, or woken up from. */
  | "sleep"
  | "tummy"
  | "bath"
  /** A moment saved: a photo, a milestone. */
  | "moment"
  /** A question saved for the doctor (cheers only). */
  | "doctor"
  /** A note (spit-up, fussy, nails…; cheers only). */
  | "note"
  /** A note about hiccups. */
  | "hiccups"
  /** Measurements (cheers only: never a word about the numbers). */
  | "growth"
  /** A bassinet try finished, on the sleep plan (cheers only). */
  | "try"
  /** The care person's own food or drink, on her page (cheers only). */
  | "self";

/** The milk a bottle line is about, as FeedData.milk says it. */
export type ExtraMilk = "breastmilk" | "formula";

export type Extra = {
  /** Stable and unique ("poop-fact-meconium"): what a phone remembers having shown. */
  id: string;
  kind: ExtraKind;
  /** Where it may show: a line shows after an entry with any of these. */
  topics: ExtraTopic[];
  /**
   * The line itself: a sentence or two, at most EXTRA_MAX_CHARS. The baby is
   * {name}/{Name}, and {he} {He} {him} {his} {His} {hes} {Hes} are the baby's
   * pronouns (fillExtra). With no sex saved, the name stands in for each one
   * ("Sam" and "Sam's"), so a line never uses more than two of them.
   */
  text: string;
  /**
   * Only true from `from` days old, up to (not including) `to`: [0, 91] for a
   * newborn fact. Absent: true at any age, born yet or not.
   */
  ages?: [from: number, to: number];
  /**
   * The night (8 PM–7 AM) shows only quiet cheers, and only now and then:
   * "also" for a cheer calm enough for the night that's true by day too, "only"
   * for one about the night itself ("The night shift is the hardest shift"),
   * which never shows by day. Absent: a daytime line.
   */
  night?: "also" | "only";
  /** A bottle line that's only true of this milk. Absent: any bottle (or no bottle at all). */
  milk?: ExtraMilk;
  /** A fact's source: the page it comes from (AAP's HealthyChildren.org, the CDC, the NHS, the WHO…). Every fact has one. */
  source?: string;
};

/** What a phone remembers (extras.ts): the lines it has shown, newest last, and when and which kind it showed last. */
export type ExtraMemory = { seen: string[]; at: number | null; kind: ExtraKind | null };

export const EMPTY_MEMORY: ExtraMemory = { seen: [], at: null, kind: null };

/** The longest a line may be: it sits under a toast at 375 px, in two lines at most. */
export const EXTRA_MAX_CHARS = 110;

/**
 * Sleep goals' rules: pure functions shared by the app, the REST route and
 * the MCP tools (checked by scripts/maple-sleep-check.ts).
 *
 * - A goal's weeks run 7 nights at a time from the night it was set (the
 *   family's calendar date it was made), through its target date, or the
 *   last 4 weeks without one. Nights are try days (noon to noon, engine.ts
 *   tryDayKey), so a 2 AM try belongs to the evening before it, and a
 *   daylight-saving night is still one night.
 * - Every count says what it's out of ("3 of 5 nights"). No scores,
 *   streaks, grades, "failed" or best times; hard nights are counts too.
 * - Check-ins are the adults' own. A reader who can't see them (a
 *   view-only guest) gets null where their counts would be, never zeros.
 * - Roster hints read the log inside each adult's protected window (feeds,
 *   holding turns, tries): hints for the family, not verdicts.
 * - Nothing here is about anyone's health or recovery, and nothing here
 *   changes a goal: the family and the coach do that through the tools.
 */
import { feedingSleepyWords, SLEEP_GUIDES, sleepyLine } from "../guidelines/sleep";
import { addDays, dayKey, daysBetween, formatDuration, formatTime, isDayKey, parseDayKey, zonedTimeToUtc } from "../time";
import type { Entry, Role } from "../types";
import type { Voice } from "../voice";
import { sleepByPlace, tryDayBounds, tryDayKey, tryDayLabel } from "./engine";
import { SleepInputError } from "./errors";
import {
  CHECKIN_NIGHTS_BACK,
  CHECKIN_PLACES,
  GOAL_AHEAD_DAYS,
  GOAL_CUSTOM_MAX,
  GOAL_STEP_TITLE_MAX,
  GOAL_STEPS_MAX,
  GOAL_TARGETS_MAX,
  GOAL_TITLE_MAX,
  GOAL_WHY_MAX,
  HANDOFF_ANSWERS,
  PROTECTED_ANSWERS,
  REVIEW_DUE_DAYS,
  ROSTER_MAX,
  TARGET_KINDS,
  UNTIMED_MIN_RANGE,
  UNTIMED_TRIES,
  WINDOW_MAX_MINUTES,
  WINDOW_MIN_MINUTES,
  WINDOW_COVERS,
  GOAL_TEMPLATES,
  type GoalTemplate,
  type WindowCovers,
  type BassinetNightsTarget,
  type CheckinExtras,
  type BassinetStretchTarget,
  type BassinetTry,
  type CheckinPlace,
  type CustomTarget,
  type GoalInput,
  type GoalStatus,
  type GoalStep,
  type GoalTarget,
  type HandoffAnswer,
  type HoldingShift,
  type ProtectedAnswer,
  type ProtectedWindowTarget,
  type RosterWindow,
  type SleepCheckin,
  type SleepGoal,
  type UntimedTry,
} from "./types";
import { coversWords, dateWords, GOAL_STATUS_LABEL, HANDOFF_LABEL, minutesWords, nightsLabel, PLACE_LABEL, PROTECTED_LABEL, targetWords, weekdayOf, windowTimes, windowWords } from "./words";

const MIN = 60_000;
const DAY_MIN = 24 * 60;
const NOON = 12 * 60;
const ms = (iso: string) => Date.parse(iso);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const live = <T extends object>(xs: readonly T[]): T[] => xs.filter((x) => !(x as { deleted_at?: unknown }).deleted_at);
const maxKey = (a: string, b: string) => (a > b ? a : b);
const minKey = (a: string, b: string) => (a < b ? a : b);

/** A goal's ref in tool text: g3 (a log entry is #123, a try t12). */
export const goalRef = (id: number) => `g${id}`;

/**
 * Who reads the adults' check-ins: owners and members, never a view-only
 * guest (or a photos-only one). Goals, steps, the roster and the baby's
 * numbers are for anyone in the family but photos-only guests.
 */
export const seesCheckins = (role: Role) => role === "owner" || role === "member";
/** Who changes goals and saves a check-in (their own only): owners and members. */
export const writesGoals = seesCheckins;

// ── clock windows ────────────────────────────────────────────────────────

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** A local "HH:MM" (24-hour). */
export const isClock = (v: unknown): v is string => typeof v === "string" && CLOCK.test(v);
const clockMin = (hhmm: string) => {
  const m = CLOCK.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

/** A window's length on the clock, in minutes: from `from` to the next `to` (0 when they're the same). */
export function windowMinutes(from: string, to: string): number {
  return (clockMin(to) - clockMin(from) + DAY_MIN) % DAY_MIN;
}

/** Where a window sits in its night, in minutes after that evening's noon: [start, end). */
function inNight(w: Pick<RosterWindow, "from" | "to">): [number, number] {
  const start = (clockMin(w.from) - NOON + DAY_MIN) % DAY_MIN;
  return [start, start + windowMinutes(w.from, w.to)];
}

/**
 * The instants of a window on the night that begins on `night` (the date of
 * its evening). A time from noon on is that evening's, one before noon the
 * next morning's (as a try day), and the end is the next `to` after the
 * start. Built with zonedTimeToUtc, so across a clock change the real length
 * is an hour off the clock's and nothing shifts.
 */
export function windowOn(w: Pick<RosterWindow, "from" | "to">, night: string, tz: string): [Date, Date] {
  const f = clockMin(w.from);
  const startDay = f < NOON ? addDays(night, 1) : night;
  const endAt = f + windowMinutes(w.from, w.to);
  const endDay = addDays(startDay, Math.floor(endAt / DAY_MIN));
  const e = endAt % DAY_MIN;
  const a = parseDayKey(startDay);
  const b = parseDayKey(endDay);
  return [zonedTimeToUtc(a.year, a.month, a.day, Math.floor(f / 60), f % 60, tz), zonedTimeToUtc(b.year, b.month, b.day, Math.floor(e / 60), e % 60, tz)];
}

/** The window is on that night: its evening's weekday is one of its nights. */
export const windowOnNight = (w: Pick<RosterWindow, "nights">, night: string) => w.nights.includes(weekdayOf(night));

// ── days ─────────────────────────────────────────────────────────────────

/** The night a morning check-in is about: the one that began yesterday evening, by the family's calendar. */
export const lastNightKey = (now: Date | number, tz: string) => addDays(dayKey(now, tz), -1);

/** The family's calendar date a goal was set: its weeks start with that evening's night. */
export const goalStartKey = (g: Pick<SleepGoal, "created_at">, tz: string) => dayKey(ms(g.created_at), tz);

/** A YYYY-MM-DD that names a real day (not 2026-02-30). */
export const isRealDay = (key: unknown): key is string => isDayKey(key) && addDays(key, 0) === key;

/** Nights a check-in can be for: the last CHECKIN_NIGHTS_BACK, ending with last night. */
export function checkinNights(now: Date | number, tz: string): { first: string; last: string } {
  const last = lastNightKey(now, tz);
  return { first: addDays(last, -(CHECKIN_NIGHTS_BACK - 1)), last };
}

// ── the input rules ──────────────────────────────────────────────────────

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function text(raw: unknown, label: string, max: number, required: boolean): string | null {
  if (raw == null || raw === "") {
    if (required) throw new SleepInputError(`${label} is needed.`);
    return null;
  }
  if (typeof raw !== "string") throw new SleepInputError(`${label} must be text.`);
  const t = raw.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (!t) {
    if (required) throw new SleepInputError(`${label} is needed.`);
    return null;
  }
  if (t.length > max) throw new SleepInputError(`${label} is too long (${max} characters at most).`);
  return t;
}

function whole(raw: unknown, label: string, lo: number, hi: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < lo || raw > hi) throw new SleepInputError(`${label} must be a whole number from ${lo} to ${hi}.`);
  return raw;
}

/** A review's or a close's note: optional, at most GOAL_NOTE_MAX characters. */
export const cleanGoalNote = (raw: unknown, max: number) => text(raw, "The note", max, false);

/** A check-in's answer. */
export function cleanProtected(raw: unknown): ProtectedAnswer {
  if (!(PROTECTED_ANSWERS as readonly unknown[]).includes(raw)) throw new SleepInputError(`The answer must be ${PROTECTED_ANSWERS.join(", ")}.`);
  return raw as ProtectedAnswer;
}

/**
 * A check-in's extra answers about the baby's night (CheckinExtras), each
 * optional: undefined leaves one as it is, null clears it. `untimed_min` is
 * the minutes a "long" untimed try meant when it was asked.
 */
export function cleanCheckinExtras(raw: unknown): CheckinExtras {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SleepInputError("The night's answers must be an object.");
  const r = raw as Record<string, unknown>;
  const out: CheckinExtras = {};
  const pick = <K extends "place" | "untimed_try" | "handoff">(k: K, list: readonly string[], label: string) => {
    const v = r[k];
    if (v === undefined) return;
    if (v !== null && !list.includes(v as string)) throw new SleepInputError(`${label} must be one of ${list.join(", ")}.`);
    out[k] = v as CheckinExtras[K];
  };
  pick("place", CHECKIN_PLACES, "Where the baby spent the night");
  pick("untimed_try", UNTIMED_TRIES, "A try that isn't in the log");
  pick("handoff", HANDOFF_ANSWERS, "The handoff");
  if (r.untimed_min !== undefined) out.untimed_min = r.untimed_min === null ? null : whole(r.untimed_min, "The untimed try's minutes", UNTIMED_MIN_RANGE[0], UNTIMED_MIN_RANGE[1]);
  return out;
}

/** A check-in's night: one of the last CHECKIN_NIGHTS_BACK, ending with last night (a night still going can't be checked in yet). */
export function cleanCheckinNight(raw: unknown, now: Date, tz: string): string {
  const { first, last } = checkinNights(now, tz);
  if (raw == null || raw === "") return last;
  if (!isRealDay(raw)) throw new SleepInputError("The night must be a date like 2026-11-01 (the evening it began).");
  if (raw > last) throw new SleepInputError(`That night isn't over yet: check in the morning after (last night is ${last}).`);
  if (raw < first) throw new SleepInputError(`That night is too long ago (the last ${CHECKIN_NIGHTS_BACK} nights at most).`);
  return raw;
}

// ── what a plan never is ─────────────────────────────────────────────────
//
// The coach's rules made checkable, for every goal text (title, why, steps,
// a custom target) and the plan's goal, after the AAP's safe-sleep guidance
// (guidelines/sleep.ts has the sourced words): never leaving the baby to cry,
// by any name (cry it out, Ferber, controlled crying, timed waiting before
// going in, "5-10-15"), and never the baby asleep on or with an adult, in an
// adult bed, on a couch, recliner or armchair, in a sitting device (car seat,
// stroller, swing, carrier, sling, bouncer), on a product not made for infant
// sleep (loungers, nests, nursing pillows, inclined sleepers), on the tummy or
// side, with pillows, blankets, bumpers or other soft things, raised or
// tilted, or with anything weighted.
//
// A backstop, not a guarantee: it matches words, in English and a few common
// Spanish, French and German phrasings, so a plan worded some other way can
// get past it. The coach's own rules (sleep_goal's description) and the
// family's judgment carry the rest.
//
// Each sentence, and each part of it, is read on its own. A phrase after a
// step-away word anywhere earlier in its part ("stop", "no more", "never
// again", "move her from", "out of", "instead of") steps away from it, unless
// a new instruction starts in between ("stop the swaddle and let her …") or a
// bassinet follows the step-away word ("from the bassinet into our bed"). A
// place counts only with a sleep word and the baby in its part (a baby's own
// device is the baby enough), so "the bassinet beside our bed", "Theo sleeps
// on the couch" and "swing her gently" pass. Held sleep while an adult says
// they're awake is the app's own holding turn, rocking or feeding her to
// sleep somewhere and then the bassinet is its transfer, and "if she falls
// asleep in the car seat, move her to the bassinet" is the AAP's own advice:
// they pass, the first two with a caution (goalCautions). In "why it
// matters", how things are now is the reason for the goal, not its plan.
// Feeding words (formula, bottles, pumping, weaning) are never refused:
// goalCautions asks for the pediatrician's or lactation consultant's yes.

/** Where a text breaks into sentences. */
const SENTENCES = /[.;!?\n]+/;
/** Where a sentence breaks into parts: dashes, and the words that start another part. */
const PART_BREAK = /\s[-–—]\s|[–—]|\b(?:but|then|while|whereas|after|before|until|unless|once|because|when|whenever|if|so)\b/gi;
/** A step away from what follows (its last one before a phrase counts). */
const AWAY_CUE = new RegExp(
  String.raw`\b(?:no(?:\s+more|\s+longer)?|not|never(?:\s+again)?|nor|don'?t|do\s+not|doesn'?t|does\s+not|won'?t|will\s+not|wouldn'?t|can'?t|cannot|shouldn'?t|without|instead(?:\s+of)?|rather\s+than|other\s+than|stop|stops|stopped|stopping|quit|quits|quitting|end(?!s?\s+up)|ends(?!\s+up)|ending|avoid|avoids|avoiding|fewer|less|out\s+of|away\s+from|(?<!\b(?:nod|nods|nodded|nodding|drift|drifts|drifted|drifting|doze|dozes|dozed|dozing|drop|drops|dropped|dropping)\s)off|from(?!\s+\d)(?!\s+(?:noon|midnight|now|then|today|tonight|tomorrow)\b)|against|remove|removes|removing|take\s+(?:away|out)|taking\s+(?:away|out)|get\s+rid\s+of|ditch\w*|skip|skips|skipping|wean\w*|transition\w*|nunca|jam[áa]s|sin|dejar\s+de|deja\s+de|evitar|en\s+vez\s+de|en\s+lugar\s+de|ya\s+no|ne|pas|jamais|plus\s+de|sans|arret\w*|evit\w*|au\s+lieu\s+d[e']|nicht|nie|niemals|kein\w*|ohne|statt|anstatt|vermeiden|aufh[öo]ren)\b`,
  "gi"
);
/** A new instruction between a step-away word and the phrase: the step away doesn't reach it. */
const NEW_STEP = String.raw`\b(?:and|or|but|also|plus)\s+(?:let|lets|letting|put|putting|have|has|lay|laying|use|using|try|trying|keep|keeping|make|making|start|starting|give|giving|leave|leaving|place|placing|switch|go|going|just|she|he|they|we|i|you`;
/** In "why it matters", how things are now ("she only sleeps on me"), which is the reason for the goal, not its plan. */
const DESCRIBING_BEFORE = /\b(?:only|still|currently|usually|mostly|always|keeps?|ends? up|has been|have been|'s been|is|are|was|were|tends? to)\b/i;
const DESCRIBING_AFTER = /^\s*(?:now|right now|for now|at the moment|these days|lately|currently|most nights)\b/i;

const SLEEP_WORDS = String.raw`sleep(?!y)\w*|slept|asleep|naps?|napp\w*|doz(?:e|es|ed|ing)|snooz\w*|nod(?:s|ded|ding)?\s+off|drift(?:s|ed|ing)?\s+off|overnight|all\s+night|the\s+night|bedtime|dor(?:m\w*|t|s)|duerm\w*|siesta\w*|sue[ñn]o|noche|dodo|sieste\w*|endor\w*|nuit|schlaf\w*|einschlaf\w*|nickerchen|nacht`;
const SLEEPING = new RegExp(String.raw`\b(?:${SLEEP_WORDS})\b`, "i");
/** Laid down for a sleep, for the positions ("put her down on her tummy"). */
const LAID_DOWN = /\b(?:put|puts|putting|lay|lays|laying|laid|place|places|placing)\s+(?:her|him|them|the\s+baby|\p{Lu}\p{L}+)\s+(?:down|to\s+bed)\b/iu;
/** A baby's own sleep surface: the bassinet, a crib, their own sleep space. */
const SAFE_SURFACE_WORDS = String.raw`bassinets?|cribs?|cots?|side-?car|bedside\s+(?:co[\s-]?)?sleepers?|play\s*-?yards?|pack\s*(?:'?n'?|and)\s*plays?|moses\s+baskets?|(?:her|his|their|its|the\s+baby'?s|own|a)\s+sleep\s+space|own\s+sleep\s+space|safe\s+sleep\s+(?:area|space)|firm,?\s+(?:flat\s+)?sleep\s+surface|cunas?|mois[ée]s|berceau|lit\s+de\s+b[ée]b[ée]|babybett|beistellbett|stubenwagen`;
const SAFE_SURFACE = new RegExp(String.raw`\b(?:${SAFE_SURFACE_WORDS})\b`, "i");
/** Where she lies to sleep, named without a bassinet or crib: soft things and tilts there are about her sleep. */
const SLEEP_PLACE = /\b(?:mattress|sleep\s+surface|head\s+of\s+(?:the|her|his|their)\s+(?:bed|bassinet|crib|cot|mattress))\b/i;
/** Moved to the baby's own sleep surface: the transfer, or the AAP's "move them to a firm sleep surface". */
const TO_SAFE = new RegExp(String.raw`\b(?:lay|lays|laying|laid|put|puts|putting|place|places|placing|move|moves|moving|transfer\w*|then|before)\b[^.;!?]{0,60}?\b(?:${SAFE_SURFACE_WORDS})\b`, "i");
/** Baby things that put the baby in a part: a sleep surface, or what she wears to sleep. */
const BABY_THINGS = new RegExp(String.raw`\b(?:${SAFE_SURFACE_WORDS}|sleep\s*sacks?|swaddl\w*|sleepers?|onesies?)\b`, "i");
const SLEEP_VERB = String.raw`(?:sleep(?!y)\w*|slept|asleep|naps?|napp\w*|doz\w*)`;
const PEOPLE = "me|us|mom|mum|mommy|mummy|mama|momma|dad|daddy|papa|dada|grandma|grandpa|nana|granny";
/** "for a minute": a pause before going in, not crying it out. */
const BRIEF = /^\s*(?:for\s+)?(?:a\s+(?:minute|moment|second|few\s+seconds)|one\s+minute|1\s*(?:minute|min)\b|\d{1,2}\s*(?:seconds?|secs?)|briefly)\b/i;
const NUM = String.raw`(?:\d+|a\s+few|a\s+couple(?:\s+of)?|several|two|three|four|five|ten|fifteen|twenty|thirty)`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a refusal is about, for its words: crying it out, an adult, a bed, a couch or chair, a sitting device, a product not made for sleep, a position, bedding, weights or a tilt. */
export type UnsafeKind = "cry" | "adult" | "bed" | "couch" | "seat" | "product" | "position" | "bedding" | "weighted" | "incline";

/** The phrase that made a text unsafe, its kind, and what it names (for the refusal: "a couch", "a car seat"). */
export type UnsafeFind = { kind: UnsafeKind; phrase: string; what: string | null };

type Rule = {
  re: RegExp;
  kind: UnsafeKind;
  /** The part needs a sleep word; "down" also takes "put her down". */
  sleep?: boolean | "down";
  /** The part needs the baby: "strict" her name, "her" or "the baby"; "loose" a baby's sleep surface or sleep sack too; "sentence" the baby anywhere in the sentence ("side sleeping so she …"). */
  baby?: "strict" | "loose" | "sentence";
  /** A bassinet or crib in the part makes it something else ("sleeps next to us in the bassinet"). */
  unlessSafe?: boolean;
  /** Held sleep: an adult who says they're awake makes it the app's holding turn. */
  held?: boolean;
  /** Rocked or fed to sleep here, then the bassinet: the transfer, never with an adult dozing. */
  transfer?: "bed" | "couch";
  /** A sitting device: "if she falls asleep in it, move her to the bassinet" is the AAP's own advice. */
  seat?: boolean;
  /** A short pause ("for a minute") is fine. */
  brief?: boolean;
  /** Read across the whole sentence (timed waiting runs across its parts). */
  sentence?: boolean;
  /** The sentence must also say this (5-10-15 needs its checks or minutes). */
  needs?: RegExp;
  /** The sentence saying this makes it something else ("gentle sleep training"). */
  unless?: RegExp;
  /** The part names her sleep space (a bassinet, a mattress), or has a sleep word and the baby: soft things and tilts are about where she sleeps. */
  where?: boolean;
  /** The part saying this makes it something else (a swaddle's blanket). */
  unlessPart?: RegExp;
  /** The refusal's noun, from the match. */
  what?: (m: RegExpMatchArray) => string;
};

/** "a couch", "an armchair": the noun the refusal names. */
const article = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun.toLowerCase().replace(/\s+/g, " ")}`;
const SEAT_NAME: [RegExp, string][] = [
  [/car[\s-]?seat|infant\s+seat|silla|si[èe]ge|autositz|babyschale/i, "car seat"],
  [/stroller|pram|buggy|buggies|pushchair|cochecito|poussette|kinderwagen/i, "stroller"],
  [/swing|columpio|balancelle|schaukel/i, "swing"],
  [/bouncer|bouncy|transat|wippe/i, "bouncer"],
  [/sling|wrap|fular|[ée]charpe|tragetuch/i, "sling"],
  [/carrier|porte|mochila|trage/i, "carrier"],
  [/jumper|activity|exersaucer/i, "baby seat"],
  [/hamaca|hammock/i, "hammock"],
];
const seatName = (m: RegExpMatchArray) => article(SEAT_NAME.find(([re]) => re.test(m[0]))?.[1] ?? "baby seat");
const PRODUCT_NAME: [RegExp, string][] = [
  [/nursing|feeding|boppy|boppies/i, "nursing pillow"],
  [/nest|sleepyhead/i, "baby nest"],
  [/inclin|rock/i, "inclined sleeper"],
  [/hammock/i, "hammock"],
  [/bean/i, "bean bag"],
];
const productName = (m: RegExpMatchArray) => article(PRODUCT_NAME.find(([re]) => re.test(m[0]))?.[1] ?? "lounger");
const couchName = (m: RegExpMatchArray) => {
  const n = (m[1] ?? m[0]).toLowerCase();
  const noun = /sofa|canap|sof[áa]/.test(n) ? "sofa" : /couch|settee|futon|love|daybed|sessel/.test(n) ? "couch" : /recliner/.test(n) ? "recliner" : /glider/.test(n) ? "glider" : /rocking/.test(n) ? "rocking chair" : /arm|fauteuil|sill[óo]n/.test(n) ? "armchair" : "chair";
  return `${noun === "sofa" || noun === "couch" ? "on" : "in"} ${article(noun)}`;
};

type Voiceish = Pick<Voice, "name" | "named" | "pronoun" | "their">;

function unsafeRules(o: { v?: Voiceish; adults?: readonly string[] }): { rules: Rule[]; baby: RegExp; awake: RegExp; doze: RegExp } {
  const names = [...new Set((o.adults ?? []).map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && /^[\p{L}'-]{2,}$/u.test(n)))].map(escapeRe);
  const babyName = o.v?.named ? escapeRe(o.v.name) : null;
  const people = [PEOPLE, ...names].join("|");
  const nameOr = names.length ? `|${names.join("|")}` : "";
  // "her" as the baby, not "her earplugs": followed by a verb or a little word, or by nothing.
  const herObject =
    "\\s+(?:sleep\\w*|nap\\w*|doz\\w*|lie|lay|rest|stay|be|fall\\w*|drift\\w*|settle\\w*|cry\\w*|fuss\\w*|on|in|into|onto|with|to|for|from|at|by|near|next|beside|against|under|down|up|over|back|there|here|out|off|until|while|when|and|or|between|face)\\b|\\s*$|\\s*[,.;:!?)]";
  const pron = !o.v ? ["she", "he", "him", `her(?=${herObject})`] : o.v.pronoun === "she" ? ["she", `her(?=${herObject})`] : o.v.pronoun === "he" ? ["he", "him"] : ["they", "them"];
  const baby = new RegExp(`\\b(?:${[...pron, "(?:the\\s+)?baby", "newborn", ...(babyName ? [babyName] : [])].join("|")})\\b`, "i");
  const someone = `(?:her|him|them|the\\s+baby|baby${babyName ? `|${babyName}` : ""})`;
  // The baby's own tummy or side ("on her tummy"), and anyone else's chest or lap ("on Theo's chest", "on my chest").
  const babyPossessive = `(?:${!o.v ? "her|his|their" : o.v.their}|the\\s+baby'?s${babyName ? `|${babyName}'?s` : ""})`;
  const possessive = `(?:my|his|her|your|their|our|[a-z][a-z-]*'s${names.map((n) => `|${n}'?s`).join("")})`;
  const adultPossessive = `(?:my|your|our|mom'?s|mum'?s|dad'?s|daddy'?s|mommy'?s${o.v?.pronoun === "she" ? "|his" : o.v?.pronoun === "he" ? "|her" : ""}${names.map((n) => `|${n}'?s`).join("")})`;
  // An adult who says they're awake: "while I'm awake", "as long as Theo is awake", "while he's awake" when the baby is "she".
  const otherPron = o.v?.pronoun === "she" ? ["he'?s", "he\\s+is"] : o.v?.pronoun === "he" ? ["she'?s", "she\\s+is"] : [];
  const subjects = ["i'?m", "i\\s+am", "we'?re", "we\\s+are", "you'?re", "you\\s+are", ...otherPron, ...names.map((n) => `${n}(?:'s|\\s+is)`), "someone(?:'s|\\s+is)", "an?\\s+adult(?:'s|\\s+is)", "whoever(?:'s|\\s+is)\\s+holding\\s+\\w+"];
  const awake = new RegExp(
    `\\b(?:while|when|as\\s+long\\s+as|only\\s+(?:if|when|while)|if)\\s+(?:${subjects.join("|")})\\s+(?:wide\\s+|fully\\s+|still\\s+)?awake\\b|\\bawake\\s+adult\\b|\\bwhile\\s+awake\\b|\\b(?:i|we|you${nameOr})\\s+(?:stay|stays|staying|keep|keeps|keeping)\\s+awake\\b`,
    "i"
  );
  // An adult dozing in the part: "Doze with her …", "Theo naps on the couch …", "if I fall asleep …".
  const adultSubjects = ["i", "we", "you", "mom", "mum", "dad", ...(o.v?.pronoun === "she" ? ["he"] : o.v?.pronoun === "he" ? ["she"] : []), ...names];
  const doze = new RegExp(
    `^\\s*(?:and\\s+)?(?:doz\\w*|snooz\\w*|nap\\w*|sleep\\w*|fall\\w*\\s+asleep|nod\\w*\\s+off|drift\\w*\\s+off)\\b|\\b(?:${adultSubjects.join("|")})\\s+(?:might\\s+|may\\s+|could\\s+|will\\s+|'ll\\s+)?(?:doz\\w*|snooz\\w*|nap\\w*|sleep\\w*|fall\\w*\\s+asleep|nod\\w*\\s+off|drift\\w*\\s+off)\\b`,
    "i"
  );
  const seatWords = String.raw`car[\s-]?seats?|infant\s+seats?|strollers?|prams?|buggy|buggies|pushchairs?|swings?|bouncers?|bouncy\s+seats?|infant\s+carriers?|baby\s+carriers?|carriers?|slings?|baby\s+wraps?|jumpers?|activity\s+cent(?:er|re)s?|exersaucers?|silla\s+(?:de\s+)?(?:auto|coche|carro)|cochecito|columpio|hamaca|fular|mochila\s+portabeb[ée]s|si[èe]ge[\s-]+auto|porte[\s-]?b[ée]b[ée]|[ée]charpe(?:\s+de\s+portage)?|transat|balancelle|poussette|autositz|babyschale|kinderwagen|babyschaukel|babywippe|wippe|tragetuch`;
  const rules: Rule[] = [
    // ── Leaving the baby to cry, by any name ──
    { re: /\bcr(?:y|ies|ied|ying)[\s-]+it[\s-]+out\b/gi, kind: "cry" },
    { re: /\bcio\b/gi, kind: "cry" },
    { re: /\bferber\w*/gi, kind: "cry" },
    { re: /\bcontrolled[\s-]+(?:crying|comforting)\b/gi, kind: "cry" },
    { re: /\bextinction\b/gi, kind: "cry" },
    { re: /\bcheck[\s-]+and[\s-]+console\b/gi, kind: "cry" },
    { re: /\b(?:timed|graduated|progressive)[\s-]+(?:checks?|check[\s-]?ins?|intervals?|waits?|waiting|crying|soothing)\b/gi, kind: "cry" },
    { re: /\bcr(?:y|ies|ying)\s+(?:her|him|them)sel(?:f|ves)\s+to\s+sleep\b/gi, kind: "cry" },
    { re: /\bsleep[\s-]?train\w*/gi, kind: "cry", unless: /\b(?:gentle|no[\s-]?cry|without\s+(?:any\s+)?(?:crying|tears))\b/i },
    { re: new RegExp(`\\blet(?:s|ting)?\\s+${someone}\\s+(?:cry|cries|crying|scream|screams|screaming|wail|wailing|sob|sobbing)\\b`, "gi"), kind: "cry" },
    { re: new RegExp(`\\blet(?:s|ting)?\\s+${someone}\\s+(?:fuss|fusses|fussing)\\b`, "gi"), kind: "cry", brief: true },
    { re: new RegExp(`\\bleav(?:e|es|ing)\\s+${someone}\\b[^,;:]{0,40}?\\b(?:cry|cries|crying|fuss|fussing|scream|screaming|wail|wailing)\\b`, "gi"), kind: "cry" },
    { re: new RegExp(`\\bignor(?:e|es|ing)\\s+(?:${someone}(?:'s)?\\s+)?(?:cry|cries|crying|fussing|screaming|wailing)\\b`, "gi"), kind: "cry" },
    // Timed waiting before going in: "Wait 10 minutes before picking her up", "Don't go in until 3 AM".
    {
      re: new RegExp(
        `\\bwait(?:s|ed|ing)?\\s+(?:for\\s+)?(?:at\\s+least\\s+)?${NUM}(?:\\s*(?:-|–|to)\\s*\\d+)?\\s*(?:minutes?|mins?)\\b[^.;!?]*?\\b(?:before|until|then|when|if|while)\\b[^.;!?]*?\\b(?:go(?:ing)?\\s+in|pick(?:s|ing)?\\b|respond\\w*|comfort\\w*|sooth\\w*|check(?:ing)?\\s+on|cry|cries|crying|fuss\\w*)`,
        "gi"
      ),
      kind: "cry",
      sentence: true,
    },
    { re: new RegExp(`\\b(?:don'?t|do\\s+not|never|no)\\s+(?:go(?:ing)?\\s+in|pick(?:ing)?\\s+(?:${someone}\\s+)?up|respond(?:ing)?|comfort(?:ing)?)\\s+(?:to\\s+${someone}\\s+)?(?:until|before|for\\s+${NUM}\\s*(?:minutes?|mins?|hours?))\\b`, "gi"), kind: "cry", sentence: true },
    { re: /\b\d{1,2}\s*[-–/,]\s*\d{1,2}\s*[-–/,]\s*\d{1,2}\b/g, kind: "cry", sentence: true, needs: /\b(?:check\w*|method|minutes?|mins?|wait\w*|intervals?|cry\w*|go(?:ing)?\s+in)\b/i },
    { re: /\b(?:dejar(?:la|lo|le)?|d[ée]ja(?:la|lo)|dejamos)\s+llorar\b|\bllorar\s+hasta\b/gi, kind: "cry" },
    { re: /\blaisser\s+(?:la\s+|le\s+|l')?pleurer\b|\blaiss(?:e|ez|ons)\s+(?:la|le)\s+pleurer\b/gi, kind: "cry" },
    { re: /\b(?:schreien|weinen)\s+(?:zu\s+)?lassen\b/gi, kind: "cry" },

    // ── Raised or tilted, and products not made for infant sleep (before soft things: a nursing pillow is a product) ──
    { re: new RegExp(`\\b(?:rais(?:e|es|ed|ing)|elevat\\w*|tilt\\w*|angl(?:e|ed|ing)|inclin\\w*|wedg\\w*|prop(?:s|ped|ping)?\\s+(?:${someone}\\s+)?up)\\b`, "gi"), kind: "incline", where: true },
    { re: /\b(?:loungers?|baby\s+nests?|sleep\s+nests?|nests?|nursing\s+pillows?|feeding\s+pillows?|boppy|boppies|dock[\s-]?a[\s-]?tots?|sleepyheads?|rock[\s-]?(?:n|'n'|’n’|and)[\s-]?plays?|inclined?\s+sleepers?|sleep\s+positioners?|positioners?|hammocks?|bean\s*bags?)\b/gi, kind: "product", sleep: true, what: productName },

    // ── On the tummy or side ──
    { re: new RegExp(`\\b(?:on|onto)\\s+${babyPossessive}\\s+(?:tummy|stomach|front|belly|side)\\b(?!\\s+time)`, "gi"), kind: "position", sleep: "down" },
    { re: /\b(?:tummy|stomach|belly|side|front)[\s-]+(?:sleep\w*|nap\w*)\b/gi, kind: "position", baby: "sentence" },
    { re: /\bprone\b|\bface[\s-]?down\b/gi, kind: "position", sleep: "down", baby: "strict" },
    { re: /\bboca\s+abajo\b|\bde\s+(?:lado|costado)\b|\bsur\s+le\s+(?:ventre|c[ôo]t[ée])\b|\bbauchlage\b|\bseitenlage\b|\bauf\s+(?:dem\s+bauch|der\s+seite)\b/gi, kind: "position", sleep: true },

    // ── Sharing an adult bed (before "sleeps with us", so co-sleeping is named as the bed it is) ──
    { re: /(?<!bedside\s)\bco[\s-]?sleep(?!er\s+(?:bassinet|crib|cot))\w*/gi, kind: "bed" },
    { re: /\bbed[\s-]?shar\w*/gi, kind: "bed" },
    { re: /\bfamily\s+bed\b|\bcolecho\b|\bcama\s+familiar\b|\bco[\s-]?dodo\b|\bcododo\b|\bfamilienbett\b|\belternbett\b/gi, kind: "bed" },

    // ── Asleep on or with an adult ──
    { re: /\bcontact\s+(?:naps?|napping|sleeps?|sleeping)\b/gi, kind: "adult", held: true },
    { re: /\bskin[\s-]to[\s-]skin\s+(?:naps?|napping|sleeps?|sleeping)\b/gi, kind: "adult", held: true },
    { re: new RegExp(`\\b${SLEEP_VERB}\\s+(?:only\\s+)?on\\s+(?:${people})\\b`, "gi"), kind: "adult", held: true },
    { re: new RegExp(`\\bon\\s+${possessive}\\s+(?:chest|lap|shoulder)\\b`, "gi"), kind: "adult", sleep: true, held: true },
    { re: new RegExp(`\\bon\\s+${adultPossessive}\\s+(?:tummy|belly|stomach)\\b`, "gi"), kind: "adult", sleep: true, held: true },
    { re: new RegExp(`\\b${SLEEP_VERB}\\s+(?:only\\s+)?(?:with|next\\s+to|beside)\\s+(?:${people})\\b`, "gi"), kind: "adult", unlessSafe: true },
    { re: new RegExp(`\\bbetween\\s+(?:us|you|the\\s+two\\s+of\\s+(?:us|you)|mom\\s+and\\s+dad|dad\\s+and\\s+mom${names.length > 1 ? `|(?:${names.join("|")})\\s+and\\s+(?:${names.join("|")})` : ""})\\b`, "gi"), kind: "adult", sleep: true, baby: "strict" },

    // ── In an adult bed ──
    { re: new RegExp(`\\bin\\s+bed\\s+with\\s+(?:${people})\\b`, "gi"), kind: "bed", baby: "strict" },
    {
      re: /\b(?:in|on|into|onto)\s+(?:the|a|our|my|your|mom'?s|mum'?s|dad'?s|mommy'?s|daddy'?s|parents'?|grown[\s-]?up|adult|big|double|queen|king)\s+(?:own\s+|big\s+|grown[\s-]?up\s+|adult\s+)?bed\b/gi,
      kind: "bed",
      sleep: true,
      baby: "strict",
      transfer: "bed",
    },
    // "in bed" with nothing before "bed" ("nurse her to sleep in bed and keep her there"), but not "in bed by 8" in her crib.
    { re: /\bin\s+bed\b(?!\s+by\b)/gi, kind: "bed", sleep: true, baby: "strict", unlessSafe: true, transfer: "bed" },
    { re: /\ben\s+(?:nuestra|la|mi|tu)\s+cama\b|\bdans\s+(?:notre\s+lit|le\s+grand\s+lit|le\s+lit\s+(?:des\s+parents|parental))\b|\bim\s+(?:gro[ßs]en\s+)?bett\b|\bbei\s+uns\s+im\s+bett\b/gi, kind: "bed", sleep: true },

    // ── On a couch, recliner or armchair ──
    {
      re: /\b(?:on|onto|in)\s+(?:the|a|our|my|his|her|their|your)\s+(couch|sofa|settee|futon|loveseat|love\s+seat|daybed)\b/gi,
      kind: "couch",
      sleep: true,
      baby: "strict",
      transfer: "couch",
      what: couchName,
    },
    {
      re: /\b(?:in|on|into)\s+(?:the|a|an|our|my|his|her|their|your|mom'?s|dad'?s)\s+(recliner|armchair|arm[\s-]chair|easy\s+chair|glider|rocking\s+chair|rocker|nursing\s+chair|chair)\b/gi,
      kind: "couch",
      sleep: true,
      baby: "strict",
      transfer: "couch",
      what: couchName,
    },
    { re: /\ben\s+el\s+(sof[áa]|sill[óo]n)\b|\bsur\s+le\s+(canap[ée]|sofa)\b|\bdans\s+le\s+(fauteuil)\b|\bauf\s+(?:dem|der)\s+(sofa|couch)\b|\bim\s+(sessel)\b/gi, kind: "couch", sleep: true, what: couchName },

    // ── Sitting devices (the baby's own, so no other word for the baby is needed) ──
    { re: new RegExp(`\\b(?:${seatWords})\\b`, "gi"), kind: "seat", sleep: true, seat: true, what: seatName },

    // ── Soft things in the sleep space ──
    { re: /\bblankets?\b/gi, kind: "bedding", where: true, unlessPart: /\bswaddl\w*/i },
    {
      re: /\b(?:pillows?|bumpers?|bumper\s+pads?|quilts?|duvets?|comforters?|sheepskins?|stuffed\s+(?:animals?|toys?)|soft\s+toys?|plush(?:ies|ie|y)?|toys?|loose\s+(?:bedding|sheets?)|soft\s+bedding|bedding|mattress\s+toppers?|rolled[\s-]+(?:up\s+)?(?:towels?|blankets?)|towels?|lovey|loveys|lovies|cushions?|almohad\w*|mantas?|cobijas?|oreillers?|couvertures?|tour\s+de\s+lit|kissen|decken?|nestchen)\b/gi,
      kind: "bedding",
      where: true,
    },
    // ── Anything weighted ──
    { re: /\bweighted\b|\bbeschwert\w*|\blest(?:ée|é)s?\b/gi, kind: "weighted", baby: "loose" },
  ];
  return { rules, baby, awake, doze };
}

/** A sentence's parts, with where each starts and the word that began it ("if", "then"). */
function partsOf(sentence: string): { text: string; start: number; lead: string }[] {
  const out: { text: string; start: number; lead: string }[] = [];
  let at = 0;
  let lead = "";
  for (const m of sentence.matchAll(PART_BREAK)) {
    out.push({ text: sentence.slice(at, m.index), start: at, lead });
    lead = m[0].trim().toLowerCase();
    at = (m.index ?? 0) + m[0].length;
  }
  out.push({ text: sentence.slice(at), start: at, lead });
  return out;
}

/**
 * Whether the words before a phrase (in its part, after any comma) step away
 * from it: their last step-away word, unless a new instruction starts after
 * it or the bassinet comes after it ("from the bassinet into our bed" steps
 * away from the bassinet, toward the bed).
 */
function awayFrom(before: string, newStep: RegExp): boolean {
  let end = -1;
  for (const m of before.matchAll(AWAY_CUE)) end = (m.index ?? 0) + m[0].length;
  if (end < 0) return false;
  const rest = before.slice(end);
  return !SAFE_SURFACE.test(rest) && !newStep.test(rest);
}

/** What a scan found: the unsafe phrase, or what made a phrase safe (held while awake, the transfer), for the cautions. */
type SafetyScan = { find: UnsafeFind | null; held: boolean; transfer: ("bed" | "couch")[] };

function scanSleep(text: string, o: { v?: Voiceish; adults?: readonly string[]; describing?: boolean }): SafetyScan {
  const out: SafetyScan = { find: null, held: false, transfer: [] };
  if (!text) return out;
  const { rules, baby, awake, doze } = unsafeRules(o);
  const names = [...new Set((o.adults ?? []).map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && /^[\p{L}'-]{2,}$/u.test(n)))].map(escapeRe);
  const newStep = new RegExp(`${NEW_STEP}${names.length ? `|${names.join("|")}` : ""})\\b`, "i");
  const babyIn = (s: string, how: Rule["baby"]) => baby.test(s) || (how === "loose" && BABY_THINGS.test(s));
  // Read without accents and with straight apostrophes, so "sofá", "côté" and a phone's "Don’t" meet the rules' plain letters.
  const plainText = text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[‘’ʼ`]/g, "'");
  for (const sentence of plainText.split(SENTENCES)) {
    if (!sentence.trim()) continue;
    const parts = partsOf(sentence);
    // A phrase read across the sentence (timed waiting) checks its step-away words in the sentence before it.
    const check = (rule: Rule, m: RegExpMatchArray, part: { text: string; start: number; lead: string }, at: number): boolean => {
      if (rule.needs && !rule.needs.test(sentence)) return false;
      if (rule.unless && rule.unless.test(sentence)) return false;
      const scope = rule.sentence ? sentence : part.text;
      if (rule.sleep && !(SLEEPING.test(scope) || (rule.sleep === "down" && LAID_DOWN.test(scope)))) return false;
      if (rule.baby && !babyIn(rule.baby === "sentence" ? sentence : scope, rule.baby)) return false;
      if (rule.unlessSafe && SAFE_SURFACE.test(scope)) return false;
      if (rule.unlessPart && rule.unlessPart.test(scope)) return false;
      if (rule.where && !(SAFE_SURFACE.test(scope) || SLEEP_PLACE.test(scope) || (SLEEPING.test(scope) && baby.test(scope)))) return false;
      const before = scope.slice(0, at).split(/[,:(]/).pop()!;
      if (awayFrom(before, newStep)) return false;
      const after = scope.slice(at + m[0].length);
      if (o.describing && (DESCRIBING_BEFORE.test(before.trim().split(/\s+/).slice(-3).join(" ")) || DESCRIBING_AFTER.test(after))) return false;
      if (rule.brief && BRIEF.test(after)) return false;
      if (rule.held && awake.test(sentence)) {
        out.held = true;
        return false;
      }
      if (rule.transfer && !doze.test(part.text) && TO_SAFE.test(sentence.slice(part.start + at + m[0].length))) {
        out.transfer.push(rule.transfer);
        return false;
      }
      // "If she falls asleep in the car seat, move her to the bassinet": the AAP's own advice for a sitting device.
      if (rule.seat && /^(?:if|when|whenever|once)$/.test(part.lead) && TO_SAFE.test(sentence.slice(0, part.start + at) + " " + sentence.slice(part.start + at + m[0].length))) return false;
      return true;
    };
    for (const rule of rules.filter((r) => r.sentence)) {
      for (const m of sentence.matchAll(rule.re)) {
        const whole = { text: sentence, start: 0, lead: "" };
        if (check(rule, m, whole, m.index ?? 0)) return { ...out, find: { kind: rule.kind, phrase: m[0], what: rule.what?.(m) ?? null } };
      }
    }
    for (const part of parts) {
      if (!part.text.trim()) continue;
      for (const rule of rules) {
        if (rule.sentence) continue;
        for (const m of part.text.matchAll(rule.re)) {
          if (check(rule, m, part, m.index ?? 0)) return { ...out, find: { kind: rule.kind, phrase: m[0], what: rule.what?.(m) ?? null } };
        }
      }
    }
  }
  return out;
}

/**
 * Whether a plan's words leave the baby to cry, or have the baby asleep
 * anywhere but on their back in their own bare, flat sleep space (above),
 * and the phrase that does. `v`: the family's voice (the baby's name and
 * pronouns); `adults`: the adults' names; `describing`: the words say why it
 * matters, where "she only sleeps on me now" is the reason, not the plan.
 */
export function unsafeSleep(text: string, o: { v?: Voiceish; adults?: readonly string[]; describing?: boolean } = {}): UnsafeFind | null {
  return scanSleep(text, o).find;
}

/** What made a text's held sleep or transfer pass (for goalCautions): held while an adult is awake, and rocked or fed in a bed or chair, then the bassinet. */
export function sleepExemptions(text: string, o: { v?: Voiceish; adults?: readonly string[] } = {}): { held: boolean; transfer: ("bed" | "couch")[] } {
  const s = scanSleep(text, o);
  return s.find ? { held: false, transfer: [] } : { held: s.held, transfer: [...new Set(s.transfer)] };
}

/**
 * The refusal, by its field, in words that help: what Maple won't plan, and a
 * safe way to say a step away from it ("Step 2: Maple won't plan sleep on a
 * couch; if this is a step away from it, try "Bassinet before I get
 * sleepy"."). The baby is "the baby" where the words have no voice. Every
 * suggestion passes unsafeSleep itself (the check holds it to that).
 */
export function unsafeWords(label: string, v?: Pick<Voice, "name" | "them" | "their" | "they" | "verb" | "named">, find?: Pick<UnsafeFind, "kind" | "what"> | null): string {
  const who = v?.name ?? "the baby";
  const them = v?.them ?? "the baby";
  const their = v ? v.their : "the baby's";
  const they = v?.they ?? "the baby";
  const verb = (s: string) => (v ? v.verb(s) : s);
  const kind = find?.kind ?? "cry";
  const words: Record<UnsafeKind, string> = {
    cry: `Maple won't plan leaving ${who} to cry; if this is about settling ${them}, try "Soothe ${them}, then try the bassinet once more".`,
    adult: `Maple won't plan ${who} sleeping on or with an adult; if this is a step away from it, try "Hold ${them} only while I'm awake, then the bassinet".`,
    bed: `Maple won't plan ${who} sleeping in an adult bed; if this is a step away from it, try "Move ${them} from our bed to the bassinet".`,
    couch: `Maple won't plan sleep ${find?.what ?? "on a couch"}; if this is a step away from it, try "Bassinet before I get sleepy".`,
    seat: `Maple won't plan sleep in ${find?.what ?? "a car seat"}; try "If ${they} ${verb("falls")} asleep in the ${(find?.what ?? "a car seat").replace(/^an? /, "")}, move ${them} to the bassinet".`,
    product: `Maple won't plan sleep on ${find?.what ?? "a lounger"}, which isn't made for infant sleep; try "Every sleep on ${their} back in the bassinet".`,
    position: `Maple won't plan sleep on ${their} tummy or side; try "On ${their} back for every sleep, and tummy time while ${they}${verb("'s")} awake".`,
    bedding: `Maple won't plan pillows, blankets, bumpers or other soft things in ${their} sleep space; try "A bare bassinet with just a fitted sheet".`,
    weighted: `Maple won't plan anything weighted for ${their} sleep; try "A sleep sack with no weights".`,
    incline: `Maple won't plan raising or tilting ${their} sleep surface; try "Flat on ${their} back in the bassinet" (questions like reflux go to ${their} pediatrician).`,
  };
  return `${label}: ${words[kind]}`;
}

/** A plan's or goal's text checked against unsafeSleep; throws SleepInputError with unsafeWords. */
export function refuseUnsafe(text: string | null | undefined, label: string, o: { v?: Voice; adults?: readonly string[]; describing?: boolean } = {}): void {
  const find = text ? unsafeSleep(text, o) : null;
  if (find) throw new SleepInputError(unsafeWords(label, o.v, find));
}

// ── what a goal's words need said with them (read-backs and the goal card) ──

/** Under this many days old, "Feeds come first" applies (guidelines/sleep.ts normal-feeds-first), so a target past FEEDS_FIRST_MINUTES gets its words. */
export const FEEDS_FIRST_DAYS = 28;
export const FEEDS_FIRST_MINUTES = 240;
/** A protected window longer than this (FEEDS_FIRST_MINUTES in the first 4 weeks), with no feed planned in it, gets its caution. */
export const LONG_WINDOW_MINUTES = 300;

/** Words that change how the baby is fed, which a plan may hold only with the pediatrician's or lactation consultant's yes. */
const FEEDING = /\b(?:formula|bottles?|bottle-?f\w*|pump\w*|express(?:ed|ing)?\s+milk|wean\w*|supplement\w*|top[\s-]?ups?|dream[\s-]?feed\w*|(?:drop|dropping|skip|skipping|cut(?:ting)?\s+out|stretch(?:ing)?|space\s+out)\s+(?:the\s+|a\s+|one\s+|her\s+|his\s+|their\s+)?(?:[\w:]+\s+){0,2}feeds?)\b/i;
/** Already a question for them: "Ask the lactation consultant whether …". */
const ASKING = /^(?:ask|check\s+with|talk\s+(?:to|with)|call|find\s+out|see\s+if|raise|bring\s+up)\b|\b(?:ask|check\s+with|talk\s+(?:to|with)|question\s+for)\s+(?:the\s+|our\s+|her\s+|his\s+|their\s+)?(?:pediatrician|paediatrician|doctor|lactation|lc|ibclc|midwife|nurse|consultant)\b/i;

export type GoalCaution = { kind: "feeds_first" | "long_window" | "bottle" | "feeding" | "awake" | "transfer"; text: string };

/** "the step "A" and the step "B"" with its verb agreeing: the texts a caution is about. */
function aboutTexts(xs: readonly { label: string; text: string }[], one: string, many: string): { what: string; verb: string; it: string } {
  const what = xs.map((x) => `${x.label} "${x.text}"`).join(" and ");
  return { what: `${what.charAt(0).toUpperCase()}${what.slice(1)}`, verb: xs.length > 1 ? many : one, it: xs.length > 1 ? "them" : "it" };
}

/**
 * What a goal as it would be saved needs said with it. Warnings, never
 * refusals:
 * - "Feeds come first", quoted, for a target past 4 hours while the baby is
 *   under 4 weeks old (`ageDays` today; null before she's born; undefined:
 *   not known, so not said).
 * - Each protected window by how its feeds are covered (`covers`) and her
 *   age: nursing in it needs nothing said; a bottle in it is a question for
 *   their pediatrician or lactation consultant before about 4 weeks, and
 *   after that a reminder to plan pumping around that feed (only when she
 *   nurses, or might); with no feed planned in it (or nothing said), a window
 *   over 5 hours (4 in her first weeks) says who could cover one.
 * - A step or aim that changes how the baby is fed: save it only with their
 *   clinician's yes.
 * - Held sleep that's fine because an adult stays awake (Maple's sleepy
 *   line), and the transfer from an adult bed or a chair (the AAP's and
 *   NICHD's words for it). `adults`: their names, as the rules read them.
 */
export function goalCautions(
  f: Pick<GoalFields, "title" | "why" | "targets" | "steps" | "roster" | "template">,
  o: { v: Voice; name: (id: string) => string; ageDays?: number | null; adults?: readonly string[] }
): GoalCaution[] {
  const out: GoalCaution[] = [];
  const v = o.v;
  const young = o.ageDays !== undefined && (o.ageDays === null || o.ageDays < FEEDS_FIRST_DAYS);
  const long = (f.targets ?? []).filter((t) => (t.kind === "bassinet_stretch" && t.minutes > FEEDS_FIRST_MINUTES) || (t.kind === "bassinet_nights" && t.min_minutes > FEEDS_FIRST_MINUTES));
  if (young && long.length) {
    const guide = SLEEP_GUIDES.find((g) => g.id === "normal-feeds-first");
    const aims = long.map((t) => `"${targetWords(t, o.name)}"`);
    out.push({
      kind: "feeds_first",
      text: `${aims.join(" and ")} ${aims.length > 1 ? "ask" : "asks"} for more than 4 hours in ${v.name}'s first 4 weeks. Maple's guidance for ${v.their} age: "${guide ? guide.body(v) : `If ${v.name} sleeps longer than 4 hours at night, wake ${v.them} to feed.`}"`,
    });
  }
  // Who nurses, when a template said (null: bottles only, so a bottle changes nothing); undefined: not known.
  const nurser = f.template ? f.template.nursing : undefined;
  for (const w of f.roster ?? []) {
    const who = o.name(w.member);
    const times = windowTimes(w);
    if (w.covers === "nurse") continue;
    if (w.covers === "bottle") {
      if (nurser === null) continue;
      out.push({
        kind: "bottle",
        text: young
          ? `A bottle in ${who}'s window (${times}): ${nurser ? "" : `if ${v.name} nurses, `}bottles are a question for their pediatrician or lactation consultant first, usually not before about 4 weeks old; until then, whoever's on duty can bring ${v.them} to nurse and settle ${v.them} after.`
          : `A bottle in ${who}'s window (${times}): ${nurser ? `plan when ${o.name(nurser)} pumps` : `if ${v.name} nurses, plan when the nursing parent pumps`} around that feed, as their lactation consultant advises.`,
      });
      continue;
    }
    // No feed planned in it, or nothing said about one: only a window long enough to need one.
    if (windowMinutes(w.from, w.to) <= (young ? FEEDS_FIRST_MINUTES : LONG_WINDOW_MINUTES)) continue;
    out.push({
      kind: "long_window",
      text: young
        ? `${who}'s window, ${times}, is longer than 4 hours with no feed planned in it: in ${v.name}'s first weeks feeds come first, so whoever's on duty can bring ${v.them} to nurse in it and settle ${v.them} after (a bottle for a nursing baby waits for their pediatrician's or lactation consultant's yes).`
        : `${who}'s window, ${times}, is longer than 5 hours with no feed planned in it: say who covers a feed then (bringing ${v.them} to nurse, or a bottle), and ask their pediatrician or lactation consultant before starting bottles for a nursing baby.`,
    });
  }
  const texts: { label: string; text: string }[] = [
    ...(f.title ? [{ label: "the title", text: f.title }] : []),
    ...(f.why ? [{ label: "why it matters", text: f.why }] : []),
    ...(f.steps ?? []).map((s) => ({ label: "the step", text: s.title })),
    ...(f.targets ?? []).flatMap((t) => (t.kind === "custom" ? [{ label: "the aim", text: t.text }] : [])),
  ];
  const feeding = texts.filter((x) => FEEDING.test(x.text) && !ASKING.test(x.text.trim()));
  if (feeding.length) {
    const a = aboutTexts(feeding, "changes", "change");
    out.push({
      kind: "feeding",
      text: `${a.what} ${a.verb} how ${v.name} is fed: save ${a.it} only if their pediatrician or lactation consultant agreed; otherwise phrase ${feeding.length > 1 ? "each" : "it"} as "Ask the pediatrician (or lactation consultant) about …".`,
    });
  }
  // Held sleep while an adult stays awake, and the transfer from a bed or a chair: fine as planned, with the words to say with them.
  const ex = texts.filter((x) => x.label !== "why it matters").map((x) => ({ ...x, e: sleepExemptions(x.text, { v, adults: o.adults }) }));
  const held = ex.filter((x) => x.e.held);
  if (held.length) {
    const a = aboutTexts(held, "has", "have");
    out.push({ kind: "awake", text: `${a.what} ${a.verb} ${v.name} asleep on an adult only while they stay awake: say Maple's line with ${a.it}: "${sleepyLine(v).split(/(?<=\.)\s+/)[0]}"` });
  }
  const words = feedingSleepyWords(v);
  const bed = ex.filter((x) => x.e.transfer.includes("bed"));
  if (bed.length) {
    const a = aboutTexts(bed, "has", "have");
    out.push({ kind: "transfer", text: `${a.what} ${a.verb} ${v.name} in an adult bed before the bassinet: say this with ${a.it}: "${words.bed}"` });
  }
  const chair = ex.filter((x) => x.e.transfer.includes("couch"));
  if (chair.length) {
    const a = aboutTexts(chair, "has", "have");
    out.push({ kind: "transfer", text: `${a.what} ${a.verb} ${v.name} on a couch or chair before the bassinet: say this with ${a.it}: "${words.mindful} ${words.someone}"` });
  }
  return out;
}

/** What a goal write sets once checked: only the fields it gave. */
export type GoalFields = {
  title?: string;
  why?: string | null;
  target_date?: string | null;
  targets?: GoalTarget[];
  steps?: GoalStep[];
  roster?: RosterWindow[];
  status?: GoalStatus;
  template?: GoalTemplate | null;
};

export type GoalRules = {
  /** The goal being changed, or null for a new one. */
  current: Pick<SleepGoal, "targets" | "steps" | "roster" | "target_date" | "template"> | null;
  /** The adults who check in (owners and members), by member id. */
  adults: ReadonlySet<string>;
  /** Their names, for the error words. */
  name: (id: string) => string;
  /** Today in the family's calendar. */
  today: string;
  /** The goal's id counter so far (0 for a new goal); new items take the next ones. */
  seq: number;
  /** The family's words for the baby, for the refusals (without, they say "the baby"). */
  v?: Voice;
  /** The baby's age in days today (null before she's born), for goalCautions; left out where it isn't known. */
  ageDays?: number | null;
};

/** The adults' names, as the refusals read them ("on Theo's chest"). */
const adultNames = (rules: Pick<GoalRules, "adults" | "name">) => [...rules.adults].map((id) => rules.name(id));

function adult(raw: unknown, rules: GoalRules, label: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SleepInputError(`${label} needs the adult it's for.`);
  if (!rules.adults.has(raw)) throw new SleepInputError(`${label}: ${rules.name(raw)} isn't an owner or member of this family, so they can't check in. Windows and protected-window targets are for the adults who log.`);
  return raw;
}

/**
 * A goal write's input checked and filled in: titles trimmed, people named
 * by member id, ids kept for items that name one (a step keeps whether it's
 * done) and new ones for the rest, a protected window 30 minutes to 12
 * hours on the clock with no overlap for the same adult on the same night.
 * Throws SleepInputError in words a person can act on.
 */
export function cleanGoalInput(raw: GoalInput, rules: GoalRules, mode: "create" | "update"): { fields: GoalFields; seq: number } {
  if (!raw || typeof raw !== "object") throw new SleepInputError("The goal is missing.");
  const out: GoalFields = {};
  let seq = rules.seq;
  const next = (prefix: string) => `${prefix}${++seq}`;
  const safe = { v: rules.v, adults: adultNames(rules) };
  if (mode === "create" || raw.title !== undefined) {
    out.title = text(raw.title, "The goal's title", GOAL_TITLE_MAX, true)!;
    refuseUnsafe(out.title, "The goal's title", safe);
  }
  if (raw.why !== undefined) {
    out.why = text(raw.why, "Why it matters", GOAL_WHY_MAX, false);
    refuseUnsafe(out.why, "Why it matters", { ...safe, describing: true });
  }
  if (raw.target_date !== undefined) {
    const d = raw.target_date;
    if (d == null || d === "") out.target_date = null;
    else {
      if (!isRealDay(d)) throw new SleepInputError("The target date must be a date like 2026-11-30.");
      // A date it already has stays, even once it's passed; a new one is from today on.
      if (d !== rules.current?.target_date) {
        if (d < rules.today) throw new SleepInputError("The target date has already passed. Pick today or a later day.");
        if (daysBetween(rules.today, d) > GOAL_AHEAD_DAYS) throw new SleepInputError("The target date can be up to a year away.");
      }
      out.target_date = d;
    }
  }

  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) throw new SleepInputError("Targets must be a list.");
    if (raw.targets.length > GOAL_TARGETS_MAX) throw new SleepInputError(`A goal has ${GOAL_TARGETS_MAX} targets at most.`);
    const have = new Map((rules.current?.targets ?? []).map((t) => [t.id, t]));
    const seen = new Set<string>();
    out.targets = raw.targets.map((t, i) => {
      const label = `Target ${i + 1}`;
      if (!t || typeof t !== "object" || !(TARGET_KINDS as readonly unknown[]).includes(t.kind)) throw new SleepInputError(`${label} needs a kind: ${TARGET_KINDS.join(", ")}.`);
      const id = keepId(t.id, have, seen, "target", label) ?? next("a");
      switch (t.kind) {
        case "bassinet_nights":
          return { id, kind: t.kind, per_week: whole(t.per_week, `${label}: nights a week`, 1, 7), min_minutes: t.min_minutes == null ? 60 : whole(t.min_minutes, `${label}: minutes asleep`, 15, 720) } satisfies BassinetNightsTarget;
        case "bassinet_stretch":
          return { id, kind: t.kind, minutes: whole(t.minutes, `${label}: the stretch's minutes`, 15, 720) } satisfies BassinetStretchTarget;
        case "protected_window":
          return { id, kind: t.kind, member: adult(t.member, rules, label), per_week: whole(t.per_week, `${label}: nights a week`, 1, 7) } satisfies ProtectedWindowTarget;
        case "custom": {
          const words = text(t.text, `${label}'s words`, GOAL_CUSTOM_MAX, true)!;
          refuseUnsafe(words, label, safe);
          return { id, kind: t.kind, text: words } satisfies CustomTarget;
        }
      }
    });
  }

  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) throw new SleepInputError("Steps must be a list.");
    if (raw.steps.length > GOAL_STEPS_MAX) throw new SleepInputError(`A goal has ${GOAL_STEPS_MAX} steps at most.`);
    const have = new Map((rules.current?.steps ?? []).map((s) => [s.id, s]));
    const seen = new Set<string>();
    out.steps = raw.steps.map((s, i) => {
      const label = `Step ${i + 1}`;
      if (!s || typeof s !== "object") throw new SleepInputError(`${label} is missing.`);
      const kept = keepId(s.id, have, seen, "step", label);
      const title = text(s.title, `${label}'s words`, GOAL_STEP_TITLE_MAX, true)!;
      refuseUnsafe(title, label, safe);
      const week = s.week_of == null || s.week_of === "" ? null : s.week_of;
      if (week !== null && !isRealDay(week)) throw new SleepInputError(`${label}: the week must be a date like 2026-11-09.`);
      const was = kept ? have.get(kept)! : null;
      return { id: kept ?? next("s"), title, week_of: week, done_at: was?.done_at ?? null, done_by: was?.done_by ?? null };
    });
  }

  if (raw.roster !== undefined) {
    if (!Array.isArray(raw.roster)) throw new SleepInputError("The roster must be a list.");
    if (raw.roster.length > ROSTER_MAX) throw new SleepInputError(`The roster has ${ROSTER_MAX} windows at most.`);
    const have = new Map((rules.current?.roster ?? []).map((w) => [w.id, w]));
    const seen = new Set<string>();
    const windows = raw.roster.map((w, i) => {
      const label = `Window ${i + 1}`;
      if (!w || typeof w !== "object") throw new SleepInputError(`${label} is missing.`);
      const id = keepId(w.id, have, seen, "window", label) ?? next("w");
      const member = adult(w.member, rules, label);
      if (!isClock(w.from) || !isClock(w.to)) throw new SleepInputError(`${label}: from and to are local times like 22:00 and 02:00.`);
      const len = windowMinutes(w.from, w.to);
      if (len < WINDOW_MIN_MINUTES || len > WINDOW_MAX_MINUTES) throw new SleepInputError(`${label}: a protected window is ${WINDOW_MIN_MINUTES} minutes to ${WINDOW_MAX_MINUTES / 60} hours long.`);
      if (!Array.isArray(w.nights) || !w.nights.length || !w.nights.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
        throw new SleepInputError(`${label}: nights are the evenings it begins on, 0 (Sunday) to 6 (Saturday).`);
      }
      const covers = w.covers == null ? null : w.covers;
      if (covers !== null && !(WINDOW_COVERS as readonly unknown[]).includes(covers)) throw new SleepInputError(`${label}: how its feeds are covered must be one of ${WINDOW_COVERS.join(", ")}.`);
      // Only a window that says how its feeds are covered carries it, so a window as before stays as it was.
      return { id, member, from: w.from, to: w.to, nights: [...new Set(w.nights)].sort((a, b) => a - b), ...(covers ? { covers } : {}) } satisfies RosterWindow;
    });
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i];
        const b = windows[j];
        if (a.member !== b.member || !a.nights.some((n) => b.nights.includes(n))) continue;
        const [as, ae] = inNight(a);
        const [bs, be] = inNight(b);
        if (as < be && bs < ae) throw new SleepInputError(`Windows ${i + 1} and ${j + 1} overlap for ${rules.name(a.member)} on the same night. Make them one window, or move one.`);
      }
    }
    out.roster = windows;
  }

  if (raw.template !== undefined) out.template = cleanTemplate(raw.template, rules);

  if (raw.status !== undefined) {
    if (mode === "create") throw new SleepInputError("A new goal starts active.");
    if (raw.status !== "active" && raw.status !== "paused") throw new SleepInputError("A goal's status changes to active or paused here; closing it as met or dropped is its own step.");
    out.status = raw.status;
  }
  return { fields: out, seq };
}

/** A goal's template context (GoalTemplate): the adult going back to work, the day, and who nurses (null: bottles only). */
function cleanTemplate(raw: unknown, rules: GoalRules): GoalTemplate | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new SleepInputError("The goal's template must be an object.");
  const t = raw as Record<string, unknown>;
  if (!(GOAL_TEMPLATES as readonly unknown[]).includes(t.kind)) throw new SleepInputError(`The goal's template must be one of ${GOAL_TEMPLATES.join(", ")}.`);
  const member = adult(t.member, rules, "Who goes back to work");
  if (!isRealDay(t.date)) throw new SleepInputError("The day back at work must be a date like 2026-11-30.");
  // A day it already has stays, even once it's passed; a new one is from today on.
  if (t.date !== rules.current?.template?.date) {
    if (t.date < rules.today) throw new SleepInputError("The day back at work has already passed. This plans ahead of it; for the nights now, set a goal by hand or with Maple.");
    if (daysBetween(rules.today, t.date) > GOAL_AHEAD_DAYS) throw new SleepInputError("The day back at work can be up to a year away.");
  }
  const nursing = t.nursing == null || t.nursing === "" ? null : adult(t.nursing, rules, "Who nurses");
  return { kind: "back_to_work", member, date: t.date, nursing };
}

function keepId<T>(raw: unknown, have: Map<string, T>, seen: Set<string>, what: string, label: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string" || !have.has(raw)) throw new SleepInputError(`${label}: this goal has no ${what} ${String(raw)}. Leave the id out for a new one.`);
  if (seen.has(raw)) throw new SleepInputError(`${label}: ${what} ${raw} is in the list twice.`);
  seen.add(raw);
  return raw;
}

/** The next step to do: the first undone one by its week (steps without a week last), then the order they're in. */
export function nextStep(steps: readonly GoalStep[]): GoalStep | null {
  const open = steps.map((s, i) => ({ s, i })).filter((x) => !x.s.done_at);
  open.sort((a, b) => (a.s.week_of ?? "9999-12-31").localeCompare(b.s.week_of ?? "9999-12-31") || a.i - b.i);
  return open[0]?.s ?? null;
}

// ── the "Back to work" template: five questions, one goal ────────────────
//
// Postpartum Support International's plan asks who's home and who goes back
// to work when, how the baby is fed, where she sleeps, who takes which half
// of the night and where the adult who's off sleeps, and the target date.
// From those answers comes one goal to read back and save on a yes, with no
// logs needed first: a protected window for each adult (the returning
// adult's on work nights), each window's feeds covered by how she's fed, and
// three steps timed from the day back: bottles as a question for their
// pediatrician or lactation consultant, not before about 4 weeks old (OWH,
// Texas HHS), the work-week roster rehearsed on 2 or 3 nights two weeks
// before (Cedars-Sinai, MSU Extension), and a short first week back (AAFP);
// with a note to expect more night nursing when the nursing parent is the
// one going back (OWH). Feeding stays the family's and their clinicians':
// the template never changes how she's fed.

export const QUICK_FEEDING = ["nursing", "bottles", "both"] as const;
export type QuickFeeding = (typeof QUICK_FEEDING)[number];
export const QUICK_SLEEPS = ["bassinet", "crib", "arms", "bed", "mixed"] as const;
export type QuickSleeps = (typeof QUICK_SLEEPS)[number];
export const QUICK_OFF_DUTY = ["other_room", "same_room"] as const;
export type QuickOffDuty = (typeof QUICK_OFF_DUTY)[number];

/** The five questions, in order (the app's quick setup and the chat ask them one at a time). */
export const backToWorkQuestions = (v: Pick<Voice, "name">): string[] => [
  "Who goes back to work, and on what day?",
  `How is ${v.name} fed: nursing, bottles or both? And who nurses?`,
  `Where does ${v.name} sleep now?`,
  "Who's on duty for each half of the night, and where does the adult who's off sleep?",
  "What's your target date? Two weeks after the day back, unless you'd like another.",
];

/** The quick setup's answers, people as member ids. */
export type BackToWorkAnswers = {
  /** Who goes back to work, and the day they go back (YYYY-MM-DD). */
  returning: string;
  return_date: string;
  feeding: QuickFeeding;
  /** Who nurses, for nursing or both. */
  nursing?: string | null;
  /** Where the baby sleeps now. */
  sleeps: QuickSleeps;
  /** Who's on duty for each half of the night: the other one sleeps then. */
  first_half: string;
  second_half: string;
  off_duty: QuickOffDuty;
  /** The night and where it splits (QUICK_NIGHT by default), local "HH:MM". */
  night_from?: string | null;
  split?: string | null;
  night_to?: string | null;
  /** The evenings before work days (WORK_NIGHTS, Sun–Thu, by default). */
  work_nights?: number[] | null;
  /** By default two weeks after the day back. */
  target_date?: string | null;
};

/** The default night and its halves: 10 PM to 6 AM, split at 2 AM. */
export const QUICK_NIGHT = { from: "22:00", split: "02:00", to: "06:00" } as const;
/** Work nights: the evenings before a Monday-to-Friday week. */
export const WORK_NIGHTS: readonly number[] = [0, 1, 2, 3, 4];
/** The target date by default: the day back and the 13 nights after it, its first two weeks. */
export const BACK_TO_WORK_AFTER_DAYS = 13;

/**
 * The quick setup's goal (BackToWorkAnswers): a title and why, the target
 * date, a protected-window target and window for each half's adult (the
 * returning adult's on work nights), each window's feeds covered by how the
 * baby is fed, and three steps timed back from the day back (none earlier
 * than this week), with the read-back's notes. Checked by cleanGoalInput
 * when it's saved, like any goal; throws SleepInputError for an answer it
 * can't use.
 */
export function backToWorkGoal(a: BackToWorkAnswers, o: { v: Voice; name: (id: string) => string; today: string; adults: ReadonlySet<string> }): { goal: GoalInput; notes: string[] } {
  const v = o.v;
  const one = <T extends string>(x: unknown, list: readonly T[], what: string): T => {
    if (!(list as readonly unknown[]).includes(x)) throw new SleepInputError(`${what} must be one of ${list.join(", ")}.`);
    return x as T;
  };
  const person = (id: unknown, what: string): string => {
    if (typeof id !== "string" || !id.trim()) throw new SleepInputError(`${what} needs one of the family's adults.`);
    if (!o.adults.has(id)) throw new SleepInputError(`${what}: ${o.name(id)} isn't an owner or member of this family.`);
    return id;
  };
  const feeding = one(a.feeding, QUICK_FEEDING, "How the baby is fed");
  const sleeps = one(a.sleeps, QUICK_SLEEPS, "Where the baby sleeps");
  const offDuty = one(a.off_duty, QUICK_OFF_DUTY, "Where the adult who's off sleeps");
  const returning = person(a.returning, "Who goes back to work");
  const first = person(a.first_half, "Who's on duty for the first half of the night");
  const second = person(a.second_half, "Who's on duty for the second half of the night");
  if (first === second) throw new SleepInputError("The two halves of the night need two different adults, so each can sleep while the other is on.");
  if (returning !== first && returning !== second) throw new SleepInputError(`${o.name(returning)} goes back to work, so ${o.name(returning)} takes one half of the night here.`);
  const nursing = feeding === "bottles" ? null : person(a.nursing, "Who nurses");
  if (!isRealDay(a.return_date)) throw new SleepInputError("The day back at work must be a date like 2026-11-30.");
  if (a.return_date < o.today) throw new SleepInputError("The day back at work has already passed. This plans ahead of it; for the nights now, set a goal by hand or with Maple.");
  if (daysBetween(o.today, a.return_date) > GOAL_AHEAD_DAYS) throw new SleepInputError("The day back at work can be up to a year away.");
  const from = a.night_from ?? QUICK_NIGHT.from;
  const split = a.split ?? QUICK_NIGHT.split;
  const to = a.night_to ?? QUICK_NIGHT.to;
  if (![from, split, to].every(isClock)) throw new SleepInputError('The night\'s times are local times like "22:00", "02:00" and "06:00".');
  const work = a.work_nights?.length ? [...new Set(a.work_nights)].sort((x, y) => x - y) : [...WORK_NIGHTS];
  const R = o.name(returning);
  const other = returning === first ? second : first;
  // The adult on duty for the first half sleeps the second, and the other way round.
  const nightsFor = (m: string) => (m === returning ? work : [0, 1, 2, 3, 4, 5, 6]);
  const coversFor = (m: string): WindowCovers => (feeding === "bottles" ? "bottle" : feeding === "both" && m === nursing ? "bottle" : "nurse");
  const roster = [
    { member: second, from, to: split, nights: nightsFor(second), covers: coversFor(second) },
    { member: first, from: split, to, nights: nightsFor(first), covers: coversFor(first) },
  ];
  // Each step's week: so many days before the day back, never before this week.
  const weekBefore = (days: number) => maxKey(o.today, addDays(a.return_date, -days));
  const steps =
    feeding === "bottles"
      ? [{ title: `Set out what the night feeds need, so whoever's on duty can feed ${v.them} alone`, week_of: weekBefore(21) }]
      : feeding === "both"
        ? [{ title: `Ask the lactation consultant when ${o.name(nursing!)} should pump around the night bottle`, week_of: weekBefore(28) }]
        : [{ title: "Ask the pediatrician or lactation consultant when to start a bottle of expressed milk (not before about 4 weeks)", week_of: weekBefore(28) }];
  steps.push({ title: "Rehearse the work-week roster on 2 or 3 nights", week_of: weekBefore(14) }, { title: "Plan a short first week back (a Wednesday or Thursday start, if work allows)", week_of: weekBefore(7) });
  const goal: GoalInput = {
    title: `Back to work: protected sleep for ${R} and ${o.name(other)}`,
    why: `${R} goes back to work on ${dateWords(a.return_date, o.today)}.`,
    target_date: a.target_date ?? addDays(a.return_date, BACK_TO_WORK_AFTER_DAYS),
    targets: [
      { kind: "protected_window", member: returning, per_week: Math.min(5, nightsFor(returning).length) },
      { kind: "protected_window", member: other, per_week: 4 },
    ],
    steps,
    roster,
    template: { kind: "back_to_work", member: returning, date: a.return_date, nursing },
  };
  const notes: string[] = [];
  const days = daysBetween(o.today, a.return_date);
  const now = steps.filter((x) => x.week_of === o.today).length;
  if (now) notes.push(`${R} is back ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}, so ${now === steps.length ? "every step starts" : now === 1 ? "the first step starts" : `the first ${now} steps start`} this week.`);
  if (sleeps === "bed") notes.push(`${v.Name} sleeps in your bed now: Maple's plans keep ${v.them} in ${v.their} own sleep space, the bassinet in your room, close to your bed but not in it. The Plan tab's first stage is one bassinet try a day.`);
  else if (sleeps === "arms" || sleeps === "mixed") notes.push(`${v.Name} sleeps ${sleeps === "arms" ? "in arms" : "in a mix of places"} now: holding ${v.them} is fine while you're awake, and the Plan tab's first stage is one bassinet try a day.`);
  notes.push(
    offDuty === "same_room"
      ? "The adult who's off sleeps in the same room: one clinician's approach is two sleep spaces, so whoever's off isn't woken by every sound. That's your call."
      : `The adult who's off sleeps in another room: whoever's on duty ${feeding === "bottles" ? "does the feeds" : `brings ${v.them} to nurse`} in the other's window.`
  );
  if (nursing === returning) notes.push(`Once ${R} is back at work, some babies nurse more often at night (sometimes called reverse cycling): the morning check-ins will show how the nights go, and the roster can change.`);
  return { goal, notes };
}

// ── a goal's weeks ───────────────────────────────────────────────────────

/** Weeks shown without a target date, and at most with one. */
export const GOAL_WEEKS_NO_DATE = 4;
export const GOAL_WEEKS_SHOWN = 12;

export type GoalWeek = {
  /** 1-based, counted from the goal's start. */
  n: number;
  /** Its first and last nights (YYYY-MM-DD, the evenings), cut at the target date. */
  from: string;
  to: string;
  /** Its nights that have begun so far (try days under way or done). */
  nights: number;
  current: boolean;
};

export type GoalSpan = {
  startsOn: string;
  /** The target date, or null. */
  endsOn: string | null;
  today: string;
  /** Days from today to the target date: 0 on the day, negative once it's passed; null without one. */
  daysLeft: number | null;
  /** The week tonight is in (1-based); null once the target date has passed or the goal is closed. */
  weekNow: number | null;
  /** Weeks from the start through the target date; null without one. */
  weeksTotal: number | null;
  /** The weeks shown, oldest first: up to the last 4 without a target date, up to the last 12 with one. */
  weeks: GoalWeek[];
  /** Earlier weeks left out. */
  weeksHidden: number;
  /** The last night counted: tonight's, or the target date or the night it closed when earlier. */
  lastNight: string;
};

const isOpen = (s: GoalStatus) => s === "active" || s === "paused";

/**
 * Weeks from a goal's first night through its target date's: a target date
 * one night past whole weeks (a goal set "in 4 weeks" has 29 nights) ends
 * the last whole week instead of starting a week of one night, so it reads
 * "week 1 of 4", not "of 5".
 */
function weeksThrough(startsOn: string, endsOn: string): { total: number; folded: boolean } {
  const nights = daysBetween(startsOn, endsOn) + 1;
  const folded = nights > 1 && nights % 7 === 1;
  return { total: folded ? (nights - 1) / 7 : Math.ceil(nights / 7), folded };
}

/** The (1-based) week a night is in, from the goal's first night, no later than its last week. */
const weekNumber = (startsOn: string, night: string, weeksTotal: number | null) => {
  const n = Math.floor(daysBetween(startsOn, night) / 7) + 1;
  return weeksTotal ? Math.min(n, weeksTotal) : n;
};

export function goalSpan(goal: Pick<SleepGoal, "created_at" | "target_date" | "closed_at" | "status">, now: Date, tz: string): GoalSpan {
  const startsOn = goalStartKey(goal, tz);
  const today = dayKey(now, tz);
  const cur = tryDayKey(now, tz);
  const endsOn = goal.target_date ? maxKey(goal.target_date, startsOn) : null;
  const weeksTotal = endsOn ? weeksThrough(startsOn, endsOn).total : null;
  let last = cur;
  if (endsOn) last = minKey(last, endsOn);
  if (goal.closed_at) last = minKey(last, tryDayKey(ms(goal.closed_at), tz));
  // The week a night is in; the current week shows from the moment the goal is set, before its first night begins.
  const shownTo = maxKey(last, startsOn);
  const begun = weekNumber(startsOn, shownTo, weeksTotal);
  const max = endsOn ? GOAL_WEEKS_SHOWN : GOAL_WEEKS_NO_DATE;
  const first = Math.max(0, begun - max);
  const inSpan = !endsOn || cur <= endsOn;
  const weekNow = isOpen(goal.status) && !goal.closed_at && inSpan ? weekNumber(startsOn, maxKey(cur, startsOn), weeksTotal) : null;
  const weeks: GoalWeek[] = [];
  for (let i = first; i < begun; i++) {
    const from = addDays(startsOn, 7 * i);
    const to = endsOn ? (i + 1 === weeksTotal ? endsOn : minKey(addDays(from, 6), endsOn)) : addDays(from, 6);
    const through = minKey(to, last);
    weeks.push({ n: i + 1, from, to, nights: through >= from ? daysBetween(from, through) + 1 : 0, current: i + 1 === weekNow });
  }
  return {
    startsOn,
    endsOn,
    today,
    daysLeft: endsOn ? daysBetween(today, endsOn) : null,
    weekNow,
    weeksTotal,
    weeks,
    weeksHidden: first,
    lastNight: last,
  };
}

/** The shown week a night falls in, or null. */
function weekOf(span: GoalSpan, night: string): GoalWeek | null {
  if (night < span.startsOn || night > span.lastNight) return null;
  const n = weekNumber(span.startsOn, night, span.weeksTotal);
  return span.weeks.find((w) => w.n === n && night <= w.to) ?? null;
}

const nightsIn = (w: GoalWeek, through: string): string[] => {
  const end = minKey(w.to, through);
  return end < w.from ? [] : Array.from({ length: daysBetween(w.from, end) + 1 }, (_, i) => addDays(w.from, i));
};

// ── what was logged, night by night ──────────────────────────────────────

/** A night's core, for what was logged: 10 PM to 6 AM by the clock, on the night that begins that evening (as a try day). */
export const NIGHT_CORE = { from: "22:00", to: "06:00" } as const;
/** In a night's core, a stretch this long with nothing logged makes the night only partly logged. */
export const UNLOGGED_GAP_MIN = 240;
/** A holding turn with no planned handoff, longer than this, was likely left open: it's flagged, and left out of the roster's hints. */
export const LONG_TURN_MIN = 240;
/** A turn with a planned handoff, still going this long past it, was likely left open. */
export const LATE_TURN_MIN = 60;

/**
 * Whether a holding turn was likely left open (flagged, and left out of the
 * roster's hints): never one that ended in a handoff (handed over or taken
 * over, as planned); one with a planned handoff that ran LATE_TURN_MIN or
 * more past it; one with none that ran over LONG_TURN_MIN.
 */
export function turnLeftOpen(s: Pick<HoldingShift, "started_at" | "ended_at" | "ended_how" | "handoff_at">, now: number): boolean {
  if (s.ended_how === "handoff") return false;
  const end = s.ended_at ? ms(s.ended_at) : now;
  if (s.handoff_at) return end - ms(s.handoff_at) >= LATE_TURN_MIN * MIN;
  return end - ms(s.started_at) > LONG_TURN_MIN * MIN;
}

/** A night's core as logged: something all through it, something but a long stretch of nothing, or nothing at all. */
export type NightLog = "logged" | "partly" | "none";

type Span = [number, number];

/** Everything logged, as spans of time (a diaper is a moment): entries of any kind, bassinet tries and holding turns. */
export function loggedSpans(data: Pick<GoalData, "entries" | "tries" | "shifts">, now: number): Span[] {
  const out: Span[] = [];
  for (const e of live(data.entries)) {
    const s = ms(e.started_at);
    const end = e.ended_at ? ms(e.ended_at) : e.active ? now : s;
    out.push([s, Math.max(s, end)]);
  }
  for (const t of live(data.tries)) out.push([ms(t.started_at), t.ended_at ? ms(t.ended_at) : now]);
  for (const s of live(data.shifts)) out.push([ms(s.started_at), s.ended_at ? ms(s.ended_at) : now]);
  return out;
}

/**
 * A night as logged, with its core's (NIGHT_CORE) stretches of nothing:
 * null while the core is still going; "none" with nothing logged from 8 PM
 * to 8 AM; "partly" with a stretch of UNLOGGED_GAP_MIN or more with nothing
 * in the core; "logged" otherwise. A night with nothing logged is unknown,
 * never a night that went well or badly, and a gap is only a gap in the log.
 */
export function nightLog(night: string, spans: readonly Span[], tz: string, now: number): { log: NightLog; gaps: Span[] } | null {
  const [a, b] = windowOn(NIGHT_CORE, night, tz).map((d) => d.getTime());
  if (b > now) return null;
  // Nothing at all from 8 PM to 8 AM is a night not logged; something then but a long stretch of nothing in the core is partly.
  const [wa, wb] = windowOn(NIGHT_STRIP, night, tz).map((d) => d.getTime());
  if (!spans.some(([s, e]) => e >= wa && s <= wb)) return { log: "none", gaps: [[a, b]] };
  const inside = spans
    .filter(([s, e]) => e >= a && s <= b)
    .map(([s, e]): Span => [Math.max(s, a), Math.min(e, b)])
    .sort((x, y) => x[0] - y[0]);
  if (!inside.length) return { log: "partly", gaps: [[a, b]] };
  const gaps: Span[] = [];
  let at = a;
  for (const [s, e] of inside) {
    if (s > at) gaps.push([at, s]);
    at = Math.max(at, e);
  }
  if (b > at) gaps.push([at, b]);
  return { log: gaps.some(([s, e]) => e - s >= UNLOGGED_GAP_MIN * MIN) ? "partly" : "logged", gaps };
}

/** "long" without its minutes (an older row) means an hour or more, the bassinet-nights default. */
const UNTIMED_DEFAULT_MIN = 60;

/** A night's answers from the adults' check-ins: the first one given for each question (once a night, whoever answers first). */
export function nightAnswers(checkins: readonly SleepCheckin[], night: string): { checkedIn: boolean; place: CheckinPlace | null; untimed: { answer: UntimedTry; minutes: number } | null; handoff: HandoffAnswer | null } {
  const those = live(checkins)
    .filter((c) => c.night === night)
    .sort((x, y) => x.id - y.id);
  const u = those.find((c) => c.untimed_try != null);
  return {
    checkedIn: those.length > 0,
    place: those.find((c) => c.place != null)?.place ?? null,
    untimed: u ? { answer: u.untimed_try!, minutes: u.untimed_min ?? UNTIMED_DEFAULT_MIN } : null,
    handoff: those.find((c) => c.handoff != null)?.handoff ?? null,
  };
}

/**
 * The night's planned handoff, if there was one: on the roster, one adult's
 * window ending within 30 minutes of another adult's starting, or a holding
 * turn begun that night with a planned handoff. For the morning's "Did the
 * handoff happen as planned?".
 */
export function plannedHandoff(goals: readonly Pick<SleepGoal, "status" | "roster">[], shifts: readonly HoldingShift[], night: string, tz: string): { at: string; from: string | null; to: string | null } | null {
  const windows = goals.filter((g) => g.status === "active").flatMap((g) => g.roster.filter((w) => windowOnNight(w, night)));
  for (const a of windows) {
    const end = windowOn(a, night, tz)[1].getTime();
    const b = windows.find((x) => x.member !== a.member && Math.abs(windowOn(x, night, tz)[0].getTime() - end) <= 30 * MIN);
    if (b) return { at: new Date(end).toISOString(), from: a.member, to: b.member };
  }
  const [lo, hi] = tryDayBounds(night, tz).map((d) => d.getTime());
  const s = live(shifts).find((x) => x.handoff_at && ms(x.started_at) >= lo && ms(x.started_at) < hi);
  return s ? { at: s.handoff_at!, from: s.holder, to: s.next_holder } : null;
}

// ── the morning's Last night card (pure, for the card and its checks) ────

/** The Last night strip runs from 8 PM to 8 AM (or now), on the night that began that evening. */
export const NIGHT_STRIP = { from: "20:00", to: "08:00" } as const;
/** A stretch with nothing logged this long, between two things that were, gets its question. */
export const NIGHT_GAP_MIN = 90;

export type NightGap = { start: number; end: number };
export type NightBar = { kind: Entry["kind"] | "try" | "hold"; start: number; end: number };

export type NightPicture = {
  night: string;
  from: number;
  to: number;
  bars: NightBar[];
  /** Stretches of NIGHT_GAP_MIN or more with nothing logged, between two things that were, touching the night's core. */
  gaps: NightGap[];
  /** A sleep timer still running with something logged after it began: when that was, and what. */
  leftRunning: { sleep: Entry; next: Entry } | null;
  /** The strip ends now (before 8 AM), not at its 8 AM end. */
  toNow: boolean;
  counts: { sleeps: number; feeds: number; diapers: number; other: number };
};

/**
 * Last night from the log: what's on the strip (sleeps, feeds and other
 * entries, tries, holding turns), the stretches with nothing logged to ask
 * about (only between two logged things, since an edge of the strip is no
 * moment anyone saw), and a sleep timer still running past something logged
 * after it began (likely left on).
 */
export function nightPicture(o: { night: string; entries: readonly Entry[]; tries: readonly BassinetTry[]; shifts: readonly HoldingShift[]; tz: string; now: number }): NightPicture {
  const [a, end] = windowOn(NIGHT_STRIP, o.night, o.tz).map((d) => d.getTime());
  const b = Math.min(end, o.now);
  const [ca, cb] = windowOn(NIGHT_CORE, o.night, o.tz).map((d) => d.getTime());
  const entries = live(o.entries);
  const tries = live(o.tries);
  const shifts = live(o.shifts);
  const endOf = (e: Entry) => (e.ended_at ? ms(e.ended_at) : e.active ? o.now : ms(e.started_at));
  const inside = entries.filter((e) => endOf(e) >= a && ms(e.started_at) <= b);
  const clipped = (kind: NightBar["kind"], s: number, e: number): NightBar => ({ kind, start: Math.max(a, s), end: Math.min(b, e) });
  const bars: NightBar[] = [
    ...inside.map((e) => clipped(e.kind, ms(e.started_at), endOf(e))),
    ...tries.filter((t) => ms(t.started_at) <= b && (t.ended_at ? ms(t.ended_at) : o.now) >= a).map((t) => clipped("try", ms(t.started_at), t.ended_at ? ms(t.ended_at) : o.now)),
    ...shifts.filter((s) => ms(s.started_at) <= b && (s.ended_at ? ms(s.ended_at) : o.now) >= a).map((s) => clipped("hold", ms(s.started_at), s.ended_at ? ms(s.ended_at) : o.now)),
  ].sort((x, y) => x.start - y.start);
  const spans = loggedSpans({ entries, tries, shifts }, o.now)
    .filter(([s, e]) => e >= a && s <= b)
    .sort((x, y) => x[0] - y[0]);
  const gaps: NightGap[] = [];
  let at: number | null = null;
  for (const [s, e] of spans) {
    if (at != null && s - at >= NIGHT_GAP_MIN * MIN && s > ca && at < cb) gaps.push({ start: at, end: s });
    at = at == null ? e : Math.max(at, e);
  }
  const running = entries.find((e) => e.kind === "sleep" && e.active && ms(e.started_at) < b);
  const next = running
    ? (entries
        .filter((e) => e.id !== running.id && e.kind !== "sleep" && ms(e.started_at) > ms(running.started_at) + 5 * MIN && ms(e.started_at) <= o.now)
        .sort((x, y) => ms(x.started_at) - ms(y.started_at))[0] ?? null)
    : null;
  const count = (k: Entry["kind"]) => inside.filter((e) => e.kind === k).length;
  return {
    night: o.night,
    from: a,
    to: b,
    bars,
    gaps: running && next ? gaps.filter((g) => g.end <= ms(running.started_at)) : gaps,
    leftRunning: running && next ? { sleep: running, next } : null,
    toNow: o.now < end,
    counts: { sleeps: count("sleep"), feeds: count("feed"), diapers: count("diaper"), other: inside.filter((e) => !["sleep", "feed", "diaper"].includes(e.kind)).length },
  };
}

// ── progress ─────────────────────────────────────────────────────────────

export type NightsWeek = {
  week: number;
  /** Nights with a bassinet try that stayed asleep at least the target's minutes, timed in the log or from an adult's check-in. */
  counted: number;
  /** Nights with a finished try in the log: the sample "counted" is out of. */
  tried: number;
  /** Nights of the week begun so far. */
  nights: number;
  /** Of `counted`, nights counted from a check-in's untimed try (no try in the log that night): shown apart. */
  fromCheckins: number;
  /** Nights that say something about her sleep: a try, a sleep, an adult's check-in, or an untimed try answered. */
  known: number;
  /** Nights that are over with none of those: unknown, not counted either way. */
  unknown: number;
  /** Of `unknown`, nights with only feeds or other entries logged: whether she tried the bassinet isn't in the log. */
  feedsOnly: number;
};

export type StretchWeek = {
  week: number;
  /** Bassinet stretches that began that week. */
  stretches: number;
  longestSec: number | null;
  /** Of them, how many reached the target's minutes. */
  atLeast: number;
};

export type WindowWeek = {
  week: number;
  /** That adult's check-ins by answer, and how many nights they checked in. */
  yes: number;
  partly: number;
  no: number;
  checkedIn: number;
  /** Nights their window was on the roster that are over (so could be checked in). */
  planned: number;
};

export type TargetProgress =
  | { id: string; kind: "bassinet_nights"; target: BassinetNightsTarget; weeks: NightsWeek[] }
  | { id: string; kind: "bassinet_stretch"; target: BassinetStretchTarget; weeks: StretchWeek[]; longest: { sec: number; start: string; end: string } | null }
  /** `weeks` is null for a reader who can't see check-ins (a view-only guest). */
  | { id: string; kind: "protected_window"; target: ProtectedWindowTarget; weeks: WindowWeek[] | null }
  | { id: string; kind: "custom"; target: CustomTarget };

export type CheckinCounts = {
  member: string;
  /** Nights checked in over the shown weeks, by answer. */
  nights: number;
  yes: number;
  partly: number;
  no: number;
  /** Their answer for last night, or null before they've checked in. */
  lastNight: ProtectedAnswer | null;
};

export type RosterHint = {
  windowId: string;
  member: string;
  /** Nights of the last week (within the goal) the window was on and is over. */
  nights: number;
  /** Of them, nights with anything logged inside the window: the rest are unknown, never "no feeds". */
  loggedNights: number;
  /** Feeds that began inside it, and on how many of those nights. */
  feeds: number;
  feedNights: number;
  /** Of those feeds, how many this adult logged. */
  feedsLoggedBy: number;
  /** Those feeds by who logged them, bottles and nursing apart (logging a feed isn't giving it: a partner may log a nursing feed). */
  feedsBy: { member: string | null; bottles: number; nursing: number }[];
  /** Nights this adult logged a feed inside it themselves, and the earliest and latest of those feeds in the night. */
  ownFeedNights: number;
  ownFeedSpan: { first: string; last: string } | null;
  /** Nights this adult had a holding turn during their own window. */
  heldNights: number;
  /** Nights someone else held the baby during it, by who. */
  cover: { member: string; nights: number }[];
  /** Bassinet tries that began inside it. */
  tries: number;
  /** Holding turns touching it that were likely left open (turnLeftOpen), with their planned handoff: left out of heldNights and cover. */
  longTurns: { member: string; start: string; end: string | null; planned: string | null }[];
};

/** What was logged each week (over the nights whose core is over): the counts' own sample. */
export type WeekCoverage = {
  week: number;
  /** Nights whose core (10 PM to 6 AM) is over. */
  over: number;
  /** Of them: something all through the night, something but a stretch of 4 hours or more with nothing, nothing. */
  logged: number;
  partly: number;
  none: number;
  /** Nights with a feed begun from 8 PM to 8 AM, a finished try that try day, and (owners and members only) an adult's check-in. */
  feedNights: number;
  tryNights: number;
  checkinNights: number | null;
};

/** The adults' extra answers about the baby's nights, each week (owners and members only). */
export type WeekAnswers = {
  week: number;
  place: Partial<Record<CheckinPlace, number>>;
  placeNights: number;
  handoff: Partial<Record<HandoffAnswer, number>>;
  handoffNights: number;
};

/** One night of the last two shown weeks, as the coach and the goal card read it. */
export type NightInfo = {
  night: string;
  week: number;
  /** Its core as logged (nightLog), null while it's still going. */
  log: NightLog | null;
  feed: boolean;
  tried: boolean;
  /** A sleep entry in the night's 8 PM–8 AM. */
  slept: boolean;
  /** From the adults' check-ins; null for a reader who can't see them. */
  checkedIn: boolean | null;
  place: CheckinPlace | null;
  untimed: { answer: UntimedTry; minutes: number } | null;
  handoff: HandoffAnswer | null;
};

export type GoalProgress = GoalSpan & {
  goalId: number;
  targets: TargetProgress[];
  /** `next`: this week's step, else one still open from earlier, else one for any week, else the next planned (nextStepNow). */
  steps: { done: number; of: number; next: GoalStep | null; thisWeek: GoalStep[]; earlier: GoalStep[] };
  /** Per adult; null for a reader who can't see check-ins. */
  checkins: CheckinCounts[] | null;
  roster: RosterHint[];
  coverage: WeekCoverage[];
  /** Null for a reader who can't see check-ins. */
  answers: WeekAnswers[] | null;
  nights: NightInfo[];
  /** Her logged night feeds over the last week, start to start (the longest gap seen, and over how many nights with two or more); null with fewer than 2 such nights. */
  feedGap: { longestMin: number; nights: number } | null;
  /** Check-in patterns with enough nights on each side (CHECKIN_PATTERN_NIGHTS); null for a reader who can't see check-ins. */
  observations: CheckinObservation[] | null;
};

/** A check-in pattern shows only with this many nights on each side, and a difference this big between them (as the try patterns' 30 points). */
export const CHECKIN_PATTERN_NIGHTS = 5;
const CHECKIN_PATTERN_GAP = 0.3;

/**
 * An early observation from one adult's check-ins: the nights they got their
 * window's sleep, with and without something in the log ("fed_by_other":
 * someone else logged a feed inside their window that night; "try": a
 * bassinet try that night). Counts only, never a verdict.
 */
export type CheckinObservation = {
  member: string;
  factor: "fed_by_other" | "try";
  with: { yes: number; of: number };
  without: { yes: number; of: number };
};

/** "Early observation (10 check-ins): Noor got the window's sleep on 4 of 5 nights when someone else logged a feed inside it, and on 1 of 5 nights without." */
export function observationWords(o: CheckinObservation, name: (id: string) => string): string {
  const [yes, no] = o.factor === "fed_by_other" ? ["when someone else logged a feed inside it", "without"] : ["with a bassinet try", "without one"];
  return `Early observation (${o.with.of + o.without.of} check-ins): ${name(o.member)} got the window's sleep on ${o.with.yes} of ${plural(o.with.of, "night")} ${yes}, and on ${o.without.yes} of ${plural(o.without.of, "night")} ${no}.`;
}

/** What progress reads: the log over the goal's nights. */
export type GoalData = {
  tries: readonly BassinetTry[];
  /** Entries of every kind (coverage reads them all; the targets read sleeps and feeds). */
  entries: readonly Entry[];
  shifts: readonly HoldingShift[];
  /** Null when this reader can't see check-ins. */
  checkins: readonly SleepCheckin[] | null;
};

/** Hints look at the last week of nights. */
const HINT_NIGHTS = 7;

/**
 * A goal's undone steps by when they're planned, against the goal's week
 * that today (the family's calendar day) is in: so on the morning a week
 * begins, its step is this week's.
 */
export function stepsByWeek(steps: readonly GoalStep[], span: Pick<GoalSpan, "startsOn" | "weeksTotal" | "today">): { thisWeek: GoalStep[]; earlier: GoalStep[]; anyTime: GoalStep[]; later: GoalStep[] } {
  const now = weekNumber(span.startsOn, maxKey(span.today, span.startsOn), span.weeksTotal);
  const open = steps.filter((s) => !s.done_at);
  const weekOfStep = (s: GoalStep) => (s.week_of! < span.startsOn ? 0 : weekNumber(span.startsOn, s.week_of!, span.weeksTotal));
  const byWeek = (xs: GoalStep[]) => xs.slice().sort((a, b) => a.week_of!.localeCompare(b.week_of!));
  return {
    thisWeek: open.filter((s) => s.week_of && weekOfStep(s) === now),
    earlier: byWeek(open.filter((s) => s.week_of && weekOfStep(s) < now)),
    anyTime: open.filter((s) => !s.week_of),
    later: byWeek(open.filter((s) => s.week_of && weekOfStep(s) > now)),
  };
}

/** The step to do next: this week's, else the latest still open from earlier, else one for any week, else the next planned. */
export function nextStepNow(steps: readonly GoalStep[], span: Pick<GoalSpan, "startsOn" | "weeksTotal" | "today">): GoalStep | null {
  const s = stepsByWeek(steps, span);
  return s.thisWeek[0] ?? s.earlier[s.earlier.length - 1] ?? s.anyTime[0] ?? s.later[0] ?? null;
}

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K) => {
  m[k] = (m[k] ?? 0) + 1;
};

export function goalProgress(goal: SleepGoal, data: GoalData, now: Date, tz: string): GoalProgress {
  const span = goalSpan(goal, now, tz);
  const t = now.getTime();
  const tries = live(data.tries).filter((x) => ms(x.started_at) <= t);
  const finished = tries.filter((x) => x.ended_at && x.outcome);
  const byNight = new Map<string, BassinetTry[]>();
  for (const x of finished) {
    const k = tryDayKey(ms(x.started_at), tz);
    byNight.set(k, [...(byNight.get(k) ?? []), x]);
  }
  // Any try that began that night, a running one too: something about her sleep is in the log.
  const tryNights = new Set(tries.map((x) => tryDayKey(ms(x.started_at), tz)));
  const checkedTo = minKey(span.lastNight, lastNightKey(now, tz));
  const shownFrom = span.weeks[0]?.from ?? span.startsOn;
  const checkins = data.checkins ? live(data.checkins) : null;
  const spans = loggedSpans(data, t);
  const feeds = live(data.entries).filter((e) => e.kind === "feed");
  const sleeps = live(data.entries).filter((e) => e.kind === "sleep");

  // Each shown night: its core as logged, a feed in it, a finished try, and the adults' answers.
  const nightInfo = new Map<string, NightInfo>();
  for (const w of span.weeks) {
    for (const k of nightsIn(w, span.lastNight)) {
      const nl = nightLog(k, spans, tz, t);
      const [a, b] = windowOn(NIGHT_STRIP, k, tz).map((d) => d.getTime());
      const ans = checkins ? nightAnswers(checkins, k) : null;
      nightInfo.set(k, {
        night: k,
        week: w.n,
        // A try that try day (a morning nap's too) is something logged, never a night with nothing.
        log: nl ? (nl.log === "none" && byNight.has(k) ? "partly" : nl.log) : null,
        feed: feeds.some((e) => ms(e.started_at) >= a && ms(e.started_at) < b),
        tried: byNight.has(k),
        slept: sleeps.some((e) => ms(e.started_at) < b && (e.ended_at ? ms(e.ended_at) : e.active ? t : ms(e.started_at)) > a),
        checkedIn: ans ? ans.checkedIn : null,
        place: ans?.place ?? null,
        untimed: ans?.untimed ?? null,
        handoff: ans?.handoff ?? null,
      });
    }
  }
  const info = (k: string) => nightInfo.get(k)!;
  // For a bassinet aim, a night is known by what says something about her sleep: a try, a sleep, a check-in or an untimed try.
  // A night with only feeds logged is unknown for it: whether she tried the bassinet isn't in the log.
  const knownNight = (k: string) => {
    const n = info(k);
    return n.tried || tryNights.has(k) || n.slept || !!n.checkedIn || n.untimed != null;
  };
  const unknownNight = (k: string) => info(k).log != null && !knownNight(k);
  const feedsOnlyNight = (k: string) => unknownNight(k) && info(k).log !== "none";

  // Bassinet stretches over the shown nights, each counted on the night it began.
  let stretches: { start: number; end: number }[] = [];
  if (goal.targets.some((x) => x.kind === "bassinet_stretch")) {
    const lo = tryDayBounds(shownFrom, tz)[0].getTime();
    const hi = Math.min(tryDayBounds(span.lastNight, tz)[1].getTime(), t + 1);
    if (hi > lo) stretches = sleepByPlace(data.entries.filter((e) => e.kind === "sleep"), data.tries, lo, hi, t).stretches.filter((s) => s.start >= lo && s.start < hi);
  }

  const windowsOf = (member: string) => goal.roster.filter((w) => w.member === member);
  const targets: TargetProgress[] = goal.targets.map((target): TargetProgress => {
    switch (target.kind) {
      case "bassinet_nights":
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const nights = nightsIn(w, span.lastNight);
            const tried = nights.filter((k) => byNight.has(k));
            const timed = tried.filter((k) => byNight.get(k)!.some((x) => x.outcome === "stayed_asleep" && ms(x.ended_at!) - ms(x.started_at) >= target.min_minutes * MIN));
            // An untimed try from a check-in counts only on a night with no try in the log, and only at the target's minutes or more.
            const fromCheckins = nights.filter((k) => !byNight.has(k) && info(k).untimed?.answer === "long" && info(k).untimed!.minutes >= target.min_minutes);
            return {
              week: w.n,
              counted: timed.length + fromCheckins.length,
              tried: tried.length,
              nights: nights.length,
              fromCheckins: fromCheckins.length,
              known: nights.filter(knownNight).length,
              unknown: nights.filter(unknownNight).length,
              feedsOnly: nights.filter(feedsOnlyNight).length,
            };
          }),
        };
      case "bassinet_stretch": {
        const mine = stretches.map((s) => ({ ...s, week: weekOf(span, tryDayKey(s.start, tz))?.n ?? null })).filter((s) => s.week != null);
        const longest = mine.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0];
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const here = mine.filter((s) => s.week === w.n);
            const top = here.reduce((m, s) => Math.max(m, s.end - s.start), 0);
            return { week: w.n, stretches: here.length, longestSec: here.length ? Math.round(top / 1000) : null, atLeast: here.filter((s) => s.end - s.start >= target.minutes * MIN).length };
          }),
          longest: longest ? { sec: Math.round((longest.end - longest.start) / 1000), start: new Date(longest.start).toISOString(), end: new Date(longest.end).toISOString() } : null,
        };
      }
      case "protected_window": {
        if (!checkins) return { id: target.id, kind: target.kind, target, weeks: null };
        const theirs = checkins.filter((c) => c.member === target.member);
        const windows = windowsOf(target.member);
        return {
          id: target.id,
          kind: target.kind,
          target,
          weeks: span.weeks.map((w) => {
            const nights = new Set(nightsIn(w, checkedTo));
            const here = theirs.filter((c) => nights.has(c.night));
            const count = (a: ProtectedAnswer) => here.filter((c) => c.protected === a).length;
            return { week: w.n, yes: count("yes"), partly: count("partly"), no: count("no"), checkedIn: here.length, planned: [...nights].filter((k) => windows.some((x) => windowOnNight(x, k))).length };
          }),
        };
      }
      case "custom":
        return { id: target.id, kind: target.kind, target };
    }
  });

  let checkinCounts: CheckinCounts[] | null = null;
  if (checkins) {
    const last = lastNightKey(now, tz);
    const inShown = checkins.filter((c) => c.night >= shownFrom && c.night <= checkedTo);
    const people = new Set<string>([...inShown.map((c) => c.member), ...goalAdults(goal)]);
    checkinCounts = [...people].map((member) => {
      const theirs = inShown.filter((c) => c.member === member);
      const count = (a: ProtectedAnswer) => theirs.filter((c) => c.protected === a).length;
      const lastOne = checkins.find((c) => c.member === member && c.night === last);
      return { member, nights: theirs.length, yes: count("yes"), partly: count("partly"), no: count("no"), lastNight: lastOne?.protected ?? null };
    });
  }

  // What was logged each week, over the nights that are over.
  const coverage: WeekCoverage[] = span.weeks.map((w) => {
    const over = nightsIn(w, span.lastNight)
      .map(info)
      .filter((n) => n.log != null);
    const n = (f: (x: NightInfo) => boolean) => over.filter(f).length;
    return {
      week: w.n,
      over: over.length,
      logged: n((x) => x.log === "logged"),
      partly: n((x) => x.log === "partly"),
      none: n((x) => x.log === "none"),
      feedNights: n((x) => x.feed),
      tryNights: n((x) => x.tried),
      checkinNights: checkins ? n((x) => !!x.checkedIn) : null,
    };
  });
  const answers: WeekAnswers[] | null = checkins
    ? span.weeks.map((w) => {
        const out: WeekAnswers = { week: w.n, place: {}, placeNights: 0, handoff: {}, handoffNights: 0 };
        for (const k of nightsIn(w, span.lastNight)) {
          const x = info(k);
          if (x.place) {
            bump(out.place, x.place);
            out.placeNights++;
          }
          if (x.handoff) {
            bump(out.handoff, x.handoff);
            out.handoffNights++;
          }
        }
        return out;
      })
    : null;

  // Roster hints: the last week of nights each window was on and is over, inside the goal.
  const cur = tryDayKey(now, tz);
  const shifts = live(data.shifts);
  const turnEnd = (s: HoldingShift) => (s.ended_at ? ms(s.ended_at) : t);
  const longTurn = (s: HoldingShift) => turnLeftOpen(s, t);
  const roster: RosterHint[] = goal.roster.map((w) => {
    const keys: string[] = [];
    for (let i = HINT_NIGHTS; i >= 0; i--) {
      const k = addDays(cur, -i);
      if (k < span.startsOn || k > span.lastNight || !windowOnNight(w, k)) continue;
      if (windowOn(w, k, tz)[1].getTime() > t) continue;
      keys.push(k);
    }
    const hint: RosterHint = { windowId: w.id, member: w.member, nights: 0, loggedNights: 0, feeds: 0, feedNights: 0, feedsLoggedBy: 0, feedsBy: [], ownFeedNights: 0, ownFeedSpan: null, heldNights: 0, cover: [], tries: 0, longTurns: [] };
    const cover = new Map<string, number>();
    const by = new Map<string | null, { bottles: number; nursing: number }>();
    const long = new Map<number, HoldingShift>();
    let first: { at: number; pos: number } | null = null;
    let last: { at: number; pos: number } | null = null;
    for (const k of keys.slice(-HINT_NIGHTS)) {
      const [a, b] = windowOn(w, k, tz).map((d) => d.getTime());
      const noon = tryDayBounds(k, tz)[0].getTime();
      hint.nights++;
      if (spans.some(([s, e]) => e >= a && s < b)) hint.loggedNights++;
      const inside = feeds.filter((e) => ms(e.started_at) >= a && ms(e.started_at) < b);
      hint.feeds += inside.length;
      if (inside.length) hint.feedNights++;
      hint.feedsLoggedBy += inside.filter((e) => e.created_by === w.member).length;
      for (const e of inside) {
        const row = by.get(e.created_by) ?? { bottles: 0, nursing: 0 };
        if (e.kind === "feed" && e.data.method === "bottle") row.bottles++;
        else row.nursing++;
        by.set(e.created_by, row);
      }
      const own = inside.filter((e) => e.created_by === w.member);
      if (own.length) hint.ownFeedNights++;
      for (const e of own) {
        const at = ms(e.started_at);
        const pos = at - noon;
        if (!first || pos < first.pos) first = { at, pos };
        if (!last || pos > last.pos) last = { at, pos };
      }
      hint.tries += tries.filter((x) => ms(x.started_at) >= a && ms(x.started_at) < b).length;
      const during = shifts.filter((s) => ms(s.started_at) < b && turnEnd(s) > a);
      for (const s of during.filter(longTurn)) long.set(s.id, s);
      const counted = during.filter((s) => !longTurn(s));
      if (counted.some((s) => s.holder === w.member)) hint.heldNights++;
      for (const who of new Set(counted.filter((s) => s.holder !== w.member).map((s) => s.holder))) cover.set(who, (cover.get(who) ?? 0) + 1);
    }
    hint.cover = [...cover.entries()].map(([member, nights]) => ({ member, nights })).sort((x, y) => y.nights - x.nights || x.member.localeCompare(y.member));
    hint.feedsBy = [...by.entries()]
      .map(([member, n]) => ({ member, ...n }))
      .sort((x, y) => y.bottles + y.nursing - (x.bottles + x.nursing) || String(x.member).localeCompare(String(y.member)));
    hint.ownFeedSpan = first && last ? { first: new Date(first.at).toISOString(), last: new Date(last.at).toISOString() } : null;
    hint.longTurns = [...long.values()].sort((x, y) => ms(x.started_at) - ms(y.started_at)).map((s) => ({ member: s.holder, start: s.started_at, end: s.ended_at, planned: s.handoff_at }));
    return hint;
  });

  // Her logged night feeds over the last week, start to start within each night's 8 PM–8 AM: the longest gap seen.
  const nightGaps: number[] = [];
  for (let i = HINT_NIGHTS; i >= 0; i--) {
    const k = addDays(cur, -i);
    if (k < span.startsOn || k > span.lastNight) continue;
    const [a, b] = windowOn(NIGHT_STRIP, k, tz).map((d) => d.getTime());
    if (b > t) continue;
    const starts = feeds
      .map((e) => ms(e.started_at))
      .filter((x) => x >= a && x < b)
      .sort((x, y) => x - y);
    if (starts.length >= 2) nightGaps.push(Math.max(...starts.slice(1).map((x, j) => x - starts[j])));
  }
  const feedGap = nightGaps.length >= 2 ? { longestMin: Math.round(Math.max(...nightGaps) / MIN), nights: nightGaps.length } : null;

  // Check-in patterns: each adult's nights on the roster they checked in about, with and without something in the log.
  let observations: CheckinObservation[] | null = null;
  if (checkins) {
    observations = [];
    for (const member of goalAdults(goal)) {
      const windows = windowsOf(member);
      const rows = checkins
        .filter((c) => c.member === member && c.night >= shownFrom && c.night <= checkedTo)
        .flatMap((c) => {
          const on = windows.filter((w) => windowOnNight(w, c.night));
          if (!on.length) return [];
          const fedByOther = on.some((w) => {
            const [a, b] = windowOn(w, c.night, tz).map((d) => d.getTime());
            return feeds.some((e) => e.created_by !== member && ms(e.started_at) >= a && ms(e.started_at) < b);
          });
          return [{ yes: c.protected === "yes", fed_by_other: fedByOther, try: byNight.has(c.night) }];
        });
      for (const factor of ["fed_by_other", "try"] as const) {
        const w = rows.filter((r) => r[factor]);
        const wo = rows.filter((r) => !r[factor]);
        if (w.length < CHECKIN_PATTERN_NIGHTS || wo.length < CHECKIN_PATTERN_NIGHTS) continue;
        const a = w.filter((r) => r.yes).length;
        const b = wo.filter((r) => r.yes).length;
        if (Math.abs(a / w.length - b / wo.length) < CHECKIN_PATTERN_GAP) continue;
        observations.push({ member, factor, with: { yes: a, of: w.length }, without: { yes: b, of: wo.length } });
      }
    }
  }

  const plan = stepsByWeek(goal.steps, span);
  const recent = new Set(span.weeks.slice(-2).map((w) => w.n));
  return {
    ...span,
    goalId: goal.id,
    targets,
    steps: { done: goal.steps.filter((s) => s.done_at).length, of: goal.steps.length, next: nextStepNow(goal.steps, span), thisWeek: plan.thisWeek, earlier: plan.earlier },
    checkins: checkinCounts,
    roster,
    coverage,
    answers,
    nights: [...nightInfo.values()].filter((n) => recent.has(n.week)),
    feedGap,
    observations,
  };
}

/** The adults a goal names: its roster's and its protected-window targets'. */
export function goalAdults(goal: Pick<SleepGoal, "roster" | "targets">): string[] {
  return [...new Set([...goal.roster.map((w) => w.member), ...goal.targets.flatMap((x) => (x.kind === "protected_window" ? [x.member] : []))])];
}

// ── words ────────────────────────────────────────────────────────────────

export type GoalWords = {
  v: Voice;
  /** A member id's name. */
  name: (id: string) => string;
  tz: string;
  now: Date;
};

const answers = (c: { yes: number; partly: number; no: number }) =>
  (["yes", "partly", "no"] as const)
    .filter((a) => c[a])
    .map((a) => `${PROTECTED_LABEL[a].toLowerCase()} ${c[a]}`)
    .join(", ");

/** A count against the aim: "3 of the 3 nights aimed for", "4 nights, past the 3 aimed for". */
export function againstAim(n: number, aim: number): string {
  return n > aim ? `${plural(n, "night")}, past the ${aim} aimed for` : `${n} of the ${plural(aim, "night")} aimed for`;
}

/** "bassinet 2, held by someone awake 2" from a week's answers, most first. */
const tally = <K extends string>(m: Partial<Record<K, number>>, label: Record<K, string>) =>
  (Object.entries(m) as [K, number][])
    .filter(([, n]) => n)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${label[k].toLowerCase()} ${n}`)
    .join(", ");

/** The morning after a goal week's last night: the try day is still that night's, while the calendar day is already the next week's. */
export function weekEndedLastNight(p: Pick<GoalSpan, "weekNow" | "weeksTotal" | "startsOn" | "today">): boolean {
  return p.weekNow != null && weekNumber(p.startsOn, maxKey(p.today, p.startsOn), p.weeksTotal) > p.weekNow;
}

/** A week still under way ("so far"): the current one, unless it ended last night. */
export const weekOngoing = (w: GoalWeek, p: Pick<GoalSpan, "weekNow" | "weeksTotal" | "startsOn" | "today">) => w.current && !weekEndedLastNight(p);

/**
 * A goal week's name in the counts: "This week", "Last week", "Week 2", and
 * on the morning after a week's last night (the try day is still that
 * night's, while the calendar day, and with it this week's step, is already
 * the next week's) "Week 1 (ended last night)", so "this week" never means
 * two weeks at once. `of`: "Week 2 of 4" for a week further back.
 */
export function goalWeekLabel(w: GoalWeek, p: Pick<GoalSpan, "weeks" | "weekNow" | "weeksTotal" | "startsOn" | "today">, o: { of?: boolean } = {}): string {
  const ended = weekEndedLastNight(p);
  if (w.current) return ended ? `Week ${w.n} (ended last night)` : "This week";
  if (!ended && p.weekNow && w.n === p.weekNow - 1) return "Last week";
  return `Week ${w.n}${o.of && p.weeksTotal ? ` of ${p.weeksTotal}` : ""}`;
}

/** The goal's header line: "Sleep goal g3 (Active): "Both of us get a 4-hour stretch". Target date Mon, Nov 30 (28 days left); week 1 of 4." */
export function goalHeadLine(goal: SleepGoal, p: GoalSpan, words: Pick<GoalWords, "tz">): string {
  const status = goal.status === "met" || goal.status === "dropped" ? `${GOAL_STATUS_LABEL[goal.status]}${goal.closed_at ? ` on ${dateWords(dayKey(ms(goal.closed_at), words.tz), p.today)}` : ""}` : GOAL_STATUS_LABEL[goal.status];
  const parts = [`Sleep goal ${goalRef(goal.id)} (${status}): "${goal.title}".`];
  if (goal.why) parts.push(`Why: "${goal.why}".`);
  if (p.endsOn) {
    const left = p.daysLeft ?? 0;
    const when = left > 1 ? `${left} days left` : left === 1 ? "tomorrow" : left === 0 ? "today" : `${plural(-left, "day")} ago`;
    parts.push(`Target date ${dateWords(p.endsOn, p.today)} (${when})${p.weekNow ? `; week ${p.weekNow} of ${p.weeksTotal}` : ""}.`);
  } else {
    parts.push(`No target date${p.weekNow ? `; week ${p.weekNow}` : ""}.`);
  }
  return parts.join(" ");
}

/**
 * A roster hint in words (the tools' line after its window, and the goal
 * card): feeds inside the window by who logged them, bottles and nursing
 * apart, who held the baby then, tries begun in it, and holding turns over
 * 4 hours left out. A night with nothing logged inside it is said as that,
 * never "no feeds".
 */
export function rosterHintBody(h: RosterHint, name: (id: string) => string, v: Voice, tz: string): string {
  const unlogged = h.nights - h.loggedNights;
  const parts: string[] = [];
  if (h.feeds) {
    const by = h.feedsBy.map((x) => `${[x.bottles ? plural(x.bottles, "bottle") : "", x.nursing ? `${x.nursing} nursing` : ""].filter(Boolean).join(" and ")} logged by ${x.member ? name(x.member) : "someone"}`);
    parts.push(`feeds began inside it on ${h.feedNights} of ${plural(h.nights, "night")} (${plural(h.feeds, "feed")}: ${by.join(", ")})`);
    if (unlogged) parts.push(`nothing logged inside it on ${unlogged} of them`);
  } else if (!h.loggedNights) {
    parts.push(`nothing logged inside it on any of the ${plural(h.nights, "night")}`);
  } else {
    parts.push(`feeds logged inside it on 0 of ${plural(h.nights, "night")}${unlogged ? ` (only ${h.loggedNights} ${h.loggedNights === 1 ? "has" : "have"} anything logged inside it)` : ""}`);
  }
  if (h.heldNights) parts.push(`${name(h.member)} held ${v.name} during it on ${plural(h.heldNights, "night")}`);
  for (const c of h.cover) parts.push(`${name(c.member)} held ${v.name} during it on ${plural(c.nights, "night")}`);
  if (h.tries) parts.push(`${plural(h.tries, "bassinet try", "bassinet tries")} began inside it`);
  for (const l of h.longTurns) {
    const when = `${name(l.member)}'s, from ${formatTime(l.start, tz)}${l.end ? ` to ${formatTime(l.end, tz)}` : ", still open"}`;
    parts.push(
      l.planned
        ? `a holding turn an hour or more past its planned handoff (${when}; planned for ${formatTime(l.planned, tz)}) is left out: it may have been left open`
        : `a holding turn over 4 hours (${when}) is left out: it may have been left open`
    );
  }
  return parts.join("; ");
}

/** "Logged: this week something on 5 of 7 nights (…); last week …", over the nights that are over. */
function coverageWords(c: WeekCoverage): string {
  const some = c.logged + c.partly;
  const kinds = [`feeds on ${c.feedNights}`, `tries on ${c.tryNights}`, ...(c.checkinNights != null ? [`check-ins on ${c.checkinNights}`] : [])].join(", ");
  // Never "partly" here: that's a check-in's answer.
  return `something on ${some} of ${plural(c.over, "night")} (${c.partly ? `${c.partly} with a gap of 4 hours or more; ` : ""}${kinds})`;
}

/**
 * The progress in plain lines, for the tools and the app's screen readers:
 * the last review, each target this week and last against its aim, what was
 * logged (so a night with nothing logged reads as unknown), the adults'
 * answers about the baby's nights and their check-ins (only when this reader
 * can see them), the steps, the roster and its hints. Neutral words, every
 * count with what it's out of.
 */
export function goalProgressLines(goal: SleepGoal, p: GoalProgress, words: GoalWords): string[] {
  const { v, name } = words;
  const lines: string[] = [];
  // The week tonight is in and the one before (or the last two, once the goal is past its date or closed).
  const cur = p.weeks[p.weeks.length - 1];
  const prev = p.weeks.length > 1 ? p.weeks[p.weeks.length - 2] : null;
  const label = (w: GoalWeek) => goalWeekLabel(w, p, { of: true });
  const shown = [cur, prev].filter((w): w is GoalWeek => !!w);
  const sentence = (head: string, parts: string[]) => lines.push(`${head}. ${parts.join(" ")}`);
  if (goal.last_review_at) lines.push(`Last review (${dateWords(dayKey(ms(goal.last_review_at), words.tz), p.today)}): ${goal.review_note ? `"${goal.review_note}"` : "no note"}.`);
  for (const tp of p.targets) {
    const head = `Aim: ${targetWords(tp.target, name)}`;
    switch (tp.kind) {
      case "bassinet_nights":
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks.find((y) => y.week === w.n)!;
            const apart = x.fromCheckins ? `${x.counted - x.fromCheckins} timed, ${x.fromCheckins} from check-ins; ` : "";
            // Nights with only feeds logged: whether she tried the bassinet isn't in the log, so never "no tries".
            const only = x.feedsOnly ? `; ${x.feedsOnly} of them with only feeds or other entries logged, no try, sleep or check-in` : "";
            return `${label(w)}: ${againstAim(x.counted, tp.target.per_week)} (${apart}tries logged on ${x.tried} of ${plural(x.nights, "night")}${weekOngoing(w, p) ? " so far" : ""}${only}).`;
          })
        );
        break;
      case "bassinet_stretch":
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks.find((y) => y.week === w.n)!;
            return x.stretches
              ? `${label(w)}: longest ${formatDuration(x.longestSec ?? 0)}; ${x.atLeast} of ${plural(x.stretches, "stretch", "stretches")} ${x.atLeast === 1 ? "was" : "were"} ${minutesWords(tp.target.minutes)} or more.`
              : `${label(w)}: no bassinet stretches logged${weekOngoing(w, p) ? " yet" : ""}.`;
          })
        );
        break;
      case "protected_window":
        if (!tp.weeks) {
          lines.push(`${head} (counted from the adults' own check-ins).`);
          break;
        }
        sentence(
          head,
          shown.map((w) => {
            const x = tp.weeks!.find((y) => y.week === w.n)!;
            const other = answers({ yes: 0, partly: x.partly, no: x.no });
            const soFar = weekOngoing(w, p) ? " so far" : "";
            const of = x.planned ? `checked in on ${x.checkedIn} of ${plural(x.planned, "roster night")}${soFar}` : `checked in on ${plural(x.checkedIn, "night")}${soFar}`;
            return x.checkedIn ? `${label(w)}: yes on ${againstAim(x.yes, tp.target.per_week)} (${of}${other ? `; ${other}` : ""}).` : `${label(w)}: no check-ins yet; ${plural(x.planned, "night")} on the roster${soFar}.`;
          })
        );
        break;
      case "custom":
        lines.push(`${head} (not counted from the log; ask how it's going).`);
        break;
    }
  }
  const cov = shown.map((w) => ({ w, c: p.coverage.find((c) => c.week === w.n) })).filter((x) => x.c && x.c.over > 0);
  if (cov.length) lines.push(`Logged: ${cov.map(({ w, c }) => `${label(w).toLowerCase()} ${coverageWords(c!)}`).join("; ")}.`);
  if (p.answers) {
    const said = shown
      .map((w) => ({ w, a: p.answers!.find((x) => x.week === w.n)! }))
      .filter(({ a }) => a && (a.placeNights || a.handoffNights))
      .map(({ w, a }) => {
        const bits = [
          a.placeNights ? `where ${v.name} spent most of the night, ${tally(a.place, PLACE_LABEL)} (${plural(a.placeNights, "night")} answered)` : "",
          a.handoffNights ? `the planned handoff, ${tally(a.handoff, HANDOFF_LABEL)} (${plural(a.handoffNights, "night")} answered)` : "",
        ].filter(Boolean);
        return `${label(w).toLowerCase()}: ${bits.join("; ")}`;
      });
    if (said.length) lines.push(`From the adults' check-ins, ${said.join("; ")}.`);
  }
  if (goal.steps.length) {
    // By id: the coach notes name each step this week and still open.
    const plan = [
      ...(p.steps.thisWeek.length ? [`this week: ${p.steps.thisWeek.map((s) => s.id).join(", ")}`] : []),
      ...(p.steps.earlier.length ? [`still open from earlier: ${p.steps.earlier.map((s) => s.id).join(", ")}`] : []),
    ];
    const n = p.steps.next;
    const rest = plan.length ? `; ${plan.join("; ")}` : n ? `; next: "${n.title}" (${n.id}${n.week_of ? `, week of ${dateWords(n.week_of, p.today)}` : ", any week"})` : p.steps.done === p.steps.of ? "; all done" : "";
    lines.push(`Steps: ${p.steps.done} of ${p.steps.of} done${rest}.`);
  }
  if (p.checkins) {
    const people = p.checkins.filter((c) => c.nights);
    lines.push(
      people.length
        ? `Check-ins since ${dateWords(p.weeks[0]?.from ?? p.startsOn, p.today)}: ${people.map((c) => `${name(c.member)} ${plural(c.nights, "night")} (${answers(c)})`).join("; ")}.`
        : "No check-ins yet over these weeks."
    );
    for (const o of p.observations ?? []) lines.push(observationWords(o, name));
  }
  if (goal.roster.length) {
    lines.push(`Roster: ${rosterWords(goal.roster, name)}.`);
    for (const h of p.roster) {
      if (!h.nights) continue;
      const w = goal.roster.find((x) => x.id === h.windowId)!;
      lines.push(`Hint from the log, ${name(h.member)}'s window ${windowTimes(w)} (the last ${plural(h.nights, "night")} it was on): ${rosterHintBody(h, name, v, words.tz)}.`);
    }
  }
  return lines;
}

// ── coaching ─────────────────────────────────────────────────────────────

export type CoachNotes = {
  goalId: number;
  daysLeft: number | null;
  /** An active goal's last review (or, without one, when it was set) is REVIEW_DUE_DAYS or more days ago. */
  reviewDue: boolean;
  daysSinceReview: number;
  /** This week's step, else the latest still open from earlier, else one for any week, else the next planned (nextStepNow). */
  nextStep: GoalStep | null;
  /** Undone steps planned for the goal's week today is in, and for the weeks before it. */
  thisWeek: GoalStep[];
  earlier: GoalStep[];
  /** A window that keeps getting broken by its own adult's feeds, as one thing to talk over; null when none does. */
  focus: string | null;
  /** The goal's adults without a check-in for last night; null for a reader who can't see check-ins. */
  notCheckedIn: string[] | null;
  /** Short lines for the coach (and the app, if it shows them). */
  notes: string[];
};

/** A window broken this often by its own adult's feeds gets a focus note: on 3 or more nights, and 3 of every 4 with anything logged inside it. */
const FOCUS_MIN_NIGHTS = 3;

/**
 * The focus: the roster window whose own adult logged a feed inside it on
 * the most nights (at least FOCUS_MIN_NIGHTS, and three of every four nights
 * anything was logged inside it), with when those feeds began, and one step
 * to talk over. Feeding changes stay a question for their clinicians.
 */
function focusNote(goal: SleepGoal, p: GoalProgress, words: Pick<GoalWords, "name" | "tz"> & { v?: Voice }): string | null {
  const best = p.roster
    .filter((h) => h.ownFeedSpan && h.ownFeedNights >= FOCUS_MIN_NIGHTS && h.ownFeedNights * 4 >= h.loggedNights * 3)
    .sort((a, b) => b.ownFeedNights - a.ownFeedNights)[0];
  if (!best) return null;
  const w = goal.roster.find((x) => x.id === best.windowId);
  if (!w) return null;
  const who = words.name(best.member);
  const other = goalAdults(goal).find((m) => m !== best.member);
  const [a, b] = [formatTime(best.ownFeedSpan!.first, words.tz), formatTime(best.ownFeedSpan!.last, words.tz)];
  const baby = words.v?.name ?? "the baby";
  const head = `Focus: ${who} logged a feed inside ${who}'s window (${windowTimes(w)}) on ${best.ownFeedNights} of the ${plural(best.loggedNights, "night")} anything was logged inside it, ${a === b ? `at ${a}` : `${a}–${b}`}.`;
  // Feeds closer together than the window is long: any window that long catches one, so moving it won't help.
  const len = windowMinutes(w.from, w.to);
  if (p.feedGap && p.feedGap.longestMin < len) {
    return `${head} ${baby}'s logged night feeds began at most ${minutesWords(p.feedGap.longestMin)} apart (over ${plural(p.feedGap.nights, "night")}), less than the window's ${minutesWords(len)}, so a window that long will likely catch one. One step to talk over: a shorter window, or ${other ? words.name(other) : "someone else"} giving one feed in it (a bottle is a question for their lactation consultant).`;
  }
  return `${head} One step to talk over: start ${who}'s window after that feed, or have ${other ? words.name(other) : "someone else"} settle ${baby} then. Bottles or pumping only as a question for their pediatrician or lactation consultant.`;
}

export function coachNotes(goal: SleepGoal, p: GoalProgress, words: Pick<GoalWords, "name" | "tz" | "now"> & { v?: Voice }): CoachNotes {
  const open = isOpen(goal.status);
  const since = daysBetween(dayKey(ms(goal.last_review_at ?? goal.created_at), words.tz), p.today);
  const reviewDue = goal.status === "active" && since >= REVIEW_DUE_DAYS;
  const notes: string[] = [];
  if (goal.status === "paused") notes.push("Paused: ask whether they want to pick it back up before coaching on it.");
  if (open && p.endsOn && p.daysLeft != null) {
    const d = dateWords(p.endsOn, p.today);
    if (p.daysLeft > 1) notes.push(`${p.daysLeft} days to the target date (${d}).`);
    else if (p.daysLeft === 1) notes.push(`The target date is tomorrow (${d}).`);
    else if (p.daysLeft === 0) notes.push("The target date is today: a good moment to look back at it together.");
    else notes.push(`The target date (${d}) was ${plural(-p.daysLeft, "day")} ago: ask whether to close it as met, set a new date, or keep going.`);
  }
  if (reviewDue) notes.push(goal.last_review_at ? `Review due: the last one was ${plural(since, "day")} ago.` : `Review due: it was set ${plural(since, "day")} ago and hasn't had one yet.`);
  const plan = stepsByWeek(goal.steps, p);
  const next = nextStepNow(goal.steps, p);
  if (open) {
    const listed = (xs: GoalStep[], week: boolean) => xs.map((s) => `"${s.title}" (${s.id}${week && s.week_of ? `, week of ${dateWords(s.week_of, p.today)}` : ""})`).join("; ");
    if (plan.thisWeek.length) notes.push(`This week's step: ${listed(plan.thisWeek, false)}.`);
    if (plan.earlier.length) notes.push(`Still open from earlier: ${listed(plan.earlier, true)}.`);
    if (!plan.thisWeek.length) {
      if (!goal.steps.length) notes.push("No weekly steps yet: suggest one small step for this week.");
      else if (goal.steps.every((s) => s.done_at)) notes.push("Every step is done: ask whether to plan the next one.");
      else {
        const other = plan.anyTime[0] ? `; one for any week: "${plan.anyTime[0].title}" (${plan.anyTime[0].id})` : plan.later[0] ? `; next planned: "${plan.later[0].title}" (${plan.later[0].id}, week of ${dateWords(plan.later[0].week_of!, p.today)})` : "";
        notes.push(`No step for this week yet${other}. End the review with one small step they choose for this week, saved as a step.`);
      }
    }
    // Nights with nothing logged are unknown: ask about them before counting them.
    const over = p.nights.filter((n) => n.log != null).slice(-7);
    const unknown = over.filter((n) => n.log === "none" && !n.tried && !n.untimed);
    if (unknown.length) {
      notes.push(
        `Nothing logged on ${unknown.length} of the last ${plural(over.length, "night")} (${unknown.map((n) => tryDayLabel(n.night, p.today)).join(", ")}): a night with nothing logged is unknown, not a night that went well or badly; ask about it before counting it.`
      );
    }
    // Nights with only feeds logged say nothing about the bassinet: never "no tries".
    if (goal.targets.some((x) => x.kind === "bassinet_nights" || x.kind === "bassinet_stretch")) {
      const only = over.filter((n) => n.log !== "none" && !n.tried && !n.slept && !n.checkedIn && !n.untimed);
      if (only.length) notes.push(`Only feeds or other entries were logged on ${only.length} of the last ${plural(over.length, "night")}, with no try, sleep or check-in: whether ${words.v?.name ?? "the baby"} tried the bassinet then isn't in the log, so ask.`);
    }
  }
  const focus = open ? focusNote(goal, p, words) : null;
  if (focus) notes.push(focus);
  // A "Back to work" goal: drowsy driving after a short night, and more night nursing to expect when the nursing parent goes back.
  const t = goal.template;
  if (open && t?.kind === "back_to_work" && p.today >= t.date) {
    const R = words.name(t.member);
    const last = lastNightKey(words.now, words.tz);
    const said = p.checkins?.find((c) => c.member === t.member)?.lastNight ?? null;
    if ((said === "no" || said === "partly") && goal.roster.some((w) => w.member === t.member && windowOnNight(w, last))) {
      notes.push(`${R} said "${PROTECTED_LABEL[said].toLowerCase()}" about last night's window and is back at work: mention drowsy driving gently. If ${R} is very sleepy, a ride, transit or a short nap before driving is safer; in one small study, new parents who slept poorly had more near misses on the road.`);
    }
    if (t.nursing === t.member && daysBetween(t.date, p.today) <= 14) {
      notes.push(`${R} has been back at work since ${dateWords(t.date, p.today)}: some babies nurse more often at night once the nursing parent is back (sometimes called reverse cycling), so read the check-ins and hints with that in mind, and offer to change the roster if it helps.`);
    }
  }
  let notCheckedIn: string[] | null = null;
  if (p.checkins) {
    // Nobody owes a check-in for a night before the goal's first one.
    const owed = lastNightKey(words.now, words.tz) >= p.startsOn;
    notCheckedIn = owed ? goalAdults(goal).filter((m) => !p.checkins!.some((c) => c.member === m && c.lastNight)) : [];
    if (open && notCheckedIn.length) notes.push(`Not checked in for last night yet: ${notCheckedIn.map(words.name).join(", ")}.`);
  }
  return { goalId: goal.id, daysLeft: p.daysLeft, reviewDue, daysSinceReview: since, nextStep: next, thisWeek: plan.thisWeek, earlier: plan.earlier, focus, notCheckedIn, notes };
}

/**
 * How the coach works, for sleep_goal's description and sleep_plan's
 * coach notes. Nothing here is medical advice; feeding changes are only
 * ever something to raise with the family's own clinicians.
 */
export const coachGuardrails = (v: Voice): string[] => [
  "Ask one question at a time (in Maple chat, with ask_user).",
  "Propose a goal with its steps, read it back, and save it only after they say yes.",
  "Use the family's memories for their constraints (work dates, feeding, who's home), and the log for what happened.",
  "Counts are only what was logged: a night with nothing logged is unknown, so say it wasn't logged and ask, never that something didn't happen.",
  "No medical advice: questions about health go to their pediatrician.",
  "Feeding changes (bottles, pumping, formula) only as options to raise with their pediatrician or lactation consultant.",
  `Never crying it out, and never ${v.name} sleeping on an adult, or in a bed, couch or armchair with one, as a plan.`,
  "Hard nights are part of it: give the counts plainly, with no blame, scores or streaks.",
  "A photo of a paper log or another app's screen: read each entry back, and save them with log_many only after they say yes.",
];

/**
 * Goals by urgency, for the coach and the Goals tab: active, then paused,
 * then closed; then the nearest target date (one already past first); then a
 * review due; then the newest.
 */
export function goalsByUrgency<T extends Pick<SleepGoal, "id" | "status" | "created_at" | "target_date" | "closed_at" | "last_review_at">>(goals: readonly T[], now: Date, tz: string): T[] {
  const today = dayKey(now, tz);
  const key = (g: T) => {
    const span = goalSpan(g, now, tz);
    const since = daysBetween(dayKey(ms(g.last_review_at ?? g.created_at), tz), today);
    return { rank: g.status === "active" ? 0 : g.status === "paused" ? 1 : 2, left: span.daysLeft ?? Infinity, due: g.status === "active" && since >= REVIEW_DUE_DAYS ? 0 : 1, made: ms(g.created_at) };
  };
  const keys = new Map(goals.map((g) => [g.id, key(g)]));
  return [...goals].sort((a, b) => {
    const x = keys.get(a.id)!;
    const y = keys.get(b.id)!;
    return x.rank - y.rank || x.left - y.left || x.due - y.due || y.made - x.made || b.id - a.id;
  });
}

/** A check-in's night in a sentence, by the calendar (as lastNightKey): "last night" all day after it, then "Sat night". */
export const nightWords = (night: string, now: Date, tz: string) => tryDayLabel(night, dayKey(now, tz));

/** "Sam yes, Alex partly; not yet: Robin": last night's check-ins for these adults. */
export function lastNightLine(adults: readonly string[], checkins: readonly SleepCheckin[], now: Date, tz: string, name: (id: string) => string): string {
  const last = lastNightKey(now, tz);
  const done = adults.flatMap((m) => {
    const c = live(checkins).find((x) => x.member === m && x.night === last);
    return c ? [`${name(m)} ${PROTECTED_LABEL[c.protected].toLowerCase()}`] : [];
  });
  const notYet = adults.filter((m) => !live(checkins).some((x) => x.member === m && x.night === last)).map(name);
  return [done.join(", "), notYet.length ? `not yet: ${notYet.join(", ")}` : ""].filter(Boolean).join("; ");
}

/** A check-in in a sentence: "Sat night (Oct 31): yes". */
export function checkinWords(c: Pick<SleepCheckin, "night" | "protected">, now: Date, tz: string): string {
  return `${nightWords(c.night, now, tz)} (${dateWords(c.night, dayKey(now, tz)).replace(/^\w+, /, "")}): ${PROTECTED_LABEL[c.protected].toLowerCase()}`;
}

/** A window in a line, with how its feeds are covered when it says: "Sam: 10:00 PM–2:00 AM, Sun–Thu nights (feeds: nursing)". */
export const windowLine = (w: RosterWindow, name: (id: string) => string) => `${windowWords(w, name)}${w.covers ? ` (${coversWords(w.covers)})` : ""}`;

/** A goal's roster in one line: "Sam: 10:00 PM–2:00 AM, Sun–Thu nights (feeds: nursing); Alex: …". */
export const rosterWords = (roster: readonly RosterWindow[], name: (id: string) => string) => roster.map((w) => windowLine(w, name)).join("; ");

/** A goal's targets in one line, for a read-back. */
export const targetsWords = (targets: readonly GoalTarget[], name: (id: string) => string) => targets.map((t) => targetWords(t, name)).join("; ");

/** The evenings a window is on, for a read-back: "Sun–Thu nights". */
export const windowNights = (w: Pick<RosterWindow, "nights">) => nightsLabel(w.nights);

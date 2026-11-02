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
import { SLEEP_GUIDES } from "../guidelines/sleep";
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
import { dateWords, GOAL_STATUS_LABEL, HANDOFF_LABEL, minutesWords, nightsLabel, PLACE_LABEL, PROTECTED_LABEL, targetWords, weekdayOf, windowTimes, windowWords } from "./words";

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
// a custom target) and the plan's goal: never leaving the baby to cry, and
// never the baby asleep on or with an adult, or in a bed, couch, recliner,
// armchair or swing. Each part of a sentence is read on its own. A phrase
// right after "no", "never", "instead of", "from" and the like is a step
// away from it ("move from co-sleeping to the bassinet"), and a place counts
// only with a sleep word and the baby in the same part, so "the bassinet
// beside our bed", "Theo sleeps on the couch" and "swing her gently" pass.
// Feeding words (formula, bottles, pumping, weaning) are never refused:
// goalCautions asks for the pediatrician's or lactation consultant's yes.

/** Where a sentence breaks into parts: its ends, dashes, and the words that start another part. */
const PARTS = /[.;!?\n]+|\s[-–—]\s|[–—]|\b(?:but|then|while|whereas|after|before|until|unless|once|because|when|whenever|if|so)\b/i;
/** Just before a phrase (its last three words, within its part and after any comma): a step away from it. */
const AWAY = /\b(?:no|not|never|nor|don'?t|do not|doesn'?t|does not|won'?t|will not|wouldn'?t|can'?t|cannot|shouldn'?t|without|instead|rather than|stop|stops|stopping|quit|quits|quitting|end|ends|ending|avoid|avoids|avoiding|fewer|less|out of|away from|off|from|other than|against)\b/i;
/**
 * Whether the words just before a phrase step away from it: an AWAY cue,
 * unless the bassinet or crib comes after that cue ("from the bassinet into
 * our bed" steps away from the bassinet, toward the bed).
 */
function awayFrom(before: string): boolean {
  let end = -1;
  for (const m of before.matchAll(new RegExp(AWAY.source, "gi"))) end = (m.index ?? 0) + m[0].length;
  return end >= 0 && !SAFE_SURFACE.test(before.slice(end));
}
/** In "why it matters", how things are now ("she only sleeps on me"), which is the reason for the goal, not its plan. */
const DESCRIBING_BEFORE = /\b(?:only|still|currently|usually|mostly|always|keeps?|ends? up|has been|have been|'s been|is|are|was|were|tends? to)\b/i;
const DESCRIBING_AFTER = /^\s*(?:now|right now|for now|at the moment|these days|lately|currently|most nights)\b/i;

const SLEEPING = /\b(?:sleep(?!y)\w*|slept|asleep|naps?|napp\w*|doz(?:e|es|ed|ing)|snooz\w*|nod(?:s|ded|ding)?\s+off|drift(?:s|ed|ing)?\s+off|overnight|all\s+night|the\s+night|bedtime)\b/i;
const SAFE_SURFACE = /\b(?:bassinet|crib|cot|side-?car|bedside\s+sleeper|play\s*-?yard|pack\s*(?:'?n'?|and)\s*play)\b/i;
const SLEEP_VERB = "(?:sleep(?!y)\\w*|slept|asleep|naps?|napp\\w*|doz\\w*)";
const PEOPLE = "me|us|mom|mum|mommy|mummy|mama|momma|dad|daddy|papa|dada|grandma|grandpa|nana|granny";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type UnsafeFind = { kind: "cry" | "adult"; phrase: string };

type Rule = { re: RegExp; kind: UnsafeFind["kind"]; sleep?: boolean; baby?: boolean; unlessSafe?: boolean };

/** "her" as the baby, not "her earplugs": followed by a verb or a little word, or by nothing. */
const HER_OBJECT =
  "\\s+(?:sleep\\w*|nap\\w*|doz\\w*|lie|lay|rest|stay|be|fall\\w*|drift\\w*|settle\\w*|cry\\w*|fuss\\w*|on|in|into|onto|with|to|for|from|at|by|near|next|beside|against|under|down|up|over|back|there|here|out|off|until|while|when|and|or)\\b|\\s*$|\\s*[,.;:!?)]";

function unsafeRules(o: { v?: Pick<Voice, "name" | "named" | "pronoun">; adults?: readonly string[] }): { rules: Rule[]; baby: RegExp } {
  const names = [...new Set((o.adults ?? []).map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && /^[\p{L}'-]{2,}$/u.test(n)))].map(escapeRe);
  const babyName = o.v?.named ? escapeRe(o.v.name) : null;
  const people = [PEOPLE, ...names].join("|");
  // Anyone's chest, lap or shoulder: "my", "his", "Theo's", "Grandma's", the family's names without an apostrophe too.
  const possessive = `(?:my|his|her|your|their|our|[a-z][a-z-]*'s${names.map((n) => `|${n}'?s`).join("")})`;
  // The baby as someone a sentence is about: the name, "the baby", and the family's pronouns ("her" only where it isn't "her earplugs").
  const pron = !o.v ? ["she", "he", "him", `her(?=${HER_OBJECT})`] : o.v.pronoun === "she" ? ["she", `her(?=${HER_OBJECT})`] : o.v.pronoun === "he" ? ["he", "him"] : ["they", "them"];
  const baby = new RegExp(`\\b(?:${[...pron, "(?:the\\s+)?baby", "newborn", ...(babyName ? [babyName] : [])].join("|")})\\b`, "i");
  const someone = `(?:her|him|them|the\\s+baby|baby${babyName ? `|${babyName}` : ""})`;
  const rules: Rule[] = [
    // Leaving the baby to cry.
    { re: /\bcr(?:y|ies|ied|ying)[\s-]+it[\s-]+out\b/gi, kind: "cry" },
    { re: /\bcio\b/gi, kind: "cry" },
    { re: /\bferber\w*/gi, kind: "cry" },
    { re: /\bcontrolled[\s-]+(?:crying|comforting)\b/gi, kind: "cry" },
    { re: /\bextinction\b/gi, kind: "cry" },
    { re: /\bcheck[\s-]+and[\s-]+console\b/gi, kind: "cry" },
    { re: new RegExp(`\\blet(?:s|ting)?\\s+${someone}\\s+(?:cry|cries|crying|fuss|fusses|fussing|scream|screaming|wail|wailing)\\b`, "gi"), kind: "cry" },
    { re: new RegExp(`\\bleav(?:e|es|ing)\\s+${someone}\\s+(?:to\\s+)?(?:cry|crying|fuss|fussing|scream|screaming)\\b`, "gi"), kind: "cry" },
    // Asleep on or with an adult.
    { re: /\bco[\s-]?sleep\w*/gi, kind: "adult" },
    { re: /\bbed[\s-]?shar\w*/gi, kind: "adult" },
    { re: /\bfamily\s+bed\b/gi, kind: "adult" },
    { re: /\bcontact\s+(?:naps?|napping|sleeps?|sleeping)\b/gi, kind: "adult" },
    { re: /\bswing\s+(?:naps?|napping|sleeps?|sleeping)\b/gi, kind: "adult" },
    { re: new RegExp(`\\b${SLEEP_VERB}\\s+(?:only\\s+)?on\\s+(?:${people})\\b`, "gi"), kind: "adult" },
    { re: new RegExp(`\\b${SLEEP_VERB}\\s+(?:only\\s+)?with\\s+(?:${people})\\b`, "gi"), kind: "adult", unlessSafe: true },
    { re: new RegExp(`\\bon\\s+${possessive}\\s+(?:chest|lap|shoulder)\\b`, "gi"), kind: "adult", sleep: true },
    { re: new RegExp(`\\bin\\s+bed\\s+with\\s+(?:${people})\\b`, "gi"), kind: "adult", baby: true },
    // In a bed, couch, recliner, armchair or swing.
    { re: /\b(?:in|on|into|onto)\s+(?:the|a|our|my|your|mom'?s|mum'?s|dad'?s|mommy'?s|daddy'?s|parents'?|grown[\s-]?up|adult|big|double|queen|king)\s+(?:own\s+|big\s+|grown[\s-]?up\s+|adult\s+)?bed\b/gi, kind: "adult", sleep: true, baby: true },
    { re: /\b(?:on|onto|in)\s+(?:the|a|our|my|his|her|their|your)\s+(?:couch|sofa|settee|futon)\b/gi, kind: "adult", sleep: true, baby: true },
    { re: /\b(?:in|on|into)\s+(?:the|a|an|our|my|his|her|their|your|mom'?s|dad'?s)\s+(?:recliner|armchair|arm[\s-]chair|easy\s+chair)\b/gi, kind: "adult", sleep: true, baby: true },
    { re: /\b(?:in|on|into)\s+(?:the|a|her|his|their|its|my|our|your)\s+(?:baby\s+)?swing\b/gi, kind: "adult", sleep: true, baby: true },
  ];
  return { rules, baby };
}

/**
 * Whether a plan's words leave the baby to cry or have the baby asleep on
 * or with an adult, or in a bed, couch, recliner, armchair or swing, and the
 * phrase that does. `v`: the family's voice (the baby's name and pronouns);
 * `adults`: the adults' names; `describing`: the words say why it matters,
 * where "she only sleeps on me now" is the reason, not the plan.
 */
export function unsafeSleep(text: string, o: { v?: Pick<Voice, "name" | "named" | "pronoun">; adults?: readonly string[]; describing?: boolean } = {}): UnsafeFind | null {
  if (!text) return null;
  const { rules, baby } = unsafeRules(o);
  const opts = o;
  for (const part of text.split(PARTS)) {
    if (!part || !part.trim()) continue;
    for (const rule of rules) {
      for (const m of part.matchAll(rule.re)) {
        if (rule.sleep && !SLEEPING.test(part)) continue;
        if (rule.baby && !baby.test(part)) continue;
        if (rule.unlessSafe && SAFE_SURFACE.test(part)) continue;
        const before = part.slice(0, m.index).split(/[,:(]/).pop()!.trim().split(/\s+/).slice(-3).join(" ");
        if (awayFrom(before)) continue;
        if (opts.describing && (DESCRIBING_BEFORE.test(before) || DESCRIBING_AFTER.test(part.slice((m.index ?? 0) + m[0].length)))) continue;
        return { kind: rule.kind, phrase: m[0] };
      }
    }
  }
  return null;
}

/** The refusal, by its field: "Step 2: Maple's plans never leave Wren to cry, or have her sleep on or with an adult, …". */
export function unsafeWords(label: string, v?: Pick<Voice, "name" | "them" | "named">): string {
  const who = v?.named ? v.name : "the baby";
  const them = v?.named ? v.them : "the baby";
  return `${label}: Maple's plans never leave ${who} to cry, or have ${them} sleep on or with an adult, or in a bed, couch, recliner, armchair or swing. Reword it.`;
}

/** A plan's or goal's text checked against unsafeSleep; throws SleepInputError with unsafeWords. */
export function refuseUnsafe(text: string | null | undefined, label: string, o: { v?: Voice; adults?: readonly string[]; describing?: boolean } = {}): void {
  if (text && unsafeSleep(text, o)) throw new SleepInputError(unsafeWords(label, o.v));
}

// ── what a goal's words need said with them (read-backs and the goal card) ──

/** Under this many days old, "Feeds come first" applies (guidelines/sleep.ts normal-feeds-first), so a target past FEEDS_FIRST_MINUTES gets its words. */
export const FEEDS_FIRST_DAYS = 28;
export const FEEDS_FIRST_MINUTES = 240;
/** A protected window longer than this leaves its feeds to someone else. */
export const LONG_WINDOW_MINUTES = 300;

/** Words that change how the baby is fed, which a plan may hold only with the pediatrician's or lactation consultant's yes. */
const FEEDING = /\b(?:formula|bottles?|bottle-?f\w*|pump\w*|express(?:ed|ing)?\s+milk|wean\w*|supplement\w*|top[\s-]?ups?|dream[\s-]?feed\w*|(?:drop|dropping|skip|skipping|cut(?:ting)?\s+out|stretch(?:ing)?|space\s+out)\s+(?:the\s+|a\s+|one\s+|her\s+|his\s+|their\s+)?(?:[\w:]+\s+){0,2}feeds?)\b/i;
/** Already a question for them: "Ask the lactation consultant whether …". */
const ASKING = /^(?:ask|check\s+with|talk\s+(?:to|with)|call|find\s+out|see\s+if|raise|bring\s+up)\b|\b(?:ask|check\s+with|talk\s+(?:to|with)|question\s+for)\s+(?:the\s+|our\s+|her\s+|his\s+|their\s+)?(?:pediatrician|paediatrician|doctor|lactation|lc|ibclc|midwife|nurse|consultant)\b/i;

export type GoalCaution = { kind: "feeds_first" | "long_window" | "feeding"; text: string };

/**
 * What a goal as it would be saved needs said with it: the "Feeds come
 * first" guidance, quoted, for a target past 4 hours while the baby is under
 * 4 weeks old (`ageDays` today; null before she's born; undefined: not
 * known, so not said), a protected window over 5 hours (someone else covers
 * the feeds in it), and a step or aim that changes how the baby is fed (save
 * it only with their clinician's yes). Warnings, never refusals.
 */
export function goalCautions(f: Pick<GoalFields, "title" | "why" | "targets" | "steps" | "roster">, o: { v: Voice; name: (id: string) => string; ageDays?: number | null }): GoalCaution[] {
  const out: GoalCaution[] = [];
  const young = o.ageDays !== undefined && (o.ageDays === null || o.ageDays < FEEDS_FIRST_DAYS);
  const long = (f.targets ?? []).filter((t) => (t.kind === "bassinet_stretch" && t.minutes > FEEDS_FIRST_MINUTES) || (t.kind === "bassinet_nights" && t.min_minutes > FEEDS_FIRST_MINUTES));
  if (young && long.length) {
    const guide = SLEEP_GUIDES.find((g) => g.id === "normal-feeds-first");
    const aims = long.map((t) => `"${targetWords(t, o.name)}"`);
    out.push({
      kind: "feeds_first",
      text: `${aims.join(" and ")} ${aims.length > 1 ? "ask" : "asks"} for more than 4 hours in ${o.v.name}'s first 4 weeks. Maple's guidance for ${o.v.their} age: "${guide ? guide.body(o.v) : `If ${o.v.name} sleeps longer than 4 hours at night, wake ${o.v.them} to feed.`}"`,
    });
  }
  for (const w of f.roster ?? []) {
    if (windowMinutes(w.from, w.to) <= LONG_WINDOW_MINUTES) continue;
    out.push({
      kind: "long_window",
      text: `${o.name(w.member)}'s window, ${windowTimes(w)}, is longer than 5 hours: someone else covers any feeds in it, and bottles or pumping to make that work go to their pediatrician or lactation consultant first.`,
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
    const what = feeding.map((x) => `${x.label} "${x.text}"`).join(" and ");
    out.push({
      kind: "feeding",
      text: `${what.charAt(0).toUpperCase()}${what.slice(1)} ${feeding.length > 1 ? "change" : "changes"} how ${o.v.name} is fed: save ${feeding.length > 1 ? "them" : "it"} only if their pediatrician or lactation consultant agreed; otherwise phrase ${feeding.length > 1 ? "each" : "it"} as "Ask the pediatrician (or lactation consultant) about …".`,
    });
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
};

export type GoalRules = {
  /** The goal being changed, or null for a new one. */
  current: Pick<SleepGoal, "targets" | "steps" | "roster" | "target_date"> | null;
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
      return { id, member, from: w.from, to: w.to, nights: [...new Set(w.nights)].sort((a, b) => a - b) } satisfies RosterWindow;
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

  if (raw.status !== undefined) {
    if (mode === "create") throw new SleepInputError("A new goal starts active.");
    if (raw.status !== "active" && raw.status !== "paused") throw new SleepInputError("A goal's status changes to active or paused here; closing it as met or dropped is its own step.");
    out.status = raw.status;
  }
  return { fields: out, seq };
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
/** A holding turn longer than this was likely left open: it's flagged, and left out of the roster's hints. */
export const LONG_TURN_MIN = 240;

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
  /** Nights with something logged (in the night, or a try), or an untimed try answered. */
  known: number;
  /** Nights that are over with none of those: unknown, not counted either way. */
  unknown: number;
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
  /** Holding turns over LONG_TURN_MIN touching it (likely left open): left out of heldNights and cover. */
  longTurns: { member: string; start: string; end: string | null }[];
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
};

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
  const checkedTo = minKey(span.lastNight, lastNightKey(now, tz));
  const shownFrom = span.weeks[0]?.from ?? span.startsOn;
  const checkins = data.checkins ? live(data.checkins) : null;
  const spans = loggedSpans(data, t);
  const feeds = live(data.entries).filter((e) => e.kind === "feed");

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
        checkedIn: ans ? ans.checkedIn : null,
        place: ans?.place ?? null,
        untimed: ans?.untimed ?? null,
        handoff: ans?.handoff ?? null,
      });
    }
  }
  const info = (k: string) => nightInfo.get(k)!;
  const knownNight = (k: string) => {
    const n = info(k);
    return (n.log != null && n.log !== "none") || n.tried || n.untimed != null;
  };
  const unknownNight = (k: string) => info(k).log === "none" && !knownNight(k);

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
  const longTurn = (s: HoldingShift) => turnEnd(s) - ms(s.started_at) > LONG_TURN_MIN * MIN;
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
    hint.longTurns = [...long.values()].sort((x, y) => ms(x.started_at) - ms(y.started_at)).map((s) => ({ member: s.holder, start: s.started_at, end: s.ended_at }));
    return hint;
  });

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
    parts.push(`a holding turn over 4 hours (${name(l.member)}'s, from ${formatTime(l.start, tz)}${l.end ? ` to ${formatTime(l.end, tz)}` : ", still open"}) is left out: it may have been left open`);
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
  const label = (w: GoalWeek) => (w.current ? "This week" : w === prev && cur?.current ? "Last week" : `Week ${w.n}${p.weeksTotal ? ` of ${p.weeksTotal}` : ""}`);
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
            return `${label(w)}: ${againstAim(x.counted, tp.target.per_week)} (${apart}tries logged on ${x.tried} of ${plural(x.nights, "night")}${w.current ? " so far" : ""}).`;
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
              : `${label(w)}: no bassinet stretches logged${w.current ? " yet" : ""}.`;
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
            const soFar = w.current ? " so far" : "";
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
  }
  if (goal.roster.length) {
    lines.push(`Roster: ${goal.roster.map((w) => windowWords(w, name)).join("; ")}.`);
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
  return `Focus: ${who} logged a feed inside ${who}'s window (${windowTimes(w)}) on ${best.ownFeedNights} of the ${plural(best.loggedNights, "night")} anything was logged inside it, ${a === b ? `at ${a}` : `${a}–${b}`}. One step to talk over: start ${who}'s window after that feed, or have ${other ? words.name(other) : "someone else"} settle ${baby} then. Bottles or pumping only as a question for their pediatrician or lactation consultant.`;
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
  }
  const focus = open ? focusNote(goal, p, words) : null;
  if (focus) notes.push(focus);
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

/** A goal's roster in one line: "Sam: 10:00 PM–2:00 AM, Sun–Thu nights; Alex: …". */
export const rosterWords = (roster: readonly RosterWindow[], name: (id: string) => string) => roster.map((w) => windowWords(w, name)).join("; ");

/** A goal's targets in one line, for a read-back. */
export const targetsWords = (targets: readonly GoalTarget[], name: (id: string) => string) => targets.map((t) => targetWords(t, name)).join("; ");

/** The evenings a window is on, for a read-back: "Sun–Thu nights". */
export const windowNights = (w: Pick<RosterWindow, "nights">) => nightsLabel(w.nights);

import type { UIMessage } from "ai";
import { zonedTimeToUtc } from "../time";

/**
 * Onboarding's spine (docs/multi-family-plan.md 4.2), shared by the server,
 * the chat's tools and the form: the steps in order, which ones block "Start
 * logging", and one validator per step that turns an answer into the exact
 * value written to its column. No server imports: the app bundles this file.
 */

export const STEPS = ["welcome", "you", "timezone", "baby_name", "birth", "sex", "feeding", "invites", "care", "pediatrician", "notifications"] as const;
export type StepId = (typeof STEPS)[number];

/** Without these the app can't count days or say "today", so "Start logging" waits for them. */
export const REQUIRED: readonly StepId[] = ["welcome", "you", "timezone", "birth"];

export const isStep = (v: unknown): v is StepId => typeof v === "string" && (STEPS as readonly string[]).includes(v);
export const skippable = (step: StepId) => !REQUIRED.includes(step);

export type Progress = "answered" | "skipped";

export const ROLE_WORDS = ["Mom", "Dad", "Mama", "Papa", "Parent"] as const;
export const UNITS = ["us", "metric"] as const;
export type Units = (typeof UNITS)[number];

export type Answer = {
  welcome: { adult: true; terms: true };
  you: { name: string; role_word: string | null };
  timezone: { timezone: string; units: Units };
  baby_name: { name: string | null; nickname: string | null };
  birth: { born: true; date: string; time: string | null } | { born: false; due: string };
  sex: { sex: "female" | "male" | null };
  feeding: { nursing: boolean; pumping: boolean; formula: boolean };
  invites: { people: { name: string; role: "member" | "viewer" }[] };
  care: { choice: "me"; consent: true } | { choice: "later" } | { choice: "no" };
  pediatrician: { name: string | null; phone: string | null; after_hours: string | null };
  notifications: { on: boolean };
};

export class AnswerError extends Error {}

export const MAX_INVITES_AT_ONCE = 6;
/** A family's open invite links at most (docs/multi-family-plan.md 5.2). */
export const MAX_OPEN_INVITES = 10;
export const BABY_DEFAULT_NAME = "Baby";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AnswerError("That answer doesn't fit this question.");
  return raw as Record<string, unknown>;
}

function name(raw: unknown, max: number, label: string): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new AnswerError(`${label} should be text.`);
  const v = raw.replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > max) throw new AnswerError(`${label} is too long (${max} characters at most).`);
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(v)) throw new AnswerError(`${label} can only have letters, spaces, hyphens and apostrophes.`);
  return v;
}

/** A person's or baby's name as onboarding takes it (letters, spaces, hyphens, apostrophes and dots), or null when blank. */
export const parseName = name;

/** A practice's name can carry digits and "&" ("Northside Pediatrics & Family Care"). */
function practice(raw: unknown, label: string): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new AnswerError(`${label} should be text.`);
  const v = raw.replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > 80) throw new AnswerError(`${label} is too long (80 characters at most).`);
  if (!/^[\p{L}\p{M}\d][\p{L}\p{M}\d .,'’&()/-]*$/u.test(v)) throw new AnswerError(`${label} has characters that don't belong in a name.`);
  return v;
}

function phone(raw: unknown, label: string): string | null {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") throw new AnswerError(`${label} should be a phone number.`);
  const v = raw.trim();
  const digits = v.replace(/\D/g, "").length;
  if (v.length > 30 || !/^[+()\d][\d\s().+-]*$/.test(v) || digits < 3 || digits > 15) throw new AnswerError(`${label} doesn't look like a phone number.`);
  return v;
}

function day(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !DAY_RE.test(raw)) throw new AnswerError(`${label} should be a date.`);
  const [y, m, d] = raw.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new AnswerError(`${label} isn't a real date.`);
  return raw;
}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const bool = (v: unknown) => v === true;

export function parseAnswer<S extends StepId>(step: S, raw: unknown): Answer[S] {
  const o = obj(raw);
  switch (step) {
    case "welcome": {
      if (o.adult !== true) throw new AnswerError("Maple is for people 18 and over.");
      if (o.terms !== true) throw new AnswerError("Accept the terms to go on.");
      return { adult: true, terms: true } as Answer[S];
    }
    case "you": {
      const n = name(o.name, 40, "Your name");
      if (!n) throw new AnswerError("Your first name, please.");
      const word = o.role_word == null || o.role_word === "" ? null : name(o.role_word, 20, "What the baby calls you");
      return { name: n, role_word: word } as Answer[S];
    }
    case "timezone": {
      if (!validTimezone(o.timezone)) throw new AnswerError("Pick a timezone from the list.");
      const units = o.units ?? "us";
      if (units !== "us" && units !== "metric") throw new AnswerError("Units are US or metric.");
      return { timezone: o.timezone, units } as Answer[S];
    }
    case "baby_name": {
      return { name: name(o.name, 80, "The baby's name"), nickname: name(o.nickname, 40, "The nickname") } as Answer[S];
    }
    case "birth": {
      if (o.born === true) {
        const time = o.time == null || o.time === "" ? null : o.time;
        if (time !== null && (typeof time !== "string" || !TIME_RE.test(time))) throw new AnswerError("The birth time should be a time of day.");
        return { born: true, date: day(o.date, "The birth date"), time } as Answer[S];
      }
      if (o.born === false) return { born: false, due: day(o.due, "The due date") } as Answer[S];
      throw new AnswerError("Is the baby here yet, or still on the way?");
    }
    case "sex": {
      const sex = o.sex === "female" || o.sex === "male" ? o.sex : o.sex == null ? null : undefined;
      if (sex === undefined) throw new AnswerError("Girl, boy, or prefer not to say.");
      return { sex } as Answer[S];
    }
    case "feeding": {
      return { nursing: bool(o.nursing), pumping: bool(o.pumping), formula: bool(o.formula) } as Answer[S];
    }
    case "invites": {
      if (!Array.isArray(o.people) || !o.people.length) throw new AnswerError("Add at least one person, or skip this for now.");
      if (o.people.length > MAX_INVITES_AT_ONCE) throw new AnswerError(`Up to ${MAX_INVITES_AT_ONCE} people at a time.`);
      const people = o.people.map((p) => {
        const r = obj(p);
        const n = name(r.name, 40, "Their name");
        if (!n) throw new AnswerError("Each invite needs a name.");
        if (r.role !== "member" && r.role !== "viewer") throw new AnswerError("Each person can log, or view only.");
        return { name: n, role: r.role };
      });
      return { people } as Answer[S];
    }
    case "care": {
      if (o.choice === "me") {
        if (o.consent !== true) throw new AnswerError("Your page starts only once you agree to it yourself.");
        return { choice: "me", consent: true } as Answer[S];
      }
      if (o.choice === "later" || o.choice === "no") return { choice: o.choice } as Answer[S];
      throw new AnswerError("Yes for you, later for someone else, or not now.");
    }
    case "pediatrician": {
      const v = { name: practice(o.name, "The pediatrician's name"), phone: phone(o.phone, "The pediatrician's number"), after_hours: phone(o.after_hours, "The after-hours number") };
      if (!v.name && !v.phone && !v.after_hours) throw new AnswerError("Add a name or a number, or skip this for now.");
      return v as Answer[S];
    }
    case "notifications": {
      return { on: o.on === true } as Answer[S];
    }
  }
  throw new AnswerError("That isn't one of the questions.");
}

export function birthInstant(a: { date: string; time: string | null }, tz: string): Date {
  const [y, m, d] = a.date.split("-").map(Number);
  const [hh, mm] = (a.time ?? "00:00").split(":").map(Number);
  return zonedTimeToUtc(y, m, d, hh, mm, tz);
}

export function birthProblem(a: Answer["birth"], tz: string, now: Date): string | null {
  const DAY = 86_400_000;
  if (a.born) {
    const at = birthInstant(a, tz).getTime();
    if (at > now.getTime() + 10 * 60_000) return "That birth time is in the future.";
    if (at < now.getTime() - 730 * DAY) return "Maple is for babies under two.";
    return null;
  }
  const due = Date.parse(`${a.due}T12:00:00Z`);
  if (due < now.getTime() - 60 * DAY) return "That due date has passed. If the baby is here, say when they were born.";
  if (due > now.getTime() + 300 * DAY) return "That due date is more than ten months away.";
  return null;
}

export type OnboardingView = {
  familyId: number;
  status: "onboarding" | "active" | "deleting";
  owner: boolean;
  done: Partial<Record<StepId, Progress>>;
  /** Where someone who left comes back. */
  next: StepId | null;
  canFinish: boolean;
  missing: StepId[];
  values: {
    you: { name: string | null; role_word: string | null };
    timezone: { timezone: string; units: Units };
    baby: { name: string | null; nickname: string | null; sex: "female" | "male" | null; born_at: string | null; due_date: string | null; birth_time_known: boolean } | null;
    feeding: { nursing: boolean; pumping: boolean; formula: boolean } | null;
    invites: number;
    care: "me" | "later" | "no" | null;
    pediatrician: { name: string | null; phone: string | null; after_hours: string | null } | null;
    notifications: boolean | null;
  };
  modelSteps: number;
};

/** One onboarding's model steps at most (plan 4.2); past it the form carries on. */
export const ONBOARDING_MODEL_STEPS = 40;

export function nextStep(done: Partial<Record<StepId, Progress>>): StepId | null {
  return STEPS.find((s) => !done[s]) ?? null;
}

export function missingSteps(done: Partial<Record<StepId, Progress>>): StepId[] {
  return REQUIRED.filter((s) => done[s] !== "answered");
}

export const STEP_TITLES: Record<StepId, string> = {
  welcome: "Terms",
  you: "You",
  timezone: "Timezone and units",
  baby_name: "Baby's name",
  birth: "Birth or due date",
  sex: "Sex, for growth charts",
  feeding: "Feeding",
  invites: "Who else joins",
  care: "A recovery page for the birth parent",
  pediatrician: "Pediatrician",
  notifications: "Notifications",
};

/** A chat tool's result as the screen reads it: a value to confirm with a tap (nothing is saved from the model's word), or why it didn't fit. */
export type Proposal =
  | { ok: true; kind: "answer"; step: StepId; value: unknown; text: string }
  | { ok: true; kind: "skip"; step: StepId; text: string }
  | { ok: true; kind: "finish"; text: string }
  | { ok: true; kind: "help"; text: string }
  | { ok: false; text: string };

/** Model steps one onboarding message may take: a proposal and the line around it. */
export const ONBOARDING_STEPS_PER_MESSAGE = 3;
export const ONBOARDING_MAX_OUTPUT_TOKENS = 600;
export const ONBOARDING_HISTORY = 12;

export type OnboardingMessage = UIMessage<unknown, { help: { reason: "crisis" | "refusal" } }>;

/** "form", "off" and "limit" carry on with the form. */
export type OnboardingRefusal = { error: string; code?: "terms" | "limit" | "off" | "form" | "done"; help?: "crisis" };

/**
 * Validation for entry payloads, shared by the REST routes and the MCP tools.
 * Unknown keys are stripped; ranges are generous but keep typos (a 70 lb
 * newborn, a 140°F fever) out of the log.
 */
import { z } from "zod";
import { ACETAMINOPHEN_NAMES, MOOD_TAGS, type MoodTag } from "./guidelines";
import {
  DIAPER_SIZES,
  ENTRY_KINDS,
  JAUNDICE_LEVELS,
  NOTE_TAGS,
  SLEEP_PLACES,
  STOOL_COLORS,
  STOOL_TEXTURES,
  TEMP_METHODS,
  type CareDataByKind,
  type CareKind,
  type EntryDataByKind,
  type EntryKind,
  type LimitUnit,
  type MedReason,
  type MedSchedule,
  type MoodDataByKind,
  type MoodKind,
} from "./types";

const iso = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO timestamp" });

const side = z.enum(["L", "R"]);
/** A stretch's side: Left, Right, or "B" (back and forth: both sides, not tracked). first_side/last_side stay L/R. */
const stretchSide = z.enum(["L", "R", "B"]);

const segment = z.object({ side: stretchSide, start: iso, end: iso.nullable() });

const optNum = (min: number, max: number, label: string) =>
  z
    .number({ invalid_type_error: `${label} must be a number` })
    .finite()
    .min(min, `${label} looks too small`)
    .max(max, `${label} looks too large`)
    .optional();

/** Blob URLs we issued for Maple uploads (keeps the photo proxy from fetching anything else). */
export const MAPLE_BLOB_RE =
  /^https:\/\/[A-Za-z0-9]+\.(?:public|private)\.blob\.vercel-storage\.com\/maple\/[A-Za-z0-9._\-/]+$/;

const photo = z.object({
  key: z.string().regex(MAPLE_BLOB_RE, "photo must be a Maple upload"),
  thumb_key: z.string().regex(MAPLE_BLOB_RE, "thumb must be a Maple upload").optional(),
  w: z.number().int().min(1).max(20000).optional(),
  h: z.number().int().min(1).max(20000).optional(),
  access: z.enum(["public", "private"]).optional(),
});

export const dataSchemas = {
  feed: z
    .object({
      method: z.enum(["breast", "bottle"]),
      segments: z.array(segment).max(60).optional(),
      left_sec: optNum(0, 4 * 3600, "Left side time"),
      right_sec: optNum(0, 4 * 3600, "Right side time"),
      // Back and forth gets no taps by design, so allow a long one (a forgotten timer must still stop).
      both_sec: optNum(0, 12 * 3600, "Back and forth time"),
      first_side: side.optional(),
      last_side: side.optional(),
      amount_ml: optNum(0, 500, "Bottle amount"),
      milk: z.enum(["breastmilk", "formula", "mixed"]).optional(),
      // Listed so .strip() keeps it: a stopped-while-paused feed must stay one through later edits.
      paused_at_stop: z.boolean().optional(),
      stopped_at: iso.optional(),
      // The latest switch / resume / pause (feed.ts LastTap), so undo takes back that tap and not an older one.
      last_tap: z
        .object({
          kind: z.enum(["switch", "resume", "pause"]),
          side: stretchSide,
          at: iso,
          // A switch that changed the open part's side (going back and forth from a fresh part): undo puts this back.
          from: stretchSide.optional(),
          paused_at: iso.optional(),
          merged: z.literal(true).optional(),
          reverted: z.literal(true).optional(),
          undone: z.literal(true).optional(),
          carried: z.literal(true).optional(),
          by: z.string().max(320).optional(),
        })
        .strip()
        .optional(),
    })
    .strip(),
  pump: z
    .object({
      left_ml: optNum(0, 600, "Left amount"),
      right_ml: optNum(0, 600, "Right amount"),
      total_ml: optNum(0, 1200, "Total amount"),
    })
    .strip(),
  diaper: z
    .object({
      pee: z.boolean().default(false),
      poop: z.boolean().default(false),
      color: z.enum(STOOL_COLORS).optional(),
      texture: z.enum(STOOL_TEXTURES).optional(),
      size: z.enum(DIAPER_SIZES).optional(),
      rash: z.boolean().optional(),
    })
    .strip(),
  sleep: z.object({ place: z.enum(SLEEP_PLACES).optional() }).strip(),
  growth: z
    .object({
      weight_g: optNum(500, 30000, "Weight"),
      length_cm: optNum(25, 130, "Length"),
      head_cm: optNum(20, 60, "Head circumference"),
      at: z.enum(["home", "doctor"]).optional(),
    })
    .strip()
    .refine((d) => d.weight_g != null || d.length_cm != null || d.head_cm != null, {
      message: "Add a weight, length, or head measurement",
    }),
  temp: z
    .object({
      temp_c: z.number().finite().min(30, "Temperature looks too low").max(45, "Temperature looks too high"),
      method: z.enum(TEMP_METHODS).optional(),
    })
    .strip(),
  vitals: z
    .object({
      heart_bpm: optNum(30, 260, "Heart rate"),
      resp_rate: optNum(5, 150, "Breathing rate"),
      spo2: optNum(50, 100, "Oxygen saturation"),
      jaundice: z.enum(JAUNDICE_LEVELS).optional(),
    })
    .strip()
    .refine((d) => d.heart_bpm != null || d.resp_rate != null || d.spo2 != null || d.jaundice != null, {
      message: "Add a heart rate, breathing rate, oxygen reading, or skin check",
    }),
  med: z
    .object({
      name: z.string().trim().min(1, "Medicine name is required").max(80),
      dose: z.string().trim().max(80).optional(),
    })
    .strip(),
  tummy: z.object({}).strip(),
  bath: z.object({}).strip(),
  moment: z
    .object({
      title: z.string().trim().max(120).optional(),
      milestone: z.string().trim().max(60).optional(),
      photos: z.array(photo).max(12).optional(),
    })
    .strip(),
  note: z
    .object({
      tag: z.enum(NOTE_TAGS).optional(),
      amount: z.enum(["little", "some", "lots"]).optional(),
      for_doctor: z.boolean().optional(),
      done: z.boolean().optional(),
      answer: z.string().trim().max(1000).optional(),
    })
    .strip(),
} satisfies Record<EntryKind, z.ZodTypeAny>;

export const kindSchema = z.enum(ENTRY_KINDS);

export const noteSchema = z.string().max(2000).nullable().optional();

export function isEntryKind(k: unknown): k is EntryKind {
  return typeof k === "string" && (ENTRY_KINDS as readonly string[]).includes(k);
}

/** Validate and clean `data` for a kind. Throws an Error with a readable message. */
export function cleanData<K extends EntryKind>(kind: K, data: unknown): EntryDataByKind[K] {
  const result = dataSchemas[kind].safeParse(data ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    throw new Error(`${where}${first?.message ?? "invalid data"}`);
  }
  return result.data as EntryDataByKind[K];
}

/** Validate an ISO timestamp from a client; returns a Date or throws. */
export function cleanInstant(value: unknown, label: string): Date {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(value);
}

// ── For mom (maple_care_*): plans, entries, check-ins, settings, sharing ──
// Every number here is checked, never filled in: a field she leaves blank
// stays null. Messages are the plan sheet's own (§11.3), so the sheet can
// show what the server says.

const LIMIT_UNITS = ["tablets", "caplets", "capsules", "doses", "mL"] as const;
const MED_REASONS = ["pain", "constipation", "bp", "iron", "infection", "mood", "vitamin", "other"] as const;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A plan's columns as stored (care-store writes exactly these). */
export type PlanFields = {
  name: string;
  also_called: string | null;
  dose_text: string | null;
  units_per_dose: string | null;
  schedule: MedSchedule;
  max_24h: number | null;
  limit_unit: LimitUnit | null;
  label_text: string | null;
  reason: MedReason | null;
  contains_apap: boolean;
  instructions: string | null;
  course_start: string | null;
  course_end: string | null;
  show_on_today: boolean;
  private: boolean;
  sort: number;
};

/** Trimmed text or null; too long throws with the field's name. */
function text(v: unknown, max: number, label: string): string | null {
  if (v == null) return null;
  if (typeof v !== "string") throw new Error(`${label} must be text`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${label} is too long (at most ${max} characters).`);
  return t || null;
}

const HOURS_MSG = "Enter hours between ¼ and 72.";
function gapMin(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n < 15 || n > 4320) throw new Error(HOURS_MSG);
  return Math.round(n);
}

/** How often. Nothing said (or the number left out) saves as As needed with no gap, never a made-up number. */
function cleanSchedule(raw: unknown): MedSchedule {
  const s = (raw ?? {}) as Record<string, unknown>;
  const loose: MedSchedule = { type: "as_needed", min_gap_min: null };
  switch (s.type) {
    case "as_needed":
      return { type: "as_needed", min_gap_min: s.min_gap_min == null ? null : gapMin(s.min_gap_min) };
    case "every":
      if (s.every_min == null) return loose;
      return { type: "every", every_min: gapMin(s.every_min) };
    case "daily": {
      if (s.per_day == null) return loose;
      const n = s.per_day;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 8) throw new Error("Enter how many times a day: a whole number from 1 to 8.");
      return { type: "daily", per_day: n };
    }
    case "times": {
      const list = Array.isArray(s.times) ? s.times : [];
      if (!list.length) return loose;
      if (list.length > 8) throw new Error("Add at most 8 times.");
      const times = [...new Set(list.map((x) => String(x).trim()))].sort();
      for (const t of times) if (!HHMM_RE.test(t)) throw new Error("Enter each time as HH:MM.");
      return { type: "times", times };
    }
    default:
      return loose;
  }
}

const LIMIT_NUMBER_MSG = "Enter the number from the label: a whole number for tablets, caplets, capsules or doses.";
const LIMIT_UNIT_MSG = "Choose what the label counts: tablets, caplets, capsules, doses or mL.";

/**
 * Validate a whole plan (a new one, or an existing one with a patch merged
 * over it). `creating` applies the create-only defaults: "Contains
 * acetaminophen" from the names (and the stored, unread Show on Today).
 * Whether it starts as Only me is the caller's call (it depends on who's
 * adding it); `private` is taken as given here.
 */
export function cleanPlan(input: Record<string, unknown>, opts: { creating: boolean; parseUnits: (t: string | null) => { fixed?: number } }): PlanFields {
  const name = text(input.name, 80, "Name");
  if (!name) throw new Error("Add the medicine's name.");
  const schedule = cleanSchedule(input.schedule);

  let max: number | null = null;
  let unit: LimitUnit | null = null;
  if (input.limit_unit != null) {
    if (!(LIMIT_UNITS as readonly unknown[]).includes(input.limit_unit)) throw new Error(LIMIT_UNIT_MSG);
    unit = input.limit_unit as LimitUnit;
  }
  if (input.max_24h != null && input.max_24h !== "") {
    const n = typeof input.max_24h === "number" ? input.max_24h : Number.NaN;
    if (!unit) throw new Error(LIMIT_UNIT_MSG);
    const okCount = Number.isInteger(n) && n >= 1 && n <= 48;
    const okMl = Number.isFinite(n) && n >= 0.5 && n <= 1000;
    if (unit === "mL" ? !okMl : !okCount) throw new Error(LIMIT_NUMBER_MSG);
    max = n;
  }

  const unitsPerDose = text(input.units_per_dose, 20, "How many each time");
  if (unitsPerDose && max != null && unit !== "doses") {
    const fixed = opts.parseUnits(unitsPerDose).fixed;
    if (fixed != null && fixed > max) throw new Error("That's more each time than the 24-hour limit. Check both against the label.");
  }

  const day = (v: unknown, label: string): string | null => {
    if (v == null || v === "") return null;
    if (typeof v !== "string" || !DAY_RE.test(v) || Number.isNaN(Date.parse(`${v}T12:00:00Z`))) throw new Error(`${label} must be a date (YYYY-MM-DD)`);
    return v;
  };
  const courseStart = day(input.course_start, "Start");
  const courseEnd = day(input.course_end, "End date");
  if (courseStart && courseEnd && courseEnd < courseStart) throw new Error("The end date is before the start.");

  let reason: MedReason | null = null;
  if (input.reason != null) {
    if (!(MED_REASONS as readonly unknown[]).includes(input.reason)) throw new Error("Choose what it's for from the list.");
    reason = input.reason as MedReason;
  }

  // "Only me" is gone: nothing is saved hidden, whatever a caller sends.
  const priv = false;
  const alsoCalled = text(input.also_called, 80, "Also called");
  const containsApap =
    typeof input.contains_apap === "boolean"
      ? input.contains_apap
      : opts.creating && [name, ...(alsoCalled ?? "").split(",")].some((n) => ACETAMINOPHEN_NAMES.test(n));
  // Show on Today: still accepted and stored (older app versions and Claude chats send it), but nothing reads it any
  // more: one rule picks her line on Today, the Lantern and maple_status (care.ts pressingPlan).
  const showOnToday =
    typeof input.show_on_today === "boolean" ? input.show_on_today : schedule.type === "as_needed" || schedule.type === "every";

  const sort = typeof input.sort === "number" && Number.isInteger(input.sort) ? Math.max(-1e6, Math.min(1e6, input.sort)) : 0;

  return {
    name,
    also_called: alsoCalled,
    dose_text: text(input.dose_text, 80, "Dose as prescribed"),
    units_per_dose: unitsPerDose,
    schedule,
    max_24h: max,
    limit_unit: unit,
    label_text: text(input.label_text, 120, "The label's words"),
    reason,
    contains_apap: containsApap,
    instructions: text(input.instructions, 120, "Instructions"),
    course_start: courseStart,
    course_end: courseEnd,
    show_on_today: showOnToday,
    private: priv,
    sort,
  };
}

/** A dose's units: above 0, at most 1000 (half a tablet is fine). */
export function cleanUnits(v: unknown, unit: LimitUnit | null): number | null {
  void unit;
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number.NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error("Enter how many this time.");
  return Math.round(n * 100) / 100;
}

/** Validate a care entry's data (kind by kind). Unknown keys are dropped. */
export function cleanCareData<K extends CareKind>(kind: K, data: unknown, opts: { unit?: LimitUnit | null } = {}): CareDataByKind[K] {
  const d = (data ?? {}) as Record<string, unknown>;
  if (kind === "dose") {
    const name = text(d.name, 80, "Name");
    if (!name) throw new Error("Add the medicine's name.");
    const unit = opts.unit !== undefined ? opts.unit : d.unit != null && (LIMIT_UNITS as readonly unknown[]).includes(d.unit) ? (d.unit as LimitUnit) : null;
    const out: CareDataByKind["dose"] = { name, dose: text(d.dose, 80, "Dose"), units: cleanUnits(d.units, unit), unit };
    if (d.skipped === true) out.skipped = true;
    return out as CareDataByKind[K];
  }
  if (kind === "temp") {
    const c = d.temp_c;
    if (typeof c !== "number" || !Number.isFinite(c)) throw new Error("Temperature must be a number");
    if (c < 30) throw new Error("Temperature looks too low");
    if (c > 45) throw new Error("Temperature looks too high");
    return { temp_c: Math.round(c * 100) / 100 } as CareDataByKind[K];
  }
  if (kind === "question") {
    const out: CareDataByKind["question"] = {};
    if (typeof d.done === "boolean") out.done = d.done;
    if (d.answer !== undefined) out.answer = clipped(d.answer);
    return out as CareDataByKind[K];
  }
  throw new Error("Unknown kind");
}

export function isCareKind(k: unknown): k is CareKind {
  return k === "dose" || k === "temp" || k === "question";
}

/** Trimmed text cut to 2000 characters, like a note in Maple's log. */
function clipped(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.trim().slice(0, 2000) || null;
}

/** A care entry's note (a question's text lives here), cut to 2000 characters like Maple's notes. */
export function cleanCareNote(v: unknown): string | null {
  return clipped(v);
}

const ANSWER = (v: unknown, label: string): 0 | 1 | 2 | 3 => {
  if (v !== 0 && v !== 1 && v !== 2 && v !== 3) throw new Error(`${label}: answers are 0 to 3`);
  return v;
};

/**
 * Validate a check-in or a fuller check-in. A screen's scores are worked out
 * again here from the answers (scoreScreen), never taken from the client.
 */
export function cleanMoodData<K extends MoodKind>(
  kind: K,
  data: unknown,
  score: (a: { phq9: (0 | 1 | 2 | 3)[]; gad7: (0 | 1 | 2 | 3)[]; difficulty?: 0 | 1 | 2 | 3 | null; item9_ever: boolean }) => MoodDataByKind["screen"]
): MoodDataByKind[K] {
  const d = (data ?? {}) as Record<string, unknown>;
  if (kind === "checkin") {
    const level = d.level;
    if (level !== 1 && level !== 2 && level !== 3 && level !== 4 && level !== 5) throw new Error("Pick how you're doing");
    const tags = Array.isArray(d.tags) ? [...new Set(d.tags.filter((t): t is MoodTag => typeof t === "string" && t in MOOD_TAGS))] : undefined;
    const harmEver = d.harm_ever === true || !!tags?.includes("harm_self");
    return { level, ...(tags ? { tags } : {}), ...(harmEver ? { harm_ever: true } : {}) } as MoodDataByKind[K];
  }
  if (kind === "screen") {
    const phq9 = Array.isArray(d.phq9) ? d.phq9.map((v, i) => ANSWER(v, `PHQ-9 question ${i + 1}`)) : [];
    const gad7 = Array.isArray(d.gad7) ? d.gad7.map((v, i) => ANSWER(v, `GAD-7 question ${i + 1}`)) : [];
    if (phq9.length > 9 || gad7.length > 7) throw new Error("Too many answers");
    if (d.complete === true && (phq9.length !== 9 || gad7.length !== 7)) throw new Error("A finished check-in has 9 and 7 answers");
    if (gad7.length && phq9.length !== 9) throw new Error("Answer the PHQ-9 first");
    const difficulty = d.difficulty == null ? null : ANSWER(d.difficulty, "Difficulty");
    return score({ phq9, gad7, difficulty, item9_ever: d.item9_ever === true }) as MoodDataByKind[K];
  }
  throw new Error("Unknown kind");
}

export function isMoodKind(k: unknown): k is MoodKind {
  return k === "checkin" || k === "screen";
}

const PHONE_MAX = 30;
const ACK_KEY_RE = /^[a-z]+:[A-Za-z0-9:,._-]{1,80}$/;

/** A setting only she may change, sent by someone else (the routes answer 403). */
export class OnlyHers extends Error {}

/**
 * A settings patch (§11.3). Nulls remove a key. `self`: her own session,
 * which alone may set the therapist, check-in suggestions and the sharing
 * banner; anyone else sending those is refused (OnlyHers) rather than ignored.
 */
export function cleanCareSettings(raw: unknown, opts: { self: boolean; name?: string }): { settings: Record<string, unknown>; acks: Record<string, string> | null } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("settings must be an object");
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const hersOnly = (key: string) => {
    if (!opts.self) throw new OnlyHers(`Only ${opts.name ?? "she"} can change ${key}.`);
  };
  if ("care_team" in r) {
    const ct = r.care_team;
    if (ct === null) out.care_team = null;
    else {
      if (typeof ct !== "object" || Array.isArray(ct)) throw new Error("care_team must be an object");
      const team: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(ct as Record<string, unknown>)) {
        if (!["ob", "after_hours", "pharmacy", "therapist"].includes(k)) continue;
        if (k === "therapist") hersOnly("the therapist's number");
        team[k] = text(v, PHONE_MAX, "Phone number");
      }
      out.care_team = team;
    }
  }
  if ("feeding" in r) {
    if (r.feeding !== null && r.feeding !== "yes" && r.feeding !== "no") throw new Error("feeding must be yes, no or null");
    out.feeding = r.feeding;
  }
  if ("next_visit" in r) {
    const v = r.next_visit;
    if (v !== null && (typeof v !== "string" || !DAY_RE.test(v))) throw new Error("Next OB visit must be a date (YYYY-MM-DD)");
    out.next_visit = v;
  }
  if ("checkin_suggestions" in r) {
    hersOnly("check-in suggestions");
    if (typeof r.checkin_suggestions !== "boolean") throw new Error("checkin_suggestions must be true or false");
    out.checkin_suggestions = r.checkin_suggestions;
  }
  if ("sharing_seen_at" in r) {
    hersOnly("that");
    const v = r.sharing_seen_at;
    if (v !== null && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) throw new Error("sharing_seen_at must be an ISO timestamp");
    out.sharing_seen_at = v;
  }
  let acks: Record<string, string> | null = null;
  if ("acks" in r && r.acks != null) {
    if (typeof r.acks !== "object" || Array.isArray(r.acks)) throw new Error("acks must be an object");
    acks = {};
    for (const [k, v] of Object.entries(r.acks as Record<string, unknown>)) {
      if (!ACK_KEY_RE.test(k)) throw new Error("Unknown note");
      // Check-in suggestion acks are about her check-ins: hers only.
      if (k.startsWith("suggest:")) hersOnly("check-in suggestions");
      acks[k] = typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : new Date().toISOString();
    }
  }
  return { settings: out, acks };
}

// ── Maple's log settings (maple_babies.settings) ─────────────────────────

/**
 * The log-wide switches in Family → On Today: "feeds_bottle" (Bottles: the
 * dock's Bottle tile) and "track_pump" (Pumping: Pump in More). Both read as
 * on unless set to false (the client reads them through MoreSheet's
 * logSwitches), so a new log has them; switching one off hides buttons only,
 * never anything logged, and Claude and Siri log either regardless.
 */
export const LOG_SWITCH_KEYS = ["feeds_bottle", "track_pump"] as const;

/** A settings patch's log switches: true, false, or null (back to the default, on). Throws on anything else. */
export function checkLogSwitches(patch: Record<string, unknown>): void {
  for (const k of LOG_SWITCH_KEYS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v !== null && typeof v !== "boolean") throw new Error(`${k} must be true or false`);
  }
}

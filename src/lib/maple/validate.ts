/**
 * Validation for entry payloads, shared by the REST routes and the MCP tools.
 * Unknown keys are stripped; ranges are generous but keep typos (a 70 lb
 * newborn, a 140°F fever) out of the log.
 */
import { z } from "zod";
import {
  DIAPER_SIZES,
  ENTRY_KINDS,
  JAUNDICE_LEVELS,
  NOTE_TAGS,
  SLEEP_PLACES,
  STOOL_COLORS,
  STOOL_TEXTURES,
  TEMP_METHODS,
  type EntryDataByKind,
  type EntryKind,
} from "./types";

const iso = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO timestamp" });

const side = z.enum(["L", "R"]);

const segment = z.object({ side, start: iso, end: iso.nullable() });

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
          side,
          at: iso,
          paused_at: iso.optional(),
          merged: z.literal(true).optional(),
          reverted: z.literal(true).optional(),
          undone: z.literal(true).optional(),
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

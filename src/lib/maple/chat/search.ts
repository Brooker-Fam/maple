import { z } from "zod";
import { isDayKey } from "../time";
import { ENTRY_KINDS } from "../types";

export const SEARCH_PAGE_SIZE = 10;
export const SEARCH_MAX_PAGE_SIZE = 20;
export const SEARCH_MAX_DAYS = 366;

const realDay = (value: string) => {
  if (!isDayKey(value) || value < "1900-01-01") return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const date = z.string().refine(realDay, "Use a real local date like 2026-10-20");
const instant = z.string().datetime({ offset: true }).refine((value) => realDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value)), "Use a real timestamp");
export const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(120).optional().describe("Exact words to find in baby notes, moment titles, medicine names or note tags; case insensitive. Leave out to list entries."),
  kind: z.enum(ENTRY_KINDS).optional(),
  from: date.optional().describe("First local day, inclusive. Defaults to the last year."),
  to: date.optional().describe("Last local day, inclusive. Defaults to today; never a future day."),
  after: instant.optional().describe("Optional exact earliest time, with a timezone offset, within the selected days."),
  before: instant.optional().describe("Optional exact latest time, exclusive, with a timezone offset, within the selected days."),
  doctorQuestions: z.boolean().optional().describe("Only the baby's questions for the pediatrician, open by default."),
  includeAnswered: z.boolean().optional().describe("For doctorQuestions only: also include questions marked asked."),
  limit: z.number().int().min(1).max(SEARCH_MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).max(3000).optional().describe("Use the nextCursor from an earlier search to continue exactly that search; omit other fields."),
}).strict();
export type ChatSearchInput = z.infer<typeof searchInputSchema>;

export const searchCriteriaSchema = z.object({
  query: z.string().max(120), kind: z.enum(ENTRY_KINDS).nullable(),
  from: date, to: date, after: instant.nullable(), before: instant.nullable(),
  doctorQuestions: z.boolean(), includeAnswered: z.boolean(),
  limit: z.number().int().min(1).max(SEARCH_MAX_PAGE_SIZE),
}).strict();
export type ChatSearchCriteria = z.infer<typeof searchCriteriaSchema>;

export const searchEntrySchema = z.object({
  id: z.number().int().positive().safe(), kind: z.enum(ENTRY_KINDS),
  startedAt: instant, summary: z.string().max(500),
  question: z.boolean(), done: z.boolean(),
}).strict();
export type ChatSearchEntry = z.infer<typeof searchEntrySchema>;

export const chatEntryResultsSchema = z.object({
  version: z.literal(1), asOf: instant,
  timezone: z.string().max(64).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }, "Invalid timezone"),
  criteria: searchCriteriaSchema,
  entries: z.array(searchEntrySchema).max(SEARCH_MAX_PAGE_SIZE),
  nextCursor: z.string().max(3000).nullable(),
}).strict();
export type ChatEntryResults = z.infer<typeof chatEntryResultsSchema>;

export function parseEntryResults(value: unknown): ChatEntryResults | null {
  const parsed = chatEntryResultsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

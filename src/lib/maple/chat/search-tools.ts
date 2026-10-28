import { tool, zodSchema } from "ai";
import { z } from "zod";
import { query } from "@/lib/db";
import { encryptSecret, openSecret } from "@/lib/secret-box";
import { describeEntry } from "../describe";
import { milestoneWordsOf } from "../milestones";
import { context, type Ctx, type Extra } from "../mcp-tools";
import { rowToEntry, StoreUnavailable } from "../store";
import { addDays, dayBounds, dayKey, daysBetween } from "../time";
import { chatEntryResultsSchema, searchCriteriaSchema, searchInputSchema, SEARCH_MAX_DAYS, SEARCH_PAGE_SIZE, type ChatEntryResults, type ChatSearchCriteria, type ChatSearchInput } from "./search";

type SearchContext = Pick<Ctx, "fam" | "baby" | "tz" | "now">;
const cursorSchema = z.object({
  purpose: z.literal("chat-search"), version: z.literal(1), family: z.number().int().positive(), baby: z.number().int().positive(),
  criteria: searchCriteriaSchema, asOf: z.string().datetime({ offset: true }),
  at: z.string().datetime({ offset: true }), id: z.number().int().positive().safe(),
}).strict();
type Cursor = z.infer<typeof cursorSchema>;
export class ChatSearchError extends Error {}

function decodeCursor(raw: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const opened = openSecret(Buffer.from(raw, "base64url").toString("utf8"));
    const cursor = cursorSchema.parse(JSON.parse(opened.text));
    if (opened.prev && cursor.family !== 1) throw new Error();
    return cursor;
  } catch { throw new ChatSearchError("That search page is no longer available. Run the search again."); }
}

/** Literal substring matching: '%' and '_' in a note never become wildcard queries. */
export function searchPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

function criteriaFor(input: ChatSearchInput, today: string): ChatSearchCriteria {
  return {
    query: input.query ?? "", kind: input.kind ?? null,
    from: input.from ?? addDays(today, 1 - SEARCH_MAX_DAYS), to: input.to ?? today,
    after: input.after ?? null, before: input.before ?? null,
    doctorQuestions: input.doctorQuestions ?? false, includeAnswered: input.includeAnswered ?? false,
    limit: input.limit ?? SEARCH_PAGE_SIZE,
  };
}

function bounds(criteria: ChatSearchCriteria, ctx: SearchContext, asOf: Date): [Date, Date] {
  const today = dayKey(ctx.now, ctx.tz);
  const span = daysBetween(criteria.from, criteria.to);
  if (span < 0 || span >= SEARCH_MAX_DAYS) throw new ChatSearchError(`Search at most ${SEARCH_MAX_DAYS} local days, with the first day before the last.`);
  if (criteria.to > today) throw new ChatSearchError("Search dates cannot be in the future.");
  if (criteria.doctorQuestions && criteria.kind && criteria.kind !== "note") throw new ChatSearchError("Doctor questions are notes. Choose note or leave the kind empty.");
  const start = dayBounds(criteria.from, ctx.tz)[0];
  const end = dayBounds(criteria.to, ctx.tz)[1];
  const from = criteria.after ? new Date(criteria.after) : start;
  const to = criteria.before ? new Date(criteria.before) : end;
  if (from < start || from >= end || to <= start || to > end || from >= to) throw new ChatSearchError("The exact times must fit inside the selected days, earliest time first.");
  if ((criteria.after && from > ctx.now) || (criteria.before && to > ctx.now)) throw new ChatSearchError("Search times cannot be in the future.");
  return [from, new Date(Math.min(to.getTime(), asOf.getTime() + 1))];
}

/** Every caller supplies a freshly authorized family and its current baby. A sealed cursor preserves criteria, never grants access. */
export async function searchEntries(ctx: SearchContext, raw: ChatSearchInput): Promise<ChatEntryResults> {
  const parsed = searchInputSchema.safeParse(raw);
  if (!parsed.success) throw new ChatSearchError("Check the search words, kind and dates, then try again.");
  const input = parsed.data;
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && Object.keys(input).some((key) => key !== "cursor")) throw new ChatSearchError("Continue with only the search cursor, or start a new search.");
  if (cursor && (cursor.family !== ctx.fam.familyId || cursor.baby !== ctx.baby.id)) throw new ChatSearchError("This search belongs to another log. Run a new search here.");
  const criteria = cursor?.criteria ?? criteriaFor(input, dayKey(ctx.now, ctx.tz));
  const asOf = cursor ? new Date(cursor.asOf) : ctx.now;
  if (asOf > ctx.now || (cursor && (new Date(cursor.at) > asOf))) throw new ChatSearchError("That search page is invalid. Run the search again.");
  const [from, to] = bounds(criteria, ctx, asOf);
  const rows = await query(
    `SELECT * FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL
      AND started_at >= $3 AND started_at < $4
      AND ($5::text IS NULL OR kind = $5)
      AND ($6::text IS NULL OR concat_ws(' ', note, data->>'title', data->>'name', data->>'tag', data->>'milestone') ILIKE $6 ESCAPE '\\')
      AND (NOT $7::boolean OR (kind = 'note' AND data->>'for_doctor' = 'true' AND ($8::boolean OR COALESCE(data->>'done', 'false') <> 'true')))
      AND ($9::timestamptz IS NULL OR (started_at, id) < ($9::timestamptz, $10::bigint))
      ORDER BY started_at DESC, id DESC LIMIT $11`,
    [ctx.fam.familyId, ctx.baby.id, from.toISOString(), to.toISOString(), criteria.kind,
      criteria.query ? searchPattern(criteria.query) : null, criteria.doctorQuestions, criteria.includeAnswered,
      cursor?.at ?? null, cursor?.id ?? null, criteria.limit + 1],
  );
  if (rows === null) throw new StoreUnavailable();
  const more = rows.length > criteria.limit;
  const shown = rows.slice(0, criteria.limit).map(rowToEntry);
  const entries = shown.map((entry) => ({
    id: entry.id, kind: entry.kind, startedAt: entry.started_at,
    summary: describeEntry(entry, { now: asOf, words: milestoneWordsOf(ctx.fam.familyId, ctx.baby) }).text.slice(0, 500),
    question: entry.kind === "note" && !!entry.data.for_doctor,
    done: entry.kind === "note" && !!entry.data.done,
  }));
  const last = shown.at(-1);
  const nextCursor = more && last ? Buffer.from(encryptSecret(JSON.stringify({ purpose: "chat-search", version: 1, family: ctx.fam.familyId, baby: ctx.baby.id, criteria, asOf: asOf.toISOString(), at: last.started_at, id: last.id } satisfies Cursor))).toString("base64url") : null;
  return chatEntryResultsSchema.parse({ version: 1, asOf: asOf.toISOString(), timezone: ctx.tz, criteria, entries, nextCursor });
}

export function searchEntriesTool(extra: Extra) {
  return tool({
    description: "Find and show baby log entries as interactive cards, with Edit and Open history. Search literal words in notes, moment titles, medicine names and note tags, or list a kind/date/time range. Defaults to the last year; at most 366 local days per search and 20 entries per page. doctorQuestions shows the baby's pediatrician questions, open by default. Never reads mom's private data. Use nextCursor for more results. No data is changed.",
    inputSchema: zodSchema(searchInputSchema),
    execute: async (input) => {
      try {
        const entries = await searchEntries(await context(extra), input);
        return { ok: true, write: false, entries, text: `${entries.entries.length} matching entries shown from ${entries.criteria.from} through ${entries.criteria.to}${entries.nextCursor ? "; more available" : ""}.` };
      } catch (error) {
        if (!(error instanceof ChatSearchError)) throw error;
        return { ok: false, write: false, text: error.message };
      }
    },
    toModelOutput: ({ output }) => ({ type: output.ok ? "text" as const : "error-text" as const, value: JSON.stringify(output) }),
  });
}

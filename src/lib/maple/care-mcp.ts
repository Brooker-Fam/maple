import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureServerException } from "@/lib/posthog-server";
import {
  aheadOfSlot,
  bareName,
  careTime,
  countedAs,
  forMom,
  listNotes,
  matchPlan,
  normName,
  planActive,
  planMeta,
  planNames,
  planSentence,
  planView,
  pressingFirst,
  scheduleSummary,
  sortPlans,
  unitCount,
  type CareViewer,
  type PlanView,
} from "./care";
import {
  CareConflict,
  CareForbidden,
  DEFAULT_CARE_PERSON,
  addCareQuestion,
  careSession,
  deleteCarePlan,
  deleteCareEntry,
  listCareEntries,
  logCareDose,
  logCareTemp,
  planDoses,
  readableEntry,
  readablePlan,
  restoreCareEntry,
  saveCarePlan,
  stopCarePlan,
  updateCareEntry,
  visiblePlans,
  type CareSession,
  type CareEntryPatch,
} from "./care-store";
import { ALERT_TIERS, HELP_NOW_LINE, MOM_DISCLAIMER, MOM_HELP, MOM_TIER_LABEL, assessMomTemp, type AlertTier, type Assessment } from "./guidelines";
import { isVitaminD, memberName } from "./insights";
import { READ_ANN, ToolError, WRITE_ANN, context, fail, isoLocal, ok, startFrom, whenText, type Annotations, type Ctx, type Extra } from "./mcp-tools";
import { NotFound, StoreUnavailable } from "./store";
import { addDays, dayKey } from "./time";
import type { CareEntry, CarePlan, DoseEntry, MedReason, PlanInput, Source } from "./types";
import { cToF, fToC } from "./units";

/**
 * Her mom's own medicines, temperature and questions as MCP tools (§10 of
 * the "for mom" spec), registered on Maple's server by registerMapleTools, so
 * Maple's connector and the calendar connector both carry them.
 *
 * - Registration needs no database; every call resolves the caller's care
 *   access (careAccess, through careSession) on the MCP channel. An
 *   assistant gets everything on her page except check-ins: there are no
 *   mood tools.
 * - She's named: titles and descriptions say "Brittany's" (MOM, the name her
 *   page is made with, since registration can't read the database), and
 *   results use her page's own name (s.name).
 * - Ids print as c12345678 (entries) and p12345678 (plans): Maple's tools
 *   take plain numbers, so neither set reaches the other's rows.
 * - Every number comes from her plan, typed by the family from her label or
 *   clinician, or copied by the assistant from a photo of them the user
 *   shared, read back and saved only after a yes. Input descriptions carry
 *   no digits and forbid filling in, suggesting or inferring a dose,
 *   interval, limit or count.
 * - A brand or generic name of a medicine on her list counts toward it
 *   (SAME_MEDICINE, exact names only, after her own names found nothing).
 * - Alerts are guidelines.ts copy, labelled with who to call (MOM_TIER_LABEL,
 *   or the alert's own label) and prefixed "For {Name}: " for anyone but her.
 * - Access errors end with HELP_NOW_LINE and carry help_now. Anything
 *   unexpected is reported as new Error(code) with { route } only: Postgres
 *   messages can hold row data.
 */

const ROUTE = "/api/maple/mcp";
const DAY = 86400_000;

/**
 * Her name where it's fixed when the server starts (tool titles and
 * descriptions; MAPLE_INSTRUCTIONS uses the same constant): the name her page
 * is made with. Results use the page's own name.
 */
const MOM = DEFAULT_CARE_PERSON;

// ── one medicine, two names ─────────────────────────────────────────────

/**
 * Single-ingredient brand and generic names of one medicine (DailyMed), so a
 * dose said by the other name counts toward the plan already on her list
 * ("acetaminophen" when the plan is named Tylenol). Names only, matched
 * exactly after normName, and only to find a plan that's already hers, never
 * to suggest one: no combination products (Percocet, Tylenol PM, Tylenol
 * with codeine), no categories ("stool softener"), no strengths.
 */
export const SAME_MEDICINE: readonly (readonly string[])[] = [
  ["acetaminophen", "paracetamol", "apap", "tylenol"],
  ["ibuprofen", "motrin", "motrin ib", "advil"],
  ["naproxen", "naproxen sodium", "aleve"],
  ["docusate", "docusate sodium", "colace"],
  ["senna", "sennosides", "senokot"],
  ["polyethylene glycol", "polyethylene glycol 3350", "miralax"],
  ["famotidine", "pepcid"],
  ["simethicone", "gas x"],
];

/**
 * The SAME_MEDICINE names `name` is one of (exactly, after normName and
 * without strength or form words like "Extra Strength"), or none. A dose said
 * with another strength still counts toward her plan, so its gap is kept; the
 * reply says what it counted as.
 */
function sameNames(name: string): readonly string[] {
  const k = bareName(name);
  return (k && SAME_MEDICINE.find((g) => g.includes(k))) || [];
}

/**
 * Her plans that are `name` by its other name: a plan whose name or an Also
 * called name is in the same SAME_MEDICINE group. Only for when her own names
 * found nothing (matchPlan first): one plan counts, two ask which.
 */
export function samePlans<P extends CarePlan>(name: string, plans: P[]): P[] {
  const g = sameNames(name);
  return g.length ? plans.filter((p) => planNames(p).some((n) => g.includes(n) || g.includes(bareName(n)))) : [];
}

/**
 * The plan already on her list that a medicine being added is: by its name or
 * an Also called name, or the same medicine by another name,
 * so a discharge sheet's "Ibuprofen" never becomes a second plan beside the
 * "Motrin" she has (each would count only its own doses).
 */
function alreadyOnList(m: { name?: string | null; also_called?: string | null }, have: CarePlan[]): { plan: CarePlan; same: boolean } | null {
  const names = [m.name ?? "", ...(m.also_called ?? "").split(",")].map((n) => n.trim()).filter(Boolean);
  for (const n of names) {
    const k = normName(n);
    const hit = k ? have.find((p) => planNames(p).includes(k)) : undefined;
    if (hit) return { plan: hit, same: false };
  }
  for (const n of names) {
    const same = samePlans(n, have);
    if (same.length) return { plan: same[0], same: true };
  }
  return null;
}

// ── who's asking ────────────────────────────────────────────────────────

/** An access problem: its text gets HELP_NOW_LINE and the result help_now. */
class CareAccessError extends Error {}

async function careFor(ctx: Ctx): Promise<CareSession> {
  const viewer: CareViewer = { id: ctx.who.id, role: ctx.who.role, viaAdmin: ctx.who.viaAdmin, channel: "mcp" };
  return careSession(viewer, { members: ctx.members, baby: ctx.baby });
}

/** The one access error: a view-only guest. Everyone else can do everything here. */
function needAccess(ctx: Ctx, s: CareSession, write: boolean) {
  if (ctx.who.role === "viewer" || !s.access.read || (write && !s.access.write)) {
    throw new CareAccessError("You're a viewer on Maple's Log, so her mom's page isn't open to you. An owner can make you a member in Maple's Log → Family.");
  }
}

function accessFail(message: string): CallToolResult {
  const summary = `${message} ${HELP_NOW_LINE}`;
  const data = { help_now: MOM_HELP.now };
  return { isError: true, content: [{ type: "text", text: `${summary}\n${JSON.stringify(data)}` }], structuredContent: { summary, ...data } };
}

/** The code behind an unexpected error, never its message (row data can be in it). */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  return err instanceof Error && err.message === "id_exhausted" ? "id_exhausted" : "care_mcp_error";
}

const userFacing = (err: unknown): err is Error =>
  err instanceof Error &&
  err.constructor === Error &&
  !("code" in err) &&
  err.message !== "id_exhausted" &&
  err.message.length < 200 &&
  !/database|neon|fetch|ECONN|timeout|sql/i.test(err.message);

async function careToolError(name: string, err: unknown): Promise<CallToolResult> {
  if (err instanceof CareAccessError || err instanceof CareForbidden) return accessFail(err.message);
  if (err instanceof ToolError) return fail(err.message);
  if (err instanceof StoreUnavailable) return fail("Maple's Log can't reach its database right now, so nothing was saved. Try again in a minute.");
  if (err instanceof NotFound) return fail("That isn't on her list or in her log. Call mom_status for her medicines and their ids.");
  if (err instanceof CareConflict) {
    const plan = err.current.plan;
    return fail(`${err.message}${plan ? ` It now reads: ${plan.name} · ${scheduleSummary(plan)}.` : ""} Nothing was saved; call mom_status, then try again.`);
  }
  // Validation (the plan sheet's own words, "Choose what the label counts: …"): the model can fix these.
  if (userFacing(err)) return fail(`${err.message.replace(/\.$/, "")}. Nothing was saved; fix that and try again.`);
  const scrubbed = new Error(errorCode(err));
  console.error(`Maple MCP ${name} error: ${scrubbed.message}`);
  await captureServerException(scrubbed, { route: ROUTE });
  return fail("Something went wrong inside Maple's Log. Check mom_status before trying again, so nothing gets logged twice.");
}

function addCareTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: S; annotations: Annotations; invoking: string; invoked: string; write?: boolean },
  run: (args: ShapeOutput<S>, ctx: Ctx, s: CareSession) => Promise<CallToolResult>
) {
  const handler = async (args: ShapeOutput<S>, extra: Extra): Promise<CallToolResult> => {
    try {
      const ctx = await context(extra);
      const s = await careFor(ctx);
      needAccess(ctx, s, !!cfg.write);
      return await run(args, ctx, s);
    } catch (err) {
      return careToolError(name, err);
    }
  };
  server.registerTool(
    name,
    {
      title: cfg.title,
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: { title: cfg.title, ...cfg.annotations },
      _meta: { "openai/toolInvocation/invoking": cfg.invoking, "openai/toolInvocation/invoked": cfg.invoked },
    },
    handler as unknown as ToolCallback<S>
  );
}

// ── how her things read ─────────────────────────────────────────────────

const VIA: Partial<Record<Source, string>> = { web: "the app", claude: "Claude", chatgpt: "ChatGPT", mcp: "an AI assistant", shortcut: "Siri" };
const viaWord = (s: Source) => VIA[s] ?? "the app";

/** Who logged it, for a sentence to the person asking: "you" when it was them. */
const byWord = (by: string | null, ctx: Ctx) => (by && by === ctx.who.id ? "you" : memberName(by, ctx.members));

type MomAlert = { tier: AlertTier; label: string; title: string; body: string };

/** Already forMom-prefixed by care.ts / care-store.ts for anyone but her. */
const momAlert = (a: Assessment): MomAlert => ({ tier: a.tier, label: a.label ?? MOM_TIER_LABEL[a.tier], title: a.title, body: a.body });

function alertsOf(list: Assessment[]): MomAlert[] {
  const seen = new Set<string>();
  return list
    .map(momAlert)
    .filter((a) => {
      const k = `${a.title}|${a.body}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => ALERT_TIERS.indexOf(a.tier) - ALERT_TIERS.indexOf(b.tier));
}

/** Word for word, with the label, then the disclaimer for anything above a nudge. */
function alertLines(alerts: MomAlert[]): string[] {
  if (!alerts.length) return [];
  const lines = alerts.map((a) => `${a.label}: ${a.title.replace(/[.:]$/, "")}. ${a.body}`);
  if (alerts.some((a) => a.tier !== "nudge")) lines.push(MOM_DISCLAIMER);
  return lines;
}

/** The engine's text context for this caller: names, never "You" (the assistant is relaying it). */
const textCtx = (s: CareSession) => ({
  now: s.now,
  tz: s.tz,
  self: s.access.self,
  members: s.members,
  name: s.name,
  settings: s.person?.settings ?? {},
});

type Viewed = { view: PlanView; doses: DoseEntry[] };

/** Her plans, as the app shows them; active ones in sortPlans order. */
async function viewsFor(s: CareSession, days = 0): Promise<{ active: Viewed[]; finished: Viewed[] }> {
  const plans = await visiblePlans(s);
  // Eight days covers the gap, the 24-hour limit and plan detail's week.
  const since = new Date(s.now.getTime() - Math.max(8, days + 1) * DAY);
  const tctx = textCtx(s);
  const all = await Promise.all(
    plans.map(async (plan) => {
      const doses = await planDoses(plan.id, since);
      return { view: planView(plan, doses, tctx, s.viewer.id), doses };
    })
  );
  const order = sortPlans(all.filter((x) => planActive(x.view.plan, s.now, s.tz)).map((x) => ({ ...x.view, x })));
  return { active: order.map((o) => o.x), finished: all.filter((x) => !planActive(x.view.plan, s.now, s.tz)) };
}

function doseJson(d: DoseEntry, ctx: Ctx) {
  return {
    id: `c${d.id}`,
    name: d.data.name,
    local: whenText(d.at, ctx),
    at: isoLocal(d.at, ctx.tz),
    ...(d.data.skipped ? { skipped: true } : {}),
    units: d.data.units ?? null,
    unit: d.data.unit ?? null,
    dose: d.data.dose ?? null,
    by: memberName(d.created_by, ctx.members),
    via: viaWord(d.source),
    note: d.note,
  };
}

function planJson({ view: v, doses }: Viewed, ctx: Ctx, days: number) {
  const p = v.plan;
  const st = v.status;
  const since = ctx.now.getTime() - days * DAY;
  return {
    id: `p${p.id}`,
    name: p.name,
    also_called: p.also_called,
    dose_text: p.dose_text,
    schedule_text: v.summary,
    label_text: p.label_text,
    instructions: p.instructions,
    line: v.line,
    sentence: v.sentence,
    meta: v.meta,
    state: st.state,
    last: st.last ? { at: isoLocal(st.last.at, ctx.tz), local: whenText(st.last.at, ctx), by: memberName(st.last.created_by, ctx.members), via: viaWord(st.last.source) } : null,
    next_ok_at: st.nextOkAt ? isoLocal(st.nextOkAt, ctx.tz) : null,
    count24: st.count24,
    max24: st.max24,
    limit_unit: p.limit_unit,
    units_per_dose: p.units_per_dose,
    course_day: st.courseDays != null ? st.courseDay : null,
    course_days: st.courseDays,
    notes: alertsOf(v.notes),
    ...(days > 0 ? { doses: doses.filter((d) => Date.parse(d.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((d) => doseJson(d, ctx)) } : {}),
  };
}

/** "Ibuprofen: OK after 8:10 AM, by her schedule. Last: 2:10 AM · Matt. 1 of 4 tablets in the last 24 hours." */
const fullSentence = (v: PlanView) => `${v.plan.name}: ${[v.sentence, ...v.meta].map((t) => t.replace(/\.$/, "")).join(". ")}.`;

/** "Acetaminophen: OK since 4:10 AM" (speak; and Siri's). */
export function spokenLine(v: PlanView, now: Date, tz: string): string {
  return `${v.plan.name}: ${spokenStatus(v, now, tz)}`;
}

/** The status part of spokenLine: "OK since 4:10 AM", "none logged yet". */
function spokenStatus(v: PlanView, now: Date, tz: string): string {
  const st = v.status;
  const at = (iso: string | null | undefined) => (iso ? careTime(iso, now, tz) : "");
  switch (st.state) {
    case "wait":
      return `OK after ${at(st.nextOkAt)}`;
    case "ok":
      return `OK since ${at(st.gapOkAt)}`;
    case "at_limit":
      return `${st.count24} of ${unitCount(st.max24 ?? 0, st.unit)} in 24 hours, OK after ${at(st.nextOkAt)}`;
    case "unknown":
      return `last one at ${at(st.last?.at)}`;
    case "none":
      return "none logged yet";
    case "day_open":
    case "day_done":
    case "slot_open":
    case "slot_next":
      return v.sentence.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase());
    default:
      return v.sentence.replace(/\.$/, "");
  }
}

/** One medicine in a spoken list: "Ibuprofen OK since 2:10 AM", "Colace, not logged today". */
function spokenItem(v: PlanView, now: Date, tz: string): string {
  const rest = spokenStatus(v, now, tz);
  return `${v.plan.name}${/^(OK|\d)/.test(rest) ? " " : ", "}${rest}`;
}

/**
 * Her medicines in one spoken sentence for Maple's status (maple_status
 * `speak`, Siri's "Maple status"), in the order given, capped at `cap`:
 * callers pass pressingFirst's order, so the most pressing one (a set time
 * not logged, then OK now, …) is never the one cut. E.g.
 * "Brittany's medicines: Ibuprofen OK since 2:10 AM; Tylenol OK after 10:55 AM."
 * Null with none.
 */
export function momSpeak(views: PlanView[], who: { name: string; self: boolean; now: Date; tz: string }, cap = 2): string | null {
  if (!views.length) return null;
  const bits = views.slice(0, cap).map((v) => spokenItem(v, who.now, who.tz));
  const more = views.length > cap ? `, and ${views.length - cap} more` : "";
  return `${who.self ? "Your medicines" : `${who.name}'s medicines`}: ${bits.join("; ")}${more}.`;
}

const listNames = (names: string[]) => (names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * One of her active plans by name, Also called, p id, or (when none of those
 * fits) the same medicine by its other name (`same`: "acetaminophen" for
 * Tylenol on her list); null when none matches (it's logged as a one-off);
 * ambiguous asks which.
 */
function pickPlan(query: string, active: Viewed[], finished: Viewed[]): { hit: Viewed; same: boolean } | null {
  const m = matchPlan(query, active.map((x) => x.view.plan), { includePrivate: true });
  if (m.kind === "match") return { hit: active.find((x) => x.view.plan.id === m.plan.id)!, same: false };
  if (m.kind === "ambiguous") throw new ToolError(`"${query}" could be ${listNames(m.plans.map((p) => p.name))}. Ask which one, then pass its name or id.`);
  // A p id is never a medicine's name: a finished or stopped plan's id logs on that plan, an unknown one asks.
  const id = /^p?(\d{8})$/i.exec(query.trim());
  if (id) {
    const old = finished.find((x) => x.view.plan.id === Number(id[1]));
    if (old) return { hit: old, same: false };
    throw new ToolError(`"${query}" isn't one of her medicine ids. ${listNames(active.map((x) => x.view.plan.name)) ? `Her list has ${listNames(active.map((x) => x.view.plan.name))}.` : "Her list is empty so far."} Call mom_status for the ids.`);
  }
  const same = samePlans(query, active.map((x) => x.view.plan));
  if (same.length === 1) return { hit: active.find((x) => x.view.plan.id === same[0].id)!, same: true };
  if (same.length > 1) {
    throw new ToolError(`"${query}" is the same medicine as ${listNames(same.map((p) => p.name))} on her list. Ask which one it counts toward, then pass its name or id.`);
  }
  return null;
}

/** Idempotency for client_ref, namespaced per member (care-store's id format is strict). */
const clientIdFor = (ctx: Ctx, ref: string | null | undefined) =>
  ref?.trim() ? `mcp-care:${createHash("sha256").update(`${ctx.who.id}\n${ref.trim()}`).digest("hex").slice(0, 40)}` : null;

/** c12345678 → 12345678, else an error that says what an id looks like. */
function entryId(raw: string): number {
  const m = /^c(\d{8})$/i.exec(raw.trim());
  if (!m) throw new ToolError(`"${raw}" isn't one of her entry ids (they start with c, like the ones mom_status and the log_mom tools return).`);
  return Number(m[1]);
}
function planId(raw: string): number {
  const m = /^p(\d{8})$/i.exec(raw.trim());
  if (!m) throw new ToolError(`"${raw}" isn't one of her medicine ids (they start with p, as mom_status shows them).`);
  return Number(m[1]);
}

const tempText = (c: number) => `${(Math.round(cToF(c) * 10) / 10).toFixed(1)}°F`;

/** The time the user gave (at or minutes_ago), else now. */
function timeArg(a: { at?: string | null; minutes_ago?: number | null }, ctx: Ctx, assumed: string[]): Date {
  return startFrom(a, ctx, assumed) ?? ctx.now;
}
const assumedLines = (assumed: string[]) => (assumed.length ? [`Note: ${[...new Set(assumed)].join("; ")}.`] : []);

// ── inputs ──────────────────────────────────────────────────────────────

const TIME_HINT =
  "a local clock time in America/New_York as the user said it, \"yesterday\" plus a time, \"just now\", or an ISO timestamp. Never invent a date. Leave it out (with minutes_ago) for right now.";

const inputs = {
  at: (what: string) => z.string().max(60).nullish().describe(`${what}: ${TIME_HINT}`),
  minutesAgo: () => z.number().min(0).max(4320).nullish().describe("How many minutes ago, as the user said it. Use instead of at."),
  clientRef: () =>
    z.string().max(100).nullish().describe("Optional idempotency key: repeat the same client_ref on a retry and the first save comes back instead of a second entry."),
  allowDuplicate: () =>
    z
      .boolean()
      .nullish()
      .describe("Only after the user confirms a possible_duplicate is really another dose: true saves it anyway."),
};

const HOW = ["as_needed", "every", "daily", "times"] as const;
const REASONS = ["pain", "constipation", "bp", "iron", "infection", "mood", "vitamin", "other"] as const;
const UNITS = ["tablets", "caplets", "capsules", "doses", "mL"] as const;

// ── the tools ───────────────────────────────────────────────────────────

/**
 * Her medicines for maple_status, by the one rule every glanceable line uses
 * (pressingPlan: a set time not logged first, then OK now, then doses left
 * today, then the soonest wait, then the next set time), for every active
 * one: `line` for the text ("Brittany's medicines: Ibuprofen OK after 9:10
 * AM; Tylenol · OK since 4:10 AM · last 10:10 PM"), and `speak` for voice,
 * capped at two (momSpeak). Only for someone who can
 * read her medicines, and only with one on her list. Null otherwise, or on
 * any error (Maple's status never waits on hers).
 */
export async function momStatus(ctx: Ctx): Promise<{ name: string; line: string; speak: string; top: string } | null> {
  try {
    const s = await careFor(ctx);
    if (!s.person || !s.access.read || ctx.who.role === "viewer") return null;
    const { active } = await viewsFor(s);
    // The pressing one leads (a set time not logged comes before OK now), then sortPlans' order.
    const views = pressingFirst(active.map((x) => x.view));
    const top = views[0];
    if (!top) return null;
    const shown = views.slice(0, 3).map((v) => v.line);
    const more = views.length > shown.length ? `; ${views.length - shown.length} more in mom_status` : "";
    const whose = s.access.self ? "Your medicines" : `${s.name}'s medicines`;
    return {
      name: s.name,
      line: `${whose}: ${shown.join("; ")}${more}.`,
      speak: momSpeak(views, { name: s.name, self: s.access.self, now: s.now, tz: s.tz })!,
      top: top.line,
    };
  } catch (err) {
    await captureServerException(new Error(errorCode(err)), { route: ROUTE });
    return null;
  }
}

/**
 * Her active plans that are this name by its other name, for Maple's
 * log_medicine note ("Brittany has Tylenol on her medicine list, the same
 * medicine as acetaminophen…"): only for someone who can read her medicines,
 * never Vitamin D, and no database read for a name SAME_MEDICINE doesn't
 * know. Errors go to the caller (which never lets them stop Maple's log).
 */
export async function momSameMedicine(ctx: Ctx, name: string): Promise<{ name: string; plans: CarePlan[] } | null> {
  if (isVitaminD(name) || !sameNames(name).length) return null;
  const s = await careFor(ctx);
  if (!s.person || !s.access.read || ctx.who.role === "viewer") return null;
  const plans = samePlans(name, (await visiblePlans(s)).filter((p) => planActive(p, s.now, s.tz)));
  return plans.length ? { name: s.name, plans } : null;
}

/**
 * Her block for daily_summary (Claude's summary, not a Maple view): her doses
 * per medicine with the last one, her temperatures and her open questions for
 * her OB, over the same days, kept apart from Maple's paragraph. Only when she
 * has one of those, and only for someone who can read her page. Never her
 * check-ins (there are no mood tools). Null otherwise, or on any error
 * (Maple's summary never waits on hers).
 */
export async function momSummary(ctx: Ctx, from: Date): Promise<{ line: string; json: Record<string, unknown> } | null> {
  try {
    const s = await careFor(ctx);
    if (!s.person || !s.access.read || ctx.who.role === "viewer") return null;
    const [entries, questions, plans] = await Promise.all([
      listCareEntries(s, { kinds: ["dose", "temp"], from }),
      listCareEntries(s, { kinds: ["question"], limit: 200 }),
      visiblePlans(s),
    ]);
    const doses = entries.filter((e): e is DoseEntry => e.kind === "dose");
    const temps = entries.flatMap((e) => (e.kind === "temp" ? [e] : []));
    const open = questions.filter((q) => q.kind === "question" && !q.data.done);
    if (!doses.length && !temps.length && !open.length) return null;

    // Per medicine (newest first, as listed): a plan by its current name, a one-time medicine by its own.
    const meds = new Map<string, { id: string | null; name: string; taken: number; skipped: number; last: string | null }>();
    for (const d of doses) {
      const plan = d.med_id != null ? plans.find((p) => p.id === d.med_id) : null;
      const key = d.med_id != null ? `p${d.med_id}` : `n:${normName(d.data.name)}`;
      const m = meds.get(key) ?? { id: d.med_id != null ? `p${d.med_id}` : null, name: plan?.name ?? d.data.name, taken: 0, skipped: 0, last: null };
      if (d.data.skipped) m.skipped++;
      else {
        m.taken++;
        m.last ??= d.at;
      }
      meds.set(key, m);
    }
    const list = [...meds.values()];
    const her = s.access.self ? "your" : "her";
    const medText = (m: (typeof list)[number]) => {
      const counts = [m.taken ? `${m.taken} ${m.taken === 1 ? "dose" : "doses"}` : "", m.skipped ? `${m.skipped} skipped` : ""].filter(Boolean).join(" and ");
      return `${m.name}${m.id ? "" : " (one-time)"} ${counts}${m.last ? `, last ${whenText(m.last, ctx)}` : ""}`;
    };
    const parts = [
      list.length
        ? `${s.access.self ? "Your" : `${s.name}'s`} own medicines over these days (not Maple's): ${list.map(medText).join("; ")}.`
        : `${s.access.self ? "Your" : `${s.name}'s`} own medicines: none logged over these days.`,
    ];
    let tempJson: Record<string, unknown> | null = null;
    if (temps.length) {
      const high = temps.reduce((a, b) => (b.data.temp_c > a.data.temp_c ? b : a));
      const latest = temps[0];
      parts.push(`${s.access.self ? "Your" : "Her"} temperatures: ${temps.length} ${temps.length === 1 ? "reading" : "readings"}, highest ${tempText(high.data.temp_c)} at ${whenText(high.at, ctx)}.`);
      const f = (c: number) => Math.round(cToF(c) * 10) / 10;
      tempJson = {
        readings: temps.length,
        highest: { temp_f: f(high.data.temp_c), local: whenText(high.at, ctx) },
        latest: { temp_f: f(latest.data.temp_c), local: whenText(latest.at, ctx) },
      };
    }
    if (open.length) parts.push(`Open questions for ${her} OB: ${open.map((q) => `“${q.note ?? ""}”`).join(" ")}`);
    return {
      line: parts.join(" "),
      json: {
        name: s.name,
        self: s.access.self,
        medicines: list.map((m) => ({ id: m.id, name: m.name, one_time: !m.id, doses: m.taken, skipped: m.skipped, last: m.last ? whenText(m.last, ctx) : null })),
        temps: tempJson,
        questions_open: open.map((q) => ({ id: `c${q.id}`, text: q.note })),
        more: "mom_status",
      },
    };
  } catch (err) {
    await captureServerException(new Error(errorCode(err)), { route: ROUTE });
    return null;
  }
}

type MomDoseArgs = {
  medicine: string;
  at?: string | null;
  minutes_ago?: number | null;
  skipped?: boolean | null;
  units?: number | null;
  dose?: string | null;
  note?: string | null;
  one_off?: boolean | null;
  client_ref?: string | null;
  allow_duplicate?: boolean | null;
};

/** log_mom_medicine itself: a name on her list counts toward it, any other is a one-off; only a likely duplicate isn't saved. */
async function momDose(a: MomDoseArgs, ctx: Ctx, s: CareSession): Promise<{ summary: string; data: Record<string, unknown> }> {
  const assumed: string[] = [];
  const at = timeArg(a, ctx, assumed);
  const { active, finished } = await viewsFor(s);
  const clientId = clientIdFor(ctx, a.client_ref);
  const source = ctx.who.via;
  const whose = s.access.self ? "your" : "her";

  // On her list (or the same medicine by its other name) it counts toward that plan; anything else is saved as a
  // one-time medicine, like Maple's log_medicine.
  const picked = a.one_off ? null : pickPlan(a.medicine, active, finished);
  const target = picked?.hit ?? null;
  // "acetaminophen" for Tylenol on her list: the dose is Tylenol's, and the result says what was said.
  const sameAs = picked?.same ? a.medicine.trim() : null;

  const plan = target?.view.plan ?? null;
  const res = await logCareDose(s, {
    planId: plan?.id ?? null,
    name: plan ? undefined : a.medicine.trim(),
    at: at.toISOString(),
    units: a.units ?? null,
    dose: a.dose ?? null,
    note: a.note ?? null,
    skipped: a.skipped === true,
    allowDuplicate: a.allow_duplicate === true,
    clientId,
    source,
  });
  const name = plan?.name ?? a.medicine.trim();
  const tctx = textCtx(s);

  if (!res.created && !res.deduped) {
    const st = res.status;
    const dup = res.possible_duplicate;
    const who = dup ? byWord(dup.created_by, ctx) : null;
    const why = dup
      ? `${who === "you" ? "You" : who} logged ${name} at ${whenText(dup.at, ctx)}, which looks like the same one. If she took another, call again with allow_duplicate: true.`
      : "It wasn't saved. Try again.";
    return { summary: `Not saved: ${why}`, data: {
      created: false,
      reason: res.reason ?? null,
      medicine: plan ? { id: `p${plan.id}`, name: plan.name, line: target!.view.line, sentence: st ? planSentence(plan, st, tctx) : target!.view.sentence } : { name },
      ...(dup ? { possible_duplicate: doseJson(dup, ctx) } : {}),
    } };
  }

  const entry = res.entry as DoseEntry;
  const who = `logged by ${memberName(entry.created_by, ctx.members)} via ${viaWord(entry.source)}`;
  const lines: string[] = [];
  if (res.deduped) lines.push(`Already saved c${entry.id}: ${name} at ${whenText(entry.at, ctx)} (${who}), so it wasn't added twice.`);
  else {
    const where = !plan ? `, as a one-time medicine (it isn't on ${whose} list)` : sameAs ? `, counted toward ${plan.name} on ${whose} list (the same medicine)` : "";
    lines.push(`Saved c${entry.id}: ${sameAs ?? name}${entry.data.skipped ? " skipped" : ""} at ${whenText(entry.at, ctx)} (${who})${where}.`);
  }
  // Any other name (one SAME_MEDICINE doesn't know) doesn't count toward a plan: say what's there so it can be moved.
  if (!plan && !res.deduped && !a.one_off && active.length) {
    lines.push(`${s.access.self ? "Your" : "Her"} list has ${listNames(active.map((x) => x.view.plan.name))}. If it was one of those, remove this with fix_mom_entry (id c${entry.id}, action delete) and log it by that name.`);
  }
  let after: Record<string, unknown> = {};
  if (plan && res.status) {
    const st = res.status;
    const sentence = planSentence(plan, st, tctx).replace(/\.$/, "");
    // Who logged it is already said; the count and course day follow the sentence.
    const meta = planMeta(plan, st, tctx).filter((m) => !m.startsWith("Last:") && !(st.state === "at_limit" && m.includes("in the last 24 hours")));
    lines[0] += ` ${[sentence, ...meta].join(" · ")}.`;
    const counted = res.created && !entry.data.skipped ? countedAs(plan, entry.data.units) : null;
    if (counted) lines.push(`How many wasn't said, so it counts as ${counted} toward ${whose} 24-hour limit. If she took more, change it with fix_mom_entry (units).`);
    const slot = res.created && !entry.data.skipped && target ? aheadOfSlot(plan, target.doses, new Date(entry.at), s.tz) : null;
    if (slot) lines.push(`That's more than an hour before ${whose} ${careTime(slot, s.now, s.tz)} time, so it counts for that one.`);
    after = { next_ok_at: st.nextOkAt ? isoLocal(st.nextOkAt, ctx.tz) : null, count24: st.count24, max24: st.max24, limit_unit: plan.limit_unit, sentence: planSentence(plan, st, tctx) };
  }
  const alerts = alertsOf(res.notes);
  lines.push(...assumedLines(assumed), ...alertLines(alerts));
  return { summary: lines.join("\n"), data: {
    created: !!res.created,
    ...(res.deduped ? { deduped: true } : {}),
    entry: doseJson(entry, ctx),
    ...(plan ? { medicine: { id: `p${plan.id}`, name: plan.name } } : { one_off: true }),
    ...(sameAs && plan ? { same_medicine: { said: sameAs, counted_toward: plan.name } } : {}),
    ...after,
    alerts,
  } };
}

// ── her plans, from what the user read (set_mom_medicine, add_mom_medicines) ──

/** One medicine's fields, as set_mom_medicine and add_mom_medicines take them. */
type PlanArgs = {
  name?: string | null;
  also_called?: string | null;
  dose_text?: string | null;
  how?: (typeof HOW)[number] | null;
  min_gap_hours?: number | null;
  every_hours?: number | null;
  per_day?: number | null;
  times?: string[] | null;
  max_per_24h?: number | null;
  limit_unit?: (typeof UNITS)[number] | null;
  units_per_dose?: string | null;
  label_text?: string | null;
  for?: (typeof REASONS)[number] | null;
  contains_acetaminophen?: boolean | null;
  start_date?: string | null;
  end_date?: string | null;
  days?: number | null;
  instructions?: string | null;
};

/** The input fields of one medicine (all but its name), shared by set_mom_medicine and add_mom_medicines. */
const planFields = () => ({
  also_called: z.string().max(80).nullish().describe("Other names for it, like the brand on the box, comma-separated, only as the user said them or the paper prints them."),
  dose_text: z.string().max(80).nullish().describe("The dose as prescribed, copied from the label or papers in their words (strength and how many). Never fill it in."),
  how: z.enum(HOW).nullish().describe("How often, as the label says: as_needed, every (every few hours), daily (a number of times a day) or times (set clock times). Left out, it's As needed with no gap."),
  min_gap_hours: z
    .number()
    .min(0.25)
    .max(72)
    .nullish()
    .describe("as_needed: the label's \"no sooner than every … hours\", only if the user read it or the paper prints it. Leave out if it doesn't say."),
  every_hours: z.number().min(0.25).max(72).nullish().describe("every: the hours between doses, exactly as the label says."),
  per_day: z.number().int().min(1).max(8).nullish().describe("daily: how many times a day, exactly as the label says."),
  times: z.array(z.string().max(5)).max(8).nullish().describe("times: the set local clock times as HH:MM on a twenty-four-hour clock, as her clinician gave them."),
  max_per_24h: z.number().positive().max(1000).nullish().describe("The label's most in twenty-four hours, only if the user read it or the paper prints it, counted in limit_unit. Never a typical number."),
  limit_unit: z.enum(UNITS).nullish().describe("What the label counts its limit in: tablets, caplets, capsules, doses or mL. Needed whenever a limit is given."),
  units_per_dose: z.string().max(20).nullish().describe("How many each time, the way the label says it (a single number or a choice), only if the user read it or the paper prints it. Left out, a dose logged without a count counts as one toward her limit."),
  label_text: z.string().max(120).nullish().describe("The label's own words for the schedule, copied as written."),
  for: z.enum(REASONS).nullish().describe("What it's for: pain, constipation, bp (blood pressure), iron, infection, mood, vitamin or other."),
  contains_acetaminophen: z.boolean().nullish().describe("Whether its Drug Facts label lists acetaminophen (APAP), only if the user checked or the paper says so."),
  start_date: z.string().max(10).nullish().describe("The course's first day as YYYY-MM-DD (defaults to today)."),
  end_date: z.string().max(10).nullish().describe("The course's last day as YYYY-MM-DD, if the label or clinician gave one."),
  days: z.number().int().min(1).max(365).nullish().describe("Or: the course length in days, as the label says. Use instead of end_date."),
  instructions: z.string().max(120).nullish().describe("Anything else the label says, like taking it with food, in its words."),
});

/**
 * What the user gave, as a plan patch: only what was given, so on a change
 * everything left out stays as it was. How often follows the number given
 * when `how` isn't said, never a made-up number; `kept` says when a new type
 * without its number kept the schedule she has.
 */
function planPatch(a: PlanArgs, cur: CarePlan | null, s: CareSession): { patch: Record<string, unknown>; kept: string[] } {
  const patch: Record<string, unknown> = {};
  const set = (k: keyof PlanInput, v: unknown) => {
    if (v !== undefined && v !== null) patch[k] = v;
  };
  set("name", a.name?.trim());
  set("also_called", a.also_called?.trim());
  set("dose_text", a.dose_text?.trim());
  set("max_24h", a.max_per_24h);
  set("limit_unit", a.limit_unit);
  set("units_per_dose", a.units_per_dose?.trim());
  set("label_text", a.label_text?.trim());
  set("reason", a.for as MedReason | undefined);
  set("contains_apap", a.contains_acetaminophen);
  set("instructions", a.instructions?.trim());
  set("course_start", a.start_date);
  set("course_end", a.end_date);

  const scheduleGiven = a.how || a.min_gap_hours != null || a.every_hours != null || a.per_day != null || a.times != null;
  const kept: string[] = [];
  if (scheduleGiven) {
    // How often follows the number given when `how` isn't said ("every 6 hours" → every); never a made-up number.
    const type =
      a.how ?? (a.every_hours != null ? "every" : a.per_day != null ? "daily" : a.times != null ? "times" : a.min_gap_hours != null ? "as_needed" : cur?.schedule.type ?? "as_needed");
    const prev = cur?.schedule ?? null;
    const hrs = (h: number | null | undefined) => (h == null ? undefined : Math.round(h * 60));
    // Switching between As needed and Every few hours keeps the hours already there.
    const prevGap = prev?.type === "as_needed" ? prev.min_gap_min ?? undefined : prev?.type === "every" ? prev.every_min : undefined;
    let schedule: Record<string, unknown>;
    if (type === "as_needed") schedule = { type, min_gap_min: hrs(a.min_gap_hours) ?? prevGap ?? null };
    else if (type === "every") schedule = { type, every_min: hrs(a.every_hours) ?? prevGap };
    else if (type === "daily") schedule = { type, per_day: a.per_day ?? (prev?.type === "daily" ? prev.per_day : undefined) };
    else schedule = { type, times: a.times ?? (prev?.type === "times" ? prev.times : undefined) };
    const missing = (type === "every" && schedule.every_min == null) || (type === "daily" && schedule.per_day == null) || (type === "times" && !schedule.times);
    // On a change, a new type without its number keeps the schedule she has rather than wiping it.
    if (missing && cur) kept.push(`How often stays ${scheduleSummary(cur).replace(/^./, (c) => c.toLowerCase())}: say the ${type === "daily" ? "times a day" : type === "times" ? "clock times" : "hours"} too to change it.`);
    else patch.schedule = schedule;
  } else if (!cur) {
    // How often wasn't said: As needed with no gap until someone adds it, never a typical interval.
    patch.schedule = { type: "as_needed", min_gap_min: null };
  }
  if (a.days != null) {
    if (a.end_date) throw new ToolError("Give either end_date or days, not both.");
    const start = (patch.course_start as string | undefined) ?? cur?.course_start ?? dayKey(s.now, s.tz);
    patch.course_start = start;
    patch.course_end = addDays(start, a.days - 1);
  }
  return { patch, kept };
}

/**
 * What a new plan doesn't have, as facts and never a suggestion ("Not on
 * file: the dose and a 24-hour limit (so there's none to count against)."),
 * so a list copied from a photo says what the paper didn't. The gap and the
 * limit only where her schedule keeps one.
 */
function notOnFile(plan: CarePlan): string | null {
  const missing: string[] = [];
  if (!plan.dose_text) missing.push("the dose");
  const s = plan.schedule;
  if (s.type === "as_needed" && s.min_gap_min == null) missing.push("how long between doses (so no gap is checked)");
  if ((s.type === "as_needed" || s.type === "every") && plan.max_24h == null) missing.push("a 24-hour limit (so there's none to count against)");
  return missing.length ? `Not on file: ${listNames(missing)}.` : null;
}

/** Save one plan (an add, or a change to `id`): its "Saved p…" line, what a new one doesn't have, and its notes. */
async function savePlan(a: PlanArgs, id: number | null, s: CareSession, source: Source): Promise<{ plan: CarePlan; lines: string[]; notes: Assessment[]; missing: string | null }> {
  if (a.max_per_24h != null && !a.limit_unit && id == null) {
    throw new ToolError("A 24-hour limit needs limit_unit exactly as the label counts it: tablets, caplets, capsules, doses or mL. Ask the user what the label says.");
  }
  const cur = id != null ? await readablePlan(s, id) : null;
  if (!cur && !a.name?.trim()) throw new ToolError("Give the medicine's name as on the label.");
  const { patch, kept } = planPatch(a, cur, s);
  const saved = await saveCarePlan(s, { ...(patch as unknown as PlanInput), ...(id != null ? { id } : {}) }, { source });
  const plan = saved.plan;
  const summary = scheduleSummary(plan).replace(/^./, (c) => c.toLowerCase());
  const missing = cur ? null : notOnFile(plan);
  // Two medicines with acetaminophen: the app's list note, said when this save makes (or keeps) the pair.
  const overlap = plan.contains_apap && planActive(plan, s.now, s.tz)
    ? listNotes((await visiblePlans(s)).filter((p) => planActive(p, s.now, s.tz)), { name: s.name, self: s.access.self, settings: s.person?.settings ?? {} })
    : [];
  return { plan, lines: [`Saved p${plan.id}: ${plan.name} · ${summary}.${missing ? ` ${missing}` : ""}`, ...kept], notes: [...overlap, ...saved.notes], missing };
}

const planOut = (plan: CarePlan) => ({
  id: `p${plan.id}`,
  name: plan.name,
  also_called: plan.also_called,
  schedule_text: scheduleSummary(plan),
  dose_text: plan.dose_text,
  max24: plan.max_24h,
  limit_unit: plan.limit_unit,
  units_per_dose: plan.units_per_dose,
});

/** The photo rule, in the descriptions of both tools that add to her list (MAPLE_INSTRUCTIONS says it too). */
const FROM_PAPER =
  "Use only what the user read from her label, discharge papers or clinician, or what's printed on a photo of her label or discharge papers that the user shared. From a photo: copy each value exactly as printed, leave out anything that isn't printed, read every medicine and number back to the user, and save only after they say yes. Never invent, guess, fill in or suggest a dose, interval, limit or count that isn't on the paper or in what the user said, and never use a typical one.";

export function registerCareTools(server: McpServer) {
  addCareTool(
    server,
    "mom_status",
    {
      title: `${MOM}'s medicines right now`,
      description: `${MOM}'s own medicines (she's Maple's mom), from the plan the family typed in or copied from her label or clinician: for each, when it was last taken and by whom, when her schedule next allows it, how many in the last 24 hours against her own limit (in the label's unit), and the course day. Also her latest temperature, open questions for her OB, her care-team numbers and help lines. Answer "can she take X yet?" about ${MOM} only from this, using the line given; a brand or generic name of one on her list (acetaminophen for Tylenol) answers for that one. Never say whether a medicine is safe while nursing and never suggest a dose, interval or limit: suggest her OB, Maple's pediatrician or a pharmacist.`,
      inputSchema: {
        medicine: z.string().max(80).nullish().describe("Optional: one medicine, by its name, an also-called name, its brand or generic name, or its p id (finished ones too)."),
        days: z.number().int().min(0).max(7).nullish().describe("Optional: how many days of dose history to include for each medicine, up to a week. Leave out for none."),
      },
      annotations: READ_ANN,
      invoking: `Checking ${MOM}'s medicines…`,
      invoked: `${MOM}'s medicines checked`,
    },
    async (a, ctx, s) => {
      const days = a.days ?? 0;
      const { active, finished } = await viewsFor(s, days);
      let shown = active;
      let offList: string | null = null;
      let sameAs: CarePlan[] = [];
      const asked = a.medicine?.trim() ?? "";
      if (asked) {
        const pool = [...active, ...finished];
        const m = matchPlan(asked, pool.map((x) => x.view.plan), { includePrivate: true });
        // Not by her own names: the same medicine by its other name ("acetaminophen" for Tylenol) answers for that one.
        sameAs = m.kind === "none" ? samePlans(asked, pool.map((x) => x.view.plan)) : [];
        if (m.kind === "none" && !sameAs.length) {
          // Not on her list: say so and show the list (and any one-time doses by that name below), not an error.
          offList = asked;
        } else {
          const ids = new Set(m.kind === "match" ? [m.plan.id] : m.kind === "ambiguous" ? m.plans.map((p) => p.id) : sameAs.map((p) => p.id));
          shown = pool.filter((x) => ids.has(x.view.plan.id));
        }
      }
      const [temps, questions, recent] = await Promise.all([
        listCareEntries(s, { kinds: ["temp"], limit: 1 }),
        listCareEntries(s, { kinds: ["question"], limit: 200 }),
        listCareEntries(s, { kinds: ["dose"], from: new Date(s.now.getTime() - 2 * DAY) }),
      ]);
      // One-time medicines from the last two days (they belong to no plan, so no plan line shows them).
      const oneOffs = recent
        .filter((d): d is DoseEntry => d.kind === "dose" && d.med_id == null && !d.data.skipped)
        .filter((d) => !offList || normName(d.data.name).includes(normName(offList)) || normName(offList).includes(normName(d.data.name)))
        .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
      const temp = temps[0]?.kind === "temp" ? temps[0] : null;
      const open = questions.filter((q) => q.kind === "question" && !q.data.done);
      const team = s.person?.settings.care_team ?? {};
      const care_team = { ob: team.ob ?? null, after_hours: team.after_hours ?? null, pharmacy: team.pharmacy ?? null, therapist: team.therapist ?? null };

      const whose = s.access.self ? "Your" : `${s.name}'s`;
      const her = s.access.self ? "your" : "her";
      const lines: string[] = [];
      if (sameAs.length) lines.push(`"${asked}" is the same medicine as ${listNames(sameAs.map((p) => p.name))} on ${her} list${sameAs.length === 1 ? ", so a dose by either name counts toward it" : ""}.`);
      if (offList) lines.push(`"${offList}" isn't on ${her} list.`);
      if (!shown.length) lines.push(`${whose} medicine list is empty so far. Medicines are added in the app (or with set_mom_medicine or add_mom_medicines) from her label or discharge papers.`);
      else lines.push(`${whose} medicines, by the schedule the family typed in from ${her} label or clinician:`, ...shown.map((x) => `- ${fullSentence(x.view)}`));
      // A reading from today keeps its card (a fever makes the breast and peeing signs urgent too).
      const tempAlert = temp && dayKey(new Date(temp.at), s.tz) === dayKey(s.now, s.tz) ? assessMomTemp(temp.data.temp_c) : null;
      if (oneOffs.length) {
        lines.push(`One-time medicines in the last two days: ${oneOffs.slice(0, 10).map((d) => `${d.data.name}${d.data.dose ? ` ${d.data.dose}` : ""} at ${whenText(d.at, ctx)} (${memberName(d.created_by, ctx.members)}, c${d.id})`).join("; ")}.`);
      } else if (offList) lines.push(`No one-time doses of it in the last two days.`);
      if (temp) lines.push(`Latest temperature: ${tempText(temp.data.temp_c)} at ${whenText(temp.at, ctx)}.`);
      if (open.length) lines.push(`Open questions for ${her} OB: ${open.map((q) => `"${q.note ?? ""}"`).join("; ")}.`);
      // The app's list note (two medicines with acetaminophen) too, over the whole active list as it reads there.
      const overlap = listNotes(
        active.map((x) => x.view.plan),
        { name: s.name, self: s.access.self, settings: s.person?.settings ?? {} }
      );
      const alerts = alertsOf([...overlap, ...shown.flatMap((x) => x.view.notes), ...(tempAlert ? [forMom(tempAlert, s.name, s.access.self)] : [])]);
      lines.push(...alertLines(alerts));
      const speak = shown.length ? `${shown.slice(0, 3).map((x) => spokenLine(x.view, s.now, s.tz)).join(". ")}.` : `No medicines on ${her} list yet.`;
      return ok(lines.join("\n"), {
        name: s.name,
        self: s.access.self,
        now: { local: whenText(s.now, ctx), iso: isoLocal(s.now, s.tz) },
        plans: shown.map((x) => planJson(x, ctx, days)),
        one_offs: oneOffs.map((d) => doseJson(d, ctx)),
        ...(offList ? { not_on_list: offList } : {}),
        ...(sameAs.length ? { same_medicine: { asked, plans: sameAs.map((p) => p.name) } } : {}),
        temp: temp ? { id: `c${temp.id}`, temp_f: Math.round(cToF(temp.data.temp_c) * 10) / 10, temp_c: temp.data.temp_c, local: whenText(temp.at, ctx) } : null,
        questions_open: open.map((q) => ({ id: `c${q.id}`, text: q.note, added: whenText(q.at, ctx), by: memberName(q.created_by, ctx.members) })),
        care_team,
        alerts,
        help: MOM_HELP,
        disclaimer: MOM_DISCLAIMER,
        speak,
      });
    }
  );

  addCareTool(
    server,
    "log_mom_medicine",
    {
      title: `Log a dose of ${MOM}'s medicine`,
      description: `Log a dose of ${MOM}'s own medicine (she's Maple's mom; Maple's medicines use log_medicine). Use it whenever the dose was ${MOM}'s: "${MOM}", "mom", "my wife", or "I" when she's the one talking. "She" and "her" mean Maple: when the medicine named is on ${MOM}'s list (by its name, an Also called name, or its brand or generic name) and the user didn't say whose dose it was, ask "Maple's or ${MOM}'s?" before logging, and use this tool only once they say ${MOM}'s. It saves, like Maple's log: a name on her list counts toward that medicine, so does its brand or generic name (acetaminophen for Tylenol on her list), and any other name is saved as a one-time medicine. Pass \`units\` (how many tablets, caplets, capsules or mL) only if the user said it, and \`dose\` only if they said something different from her plan; never fill either in. created:false with possible_duplicate means someone logged the same medicine within 30 minutes: ask whether it's another dose, and only then call again with allow_duplicate: true. If it was early or over her limit it still saves; repeat the result's alerts word for word with their labels.`,
      inputSchema: {
        medicine: z.string().min(1).max(80).describe("The medicine as the user said it: a name or also-called name on her list, its brand or generic name, or its p id."),
        at: inputs.at("When she took it"),
        minutes_ago: inputs.minutesAgo(),
        skipped: z.boolean().nullish().describe("True when she skipped a scheduled dose (it fills the slot and never counts as a dose)."),
        units: z
          .number()
          .positive()
          .max(1000)
          .nullish()
          .describe("How many tablets, caplets, capsules or mL she took this time, only as the user said it. Never guess or fill it in; left out, the result says what it counted as toward her limit."),
        dose: z.string().max(80).nullish().describe("Only if the user said she took something different from her plan's dose, in their words. Never fill it in."),
        note: z.string().max(500).nullish().describe("Optional short note in the family's own words."),
        one_off: z.boolean().nullish().describe("True when the user said it's a different medicine from the one on her list with that name: it's logged as a one-time medicine by the name given."),
        client_ref: inputs.clientRef(),
        allow_duplicate: inputs.allowDuplicate(),
      },
      annotations: WRITE_ANN,
      invoking: `Noting ${MOM}'s medicine…`,
      invoked: `${MOM}'s medicine noted`,
      write: true,
    },
    async (a, ctx, s) => {
      const r = await momDose(a, ctx, s);
      return ok(r.summary, r.data);
    }
  );

  addCareTool(
    server,
    "set_mom_medicine",
    {
      title: `Add or change ${MOM}'s medicine`,
      description: `Add, change, stop or delete one medicine on ${MOM}'s list (she's Maple's mom). ${FROM_PAPER} Leave any field empty that the user didn't say and the paper doesn't print. A 24-hour limit needs limit_unit exactly as the label counts it (tablets, caplets, capsules, doses or mL); with no unit printed, leave the limit out and say so. Several at once (a discharge list): add_mom_medicines.`,
      inputSchema: {
        id: z.string().max(20).nullish().describe("To change, stop or delete one: its p id from mom_status. Leave out to add a new one."),
        name: z.string().max(80).nullish().describe("The medicine's name as on the label (needed to add one)."),
        ...planFields(),
        stop: z.boolean().nullish().describe("True to stop it (it moves to Finished, with its history); false to take a finished one again. Needs id."),
        delete: z.boolean().nullish().describe("True to delete a plan added by mistake (its logged doses stay). Needs id."),
        restore: z.boolean().nullish().describe("True to bring back a deleted plan, with its history. Needs id."),
        separate: z
          .boolean()
          .nullish()
          .describe("Adding one that's already on her list (by name or as the same medicine): true only when the user says it's a second, separate plan."),
      },
      annotations: { ...WRITE_ANN, destructiveHint: true },
      invoking: `Updating ${MOM}'s list…`,
      invoked: `${MOM}'s list updated`,
      write: true,
    },
    async (a, ctx, s) => {
      const source = ctx.who.via;
      const id = a.id?.trim() ? planId(a.id) : null;
      if ((a.stop != null || a.delete || a.restore) && id == null) throw new ToolError("To stop, delete or bring back a medicine, pass its id (p…) from mom_status.");
      if (a.restore && id != null) {
        const plan = await deleteCarePlan(s, id, true);
        return ok(`Brought back p${plan.id}: ${plan.name}, with its history.`, { restored: true, id: `p${plan.id}`, name: plan.name });
      }
      if (a.stop === false && id != null) {
        const plan = await stopCarePlan(s, id, false);
        return ok(`Taking p${plan.id} again: ${plan.name}. It's back on her list, with its history.`, { stopped: false, id: `p${plan.id}`, name: plan.name });
      }
      if (a.delete && id != null) {
        const plan = await deleteCarePlan(s, id);
        return ok(`Deleted p${plan.id}: ${plan.name}. Doses already logged stay in her history.`, { deleted: true, id: `p${plan.id}`, name: plan.name });
      }
      if (a.stop && id != null) {
        const plan = await stopCarePlan(s, id, true);
        return ok(`Stopped p${plan.id}: ${plan.name}. It moved to Finished, with its history.`, { stopped: true, id: `p${plan.id}`, name: plan.name });
      }
      // A medicine she already has (by name, or the same one by another name): change that one, not a second plan
      // whose doses would be counted apart.
      if (id == null && !a.separate) {
        const there = alreadyOnList(a, (await visiblePlans(s)).filter((p) => planActive(p, s.now, s.tz)));
        if (there) {
          const what = there.same ? `the same medicine as ${there.plan.name} (p${there.plan.id})` : `already on ${s.access.self ? "your" : "her"} list as p${there.plan.id} (${there.plan.name})`;
          throw new ToolError(`Not added: ${a.name?.trim() || "that"} is ${what}. To change it, call again with id p${there.plan.id}; only if the user says it's a second, separate plan, add it with separate: true.`);
        }
      }
      // Show on Today is gone (her strip shows her most pressing medicine by one rule): nothing here sets it.
      const r = await savePlan(a, id, s, source);
      const alerts = alertsOf(r.notes);
      const { plan } = r;
      return ok([...r.lines, ...alertLines(alerts)].join("\n"), {
        saved: true,
        id: `p${plan.id}`,
        name: plan.name,
        schedule_text: scheduleSummary(plan),
        dose_text: plan.dose_text,
        max24: plan.max_24h,
        limit_unit: plan.limit_unit,
        units_per_dose: plan.units_per_dose,
        ...(r.missing ? { not_on_file: r.missing } : {}),
        alerts,
      });
    }
  );

  addCareTool(
    server,
    "add_mom_medicines",
    {
      title: `Add ${MOM}'s medicines from her papers`,
      description: `Add several medicines to ${MOM}'s list at once (she's Maple's mom), like the lines of her discharge papers: one call for the whole list, after the user says yes to your read-back. ${FROM_PAPER} Leave any field empty that the user didn't say and the paper doesn't print; a 24-hour limit needs limit_unit exactly as the label counts it. A name already on her list is left as it is (change it with set_mom_medicine). Each saved line says what isn't on file.`,
      inputSchema: {
        medicines: z
          .array(
            z.object({
              name: z.string().min(1).max(80).describe("The medicine's name as printed or as the user said it."),
              ...planFields(),
            })
          )
          .min(1)
          .max(12)
          .describe("Each medicine as printed or read out, in the paper's order."),
        read_back_confirmed: z
          .literal(true)
          .describe("True only after you read every medicine and every number on this list back to the user and they said yes to it."),
      },
      annotations: WRITE_ANN,
      invoking: `Adding ${MOM}'s medicines…`,
      invoked: `${MOM}'s medicines added`,
      write: true,
    },
    async (a, ctx, s) => {
      // The schema says so too; this holds for any client that doesn't check it.
      if (a.read_back_confirmed !== true) {
        throw new ToolError("Nothing was saved. Read every medicine and number on the list back to the user first, then call again with read_back_confirmed: true once they say yes.");
      }
      const source = ctx.who.via;
      const have = (await visiblePlans(s)).filter((p) => planActive(p, s.now, s.tz));
      const her = s.access.self ? "your" : "her";
      const lines: string[] = [];
      const notes: Assessment[] = [];
      const results: Record<string, unknown>[] = [];
      let stopped = false;
      for (const m of a.medicines) {
        const name = m.name.trim();
        if (stopped) {
          lines.push(`Not saved: ${name} (Maple's Log couldn't reach its database). Calling again is safe: lines already saved are skipped.`);
          results.push({ name, saved: false, reason: "unavailable" });
          continue;
        }
        // Already on her list by that name, an Also called one, or as the same medicine by another name: left as it is, never a second plan.
        const found = alreadyOnList(m, have);
        if (found) {
          const there = found.plan;
          const sched = scheduleSummary(there).replace(/^./, (c) => c.toLowerCase());
          const as = found.same ? `the same medicine as ${there.name} on ${her} list (p${there.id} · ${sched})` : `already on ${her} list as p${there.id} (${there.name} · ${sched})`;
          lines.push(`${name}: ${as}, so it was left as it is. Change it with set_mom_medicine.`);
          results.push({ name, saved: false, reason: found.same ? "same_medicine" : "on_list", id: `p${there.id}` });
          continue;
        }
        try {
          const r = await savePlan(m, null, s, source);
          lines.push(...r.lines);
          notes.push(...r.notes);
          have.push(r.plan);
          results.push({ saved: true, ...planOut(r.plan), ...(r.missing ? { not_on_file: r.missing } : {}) });
        } catch (err) {
          // One line the model can fix (no unit for a limit, a count over it): the rest still save.
          const why = err instanceof ToolError ? err.message : userFacing(err) ? err.message : null;
          if (why != null) {
            lines.push(`Not saved: ${name}: ${why.replace(/\.$/, "")}.`);
            results.push({ name, saved: false, reason: why });
            continue;
          }
          // Anything else before a line saved: nothing was saved (careToolError says so). After one: say which did.
          if (!results.some((x) => x.saved)) throw err;
          void captureServerException(new Error(errorCode(err)), { route: ROUTE });
          stopped = true;
          lines.push(`Not saved: ${name} (Maple's Log couldn't reach its database). Calling again is safe: lines already saved are skipped.`);
          results.push({ name, saved: false, reason: "unavailable" });
        }
      }
      const saved = results.filter((r) => r.saved).length;
      const alerts = alertsOf(notes);
      const head = `Added ${saved} of ${a.medicines.length} to ${s.access.self ? "your" : `${s.name}'s`} list.`;
      return ok([head, ...lines, ...alertLines(alerts)].join("\n"), { saved, of: a.medicines.length, medicines: results, alerts });
    }
  );

  addCareTool(
    server,
    "log_mom_temperature",
    {
      title: `Log ${MOM}'s temperature`,
      description: `Log ${MOM}'s temperature (she's Maple's mom; Maple's temperature uses log_temperature). Repeat the result's alert word for word with its label.`,
      inputSchema: {
        temp_f: z.number().min(80).max(115).nullish().describe("The reading in °F, as the user said it."),
        temp_c: z.number().min(25).max(46).nullish().describe("Or the reading in °C, as the user said it."),
        at: inputs.at("When it was taken"),
        minutes_ago: inputs.minutesAgo(),
        client_ref: inputs.clientRef(),
      },
      annotations: WRITE_ANN,
      invoking: `Noting ${MOM}'s temperature…`,
      invoked: `${MOM}'s temperature noted`,
      write: true,
    },
    async (a, ctx, s) => {
      if ((a.temp_f == null) === (a.temp_c == null)) throw new ToolError("Give the reading once: temp_f or temp_c.");
      const c = a.temp_c ?? fToC(a.temp_f!);
      if (c < 30 || c > 45) throw new ToolError(`${a.temp_f ?? a.temp_c}°${a.temp_f != null ? "F" : "C"} doesn't look like a body temperature. Check the number and unit.`);
      const assumed: string[] = [];
      const at = timeArg(a, ctx, assumed);
      const res = await logCareTemp(s, { tempC: Math.round(c * 1000) / 1000, at: at.toISOString(), clientId: clientIdFor(ctx, a.client_ref), source: ctx.who.via });
      const e = res.entry!;
      const shown = e.kind === "temp" ? tempText(e.data.temp_c) : "";
      const alerts = alertsOf(res.notes);
      const head = res.deduped ? `Already saved c${e.id}: ${shown} at ${whenText(e.at, ctx)}, so it wasn't added twice.` : `Saved c${e.id}: ${shown} at ${whenText(e.at, ctx)}.`;
      return ok([head, ...assumedLines(assumed), ...alertLines(alerts)].join("\n"), {
        created: !!res.created,
        ...(res.deduped ? { deduped: true } : {}),
        id: `c${e.id}`,
        temp_f: e.kind === "temp" ? Math.round(cToF(e.data.temp_c) * 10) / 10 : null,
        local: whenText(e.at, ctx),
        alerts,
      });
    }
  );

  addCareTool(
    server,
    "add_mom_question",
    {
      title: `Add a question for ${MOM}'s OB`,
      description: `Add a question for ${MOM}'s OB (she's Maple's mom; Maple's pediatrician questions use add_doctor_question).`,
      inputSchema: {
        text: z.string().min(2).max(1000).describe("The question, in the family's own words."),
        client_ref: inputs.clientRef(),
      },
      annotations: WRITE_ANN,
      invoking: `Adding to ${MOM}'s OB list…`,
      invoked: "Question added",
      write: true,
    },
    async (a, ctx, s) => {
      const { entry, deduped } = await addCareQuestion(s, { text: a.text, clientId: clientIdFor(ctx, a.client_ref), source: ctx.who.via });
      const whose = s.access.self ? "your" : "her";
      return ok(deduped ? `Already saved c${entry.id}: question for ${whose} OB.` : `Saved c${entry.id}: question for ${whose} OB.`, {
        created: !deduped,
        ...(deduped ? { deduped: true } : {}),
        id: `c${entry.id}`,
        text: entry.note,
      });
    }
  );

  addCareTool(
    server,
    "fix_mom_entry",
    {
      title: `Fix one of ${MOM}'s entries`,
      description:
        `Change, delete or restore one of ${MOM}'s entries by its c… id: a dose, temperature or question. Plans are changed with set_mom_medicine.`,
      inputSchema: {
        id: z.string().max(20).describe("The entry's c id, from mom_status or the result that saved it."),
        action: z.enum(["update", "delete", "restore"]).describe("update, delete, or restore (brings a deleted one back)."),
        at: inputs.at("update: the corrected time"),
        minutes_ago: z.number().min(0).max(4320).nullish().describe("update: the corrected time as how many minutes ago, as the user said it. Use instead of at."),
        units: z.number().positive().max(1000).nullish().describe("update, a dose: how many she took, only as the user said it."),
        dose: z.string().max(80).nullish().describe("update, a dose: the dose if it differed from her plan, in the user's words."),
        skipped: z.boolean().nullish().describe("update, a dose: true if it was skipped, false if she took it."),
        note: z.string().max(1000).nullish().describe("update: the note (for a question, the question itself)."),
        done: z.boolean().nullish().describe("update, a question: true once it's been asked."),
        answer: z.string().max(1000).nullish().describe("update, a question: what her OB said, in the family's words."),
      },
      annotations: { ...WRITE_ANN, destructiveHint: true },
      invoking: `Fixing ${MOM}'s entry…`,
      invoked: `${MOM}'s entry fixed`,
      write: true,
    },
    async (a, ctx, s) => {
      const id = entryId(a.id);
      const what = (e: CareEntry) =>
        e.kind === "dose"
          ? `${e.data.name}${e.data.skipped ? " skipped" : ""} at ${whenText(e.at, ctx)}`
          : e.kind === "temp"
            ? `${tempText(e.data.temp_c)} at ${whenText(e.at, ctx)}`
            : `question for ${s.access.self ? "your" : "her"} OB${e.data.done ? " (asked)" : ""}`;
      if (a.action === "delete") {
        const e = await deleteCareEntry(s, id);
        return ok(`Deleted c${id}: ${what(e)}. To bring it back, use fix_mom_entry with action restore.`, { deleted: true, id: `c${id}` });
      }
      if (a.action === "restore") {
        const e = await restoreCareEntry(s, id);
        return ok(`Restored c${id}: ${what(e)}.`, { restored: true, id: `c${id}` });
      }
      const cur = await readableEntry(s, id);
      const patch: CareEntryPatch = {};
      const assumed: string[] = [];
      // at or minutes_ago (startFrom refuses both); neither leaves the time as it is.
      if (a.at || a.minutes_ago != null) patch.at = timeArg({ at: a.at, minutes_ago: a.minutes_ago }, ctx, assumed).toISOString();
      const data: Record<string, unknown> = {};
      if (cur.kind === "dose") {
        if (a.units != null) data.units = a.units;
        if (a.dose != null) data.dose = a.dose;
        if (a.skipped != null) data.skipped = a.skipped;
      } else if (cur.kind === "question") {
        if (a.done != null) data.done = a.done;
        if (a.answer != null) data.answer = a.answer;
      }
      const wrong = cur.kind !== "dose" && (a.units != null || a.dose != null || a.skipped != null) ? "units, dose and skipped are for doses" : cur.kind !== "question" && (a.done != null || a.answer != null) ? "done and answer are for questions" : null;
      if (wrong) throw new ToolError(`c${id} is a ${cur.kind === "temp" ? "temperature" : cur.kind}: ${wrong}.`);
      if (Object.keys(data).length) patch.data = data;
      if (a.note != null) patch.note = a.note;
      if (!patch.at && !patch.data && patch.note === undefined) throw new ToolError("Nothing to change: pass at or minutes_ago, units, dose, skipped, note, done or answer.");
      const r = await updateCareEntry(s, id, patch);
      const alerts = alertsOf(r.notes);
      return ok([`Updated c${id}: ${what(r.entry)}.`, ...assumedLines(assumed), ...alertLines(alerts)].join("\n"), {
        updated: true,
        id: `c${id}`,
        ...(r.entry.kind === "dose" ? { entry: doseJson(r.entry, ctx) } : {}),
        alerts,
      });
    }
  );
}

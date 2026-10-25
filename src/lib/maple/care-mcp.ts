import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureServerException } from "@/lib/posthog-server";
import { ADMIN_ID } from "./auth";
import { careTime, forMom, hoursText, listNotes, matchPlan, planActive, planMeta, planSentence, planView, scheduleSummary, sortPlans, unitCount, unitsOf, unreviewed, type CareViewer, type PlanView } from "./care";
import {
  CareConflict,
  CareForbidden,
  addCareQuestion,
  careSession,
  carePersonName,
  createCarePerson,
  deleteCarePlan,
  deleteCareEntry,
  eligible,
  getCarePerson,
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
import { memberName } from "./insights";
import { READ_ANN, ToolError, VIEWER_MESSAGE, WRITE_ANN, context, fail, isoLocal, ok, startFrom, whenText, type Annotations, type Ctx, type Extra } from "./mcp-tools";
import { NotFound, StoreUnavailable } from "./store";
import { addDays, dayKey } from "./time";
import type { CareEntry, CarePlan, DoseEntry, MedReason, MedSchedule, PlanInput, Source } from "./types";
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
 * - Ids print as c12345678 (entries) and p12345678 (plans): Maple's tools
 *   take plain numbers, so neither set reaches the other's rows.
 * - Every number comes from her plan, typed by the family from her label or
 *   clinician. Input descriptions carry no digits and forbid filling in,
 *   suggesting or inferring a dose, interval, limit or count.
 * - Alerts are guidelines.ts copy, labelled with who to call (MOM_TIER_LABEL,
 *   or the alert's own label) and prefixed "For {Name}: " for anyone but her.
 * - Access errors end with HELP_NOW_LINE and carry help_now. Anything
 *   unexpected is reported as new Error(code) with { route } only: Postgres
 *   messages can hold row data.
 */

const ROUTE = "/api/maple/mcp";
const DAY = 86400_000;

// ── who's asking ────────────────────────────────────────────────────────

/** An access problem: its text gets HELP_NOW_LINE and the result help_now. */
class CareAccessError extends Error {}

async function careFor(ctx: Ctx): Promise<CareSession> {
  const viewer: CareViewer = { id: ctx.who.id, role: ctx.who.role, viaAdmin: ctx.who.viaAdmin, channel: "mcp" };
  return careSession(viewer, { members: ctx.members, baby: ctx.baby });
}

/** The access errors: a viewer, or no page yet. Everyone else can do everything here. */
function needAccess(ctx: Ctx, s: CareSession, write: boolean) {
  if (ctx.who.role === "viewer") throw new CareAccessError(VIEWER_MESSAGE);
  if (!s.person) throw new CareAccessError("There's no page for mom in Maple's Log yet. set_up_mom creates it, or someone can in the app under Family.");
  if (!s.access.read || (write && !s.access.write)) throw new CareAccessError("You can't change her medicines from this account.");
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
    checked_against_label: !unreviewed(p),
    notes: alertsOf(v.notes),
    ...(days > 0 ? { doses: doses.filter((d) => Date.parse(d.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((d) => doseJson(d, ctx)) } : {}),
  };
}

/**
 * "Ibuprofen: OK after 8:10 AM, by her schedule. Last: 2:10 AM · Matt. 1 of 4 tablets in the last 24 hours."
 * An assistant-added plan nobody has checked ends " · not checked against the label", as its line does.
 */
const fullSentence = (v: PlanView) =>
  `${v.plan.name}: ${[v.sentence, ...v.meta].map((t) => t.replace(/\.$/, "")).join(". ")}${unreviewed(v.plan) ? " · not checked against the label" : ""}.`;

/** "Acetaminophen: OK since 4:10 AM" (speak; and Siri's). */
export function spokenLine(v: PlanView, now: Date, tz: string): string {
  const line = spokenStatus(v, now, tz);
  // As on the compact line: an assistant-added plan nobody has checked yet says so out loud too.
  return unreviewed(v.plan) ? `${line} (not checked against the label)` : line;
}

function spokenStatus(v: PlanView, now: Date, tz: string): string {
  const st = v.status;
  const at = (iso: string | null | undefined) => (iso ? careTime(iso, now, tz) : "");
  const n = v.plan.name;
  switch (st.state) {
    case "wait":
      return `${n}: OK after ${at(st.nextOkAt)}`;
    case "ok":
      return `${n}: OK since ${at(st.gapOkAt)}`;
    case "at_limit":
      return `${n}: ${st.count24} of ${unitCount(st.max24 ?? 0, st.unit)} in 24 hours, OK after ${at(st.nextOkAt)}`;
    case "unknown":
      return `${n}: last one at ${at(st.last?.at)}`;
    case "none":
      return `${n}: none logged yet`;
    case "day_open":
    case "day_done":
    case "slot_open":
    case "slot_next":
      return `${n}: ${v.sentence.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`;
    default:
      return `${n}: ${v.sentence.replace(/\.$/, "")}`;
  }
}

const listNames = (names: string[]) => (names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** "Her list has Ibuprofen and Acetaminophen." / "Her list is empty." */
function listLine(s: CareSession, plans: CarePlan[]): string {
  const whose = s.access.self ? "Your" : "Her";
  return plans.length ? `${whose} list has ${listNames(plans.map((p) => p.name))}.` : `${whose} list is empty so far.`;
}

/** One of her active plans by name, Also called or p id; anything else is an error that lists her medicines. */
function pickPlan(query: string, s: CareSession, active: Viewed[]): Viewed {
  const m = matchPlan(query, active.map((x) => x.view.plan), { includePrivate: false });
  if (m.kind === "match") return active.find((x) => x.view.plan.id === m.plan.id)!;
  if (m.kind === "ambiguous") throw new ToolError(`"${query}" could be ${listNames(m.plans.map((p) => p.name))}. Ask which one, then pass its name or id.`);
  throw new ToolError(`I couldn't find "${query}" in ${s.access.self ? "your" : `${s.name}'s`} medicines. ${listLine(s, active.map((x) => x.view.plan))} Ask which one; for a one-time medicine not on the list, pass one_off: true.`);
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
      .describe("Only after the user confirms she really took it (a second dose, early by her schedule, or over her limit): true saves it anyway."),
};

const HOW = ["as_needed", "every", "daily", "times"] as const;
const REASONS = ["pain", "constipation", "bp", "iron", "infection", "mood", "vitamin", "other"] as const;
const UNITS = ["tablets", "caplets", "capsules", "doses", "mL"] as const;

// ── the tools ───────────────────────────────────────────────────────────

/**
 * Her mom's line for maple_status ("Brittany: Ibuprofen OK after 9:10 AM"):
 * the first Show on Today plan by sortPlans, never an Only me one, and only
 * for someone who can read her medicines. Null otherwise, or on any error
 * (Maple's status never waits on hers).
 */
export async function momStatusLine(ctx: Ctx): Promise<string | null> {
  try {
    const s = await careFor(ctx);
    if (!s.person || !s.access.read || ctx.who.role === "viewer") return null;
    const { active } = await viewsFor(s);
    const v = active.find((x) => x.view.plan.show_on_today);
    return v ? `${s.name}: ${v.view.line}` : null;
  } catch (err) {
    await captureServerException(new Error(errorCode(err)), { route: ROUTE });
    return null;
  }
}

export function registerCareTools(server: McpServer) {
  // Before her page exists there's no care session to check, so this one does the app's own rule (POST
  // /api/maple/care/person): she can set it up for herself, or an owner can for her; one per log.
  const setUpTitle = "Set up her mom's medicines page";
  server.registerTool(
    "set_up_mom",
    {
      title: setUpTitle,
      description:
        'Use this when the mom tools say there\'s no page for her yet and the user wants one, e.g. "set up Brittany\'s medicines". It creates her page in Maple\'s Log for one family member; there\'s one per log, and everyone signed in can see and log on it. Then add each medicine with set_mom_medicine.',
      inputSchema: {
        person: z.string().min(1).max(120).nullish().describe("Who it's for: a family member's name or email. Leave it out to set it up for yourself."),
      },
      annotations: { title: setUpTitle, ...WRITE_ANN },
      _meta: { "openai/toolInvocation/invoking": "Setting up her page…", "openai/toolInvocation/invoked": "Her page is set up" },
    },
    (async (a: { person?: string | null }, extra: Extra): Promise<CallToolResult> => {
      try {
        const ctx = await context(extra);
        if (ctx.who.role === "viewer") throw new CareAccessError(VIEWER_MESSAGE);
        // The admin login logging as nobody is the family's password: it sets up like an owner, for someone it names.
        const admin = ctx.who.id === ADMIN_ID;
        const member = ctx.members.find((m) => m.email === ctx.who.id);
        const caller = admin ? { email: ADMIN_ID, role: "owner" as const } : eligible(member) ? member : null;
        if (!caller) throw new CareForbidden("Only a family member can set this up.");
        const pool = ctx.members.filter(eligible);
        let target: { email: string } = caller;
        const asked = a.person?.trim().toLowerCase();
        if (admin && !asked) throw new ToolError(`Who is it for? Pass person: ${pool.map((m) => memberName(m.email, ctx.members)).join(", ")}.`);
        if (asked) {
          const name = (m: (typeof pool)[number]) => memberName(m.email, ctx.members).toLowerCase();
          const hits = pool.filter((m) => m.email.toLowerCase() === asked || name(m) === asked || name(m).split(" ")[0] === asked);
          const names = pool.map((m) => memberName(m.email, ctx.members)).join(", ");
          if (!hits.length) throw new ToolError(`I couldn't find "${a.person}" among the family members who can have one: ${names}.`);
          if (hits.length > 1) throw new ToolError(`"${a.person}" matches more than one person: ${hits.map((m) => memberName(m.email, ctx.members)).join(", ")}. Which one?`);
          target = hits[0];
        }
        const who = memberName(target.email, ctx.members);
        const existing = await getCarePerson();
        if (existing) {
          if (existing.member === target.email) return ok(`${who}'s medicines page is already set up. Add medicines with set_mom_medicine.`, { created: false, for: who });
          throw new ToolError(`Maple's Log already has a page for ${carePersonName(existing, ctx.members)}, and there's one per log.`);
        }
        await createCarePerson(target.email, caller.email, ctx.members);
        return ok(`Set up ${who}'s medicines page. Next, add each medicine with set_mom_medicine, typed from her label or discharge papers.`, { created: true, for: who });
      } catch (err) {
        return careToolError("set_up_mom", err);
      }
    }) as unknown as ToolCallback<{ person: z.ZodOptional<z.ZodNullable<z.ZodString>> }>
  );

  addCareTool(
    server,
    "mom_status",
    {
      title: "Her mom's medicines right now",
      description:
        'Her mom\'s own medicines, from the plan the family typed in from her label or clinician: for each, when it was last taken and by whom, when her schedule next allows it, how many in the last 24 hours against her own limit (in the label\'s unit), and the course day. Also her latest temperature, open questions for her OB, her care-team numbers and help lines. Answer "can she take X yet?" only from this, using the line given. Never say whether a medicine is safe while nursing and never suggest a dose, interval or limit: suggest her OB, Maple\'s pediatrician or a pharmacist.',
      inputSchema: {
        medicine: z.string().max(80).nullish().describe("Optional: one medicine, by its name, an also-called name or its p id (finished ones too)."),
        days: z.number().int().min(0).max(7).nullish().describe("Optional: how many days of dose history to include for each medicine, up to a week. Leave out for none."),
      },
      annotations: READ_ANN,
      invoking: "Checking her medicines…",
      invoked: "Her medicines checked",
    },
    async (a, ctx, s) => {
      const days = a.days ?? 0;
      const { active, finished } = await viewsFor(s, days);
      let shown = active;
      if (a.medicine?.trim()) {
        const pool = [...active, ...finished];
        const m = matchPlan(a.medicine, pool.map((x) => x.view.plan), { includePrivate: false });
        if (m.kind === "none") throw new ToolError(`I couldn't find "${a.medicine}" in ${s.access.self ? "your" : `${s.name}'s`} medicines. ${listLine(s, active.map((x) => x.view.plan))}`);
        const ids = new Set(m.kind === "match" ? [m.plan.id] : m.plans.map((p) => p.id));
        shown = pool.filter((x) => ids.has(x.view.plan.id));
      }
      const [temps, questions] = await Promise.all([
        listCareEntries(s, { kinds: ["temp"], limit: 1 }),
        listCareEntries(s, { kinds: ["question"], limit: 200 }),
      ]);
      const temp = temps[0]?.kind === "temp" ? temps[0] : null;
      const open = questions.filter((q) => q.kind === "question" && !q.data.done);
      const team = s.person?.settings.care_team ?? {};
      const care_team = { ob: team.ob ?? null, after_hours: team.after_hours ?? null, pharmacy: team.pharmacy ?? null, therapist: team.therapist ?? null };

      const whose = s.access.self ? "Your" : `${s.name}'s`;
      const lines: string[] = [];
      if (!shown.length) lines.push(`${whose} medicine list is empty so far. Medicines are added in the app (or with set_mom_medicine) from her label or discharge papers.`);
      else lines.push(`${whose} medicines, by the schedule the family typed in from ${s.access.self ? "your" : "her"} label or clinician:`, ...shown.map((x) => `- ${fullSentence(x.view)}`));
      // A reading from today keeps its card (a fever makes the breast and peeing signs urgent too).
      const tempAlert = temp && dayKey(new Date(temp.at), s.tz) === dayKey(s.now, s.tz) ? assessMomTemp(temp.data.temp_c) : null;
      if (temp) lines.push(`Latest temperature: ${tempText(temp.data.temp_c)} at ${whenText(temp.at, ctx)}.`);
      if (open.length) lines.push(`Open questions for ${s.access.self ? "your" : "her"} OB: ${open.map((q) => `"${q.note ?? ""}"`).join("; ")}.`);
      // The app's list note (two medicines with acetaminophen) too, over the whole active list as it reads there.
      const overlap = listNotes(
        active.map((x) => x.view.plan),
        { name: s.name, self: s.access.self, settings: s.person?.settings ?? {} }
      );
      const alerts = alertsOf([...overlap, ...shown.flatMap((x) => x.view.notes), ...(tempAlert ? [forMom(tempAlert, s.name, s.access.self)] : [])]);
      lines.push(...alertLines(alerts));
      const speak = shown.length ? `${shown.slice(0, 3).map((x) => spokenLine(x.view, s.now, s.tz)).join(". ")}.` : `No medicines on ${s.access.self ? "your" : "her"} list yet.`;
      return ok(lines.join("\n"), {
        name: s.name,
        self: s.access.self,
        now: { local: whenText(s.now, ctx), iso: isoLocal(s.now, s.tz) },
        plans: shown.map((x) => planJson(x, ctx, days)),
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
      title: "Log a dose of her mom's medicine",
      description:
        "Log a dose of her mom's own medicine (not Maple's: Maple's medicines use log_medicine). Match `medicine` to a name or also-called name on her list; on no match the error lists her medicines, so ask which one. If her plan counts its limit in tablets, caplets, capsules or mL and doesn't fix how many each time, pass `units` only as the user said it, and if they didn't say, ask them. Pass `dose` only if the user said something different from her plan. Never fill in a dose. If the result says created:false (too soon by her schedule, at her limit, or someone already logged it), tell the user why and call again with allow_duplicate: true only if they confirm she took it (still passing units, if they gave a count). Repeat the result's alerts word for word with their labels.",
      inputSchema: {
        medicine: z.string().min(1).max(80).describe("The medicine as the user said it: a name or also-called name on her list, or its p id."),
        at: inputs.at("When she took it"),
        minutes_ago: inputs.minutesAgo(),
        skipped: z.boolean().nullish().describe("True when she skipped a scheduled dose (it fills the slot and never counts as a dose)."),
        units: z
          .number()
          .positive()
          .max(1000)
          .nullish()
          .describe("How many tablets, caplets, capsules or mL she took this time, only as the user said it. Never guess or fill it in; if her plan needs it and they didn't say, ask."),
        dose: z.string().max(80).nullish().describe("Only if the user said she took something different from her plan's dose, in their words. Never fill it in."),
        note: z.string().max(500).nullish().describe("Optional short note in the family's own words."),
        one_off: z.boolean().nullish().describe("True when `medicine` isn't on her list: a one-time medicine, logged by the name the user gave."),
        client_ref: inputs.clientRef(),
        allow_duplicate: inputs.allowDuplicate(),
      },
      annotations: WRITE_ANN,
      invoking: "Noting her medicine…",
      invoked: "Her medicine noted",
      write: true,
    },
    async (a, ctx, s) => {
      const assumed: string[] = [];
      const at = timeArg(a, ctx, assumed);
      const { active } = await viewsFor(s);
      const clientId = clientIdFor(ctx, a.client_ref);
      const source = ctx.who.via;
      const whose = s.access.self ? "your" : "her";

      let target: Viewed | null = null;
      if (a.one_off) {
        // A name that is on her list goes there, unless the user said it's something else.
        const m = matchPlan(a.medicine, active.map((x) => x.view.plan), { includePrivate: false });
        if (m.kind === "match" && !a.allow_duplicate) {
          throw new ToolError(
            `"${a.medicine}" matches ${m.plan.name} on ${whose} list. If that's what she took, call again without one_off; if it's something else, call again with one_off and allow_duplicate: true.`
          );
        }
      } else target = pickPlan(a.medicine, s, active);

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
        strict: true,
      });
      const name = plan?.name ?? a.medicine.trim();
      const tctx = textCtx(s);

      if (!res.created && !res.deduped) {
        const st = res.status;
        let why: string;
        const dup = res.possible_duplicate;
        if (res.reason === "recent" && dup) {
          const who = byWord(dup.created_by, ctx);
          why = `${who === "you" ? "You" : who} logged ${name} at ${whenText(dup.at, ctx)}. Is this another dose? Only if she took another one, call again with allow_duplicate: true.`;
        } else if (res.reason === "at_limit" && plan && st) {
          const would = st.count24 + unitsOf({ data: { units: a.units ?? null } } as DoseEntry, plan);
          why = `That would be ${would} of ${unitCount(plan.max_24h ?? 0, plan.limit_unit)} in 24 hours, over ${whose} limit. If she took it anyway, call again with allow_duplicate: true.`;
        } else if (res.reason === "early" && plan && st) {
          const last = st.last ? ` (${byWord(st.last.created_by, ctx)} logged the last one at ${whenText(st.last.at, ctx)})` : "";
          const gap = plan.schedule.type === "as_needed" ? plan.schedule.min_gap_min : plan.schedule.type === "every" ? plan.schedule.every_min : null;
          why = `That's sooner than ${whose} schedule allows${gap ? `: no sooner than every ${hoursText(gap)}` : ""}${last}. If she took it anyway, call again with allow_duplicate: true.`;
        } else if (res.reason === "units" && plan) {
          const unit = plan.limit_unit ?? "doses";
          why = `${s.access.self ? "Your" : "Her"} plan counts ${name} in ${unit} and doesn't fix how many each time${plan.units_per_dose ? ` (it says "${plan.units_per_dose}")` : ""}. Ask how many ${unit} she took, then call again with units.`;
        } else why = "It wasn't saved. Ask the user, then try again.";
        return ok(`Not saved: ${why}`, {
          created: false,
          reason: res.reason ?? null,
          medicine: plan ? { id: `p${plan.id}`, name: plan.name, line: target!.view.line, sentence: st ? planSentence(plan, st, tctx) : target!.view.sentence } : { name },
          ...(dup ? { possible_duplicate: doseJson(dup, ctx) } : {}),
        });
      }

      const entry = res.entry as DoseEntry;
      const who = `logged by ${memberName(entry.created_by, ctx.members)} via ${viaWord(entry.source)}`;
      const lines: string[] = [];
      if (res.deduped) lines.push(`Already saved c${entry.id}: ${name} at ${whenText(entry.at, ctx)} (${who}), so it wasn't added twice.`);
      else lines.push(`Saved c${entry.id}: ${name}${entry.data.skipped ? " skipped" : ""} at ${whenText(entry.at, ctx)} (${who}).`);
      let after: Record<string, unknown> = {};
      if (plan && res.status) {
        const st = res.status;
        const sentence = planSentence(plan, st, tctx).replace(/\.$/, "");
        // Who logged it is already said; the count and course day follow the sentence.
        const meta = planMeta(plan, st, tctx).filter((m) => !m.startsWith("Last:") && !(st.state === "at_limit" && m.includes("in the last 24 hours")));
        lines[0] += ` ${[sentence, ...meta].join(" · ")}.`;
        if (unreviewed(plan)) lines.push(`${s.access.self ? "Your" : "Her"} plan for ${plan.name} isn't checked against the label yet: ask them to check it in the app ("Matches the label").`);
        after = { next_ok_at: st.nextOkAt ? isoLocal(st.nextOkAt, ctx.tz) : null, count24: st.count24, max24: st.max24, limit_unit: plan.limit_unit, sentence: planSentence(plan, st, tctx) };
      }
      const alerts = alertsOf(res.notes);
      lines.push(...assumedLines(assumed), ...alertLines(alerts));
      return ok(lines.join("\n"), {
        created: !!res.created,
        ...(res.deduped ? { deduped: true } : {}),
        entry: doseJson(entry, ctx),
        ...(plan ? { medicine: { id: `p${plan.id}`, name: plan.name } } : { one_off: true }),
        ...after,
        alerts,
      });
    }
  );

  addCareTool(
    server,
    "set_mom_medicine",
    {
      title: "Add or change her mom's medicine",
      description:
        'Add, change, stop or delete a medicine on her mom\'s list. Use only what the user read from her label, discharge papers or clinician. Never fill in, suggest or use a typical dose, interval or limit; leave any field the user didn\'t say empty. A 24-hour limit needs limit_unit exactly as the label counts it (tablets, caplets, capsules, doses or mL). Plans you add show "Check this against the label" in the app until someone confirms them.',
      inputSchema: {
        id: z.string().max(20).nullish().describe("To change, stop or delete one: its p id from mom_status. Leave out to add a new one."),
        name: z.string().max(80).nullish().describe("The medicine's name as on the label (needed to add one)."),
        also_called: z.string().max(80).nullish().describe("Other names the family uses for it, like the brand on the box, comma-separated, only as they said them."),
        dose_text: z.string().max(80).nullish().describe("The dose as prescribed, copied from the label in its words (strength and how many). Never fill it in."),
        how: z.enum(HOW).nullish().describe("How often, as the label says: as_needed, every (every few hours), daily (a number of times a day) or times (set clock times). Needed to add one."),
        min_gap_hours: z
          .number()
          .min(0.25)
          .max(72)
          .nullish()
          .describe("as_needed: the label's \"no sooner than every … hours\", only if the user read it. Leave out if the label doesn't say."),
        every_hours: z.number().min(0.25).max(72).nullish().describe("every: the hours between doses, exactly as the label says."),
        per_day: z.number().int().min(1).max(8).nullish().describe("daily: how many times a day, exactly as the label says."),
        times: z.array(z.string().max(5)).max(8).nullish().describe("times: the set local clock times as HH:MM on a twenty-four-hour clock, as her clinician gave them."),
        max_per_24h: z.number().positive().max(1000).nullish().describe("The label's most in twenty-four hours, only if the user read it, counted in limit_unit. Never a typical number."),
        limit_unit: z.enum(UNITS).nullish().describe("What the label counts its limit in: tablets, caplets, capsules, doses or mL. Needed whenever a limit is given."),
        units_per_dose: z.string().max(20).nullish().describe("How many each time, the way the label says it (a single number or a choice), only if the user read it. Leave out to have them asked each time."),
        label_text: z.string().max(120).nullish().describe("The label's own words for the schedule, copied as written."),
        for: z.enum(REASONS).nullish().describe("What it's for: pain, constipation, bp (blood pressure), iron, infection, mood, vitamin or other."),
        contains_acetaminophen: z.boolean().nullish().describe("Whether its Drug Facts label lists acetaminophen (APAP), only if the user checked."),
        start_date: z.string().max(10).nullish().describe("The course's first day as YYYY-MM-DD (defaults to today)."),
        end_date: z.string().max(10).nullish().describe("The course's last day as YYYY-MM-DD, if the label or clinician gave one."),
        days: z.number().int().min(1).max(365).nullish().describe("Or: the course length in days, as the label says. Use instead of end_date."),
        instructions: z.string().max(120).nullish().describe("Anything else the label says, like taking it with food, in its words."),
        show_on_today: z.boolean().nullish().describe("Show it on Maple's Today screen. Leave out for the app's default."),
        stop: z.boolean().nullish().describe("True to stop it (it moves to Finished, with its history). Needs id."),
        delete: z.boolean().nullish().describe("True to delete a plan added by mistake (its logged doses stay). Needs id."),
      },
      annotations: { ...WRITE_ANN, destructiveHint: true },
      invoking: "Updating her list…",
      invoked: "Her list updated",
      write: true,
    },
    async (a, ctx, s) => {
      const source = ctx.who.via;
      const id = a.id?.trim() ? planId(a.id) : null;
      if ((a.stop || a.delete) && id == null) throw new ToolError("To stop or delete a medicine, pass its id (p…) from mom_status.");
      if (a.delete && id != null) {
        const plan = await deleteCarePlan(s, id);
        return ok(`Deleted p${plan.id}: ${plan.name}. Doses already logged stay in her history.`, { deleted: true, id: `p${plan.id}`, name: plan.name });
      }
      if (a.stop && id != null) {
        const plan = await stopCarePlan(s, id, true);
        return ok(`Stopped p${plan.id}: ${plan.name}. It moved to Finished, with its history.`, { stopped: true, id: `p${plan.id}`, name: plan.name });
      }
      if (a.max_per_24h != null && !a.limit_unit && id == null) {
        throw new ToolError("A 24-hour limit needs limit_unit exactly as the label counts it: tablets, caplets, capsules, doses or mL. Ask the user what the label says.");
      }

      const cur = id != null ? await readablePlan(s, id) : null;
      if (!cur && !a.name?.trim()) throw new ToolError("Give the medicine's name as on the label.");
      if (!cur && !a.how) throw new ToolError("Say how often the label says to take it: as_needed, every, daily or times.");

      // Only what was given: on a change, everything left out stays as it was.
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
      set("show_on_today", a.show_on_today);
      set("course_start", a.start_date);
      set("course_end", a.end_date);

      const scheduleGiven = a.how || a.min_gap_hours != null || a.every_hours != null || a.per_day != null || a.times != null;
      if (scheduleGiven) {
        const type = a.how ?? cur!.schedule.type;
        const prev = cur?.schedule.type === type ? cur.schedule : null;
        const hrs = (h: number | null | undefined) => (h == null ? undefined : Math.round(h * 60));
        let schedule: MedSchedule | Record<string, unknown>;
        if (type === "as_needed") schedule = { type, min_gap_min: hrs(a.min_gap_hours) ?? (prev?.type === "as_needed" ? prev.min_gap_min ?? null : null) };
        else if (type === "every") schedule = { type, every_min: hrs(a.every_hours) ?? (prev?.type === "every" ? prev.every_min : undefined) };
        else if (type === "daily") schedule = { type, per_day: a.per_day ?? (prev?.type === "daily" ? prev.per_day : undefined) };
        else schedule = { type, times: a.times ?? (prev?.type === "times" ? prev.times : undefined) };
        patch.schedule = schedule;
      }
      if (a.days != null) {
        if (a.end_date) throw new ToolError("Give either end_date or days, not both.");
        const start = (patch.course_start as string | undefined) ?? cur?.course_start ?? dayKey(s.now, s.tz);
        patch.course_start = start;
        patch.course_end = addDays(start, a.days - 1);
      }

      const saved = await saveCarePlan(s, { ...(patch as unknown as PlanInput), ...(id != null ? { id } : {}) }, { source });
      const plan = saved.plan;
      const summary = scheduleSummary(plan).replace(/^./, (c) => c.toLowerCase());
      const lines = [`Saved p${plan.id}: ${plan.name} · ${summary}.${unreviewed(plan) ? " Ask them to check it against the label." : ""}`];
      // Two medicines with acetaminophen: the app's list note, said when this save makes (or keeps) the pair.
      const overlap = plan.contains_apap && planActive(plan, s.now, s.tz)
        ? listNotes((await visiblePlans(s)).filter((p) => planActive(p, s.now, s.tz)), { name: s.name, self: s.access.self, settings: s.person?.settings ?? {} })
        : [];
      const alerts = alertsOf([...overlap, ...saved.notes]);
      lines.push(...alertLines(alerts));
      return ok(lines.join("\n"), {
        saved: true,
        id: `p${plan.id}`,
        name: plan.name,
        schedule_text: scheduleSummary(plan),
        dose_text: plan.dose_text,
        max24: plan.max_24h,
        limit_unit: plan.limit_unit,
        units_per_dose: plan.units_per_dose,
        checked_against_label: !unreviewed(plan),
        alerts,
      });
    }
  );

  addCareTool(
    server,
    "log_mom_temperature",
    {
      title: "Log her mom's temperature",
      description: "Log her mom's temperature (Maple's temperature uses log_temperature). Repeat the result's alert word for word with its label.",
      inputSchema: {
        temp_f: z.number().min(80).max(115).nullish().describe("The reading in °F, as the user said it."),
        temp_c: z.number().min(25).max(46).nullish().describe("Or the reading in °C, as the user said it."),
        at: inputs.at("When it was taken"),
        minutes_ago: inputs.minutesAgo(),
        client_ref: inputs.clientRef(),
      },
      annotations: WRITE_ANN,
      invoking: "Noting her temperature…",
      invoked: "Her temperature noted",
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
      title: "Add a question for her mom's OB",
      description: "Add a question for her mom's OB (Maple's pediatrician questions use add_doctor_question).",
      inputSchema: {
        text: z.string().min(2).max(1000).describe("The question, in the family's own words."),
        client_ref: inputs.clientRef(),
      },
      annotations: WRITE_ANN,
      invoking: "Adding to her OB list…",
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
      title: "Fix one of her mom's entries",
      description:
        "Change, delete or restore one of her mom's entries by its c… id: a dose, temperature or question. Plans are changed with set_mom_medicine.",
      inputSchema: {
        id: z.string().max(20).describe("The entry's c id, from mom_status or the result that saved it."),
        action: z.enum(["update", "delete", "restore"]).describe("update, delete, or restore (brings a deleted one back)."),
        at: inputs.at("update: the corrected time"),
        units: z.number().positive().max(1000).nullish().describe("update, a dose: how many she took, only as the user said it."),
        dose: z.string().max(80).nullish().describe("update, a dose: the dose if it differed from her plan, in the user's words."),
        skipped: z.boolean().nullish().describe("update, a dose: true if it was skipped, false if she took it."),
        note: z.string().max(1000).nullish().describe("update: the note (for a question, the question itself)."),
        done: z.boolean().nullish().describe("update, a question: true once it's been asked."),
        answer: z.string().max(1000).nullish().describe("update, a question: what her OB said, in the family's words."),
      },
      annotations: { ...WRITE_ANN, destructiveHint: true },
      invoking: "Fixing her entry…",
      invoked: "Her entry fixed",
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
      if (a.at) patch.at = timeArg({ at: a.at }, ctx, assumed).toISOString();
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
      if (!patch.at && !patch.data && patch.note === undefined) throw new ToolError("Nothing to change: pass at, units, dose, skipped, note, done or answer.");
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

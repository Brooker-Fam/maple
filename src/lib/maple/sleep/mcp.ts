import { z } from "zod";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { captureServerException } from "@/lib/posthog-server";
import { DISCLAIMER } from "../guidelines";
import { memberName } from "../insights";
import {
  clientIdFor,
  context,
  endFrom,
  fail,
  FAMILY_ONE_COPY,
  ok,
  READ_ANN,
  startFrom,
  ToolError,
  VIEWER_MESSAGE,
  voiceOf,
  whenText,
  WRITE_ANN,
  type Annotations,
  type Ctx,
  type Extra,
  type ToolCopy,
} from "../mcp-tools";
import { holdingChanged } from "../push-hooks";
import { activeTimers, getEntry, NotFound, StoreUnavailable } from "../store";
import { addDays, dayKey, formatDuration, formatTime } from "../time";
import { SLEEP_PLACES, type Entry, type Member } from "../types";
import type { Voice } from "../voice";
import { askState, numberTries, planToday, planTodayWords, progressLines, shiftStatus, sleepAge, sleepGuidance, sleepSignals, snoozeUntil, stageSuggestion, tryDayKey, tryDayLabel, type GuideView, type SleepGuidance } from "./engine";
import {
  backToWorkGoal,
  backToWorkQuestions,
  checkinTryOn,
  checkinMorning,
  checkinWords,
  cleanCheckinNight,
  cleanGoalInput,
  coachGuardrails,
  coachNotes,
  goalCautions,
  goalHeadLine,
  goalProgressLines,
  goalRef,
  goalsByUrgency,
  goalSpan,
  goalStartKey,
  lastNightKey,
  lastNightLine,
  nextStep,
  NIGHT_OVER_HOUR,
  nightWords,
  owedNow,
  QUICK_FEEDING,
  QUICK_OFF_DUTY,
  QUICK_SLEEPS,
  rosterWords,
  seesCheckins,
  targetsWords,
  tonightKey,
  windowLine,
  windowOn,
  windowOnNight,
  writesGoals,
  type CoachNotes,
  type GoalFields,
  type GoalProgress,
  type GoalWords,
} from "./goals";
import {
  acceptHandoff,
  askHandoff,
  cancelAsk,
  cleanNote,
  cleanPlanPatch,
  cleanTags,
  closeGoal,
  createGoal,
  deleteCheckin,
  deleteTry,
  endShift,
  ensurePlan,
  finishTry,
  getGoal,
  getPlan,
  getTry,
  goalProgressFor,
  handOff,
  listCheckins,
  listGoals,
  listTries,
  logTry,
  openShift,
  progressFor,
  restoreTry,
  reviewGoal,
  rowToCheckin,
  rowToGoal,
  runningTry,
  saveCheckin,
  setGoalStep,
  SleepConflict,
  SleepInputError,
  startShift,
  startTry,
  undoFinish,
  updateGoal,
  updatePlan,
  updateTry,
  type GoalCtx,
  type TryPatch,
  type TryWrite,
} from "./store";
import {
  CHECKIN_PLACES,
  EASE_OFF_DAYS,
  GOAL_NOTE_MAX,
  HANDOFF_ANSWERS,
  PLAN_STAGES,
  PROTECTED_ANSWERS,
  TARGET_KINDS,
  TRY_OUTCOMES,
  TRY_TAGS,
  UNTIMED_TRIES,
  WINDOW_COVERS,
  type BassinetTry,
  type GoalInput,
  type HoldingShift,
  type SleepCheckin,
  type SleepGoal,
  type SleepPlan,
  type TryOutcome,
} from "./types";
import { dateWords, defaultGoal, ENOUGH_NIGHTS_LINE, GOAL_STATUS_LABEL, HANDOFF_LABEL, OUTCOME_LABEL, PLACE_LABEL, PROTECTED_LABEL, SLEEP_PLACE_LABEL, slotLabel, STAGE_INFO, TAG_LABEL, targetWords, windowTimes } from "./words";
import { windowRange, type HandoffWhy } from "./handoff";

/**
 * The sleep plan as MCP tools: read the plan and progress, change the plan,
 * start, finish, log and fix bassinet tries, and track who is holding the
 * baby awake. Registered on Maple's server by registerMapleTools, so the
 * in-app chat and every connected app share them; viewers get the reads.
 *
 * Try ids print as t12 and shift ids as h7 (never a bare #12, which names a
 * log entry), and a try's results are never a "Saved #…" receipt: the chat
 * would offer an entry's Undo for it. The sleep entry a try sits on keeps its
 * own #id.
 */

const ROUTE = "/api/maple/mcp";
const MIN = 60_000;

export const tryRef = (id: number) => `t${id}`;
export const shiftRef = (id: number) => `h${id}`;

/** A try or shift id from "t12", "#12", "12" or 12. */
function refId(raw: unknown, prefix: "t" | "h"): number {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  const m = new RegExp(`^[${prefix}${prefix.toUpperCase()}]?([1-9]\\d{0,15})$`).exec(s);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n)) throw new ToolError(`That isn't a ${prefix === "t" ? "bassinet try id (like t12)" : "holding shift id (like h7)"}.`);
  return n;
}

async function sleepToolError(name: string, err: unknown): Promise<CallToolResult> {
  if (err instanceof ToolError) return fail(err.message);
  if (err instanceof SleepInputError) return fail(`${err.message.replace(/\.$/, "")}. Nothing was saved; fix that and try again.`);
  if (err instanceof SleepConflict) return fail(`${err.message} Nothing was saved. Call sleep_plan to see it as it is now, then try again.`);
  if (err instanceof StoreUnavailable) return fail("Maple's Log can't reach its database right now, so nothing was saved. Try again in a minute.");
  if (err instanceof NotFound) return fail(`${err.message}. Call sleep_plan for the current try and shift.`);
  if (err instanceof Error && err.constructor === Error && err.message.length < 200 && !/database|neon|fetch|ECONN|timeout|sql/i.test(err.message)) {
    return fail(`${err.message.replace(/\.$/, "")}. Nothing was saved; fix that and try again.`);
  }
  // Its class only: Postgres quotes the row, and notes are the family's words.
  const scrubbed = new Error(err instanceof Error && /^[A-Za-z0-9_]{1,60}$/.test(err.name) ? err.name : "sleep_error");
  console.error(`Maple MCP ${name} error: ${scrubbed.message}`);
  await captureServerException(scrubbed, { tool: name, route: ROUTE });
  return fail("Something went wrong inside Maple's Log. Call sleep_plan before trying again, so nothing is saved twice.");
}

function addSleepTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  cfg: { title: string; description: string; inputSchema: S; annotations: Annotations; invoking: string; invoked: string; write?: boolean },
  run: (args: ShapeOutput<S>, ctx: Ctx) => Promise<CallToolResult>
) {
  const handler = async (args: ShapeOutput<S>, extra: Extra): Promise<CallToolResult> => {
    try {
      const ctx = await context(extra);
      if (cfg.write && ctx.who.role === "viewer") throw new ToolError(VIEWER_MESSAGE);
      return await run(args, ctx);
    } catch (err) {
      return sleepToolError(name, err);
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

// ── words ────────────────────────────────────────────────────────────────

const who = (id: string | null | undefined, ctx: Ctx) => memberName(id, ctx.members);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Someone in this family by name, first name or email ("me" is the caller); never a photos-only guest. */
function personArg(raw: string | null | undefined, ctx: Ctx, label: string): string | null {
  if (raw == null || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  if (["me", "i", "myself"].includes(s)) return ctx.who.id;
  const people = ctx.members.filter((m: Member) => m.role !== "photos");
  const exact = people.filter((m) => m.email.toLowerCase() === s || (m.display_name ?? "").trim().toLowerCase() === s);
  const found = exact.length ? exact : people.filter((m) => (m.display_name ?? "").trim().split(/\s+/)[0]?.toLowerCase() === s);
  if (found.length === 1) return found[0].email;
  const names = people.map((m) => who(m.email, ctx)).join(", ");
  throw new ToolError(found.length > 1 ? `More than one person in the family is called "${raw}" (${label}). Say which: ${names}.` : `"${raw}" isn't someone in this family (${label}). The family is: ${names}.`);
}

function tryJson(t: BassinetTry, ctx: Ctx, nums = numberTries([t], ctx.tz)) {
  const n = nums.get(t.id);
  const down = (t.ended_at ? Date.parse(t.ended_at) : ctx.now.getTime()) - Date.parse(t.started_at);
  return {
    id: tryRef(t.id),
    laid_down_local: whenText(t.started_at, ctx),
    ...(t.ended_at ? { ended_local: whenText(t.ended_at, ctx) } : { running: true }),
    minutes_down: Math.max(0, Math.round(down / MIN)),
    outcome: t.outcome,
    ...(n ? { try_number: n.n, of_today: n.of, try_day: tryDayLabel(n.day, tryDayKey(ctx.now, ctx.tz)), ...(n.retry ? { retry: true } : {}) } : {}),
    put_down_by: t.put_down_by ? who(t.put_down_by, ctx) : null,
    tags: t.tags,
    ...(t.note ? { note: t.note } : {}),
    sleep_entry: t.sleep_entry_id,
    by: who(t.created_by, ctx),
    via: t.source,
  };
}

function shiftJson(s: HoldingShift, ctx: Ctx) {
  const st = shiftStatus(s, ctx.now);
  const ask = askState(s, ctx.now);
  return {
    id: shiftRef(s.id),
    holder: who(s.holder, ctx),
    since_local: whenText(s.started_at, ctx),
    ...(s.handoff_at ? { handoff_planned_local: whenText(s.handoff_at, ctx), handoff_due: st.due, minutes_to_handoff: st.minutesLeft } : {}),
    ...(s.next_holder ? { next_holder: who(s.next_holder, ctx) } : {}),
    // Asked, not handed over: the holder still has her until the person asked does.
    ...(ask.asked ? { asked_to: who(ask.to, ctx), asked_local: whenText(ask.at!, ctx), minutes_since_ask: ask.minutes, nobody_took_over: ask.stale } : {}),
    ...(s.ended_at ? { ended_local: whenText(s.ended_at, ctx), ended_how: s.ended_how } : { open: true }),
  };
}

/** A turn's open ask in words, with the 10-minute rule: past it, the two safe choices again, never "keep holding". */
function askLine(s: HoldingShift, ctx: Ctx): string | null {
  const ask = askState(s, ctx.now);
  if (!ask.asked) return null;
  const vo = voiceOf(ctx);
  const asked = who(ask.to, ctx);
  const head = `${who(s.holder, ctx)} asked ${asked} to take over at ${formatTime(ask.at!, ctx.tz)} (${plural(ask.minutes, "minute")} ago); nothing has changed hands, so ${who(s.holder, ctx)} is still holding ${vo.them}`;
  return ask.stale
    ? `${head}. Nobody has taken over yet: the two safe choices are laying ${vo.them} on ${vo.their} back in the bassinet now (bassinet_try start) or waking ${asked} again (holding ask).`
    : `${head} until ${asked} has ${vo.them} (holding accept from ${asked}, or hand_off when ${who(s.holder, ctx)} says so).`;
}

/** "Bassinet try t12 running since 2:10 AM (15 min), laid down by Sam: try 1 tonight." */
function tryLine(t: BassinetTry, ctx: Ctx, nums: ReturnType<typeof numberTries>): string {
  const n = nums.get(t.id);
  const nth = n ? `try ${n.n} ${tryDayLabel(n.day, tryDayKey(ctx.now, ctx.tz))}${n.retry ? ", a retry" : ""}` : "";
  const tags = t.tags.length ? ` (${t.tags.map((x) => TAG_LABEL[x].toLowerCase()).join(", ")})` : "";
  if (!t.ended_at) {
    const mins = Math.max(0, Math.round((ctx.now.getTime() - Date.parse(t.started_at)) / MIN));
    return `Bassinet try ${tryRef(t.id)} running: laid down at ${formatTime(t.started_at, ctx.tz)} (${mins} min ago) by ${who(t.put_down_by, ctx)}${tags}${nth ? `; ${nth}` : ""}.`;
  }
  const mins = Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / MIN);
  return `Bassinet try ${tryRef(t.id)}: ${formatTime(t.started_at, ctx.tz)}–${formatTime(t.ended_at, ctx.tz)}, ${OUTCOME_LABEL[t.outcome!].toLowerCase()} after ${mins} min down${tags}${nth ? `; ${nth}` : ""}.`;
}

function shiftLine(s: HoldingShift, ctx: Ctx): string {
  const vo = voiceOf(ctx);
  const st = shiftStatus(s, ctx.now);
  const plan = s.handoff_at
    ? st.due
      ? `; the planned handoff (${formatTime(s.handoff_at, ctx.tz)}) is due now`
      : `; planned handoff ${formatTime(s.handoff_at, ctx.tz)} (in ${formatDuration((st.minutesLeft ?? 0) * 60)})`
    : "";
  const next = s.next_holder ? ` to ${who(s.next_holder, ctx)}` : "";
  const ask = askLine(s, ctx);
  return `Holding: ${who(s.holder, ctx)} is holding ${vo.name} awake since ${formatTime(s.started_at, ctx.tz)} (${shiftRef(s.id)})${plan}${s.handoff_at ? next : ""}.${ask ? ` ${ask}` : ""}`;
}

/**
 * After a handoff: when the next one is planned, and why it isn't the
 * default when that would land in the next holder's protected window on
 * the roster ("6:30 AM, the end of Theo's protected sleep (1:30–6:30 AM on
 * the roster), not 4:24 AM, so Theo isn't woken inside it").
 */
function nextHandoffWords(w: { shift: HoldingShift; handoffWhy?: HandoffWhy | null }, ctx: Ctx): string {
  const why = w.handoffWhy;
  if (!why) return w.shift.handoff_at ? `; the next handoff is planned for ${formatTime(w.shift.handoff_at, ctx.tz)}` : "";
  const name = who(why.member, ctx);
  const range = `${windowRange(why, ctx.tz)} on the roster`;
  return why.planned_at
    ? `; the next handoff is planned for ${formatTime(why.planned_at, ctx.tz)}, the end of ${name}'s protected sleep (${range}), not ${formatTime(why.default_at, ctx.tz)}, so ${name} isn't woken inside it`
    : `; no next handoff is planned, since ${formatTime(why.default_at, ctx.tz)} is inside ${name}'s protected sleep (${range}), which ends over 12 hours from now`;
}

/** A sleep in arms running through a handoff: said, so whoever has her now stops it if she's awake. */
async function armsRunningLine(ctx: Ctx): Promise<string | null> {
  const sleep = (await activeTimers(ctx.fam, ctx.baby.id)).find((e) => e.kind === "sleep");
  if (!sleep || (sleep.data as { place?: string }).place !== "arms") return null;
  const v = voiceOf(ctx);
  return `${v.Name}'s sleep in arms has been running since ${formatTime(sleep.started_at, ctx.tz)} (#${sleep.id}); if ${v.they}${v.verb("'s")} awake, stop it (stop_timer).`;
}

function linkLine(w: TryWrite, ctx: Ctx): string | null {
  const vo = voiceOf(ctx);
  if (!w.sleep) return null;
  if (w.link === "create") return `It started ${vo.their} sleep in the log too (#${w.sleep.id}, in the bassinet), so don't also start a sleep timer or log this sleep.`;
  if (w.link === "running") return `It's on ${vo.their} running sleep timer (#${w.sleep.id}, asleep since ${formatTime(w.sleep.started_at, ctx.tz)}), so that sleep isn't counted twice.`;
  if (w.link === "overlap") return `It's on the sleep logged from ${formatTime(w.sleep.started_at, ctx.tz)} (#${w.sleep.id}), so that sleep isn't counted twice.`;
  return null;
}

const planJson = (p: SleepPlan, v: Voice) => ({
  stage: p.stage,
  stage_title: STAGE_INFO[p.stage].title,
  stage_goal: STAGE_INFO[p.stage].goal,
  goal: p.goal ?? defaultGoal(v),
  tries_per_day: p.tries_per_day,
  try_times: p.try_times.map(slotLabel),
  backup: p.fallback ? slotLabel(p.fallback) : null,
  sleeps_now: p.sleeps_now ? SLEEP_PLACE_LABEL[p.sleeps_now] : null,
  revision: p.revision,
});

function planLine(p: SleepPlan, v: Voice): string {
  const times = p.try_times.map((x) => slotLabel(x).replace(/^The /, "the ")).join(", ");
  const backup = p.fallback ? `; backup: ${slotLabel(p.fallback).replace(/^The /, "the ")}` : "";
  return `Sleep plan: stage ${p.stage} of ${PLAN_STAGES.length} (${STAGE_INFO[p.stage].title}), ${plural(p.tries_per_day, "try", "tries")} a day at ${times}${backup}. Goal: ${p.goal ?? defaultGoal(v)}.`;
}

const guideText = (g: GuideView) => `${g.title}: ${g.body}${g.steps ? ` ${g.steps.map((s, i) => `${i + 1}. ${s}`).join(" ")}` : ""}`;
const guideJson = (g: GuideView) => ({ title: g.title, body: g.body, ...(g.steps ? { steps: g.steps } : {}), source: g.sources[0]?.url });

// ── sleep goals: words and JSON ──────────────────────────────────────────

/** A goal's id from "g3", "#3", "3" or 3. */
function goalIdArg(raw: unknown): number {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().replace(/^#/, "") : "";
  const m = /^[gG]?([1-9]\d{0,15})$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(n)) throw new ToolError("That isn't a sleep goal id (like g3). sleep_plan lists the goals.");
  return n;
}

/** The adults' names (owners and members), as the safety rules read them ("while Theo's awake"). */
const adultNames = (ctx: Ctx) => ctx.members.filter((m) => m.role === "owner" || m.role === "member").map((m) => who(m.email, ctx));

/** Adults who log and can each take half a night (owners and members, never the shared admin login): the quick setup needs two. */
const nightAdults = (ctx: Ctx) => ctx.members.filter((m) => (m.role === "owner" || m.role === "member") && m.email !== "admin");

/** The adults who check in (owners and members), the day, and the baby's words and age, a goal write is checked against. */
const goalCtx = (ctx: Ctx): GoalCtx => ({
  adults: new Set(ctx.members.filter((m) => m.role === "owner" || m.role === "member").map((m) => m.email)),
  name: (id) => who(id, ctx),
  today: dayKey(ctx.now, ctx.tz),
  v: voiceOf(ctx),
  ageDays: sleepAge(ctx.baby, ctx.now)?.days ?? null,
});

const goalWords = (ctx: Ctx): GoalWords => ({ v: voiceOf(ctx), name: (id) => who(id, ctx), tz: ctx.tz, now: ctx.now });

function goalJson(g: SleepGoal, ctx: Ctx) {
  const today = dayKey(ctx.now, ctx.tz);
  return {
    id: goalRef(g.id),
    title: g.title,
    ...(g.why ? { why: g.why } : {}),
    status: g.status,
    target_date: g.target_date,
    targets: g.targets.map((t) => ({ ...t, ...(t.kind === "protected_window" ? { member: who(t.member, ctx) } : {}), words: targetWords(t, (id) => who(id, ctx)) })),
    steps: g.steps.map((s) => ({ id: s.id, title: s.title, week_of: s.week_of, done: !!s.done_at, ...(s.done_at ? { done_by: who(s.done_by, ctx), done_local: whenText(s.done_at, ctx) } : {}) })),
    roster: g.roster.map((w) => ({ id: w.id, member: who(w.member, ctx), from: w.from, to: w.to, nights: w.nights, ...(w.covers ? { covers: w.covers } : {}), words: windowLine(w, (id) => who(id, ctx)) })),
    ...templateJson(g, ctx),
    ...restartJson(g),
    ...(g.last_review_at ? { last_review: dateWords(dayKey(Date.parse(g.last_review_at), ctx.tz), today), review_note: g.review_note } : {}),
    ...(g.closed_at ? { closed: dateWords(dayKey(Date.parse(g.closed_at), ctx.tz), today) } : {}),
    revision: g.revision,
  };
}

/** The family's own restart, when there is one: counting from a night (picked up again), or easing off until one. */
const restartJson = (g: SleepGoal) => ({ ...(g.counts_from ? { counts_from: g.counts_from } : {}), ...(g.paused_until ? { paused_until: g.paused_until } : {}) });

/** A "Back to work" goal's template, for a model: who goes back to work and when, and who nurses. */
const templateJson = (g: SleepGoal, ctx: Ctx) =>
  g.template ? { template: { kind: g.template.kind, back_to_work: who(g.template.member, ctx), back_on: g.template.date, nurses: g.template.nursing ? who(g.template.nursing, ctx) : null } } : {};

const coachJson = (c: CoachNotes, ctx: Ctx) => ({
  days_left: c.daysLeft,
  review_due: c.reviewDue,
  days_since_review: c.daysSinceReview,
  next_step: c.nextStep ? { id: c.nextStep.id, title: c.nextStep.title, week_of: c.nextStep.week_of } : null,
  ...(c.notCheckedIn ? { not_checked_in_for_last_night: c.notCheckedIn.map((m) => who(m, ctx)) } : {}),
  notes: c.notes,
});

/** A goal as it would be saved, read back in words: what the person says yes to. */
function draftWords(f: GoalFields, ctx: Ctx): string {
  const today = dayKey(ctx.now, ctx.tz);
  const name = (id: string) => who(id, ctx);
  const parts: string[] = [];
  if (f.title !== undefined) parts.push(`"${f.title}"`);
  if (f.why !== undefined) parts.push(f.why ? `why: "${f.why}"` : "no why");
  if (f.target_date !== undefined) parts.push(f.target_date ? `target date ${dateWords(f.target_date, today)}` : "no target date");
  if (f.targets !== undefined) parts.push(f.targets.length ? `targets: ${targetsWords(f.targets, name)}` : "no targets");
  if (f.steps !== undefined) parts.push(f.steps.length ? `steps: ${f.steps.map((s, i) => `${i + 1}. "${s.title}"${s.week_of ? ` (week of ${dateWords(s.week_of, today)})` : ""}`).join(" ")}` : "no steps");
  if (f.roster !== undefined) parts.push(f.roster.length ? `roster: ${rosterWords(f.roster, name)}` : "no roster");
  if (f.status !== undefined) parts.push(`status ${GOAL_STATUS_LABEL[f.status].toLowerCase()}`);
  return parts.join("; ");
}

/** The tool's people (names or "me"), and its "in 4 weeks" dates, as a GoalInput with member ids. */
type GoalArgs = {
  title?: string | null;
  why?: string | null;
  target_date?: string | null;
  targets?: { kind: (typeof TARGET_KINDS)[number]; per_week?: number | null; min_minutes?: number | null; minutes?: number | null; member?: string | null; text?: string | null; id?: string | null }[] | null;
  steps?: { title: string; week_of?: string | null; id?: string | null }[] | null;
  roster?: { member: string; from: string; to: string; nights: number[]; id?: string | null }[] | null;
  status?: "active" | "paused" | "met" | "dropped" | null;
  counts_from?: string | null;
  paused_until?: string | null;
};

function targetDateArg(raw: string, ctx: Ctx): string | null {
  const s = raw.trim().toLowerCase();
  if (s === "none" || s === "no date") return null;
  if (s === "tonight") return tonightKey(ctx.now, ctx.tz);
  if (s === "a week" || s === "in a week") return addDays(dayKey(ctx.now, ctx.tz), EASE_OFF_DAYS);
  const m = /^in\s+(\d{1,3})\s+(day|week)s?$/.exec(s);
  if (m) return addDays(dayKey(ctx.now, ctx.tz), Number(m[1]) * (m[2] === "week" ? 7 : 1));
  return raw.trim();
}

function goalInputFrom(a: GoalArgs, ctx: Ctx, mode: "add" | "update"): GoalInput {
  const out: GoalInput = {};
  if (a.title != null) out.title = a.title;
  if (a.why != null) out.why = a.why.trim() ? a.why : null;
  if (a.target_date != null) out.target_date = targetDateArg(a.target_date, ctx);
  if (a.targets != null)
    out.targets = a.targets.map((t, i) => ({
      ...t,
      member: t.kind === "protected_window" ? (personArg(t.member ?? null, ctx, `target ${i + 1}'s member`) ?? ctx.who.id) : null,
    }));
  if (a.steps != null) out.steps = a.steps.map((s) => ({ ...s }));
  if (a.roster != null) out.roster = a.roster.map((w, i) => ({ ...w, member: personArg(w.member, ctx, `window ${i + 1}'s member`) ?? ctx.who.id }));
  if (a.status != null) {
    if (mode === "add") throw new ToolError("A new goal starts active; leave status out.");
    if (a.status === "met" || a.status === "dropped") throw new ToolError(`To close a goal as ${a.status}, use action "close" (with confirmed: true after they say yes).`);
    out.status = a.status;
  }
  if (a.counts_from != null) out.counts_from = targetDateArg(a.counts_from, ctx);
  if (a.paused_until != null) out.paused_until = targetDateArg(a.paused_until, ctx);
  return out;
}

type QuickArgs = {
  returning: string;
  return_date: string;
  feeding: (typeof QUICK_FEEDING)[number];
  nursing?: string | null;
  sleeps: (typeof QUICK_SLEEPS)[number];
  first_half: string;
  second_half: string;
  off_duty: (typeof QUICK_OFF_DUTY)[number];
  split?: string | null;
};

/**
 * sleep_goal add's back_to_work: the quick setup's answers (people by name
 * or "me", "in 4 weeks" dates) as the template's goal (goals.ts
 * backToWorkGoal) and its read-back notes. A title, a why or a target date
 * the call also gives replace the template's.
 */
function quickGoal(q: QuickArgs, a: Pick<GoalArgs, "title" | "why" | "target_date">, ctx: Ctx): { goal: GoalInput; notes: string[] } {
  const person = (raw: string | null | undefined, label: string) => personArg(raw, ctx, label) ?? "";
  const built = backToWorkGoal(
    {
      returning: person(q.returning, "who goes back to work"),
      return_date: targetDateArg(q.return_date, ctx) ?? "",
      feeding: q.feeding,
      nursing: q.nursing ? person(q.nursing, "who nurses") : null,
      sleeps: q.sleeps,
      first_half: person(q.first_half, "the first half of the night"),
      second_half: person(q.second_half, "the second half of the night"),
      off_duty: q.off_duty,
      split: q.split ?? null,
      target_date: a.target_date != null ? targetDateArg(a.target_date, ctx) : null,
    },
    { v: voiceOf(ctx), name: (id) => who(id, ctx), today: dayKey(ctx.now, ctx.tz), adults: goalCtx(ctx).adults }
  );
  return {
    goal: { ...built.goal, ...(a.title?.trim() ? { title: a.title } : {}), ...(a.why != null ? { why: a.why.trim() ? a.why : null } : {}) },
    notes: built.notes,
  };
}

/** The goal's head line, its progress lines and its coach notes, for sleep_plan and the tool's answers. */
function goalBlock(g: SleepGoal, p: GoalProgress, ctx: Ctx): { lines: string[]; coach: CoachNotes } {
  const words = goalWords(ctx);
  const coach = coachNotes(g, p, words);
  return { lines: [goalHeadLine(g, p, words), ...goalProgressLines(g, p, words), ...coach.notes.map((n) => `Coach note (${goalRef(g.id)}): ${n}`)], coach };
}

async function oneProgress(g: SleepGoal, ctx: Ctx): Promise<GoalProgress> {
  const m = await goalProgressFor(ctx.fam, ctx.baby.id, [g], { tz: ctx.tz, now: ctx.now, checkins: seesCheckins(ctx.who.role) });
  return m.get(g.id)!;
}

/** A goal changed since the model read it: say so, with the goal as it is now. */
function goalConflictText(err: SleepConflict, ctx: Ctx): string {
  const g = err.current as SleepGoal | null;
  if (!g || !("targets" in g)) return `${err.message} Nothing was saved. Call sleep_plan to see it as it is now, then try again.`;
  const span = goalSpan(g, ctx.now, ctx.tz);
  return `Someone changed sleep goal ${goalRef(g.id)} since you read it (revision ${g.revision} now). Nothing was saved. It reads: ${goalHeadLine(g, span, goalWords(ctx))} Check it's still what they want, then try again with revision ${g.revision}.`;
}

// ── sleep goals: read-backs, cautions, the family's words, a shorter read ──

/** "1–4", "1, 3 and 5": positions in a list, 1-based. */
function positions(ns: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    runs.push(j > i ? `${ns[i]}–${ns[j]}` : String(ns[i]));
    i = j;
  }
  return runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs[runs.length - 1]}` : runs[0] ?? "";
}

/**
 * What a list in an update does to the goal's list, by position in the new
 * one: "adds step 5 "…" (week of …); keeps 1–4 (2 done); changes 2 to "…"
 * (was "…"); removes "…" (s6)". An item is kept when it keeps its id and
 * reads the same (`words`); `done` counts the kept ones already done.
 */
function listChange<T extends { id: string }>(noun: string, cur: readonly T[], next: readonly T[], words: (x: T) => string, extra: { done?: (x: T) => boolean } = {}): string {
  if (!next.length) return cur.length ? `removes every ${noun}` : `no ${noun}s`;
  const had = new Map(cur.map((x) => [x.id, x]));
  const kept: number[] = [];
  const parts: string[] = [];
  next.forEach((x, i) => {
    const was = had.get(x.id);
    if (!was) parts.push(`adds ${noun} ${i + 1}: ${words(x)}`);
    else if (words(was) !== words(x)) parts.push(`changes ${noun} ${i + 1} to ${words(x)} (was ${words(was)})`);
    else kept.push(i + 1);
  });
  const done = extra.done ? next.filter((x) => had.has(x.id) && extra.done!(x)).length : 0;
  if (kept.length) parts.push(`keeps ${kept.length === next.length ? `all ${kept.length}` : positions(kept)}${done ? ` (${done} done)` : ""}`);
  const gone = cur.filter((x) => !next.some((y) => y.id === x.id));
  for (const x of gone) parts.push(`removes ${words(x)} (${x.id})`);
  return `${noun}s: ${parts.join("; ")}`;
}

/** An update read back as what it changes on the goal as it is: what's new, kept, changed and removed. */
function changeWords(cur: SleepGoal, f: GoalFields, ctx: Ctx): string {
  const today = dayKey(ctx.now, ctx.tz);
  const name = (id: string) => who(id, ctx);
  const parts: string[] = [];
  if (f.title !== undefined && f.title !== cur.title) parts.push(`the title becomes "${f.title}" (was "${cur.title}")`);
  if (f.why !== undefined && f.why !== cur.why) parts.push(f.why ? `why becomes "${f.why}"${cur.why ? ` (was "${cur.why}")` : ""}` : "removes the why");
  if (f.target_date !== undefined && f.target_date !== cur.target_date) {
    const was = cur.target_date ? ` (was ${dateWords(cur.target_date, today)})` : "";
    parts.push(f.target_date ? `target date ${dateWords(f.target_date, today)}${was}` : `no target date${was}`);
  }
  if (f.targets !== undefined) parts.push(listChange("target", cur.targets, f.targets, (t) => `"${targetWords(t, name)}"`));
  if (f.steps !== undefined) {
    parts.push(listChange("step", cur.steps, f.steps, (s) => `"${s.title}"${s.week_of ? ` (week of ${dateWords(s.week_of, today)})` : ""}`, { done: (s) => !!s.done_at }));
  }
  if (f.roster !== undefined) parts.push(listChange("window", cur.roster, f.roster, (w) => `"${windowLine(w, name)}"`));
  if (f.status !== undefined && f.status !== cur.status) parts.push(`status ${GOAL_STATUS_LABEL[f.status].toLowerCase()} (was ${GOAL_STATUS_LABEL[cur.status].toLowerCase()})`);
  // The family's clean restart: what counts from when, never a tally of the nights left out.
  if (f.counts_from !== undefined && f.counts_from !== (cur.counts_from ?? null)) {
    parts.push(f.counts_from ? `counting starts again from ${f.counts_from === tonightKey(ctx.now, ctx.tz) ? "tonight, " : ""}${dateWords(f.counts_from, today)}: the nights before it don't count` : "counts from the night it was set again");
  }
  if (f.paused_until !== undefined && f.paused_until !== (cur.paused_until ?? null)) {
    parts.push(f.paused_until ? `eases off until ${dateWords(f.paused_until, today)}: nothing is counted until then, and the steps and targets hold` : "stops easing off");
  }
  return parts.join("; ") || "nothing new (it already reads that way)";
}

/** Only what an update adds or changes (new or reworded items), so a read-back's cautions are about this change. */
function changedFields(cur: SleepGoal, f: GoalFields): GoalFields {
  const fresh = <T extends { id: string }>(next: readonly T[] | undefined, had: readonly T[], same: (a: T, b: T) => boolean) =>
    next?.filter((x) => {
      const was = had.find((y) => y.id === x.id);
      return !was || !same(was, x);
    });
  return {
    ...(f.title !== undefined && f.title !== cur.title ? { title: f.title } : {}),
    ...(f.why !== undefined && f.why !== cur.why ? { why: f.why } : {}),
    targets: fresh(f.targets, cur.targets, (a, b) => JSON.stringify(a) === JSON.stringify(b)),
    steps: fresh(f.steps, cur.steps, (a, b) => a.title === b.title),
    roster: fresh(f.roster, cur.roster, (a, b) => a.from === b.from && a.to === b.to && a.member === b.member && (a.covers ?? null) === (b.covers ?? null)),
  };
}

/** What has to be said with a goal as it would be saved (goals.ts goalCautions), as lines: "Say this too: …" in a read-back. */
const cautionLines = (f: GoalFields, ctx: Ctx, kinds?: readonly string[], head = "Say this too") =>
  goalCautions(f, { v: voiceOf(ctx), name: (id) => who(id, ctx), ageDays: sleepAge(ctx.baby, ctx.now)?.days ?? null, adults: adultNames(ctx), today: dayKey(ctx.now, ctx.tz) })
    .filter((c) => !kinds || kinds.includes(c.kind))
    .map((c) => `${head}: ${c.text}${c.source ? ` (source: ${c.source.title}, ${c.source.url})` : ""}`);

/** A goal for a model that only needs to write it: ids, revision, the step ids and whether they're done (sleep_plan's lines carry the rest). */
function goalJsonCompact(g: SleepGoal, ctx: Ctx) {
  return {
    id: goalRef(g.id),
    title: g.title,
    status: g.status,
    revision: g.revision,
    target_date: g.target_date,
    targets: g.targets.map((t) => ({ ...t, ...(t.kind === "protected_window" ? { member: who(t.member, ctx) } : {}) })),
    steps: g.steps.map((s) => ({ id: s.id, title: s.title, week_of: s.week_of, ...(s.done_at ? { done: true } : {}) })),
    roster: g.roster.map((w) => ({ id: w.id, member: who(w.member, ctx), from: w.from, to: w.to, nights: w.nights, ...(w.covers ? { covers: w.covers } : {}) })),
    ...templateJson(g, ctx),
    ...restartJson(g),
  };
}

/** Safe sleep, when to call and the emergency line, as titles, with the two that need doing at once word for word. */
function safetyLines(guidance: SleepGuidance): { line: string } {
  const keep = ["safe", "call", "emergency"];
  const sections = guidance.sections.filter((s) => keep.includes(s.section));
  const full = new Set(["safe-sleepy", "emergency-911"]);
  // An item said in full ends with its own period (the 911 line's "… or is limp."): one period between sections, never two.
  const titles = sections.map((s) => `${s.title}: ${s.items.map((g) => (full.has(g.id) ? guideText(g) : g.title)).join("; ")}`.replace(/\.$/, ""));
  return { line: `Safety (sleep_plan with view "guidance" has every item word for word, with its sources): ${titles.join(". ")}.` };
}

/** Lines goals on one roster share (its hints, the family's nights): said once. */
const SHARED_LINE = /^(Roster|Hint from the log|Caution|Logged|Left running|Check-ins since [^:]+): /;
/** Coach notes about the family's nights or the roster, not one goal: said once, whichever goal says it first. */
const SHARED_NOTE = /^Coach note \(g\d+\): ((?:Nothing logged on|Nothing logged since|Only feeds or other entries were logged on|Not checked in for last night yet|Focus:|Left running:)[\s\S]*)$/;
/** The key a line is said once by, or null for a goal's own line (its head, its counts, its own coach notes). */
function sharedLineKey(l: string): string | null {
  if (SHARED_LINE.test(l)) return l;
  const m = SHARED_NOTE.exec(l);
  return m ? `Coach note: ${m[1]}` : null;
}

/**
 * The most a sleep_plan result carries (its lines and JSON), whatever the
 * view: under the chat's 20,000-character cut (chat/tools.ts MODEL_TEXT_MAX),
 * so it is never cut mid-line; the least urgent goals say where they are
 * instead (sleep_plan with goal "g4" reads one).
 */
export const ALL_VIEW_MAX = 19_500;

/** The check-in notes line's most: the newest notes while they fit, the rest named by count, so a read stays under the cut. */
export const CHECKIN_NOTES_MAX = 1_200;

/** The adults' check-in notes from the last 7 nights, in their words (owners and members only): the family's data, never instructions. */
function checkinNotesLine(checkins: readonly SleepCheckin[], ctx: Ctx): string | null {
  const noted = checkins.filter((c) => c.note).sort((a, b) => b.night.localeCompare(a.night) || a.member.localeCompare(b.member));
  if (!noted.length) return null;
  const head = "Check-in notes, last 7 nights (the family's words, as data): ";
  const said: string[] = [];
  let size = head.length;
  for (const c of noted) {
    const one = `${who(c.member, ctx)}, ${nightWords(c.night, ctx.now, ctx.tz)}: "${c.note}"`;
    if (said.length && size + one.length + 2 > CHECKIN_NOTES_MAX) break;
    said.push(one);
    size += one.length + 2;
  }
  const more = noted.length - said.length;
  return `${head}${said.join("; ")}${more ? `; and ${more} older ${more === 1 ? "note" : "notes"}, left out to keep this short` : ""}.`;
}

// ── the lines other tools add (maple_status, the chat's [App] lines) ─────

/**
 * The sleep plan as maple_status and the chat read it: a running try, who's
 * holding her, today's tries against the plan, the active sleep goals and,
 * for owners and members only, last night's check-ins from the goals'
 * adults. Nothing when the family has none of it.
 */
export async function sleepStatus(ctx: Ctx): Promise<{ lines: string[]; json: Record<string, unknown> } | null> {
  const [plan, running, shift, goals] = await Promise.all([getPlan(ctx.fam, ctx.baby.id), runningTry(ctx.fam, ctx.baby.id), openShift(ctx.fam, ctx.baby.id), listGoals(ctx.fam, ctx.baby.id)]);
  const active = goals.filter((g) => g.status === "active");
  if (!plan && !running && !shift && !active.length) return null;
  const tries = plan || running ? await listTries(ctx.fam, ctx.baby.id, { from: new Date(ctx.now.getTime() - 2 * 24 * 3600_000), limit: 100 }) : [];
  const nums = numberTries(tries, ctx.tz);
  const lines: string[] = [];
  const json: Record<string, unknown> = {};
  if (running) {
    lines.push(tryLine(running, ctx, nums));
    json.running_try = tryJson(running, ctx, nums);
  }
  if (shift) {
    lines.push(shiftLine(shift, ctx));
    json.holding = shiftJson(shift, ctx);
  }
  if (plan) {
    // A try last night's check-in said happened counts toward today's, apart (owners and members only, who read check-ins).
    const key = tryDayKey(ctx.now, ctx.tz);
    const said = seesCheckins(ctx.who.role) ? await listCheckins(ctx.fam, ctx.baby.id, { from: key, to: key }) : null;
    const today = planToday(plan, tries, ctx.now, ctx.tz, { fromCheckins: checkinTryOn(said, key) });
    const t = planTodayWords(today, ctx.now, ctx.tz);
    lines.push(`Sleep plan: stage ${plan.stage} (${STAGE_INFO[plan.stage].title}); bassinet tries ${t.when}: ${t.count}.`);
    json.plan = { stage: plan.stage, today: `${today.done} of ${today.planned}`, next: today.next ? slotLabel(today.next) : null, more: "sleep_plan" };
  }
  if (active.length) {
    const left = (g: SleepGoal) => {
      const d = goalSpan(g, ctx.now, ctx.tz).daysLeft;
      return d == null ? "" : d > 1 ? `, ${d} days left` : d === 1 ? ", the target date is tomorrow" : d === 0 ? ", the target date is today" : ", past its target date";
    };
    lines.push(`Sleep goals: ${active.map((g) => `${goalRef(g.id)} "${g.title}"${left(g)}`).join("; ")}. sleep_plan has their progress and coach notes.`);
    json.goals = active.map((g) => ({ id: goalRef(g.id), title: g.title, days_left: goalSpan(g, ctx.now, ctx.tz).daysLeft, more: "sleep_plan" }));
    // Last night's check-ins, only for someone who may read them (owners and members), from the adults whose window was on
    // last night (and counting by then), never someone whose window was off. As Today asks: from 5 AM the morning after
    // (never between midnight and the morning, while the night is still going), each adult once their own window is over.
    const last = lastNightKey(ctx.now, ctx.tz);
    const adults = [...new Set(active.filter((g) => goalSpan(g, ctx.now, ctx.tz).startsOn <= last).flatMap((g) => owedNow(g, ctx.now, ctx.tz)?.adults ?? []))];
    if (adults.length && seesCheckins(ctx.who.role)) {
      const checkins = await listCheckins(ctx.fam, ctx.baby.id, { from: last, to: last });
      lines.push(`Check-ins for last night: ${lastNightLine(adults, checkins, ctx.now, ctx.tz, (id) => who(id, ctx))}.`);
      json.checkins_last_night = adults.map((m) => ({ who: who(m, ctx), answer: checkins.find((c) => c.member === m)?.protected ?? null }));
    }
  }
  return { lines, json };
}

// ── registration ─────────────────────────────────────────────────────────

export function registerSleepTools(server: McpServer, copy: ToolCopy = FAMILY_ONE_COPY) {
  const vo = copy.v;
  const local = (what: string) => z.string().max(60).nullish().describe(`${what} (local, like 2:10am)`);
  const ago = (what: string) => z.number().min(0).max(720).nullish().describe(what);
  const tagsField = z.array(z.enum(TRY_TAGS)).max(3).nullish();
  const nowMs = (ctx: Ctx) => ctx.now.getTime();
  const recent = (ctx: Ctx, from = nowMs(ctx)) => listTries(ctx.fam, ctx.baby.id, { from: new Date(from - 2 * 24 * 3600_000), limit: 200 });
  const noteLines = (assumed: string[]) => (assumed.length ? [`Note: ${[...new Set(assumed)].join("; ")}.`] : []);

  // ── the plan, and how the tries are going ──

  addSleepTool(
    server,
    "sleep_plan",
    {
      title: `${vo.Name}'s sleep plan`,
      description: `For sleep questions, and before a try, holding or goal change: ${vo.their} age, the plan (with revision), tonight's tries, a running try, who's holding ${vo.them}, a stage recent tries could support (theirs to choose), the sleep goals with progress and coach notes (most urgent first), and guidance for ${vo.their} age, word for word. With goals it gives their progress and the safety titles; view "guidance" gives the guidance word for word, "all" both. When a read says it left goals out to stay short, goal "g4" reads that one.`,
      inputSchema: {
        progress_days: z.number().int().min(1).max(31).nullish().describe("Also how the last N days of tries went."),
        view: z.enum(["goals", "guidance", "all"]).nullish(),
        goal: z.string().max(20).nullish().describe('Only this sleep goal, like g4'),
      },
      annotations: READ_ANN,
      invoking: "Checking the sleep plan…",
      invoked: "Sleep plan ready",
    },
    async (a, ctx) => {
      const v = voiceOf(ctx);
      const [plan, tries, shift] = await Promise.all([
        getPlan(ctx.fam, ctx.baby.id),
        listTries(ctx.fam, ctx.baby.id, { from: new Date(nowMs(ctx) - 8 * 24 * 3600_000), limit: 400 }),
        openShift(ctx.fam, ctx.baby.id),
      ]);
      const age = sleepAge(ctx.baby, ctx.now);
      const nums = numberTries(tries, ctx.tz);
      const suggestion = stageSuggestion(plan, tries, ctx.now, ctx.tz);
      const guidance = sleepGuidance(v, { days: age?.days ?? null, stage: plan?.stage ?? null, signals: sleepSignals(tries, ctx.now, ctx.tz, { suggestion }) });
      const lines: string[] = [];
      lines.push(age ? `${v.Name} is ${age.label} old (${age.band.label.toLowerCase()}), by ${v.their} birth date.` : `${v.Name} isn't born yet, so there's no sleep guidance for ${v.their} age yet.`);
      lines.push(plan ? planLine(plan, v) : `No sleep plan yet. set_sleep_plan sets one up: stage 1 is ${STAGE_INFO[1].goal.charAt(0).toLowerCase()}${STAGE_INFO[1].goal.slice(1)}.`);
      const dayKeyNow = tryDayKey(ctx.now, ctx.tz);
      const said = plan && seesCheckins(ctx.who.role) ? await listCheckins(ctx.fam, ctx.baby.id, { from: dayKeyNow, to: dayKeyNow }) : null;
      const today = plan ? planToday(plan, tries, ctx.now, ctx.tz, { fromCheckins: checkinTryOn(said, dayKeyNow) }) : null;
      const todayWords = today ? planTodayWords(today, ctx.now, ctx.tz) : null;
      if (todayWords) lines.push(todayWords.when === "tonight" ? `Tonight's tries: ${todayWords.count}.` : `Tries ${todayWords.when}: ${todayWords.count}.`);
      const running = tries.find((t) => !t.ended_at);
      if (running) lines.push(tryLine(running, ctx, nums));
      if (shift) lines.push(shiftLine(shift, ctx));
      if (suggestion && !suggestion.snoozed) {
        lines.push(
          `Recent tries could support stage ${suggestion.to} (${STAGE_INFO[suggestion.to].title}): ${suggestion.stayed} of the last ${suggestion.recent} stayed asleep 30 minutes or more, over ${plural(suggestion.days, "day")}. That's the family's choice: change the stage only if they ask.`
        );
      }
      if (guidance.now.length) lines.push(`For right now: ${guidance.now.map(guideText).join(" ")}`);
      let progress: Record<string, unknown> | null = null;
      if (a.progress_days) {
        const p = await progressFor(ctx.fam, ctx.baby.id, ctx.tz, ctx.now, a.progress_days);
        lines.push(...progressLines(p, ctx.tz, ctx.now));
        progress = {
          days: a.progress_days,
          tries: p.tries,
          finished: p.finished,
          days_with_a_try: p.tryDays,
          stayed_asleep: p.stayedAsleep,
          outcomes: p.outcomes,
          median_minutes_down: p.medianMinutesDown,
          longest_bassinet: p.longestBassinet ? { length: formatDuration(p.longestBassinet.sec), from_local: whenText(p.longestBassinet.start, ctx), to_local: whenText(p.longestBassinet.end, ctx) } : null,
          sleep_by_place: p.places.map((x) => ({ place: x.label, hours: Math.round((x.sec / 3600) * 10) / 10, sleeps: x.sleeps })),
          by_time_of_day: p.byTimeOfDay.filter((b) => b.tries).map((b) => ({ part: b.label, tries: b.tries, outcomes: b.outcomes })),
          early_observations: p.observations,
          enough_for_patterns: p.enough,
        };
      }
      // The family's open sleep goals, most urgent first, each with its progress from the log and short coach notes (check-in counts only for owners and members).
      const open = goalsByUrgency(await listGoals(ctx.fam, ctx.baby.id), ctx.now, ctx.tz);
      const only = a.goal ? goalIdArg(a.goal) : null;
      if (only !== null && !open.some((g) => g.id === only)) throw new ToolError(`There's no open sleep goal ${goalRef(only)}. sleep_plan lists the goals.`);
      const goals = only === null ? open : open.filter((g) => g.id === only);
      // With goals, the default is their progress, compact, with the safety titles (the guidance word for word is view "guidance");
      // without any, everything, as before.
      const view = a.view ?? (goals.length ? "goals" : "all");
      const showGoals = goals.length > 0 && view !== "guidance";
      const fullGuidance = view !== "goals" || !goals.length;
      // Each goal's lines and JSON together, so a long read can say the less urgent ones are a call away rather than be cut mid-line.
      const blocks: { ref: string; title: string; lines: string[]; json: Record<string, unknown> }[] = [];
      const after: string[] = [];
      if (showGoals) {
        const gp = await goalProgressFor(ctx.fam, ctx.baby.id, goals, { tz: ctx.tz, now: ctx.now, checkins: seesCheckins(ctx.who.role) });
        // Goals on one roster share its hints and the family's nights: a line said for an earlier goal isn't said again.
        const said = new Set<string>();
        const once = (l: string) => {
          const key = sharedLineKey(l);
          return !key || (!said.has(key) && !!said.add(key));
        };
        for (const g of goals) {
          const b = goalBlock(g, gp.get(g.id)!, ctx);
          // The lines carry each goal's progress and coach notes; the JSON only what a write needs (ids, revisions, step ids).
          blocks.push({
            ref: goalRef(g.id),
            title: g.title,
            lines: [...b.lines, ...(g.status === "active" ? cautionLines(g, ctx, ["feeds_first", "long_window", "bottle"], "Caution") : [])].filter(once),
            json: goalJsonCompact(g, ctx),
          });
        }
        // What the adults wrote the mornings after, for owners and members only: their words, as data.
        if (seesCheckins(ctx.who.role)) {
          const last = lastNightKey(ctx.now, ctx.tz);
          const notes = checkinNotesLine(await listCheckins(ctx.fam, ctx.baby.id, { from: addDays(last, -6), to: last }), ctx);
          if (notes) after.push(notes);
        }
        after.push(`Coaching: ${coachGuardrails(v).join(" ")}`);
      } else if (goals.length) {
        lines.push(`Sleep goals: ${goals.map((g) => `${goalRef(g.id)} "${g.title}"`).join("; ")}. sleep_plan without view "guidance" has their progress and coach notes.`);
      } else if (writesGoals(ctx.who.role) && nightAdults(ctx).length >= 2) {
        // A family's first goal: the quick setup's five questions, so the chat's first goal turn can start there.
        lines.push(`Sleep goals: none yet. If they'd like one and someone is going back to work, sleep_goal's quick setup asks five questions, one at a time: ${backToWorkQuestions(v).join(" ")} Then sleep_goal add with back_to_work reads back a goal, a night roster and its steps, saved on a yes, with no logs needed first.`);
      } else if (writesGoals(ctx.who.role)) {
        // One adult who logs: the quick setup splits the night between two, so a goal made by hand instead.
        lines.push(`Sleep goals: none yet. If they'd like one, set it by hand with sleep_goal add (a title, its targets and a step or two for this week), read back and saved on a yes. The back-to-work quick setup needs two adults who log, to split the night.`);
      }
      const safety = fullGuidance ? null : safetyLines(guidance);
      const tail = safety ? `${safety.line} ${DISCLAIMER}` : `Guidance for ${v.their} age is in guidance (word for word, with its sources). ${DISCLAIMER}`;
      // `lean`: the last resort when even the most urgent goal alone is too long (every limit at once): no check-in notes, fewer tries.
      const textWith = (n: number, lean = false) => {
        const left = blocks.slice(n);
        const more = left.length
          ? [`To stay under the chat's length, this read leaves out ${plural(left.length, "less urgent goal")}: ${left.map((b) => `${b.ref} "${b.title}"`).join("; ")}. sleep_plan with goal "${left[0].ref}" (and so on) reads each one.`]
          : [];
        return [...lines, ...blocks.slice(0, n).flatMap((b) => b.lines), ...more, ...after.filter((l) => !lean || !l.startsWith("Check-in notes")), tail].join("\n");
      };
      const dataWith = (n: number, lean = false) => ({
        // The goals first: their ids, revisions and step ids are what a write needs, and the lines carry their progress.
        ...(blocks.length ? { goals: blocks.slice(0, n).map((b) => b.json) } : {}),
        age: age ? { days: age.days, label: age.label, stage: age.band.label } : null,
        plan: plan ? planJson(plan, v) : null,
        today: today && todayWords ? { ...today, label: todayWords.when } : null,
        running_try: running ? tryJson(running, ctx, nums) : null,
        holding: shift ? shiftJson(shift, ctx) : null,
        suggestion: suggestion && !suggestion.snoozed ? { to_stage: suggestion.to, tries: suggestion.tries, days: suggestion.days, stayed_30_plus_of_last: `${suggestion.stayed} of ${suggestion.recent}` } : null,
        recent_tries: tries.slice(0, lean || (view === "goals" && goals.length) ? 3 : 10).map((t) => tryJson(t, ctx, nums)),
        ...(progress ? { progress } : {}),
        // The compact read's safety titles are in its lines; the guidance word for word is a view away.
        ...(safety
          ? { guidance: `sleep_plan {view: "guidance"} has it word for word, with its sources` }
          : { guidance: { now: guidance.now.map(guideJson), sections: guidance.sections.map((s) => ({ section: s.title, items: s.items.map(guideJson) })) } }),
      });
      // Every goal, most urgent first, while the read stays under the chat's cut; past it, the least urgent ones say where they are.
      const size = (n: number, lean = false) => textWith(n, lean).length + JSON.stringify(dataWith(n, lean)).length + 1;
      let shown = blocks.length;
      while (shown > 1 && size(shown) > ALL_VIEW_MAX) shown--;
      const lean = size(shown) > ALL_VIEW_MAX;
      return ok(textWith(shown, lean), dataWith(shown, lean));
    }
  );

  addSleepTool(
    server,
    "set_sleep_plan",
    {
      title: "Set up or change the sleep plan",
      description: "Sets up the sleep plan, or changes it with sleep_plan's revision. Change the stage only when they ask. not_now hides the stage suggestion for 3 days.",
      inputSchema: {
        revision: z.number().int().positive().nullish(),
        stage: z.number().int().min(1).max(4).nullish().describe(`1 ${STAGE_INFO[1].title}, 2 ${STAGE_INFO[2].title}, 3 ${STAGE_INFO[3].title}, 4 ${STAGE_INFO[4].title}.`),
        tries_per_day: z.number().int().min(1).max(8).nullish(),
        try_times: z.array(z.string().max(20)).min(1).max(6).nullish().describe('first_night_stretch, night_stretch, first_morning_nap, any_nap or "22:30"'),
        backup: z.string().max(20).nullish().describe("If the planned try doesn't happen (same choices)"),
        sleeps_now: z.enum(SLEEP_PLACES).nullish(),
        goal: z.string().max(160).nullish(),
        not_now: z.boolean().nullish(),
      },
      annotations: WRITE_ANN,
      invoking: "Updating the sleep plan…",
      invoked: "Sleep plan saved",
      write: true,
    },
    async (a, ctx) => {
      const v = voiceOf(ctx);
      const raw: Record<string, unknown> = {};
      if (a.stage != null) raw.stage = a.stage;
      if (a.tries_per_day != null) raw.tries_per_day = a.tries_per_day;
      if (a.try_times != null) raw.try_times = a.try_times;
      if (a.backup != null) raw.fallback = a.backup;
      if (a.sleeps_now != null) raw.sleeps_now = a.sleeps_now;
      if (a.goal != null) raw.goal = a.goal;
      if (a.not_now) raw.snoozed_until = snoozeUntil(ctx.now, ctx.tz);
      const current = await getPlan(ctx.fam, ctx.baby.id);
      if (!current) {
        const { plan, created } = await ensurePlan(ctx.fam, ctx.baby.id, ctx.who.id, ctx.who.via, cleanPlanPatch(raw, null, v));
        return ok(`${created ? "Set up" : "There's already"} ${v.name}'s sleep plan. ${planLine(plan, v)}`, { created, plan: planJson(plan, v) });
      }
      if (!Object.keys(raw).length) throw new ToolError("Nothing to change: give a stage, tries_per_day, try_times, backup, sleeps_now, goal or not_now.");
      if (a.revision == null) throw new ToolError(`Pass the plan's revision (${current.revision} now, from sleep_plan) so a change made meanwhile isn't overwritten.`);
      try {
        const { plan, before } = await updatePlan(ctx.fam, ctx.baby.id, cleanPlanPatch(raw, current, v), a.revision, ctx.who.id, ctx.who.via);
        return ok(`Updated the sleep plan. ${planLine(plan, v)}${before.stage !== plan.stage ? ` (It was stage ${before.stage}.)` : ""}`, { updated: true, plan: planJson(plan, v), before: planJson(before, v) });
      } catch (err) {
        if (err instanceof SleepConflict && err.current) throw new ToolError(`Someone changed the sleep plan since you read it (revision ${(err.current as SleepPlan).revision} now). Nothing was saved. It reads: ${planLine(err.current as SleepPlan, v)} Check it's still what they want, then try again with that revision.`);
        throw err;
      }
    }
  );

  // ── bassinet tries ──

  /** A finish's or a fix's words about the sleep it sits on. */
  const sleepAfter = (w: TryWrite, ctx: Ctx): string | null => {
    const v = voiceOf(ctx);
    if (!w.sleep || !w.sleepBefore) return null;
    if (w.sleepBefore.active && !w.sleep.active && w.sleep.ended_at) return `${v.Their} sleep timer stopped then too (#${w.sleep.id}).`;
    if (w.sleep.active && w.try.outcome === "picked_up") return `${v.They}${v.verb("'s")} still asleep, in arms now, so ${v.their} sleep timer keeps running (#${w.sleep.id}).`;
    return null;
  };

  addSleepTool(
    server,
    "bassinet_try",
    {
      title: "Bassinet try",
      description: `Bassinet tries: start (laid down now), finish (how it went), log (one that's over), fix, delete, restore, reopen (undo a finish). A try logs ${vo.their} sleep itself: never log that sleep too. Start ends a holding shift.`,
      inputSchema: {
        action: z.enum(["start", "finish", "log", "fix", "delete", "restore", "reopen"]),
        id: z.string().max(20).nullish().describe("Like t12"),
        at: local(`When ${vo.they} ${vo.verb("was")} laid down`),
        minutes_ago: ago(`when ${vo.they} ${vo.verb("was")} laid down`),
        ended_at: local("When it ended"),
        ended_minutes_ago: ago("when it ended"),
        duration_minutes: z.number().min(0).max(720).nullish(),
        outcome: z.enum(TRY_OUTCOMES).nullish().describe("picked_up: still asleep"),
        put_down_by: z.string().max(80).nullish().describe('A name, or "me" (default)'),
        tags: tagsField,
        note: z.string().max(200).nullish().describe(`About ${vo.name}'s sleep only`),
        client_ref: z.string().max(100).nullish(),
        allow_duplicate: z.boolean().nullish(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      invoking: "Noting the bassinet try…",
      invoked: "Bassinet try saved",
      write: true,
    },
    async (a, ctx) => {
      const v = voiceOf(ctx);
      const assumed: string[] = [];
      const ref = a.client_ref?.trim() || null;
      switch (a.action) {
        case "start": {
          const w = await startTry(ctx.fam, {
            babyId: ctx.baby.id,
            at: startFrom(a, ctx, assumed) ?? ctx.now,
            putDownBy: personArg(a.put_down_by, ctx, "put_down_by") ?? ctx.who.id,
            tags: cleanTags(a.tags),
            note: cleanNote(a.note),
            by: ctx.who.id,
            source: ctx.who.via,
            clientId: ref ? clientIdFor(ctx, ref) : null,
            device: ctx.device,
          });
          const nums = numberTries(await recent(ctx), ctx.tz);
          const n = nums.get(w.try.id);
          const nth = n ? ` (try ${n.n} ${tryDayLabel(n.day, tryDayKey(ctx.now, ctx.tz))}${n.retry ? ", a retry" : ""})` : "";
          const lines: string[] = [];
          if (w.status === "running") lines.push(`A bassinet try was already running (${tryRef(w.try.id)}, laid down at ${whenText(w.try.started_at, ctx)} by ${who(w.try.put_down_by, ctx)}), so no second one was started.`);
          else if (w.status === "deduped") lines.push(`Already saved bassinet try ${tryRef(w.try.id)}: laid down at ${whenText(w.try.started_at, ctx)}, so it wasn't added twice.`);
          else {
            lines.push(`Saved bassinet try ${tryRef(w.try.id)}: ${v.name} laid down at ${whenText(w.try.started_at, ctx)} by ${who(w.try.put_down_by, ctx)}${nth} (logged by ${ctx.who.name}).`);
            const link = linkLine(w, ctx);
            if (link) lines.push(link);
            if (w.endedShift) lines.push(`${who(w.endedShift.holder, ctx)}'s holding shift ended then (${shiftRef(w.endedShift.id)}).`);
            const feed = (await activeTimers(ctx.fam, ctx.baby.id)).find((e: Entry) => e.kind === "feed");
            if (feed) lines.push(`A nursing timer is still running (#${feed.id}): stop it with stop_timer if ${v.they}${v.verb("'s")} done.`);
            lines.push(`If ${v.they} ${v.verb("wakes")} crying: soothe ${v.them}, try once more when ${v.they}${v.verb("'s")} deeply asleep, then pause until the next planned try.`);
          }
          if (w.endedShift) holdingChanged({ familyId: ctx.fam.familyId });
          return ok([...lines, ...noteLines(assumed)].join("\n"), {
            started: w.status === "created",
            ...(w.status === "running" ? { already_running: true } : {}),
            ...(w.status === "deduped" ? { deduped: true } : {}),
            try: tryJson(w.try, ctx, nums),
            ...(w.sleep ? { sleep_entry: { id: w.sleep.id, linked: w.link ?? "running", running: w.sleep.active } } : {}),
            ...(w.endedShift ? { ended_shift: shiftJson(w.endedShift, ctx) } : {}),
            undo: `undo_last, or bassinet_try {action:"delete", id:"${tryRef(w.try.id)}"}`,
          });
        }
        case "finish": {
          if (!a.outcome) throw new ToolError("Say how it went: outcome stayed_asleep, woke_calm, woke_crying or picked_up.");
          const target = a.id ? await getTry(ctx.fam, refId(a.id, "t")) : await runningTry(ctx.fam, ctx.baby.id);
          if (!target) throw new ToolError(`No bassinet try is running. For one that's over, use action "log".`);
          const end = endFrom(a, ctx, assumed) ?? startFrom(a, ctx, assumed) ?? undefined;
          const w = await finishTry(ctx.fam, target.id, {
            outcome: a.outcome as TryOutcome,
            at: end,
            ...(a.tags ? { tags: cleanTags(a.tags) } : {}),
            ...(a.note != null ? { note: cleanNote(a.note) } : {}),
            by: ctx.who.id,
          });
          if (w.status === "already_finished") {
            return ok(`That try already ended at ${whenText(w.try.ended_at!, ctx)} (${OUTCOME_LABEL[w.try.outcome!].toLowerCase()}, ${tryRef(w.try.id)}). To change it, use action "fix".`, { finished: false, already_finished: true, try: tryJson(w.try, ctx) });
          }
          const tries = await recent(ctx);
          const nums = numberTries(tries, ctx.tz);
          const mins = Math.round((Date.parse(w.try.ended_at!) - Date.parse(w.try.started_at)) / MIN);
          const lines = [`Saved: bassinet try ${tryRef(w.try.id)} ended at ${whenText(w.try.ended_at!, ctx)}, ${OUTCOME_LABEL[w.try.outcome!].toLowerCase()} after ${mins} min down.`];
          const s = sleepAfter(w, ctx);
          if (s) lines.push(s);
          const guide = sleepGuidance(v, { days: sleepAge(ctx.baby, ctx.now)?.days ?? null, stage: (await getPlan(ctx.fam, ctx.baby.id))?.stage ?? null, signals: sleepSignals(tries, ctx.now, ctx.tz) }).now;
          for (const g of guide.filter((x) => x.section === "crying" || x.section === "bad_day" || x.section === "call")) lines.push(guideText(g));
          return ok([...lines, ...noteLines(assumed)].join("\n"), {
            finished: true,
            try: tryJson(w.try, ctx, nums),
            ...(w.sleep ? { sleep_entry: { id: w.sleep.id, running: w.sleep.active } } : {}),
            undo: `bassinet_try {action:"reopen", id:"${tryRef(w.try.id)}"}`,
          });
        }
        case "log": {
          if (!a.outcome) throw new ToolError("Say how it went: outcome stayed_asleep, woke_calm, woke_crying or picked_up.");
          let start = startFrom(a, ctx, assumed);
          let end = endFrom(a, ctx, assumed);
          const dur = a.duration_minutes != null ? a.duration_minutes * MIN : null;
          if (start && end && dur != null) throw new ToolError("Give two of the start, the end and duration_minutes, not all three.");
          if (!start && end && dur != null) start = new Date(end.getTime() - dur);
          if (start && !end && dur != null) end = new Date(start.getTime() + dur);
          if (!start && !end && dur != null) {
            end = ctx.now;
            start = new Date(ctx.now.getTime() - dur);
          }
          if (!start || !end) throw new ToolError(`Give when it started and when it ended (or how long it lasted). For a try still going, use action "start".`);
          const w = await logTry(ctx.fam, {
            babyId: ctx.baby.id,
            start,
            end,
            outcome: a.outcome as TryOutcome,
            putDownBy: personArg(a.put_down_by, ctx, "put_down_by") ?? ctx.who.id,
            tags: cleanTags(a.tags),
            note: cleanNote(a.note),
            by: ctx.who.id,
            source: ctx.who.via,
            clientId: ref ? clientIdFor(ctx, ref) : null,
            device: ctx.device,
            allowDuplicate: a.allow_duplicate === true,
          });
          if (w.status === "duplicate") {
            return ok(
              `Not saved: ${who(w.try.created_by, ctx)} already logged a bassinet try at ${whenText(w.try.started_at, ctx)} (${tryRef(w.try.id)}), which looks like the same one. If this is a different one, call again with allow_duplicate: true.`,
              { created: false, possible_duplicate: tryJson(w.try, ctx) }
            );
          }
          const nums = numberTries(await recent(ctx, start.getTime()), ctx.tz);
          const lines = [
            w.status === "deduped" ? `Already saved bassinet try ${tryRef(w.try.id)}, so it wasn't added twice.` : `Saved bassinet try ${tryRef(w.try.id)}: ${tryLine(w.try, ctx, nums).replace(/^Bassinet try t\d+: /, "")}`,
          ];
          const link = w.status === "created" ? linkLine(w, ctx) : null;
          if (link) lines.push(link.replace(/running sleep timer/, "sleep timer"));
          return ok([...lines, ...noteLines(assumed)].join("\n"), {
            created: w.status === "created",
            ...(w.status === "deduped" ? { deduped: true } : {}),
            try: tryJson(w.try, ctx, nums),
            ...(w.sleep ? { sleep_entry: { id: w.sleep.id, linked: w.link } } : {}),
            undo: `undo_last, or bassinet_try {action:"delete", id:"${tryRef(w.try.id)}"}`,
          });
        }
        case "restore": {
          const id = refId(a.id, "t");
          const cur = await getTry(ctx.fam, id, { includeDeleted: true });
          if (!cur) throw new ToolError(`There's no bassinet try ${tryRef(id)}.`);
          if (!cur.deleted_at) return ok(`${tryRef(id)} isn't deleted. Nothing changed.`, { restored: false, try: tryJson(cur, ctx) });
          const r = await restoreTry(ctx.fam, id, ctx.who.id, { sleepId: cur.made_sleep ? cur.sleep_entry_id : null });
          return ok(`Restored bassinet try ${tryRef(id)}${r.sleep && cur.made_sleep ? ` and the sleep it started (#${r.sleep.id})` : ""}.`, { restored: true, try: tryJson(r.try, ctx) });
        }
        default: {
          const id = refId(a.id, "t");
          const cur = await getTry(ctx.fam, id);
          if (!cur) {
            const gone = await getTry(ctx.fam, id, { includeDeleted: true });
            throw new ToolError(gone ? `Bassinet try ${tryRef(id)} is deleted. Bring it back with action "restore".` : `There's no bassinet try ${tryRef(id)}. Call sleep_plan for recent tries.`);
          }
          if (a.action === "delete") {
            const r = await deleteTry(ctx.fam, id, ctx.who.id);
            return ok(`Deleted bassinet try ${tryRef(id)}${r.sleepDeleted ? ` and the sleep it started (#${r.sleepDeleted.id})` : ""}. To undo, bassinet_try {action:"restore", id:"${tryRef(id)}"}.`, {
              deleted: true,
              ...(r.sleepDeleted ? { sleep_deleted: r.sleepDeleted.id } : {}),
            });
          }
          if (a.action === "reopen") {
            if (!cur.ended_at) return ok(`${tryRef(id)} is still running. Nothing changed.`, { reopened: false, try: tryJson(cur, ctx) });
            const s = cur.sleep_entry_id ? await getEntry(ctx.fam, cur.sleep_entry_id) : null;
            // The sleep the finish stopped comes back running only if it still ends where the try did.
            const stopped = !!s && !s.active && !!s.ended_at && Math.abs(Date.parse(s.ended_at) - Date.parse(cur.ended_at)) <= 1500;
            const w = await undoFinish(ctx.fam, id, { expectUpdatedAt: cur.updated_at, sleep: s && stopped ? { id: s.id, expectUpdatedAt: s.updated_at, wasActive: true } : null, by: ctx.who.id });
            return ok(`Bassinet try ${tryRef(id)} is running again${w.sleep?.active && stopped ? `, and so is the sleep timer (#${w.sleep.id})` : ""}.`, { reopened: true, try: tryJson(w.try, ctx) });
          }
          const start = startFrom(a, ctx, assumed);
          const end = endFrom(a, ctx, assumed);
          const patch: TryPatch = {};
          if (start) patch.started_at = start;
          if (end) patch.ended_at = end;
          if (a.outcome) patch.outcome = a.outcome as TryOutcome;
          if (a.tags) patch.tags = cleanTags(a.tags);
          if (a.note != null) patch.note = cleanNote(a.note);
          if (a.put_down_by != null) patch.put_down_by = personArg(a.put_down_by, ctx, "put_down_by");
          if (!Object.keys(patch).length) throw new ToolError("Nothing to change: give a new time, end, outcome, tags, note or put_down_by.");
          const w = await updateTry(ctx.fam, id, patch, { by: ctx.who.id });
          const nums = numberTries(await recent(ctx, Date.parse(w.try.started_at)), ctx.tz);
          const lines = [`Updated bassinet try ${tryRef(id)}: now ${tryLine(w.try, ctx, nums).replace(/^Bassinet try t\d+(: | running: )/, "")}`];
          if (w.sleepMoved && w.sleep) lines.push(`The sleep it sits on moved with it (#${w.sleep.id}).`);
          return ok([...lines, ...noteLines(assumed)].join("\n"), { updated: true, try: tryJson(w.try, ctx, nums), was: tryJson(w.before!, ctx, nums) });
        }
      }
    }
  );

  // ── holding shifts ──

  const handoffArg = (a: { handoff_at?: string | null; handoff_in_minutes?: number | null }, ctx: Ctx, from: Date, assumed: string[]): Date | null | undefined => {
    if (a.handoff_at && a.handoff_in_minutes != null) throw new ToolError("Give handoff_at or handoff_in_minutes, not both.");
    if (a.handoff_in_minutes != null) return new Date(from.getTime() + a.handoff_in_minutes * MIN);
    // A clock time for a handoff means the next one ahead, never one gone by.
    if (a.handoff_at) return startFrom({ at: a.handoff_at }, { ...ctx, now: new Date(ctx.now.getTime() + 13 * 3600_000) }, assumed);
    return undefined;
  };

  addSleepTool(
    server,
    "holding",
    {
      title: `Who's holding ${vo.name}`,
      description: `Someone holding ${vo.name} while staying awake: start (who, planned handoff, who's next; asleep: true when ${vo.they}${vo.verb("'s")} asleep in the holder's arms, which logs that sleep), ask (the holder is getting sleepy and wants \`to\` to take over now: the family's phones are told, and nothing changes hands until that person has ${vo.them}), accept (the person talking has ${vo.them} now), hand_off (\`to\` has ${vo.them} now), end (nobody's holding ${vo.them}; it stops a sleep in arms). Into the bassinet is bassinet_try start.`,
      inputSchema: {
        action: z.enum(["start", "ask", "accept", "hand_off", "end"]),
        holder: z.string().max(80).nullish().describe('A name, or "me" (default).'),
        to: z.string().max(80).nullish().describe("ask: who to wake; hand_off: who has them now"),
        at: local("When it happened (default now)"),
        minutes_ago: ago("when it happened"),
        handoff_at: local("The planned handoff"),
        handoff_in_minutes: z.number().int().min(15).max(720).nullish(),
        next_holder: z.string().max(80).nullish(),
        asleep: z.boolean().nullish().describe("start: asleep in the holder's arms now"),
        sleepy: z.boolean().nullish().describe("hand_off: the holder is getting sleepy (the same as ask)"),
        client_ref: z.string().max(100).nullish(),
      },
      annotations: WRITE_ANN,
      invoking: "Noting who's holding…",
      invoked: "Holding saved",
      write: true,
    },
    async (a, ctx) => {
      const v = voiceOf(ctx);
      const assumed: string[] = [];
      const when = startFrom(a, ctx, assumed) ?? ctx.now;
      if (a.action === "end") {
        const open = await openShift(ctx.fam, ctx.baby.id);
        if (!open) throw new ToolError(`Nobody is recorded holding ${v.name} right now.`);
        const w = await endShift(ctx.fam, open.id, { at: when, how: "ended", by: ctx.who.id });
        holdingChanged({ familyId: ctx.fam.familyId });
        const stopped = w.sleep ? ` ${v.Name}'s sleep in arms (#${w.sleep.id}) stopped then too.` : "";
        return ok(`Ended ${who(w.shift.holder, ctx)}'s holding shift (${shiftRef(w.shift.id)}) at ${whenText(w.shift.ended_at!, ctx)}.${stopped}`, {
          ended: true,
          shift: shiftJson(w.shift, ctx),
          ...(w.sleep ? { sleep_stopped: w.sleep.id } : {}),
        });
      }
      const open = await openShift(ctx.fam, ctx.baby.id);
      // "Wake [partner]": an ask, never a handoff (hand_off with sleepy: true is the same). Nothing changes hands until they have her.
      if (a.action === "ask" || (a.action === "hand_off" && a.sleepy)) {
        if (!a.to) throw new ToolError("Say who to wake (to).");
        const to = personArg(a.to, ctx, "to")!;
        const w = await askHandoff(ctx.fam, { babyId: ctx.baby.id, id: open?.id ?? null, to, by: ctx.who.id, source: ctx.who.via, device: ctx.device, clientId: ref(a.client_ref, ctx) });
        holdingChanged({ familyId: ctx.fam.familyId, wake: { shiftId: w.shift.id, device: ctx.device } });
        const holder = who(w.shift.holder, ctx);
        const asked = who(to, ctx);
        return ok(
          [
            `Asked ${asked} to take over at ${formatTime(w.shift.asked_at!, ctx.tz)} (${shiftRef(w.shift.id)}). Nothing has changed hands: ${holder} is still holding ${v.name} until ${asked} has ${v.them} (holding accept from ${asked}, or hand_off when ${holder} says ${asked} has ${v.them}).`,
            // "Handoff now" goes only to the phones of the person asked.
            `${asked}'s phone gets a notice now if handoff reminders are on there. Don't count on it: go and wake ${asked}. If ${holder} gets sleepier before ${asked} comes, lay ${v.them} on ${v.their} back in the bassinet now (bassinet_try start).`,
            ...noteLines(assumed),
          ].join("\n"),
          { asked: true, shift: shiftJson(w.shift, ctx), undo: "undo_last" }
        );
      }
      // "I've got her": the person talking takes over the turn as it is now (asked or not), with a catch-up to read.
      if (a.action === "accept") {
        if (!open) throw new ToolError(`Nobody is recorded holding ${v.name} right now. To start holding ${v.them}, use action "start".`);
        const handoff = handoffArg(a, ctx, ctx.now, assumed);
        const w = await acceptHandoff(ctx.fam, open.id, { by: ctx.who.id, source: ctx.who.via, device: ctx.device, tz: ctx.tz, ...(handoff !== undefined ? { handoffAt: handoff } : {}) });
        holdingChanged({ familyId: ctx.fam.familyId });
        const arms = await armsRunningLine(ctx);
        return ok(
          [
            `${who(w.shift.holder, ctx)} has ${v.name} now (${shiftRef(w.shift.id)}, since ${formatTime(w.shift.started_at, ctx.tz)}), taking over from ${who(open.holder, ctx)}${nextHandoffWords(w, ctx)}.`,
            ...(arms ? [arms] : []),
            "For a catch-up (the last feed and next side, the last diaper, anything running), call maple_status.",
            ...noteLines(assumed),
          ].join("\n"),
          { handed_off: true, shift: shiftJson(w.shift, ctx), ended: w.ended ? shiftJson(w.ended, ctx) : null, ...(w.handoffWhy ? { next_handoff_moved: w.handoffWhy } : {}), undo: "undo_last" }
        );
      }
      const handoff = handoffArg(a, ctx, when, assumed);
      if (a.action === "hand_off" && open) {
        if (!a.to) throw new ToolError("Say who takes over (to).");
        const w = await handOff(ctx.fam, open.id, { to: personArg(a.to, ctx, "to")!, at: when, ...(handoff !== undefined ? { handoffAt: handoff } : {}), by: ctx.who.id, source: ctx.who.via, device: ctx.device, tz: ctx.tz });
        holdingChanged({ familyId: ctx.fam.familyId });
        const arms = await armsRunningLine(ctx);
        const next = nextHandoffWords(w, ctx).replace(/^; the next handoff is planned for/, ", with the next handoff planned for").replace(/^; no next/, ", with no next");
        const lines = [
          `Handed off at ${whenText(w.shift.started_at, ctx)}: ${who(w.shift.holder, ctx)} is holding ${v.name} now${next}. ${who(open.holder, ctx)} held ${v.them} from ${formatTime(open.started_at, ctx.tz)} (${shiftRef(open.id)}).`,
          ...(arms ? [arms] : []),
        ];
        return ok([...lines, ...noteLines(assumed)].join("\n"), { handed_off: true, shift: shiftJson(w.shift, ctx), ended: w.ended ? shiftJson(w.ended, ctx) : null, ...(w.handoffWhy ? { next_handoff_moved: w.handoffWhy } : {}) });
      }
      // A start, or a hand-off with nobody recorded holding her: the new holder's shift starts.
      const holder = a.action === "hand_off" ? personArg(a.to, ctx, "to") : personArg(a.holder, ctx, "holder") ?? ctx.who.id;
      if (!holder) throw new ToolError("Say who takes over (to).");
      const w = await startShift(ctx.fam, {
        babyId: ctx.baby.id,
        holder,
        at: when,
        handoffAt: handoff ?? null,
        nextHolder: personArg(a.next_holder, ctx, "next_holder"),
        asleep: a.action === "start" && a.asleep === true,
        by: ctx.who.id,
        source: ctx.who.via,
        clientId: ref(a.client_ref, ctx),
        device: ctx.device,
      });
      if (w.status === "created") holdingChanged({ familyId: ctx.fam.familyId });
      const head =
        w.status === "open"
          ? `${who(w.shift.holder, ctx)} is already holding ${v.name} (since ${whenText(w.shift.started_at, ctx)}, ${shiftRef(w.shift.id)}). To swap, use action "hand_off".`
          : w.status === "deduped"
            ? `Already saved: ${shiftLine(w.shift, ctx)}`
            : `Saved holding shift ${shiftRef(w.shift.id)}: ${shiftLine(w.shift, ctx).replace(/^Holding: /, "").replace(/ \(h\d+\)/, "")}`;
      // Asleep in arms: a sleep in the log, carried through handoffs, sat on by a try, stopped by ending the turn awake.
      const arms = w.sleep
        ? w.madeSleep
          ? `${v.Name}'s sleep in arms is logged from ${formatTime(w.sleep.started_at, ctx.tz)} (#${w.sleep.id}): it carries on through handoffs, a bassinet try sits on it, and ending the turn awake stops it. Don't also log this sleep.`
          : `${v.Name}'s sleep timer was already running (#${w.sleep.id}, since ${formatTime(w.sleep.started_at, ctx.tz)}), so no second sleep was started.`
        : null;
      return ok([head, ...(arms ? [arms] : []), ...noteLines(assumed)].join("\n"), {
        started: w.status === "created",
        ...(w.status === "open" ? { already_open: true } : {}),
        shift: shiftJson(w.shift, ctx),
        ...(w.sleep ? { sleep: w.sleep.id } : {}),
        undo: "undo_last",
      });
    }
  );

  // ── sleep goals, coached ──

  const targetShape = z.object({
    kind: z.enum(TARGET_KINDS),
    per_week: z.number().int().min(1).max(7).nullish(),
    min_minutes: z.number().int().min(15).max(720).nullish(),
    minutes: z.number().int().min(15).max(720).nullish(),
    member: z.string().max(80).nullish(),
    text: z.string().max(120).nullish(),
    id: z.string().max(12).nullish(),
  });
  const stepShape = z.object({ title: z.string().max(120), week_of: z.string().max(10).nullish(), id: z.string().max(12).nullish() });
  const windowShape = z.object({
    member: z.string().max(80),
    from: z.string().max(5),
    to: z.string().max(5),
    nights: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    covers: z.enum(WINDOW_COVERS).nullish().describe(`How ${vo.their} feeds inside it are covered: nurse (brought to nurse), bottle (expressed milk), none (no feed planned)`),
    id: z.string().max(12).nullish(),
  });
  // The quick setup's five answers (goals.ts backToWorkGoal); people by name or "me".
  const backToWorkShape = z.object({
    returning: z.string().max(80).describe('Who goes back to work: a name, or "me"'),
    return_date: z.string().max(20).describe('Their day back: YYYY-MM-DD or "in 4 weeks"'),
    feeding: z.enum(QUICK_FEEDING),
    nursing: z.string().max(80).nullish().describe("Who nurses (for nursing or both)"),
    sleeps: z.enum(QUICK_SLEEPS).describe(`Where ${vo.name} sleeps now`),
    first_half: z.string().max(80).describe("Who's on duty for the first half of the night"),
    second_half: z.string().max(80).describe("Who's on duty for the second half"),
    off_duty: z.enum(QUICK_OFF_DUTY).describe("Where the adult who's off sleeps"),
    split: z.string().max(5).nullish().describe('Where the night splits, like "02:00" (the night is 10 PM to 6 AM)'),
  });

  addSleepTool(
    server,
    "sleep_goal",
    {
      title: "Sleep goals",
      description: `Sleep goals, coached: add, update (with its revision), step (mark one done), check_in, review, close (met or dropped). A goal has a target date, measurable targets, weekly steps and, if it helps, a roster of protected sleep windows per adult. Coach this way: ask one question at a time (in Maple chat, with ask_user); use the family's memories for their constraints; propose one goal with its steps, read it back and save it only after a yes (add, update and close need confirmed: true). A family's first goal, when someone is going back to work and two adults log: ask the quick setup's five questions, one at a time (who goes back to work and on what day; nursing, bottles or both, and who nurses; where ${vo.name} sleeps now; who's on duty for each half of the night, and where the adult who's off sleeps; the target date, two weeks after the day back unless they say), then call add with back_to_work: it builds a goal, a night roster (each window's feeds covered by how ${vo.they} ${vo.verb("is")} fed) and up to three steps timed from the day back, for one read-back; with no logs needed first. Each adult checks in the morning after: check_in saves only the signed-in person's own answer (protected yes, partly or no, and an optional note about the night), never hours slept, mood or anyone's health. sleep_plan has each goal's progress, counted from the log, and coach notes: talk it over, then review with a short note. Counts are only what was logged: a night with nothing logged is unknown, so leave it out and don't ask about it, never "didn't". ${ENOUGH_NIGHTS_LINE} Under that, suggest no next step or stage change. After a quiet stretch, ask how they are first; a clean restart is theirs to choose: update with counts_from "tonight" (pick up from tonight) or paused_until "in 1 week" (ease off a week), or close as dropped (set it aside). End a review with one step for this week that they choose, saved as a step. Steps are one-off actions; a habit belongs in a target. No medical advice. Feeding changes (bottles, pumping, formula) stay questions for their pediatrician or lactation consultant. The tool refuses crying it out and sleep on or with an adult; never ${vo.name} sleeping on an adult, or in a bed, couch or armchair with one, as a plan. Hard nights are neutral: plain counts, no blame. A refusal says what to try instead: offer that wording. Targets: bassinet_nights {per_week, min_minutes}, bassinet_stretch {minutes}, protected_window {member, per_week}, custom {text}.`,
      inputSchema: {
        action: z.enum(["add", "update", "step", "check_in", "review", "close"]),
        id: z.string().max(20).nullish().describe("The goal, like g3"),
        revision: z.number().int().positive().nullish().describe("update: the goal's revision from sleep_plan"),
        confirmed: z.boolean().nullish().describe("add, update, close: true only once you read it back and they said yes"),
        title: z.string().max(120).nullish(),
        why: z.string().max(300).nullish(),
        target_date: z.string().max(20).nullish().describe('YYYY-MM-DD, "in 4 weeks", or "none"'),
        targets: z.array(targetShape).max(6).nullish().describe("The whole list"),
        steps: z.array(stepShape).max(12).nullish().describe("The whole list; week_of is a date in its week"),
        roster: z.array(windowShape).max(6).nullish().describe('Protected sleep windows: from and to like "22:00", nights the evenings it begins on, 0 (Sun) to 6 (Sat)'),
        back_to_work: backToWorkShape.nullish().describe("add: the quick setup's answers; builds the goal (title, why, target date, targets, steps and roster) for its read-back"),
        status: z.enum(["active", "paused", "met", "dropped"]).nullish().describe("update: active or paused; close: met or dropped"),
        counts_from: z.string().max(20).nullish().describe('update: "tonight" or YYYY-MM-DD, counting only from then; "none" clears it'),
        paused_until: z.string().max(20).nullish().describe('update: "in 1 week" or YYYY-MM-DD, the night it counts again; "none" stops easing off'),
        step: z.string().max(12).nullish().describe("step: its id, like s2"),
        done: z.boolean().nullish(),
        protected: z.enum(PROTECTED_ANSWERS).nullish().describe("check_in: did they get their protected sleep"),
        night: z.string().max(20).nullish().describe("check_in: YYYY-MM-DD, the evening it began (default last night)"),
        place: z.enum(CHECKIN_PLACES).nullish().describe(`check_in, if they said: where ${vo.name} spent most of the night`),
        untimed_try: z.enum(UNTIMED_TRIES).nullish().describe("check_in: a bassinet try that isn't in the log (long: asleep untimed_minutes or more)"),
        untimed_minutes: z.number().int().min(15).max(720).nullish(),
        handoff: z.enum(HANDOFF_ANSWERS).nullish().describe("check_in: the planned handoff"),
        note: z.string().max(GOAL_NOTE_MAX).nullish().describe("check_in (200 at most): about the night only; review and close: a short note"),
        client_ref: z.string().max(100).nullish(),
      },
      annotations: WRITE_ANN,
      invoking: "Working on the sleep goal…",
      invoked: "Sleep goal saved",
      write: true,
    },
    async (a, ctx) => {
      const gc = goalCtx(ctx);
      const by = ctx.who.id;
      const source = ctx.who.via;
      const name = (id: string) => who(id, ctx);
      try {
        switch (a.action) {
          case "add": {
            if (a.back_to_work && nightAdults(ctx).length < 2) {
              throw new ToolError("The back-to-work quick setup splits the night between two adults who log, and this family has one. Set a goal by hand instead: sleep_goal add with a title, its targets and a step or two, read back first.");
            }
            const quick = a.back_to_work ? quickGoal(a.back_to_work, a, ctx) : null;
            if (!quick && !a.title?.trim()) throw new ToolError("Give the goal a short title in their words (title), or pass back_to_work with the quick setup's answers.");
            const input = quick ? quick.goal : goalInputFrom(a, ctx, "add");
            if (a.confirmed !== true) {
              // Checked now, so what they say yes to is what saves; what it needs said with it comes with the read-back.
              const { fields } = cleanGoalInput(input, { ...gc, current: null, seq: 0 }, "create");
              const cautions = cautionLines(fields, ctx);
              const again = quick ? "call sleep_goal add again with the same back_to_work answers and confirmed: true (to change something first, change that answer, or the title)" : "call sleep_goal add again with the same goal and confirmed: true";
              return ok(
                [
                  `Nothing saved yet. Read this back to them: a sleep goal ${draftWords(fields, ctx)}. Only if they say yes, ${again}.`,
                  ...(quick?.notes.length ? [`Say this with it: ${quick.notes.join(" ")}`] : []),
                  ...cautions,
                ].join("\n"),
                { confirm_needed: true, ...(cautions.length ? { cautions } : {}), ...(quick?.notes.length ? { notes: quick.notes } : {}) }
              );
            }
            const w = await createGoal(ctx.fam, { babyId: ctx.baby.id, goal: input, ctx: gc, by, source, clientId: ref(a.client_ref, ctx), device: ctx.device });
            const p = await oneProgress(w.goal, ctx);
            const coach = coachNotes(w.goal, p, goalWords(ctx));
            const lonely = w.goal.targets.flatMap((t) => (t.kind === "protected_window" && !w.goal.roster.some((x) => x.member === t.member) ? [name(t.member)] : []));
            const lines = [
              w.status === "deduped" ? `Already saved sleep goal ${goalRef(w.goal.id)} ("${w.goal.title}"), so it wasn't added twice.` : `Saved sleep goal ${goalRef(w.goal.id)}: "${w.goal.title}" (set by ${ctx.who.name}).`,
              goalHeadLine(w.goal, p, goalWords(ctx)),
              ...(lonely.length ? [`No window on the roster yet for ${lonely.join(", ")}: their check-ins still count, and the roster can be added with update.`] : []),
              ...coach.notes.map((n) => `Coach note: ${n}`),
            ];
            return ok(lines.join("\n"), {
              created: w.status === "created",
              ...(w.status === "deduped" ? { deduped: true } : {}),
              goal: goalJson(w.goal, ctx),
              coach: coachJson(coach, ctx),
              undo: `sleep_goal {action:"close", id:"${goalRef(w.goal.id)}", status:"dropped", confirmed:true}, after they say yes`,
            });
          }
          case "update": {
            const id = goalIdArg(a.id);
            const cur = await getGoal(ctx.fam, id);
            if (!cur || cur.baby_id !== ctx.baby.id) throw new ToolError(`There's no sleep goal ${goalRef(id)}. sleep_plan lists the goals.`);
            const input = goalInputFrom(a, ctx, "update");
            if (!Object.keys(input).length) throw new ToolError("Nothing to change: give a title, why, target_date, targets, steps, roster, status (active or paused), counts_from or paused_until.");
            // Stopping easing off early picks the goal up from tonight, so the nights it eased off never count as missed.
            if (input.paused_until === null && input.counts_from === undefined && cur.paused_until && dayKey(ctx.now, ctx.tz) < cur.paused_until) input.counts_from = tonightKey(ctx.now, ctx.tz);
            if (a.revision == null) throw new ToolError(`Pass the goal's revision (${cur.revision} now, from sleep_plan) so a change made meanwhile isn't overwritten.`);
            if (a.revision !== cur.revision) throw new SleepConflict("Someone changed this sleep goal just now.", "changed", cur);
            if (a.confirmed !== true) {
              // New items take ids past any the goal has, so the read-back never mistakes one for an item it keeps.
              const { fields } = cleanGoalInput(input, { ...gc, current: cur, seq: 1_000_000 }, "update");
              const cautions = cautionLines(changedFields(cur, fields), ctx);
              return ok(
                [
                  `Nothing changed yet. Read this back to them: sleep goal ${goalRef(id)} ("${cur.title}"): ${changeWords(cur, fields, ctx)}. Only if they say yes, call sleep_goal update again with confirmed: true and revision ${cur.revision}.`,
                  ...cautions,
                ].join("\n"),
                { confirm_needed: true, revision: cur.revision, ...(cautions.length ? { cautions } : {}) }
              );
            }
            const w = await updateGoal(ctx.fam, id, { patch: input, revision: a.revision, ctx: gc, by, source });
            const p = await oneProgress(w.goal, ctx);
            const b = goalBlock(w.goal, p, ctx);
            return ok([`Updated sleep goal ${goalRef(id)} (revision ${w.goal.revision} now).`, ...b.lines].join("\n"), { updated: w.status === "updated", goal: goalJson(w.goal, ctx), coach: coachJson(b.coach, ctx), was: w.before ? goalJson(w.before, ctx) : null });
          }
          case "step": {
            const id = goalIdArg(a.id);
            if (!a.step?.trim()) throw new ToolError("Say which step (step, like s2); sleep_plan lists them.");
            const w = await setGoalStep(ctx.fam, id, { step: a.step.trim(), done: a.done !== false, by, source });
            const s = w.goal.steps.find((x) => x.id === a.step!.trim())!;
            const done = w.goal.steps.filter((x) => x.done_at).length;
            const next = nextStep(w.goal.steps);
            const head =
              w.status === "unchanged"
                ? `Step ${s.id} ("${s.title}") was already ${s.done_at ? `done (${who(s.done_by, ctx)}, ${whenText(s.done_at, ctx)})` : "not done"}. Nothing changed.`
                : s.done_at
                  ? `Marked step ${s.id} done on sleep goal ${goalRef(id)}: "${s.title}".`
                  : `Step ${s.id} on sleep goal ${goalRef(id)} isn't done anymore: "${s.title}".`;
            return ok([head, `Steps: ${done} of ${w.goal.steps.length} done${next ? `; next: "${next.title}" (${next.id})` : ""}.`].join("\n"), {
              updated: w.status === "updated",
              step: { id: s.id, title: s.title, done: !!s.done_at },
              goal: goalJson(w.goal, ctx),
              undo: `sleep_goal {action:"step", id:"${goalRef(id)}", step:"${s.id}", done:${!s.done_at}}`,
            });
          }
          case "check_in": {
            if (!a.protected) throw new ToolError("Say whether they got their protected sleep: protected yes, partly or no.");
            const raw = a.night?.trim() ?? "";
            const given = !raw || /^(last night|last_night|yesterday)$/i.test(raw) ? undefined : raw;
            // Before 5 AM the night still going can't be checked in, and "last night" would be the one before it, which isn't
            // what someone checking in at 2 AM is likely to mean: so no default then, only a night they name.
            if (!given && !checkinMorning(ctx.now, ctx.tz)) {
              throw new ToolError(`Nothing was saved: it's still the night (${formatTime(ctx.now, ctx.tz)}), and a check-in is for a night that's over, from ${NIGHT_OVER_HOUR} AM the morning after. Ask them to check in then; for an earlier night, pass its date (the latest that's over began ${lastNightKey(ctx.now, ctx.tz)}).`);
            }
            // The night it's for, checked first: never one still going, and never before the caller's own window that night is
            // over, as Today asks.
            const night = cleanCheckinNight(given, ctx.now, ctx.tz);
            const going = (await listGoals(ctx.fam, ctx.baby.id))
              .filter((g) => g.status === "active" && goalStartKey(g, ctx.tz) <= night)
              .flatMap((g) => g.roster.filter((w) => w.member === by && windowOnNight(w, night)))
              .map((w) => ({ w, end: windowOn(w, night, ctx.tz)[1] }))
              .filter((x) => x.end.getTime() > ctx.now.getTime())
              .sort((x, y) => y.end.getTime() - x.end.getTime())[0];
            if (going) throw new ToolError(`Nothing was saved: your protected window that night (${windowTimes(going.w)}) isn't over until ${formatTime(going.end, ctx.tz)}. Check in once it ends.`);
            // The night's other answers, only those they gave (each once a night: the first one given counts).
            const extras = {
              ...(a.place != null ? { place: a.place } : {}),
              ...(a.untimed_try != null ? { untimed_try: a.untimed_try, untimed_min: a.untimed_try === "no" ? null : (a.untimed_minutes ?? null) } : {}),
              ...(a.handoff != null ? { handoff: a.handoff } : {}),
            };
            const w = await saveCheckin(ctx.fam, {
              babyId: ctx.baby.id,
              member: by,
              night,
              protected: a.protected,
              ...(a.note != null ? { note: a.note } : {}),
              extras,
              tz: ctx.tz,
              now: ctx.now,
              source,
              clientId: ref(a.client_ref, ctx),
              device: ctx.device,
            });
            const said = checkinWords(w.checkin, ctx.now, ctx.tz);
            const head =
              w.status === "created"
                ? `Saved your check-in for ${said}.`
                : w.status === "updated"
                  ? w.before!.protected === w.checkin.protected
                    ? `Updated your check-in for ${said}.`
                    : `Changed your check-in for ${said} (it was ${PROTECTED_LABEL[w.before!.protected].toLowerCase()}).`
                  : w.status === "deduped"
                    ? `Already saved your check-in for ${said}, so it wasn't added twice.`
                    : `Your check-in for ${said} already says that. Nothing changed.`;
            const c = w.checkin;
            const also = [
              c.place ? `where ${voiceOf(ctx).name} spent most of the night: ${PLACE_LABEL[c.place].toLowerCase()}` : "",
              c.untimed_try ? `a try not in the log: ${c.untimed_try === "no" ? "none" : c.untimed_try === "long" ? `one asleep ${c.untimed_min ? `${c.untimed_min} minutes` : "a while"} or more` : "a shorter one"}` : "",
              c.handoff ? `the planned handoff: ${HANDOFF_LABEL[c.handoff].toLowerCase()}` : "",
            ].filter(Boolean);
            return ok([head, ...(also.length ? [`With it: ${also.join("; ")}.`] : []), "Owners and members of the family see check-ins; view-only guests don't."].join("\n"), {
              saved: w.status === "created" || w.status === "updated",
              checkin: { night: c.night, protected: c.protected, ...(c.note ? { note: c.note } : {}), ...(c.place ? { place: c.place } : {}), ...(c.untimed_try ? { untimed_try: c.untimed_try } : {}), ...(c.handoff ? { handoff: c.handoff } : {}) },
              undo:
                w.status === "created"
                  ? "undo_last"
                  : w.status === "updated"
                    ? `sleep_goal {action:"check_in", night:"${w.checkin.night}", protected:"${w.before!.protected}"}`
                    : null,
            });
          }
          case "review": {
            const id = goalIdArg(a.id);
            const w = await reviewGoal(ctx.fam, id, { note: a.note ?? null, by, source, ...(a.revision != null ? { revision: a.revision } : {}) });
            return ok(`Reviewed sleep goal ${goalRef(id)} ("${w.goal.title}")${w.goal.review_note ? ` with the note "${w.goal.review_note}"` : ""}. The next review is due in a week.`, { reviewed: true, goal: goalJson(w.goal, ctx) });
          }
          case "close": {
            const id = goalIdArg(a.id);
            if (a.status !== "met" && a.status !== "dropped") throw new ToolError('Say how it closes: status "met" or "dropped".');
            const cur = await getGoal(ctx.fam, id);
            if (!cur || cur.baby_id !== ctx.baby.id) throw new ToolError(`There's no sleep goal ${goalRef(id)}. sleep_plan lists the goals.`);
            const how = a.status === "met" ? "as met" : "as dropped (set aside)";
            if (a.confirmed !== true) {
              return ok(`Nothing changed yet. Read this back to them: close sleep goal ${goalRef(id)} ("${cur.title}") ${how}${a.note?.trim() ? `, with the note "${a.note.trim()}"` : ""}. Only if they say yes, call sleep_goal close again with confirmed: true.`, { confirm_needed: true });
            }
            const w = await closeGoal(ctx.fam, id, { status: a.status, ...(a.note != null ? { note: a.note } : {}), by, source, ...(a.revision != null ? { revision: a.revision } : {}) });
            const head = w.status === "unchanged" ? `Sleep goal ${goalRef(id)} is already closed ${how}. Nothing changed.` : `Closed sleep goal ${goalRef(id)} ("${w.goal.title}") ${how}.`;
            return ok(`${head} To open it again: sleep_goal update with status active (revision ${w.goal.revision}).`, { closed: w.status === "updated", goal: goalJson(w.goal, ctx) });
          }
        }
      } catch (err) {
        if (err instanceof SleepConflict) throw new ToolError(goalConflictText(err, ctx));
        // Another family's goal reads exactly like one nobody has.
        if (err instanceof NotFound && /^Sleep goal \d+ not found$/.test(err.message)) throw new ToolError(`There's no sleep goal ${goalRef(Number(err.message.split(" ")[2]))}. sleep_plan lists the goals.`);
        throw err;
      }
    }
  );
}

const ref = (raw: string | null | undefined, ctx: Ctx) => {
  const r = raw?.trim() || null;
  return r ? clientIdFor(ctx, r) : null;
};

/**
 * Tries and shifts this member made through an assistant in the last 30
 * minutes, and an open ask they made ("Wake [partner]"), newest first:
 * undo_last's share. An ask is taken back (cancelAsk), never its whole turn.
 */
export async function undoableSleep(ctx: Ctx, sources: string[]): Promise<{ kind: "try" | "shift" | "ask"; id: number; created_at: string; sleepId: number | null; made: boolean; updatedAt?: string } | null> {
  const { query } = await import("@/lib/db");
  const asks = await query(
    `SELECT id, asked_at, updated_at FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND updated_by = $3 AND asked_to IS NOT NULL
       AND asked_at >= NOW() - INTERVAL '30 minutes' AND ended_at IS NULL AND deleted_at IS NULL ORDER BY asked_at DESC, id DESC LIMIT 1`,
    [ctx.fam.familyId, ctx.baby.id, ctx.who.id]
  );
  if (asks === null) throw new StoreUnavailable();
  const made = await undoableMade(ctx, sources);
  const a = asks[0] as Record<string, unknown> | undefined;
  const aAt = a ? new Date(a.asked_at as string).toISOString() : null;
  if (a && (!made || aAt! >= made.created_at)) return { kind: "ask", id: Number(a.id), created_at: aAt!, sleepId: null, made: false, updatedAt: new Date(a.updated_at as string).toISOString() };
  return made;
}

/** Take back an ask (undo_last): the turn goes on as before, with nobody asked. */
export async function undoAsk(ctx: Ctx, id: number, updatedAt: string): Promise<CallToolResult> {
  const w = await cancelAsk(ctx.fam, id, { by: ctx.who.id, expectUpdatedAt: updatedAt });
  holdingChanged({ familyId: ctx.fam.familyId });
  return ok(`Took back the ask: nobody is asked to take over now, and ${who(w.shift.holder, ctx)} is still holding ${voiceOf(ctx).name} (${shiftRef(w.shift.id)}).`, {
    unasked: true,
    shift: shiftJson(w.shift, ctx),
  });
}

async function undoableMade(ctx: Ctx, sources: string[]): Promise<{ kind: "try" | "shift"; id: number; created_at: string; sleepId: number | null; made: boolean } | null> {
  const { query } = await import("@/lib/db");
  const [tries, shifts] = await Promise.all([
    query(
      `SELECT id, created_at, sleep_entry_id, made_sleep FROM maple_sleep_tries WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND source = ANY($4::text[])
         AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ctx.fam.familyId, ctx.baby.id, ctx.who.id, sources]
    ),
    query(
      `SELECT id, created_at FROM maple_sleep_shifts WHERE family_id = $1 AND baby_id = $2 AND created_by = $3 AND source = ANY($4::text[])
         AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 minutes' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [ctx.fam.familyId, ctx.baby.id, ctx.who.id, sources]
    ),
  ]);
  if (tries === null || shifts === null) throw new StoreUnavailable();
  const t = tries[0] as Record<string, unknown> | undefined;
  const s = shifts[0] as Record<string, unknown> | undefined;
  const tAt = t ? new Date(t.created_at as string).toISOString() : null;
  const sAt = s ? new Date(s.created_at as string).toISOString() : null;
  if (t && (!sAt || tAt! >= sAt)) return { kind: "try", id: Number(t.id), created_at: tAt!, sleepId: t.sleep_entry_id == null ? null : Number(t.sleep_entry_id), made: t.made_sleep === true };
  if (s) return { kind: "shift", id: Number(s.id), created_at: sAt!, sleepId: null, made: false };
  return null;
}

const near = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) < 2000;

/**
 * undo_last's share of sleep goals and check-ins: this member's newest goal
 * write (one they saved through an assistant, or any change they made) and
 * check-in saved through an assistant, in the last 30 minutes, with when it
 * happened and what undo_last does about it. A check-in just saved is taken
 * back; anything else is explained, since a goal is the family's plan and a
 * changed check-in has no earlier answer kept to put back.
 */
export async function undoableGoalWrite(ctx: Ctx, sources: string[]): Promise<{ at: number; run: () => Promise<CallToolResult> } | null> {
  const { query } = await import("@/lib/db");
  const [goals, checkins] = await Promise.all([
    query(
      `SELECT * FROM maple_sleep_goals WHERE family_id = $1 AND baby_id = $2 AND deleted_at IS NULL
         AND ((created_by = $3 AND source = ANY($4::text[]) AND created_at >= NOW() - INTERVAL '30 minutes') OR (updated_by = $3 AND updated_at >= NOW() - INTERVAL '30 minutes'))
       ORDER BY updated_at DESC, id DESC LIMIT 5`,
      [ctx.fam.familyId, ctx.baby.id, ctx.who.id, sources]
    ),
    query(
      `SELECT * FROM maple_sleep_checkins WHERE family_id = $1 AND baby_id = $2 AND member = $3 AND source = ANY($4::text[]) AND deleted_at IS NULL
         AND updated_at >= NOW() - INTERVAL '30 minutes' ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [ctx.fam.familyId, ctx.baby.id, ctx.who.id, sources]
    ),
  ]);
  if (goals === null || checkins === null) throw new StoreUnavailable();
  // When this member last acted on each goal: their change, else their saving it.
  const mine = goals.map((r) => rowToGoal(r as Record<string, unknown>)).map((g) => ({ g, at: Date.parse(g.updated_by === ctx.who.id ? g.updated_at : g.created_at) }));
  mine.sort((x, y) => y.at - x.at);
  const goal = mine[0] ?? null;
  const c = checkins[0] ? rowToCheckin(checkins[0] as Record<string, unknown>) : null;
  const cAt = c ? Date.parse(c.updated_at) : 0;
  if (c && (!goal || cAt >= goal.at)) {
    return {
      at: cAt,
      run: async () => {
        const said = checkinWords(c, ctx.now, ctx.tz);
        if (!near(c.created_at, c.updated_at)) {
          throw new ToolError(`Nothing was removed. Your last action changed your check-in for ${said}. To change it back, sleep_goal {action:"check_in", night:"${c.night}", protected:…} with the earlier answer.`);
        }
        await deleteCheckin(ctx.fam, { babyId: ctx.baby.id, member: ctx.who.id, id: c.id });
        return ok(`Removed your check-in for ${said}. To save it again, sleep_goal {action:"check_in", night:"${c.night}", protected:"${c.protected}"}.`, {
          removed: { checkin: c.night },
          undo: `sleep_goal {action:"check_in", night:"${c.night}", protected:"${c.protected}"}`,
        });
      },
    };
  }
  if (!goal) return null;
  const g = goal.g;
  const r = goalRef(g.id);
  return {
    at: goal.at,
    run: async () => {
      const t = `sleep goal ${r} ("${g.title}")`;
      if (g.updated_by !== ctx.who.id) {
        throw new ToolError(
          `Nothing was removed. Your last action was saving ${t}. A goal stays until the family closes it: if they want it gone, sleep_goal {action:"close", id:"${r}", status:"dropped", confirmed:true} after they say yes; to change it, sleep_goal update with revision ${g.revision}.`
        );
      }
      if ((g.status === "met" || g.status === "dropped") && near(g.closed_at, g.updated_at)) {
        throw new ToolError(`Nothing was removed. Your last action closed ${t} as ${g.status}. To open it again, sleep_goal {action:"update", id:"${r}", revision:${g.revision}, status:"active", confirmed:true} after they say yes.`);
      }
      // The step this change marked: the one they marked done most recently, if that was this change.
      const step = g.steps
        .filter((s) => s.done_by === ctx.who.id && s.done_at)
        .sort((a, b) => Date.parse(b.done_at!) - Date.parse(a.done_at!))
        .find((s, i) => i === 0 && near(s.done_at, g.updated_at));
      if (step) throw new ToolError(`Nothing was removed. Your last action marked step ${step.id} ("${step.title}") of ${t} done. To take that back, sleep_goal {action:"step", id:"${r}", step:"${step.id}", done:false}.`);
      if (near(g.last_review_at, g.updated_at)) throw new ToolError(`Nothing was removed. Your last action was a review of ${t}. A review only records its note; review again to replace it.`);
      throw new ToolError(`Nothing was removed. Your last action was a change to ${t}, now at revision ${g.revision}. sleep_plan shows it as it is now; sleep_goal update with revision ${g.revision} changes it back after they say yes.`);
    },
  };
}

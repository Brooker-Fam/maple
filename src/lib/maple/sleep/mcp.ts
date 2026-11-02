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
import { formatDuration, formatTime } from "../time";
import { SLEEP_PLACES, type Entry, type Member } from "../types";
import type { Voice } from "../voice";
import { numberTries, planToday, planTodayLine, progressLines, shiftStatus, sleepAge, sleepGuidance, sleepSignals, snoozeUntil, stageSuggestion, tryDayKey, tryDayLabel, type GuideView } from "./engine";
import {
  cleanNote,
  cleanPlanPatch,
  cleanTags,
  deleteTry,
  endShift,
  ensurePlan,
  finishTry,
  getPlan,
  getTry,
  handOff,
  listTries,
  logTry,
  openShift,
  progressFor,
  restoreTry,
  runningTry,
  SleepConflict,
  SleepInputError,
  startShift,
  startTry,
  undoFinish,
  updatePlan,
  updateTry,
  type TryPatch,
  type TryWrite,
} from "./store";
import { PLAN_STAGES, TRY_OUTCOMES, TRY_TAGS, type BassinetTry, type HoldingShift, type SleepPlan, type TryOutcome } from "./types";
import { defaultGoal, OUTCOME_LABEL, SLEEP_PLACE_LABEL, slotLabel, STAGE_INFO, TAG_LABEL } from "./words";

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
  return {
    id: shiftRef(s.id),
    holder: who(s.holder, ctx),
    since_local: whenText(s.started_at, ctx),
    ...(s.handoff_at ? { handoff_planned_local: whenText(s.handoff_at, ctx), handoff_due: st.due, minutes_to_handoff: st.minutesLeft } : {}),
    ...(s.next_holder ? { next_holder: who(s.next_holder, ctx) } : {}),
    ...(s.ended_at ? { ended_local: whenText(s.ended_at, ctx), ended_how: s.ended_how } : { open: true }),
  };
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
  return `Holding: ${who(s.holder, ctx)} is holding ${vo.name} awake since ${formatTime(s.started_at, ctx.tz)} (${shiftRef(s.id)})${plan}${s.handoff_at ? next : ""}.`;
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

// ── the lines other tools add (maple_status, the chat's [App] lines) ─────

/**
 * The sleep plan as maple_status and the chat read it: a running try, who's
 * holding her, and today's tries against the plan. Nothing when the family
 * has none of it.
 */
export async function sleepStatus(ctx: Ctx): Promise<{ lines: string[]; json: Record<string, unknown> } | null> {
  const [plan, running, shift] = await Promise.all([getPlan(ctx.fam, ctx.baby.id), runningTry(ctx.fam, ctx.baby.id), openShift(ctx.fam, ctx.baby.id)]);
  if (!plan && !running && !shift) return null;
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
    const today = planToday(plan, tries, ctx.now, ctx.tz);
    lines.push(`Sleep plan: stage ${plan.stage} (${STAGE_INFO[plan.stage].title}); bassinet tries ${planTodayLine(today)}`);
    json.plan = { stage: plan.stage, today: `${today.done} of ${today.planned}`, next: today.next ? slotLabel(today.next) : null, more: "sleep_plan" };
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
      description: `For sleep questions, and before a try or holding change: ${vo.their} age, the plan (with revision), tonight's tries, a running try, who's holding ${vo.them}, a stage recent tries could support (theirs to choose), and guidance for ${vo.their} age, word for word.`,
      inputSchema: { progress_days: z.number().int().min(1).max(31).nullish().describe("Also how the last N days of tries went.") },
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
      if (plan) lines.push(`Tonight's tries: ${planTodayLine(planToday(plan, tries, ctx.now, ctx.tz))}`);
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
      lines.push(`Guidance for ${v.their} age is in guidance (word for word, with its sources). ${DISCLAIMER}`);
      return ok(lines.join("\n"), {
        age: age ? { days: age.days, label: age.label, stage: age.band.label } : null,
        plan: plan ? planJson(plan, v) : null,
        today: plan ? planToday(plan, tries, ctx.now, ctx.tz) : null,
        running_try: running ? tryJson(running, ctx, nums) : null,
        holding: shift ? shiftJson(shift, ctx) : null,
        suggestion: suggestion && !suggestion.snoozed ? { to_stage: suggestion.to, tries: suggestion.tries, days: suggestion.days, stayed_30_plus_of_last: `${suggestion.stayed} of ${suggestion.recent}` } : null,
        recent_tries: tries.slice(0, 10).map((t) => tryJson(t, ctx, nums)),
        ...(progress ? { progress } : {}),
        guidance: { now: guidance.now.map(guideJson), sections: guidance.sections.map((s) => ({ section: s.title, items: s.items.map(guideJson) })) },
      });
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
        const { plan, created } = await ensurePlan(ctx.fam, ctx.baby.id, ctx.who.id, ctx.who.via, cleanPlanPatch(raw, null));
        return ok(`${created ? "Set up" : "There's already"} ${v.name}'s sleep plan. ${planLine(plan, v)}`, { created, plan: planJson(plan, v) });
      }
      if (!Object.keys(raw).length) throw new ToolError("Nothing to change: give a stage, tries_per_day, try_times, backup, sleeps_now, goal or not_now.");
      if (a.revision == null) throw new ToolError(`Pass the plan's revision (${current.revision} now, from sleep_plan) so a change made meanwhile isn't overwritten.`);
      try {
        const { plan, before } = await updatePlan(ctx.fam, ctx.baby.id, cleanPlanPatch(raw, current), a.revision, ctx.who.id, ctx.who.via);
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
      description: `Someone holding ${vo.name} while staying awake: start (who, planned handoff, who's next), hand_off (sleepy: true when the holder is getting sleepy; the family's phones are told), end. Into the bassinet is bassinet_try start.`,
      inputSchema: {
        action: z.enum(["start", "hand_off", "end"]),
        holder: z.string().max(80).nullish().describe('A name, or "me" (default).'),
        to: z.string().max(80).nullish().describe("hand_off: who takes over"),
        at: local("When it happened (default now)"),
        minutes_ago: ago("when it happened"),
        handoff_at: local("The planned handoff"),
        handoff_in_minutes: z.number().int().min(15).max(720).nullish(),
        next_holder: z.string().max(80).nullish(),
        sleepy: z.boolean().nullish(),
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
        return ok(`Ended ${who(w.shift.holder, ctx)}'s holding shift (${shiftRef(w.shift.id)}) at ${whenText(w.shift.ended_at!, ctx)}.`, { ended: true, shift: shiftJson(w.shift, ctx) });
      }
      const handoff = handoffArg(a, ctx, when, assumed);
      const open = await openShift(ctx.fam, ctx.baby.id);
      if (a.action === "hand_off" && open) {
        if (!a.to) throw new ToolError("Say who takes over (to).");
        const w = await handOff(ctx.fam, open.id, { to: personArg(a.to, ctx, "to")!, at: when, ...(handoff !== undefined ? { handoffAt: handoff } : {}), by: ctx.who.id, source: ctx.who.via, device: ctx.device });
        holdingChanged({ familyId: ctx.fam.familyId, ...(a.sleepy ? { wake: { shiftId: w.shift.id, device: ctx.device } } : {}) });
        const lines = [
          `Handed off at ${whenText(w.shift.started_at, ctx)}: ${who(w.shift.holder, ctx)} is holding ${v.name} now${w.shift.handoff_at ? `, with the next handoff planned for ${formatTime(w.shift.handoff_at, ctx.tz)}` : ""}. ${who(open.holder, ctx)} held ${v.them} from ${formatTime(open.started_at, ctx.tz)} (${shiftRef(open.id)}).`,
          ...(a.sleepy ? ["Phones in the family with handoff reminders on get a notice now."] : []),
        ];
        return ok([...lines, ...noteLines(assumed)].join("\n"), { handed_off: true, shift: shiftJson(w.shift, ctx), ended: w.ended ? shiftJson(w.ended, ctx) : null });
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
        by: ctx.who.id,
        source: ctx.who.via,
        clientId: ref(a.client_ref, ctx),
        device: ctx.device,
      });
      if (w.status === "created") holdingChanged({ familyId: ctx.fam.familyId, ...(a.sleepy ? { wake: { shiftId: w.shift.id, device: ctx.device } } : {}) });
      const head =
        w.status === "open"
          ? `${who(w.shift.holder, ctx)} is already holding ${v.name} (since ${whenText(w.shift.started_at, ctx)}, ${shiftRef(w.shift.id)}). To swap, use action "hand_off".`
          : w.status === "deduped"
            ? `Already saved: ${shiftLine(w.shift, ctx)}`
            : `Saved holding shift ${shiftRef(w.shift.id)}: ${shiftLine(w.shift, ctx).replace(/^Holding: /, "").replace(/ \(h\d+\)/, "")}`;
      return ok([head, ...noteLines(assumed)].join("\n"), {
        started: w.status === "created",
        ...(w.status === "open" ? { already_open: true } : {}),
        shift: shiftJson(w.shift, ctx),
        undo: "undo_last",
      });
    }
  );
}

const ref = (raw: string | null | undefined, ctx: Ctx) => {
  const r = raw?.trim() || null;
  return r ? clientIdFor(ctx, r) : null;
};

/** Tries and shifts this member made through an assistant in the last 30 minutes, newest first: undo_last's share. */
export async function undoableSleep(ctx: Ctx, sources: string[]): Promise<{ kind: "try" | "shift"; id: number; created_at: string; sleepId: number | null; made: boolean } | null> {
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

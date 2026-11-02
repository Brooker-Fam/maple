import type { NextRequest } from "next/server";
import { listMembers } from "@/lib/maple/auth";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import type { FamilyCtx } from "@/lib/maple/family";
import { memberName } from "@/lib/maple/insights";
import { holdingChanged } from "@/lib/maple/push-hooks";
import { progressLines, sleepAge } from "@/lib/maple/sleep/engine";
import { coachNotes, goalCautions, goalProgressLines, seesCheckins, type GoalWords } from "@/lib/maple/sleep/goals";
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
  deleteShift,
  deleteTry,
  endShift,
  ensurePlan,
  finishTry,
  getGoal,
  getPlan,
  goalProgressFor,
  handOff,
  listGoals,
  logTry,
  progressFor,
  reopenShift,
  restoreShift,
  restoreTry,
  reviewGoal,
  saveCheckin,
  setGoalStep,
  SleepConflict,
  SleepInputError,
  sleepStateFor,
  startArmsSleep,
  startShift,
  startTry,
  undoFinish,
  undoHandOff,
  undoTurnSleep,
  updateGoal,
  updatePlan,
  updateShift,
  updateTry,
  type GoalCtx,
  type TryPatch,
} from "@/lib/maple/sleep/store";
import { SHIFT_ENDINGS, TRY_OUTCOMES, type GoalInput, type ShiftEnding, type SleepGoal, type TryOutcome } from "@/lib/maple/sleep/types";
import { getBaby, NotFound, toClientEntry } from "@/lib/maple/store";
import { dayKey } from "@/lib/maple/time";
import { SLEEP_PLACES, type Baby, type Entry, type Member, type SleepPlace } from "@/lib/maple/types";
import { voiceFor, type Voice } from "@/lib/maple/voice";

export const dynamic = "force-dynamic";

/**
 * The sleep plan, bassinet tries, holding shifts, sleep goals and the
 * adults' check-ins (sleep/store.ts).
 *
 * GET (anyone in the family but photos-only guests): the plan, tries,
 * shifts and goals as the state carries them, and the check-ins for owners
 * and members only; `?view=progress&days=7` adds the progress view, worked
 * out from the log on the server, and `?view=goals` (`&id=3` for one goal,
 * any status) adds each open goal with its progress, coach notes and lines
 * (a view-only guest's carry no check-in counts).
 *
 * POST { action, … } (owners and members): every write answers with the
 * fresh sleep state and the sleep entry it touched (`entries`), so the
 * phone shows both at once. A stale write (it names the updated_at or
 * revision it was made against) answers 409 with the record as it is now
 * (`current`, `code`: changed, finished, running or open); nothing is saved.
 * A check-in is always the signed-in adult's own: nothing in the request
 * can say whose it is. A holding turn's "Wake [partner]" is shift.ask,
 * never a handoff: the handoff is recorded only by shift.accept ("I've got
 * her", the signed-in person) or the holder's shift.handoff.
 */

type Body = Record<string, unknown>;

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function instant(v: unknown, label: string): Date | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isIso(v)) throw new BadRequest(`${label} must be an ISO timestamp`);
  return new Date(v);
}

function id(v: unknown, label = "id"): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequest(`${label} is required`);
  return n;
}

const stamp = (v: unknown, label = "expect_updated_at"): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!isIso(v)) throw new BadRequest(`${label} must be an ISO timestamp`);
  return v;
};

/** A person in this family (never a photos-only guest): the holder, who's next, who put her down. */
function person(v: unknown, members: Member[], label: string): string {
  const m = typeof v === "string" ? members.find((x) => x.email === v) : undefined;
  if (!m || m.role === "photos") throw new BadRequest(`${label} must be someone in this family`);
  return m.email;
}
const personOrNull = (v: unknown, members: Member[], label: string) => (v === null || v === undefined || v === "" ? null : person(v, members, label));

function outcome(v: unknown): TryOutcome {
  if (!(TRY_OUTCOMES as readonly unknown[]).includes(v)) throw new BadRequest(`outcome must be one of ${TRY_OUTCOMES.join(", ")}`);
  return v as TryOutcome;
}

/** The answer to every write: what it did, the sleep entries it touched (`entries`) or deleted (`removed`), and the fresh sleep state. Writers are owners and members, who see check-ins. */
async function stateBody(ctx: FamilyCtx, babyId: number, extra: Record<string, unknown>, touched: (Entry | null | undefined)[] = [], removed: (Entry | null | undefined)[] = []) {
  const entries = touched.filter((e): e is Entry => !!e).map(toClientEntry);
  return json({ ...extra, entries, removed: removed.filter((e): e is Entry => !!e).map((e) => e.id), sleep: await sleepStateFor(ctx, babyId, new Date(), { checkins: true }) });
}

/** The people and day a goal write is checked against: owners and members are the adults who check in. */
function goalCtxOf(members: Member[], baby: Baby, familyId: number): GoalCtx {
  return {
    adults: new Set(members.filter((m) => m.role === "owner" || m.role === "member").map((m) => m.email)),
    name: (id) => memberName(id, members),
    today: dayKey(new Date(), baby.timezone),
    ...goalVoiceOf(baby, familyId),
  };
}

/** The baby's words and age for a goal write's refusals and cautions (goals.ts unsafeSleep, goalCautions). */
function goalVoiceOf(baby: Baby, familyId: number): { v: Voice; ageDays: number | null } {
  return { v: voiceFor(familyId, baby), ageDays: sleepAge(baby, new Date())?.days ?? null };
}

/** What a saved goal needs said with it (its cautions), for the app to show. */
function goalCautionsOf(goal: SleepGoal, members: Member[], baby: Baby, familyId: number): string[] {
  const { v, ageDays } = goalVoiceOf(baby, familyId);
  return goalCautions(goal, { v, name: (id) => memberName(id, members), ageDays }).map((c) => c.text);
}

/** checkin.save's extra answers about the night: only the keys the request has (goals.ts cleanCheckinExtras checks them). */
function checkinExtrasFrom(body: Body): Record<string, unknown> {
  return Object.fromEntries((["place", "untimed_try", "untimed_min", "handoff"] as const).filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
}

const goalId = (v: unknown) => {
  const n = typeof v === "string" ? Number(v.replace(/^g/i, "")) : v;
  return id(n, "id");
};

const optionalRevision = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new BadRequest("revision must be a whole number");
  return n;
};

export const GET = withMember("GET /api/maple/sleep", async (request, me, ctx) => {
  const baby = await getBaby(ctx);
  const sp = new URL(request.url).searchParams;
  const checkins = seesCheckins(me.role);
  const now = new Date();
  const body: Record<string, unknown> = { sleep: await sleepStateFor(ctx, baby.id, now, { checkins, tz: baby.timezone }) };
  if (sp.get("view") === "progress") {
    const raw = Number(sp.get("days") ?? 7);
    const days = Number.isInteger(raw) && raw >= 1 && raw <= 31 ? raw : 7;
    const progress = await progressFor(ctx, baby.id, baby.timezone, now, days);
    body.progress = progress;
    body.lines = progressLines(progress, baby.timezone, now);
  }
  if (sp.get("view") === "goals") {
    const one = sp.get("id");
    const goals = one ? [await getGoal(ctx, goalId(one))].filter((g): g is SleepGoal => g !== null && g.baby_id === baby.id) : await listGoals(ctx, baby.id);
    const members = await listMembers(ctx);
    const words: GoalWords = { v: voiceFor(ctx.familyId, baby), name: (m) => memberName(m, members), tz: baby.timezone, now };
    const progress = await goalProgressFor(ctx, baby.id, goals, { tz: baby.timezone, now, checkins });
    body.goals = goals.map((goal) => {
      const p = progress.get(goal.id)!;
      return { goal, progress: p, coach: coachNotes(goal, p, words), lines: goalProgressLines(goal, p, words) };
    });
  }
  return json(body);
});

export const POST = withMember(
  "POST /api/maple/sleep",
  async (request: NextRequest, me: Member, ctx: FamilyCtx) => {
    const body = await readJson<Body>(request);
    const [baby, members] = await Promise.all([getBaby(ctx), listMembers(ctx)]);
    const device = deviceOf(request);
    const by = me.email;
    const src = "web" as const;
    const askFor = async (shiftId: number | null, to: string) => {
      const w = await askHandoff(ctx, { babyId: baby.id, id: shiftId, to, by, source: src, device });
      // The other phones that turned handoff reminders on hear of it now; this one doesn't.
      holdingChanged({ familyId: ctx.familyId, wake: { shiftId: w.shift.id, device } });
      return stateBody(ctx, baby.id, { result: w });
    };
    /** A turn's sleep in arms for Undo (`{ id, expect_updated_at }`), only while it's as this phone left it. */
    const turnSleep = async (raw: unknown, how: "delete" | "reopen") => {
      const t = raw as Body | null | undefined;
      if (!t || typeof t !== "object") return null;
      return undoTurnSleep(ctx, { id: id(t.id, "sleep.id"), expectUpdatedAt: stamp(t.expect_updated_at, "sleep.expect_updated_at") ?? "", how, by });
    };
    try {
      switch (body.action) {
        // ── the plan ──
        case "plan.create": {
          const init = cleanPlanPatch((body.plan as Body | undefined) ?? {}, null, voiceFor(ctx.familyId, baby));
          const { plan, created } = await ensurePlan(ctx, baby.id, by, src, init);
          return stateBody(ctx, baby.id, { plan, created });
        }
        case "plan.update": {
          const revision = Number(body.revision);
          if (!Number.isSafeInteger(revision) || revision < 1) throw new BadRequest("revision is required");
          const current = await getPlan(ctx, baby.id);
          const patch = cleanPlanPatch((body.patch as Body | undefined) ?? {}, current, voiceFor(ctx.familyId, baby));
          const { plan, before } = await updatePlan(ctx, baby.id, patch, revision, by, src);
          return stateBody(ctx, baby.id, { plan, before });
        }

        // ── bassinet tries ──
        case "try.start": {
          const w = await startTry(ctx, {
            babyId: baby.id,
            at: instant(body.at, "at"),
            putDownBy: body.put_down_by === undefined ? by : personOrNull(body.put_down_by, members, "put_down_by"),
            tags: cleanTags(body.tags),
            note: cleanNote(body.note),
            by,
            source: src,
            clientId: typeof body.client_id === "string" ? body.client_id : null,
            device,
          });
          if (w.endedShift) holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "try.log": {
          const start = instant(body.started_at, "started_at");
          const end = instant(body.ended_at, "ended_at");
          if (!start || !end) throw new BadRequest("started_at and ended_at are required");
          const w = await logTry(ctx, {
            babyId: baby.id,
            start,
            end,
            outcome: outcome(body.outcome),
            putDownBy: body.put_down_by === undefined ? by : personOrNull(body.put_down_by, members, "put_down_by"),
            tags: cleanTags(body.tags),
            note: cleanNote(body.note),
            by,
            source: src,
            clientId: typeof body.client_id === "string" ? body.client_id : null,
            device,
            allowDuplicate: body.allow_duplicate === true,
          });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "try.finish": {
          const w = await finishTry(ctx, id(body.id), {
            outcome: outcome(body.outcome),
            at: instant(body.at, "at"),
            ...(body.tags !== undefined ? { tags: cleanTags(body.tags) } : {}),
            ...(body.note !== undefined ? { note: cleanNote(body.note) } : {}),
            by,
            expectUpdatedAt: stamp(body.expect_updated_at),
          });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "try.undo_finish": {
          const s = body.sleep as Body | null | undefined;
          const place = s?.place;
          if (place !== undefined && place !== null && !(SLEEP_PLACES as readonly unknown[]).includes(place)) throw new BadRequest("sleep.place isn't a sleep place");
          const w = await undoFinish(ctx, id(body.id), {
            expectUpdatedAt: stamp(body.expect_updated_at) ?? "",
            sleep: s ? { id: id(s.id, "sleep.id"), expectUpdatedAt: stamp(s.expect_updated_at, "sleep.expect_updated_at") ?? "", wasActive: s.was_active === true, ...(place !== undefined ? { place: (place as SleepPlace | null) ?? null } : {}) } : null,
            by,
          });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "try.update": {
          const patch: TryPatch = {};
          if (body.started_at !== undefined) patch.started_at = instant(body.started_at, "started_at");
          if (body.ended_at !== undefined) patch.ended_at = instant(body.ended_at, "ended_at");
          if (body.outcome !== undefined) patch.outcome = outcome(body.outcome);
          if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
          if (body.note !== undefined) patch.note = cleanNote(body.note);
          if (body.put_down_by !== undefined) patch.put_down_by = personOrNull(body.put_down_by, members, "put_down_by");
          const w = await updateTry(ctx, id(body.id), patch, { by, expectUpdatedAt: stamp(body.expect_updated_at) });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "try.delete": {
          const r = await deleteTry(ctx, id(body.id), by, { expectUpdatedAt: stamp(body.expect_updated_at) });
          return stateBody(ctx, baby.id, { result: r }, [], [r.sleepDeleted]);
        }
        case "try.restore": {
          const r = await restoreTry(ctx, id(body.id), by, { sleepId: body.sleep_id == null ? null : id(body.sleep_id, "sleep_id") });
          return stateBody(ctx, baby.id, { result: r }, [r.sleep]);
        }

        // ── holding shifts ──
        case "shift.start": {
          const w = await startShift(ctx, {
            babyId: baby.id,
            holder: body.holder === undefined ? by : person(body.holder, members, "holder"),
            at: instant(body.at, "at"),
            handoffAt: instant(body.handoff_at, "handoff_at") ?? null,
            nextHolder: personOrNull(body.next_holder, members, "next_holder"),
            asleep: body.asleep === true,
            by,
            source: src,
            clientId: typeof body.client_id === "string" ? body.client_id : null,
            device,
          });
          if (w.status === "created") holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "shift.handoff": {
          // "Wake [partner]" from an app from before asks: only an ask now, so nothing changes hands until they have her.
          if (body.wake === true) return await askFor(id(body.id), person(body.to, members, "to"));
          const w = await handOff(ctx, id(body.id), {
            to: person(body.to, members, "to"),
            at: instant(body.at, "at"),
            ...(body.handoff_at !== undefined ? { handoffAt: instant(body.handoff_at, "handoff_at") ?? null } : {}),
            by,
            source: src,
            device,
            expectUpdatedAt: stamp(body.expect_updated_at),
          });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "shift.end": {
          const how = body.how === undefined ? "ended" : body.how;
          if (!(SHIFT_ENDINGS as readonly unknown[]).includes(how)) throw new BadRequest(`how must be one of ${SHIFT_ENDINGS.join(", ")}`);
          const w = await endShift(ctx, id(body.id), { at: instant(body.at, "at"), how: how as ShiftEnding, by, expectUpdatedAt: stamp(body.expect_updated_at) });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w }, [w.sleep]);
        }
        case "shift.update": {
          const w = await updateShift(
            ctx,
            id(body.id),
            {
              ...(body.handoff_at !== undefined ? { handoffAt: instant(body.handoff_at, "handoff_at") ?? null } : {}),
              ...(body.next_holder !== undefined ? { nextHolder: personOrNull(body.next_holder, members, "next_holder") } : {}),
              ...(body.started_at !== undefined ? { startedAt: instant(body.started_at, "started_at") } : {}),
            },
            { by, expectUpdatedAt: stamp(body.expect_updated_at) }
          );
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "shift.delete": {
          const shift = await deleteShift(ctx, id(body.id), by, { expectUpdatedAt: stamp(body.expect_updated_at) });
          holdingChanged({ familyId: ctx.familyId });
          // Undo of a start that made her sleep in arms: that sleep goes too, while it's still as the start left it.
          const gone = await turnSleep(body.sleep, "delete");
          return stateBody(ctx, baby.id, { result: { shift, sleepDeleted: gone } }, [], [gone]);
        }
        case "shift.restore": {
          const shift = await restoreShift(ctx, id(body.id), by);
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: { shift } });
        }
        case "shift.reopen": {
          const shift = await reopenShift(ctx, id(body.id), { by, expectUpdatedAt: stamp(body.expect_updated_at) ?? "" });
          holdingChanged({ familyId: ctx.familyId });
          // Undo of an end that stopped her sleep in arms: it runs again, while it's still as the end left it.
          const sleep = await turnSleep(body.sleep, "reopen");
          return stateBody(ctx, baby.id, { result: { shift, sleep } }, [sleep]);
        }
        case "shift.undo_handoff": {
          const r = await undoHandOff(ctx, {
            startedId: id(body.started_id, "started_id"),
            startedUpdatedAt: stamp(body.started_updated_at, "started_updated_at") ?? "",
            endedId: id(body.ended_id, "ended_id"),
            endedUpdatedAt: stamp(body.ended_updated_at, "ended_updated_at") ?? "",
            by,
          });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: r });
        }
        // "Wake [partner]": an ask, never a handoff. Nothing changes hands until they have her (shift.accept, or the
        // holder's shift.handoff); the family's other phones with handoff reminders on hear of it now.
        case "shift.ask":
          return await askFor(body.id == null ? null : id(body.id), person(body.to, members, "to"));
        case "shift.cancel_ask": {
          const w = await cancelAsk(ctx, id(body.id), { by, expectUpdatedAt: stamp(body.expect_updated_at) ?? "" });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
        }
        // "I've got her": the signed-in person takes over the turn as it is now.
        case "shift.accept": {
          const w = await acceptHandoff(ctx, id(body.id), { by, source: src, device, ...(body.handoff_at !== undefined ? { handoffAt: instant(body.handoff_at, "handoff_at") ?? null } : {}) });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
        }
        // "Asleep in arms" during a turn: a running sleep in arms from now (none if a sleep already runs).
        case "shift.asleep": {
          const r = await startArmsSleep(ctx, { babyId: baby.id, by, source: src, device, clientId: typeof body.client_id === "string" ? body.client_id : null });
          return stateBody(ctx, baby.id, { result: r }, [r.sleep]);
        }
        case "shift.asleep_undo": {
          const gone = await turnSleep(body.sleep, "delete");
          return stateBody(ctx, baby.id, { result: { sleepDeleted: gone } }, [], [gone]);
        }

        // ── sleep goals ──
        case "goal.create": {
          if (!body.goal || typeof body.goal !== "object") throw new BadRequest("goal is required");
          const w = await createGoal(ctx, { babyId: baby.id, goal: body.goal as GoalInput, ctx: goalCtxOf(members, baby, ctx.familyId), by, source: src, clientId: typeof body.client_id === "string" ? body.client_id : null, device });
          return stateBody(ctx, baby.id, { result: w, cautions: goalCautionsOf(w.goal, members, baby, ctx.familyId) });
        }
        case "goal.update": {
          const revision = Number(body.revision);
          if (!Number.isSafeInteger(revision) || revision < 1) throw new BadRequest("revision is required");
          if (!body.patch || typeof body.patch !== "object") throw new BadRequest("patch is required");
          const w = await updateGoal(ctx, goalId(body.id), { patch: body.patch as GoalInput, revision, ctx: goalCtxOf(members, baby, ctx.familyId), by, source: src });
          return stateBody(ctx, baby.id, { result: w, cautions: goalCautionsOf(w.goal, members, baby, ctx.familyId) });
        }
        case "goal.step": {
          if (typeof body.step !== "string" || !body.step) throw new BadRequest("step is required");
          const w = await setGoalStep(ctx, goalId(body.id), { step: body.step, done: body.done !== false, by, source: src, revision: optionalRevision(body.revision) });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "goal.review": {
          const w = await reviewGoal(ctx, goalId(body.id), { note: body.note ?? null, by, source: src, revision: optionalRevision(body.revision) });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "goal.close": {
          if (body.status !== "met" && body.status !== "dropped") throw new BadRequest("status must be met or dropped");
          const w = await closeGoal(ctx, goalId(body.id), { status: body.status, ...(body.note !== undefined ? { note: body.note } : {}), by, source: src, revision: optionalRevision(body.revision) });
          return stateBody(ctx, baby.id, { result: w });
        }

        // ── check-ins: the signed-in adult's own ──
        case "checkin.save": {
          const w = await saveCheckin(ctx, {
            babyId: baby.id,
            member: by,
            night: body.night,
            protected: body.protected,
            ...(body.note !== undefined ? { note: body.note } : {}),
            extras: checkinExtrasFrom(body),
            tz: baby.timezone,
            source: src,
            clientId: typeof body.client_id === "string" ? body.client_id : null,
            device,
          });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "checkin.delete": {
          const checkin = await deleteCheckin(ctx, { babyId: baby.id, member: by, id: body.id == null ? null : id(body.id), night: typeof body.night === "string" ? body.night : null });
          return stateBody(ctx, baby.id, { result: { checkin } });
        }
        default:
          throw new BadRequest("Unknown sleep action.");
      }
    } catch (err) {
      if (err instanceof SleepInputError) return json({ error: err.message }, 400);
      if (err instanceof SleepConflict) return json({ error: err.message, code: err.reason, current: err.current, sleep: await sleepStateFor(ctx, baby.id, new Date(), { checkins: true }) }, 409);
      if (err instanceof NotFound) return json({ error: err.message || "Not found", sleep: await sleepStateFor(ctx, baby.id, new Date(), { checkins: true }) }, 404);
      throw err;
    }
  },
  { write: true }
);

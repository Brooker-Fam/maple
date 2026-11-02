import type { NextRequest } from "next/server";
import { listMembers } from "@/lib/maple/auth";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { deviceOf } from "@/lib/maple/device";
import type { FamilyCtx } from "@/lib/maple/family";
import { holdingChanged } from "@/lib/maple/push-hooks";
import { progressLines } from "@/lib/maple/sleep/engine";
import {
  cleanNote,
  cleanPlanPatch,
  cleanTags,
  deleteShift,
  deleteTry,
  endShift,
  ensurePlan,
  finishTry,
  getPlan,
  handOff,
  logTry,
  progressFor,
  reopenShift,
  restoreShift,
  restoreTry,
  SleepConflict,
  SleepInputError,
  sleepStateFor,
  startShift,
  startTry,
  undoFinish,
  undoHandOff,
  updatePlan,
  updateShift,
  updateTry,
  type TryPatch,
} from "@/lib/maple/sleep/store";
import { SHIFT_ENDINGS, TRY_OUTCOMES, type ShiftEnding, type TryOutcome } from "@/lib/maple/sleep/types";
import { getBaby, NotFound, toClientEntry } from "@/lib/maple/store";
import { SLEEP_PLACES, type Entry, type Member, type SleepPlace } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

/**
 * The sleep plan, bassinet tries and holding shifts (sleep/store.ts).
 *
 * GET (anyone in the family but photos-only guests): the plan, tries and
 * shifts as the state carries them; `?view=progress&days=7` adds the
 * progress view, worked out from the log on the server.
 *
 * POST { action, … } (owners and members): every write answers with the
 * fresh sleep state and the sleep entry it touched (`entries`), so the
 * phone shows both at once. A stale write (it names the updated_at or
 * revision it was made against) answers 409 with the record as it is now
 * (`current`, `code`: changed, finished, running or open); nothing is saved.
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

async function stateBody(ctx: FamilyCtx, babyId: number, extra: Record<string, unknown>, touched: (Entry | null | undefined)[] = []) {
  const entries = touched.filter((e): e is Entry => !!e).map(toClientEntry);
  return json({ ...extra, entries, sleep: await sleepStateFor(ctx, babyId) });
}

export const GET = withMember("GET /api/maple/sleep", async (request, _me, ctx) => {
  const baby = await getBaby(ctx);
  const sp = new URL(request.url).searchParams;
  const body: Record<string, unknown> = { sleep: await sleepStateFor(ctx, baby.id) };
  if (sp.get("view") === "progress") {
    const raw = Number(sp.get("days") ?? 7);
    const days = Number.isInteger(raw) && raw >= 1 && raw <= 31 ? raw : 7;
    const now = new Date();
    const progress = await progressFor(ctx, baby.id, baby.timezone, now, days);
    body.progress = progress;
    body.lines = progressLines(progress, baby.timezone, now);
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
    try {
      switch (body.action) {
        // ── the plan ──
        case "plan.create": {
          const init = cleanPlanPatch((body.plan as Body | undefined) ?? {}, null);
          const { plan, created } = await ensurePlan(ctx, baby.id, by, src, init);
          return stateBody(ctx, baby.id, { plan, created });
        }
        case "plan.update": {
          const revision = Number(body.revision);
          if (!Number.isSafeInteger(revision) || revision < 1) throw new BadRequest("revision is required");
          const current = await getPlan(ctx, baby.id);
          const patch = cleanPlanPatch((body.patch as Body | undefined) ?? {}, current);
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
          return stateBody(ctx, baby.id, { result: r }, [r.sleepDeleted]);
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
            by,
            source: src,
            clientId: typeof body.client_id === "string" ? body.client_id : null,
            device,
          });
          if (w.status === "created") holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "shift.handoff": {
          const w = await handOff(ctx, id(body.id), {
            to: person(body.to, members, "to"),
            at: instant(body.at, "at"),
            ...(body.handoff_at !== undefined ? { handoffAt: instant(body.handoff_at, "handoff_at") ?? null } : {}),
            by,
            source: src,
            device,
            expectUpdatedAt: stamp(body.expect_updated_at),
          });
          // "Wake [partner]": the other phones that turned handoffs on hear of it now; this one doesn't.
          holdingChanged({ familyId: ctx.familyId, ...(body.wake === true ? { wake: { shiftId: w.shift.id, device } } : {}) });
          return stateBody(ctx, baby.id, { result: w });
        }
        case "shift.end": {
          const how = body.how === undefined ? "ended" : body.how;
          if (!(SHIFT_ENDINGS as readonly unknown[]).includes(how)) throw new BadRequest(`how must be one of ${SHIFT_ENDINGS.join(", ")}`);
          const w = await endShift(ctx, id(body.id), { at: instant(body.at, "at"), how: how as ShiftEnding, by, expectUpdatedAt: stamp(body.expect_updated_at) });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: w });
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
          return stateBody(ctx, baby.id, { result: { shift } });
        }
        case "shift.restore": {
          const shift = await restoreShift(ctx, id(body.id), by);
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: { shift } });
        }
        case "shift.reopen": {
          const shift = await reopenShift(ctx, id(body.id), { by, expectUpdatedAt: stamp(body.expect_updated_at) ?? "" });
          holdingChanged({ familyId: ctx.familyId });
          return stateBody(ctx, baby.id, { result: { shift } });
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
        default:
          throw new BadRequest("Unknown sleep action.");
      }
    } catch (err) {
      if (err instanceof SleepInputError) return json({ error: err.message }, 400);
      if (err instanceof SleepConflict) return json({ error: err.message, code: err.reason, current: err.current, sleep: await sleepStateFor(ctx, baby.id) }, 409);
      if (err instanceof NotFound) return json({ error: err.message || "Not found", sleep: await sleepStateFor(ctx, baby.id) }, 404);
      throw err;
    }
  },
  { write: true }
);

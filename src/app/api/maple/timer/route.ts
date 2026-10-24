import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import {
  adjustTimerStart,
  discardTimer,
  getBaby,
  pauseTimer,
  reopenTimer,
  retimeFeed,
  startTimer,
  stopTimer,
  switchSide,
  toClientEntry,
} from "@/lib/maple/store";
import {
  TIMER_KINDS,
  type FeedEdit,
  type Segment,
  type Side,
  type StretchRef,
  type TimerInput,
  type TimerKind,
  type TimerResponse,
} from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const isSide = (s: unknown): s is Side => s === "L" || s === "R";
const isTimerKind = (k: unknown): k is TimerKind => (TIMER_KINDS as readonly unknown[]).includes(k);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function instant(v: unknown, label: string): Date {
  if (!isIso(v)) throw new BadRequest(`${label} must be an ISO timestamp`);
  return new Date(v);
}

function stretchRef(v: unknown, label: string): StretchRef {
  if (!isObject(v) || !isSide(v.side) || !isIso(v.start)) throw new BadRequest(`${label} needs side (L or R) and an ISO start`);
  return { side: v.side, start: v.start };
}

function segment(v: unknown, i: number): Segment {
  if (!isObject(v) || !isSide(v.side) || !isIso(v.start) || !(v.end === null || isIso(v.end))) {
    throw new BadRequest(`edit.segments[${i}] needs side (L or R), an ISO start, and an ISO end or null`);
  }
  return { side: v.side, start: v.start, end: v.end as string | null };
}

/** Every field of a Fix times edit, checked before the store checks it against the feed. */
function feedEdit(v: unknown): FeedEdit {
  if (!isObject(v)) throw new BadRequest("edit is required");
  switch (v.op) {
    case "move": {
      if (v.edge !== "start" && v.edge !== "end" && v.edge !== "ended") throw new BadRequest("edit.edge must be start, end or ended");
      const to = instant(v.to, "edit.to").toISOString();
      return { op: "move", edge: v.edge, to, ...(v.ref != null ? { ref: stretchRef(v.ref, "edit.ref") } : {}) };
    }
    case "set_side":
      if (!isSide(v.side)) throw new BadRequest("edit.side must be L or R");
      return { op: "set_side", ref: stretchRef(v.ref, "edit.ref"), side: v.side };
    case "undo_tap": {
      const x = v.expect;
      if (!isObject(x) || !isSide(x.side) || !isIso(x.start) || !(x.end === null || isIso(x.end))) {
        throw new BadRequest("edit.expect needs side (L or R), an ISO start, and an ISO end or null");
      }
      return { op: "undo_tap", expect: { side: x.side, start: x.start, end: x.end as string | null } };
    }
    case "restore": {
      if (!Array.isArray(v.segments) || !v.segments.length || v.segments.length > 60) throw new BadRequest("edit.segments must list 1 to 60 parts");
      if (!isIso(v.started_at)) throw new BadRequest("edit.started_at must be an ISO timestamp");
      if (!(v.ended_at === null || isIso(v.ended_at))) throw new BadRequest("edit.ended_at must be an ISO timestamp or null");
      if (!isIso(v.expect_updated_at)) throw new BadRequest("edit.expect_updated_at must be an ISO timestamp");
      let nap: Extract<FeedEdit, { op: "restore" }>["nap"];
      if (v.nap != null) {
        const n = v.nap;
        if (!isObject(n) || !Number.isSafeInteger(n.id) || (n.id as number) <= 0) throw new BadRequest("edit.nap.id must be a positive integer");
        if (!isIso(n.ended_at) || !isIso(n.expect_updated_at)) throw new BadRequest("edit.nap needs ISO ended_at and expect_updated_at");
        nap = { id: n.id as number, ended_at: n.ended_at, expect_updated_at: n.expect_updated_at };
      }
      return {
        op: "restore",
        segments: v.segments.map(segment),
        started_at: v.started_at,
        ended_at: v.ended_at as string | null,
        expect_updated_at: v.expect_updated_at,
        ...(nap ? { nap } : {}),
      };
    }
    default:
      throw new BadRequest("edit.op must be move, set_side, undo_tap or restore");
  }
}

/** A store answer with its entries made safe to send (no blob keys). */
const timerJson = (r: TimerResponse) =>
  json({ ...r, entry: toClientEntry(r.entry), ...(r.nap ? { nap: { ...r.nap, entry: toClientEntry(r.nap.entry) } } : {}) });

/**
 * POST /api/maple/timer { action, kind?, side?, id?, at?, edit?, client_id? }
 * Timers run on server time so every phone shows the same clock; `at` is
 * only for when it really happened (switch/resume/pause within the last 4
 * hours, stop, adjust). retime fixes one moment ({ id, edit }). A write that
 * loses to the other parent answers 409 with the current entry and a reason
 * ("stopped", "changed"), so the app can say "Brittany already stopped it";
 * an edit that doesn't fit the feed answers 400 { error, code }.
 */
export const POST = withMember("POST /api/maple/timer", async (request, me) => {
  const body = await readJson<TimerInput>(request);
  const now = new Date();

  if (body.action === "start") {
    if (!isTimerKind(body.kind)) throw new BadRequest("kind must be feed, sleep, tummy, or pump");
    if (body.side !== undefined && !isSide(body.side)) throw new BadRequest("side must be L or R");
    const baby = await getBaby();
    const { entry, alreadyRunning } = await startTimer({
      babyId: baby.id,
      kind: body.kind,
      side: body.side,
      at: now,
      createdBy: me.email,
      source: "web",
      clientId: body.client_id,
    });
    return json({ entry: toClientEntry(entry), alreadyRunning });
  }

  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new BadRequest("id is required");
  const at = body.at ? instant(body.at, "at") : undefined;

  switch (body.action) {
    case "switch":
    case "resume": {
      if (!isSide(body.side)) throw new BadRequest("side must be L or R");
      return timerJson(await switchSide(id, body.side, at, me.email));
    }
    case "pause":
      return timerJson(await pauseTimer(id, at, me.email));
    case "stop":
      return json({ entry: toClientEntry(await stopTimer(id, at, me.email)) });
    case "retime":
      return timerJson(await retimeFeed(id, feedEdit(body.edit), me.email));
    case "adjust":
      return json({ entry: toClientEntry(await adjustTimerStart(id, instant(body.at, "at"), me.email)) });
    case "discard":
      return json({ entry: toClientEntry(await discardTimer(id, me.email)) });
    case "reopen":
      return json({ entry: toClientEntry(await reopenTimer(id, me.email)) });
    default:
      throw new BadRequest("Unknown timer action");
  }
}, { write: true });

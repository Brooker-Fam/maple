import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import {
  adjustTimerStart,
  discardTimer,
  getBaby,
  pauseTimer,
  reopenTimer,
  startTimer,
  stopTimer,
  switchSide,
  toClientEntry,
} from "@/lib/maple/store";
import { TIMER_KINDS, type Side, type TimerInput, type TimerKind } from "@/lib/maple/types";

export const dynamic = "force-dynamic";

const isSide = (s: unknown): s is Side => s === "L" || s === "R";
const isTimerKind = (k: unknown): k is TimerKind => (TIMER_KINDS as readonly unknown[]).includes(k);

function instant(v: unknown, label: string): Date {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw new BadRequest(`${label} must be an ISO timestamp`);
  return new Date(t);
}

/**
 * POST /api/maple/timer { action, kind?, side?, id?, at?, client_id? }
 * Timers run on server time so every phone shows the same clock. A stop or
 * switch that loses a race with the other parent answers 409 with the
 * current entry, so the app can say "Brittany already stopped it".
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

  switch (body.action) {
    case "switch":
    case "resume": {
      if (!isSide(body.side)) throw new BadRequest("side must be L or R");
      return json({ entry: toClientEntry(await switchSide(id, body.side, now, me.email)) });
    }
    case "pause":
      return json({ entry: toClientEntry(await pauseTimer(id, now, me.email)) });
    case "stop": {
      const at = body.at ? instant(body.at, "at") : now;
      return json({ entry: toClientEntry(await stopTimer(id, at, me.email)) });
    }
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

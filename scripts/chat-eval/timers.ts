import { entryJson, ok, type Handler } from "./result";
import { MIN, ToolErr, type Entry, type Kind, type Side, type Sim } from "./sim";

const KIND: Record<string, Kind> = { nursing: "feed", sleep: "sleep", tummy_time: "tummy", pumping: "pump" };
const SIDE: Record<string, Side> = { left: "L", right: "R", both: "B" };

function nursing(sim: Sim, id: unknown): Entry {
  const running = sim.running("feed");
  const e = typeof id === "number" ? running.find((x) => x.id === id) : running[0];
  if (!e) throw new ToolErr("No nursing timer is running. To record a finished feed use log_feed with left_minutes / right_minutes; to start one use start_timer.");
  return e;
}

const open = (e: Entry) => e.parts![e.parts!.length - 1];

function feedJson(sim: Sim, e: Entry, extra: Record<string, unknown> = {}) {
  return { ...entryJson(sim, e), ...sim.timerJson(e), ...extra, next_side: sim.nextSide() };
}

function change(sim: Sim, tool: string, e: Entry) {
  sim.actions.push({ kind: "change", tool, id: e.id, at: sim.now });
}

const start_timer: Handler = (a, sim) => {
  const kind = KIND[String(a.timer)];
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const already = sim.running(kind)[0];
  if (already && kind === "feed" && a.side) return switch_side({ to: a.back_and_forth ? "both" : a.side, at: a.at, minutes_ago: a.minutes_ago }, sim);
  if (already) return ok(`A ${a.timer} timer is already running: ${sim.timerLine(already)}`, { created: false, already_running: true, ...entryJson(sim, already) });
  if (kind === "feed" && a.back_and_forth && !a.side) throw new ToolErr("back_and_forth needs side: the side she started on.");
  const side: Side | null = kind === "feed" ? (a.back_and_forth ? "B" : SIDE[String(a.side ?? sim.nextSide())]) : null;
  const e = sim.add({
    kind,
    start: at,
    end: null,
    active: true,
    by: sim.me,
    via: "chat",
    createdAt: sim.now,
    data: kind === "feed" ? { method: "breast", first_side: a.side ?? sim.nextSide() } : {},
    ...(side ? { parts: [{ side, start: at, end: null }] } : {}),
  });
  sim.actions.push({ kind: "create", tool: "start_timer", id: e.id, at: sim.now });
  const sideText = side ? (side === "B" ? " going back and forth" : ` on the ${sim.sideWord(side)}`) : "";
  const label = kind === "feed" ? "Nursing" : kind === "tummy" ? "Tummy time" : kind === "pump" ? "Pumping" : "Sleep";
  const note = assumed.length ? `\nNote: ${assumed.join("; ")}.` : "";
  return ok(`Saved #${e.id}: ${label} timer started${sideText} at ${sim.whenText(at)} (logged by ${sim.me} via Maple chat).${note}`, { created: true, ...entryJson(sim, e), ...sim.timerJson(e), undo: `undo_last, or delete_entry with id ${e.id}` });
};

const stop_timer: Handler = (a, sim) => {
  const wanted = a.timer ? KIND[String(a.timer)] : null;
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed);
  let target: Entry | undefined;
  if (typeof a.id === "number") {
    target = sim.get(a.id);
    if (!target || target.deleted) throw new ToolErr(`There's no entry #${a.id}. Call maple_status to see running timers.`);
    if (!target.active) return ok(`That timer already stopped at ${sim.whenText(target.end!)} (#${target.id}: ${sim.phrase(target)}).`, { stopped: false, already_stopped: true, ...entryJson(sim, target) });
  } else {
    const running = sim.running().filter((e) => (wanted ? e.kind === wanted : ["feed", "sleep", "tummy", "pump"].includes(e.kind)));
    if (running.length > 1) throw new ToolErr(`More than one timer is running: ${running.map((e) => `#${e.id} ${e.kind === "feed" ? "nursing" : e.kind}`).join(", ")}. Say which with timer or id.`);
    target = running[0];
    if (!target) {
      throw new ToolErr(wanted === "feed" ? "No nursing timer is running. To record a finished feed use log_feed with left_minutes / right_minutes; to start one use start_timer." : "No timer is running. To record something that already finished, use the matching log_* tool.");
    }
  }
  const e = target;
  let end = at ?? sim.now;
  let ending = "";
  if (e.kind === "feed" && e.parts?.length) {
    const cur = open(e);
    if (!cur.side) {
      if (!at || at > cur.start) {
        end = cur.start;
        ending = ` It ended ${sim.time(end)}, when it was paused.`;
      }
      e.parts.pop();
    } else if (end < cur.start) {
      throw new ToolErr(`${sim.time(end)} is before she went on the ${sim.sideWord(cur.side)} at ${sim.time(cur.start)}. If she switched later than the timer says, move that with fix_nursing_time {part:"current_side", at:"…"} first; otherwise stop it with a time after ${sim.time(cur.start)}.`);
    }
    const last = open(e);
    if (last.end === null) last.end = end;
  }
  if (end < e.start) throw new ToolErr(`That's before the timer started (${sim.time(e.start)}).`);
  e.active = false;
  e.end = end;
  if (e.kind === "pump" && a.amount != null) e.data.total_ml = Math.round(Number(a.amount) * (a.unit === "ml" ? 1 : 29.5735));
  change(sim, "stop_timer", e);
  const lines = [`Saved #${e.id}: ${sim.phrase(e)}, ${sim.span(e.start, end)} ${sim.dayWord(e.start)} (stopped by ${sim.me} via Maple chat).${ending}`];
  if (e.kind === "feed" && (e.parts?.length ?? 0) > 1) lines.push(`Timeline: ${sim.timeline(e)}.`);
  if (e.kind === "feed") lines.push(sim.todayLine(), `Next feed: offer the ${sim.nextSide()} side first.`);
  if (assumed.length) lines.push(`Note: ${assumed.join("; ")}.`);
  const m = sim.sideMinutes(e);
  return ok(lines.join("\n"), {
    stopped: true,
    ...entryJson(sim, e),
    ...(e.kind === "feed" ? { total_nursing_minutes: m.L + m.R + m.B, next_side: sim.nextSide() } : {}),
    undo: e.kind === "feed" ? `reopen_timer id ${e.id} if she's still going; fix_nursing_time {id:${e.id}, part:"feed_end", at:"…"} if it ended at another time; delete_entry id ${e.id} to remove it` : `update_entry id ${e.id} to fix times, or delete_entry id ${e.id}`,
  });
};

export const switch_side: Handler = (a, sim) => {
  const e = nursing(sim, a.id);
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const cur = open(e);
  const to: Side | null = a.to ? SIDE[String(a.to)] : null;
  if (cur.side && to === cur.side) {
    if (a.at || a.minutes_ago != null) {
      cur.start = at;
      change(sim, "switch_side", e);
      return ok(`Moved: she's been on the ${sim.sideWord(cur.side)} since ${sim.time(at)}.\nTimeline: ${sim.timeline(e)}.`, feedJson(sim, e));
    }
    return ok(`She's already on the ${sim.sideWord(cur.side)} (since ${sim.time(cur.start)}), so nothing changed.`, feedJson(sim, e, { changed: false }));
  }
  if (cur.side === "B" && !to) return ok("She's going back and forth, so there's nothing to switch. To track sides again, say which side she's on now.", feedJson(sim, e, { changed: false }));
  if (at < cur.start) throw new ToolErr(`${sim.time(at)} is before the current part started (${sim.time(cur.start)}). Use fix_nursing_time to move an earlier moment.`);
  const lastSide = [...e.parts!].reverse().find((p) => p.side === "L" || p.side === "R")?.side;
  const next: Side = to ?? (lastSide === "L" ? "R" : "L");
  cur.end = at;
  e.parts!.push({ side: next, start: at, end: null });
  change(sim, "switch_side", e);
  const what = next === "B" ? `Going back and forth from ${sim.time(at)}: sides aren't tracked from here, so nothing needs tapping at each change.` : `Switched to the ${sim.sideWord(next)} at ${sim.time(at)}${cur.side ? "" : " (back on after the break)"}.`;
  return ok(`${what}\nTimeline: ${sim.timeline(e)}.`, feedJson(sim, e));
};

const pause_nursing: Handler = (a, sim) => {
  const e = nursing(sim, a.id);
  const assumed: string[] = [];
  const at = sim.when(a.at as string, a.minutes_ago as number, assumed) ?? sim.now;
  const cur = open(e);
  if (!cur.side) {
    const prev = e.parts![e.parts!.length - 2];
    prev.end = at;
    cur.start = at;
    change(sim, "pause_nursing", e);
    return ok(`Moved: she came off at ${sim.time(at)}.\nTimeline: ${sim.timeline(e)}.`, feedJson(sim, e));
  }
  if (at < cur.start) throw new ToolErr(`${sim.time(at)} is before she went on the ${sim.sideWord(cur.side)} at ${sim.time(cur.start)}.`);
  cur.end = at;
  e.parts!.push({ side: null, start: at, end: null });
  change(sim, "pause_nursing", e);
  return ok(`Paused at ${sim.time(at)}. When she goes back on, switch_side resumes it (offer the ${cur.side === "L" ? "right" : "left"}).\nTimeline: ${sim.timeline(e)}.`, feedJson(sim, e, { back_on_side: cur.side === "L" ? "right" : "left" }));
};

const fix_nursing_time: Handler = (a, sim) => {
  const e =
    typeof a.id === "number"
      ? sim.get(a.id)
      : (sim.running("feed")[0] ?? sim.feeds().filter((x) => x.data.method !== "bottle" && x.end && sim.now - x.end < 12 * 60 * MIN).pop());
  if (!e || !e.parts?.length) throw new ToolErr("There's no timed feed to fix. Use list_entries to find the right id.");
  const before = structuredClone(e.parts);
  const assumed: string[] = [];
  if (a.undo_last_tap) {
    if (e.parts.length < 2) throw new ToolErr("There's no switch or pause to take back.");
    e.parts.pop();
    open(e).end = null;
  } else {
    const part = String(a.part ?? "");
    const idx = part === "feed_start" ? 0 : part === "feed_end" ? e.parts.length - 1 : part === "current_side" ? e.parts.length - 1 : e.parts.map((p) => p.side).lastIndexOf(SIDE[part] ?? "X");
    if (idx < 0) throw new ToolErr(`This feed has no ${part} part.`);
    const p = e.parts[idx];
    if (a.set_side) p.side = SIDE[String(a.set_side)];
    else {
      const edgeEnd = part === "feed_end" || a.edge === "end";
      const moved = a.add_minutes != null ? (edgeEnd ? (p.end ?? sim.now) + Number(a.add_minutes) * MIN : p.start - Number(a.add_minutes) * MIN) : sim.when(a.at as string, a.minutes_ago as number, assumed);
      if (moved == null) throw new ToolErr("Give exactly one of add_minutes, at / minutes_ago, set_side, undo_last_tap or undo.");
      if (edgeEnd) {
        p.end = moved;
        if (part === "feed_end") e.end = moved;
        const next = e.parts[idx + 1];
        if (next) next.start = moved;
      } else {
        p.start = moved;
        const prev = e.parts[idx - 1];
        if (prev) prev.end = moved;
        if (idx === 0) e.start = moved;
      }
    }
  }
  change(sim, "fix_nursing_time", e);
  const token = `u1${Buffer.from(JSON.stringify({ id: e.id, before: before.length })).toString("base64url")}`;
  return ok(`Fixed #${e.id}: ${sim.phrase(e)}.\nTimeline: ${sim.timeline(e)}.`, { ...entryJson(sim, e), ...(e.active ? sim.timerJson(e) : {}), undo: token });
};

const reopen_timer: Handler = (a, sim) => {
  const e = typeof a.id === "number" ? sim.get(a.id) : sim.lastFeed();
  if (!e || e.active || e.kind !== "feed") throw new ToolErr("There's no stopped feed to reopen.");
  e.active = true;
  e.end = null;
  if (e.parts?.length) open(e).end = null;
  change(sim, "reopen_timer", e);
  return ok(`Reopened #${e.id}: the feed is running again.\n${sim.timerLine(e)}`, { reopened: true, ...feedJson(sim, e) });
};

export const TIMER_TOOLS: Record<string, Handler> = { start_timer, stop_timer, switch_side, pause_nursing, fix_nursing_time, reopen_timer };

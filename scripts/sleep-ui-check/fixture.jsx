import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { ApiError } from "../../src/lib/maple/client-request";
import { summarize } from "../../src/lib/maple/insights";
import { chooseSleepLink, nextHandoff, progressLines, sleepProgress } from "../../src/lib/maple/sleep/engine";
import { SleepInputError } from "../../src/lib/maple/sleep/errors";
import { cleanCheckinNight, cleanGoalInput, cleanGoalNote, cleanProtected, coachNotes, goalProgress, goalProgressLines } from "../../src/lib/maple/sleep/goals";
import { CHECKIN_NOTE_MAX, GOAL_NOTE_MAX } from "../../src/lib/maple/sleep/types";
import { STAGE_INFO } from "../../src/lib/maple/sleep/words";
import { dayKey, formatDuration, zonedTimeToUtc } from "../../src/lib/maple/time";
import { makeVoice } from "../../src/lib/maple/voice";
import { Icon } from "../../src/components/maple/icons";
import { setNightActive } from "../../src/components/maple/nightLook";
import { SleepSheetHost } from "../../src/components/maple/sleep/SleepSheets";
import { SleepProvider } from "../../src/components/maple/sleep/useSleep";
import TodayTab from "../../src/components/maple/TodayTab";
import { ToastHost } from "../../src/components/maple/ui";
import { FixtureContext } from "./mocks";

// A made-up family: Sam (owner), Alex (member), Pat (view-only), and a baby called River. 2:10 AM in New York, or with
// ?morning 7:30 AM on Thu, Nov 5 (after the clocks went back), the morning after a night on a sleep goal's roster.
// Each page is one phone showing the real Today tab (Right now, the dock with its sleep strip, More, the toasts and every
// sleep sheet). ?as=alex signs in as Alex, ?role=viewer as Pat. ?phones puts Sam's phone and Alex's side by side in two
// frames that share one stand-in route and one clock, so one phone's write reaches the other at its next poll.
const ME = "sam@example.test";
const PARTNER = "alex@example.test";
const VIEWER = "pat@example.test";
const NAMES = { [ME]: "Sam", [PARTNER]: "Alex", [VIEWER]: "Pat" };
const ROLES = { [ME]: "owner", [PARTNER]: "member", [VIEWER]: "viewer" };
const TZ = "America/New_York";
const params = new URLSearchParams(location.search);
const BASE = params.has("morning") ? Date.parse("2026-11-05T12:30:00.000Z") : Date.parse("2026-10-28T06:10:00.000Z");
const role = params.get("role") ?? (params.get("as") === "alex" ? "member" : "owner");
const SIGNED_IN = role === "viewer" ? VIEWER : params.get("as") === "alex" ? PARTNER : ME;
const ADULTS = new Set([ME, PARTNER]);
const NIGHT = params.has("night");
const nameOf = (email) => NAMES[email] ?? email;
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const newest = (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;
const vo = makeVoice({ name: "River", pronoun: "she" });
/** A local wall time in New York: at("2026-11-04", 23, 0). */
const at = (key, h, m = 0) => {
  const [y, mo, d] = key.split("-").map(Number);
  return zonedTimeToUtc(y, mo, d, h, m, TZ).getTime();
};
const nextDay = (key) => new Date(Date.parse(`${key}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
/** The rules' refusals are 400s with their words, as the route answers. */
const ruled = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SleepInputError) throw new ApiError(err.message, 400, { error: err.message });
    throw err;
  }
};

/**
 * The sleep route, in memory: the same answers (result, entries, removed, sleep) for the actions the app sends, for
 * whichever phone asks (`who`: its signed-in person). Owners and members get the adults' check-ins; a view-only guest never.
 */
function makeServer(clock) {
  let seq = 500;
  const feed = {
    id: 41, kind: "feed", started_at: iso(BASE - 40 * MIN), ended_at: iso(BASE - 12 * MIN), active: false,
    data: { method: "breast", first_side: "L", last_side: "R", segments: [] }, note: null, created_by: ME, updated_at: iso(BASE - 12 * MIN), source: "web", created_at: iso(BASE - 40 * MIN),
  };
  const diaper = { id: 42, kind: "diaper", started_at: iso(BASE - 50 * MIN), ended_at: null, active: false, data: { pee: true, poop: false }, note: null, created_by: PARTNER, updated_at: iso(BASE - 50 * MIN), source: "web", created_at: iso(BASE - 50 * MIN) };
  const db = { plan: null, tries: [], shifts: [], entries: [feed, diaper], goals: [], checkins: [], calls: [] };
  const now = () => clock();
  const stamp = (x) => ((x.updated_at = iso(now() + ++seq)), x);
  const goalOut = ({ client_id: _c, item_seq: _s, ...g }) => ({ ...g, targets: g.targets.map((t) => ({ ...t })), steps: g.steps.map((s) => ({ ...s })), roster: g.roster.map((w) => ({ ...w, nights: [...w.nights] })) });
  const checkinOut = ({ client_id: _c, deleted: _d, ...c }) => ({ ...c });
  const liveCheckins = () => db.checkins.filter((c) => !c.deleted);
  const sees = (who) => ROLES[who] === "owner" || ROLES[who] === "member";
  const snapshot = (who) => ({
    plan: db.plan && { ...db.plan },
    tries: db.tries.map((t) => ({ ...t, tags: [...t.tags] })).sort(newest),
    shifts: db.shifts.map((s) => ({ ...s })).sort(newest),
    goals: db.goals.map(goalOut).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id),
    ...(sees(who) ? { checkins: liveCheckins().map(checkinOut).sort((a, b) => b.night.localeCompare(a.night) || a.member.localeCompare(b.member)) } : {}),
  });
  const goalRules = (current, itemSeq) => ({ current, seq: itemSeq, adults: ADULTS, name: nameOf, today: dayKey(now(), TZ) });
  const sleepOf = (id) => db.entries.find((e) => e.id === id) ?? null;
  const runningSleep = () => db.entries.find((e) => e.kind === "sleep" && e.active) ?? null;
  const newSleep = (start, end, place, by) => {
    const e = { id: ++seq, kind: "sleep", started_at: iso(start), ended_at: end == null ? null : iso(end), active: end == null, data: { place }, note: null, created_by: by, updated_at: iso(now()), source: "web", created_at: iso(now()) };
    db.entries.push(e);
    return e;
  };
  const stopEntry = (id, end = now()) => {
    const e = sleepOf(id);
    if (!e || !e.active) return null;
    Object.assign(stamp(e), { active: false, ended_at: iso(end) });
    return e;
  };
  const handle = async (who, path, init = {}) => {
    const url = new URL(path, location.origin);
    if (!url.pathname.startsWith("/api/maple/sleep")) {
      db.calls.push({ action: "OTHER", path, who });
      return { entries: [] };
    }
    const answer = (extra, touched = [], removed = []) => ({ ...extra, entries: touched.filter(Boolean).map((e) => ({ ...e })), removed: removed.filter(Boolean).map((e) => e.id), sleep: snapshot(who) });
    const conflict = () => {
      throw new ApiError("conflict", 409, { error: "That changed on another phone. Here it is now.", code: "changed", sleep: snapshot(who) });
    };
    const check = (x, expect) => {
      if (expect && x.updated_at !== expect) conflict();
    };
    const tryOf = (id) => db.tries.find((t) => t.id === id) ?? (() => { throw new ApiError("gone", 404, { error: "That try isn't in the log anymore.", sleep: snapshot(who) }); })();
    const shiftOf = (id) => db.shifts.find((s) => s.id === id) ?? (() => { throw new ApiError("gone", 404, { error: "Holding shift not found", sleep: snapshot(who) }); })();
    const openShift = () => db.shifts.find((s) => !s.ended_at) ?? null;
    const goalOf = (id) => db.goals.find((g) => g.id === Number(id)) ?? (() => { throw new ApiError("gone", 404, { error: "Sleep goal not found", sleep: snapshot(who) }); })();
    const bump = (g) => {
      g.revision += 1;
      g.updated_by = who;
      return stamp(g);
    };
    const newTry = (fields) => {
      const t = { id: ++seq, ended_at: null, outcome: null, put_down_by: who, tags: [], note: null, sleep_entry_id: null, made_sleep: false, created_by: who, updated_by: who, source: "web", created_at: iso(now()), updated_at: iso(now()), ...fields };
      db.tries.push(t);
      return t;
    };
    const newShift = (fields) => {
      const s = { id: ++seq, holder: who, started_at: iso(now()), handoff_at: null, next_holder: null, ended_at: null, ended_how: null, asked_to: null, asked_at: null, created_by: who, updated_by: who, source: "web", created_at: iso(now()), updated_at: iso(now()), ...fields };
      db.shifts.push(s);
      return s;
    };
    const endShift = (s, how, end = now()) => {
      const before = { ...s };
      Object.assign(stamp(s), { ended_at: iso(end), ended_how: how, updated_by: who });
      return before;
    };
    const handOff = (old, to, handoffAt) => {
      if (old.ended_at) conflict();
      const span = old.handoff_at ? Date.parse(old.handoff_at) - Date.parse(old.started_at) : 120 * MIN;
      const endedBefore = endShift(old, "handoff");
      const s = newShift({ holder: to, handoff_at: handoffAt !== undefined ? handoffAt : iso(nextHandoff({ started_at: old.started_at, handoff_at: old.handoff_at }, now())), next_holder: old.holder });
      void span;
      return { shift: s, before: null, status: "handed_off", ended: old, endedBefore };
    };
    if (!init.method || init.method === "GET") {
      db.calls.push({ action: "GET", view: url.searchParams.get("view"), who });
      if (url.searchParams.get("view") === "goals") {
        // As the route: each open goal with its progress from the real rules, check-ins only for owners and members.
        const t = new Date(now());
        const words = { v: vo, name: nameOf, tz: TZ, now: t };
        const data = { tries: db.tries, entries: db.entries, shifts: db.shifts, checkins: sees(who) ? liveCheckins() : null };
        const open = db.goals.filter((g) => g.status === "active" || g.status === "paused").map(goalOut);
        return {
          sleep: snapshot(who),
          goals: open.map((goal) => {
            const progress = goalProgress(goal, data, t, TZ);
            return { goal, progress, coach: coachNotes(goal, progress, words), lines: goalProgressLines(goal, progress, words) };
          }),
        };
      }
      const progress = sleepProgress({ tries: db.tries, entries: db.entries, now: new Date(now()), tz: TZ, days: Number(url.searchParams.get("days") ?? 7) });
      return { sleep: snapshot(who), progress, lines: progressLines(progress, TZ, new Date(now())) };
    }
    if (ROLES[who] === "viewer") throw new ApiError("forbidden", 403, { error: "View only." });
    const body = JSON.parse(init.body);
    db.calls.push({ ...body, who });
    switch (body.action) {
      case "plan.create": {
        if (db.plan) return answer({ plan: db.plan, created: false });
        db.plan = {
          baby_id: 1, stage: 1, stage_since: iso(now()), sleeps_now: null, goal: null, ...STAGE_INFO[1].defaults, snoozed_until: null,
          revision: 1, created_by: who, updated_by: who, source: "web", created_at: iso(now()), updated_at: iso(now()), ...(body.plan ?? {}),
        };
        return answer({ plan: db.plan, created: true });
      }
      case "plan.update": {
        if (!db.plan || body.revision !== db.plan.revision) throw new ApiError("conflict", 409, { error: "Someone changed the sleep plan just now.", code: "changed", current: db.plan && { ...db.plan }, sleep: snapshot(who) });
        const before = { ...db.plan };
        const patch = body.patch ?? {};
        if (patch.stage && patch.stage !== db.plan.stage) Object.assign(db.plan, STAGE_INFO[patch.stage].defaults, { stage_since: iso(now()) });
        Object.assign(db.plan, patch, { revision: db.plan.revision + 1, updated_by: who });
        stamp(db.plan);
        return answer({ plan: db.plan, before });
      }
      case "try.start": {
        const running = db.tries.find((t) => !t.ended_at);
        if (running) return answer({ result: { try: running, before: null, sleep: sleepOf(running.sleep_entry_id), sleepBefore: null, status: "running" } });
        const start = body.at ? Date.parse(body.at) : now();
        // As the store: the running sleep (her sleep in arms, a sleep timer) if there is one, else a bassinet sleep it makes.
        const link = chooseSleepLink(start, null, db.entries.filter((e) => e.kind === "sleep"), now());
        const live = link.kind === "create" ? null : sleepOf(link.entry.id);
        const sleepBefore = live ? { ...live } : null;
        const sleep = live ?? newSleep(start, null, "bassinet", who);
        const t = newTry({ started_at: iso(start), tags: body.tags ?? [], sleep_entry_id: sleep.id, made_sleep: !live });
        const open = openShift();
        const endedShiftBefore = open ? endShift(open, "bassinet", start) : null;
        return answer({ result: { try: t, before: null, sleep, sleepBefore, status: "created", link: live ? link.kind : "create", endedShift: open ?? null, endedShiftBefore } }, [sleep]);
      }
      case "try.finish": {
        const t = tryOf(body.id);
        if (t.ended_at) return answer({ result: { try: t, before: t, sleep: sleepOf(t.sleep_entry_id), sleepBefore: null, status: "already_finished" } });
        check(t, body.expect_updated_at);
        const before = { ...t };
        const end = body.at ? Date.parse(body.at) : now();
        Object.assign(t, { ended_at: iso(end), outcome: body.outcome, ...(body.tags ? { tags: body.tags } : {}), ...(body.note !== undefined ? { note: body.note } : {}) });
        stamp(t);
        const sleep = sleepOf(t.sleep_entry_id);
        const sleepBefore = sleep ? { ...sleep } : null;
        if (sleep?.active && body.outcome !== "picked_up") Object.assign(stamp(sleep), { active: false, ended_at: iso(end) });
        return answer({ result: { try: t, before, sleep, sleepBefore, status: "finished" } }, [sleep]);
      }
      case "try.undo_finish": {
        const t = tryOf(body.id);
        check(t, body.expect_updated_at);
        const before = { ...t };
        Object.assign(stamp(t), { ended_at: null, outcome: null });
        const sleep = body.sleep ? sleepOf(body.sleep.id) : null;
        if (sleep && body.sleep.was_active) Object.assign(stamp(sleep), { active: true, ended_at: null });
        return answer({ result: { try: t, before, sleep, sleepBefore: null, status: "reopened" } }, [sleep]);
      }
      case "try.update": {
        const t = tryOf(body.id);
        check(t, body.expect_updated_at);
        const before = { ...t };
        const sleep = sleepOf(t.sleep_entry_id);
        const sleepBefore = sleep ? { ...sleep } : null;
        if (body.started_at && sleep && sleep.started_at === t.started_at) Object.assign(stamp(sleep), { started_at: body.started_at });
        for (const k of ["started_at", "ended_at", "outcome", "tags", "note", "put_down_by"]) if (body[k] !== undefined) t[k] = body[k];
        stamp(t);
        return answer({ result: { try: t, before, sleep, sleepBefore, status: "updated" } }, [sleep]);
      }
      case "try.delete": {
        const t = tryOf(body.id);
        check(t, body.expect_updated_at);
        db.tries = db.tries.filter((x) => x.id !== t.id);
        const made = t.made_sleep ? sleepOf(t.sleep_entry_id) : null;
        if (made) db.entries = db.entries.filter((e) => e.id !== made.id);
        db.deleted = { try: t, sleep: made };
        return answer({ result: { try: t, sleepDeleted: made } }, [], [made]);
      }
      case "try.restore": {
        const gone = db.deleted;
        if (!gone || gone.try.id !== body.id) throw new ApiError("gone", 404, { error: "Nothing to restore.", sleep: snapshot(who) });
        db.tries.push(gone.try);
        if (gone.sleep) db.entries.push(gone.sleep);
        return answer({ result: { try: gone.try, sleep: gone.sleep } }, [gone.sleep]);
      }
      case "try.log": {
        const start = Date.parse(body.started_at);
        const end = Date.parse(body.ended_at);
        const twin = db.tries.find((t) => Math.abs(Date.parse(t.started_at) - start) <= 10 * MIN || (Date.parse(t.started_at) < end && start < Date.parse(t.ended_at ?? iso(now()))));
        if (twin && !body.allow_duplicate) return answer({ result: { try: twin, before: null, sleep: null, sleepBefore: null, status: "duplicate" } });
        const link = chooseSleepLink(start, end, db.entries.filter((e) => e.kind === "sleep"), now());
        const sleep = link.kind === "create" ? newSleep(start, end, "bassinet", who) : sleepOf(link.entry.id);
        const t = newTry({ started_at: iso(start), ended_at: iso(end), outcome: body.outcome, tags: body.tags ?? [], note: body.note ?? null, put_down_by: body.put_down_by ?? null, sleep_entry_id: sleep.id, made_sleep: link.kind === "create" });
        return answer({ result: { try: t, before: null, sleep, sleepBefore: null, status: "created", link: link.kind } }, [sleep]);
      }

      // ── holding turns: asks, takeovers and her sleep in arms ──
      case "shift.start": {
        const open = openShift();
        if (open) return answer({ result: { shift: open, before: null, status: "open" } });
        const s = newShift({ holder: body.holder ?? who, handoff_at: body.handoff_at ?? null, next_holder: body.next_holder ?? null });
        let sleep = null;
        let madeSleep = false;
        if (body.asleep) {
          sleep = runningSleep();
          if (!sleep) {
            sleep = newSleep(now(), null, "arms", who);
            madeSleep = true;
          }
        }
        return answer({ result: { shift: s, before: null, status: "created", sleep, madeSleep } }, [sleep]);
      }
      case "shift.handoff": {
        const old = shiftOf(body.id);
        check(old, body.expect_updated_at);
        return answer({ result: handOff(old, body.to, body.handoff_at) });
      }
      case "shift.ask": {
        const open = openShift();
        if (!open || (body.id != null && open.id !== body.id)) conflict();
        if (body.to === open.holder) throw new ApiError("bad", 400, { error: "That's who is holding her now." });
        const before = { ...open };
        Object.assign(stamp(open), { asked_to: body.to, asked_at: iso(now()), updated_by: who });
        return answer({ result: { shift: open, before, status: "asked" } });
      }
      case "shift.cancel_ask": {
        const s = shiftOf(body.id);
        if (s.ended_at) conflict();
        check(s, body.expect_updated_at);
        const before = { ...s };
        Object.assign(stamp(s), { asked_to: null, asked_at: null });
        return answer({ result: { shift: s, before, status: "unasked" } });
      }
      case "shift.accept": {
        const old = shiftOf(body.id);
        if (old.ended_at) conflict();
        if (old.holder === who) throw new ApiError("bad", 400, { error: "You're the one holding her now." });
        return answer({ result: handOff(old, who, body.handoff_at) });
      }
      case "shift.asleep": {
        const live = runningSleep();
        if (live) return answer({ result: { sleep: live, made: false } }, [live]);
        const sleep = newSleep(now(), null, "arms", who);
        return answer({ result: { sleep, made: true } }, [sleep]);
      }
      case "shift.asleep_undo": {
        const e = sleepOf(body.sleep?.id);
        if (!e || e.updated_at !== body.sleep.expect_updated_at) return answer({ result: { sleepDeleted: null } });
        db.entries = db.entries.filter((x) => x.id !== e.id);
        return answer({ result: { sleepDeleted: e } }, [], [e]);
      }
      case "shift.end": {
        const s = shiftOf(body.id);
        check(s, body.expect_updated_at);
        const before = endShift(s, "ended");
        // Ended awake: her sleep in arms stops then too.
        const arms = runningSleep();
        if (arms && arms.data.place === "arms") {
          const sleepBefore = { ...arms };
          const sleep = stopEntry(arms.id, Date.parse(s.ended_at));
          return answer({ result: { shift: s, before, status: "ended", sleep, sleepBefore } }, [sleep]);
        }
        return answer({ result: { shift: s, before, status: "ended" } });
      }
      case "shift.update": {
        const s = shiftOf(body.id);
        check(s, body.expect_updated_at);
        const before = { ...s };
        Object.assign(stamp(s), { handoff_at: body.handoff_at });
        return answer({ result: { shift: s, before, status: "updated" } });
      }
      case "shift.reopen": {
        const s = shiftOf(body.id);
        Object.assign(stamp(s), { ended_at: null, ended_how: null });
        const sleep = body.sleep ? sleepOf(body.sleep.id) : null;
        if (sleep && !sleep.active && sleep.updated_at === body.sleep.expect_updated_at) Object.assign(stamp(sleep), { active: true, ended_at: null });
        return answer({ result: { shift: s, sleep } }, [sleep]);
      }
      case "shift.delete": {
        const s = shiftOf(body.id);
        db.shifts = db.shifts.filter((x) => x.id !== s.id);
        const made = body.sleep ? sleepOf(body.sleep.id) : null;
        if (made && made.active && made.updated_at === body.sleep.expect_updated_at) db.entries = db.entries.filter((e) => e.id !== made.id);
        return answer({ result: { shift: s, sleepDeleted: made } }, [], [made]);
      }
      case "shift.undo_handoff": {
        db.shifts = db.shifts.filter((x) => x.id !== body.started_id);
        const s = shiftOf(body.ended_id);
        Object.assign(stamp(s), { ended_at: null, ended_how: null });
        return answer({ result: { shift: s } });
      }

      // ── sleep goals: the real input rules (goals.ts), a revision on every write ──
      case "goal.create": {
        const prior = body.client_id && db.goals.find((g) => g.client_id === body.client_id);
        if (prior) return answer({ result: { goal: goalOut(prior), before: null, status: "deduped" } });
        const { fields, seq: itemSeq } = ruled(() => cleanGoalInput(body.goal, goalRules(null, 0), "create"));
        const g = {
          id: ++seq, baby_id: 1, title: fields.title, why: fields.why ?? null, target_date: fields.target_date ?? null, status: "active",
          targets: fields.targets ?? [], steps: fields.steps ?? [], roster: fields.roster ?? [], last_review_at: null, review_note: null, closed_at: null,
          revision: 1, created_by: who, updated_by: who, source: "web", created_at: iso(now()), updated_at: iso(now()), client_id: body.client_id ?? null, item_seq: itemSeq,
        };
        db.goals.push(g);
        return answer({ result: { goal: goalOut(g), before: null, status: "created" } });
      }
      case "goal.update": {
        const g = goalOf(body.id);
        if (body.revision !== g.revision) throw new ApiError("conflict", 409, { error: "Someone changed this sleep goal just now.", code: "changed", current: goalOut(g), sleep: snapshot(who) });
        const before = goalOut(g);
        const { fields, seq: itemSeq } = ruled(() => cleanGoalInput(body.patch, goalRules(before, g.item_seq), "update"));
        if (!Object.keys(fields).length) return answer({ result: { goal: before, before, status: "unchanged" } });
        const reopening = fields.status !== undefined && (g.status === "met" || g.status === "dropped");
        Object.assign(g, fields, { item_seq: itemSeq }, reopening ? { closed_at: null } : {});
        bump(g);
        return answer({ result: { goal: goalOut(g), before, status: "updated" } });
      }
      case "goal.step": {
        const g = goalOf(body.id);
        const st = g.steps.find((x) => x.id === body.step);
        if (!st) throw new ApiError("bad", 400, { error: `This goal has no step ${body.step}.` });
        const done = body.done !== false;
        const before = goalOut(g);
        if (!!st.done_at === done) return answer({ result: { goal: before, before, status: "unchanged" } });
        g.steps = g.steps.map((x) => (x.id === st.id ? { ...x, done_at: done ? iso(now()) : null, done_by: done ? who : null } : x));
        bump(g);
        return answer({ result: { goal: goalOut(g), before, status: "updated" } });
      }
      case "goal.close": {
        const g = goalOf(body.id);
        const before = goalOut(g);
        if (g.status === body.status) return answer({ result: { goal: before, before, status: "unchanged" } });
        const note = body.note === undefined ? undefined : ruled(() => cleanGoalNote(body.note, GOAL_NOTE_MAX));
        Object.assign(g, { status: body.status, closed_at: iso(now()) }, note ? { last_review_at: iso(now()), review_note: note } : {});
        bump(g);
        return answer({ result: { goal: goalOut(g), before, status: "updated" } });
      }

      // ── check-ins: always the signed-in adult's own ──
      case "checkin.save": {
        const prior = body.client_id && db.checkins.find((c) => c.client_id === body.client_id);
        if (prior) return answer({ result: { checkin: checkinOut(prior), before: null, status: "deduped" } });
        const night = ruled(() => cleanCheckinNight(body.night, new Date(now()), TZ));
        const said = ruled(() => cleanProtected(body.protected));
        const keep = body.note === undefined;
        const note = keep ? null : ruled(() => cleanGoalNote(body.note, CHECKIN_NOTE_MAX));
        const found = liveCheckins().find((c) => c.member === who && c.night === night);
        if (found) {
          const before = checkinOut(found);
          if (found.protected === said && (keep || note === found.note)) return answer({ result: { checkin: before, before, status: "unchanged" } });
          Object.assign(stamp(found), { protected: said }, keep ? {} : { note });
          return answer({ result: { checkin: checkinOut(found), before, status: "updated" } });
        }
        const c = { id: ++seq, member: who, night, protected: said, note, source: "web", created_at: iso(now()), updated_at: iso(now()), client_id: body.client_id ?? null };
        db.checkins.push(c);
        return answer({ result: { checkin: checkinOut(c), before: null, status: "created" } });
      }
      case "checkin.delete": {
        const c = liveCheckins().find((x) => x.member === who && (body.id != null ? x.id === body.id : x.night === body.night));
        if (!c) throw new ApiError("gone", 404, { error: "Check-in not found", sleep: snapshot(who) });
        c.deleted = true;
        return answer({ result: { checkin: checkinOut(c) } });
      }
      default:
        throw new ApiError("unknown", 400, { error: `Unknown action ${body.action}` });
    }
  };

  // ── seeds, by name in the query ──
  const planAt = (stage = 1) => {
    db.plan = { baby_id: 1, stage, stage_since: iso(BASE - 3 * 86_400_000), sleeps_now: "arms", goal: null, ...STAGE_INFO[stage].defaults, snoozed_until: null, revision: 3, created_by: ME, updated_by: ME, source: "web", created_at: iso(BASE - 3 * 86_400_000), updated_at: iso(BASE - 86_400_000) };
  };
  const seeds = {
    /** A try running on a bassinet sleep since 1:50 AM (swaddled). */
    running: () => {
      planAt();
      const sleep = { id: 77, kind: "sleep", started_at: iso(BASE - 20 * MIN), ended_at: null, active: true, data: { place: "bassinet" }, note: null, created_by: ME, updated_at: iso(BASE - 20 * MIN), source: "web", created_at: iso(BASE - 20 * MIN) };
      db.entries.push(sleep);
      db.tries.push({ id: 78, started_at: sleep.started_at, ended_at: null, outcome: null, put_down_by: ME, tags: ["swaddled"], note: null, sleep_entry_id: 77, made_sleep: true, created_by: ME, updated_by: ME, source: "web", created_at: sleep.started_at, updated_at: sleep.started_at });
    },
    /** Sam holding River since 1:30 AM, asleep in arms since 1:40 AM, handoff planned at 3:30 AM, then Alex. */
    holding: () => {
      planAt();
      db.shifts.push({ id: 90, holder: ME, started_at: iso(BASE - 40 * MIN), handoff_at: iso(BASE + 80 * MIN), next_holder: PARTNER, ended_at: null, ended_how: null, asked_to: null, asked_at: null, created_by: ME, updated_by: ME, source: "web", created_at: iso(BASE - 40 * MIN), updated_at: iso(BASE - 40 * MIN) });
      db.entries.push({ id: 91, kind: "sleep", started_at: iso(BASE - 30 * MIN), ended_at: null, active: true, data: { place: "arms" }, note: null, created_by: ME, updated_at: iso(BASE - 30 * MIN), source: "web", created_at: iso(BASE - 30 * MIN) });
    },
    /** The morning after: a sleep in arms logged 2:30–5:10 AM that no try sits on yet (Log an earlier try's one-tap times). */
    lastnight: () => {
      db.entries.push({ id: 95, kind: "sleep", started_at: iso(at("2026-11-05", 2, 30)), ended_at: iso(at("2026-11-05", 5, 10)), active: false, data: { place: "arms" }, note: null, created_by: PARTNER, updated_at: iso(at("2026-11-05", 5, 10)), source: "web", created_at: iso(at("2026-11-05", 5, 10)) });
    },
    /**
     * A goal set a fortnight ago with all four kinds of target, three steps, a night roster for Sam and Alex, tries on most
     * nights (some long, some short), feeds and a holding turn inside Sam's window, and check-ins from both, except Sam's
     * for last night (Wed, Nov 4), so Today asks Sam this morning.
     */
    goals: () => {
      const created = at("2026-10-22", 20, 0);
      db.goals.push({
        id: 301, baby_id: 1, title: "Both of us get one long stretch", why: "Back to work on the 30th", target_date: "2026-11-25", status: "active",
        targets: [
          { id: "a1", kind: "bassinet_nights", per_week: 4, min_minutes: 60 },
          { id: "a2", kind: "bassinet_stretch", minutes: 180 },
          { id: "a3", kind: "protected_window", member: ME, per_week: 5 },
          { id: "a4", kind: "custom", text: "Calmer bedtimes" },
        ],
        steps: [
          { id: "s5", title: "Bassinet after the 10 PM feed", week_of: "2026-10-22", done_at: iso(at("2026-10-24", 9)), done_by: PARTNER },
          { id: "s6", title: "White noise on for every try", week_of: "2026-10-29", done_at: null, done_by: null },
          { id: "s7", title: "Dim lights for night feeds", week_of: "2026-11-05", done_at: null, done_by: null },
        ],
        roster: [
          { id: "w8", member: ME, from: "22:00", to: "02:00", nights: [0, 1, 2, 3, 4, 5, 6] },
          { id: "w9", member: PARTNER, from: "02:00", to: "06:00", nights: [0, 1, 2, 3, 4, 5, 6] },
        ],
        last_review_at: null, review_note: null, closed_at: null, revision: 4, created_by: ME, updated_by: PARTNER, source: "web",
        created_at: iso(created), updated_at: iso(at("2026-10-24", 9)), client_id: null, item_seq: 9,
      });
      // Tries, each on a bassinet sleep: [night, start hour, start minute, minutes, outcome].
      const tries = [
        ["2026-10-23", 22, 30, 100, "stayed_asleep"],
        ["2026-10-25", 22, 0, 20, "woke_crying"],
        ["2026-10-27", 23, 0, 150, "stayed_asleep"],
        ["2026-10-30", 22, 15, 50, "stayed_asleep"],
        ["2026-11-01", 21, 45, 180, "stayed_asleep"],
        ["2026-11-03", 22, 30, 30, "picked_up"],
        ["2026-11-04", 23, 0, 140, "stayed_asleep"],
      ];
      for (const [night, h, m, mins, outcome] of tries) {
        const start = at(night, h, m);
        const end = start + mins * MIN;
        const sleep = { id: ++seq, kind: "sleep", started_at: iso(start), ended_at: iso(end), active: false, data: { place: "bassinet" }, note: null, created_by: ME, updated_at: iso(end), source: "web", created_at: iso(end) };
        db.entries.push(sleep);
        db.tries.push({ id: ++seq, started_at: iso(start), ended_at: iso(end), outcome, put_down_by: ME, tags: [], note: null, sleep_entry_id: sleep.id, made_sleep: true, created_by: ME, updated_by: ME, source: "web", created_at: iso(start), updated_at: iso(end) });
      }
      // Feeds inside Sam's window (22:00–02:00): one Sam logged, one Alex did; Alex held River during it one night.
      for (const [startAt, by] of [[at("2026-11-03", 23, 30), ME], [at(nextDay("2026-11-04"), 0, 30), PARTNER]]) {
        db.entries.push({ id: ++seq, kind: "feed", started_at: iso(startAt), ended_at: iso(startAt + 20 * MIN), active: false, data: { method: "breast", first_side: "L", last_side: "L", segments: [] }, note: null, created_by: by, updated_at: iso(startAt + 20 * MIN), source: "web", created_at: iso(startAt) });
      }
      db.shifts.push({ id: ++seq, holder: PARTNER, started_at: iso(at("2026-11-02", 23, 0)), handoff_at: null, next_holder: null, ended_at: iso(at("2026-11-02", 23, 40)), ended_how: "ended", asked_to: null, asked_at: null, created_by: PARTNER, updated_by: PARTNER, source: "web", created_at: iso(at("2026-11-02", 23, 0)), updated_at: iso(at("2026-11-02", 23, 40)) });
      // Check-ins: Sam's (not last night's yet) and Alex's.
      for (const [member, night, said, note] of [
        [ME, "2026-10-30", "yes", null], [ME, "2026-11-01", "no", "Up twice, both short"], [ME, "2026-11-02", "yes", null], [ME, "2026-11-03", "yes", null],
        [PARTNER, "2026-11-02", "yes", null], [PARTNER, "2026-11-03", "partly", null], [PARTNER, "2026-11-04", "yes", null],
      ]) {
        db.checkins.push({ id: ++seq, member, night, protected: said, note, source: "web", created_at: iso(at(nextDay(night), 7)), updated_at: iso(at(nextDay(night), 7)), client_id: null });
      }
      planAt();
    },
  };
  /** Another phone changes a goal: the server's copy moves on to a new revision, which this phone hasn't seen. */
  const changeGoal = (id, patch) => {
    const g = db.goals.find((x) => x.id === id);
    Object.assign(g, patch);
    g.revision += 1;
    g.updated_by = PARTNER;
    stamp(g);
    return goalOut(g);
  };
  /** Another phone changes the plan. */
  const changePlan = (patch) => {
    Object.assign(db.plan, patch, { revision: db.plan.revision + 1, updated_by: PARTNER });
    stamp(db.plan);
    return { ...db.plan };
  };
  /** The dock's sleep timer: Sleep starts one (no place), Woke up stops it. */
  const startTimer = (kind, by) => {
    if (kind !== "sleep" || runningSleep()) return runningSleep();
    const e = { id: ++seq, kind: "sleep", started_at: iso(now()), ended_at: null, active: true, data: {}, note: null, created_by: by, updated_at: iso(now()), source: "web", created_at: iso(now()) };
    db.entries.push(e);
    return e;
  };
  return { db, handle, snapshot, seeds, changeGoal, changePlan, startTimer, stopEntry, stopSleep: () => {
    const live = runningSleep();
    return live ? { ...stopEntry(live.id) } : null;
  } };
}

/** The shared route and clock of ?phones (the parent page), or this page's own. */
function shared() {
  try {
    if (window.parent !== window && window.parent.__shared) return window.parent.__shared;
  } catch {
    // Not ours to read: this page stands alone.
  }
  return null;
}

function makeWorld(query) {
  const offset = { current: 0 };
  const listeners = new Set();
  const clock = () => BASE + offset.current;
  const server = makeServer(clock);
  for (const name of ["running", "holding", "goals", "lastnight"]) if (query.has(name)) server.seeds[name]();
  return {
    server,
    clock,
    listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    advance: (minutes) => {
      offset.current += minutes * MIN;
      for (const fn of listeners) fn();
    },
  };
}

function TabBar() {
  const tabs = [
    { id: "today", label: "Today", icon: "house" },
    { id: "history", label: "History", icon: "history" },
    { id: "moments", label: "Moments", icon: "image" },
    { id: "chat", label: "Chat", icon: "message-square" },
  ];
  return (
    <nav aria-label="Maple's Log" className="fixed inset-x-0 bottom-0 z-[70] border-t border-mp-line bg-mp-bg pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-lg">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-current={t.id === "today" ? "page" : undefined} className={`flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[12px] font-medium ${t.id === "today" ? "text-mp-accent-fg" : "text-mp-ink-3"}`}>
            <Icon name={t.icon} size={24} />
            <span className="max-w-full truncate">{t.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

function Phone({ world }) {
  const { server, clock } = world;
  const [tickN, setTick] = useState(0);
  const [toasts, setToasts] = useState([]);
  // Minutes passing: the clock moves, and toasts that would have timed out on a phone are gone.
  useEffect(() => world.listen(() => (setTick((n) => n + 1), setToasts([]))), [world]);
  const handle = useCallback((path, init) => server.handle(SIGNED_IN, path, init), [server]);
  const [state, setState] = useState(() => {
    const snap = server.snapshot(SIGNED_IN);
    const any = !!snap.plan || snap.tries.length || snap.shifts.length || snap.goals.length || snap.checkins?.length;
    return {
      now: iso(clock()), rev: "r0", growth: [], lifetime: null, care: null,
      baby: { id: 1, name: "River", nickname: null, sex: "female", born_at: "2026-10-01T14:00:00.000Z", timezone: TZ, settings: {} },
      family: { id: 99, ask: "an owner" },
      me: { email: SIGNED_IN, role },
      members: [
        { email: ME, name: "Sam", display_name: "Sam", role: "owner", color: "#674b7b" },
        { email: PARTNER, name: "Alex", display_name: "Alex", role: "member", color: "#3b6e8f" },
        { email: VIEWER, name: "Pat", display_name: "Pat", role: "viewer", color: "#8f6a3b" },
      ],
      entries: [...server.db.entries].map((e) => ({ ...e })).sort(newest),
      ...(any ? { sleep: snap } : {}),
    };
  });
  const revN = useRef(0);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((text, opts = {}) => {
    const id = ++revN.current + Math.random();
    // Toasts stay up until dismissed or replaced: the check reads and taps them at its own pace.
    setToasts((t) => [...t.filter((x) => !opts.group || x.group !== opts.group).slice(-2), { id, text, tone: opts.tone ?? "ok", ...opts }]);
    return id;
  }, []);
  const apply = useCallback((next, entries = [], removed = []) => setState((s) => {
    const gone = new Set([...removed, ...entries.map((e) => e.id)]);
    const merged = [...entries.filter((e) => !removed.includes(e.id)), ...s.entries.filter((e) => !gone.has(e.id))].sort(newest);
    // As useMaple's apply: a goal or a check-in keeps the sleep state too.
    const any = !!next && (!!next.plan || next.tries.length > 0 || next.shifts.length > 0 || !!next.goals?.length || !!next.checkins?.length);
    const { sleep: old, ...rest } = s;
    return { ...rest, rev: `r${++revN.current}`, entries: merged, ...(any ? { sleep: next } : next ? {} : old ? { sleep: old } : {}) };
  }), []);
  const now = useMemo(() => new Date(clock()), [clock, tickN]); // eslint-disable-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarize({ entries: state.entries, baby: state.baby, members: state.members, now: new Date(clock()), vo }), [state, clock, tickN]); // eslint-disable-line react-hooks/exhaustive-deps
  const calls = server.db.calls;
  // What an opener was asked (a click's event, or anything else that won't copy, is left out).
  const plain = (a) => {
    try {
      return typeof a === "function" ? null : JSON.parse(JSON.stringify(a));
    } catch {
      return null;
    }
  };
  const record = (what) => (...args) => (calls.push({ action: what, who: SIGNED_IN, args: args.map(plain) }), undefined);
  const maple = useMemo(() => ({
    state, summary, now: () => new Date(clock()), readOnly: role === "viewer" || role === "photos", units: "us", seenAt: null,
    api: handle,
    memberName: nameOf, memberLabel: nameOf, member: (email) => state.members.find((m) => m.email === email) ?? null,
    isNight: () => NIGHT, timerBusy: () => false, toasts, toast, dismissToast,
    dismissTimerToast: () => setToasts((t) => t.filter((x) => x.group !== "timer")), holdTimerToasts: () => {},
    log: async (v) => (calls.push({ action: "log", v }), v), remove: record("remove"), update: async (id, patch) => (calls.push({ action: "update", id, patch }), null),
    restore: record("restore"), refresh: async () => {}, whoDiscarded: () => null, outbox: [], online: true,
    timerCall: async (b) => (calls.push({ action: "timer", ...b }), null),
    sleep: { apply, track: (fn) => fn() },
  }), [state, summary, clock, handle, toasts, toast, dismissToast, apply]); // eslint-disable-line react-hooks/exhaustive-deps
  // The dock's timers: Sleep starts a sleep timer, Woke up stops it (the try on it then asks how it went).
  const actions = useMemo(() => {
    const known = {
      running: (kind) => state.entries.find((e) => e.active && e.kind === kind) ?? null,
      startTimer: async (kind) => {
        calls.push({ action: "timer.start", kind, who: SIGNED_IN });
        const e = server.startTimer(kind, SIGNED_IN);
        if (e) apply(server.snapshot(SIGNED_IN), [{ ...e }]);
        return e;
      },
      stop: async (e, when) => {
        calls.push({ action: "timer.stop", id: e.id, who: SIGNED_IN });
        const x = server.stopEntry(e.id, when ? when.getTime() : undefined);
        if (x) {
          apply(server.snapshot(SIGNED_IN), [{ ...x }]);
          toast(`Slept ${formatDuration((Date.parse(x.ended_at) - Date.parse(x.started_at)) / 1000)}`, { tone: "ok", group: "timer" });
        }
        return x;
      },
      busy: () => false, memberName: nameOf, dismissToast: () => {}, holdToasts: () => {},
    };
    return new Proxy(known, { get: (t, k) => (k in t ? t[k] : typeof k === "string" ? record(`timer.${k}`) : undefined) });
  }, [state, server, apply, toast]); // eslint-disable-line react-hooks/exhaustive-deps
  const ctx = useMemo(() => ({
    maple, now,
    careNav: new Proxy({}, { get: (_, k) => (typeof k === "string" ? record(`care.${k}`) : undefined) }),
    // The chat's opener: records the seeded message, as the Chat tab would get it in its composer.
    chatNav: { ask: ({ prompt, label }) => (calls.push({ action: "ask", prompt, label, who: SIGNED_IN }), true) },
    sheets: { open: record("sheets.open"), close: record("sheets.close"), current: null },
    actions,
    appNav: { go: record("nav.go"), tab: "today" },
  }), [maple, now, actions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.__sleep = {
      calls: () => server.db.calls.map((c) => ({ ...c })),
      advance: (minutes) => world.advance(minutes),
      /** This phone's next poll: it learns what the other phones wrote. */
      poll: () => apply(server.snapshot(SIGNED_IN), server.db.entries.map((e) => ({ ...e }))),
      stopSleep: () => {
        const e = server.stopSleep();
        if (e) apply(server.snapshot(SIGNED_IN), [e]);
        return !!e;
      },
      // Another phone's edit, which this phone only learns of from a write's answer (or the next poll).
      changeGoal: (id, patch) => server.changeGoal(id, patch),
      changePlan: (patch) => server.changePlan(patch),
      goal: (id) => server.snapshot(SIGNED_IN).goals.find((g) => g.id === id) ?? null,
      db: () => JSON.parse(JSON.stringify({ plan: server.db.plan, tries: server.db.tries, shifts: server.db.shifts, entries: server.db.entries })),
      checkins: () => server.db.checkins.filter((c) => !c.deleted).map((c) => ({ member: c.member, night: c.night, protected: c.protected, note: c.note })),
      toasts: () => toasts.map((t) => t.text),
    };
  }, [server, world, apply, toasts]);
  return (
    <FixtureContext.Provider value={ctx}>
      <SleepProvider sheets={(api) => <SleepSheetHost api={api} />}>
        <div className="maple-app relative mx-auto min-h-[100dvh] w-full max-w-lg pb-[calc(80px+env(safe-area-inset-bottom))]">
          <TodayTab onNavigate={record("today.navigate")} />
          <TabBar />
          <ToastHost />
        </div>
      </SleepProvider>
    </FixtureContext.Provider>
  );
}

/** ?phones: Sam's phone and Alex's, side by side, sharing one route and one clock. */
function Phones() {
  const night = NIGHT ? "&night" : "";
  const rest = [...params.entries()].filter(([k]) => k !== "phones" && k !== "night").map(([k, v]) => `&${k}${v ? `=${v}` : ""}`).join("");
  return (
    <div className="flex gap-4 p-2">
      <iframe title="Sam's phone" name="sam" src={`/?phone${rest}${night}`} style={{ width: 390, height: 844, border: 0 }} />
      <iframe title="Alex's phone" name="alex" src={`/?phone&as=alex${rest}${night}`} style={{ width: 390, height: 844, border: 0 }} />
    </div>
  );
}

if (NIGHT) setNightActive(true);
const root = createRoot(document.getElementById("root"));
if (params.has("phones")) {
  window.__shared = makeWorld(params);
  root.render(<Phones />);
} else {
  const world = shared() ?? makeWorld(params);
  root.render(
    <MotionConfig reducedMotion="user">
      <Phone world={world} />
    </MotionConfig>
  );
}

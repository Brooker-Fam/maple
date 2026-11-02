import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { ApiError } from "../../src/lib/maple/client-request";
import { progressLines, sleepProgress } from "../../src/lib/maple/sleep/engine";
import { SleepInputError } from "../../src/lib/maple/sleep/errors";
import { cleanCheckinNight, cleanGoalInput, cleanGoalNote, cleanProtected, coachNotes, goalProgress, goalProgressLines } from "../../src/lib/maple/sleep/goals";
import { CHECKIN_NOTE_MAX, GOAL_NOTE_MAX } from "../../src/lib/maple/sleep/types";
import { STAGE_INFO } from "../../src/lib/maple/sleep/words";
import { dayKey, zonedTimeToUtc } from "../../src/lib/maple/time";
import { makeVoice } from "../../src/lib/maple/voice";
import { SleepNow } from "../../src/components/maple/sleep/SleepCards";
import { SleepCheckinCard } from "../../src/components/maple/sleep/SleepCheckin";
import { SleepSheetHost } from "../../src/components/maple/sleep/SleepSheets";
import { SleepStrip } from "../../src/components/maple/sleep/SleepStrip";
import { SleepProvider, useSleep } from "../../src/components/maple/sleep/useSleep";
import { FixtureContext } from "./mocks";

// A made-up family: Sam (owner, this phone) and Alex (member), Pat (view-only), and a baby called River. 2:10 AM in New York,
// or with ?morning 7:30 AM on Thu, Nov 5 (after the clocks went back), the morning after a night on a sleep goal's roster.
const ME = "sam@example.test";
const PARTNER = "alex@example.test";
const VIEWER = "pat@example.test";
const NAMES = { [ME]: "Sam", [PARTNER]: "Alex", [VIEWER]: "Pat" };
const TZ = "America/New_York";
const params = new URLSearchParams(location.search);
const BASE = params.has("morning") ? Date.parse("2026-11-05T12:30:00.000Z") : Date.parse("2026-10-28T06:10:00.000Z");
const role = params.get("role") ?? "owner";
const SIGNED_IN = role === "viewer" ? VIEWER : ME;
// Owners and members read the adults' check-ins; a view-only guest never gets one (no key in the state, none in the goals view).
const SEES_CHECKINS = role === "owner" || role === "member";
const ADULTS = new Set([ME, PARTNER]);
const nameOf = (email) => NAMES[email] ?? email;
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const newest = (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;
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

/** The sleep route, in memory: the same answers (result, entries, removed, sleep) for the actions the app sends. */
function makeServer(clock) {
  let seq = 500;
  const feed = {
    id: 41, kind: "feed", started_at: iso(BASE - 40 * MIN), ended_at: iso(BASE - 12 * MIN), active: false,
    data: { method: "breast", first_side: "L", last_side: "R", segments: [] }, note: null, created_by: ME, updated_at: iso(BASE - 12 * MIN), source: "web",
  };
  const db = { plan: null, tries: [], shifts: [], entries: [feed], goals: [], checkins: [], calls: [] };
  const now = () => clock();
  const stamp = (x) => ((x.updated_at = iso(now() + ++seq)), x);
  const goalOut = ({ client_id: _c, item_seq: _s, ...g }) => ({ ...g, targets: g.targets.map((t) => ({ ...t })), steps: g.steps.map((s) => ({ ...s })), roster: g.roster.map((w) => ({ ...w, nights: [...w.nights] })) });
  const checkinOut = ({ client_id: _c, deleted: _d, ...c }) => ({ ...c });
  const liveCheckins = () => db.checkins.filter((c) => !c.deleted);
  const snapshot = () => ({
    plan: db.plan && { ...db.plan },
    tries: db.tries.map((t) => ({ ...t, tags: [...t.tags] })).sort(newest),
    shifts: db.shifts.map((s) => ({ ...s })).sort(newest),
    goals: db.goals.map(goalOut).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id),
    ...(SEES_CHECKINS ? { checkins: liveCheckins().map(checkinOut).sort((a, b) => b.night.localeCompare(a.night) || a.member.localeCompare(b.member)) } : {}),
  });
  const goalOf = (id) => db.goals.find((g) => g.id === Number(id)) ?? (() => { throw new ApiError("gone", 404, { error: "Sleep goal not found", sleep: snapshot() }); })();
  const goalRules = (current, itemSeq) => ({ current, seq: itemSeq, adults: ADULTS, name: nameOf, today: dayKey(now(), TZ) });
  const bump = (g) => {
    g.revision += 1;
    g.updated_by = SIGNED_IN;
    return stamp(g);
  };
  const answer = (extra, touched = [], removed = []) => ({ ...extra, entries: touched.filter(Boolean).map((e) => ({ ...e })), removed: removed.filter(Boolean).map((e) => e.id), sleep: snapshot() });
  const conflict = () => {
    throw new ApiError("conflict", 409, { error: "That changed on another phone. Here it is now.", code: "changed", sleep: snapshot() });
  };
  const tryOf = (id) => db.tries.find((t) => t.id === id) ?? (() => { throw new ApiError("gone", 404, { error: "That try isn't in the log anymore.", sleep: snapshot() }); })();
  const shiftOf = (id) => db.shifts.find((s) => s.id === id);
  const sleepOf = (id) => db.entries.find((e) => e.id === id) ?? null;
  const check = (x, expect) => {
    if (expect && x.updated_at !== expect) conflict();
  };
  const newSleep = (start, end) => {
    const e = { id: ++seq, kind: "sleep", started_at: iso(start), ended_at: end == null ? null : iso(end), active: end == null, data: { place: "bassinet" }, note: null, created_by: ME, updated_at: iso(now()), source: "web" };
    db.entries.push(e);
    return e;
  };
  const newTry = (fields) => {
    const t = { id: ++seq, ended_at: null, outcome: null, put_down_by: ME, tags: [], note: null, sleep_entry_id: null, made_sleep: false, created_by: ME, updated_by: ME, source: "web", created_at: iso(now()), updated_at: iso(now()), ...fields };
    db.tries.push(t);
    return t;
  };
  const endShift = (s, how, at = now()) => {
    const before = { ...s };
    s.ended_at = iso(at);
    s.ended_how = how;
    stamp(s);
    return before;
  };
  const handle = async (path, init = {}) => {
    const url = new URL(path, location.origin);
    if (!init.method || init.method === "GET") {
      db.calls.push({ action: "GET", view: url.searchParams.get("view") });
      if (url.searchParams.get("view") === "goals") {
        // As the route: each open goal with its progress from the real rules, check-ins only for owners and members.
        const t = new Date(now());
        const words = { v: makeVoice({ name: "River", pronoun: "she" }), name: nameOf, tz: TZ, now: t };
        const data = { tries: db.tries, entries: db.entries, shifts: db.shifts, checkins: SEES_CHECKINS ? liveCheckins() : null };
        const open = db.goals.filter((g) => g.status === "active" || g.status === "paused").map(goalOut);
        return {
          sleep: snapshot(),
          goals: open.map((goal) => {
            const progress = goalProgress(goal, data, t, TZ);
            return { goal, progress, coach: coachNotes(goal, progress, words), lines: goalProgressLines(goal, progress, words) };
          }),
        };
      }
      const progress = sleepProgress({ tries: db.tries, entries: db.entries, now: new Date(now()), tz: TZ, days: Number(url.searchParams.get("days") ?? 7) });
      return { sleep: snapshot(), progress, lines: progressLines(progress, TZ, new Date(now())) };
    }
    const body = JSON.parse(init.body);
    db.calls.push(body);
    switch (body.action) {
      case "plan.create": {
        if (db.plan) return answer({ plan: db.plan, created: false });
        db.plan = {
          baby_id: 1, stage: 1, stage_since: iso(now()), sleeps_now: null, goal: null, ...STAGE_INFO[1].defaults, snoozed_until: null,
          revision: 1, created_by: ME, updated_by: ME, source: "web", created_at: iso(now()), updated_at: iso(now()), ...(body.plan ?? {}),
        };
        return answer({ plan: db.plan, created: true });
      }
      case "plan.update": {
        if (!db.plan || body.revision !== db.plan.revision) conflict();
        const before = { ...db.plan };
        const patch = body.patch ?? {};
        if (patch.stage && patch.stage !== db.plan.stage) Object.assign(db.plan, STAGE_INFO[patch.stage].defaults, { stage_since: iso(now()) });
        Object.assign(db.plan, patch, { revision: db.plan.revision + 1 });
        stamp(db.plan);
        return answer({ plan: db.plan, before });
      }
      case "try.start": {
        const running = db.tries.find((t) => !t.ended_at);
        if (running) return answer({ result: { try: running, before: null, sleep: sleepOf(running.sleep_entry_id), sleepBefore: null, status: "running" } });
        const at = body.at ? Date.parse(body.at) : now();
        const live = db.entries.find((e) => e.kind === "sleep" && e.active);
        const sleepBefore = live ? { ...live } : null;
        const sleep = live ?? newSleep(at, null);
        const t = newTry({ started_at: iso(at), tags: body.tags ?? [], sleep_entry_id: sleep.id, made_sleep: !live });
        const open = db.shifts.find((s) => !s.ended_at);
        const endedShiftBefore = open ? endShift(open, "bassinet", at) : null;
        return answer({ result: { try: t, before: null, sleep, sleepBefore, status: "created", link: live ? "running" : "create", endedShift: open ?? null, endedShiftBefore } }, [sleep]);
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
        if (!gone || gone.try.id !== body.id) throw new ApiError("gone", 404, { error: "Nothing to restore.", sleep: snapshot() });
        db.tries.push(gone.try);
        if (gone.sleep) db.entries.push(gone.sleep);
        return answer({ result: { try: gone.try, sleep: gone.sleep } }, [gone.sleep]);
      }
      case "try.log": {
        const start = Date.parse(body.started_at);
        const end = Date.parse(body.ended_at);
        const twin = db.tries.find((t) => Math.abs(Date.parse(t.started_at) - start) <= 10 * MIN);
        if (twin && !body.allow_duplicate) return answer({ result: { try: twin, before: null, sleep: null, sleepBefore: null, status: "duplicate" } });
        const sleep = newSleep(start, end);
        const t = newTry({ started_at: iso(start), ended_at: iso(end), outcome: body.outcome, tags: body.tags ?? [], note: body.note ?? null, put_down_by: body.put_down_by ?? null, sleep_entry_id: sleep.id, made_sleep: true });
        return answer({ result: { try: t, before: null, sleep, sleepBefore: null, status: "created", link: "create" } }, [sleep]);
      }
      case "shift.start": {
        const open = db.shifts.find((s) => !s.ended_at);
        if (open) return answer({ result: { shift: open, before: null, status: "open" } });
        const s = { id: ++seq, holder: body.holder, started_at: iso(now()), handoff_at: body.handoff_at ?? null, next_holder: body.next_holder ?? null, ended_at: null, ended_how: null, created_by: ME, updated_by: ME, source: "web", created_at: iso(now()), updated_at: iso(now()) };
        db.shifts.push(s);
        return answer({ result: { shift: s, before: null, status: "created" } });
      }
      case "shift.handoff": {
        const old = shiftOf(body.id);
        check(old, body.expect_updated_at);
        const span = old.handoff_at ? Date.parse(old.handoff_at) - Date.parse(old.started_at) : 120 * MIN;
        const endedBefore = endShift(old, "handoff");
        const s = { id: ++seq, holder: body.to, started_at: iso(now()), handoff_at: body.handoff_at !== undefined ? body.handoff_at : iso(now() + span), next_holder: old.holder, ended_at: null, ended_how: null, created_by: ME, updated_by: ME, source: "web", created_at: iso(now()), updated_at: iso(now()) };
        db.shifts.push(s);
        return answer({ result: { shift: s, before: null, status: "created", ended: old, endedBefore } });
      }
      case "shift.end": {
        const s = shiftOf(body.id);
        check(s, body.expect_updated_at);
        const before = endShift(s, "ended");
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
        return answer({ result: { shift: s } });
      }
      case "shift.delete": {
        const s = shiftOf(body.id);
        db.shifts = db.shifts.filter((x) => x.id !== s.id);
        return answer({ result: { shift: s } });
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
          revision: 1, created_by: SIGNED_IN, updated_by: SIGNED_IN, source: "web", created_at: iso(now()), updated_at: iso(now()), client_id: body.client_id ?? null, item_seq: itemSeq,
        };
        db.goals.push(g);
        return answer({ result: { goal: goalOut(g), before: null, status: "created" } });
      }
      case "goal.update": {
        const g = goalOf(body.id);
        if (body.revision !== g.revision) throw new ApiError("conflict", 409, { error: "Someone changed this sleep goal just now.", code: "changed", current: goalOut(g), sleep: snapshot() });
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
        g.steps = g.steps.map((x) => (x.id === st.id ? { ...x, done_at: done ? iso(now()) : null, done_by: done ? SIGNED_IN : null } : x));
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
        const found = liveCheckins().find((c) => c.member === SIGNED_IN && c.night === night);
        if (found) {
          const before = checkinOut(found);
          if (found.protected === said && (keep || note === found.note)) return answer({ result: { checkin: before, before, status: "unchanged" } });
          Object.assign(stamp(found), { protected: said }, keep ? {} : { note });
          return answer({ result: { checkin: checkinOut(found), before, status: "updated" } });
        }
        const c = { id: ++seq, member: SIGNED_IN, night, protected: said, note, source: "web", created_at: iso(now()), updated_at: iso(now()), client_id: body.client_id ?? null };
        db.checkins.push(c);
        return answer({ result: { checkin: checkinOut(c), before: null, status: "created" } });
      }
      case "checkin.delete": {
        const c = liveCheckins().find((x) => x.member === SIGNED_IN && (body.id != null ? x.id === body.id : x.night === body.night));
        if (!c) throw new ApiError("gone", 404, { error: "Check-in not found", sleep: snapshot() });
        c.deleted = true;
        return answer({ result: { checkin: checkinOut(c) } });
      }
      default:
        throw new ApiError("unknown", 400, { error: `Unknown action ${body.action}` });
    }
  };
  /**
   * ?goals: a goal set a fortnight ago with all four kinds of target, three steps, a night roster for Sam and Alex,
   * tries on most nights (some long, some short), feeds and a holding turn inside Sam's window, and check-ins from
   * both, except Sam's for last night (Wed, Nov 4), so Today asks Sam this morning.
   */
  const seedGoals = () => {
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
      const sleep = { id: ++seq, kind: "sleep", started_at: iso(start), ended_at: iso(end), active: false, data: { place: "bassinet" }, note: null, created_by: ME, updated_at: iso(end), source: "web" };
      db.entries.push(sleep);
      db.tries.push({ id: ++seq, started_at: iso(start), ended_at: iso(end), outcome, put_down_by: ME, tags: [], note: null, sleep_entry_id: sleep.id, made_sleep: true, created_by: ME, updated_by: ME, source: "web", created_at: iso(start), updated_at: iso(end) });
    }
    // Feeds inside Sam's window (22:00–02:00): one Sam logged, one Alex did; Alex held River during it one night.
    for (const [startAt, by] of [[at("2026-11-03", 23, 30), ME], [at(nextDay("2026-11-04"), 0, 30), PARTNER]]) {
      db.entries.push({ id: ++seq, kind: "feed", started_at: iso(startAt), ended_at: iso(startAt + 20 * MIN), active: false, data: { method: "breast", first_side: "L", last_side: "L", segments: [] }, note: null, created_by: by, updated_at: iso(startAt + 20 * MIN), source: "web" });
    }
    db.shifts.push({ id: ++seq, holder: PARTNER, started_at: iso(at("2026-11-02", 23, 0)), handoff_at: null, next_holder: null, ended_at: iso(at("2026-11-02", 23, 40)), ended_how: "ended", created_by: PARTNER, updated_by: PARTNER, source: "web", created_at: iso(at("2026-11-02", 23, 0)), updated_at: iso(at("2026-11-02", 23, 40)) });
    // Check-ins: Sam's (not last night's yet) and Alex's.
    for (const [member, night, said, note] of [
      [ME, "2026-10-30", "yes", null], [ME, "2026-11-01", "no", "Up twice, both short"], [ME, "2026-11-02", "yes", null], [ME, "2026-11-03", "yes", null],
      [PARTNER, "2026-11-02", "yes", null], [PARTNER, "2026-11-03", "partly", null], [PARTNER, "2026-11-04", "yes", null],
    ]) {
      db.checkins.push({ id: ++seq, member, night, protected: said, note, source: "web", created_at: iso(at(nextDay(night), 7)), updated_at: iso(at(nextDay(night), 7)), client_id: null });
    }
  };
  /** Another phone changes a goal: the server's copy moves on to a new revision, which this phone hasn't seen. */
  const changeGoal = (id, patch) => {
    const g = goalOf(id);
    Object.assign(g, patch);
    g.revision += 1;
    g.updated_by = PARTNER;
    stamp(g);
    return goalOut(g);
  };
  return { db, handle, snapshot, seedGoals, changeGoal, stopSleep: () => {
    const live = db.entries.find((e) => e.kind === "sleep" && e.active);
    if (live) Object.assign(stamp(live), { active: false, ended_at: iso(now()) });
    return live ? { ...live } : null;
  } };
}

function OpenButtons() {
  const s = useSleep();
  return (
    <div className="flex flex-wrap gap-2 p-4">
      <button type="button" onClick={() => s.openSheet({ kind: "plan" })}>Open the sleep plan</button>
      <button type="button" onClick={() => s.openSheet({ kind: "log" })}>Log an earlier try</button>
    </div>
  );
}

function Toasts({ toasts }) {
  return (
    <div data-maple-toasts className="space-y-1 p-2">
      {toasts.map((t) => (
        <div key={t.id} role="status" data-toast className="rounded-xl bg-mp-surface p-2 text-sm">
          <span data-toast-text>{t.text}</span>
          {(t.actions ?? []).map((a) => (
            <button key={a.label} type="button" aria-label={a.ariaLabel ?? a.label} onClick={a.onClick}>{a.label}</button>
          ))}
          {t.undo && <button type="button" onClick={t.undo}>Undo</button>}
        </div>
      ))}
    </div>
  );
}

function Fixture() {
  const offset = useRef(0);
  const [tickN, setTick] = useState(0);
  const clock = useCallback(() => BASE + offset.current, []);
  const server = useMemo(() => makeServer(clock), [clock]);
  const [state, setState] = useState(() => {
    if (params.has("goals")) server.seedGoals();
    const s = {
      baby: { id: 1, name: "River", nickname: null, sex: "female", born_at: "2026-10-01T14:00:00.000Z", timezone: TZ, settings: {} },
      family: { id: 99 },
      me: { email: SIGNED_IN, role },
      members: [
        { email: ME, name: "Sam", role: "owner" },
        { email: PARTNER, name: "Alex", role: "member" },
        { email: VIEWER, name: "Pat", role: "viewer" },
      ],
      entries: [...server.db.entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)),
      ...(params.has("goals") ? { sleep: server.snapshot() } : {}),
    };
    if (params.has("running")) {
      const sleep = { id: 77, kind: "sleep", started_at: iso(BASE - 20 * MIN), ended_at: null, active: true, data: { place: "bassinet" }, note: null, created_by: ME, updated_at: iso(BASE - 20 * MIN), source: "web" };
      server.db.entries.push(sleep);
      server.db.tries.push({ id: 78, started_at: sleep.started_at, ended_at: null, outcome: null, put_down_by: ME, tags: ["swaddled"], note: null, sleep_entry_id: 77, made_sleep: true, created_by: ME, updated_by: ME, source: "web", created_at: sleep.started_at, updated_at: sleep.started_at });
      server.db.plan = { baby_id: 1, stage: 1, stage_since: iso(BASE - 3 * 86_400_000), sleeps_now: "arms", goal: null, ...STAGE_INFO[1].defaults, snoozed_until: null, revision: 3, created_by: ME, updated_by: ME, source: "web", created_at: iso(BASE - 3 * 86_400_000), updated_at: iso(BASE - 86_400_000) };
      s.entries = [sleep, ...s.entries];
      s.sleep = { plan: server.db.plan, tries: [...server.db.tries], shifts: [] };
    }
    return s;
  });
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  const toast = useCallback((text, opts = {}) => setToasts((t) => [...t.slice(-2), { id: ++seq.current, text, ...opts }]), []);
  const apply = useCallback((next, entries = [], removed = []) => setState((s) => {
    const gone = new Set([...removed, ...entries.map((e) => e.id)]);
    const merged = [...entries.filter((e) => !removed.includes(e.id)), ...s.entries.filter((e) => !gone.has(e.id))].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    // As useMaple's apply: a goal or a check-in keeps the sleep state too.
    const any = !!next && (!!next.plan || next.tries.length > 0 || next.shifts.length > 0 || !!next.goals?.length || !!next.checkins?.length);
    const { sleep: _old, ...rest } = s;
    void _old;
    return { ...rest, entries: merged, ...(any ? { sleep: next } : {}) };
  }), []);
  const now = useMemo(() => new Date(clock()), [clock, tickN]); // eslint-disable-line react-hooks/exhaustive-deps
  const maple = useMemo(() => ({
    state,
    now: () => new Date(clock()),
    readOnly: role === "viewer" || role === "photos",
    api: (path, init) => server.handle(path, init),
    toast,
    memberName: (email) => nameOf(email),
    timerCall: async (b) => { server.db.calls.push({ action: "timer", ...b }); },
    sleep: { apply, track: (fn) => fn() },
  }), [state, clock, server, toast, apply]);
  const careNav = useMemo(() => ({ openHelp: () => server.db.calls.push({ action: "help" }) }), [server]);
  // The chat's opener: records the seeded message, as the Chat tab would get it in its composer.
  const chatNav = useMemo(() => ({ ask: ({ prompt, label }) => (server.db.calls.push({ action: "ask", prompt, label }), true) }), [server]);
  useEffect(() => {
    window.__sleep = {
      calls: () => server.db.calls.map((c) => ({ ...c })),
      advance: (minutes) => { offset.current += minutes * MIN; setTick((n) => n + 1); },
      stopSleep: () => { const e = server.stopSleep(); if (e) apply(server.snapshot(), [e]); return !!e; },
      // Another phone's edit, which this phone only learns of from a write's answer (or the next poll, which never comes here).
      changeGoal: (id, patch) => server.changeGoal(id, patch),
      goal: (id) => server.snapshot().goals.find((g) => g.id === id) ?? null,
      checkins: () => server.db.checkins.filter((c) => !c.deleted).map((c) => ({ member: c.member, night: c.night, protected: c.protected, note: c.note })),
      toasts: () => toasts.map((t) => t.text),
    };
  }, [server, apply, toasts]);
  return (
    <FixtureContext.Provider value={{ maple, now, careNav, chatNav }}>
      <Toasts toasts={toasts} />
      <SleepProvider sheets={(api) => <SleepSheetHost api={api} />}>
        <main className="mx-auto max-w-lg space-y-3 px-4 pt-4">
          <OpenButtons />
          <SleepNow />
          {/* Today puts the morning check-in right after Right now. */}
          <SleepCheckinCard />
          <SleepStrip />
        </main>
      </SleepProvider>
    </FixtureContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(<MotionConfig reducedMotion="user"><Fixture /></MotionConfig>);

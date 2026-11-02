import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { ApiError } from "../../src/lib/maple/client-request";
import { progressLines, sleepProgress } from "../../src/lib/maple/sleep/engine";
import { STAGE_INFO } from "../../src/lib/maple/sleep/words";
import { SleepNow } from "../../src/components/maple/sleep/SleepCards";
import { SleepSheetHost } from "../../src/components/maple/sleep/SleepSheets";
import { SleepStrip } from "../../src/components/maple/sleep/SleepStrip";
import { SleepProvider, useSleep } from "../../src/components/maple/sleep/useSleep";
import { FixtureContext } from "./mocks";

// A made-up family: Sam (owner, this phone) and Alex (member), and a baby called River. 2:10 AM in New York.
const ME = "sam@example.test";
const PARTNER = "alex@example.test";
const NAMES = { [ME]: "Sam", [PARTNER]: "Alex" };
const TZ = "America/New_York";
const BASE = Date.parse("2026-10-28T06:10:00.000Z");
const params = new URLSearchParams(location.search);
const role = params.get("role") ?? "owner";
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const newest = (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id;

/** The sleep route, in memory: the same answers (result, entries, removed, sleep) for the actions the app sends. */
function makeServer(clock) {
  let seq = 500;
  const feed = {
    id: 41, kind: "feed", started_at: iso(BASE - 40 * MIN), ended_at: iso(BASE - 12 * MIN), active: false,
    data: { method: "breast", first_side: "L", last_side: "R", segments: [] }, note: null, created_by: ME, updated_at: iso(BASE - 12 * MIN), source: "web",
  };
  const db = { plan: null, tries: [], shifts: [], entries: [feed], calls: [] };
  const now = () => clock();
  const stamp = (x) => ((x.updated_at = iso(now() + ++seq)), x);
  const snapshot = () => ({ plan: db.plan && { ...db.plan }, tries: db.tries.map((t) => ({ ...t, tags: [...t.tags] })).sort(newest), shifts: db.shifts.map((s) => ({ ...s })).sort(newest) });
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
      default:
        throw new ApiError("unknown", 400, { error: `Unknown action ${body.action}` });
    }
  };
  return { db, handle, snapshot, stopSleep: () => {
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
    const s = {
      baby: { id: 1, name: "River", nickname: null, sex: "female", born_at: "2026-10-01T14:00:00.000Z", timezone: TZ, settings: {} },
      family: { id: 99 },
      me: { email: role === "viewer" ? "pat@example.test" : ME, role },
      members: [
        { email: ME, name: "Sam", role: "owner" },
        { email: PARTNER, name: "Alex", role: "member" },
        { email: "pat@example.test", name: "Pat", role: "viewer" },
      ],
      entries: [...server.db.entries],
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
    const any = !!next && (!!next.plan || next.tries.length > 0 || next.shifts.length > 0);
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
    memberName: (email) => NAMES[email] ?? (email === "pat@example.test" ? "Pat" : email),
    timerCall: async (b) => { server.db.calls.push({ action: "timer", ...b }); },
    sleep: { apply, track: (fn) => fn() },
  }), [state, clock, server, toast, apply]);
  const careNav = useMemo(() => ({ openHelp: () => server.db.calls.push({ action: "help" }) }), [server]);
  useEffect(() => {
    window.__sleep = {
      calls: () => server.db.calls.map((c) => ({ ...c })),
      advance: (minutes) => { offset.current += minutes * MIN; setTick((n) => n + 1); },
      stopSleep: () => { const e = server.stopSleep(); if (e) apply(server.snapshot(), [e]); return !!e; },
      toasts: () => toasts.map((t) => t.text),
    };
  }, [server, apply, toasts]);
  return (
    <FixtureContext.Provider value={{ maple, now, careNav }}>
      <Toasts toasts={toasts} />
      <SleepProvider sheets={(api) => <SleepSheetHost api={api} />}>
        <main className="mx-auto max-w-lg space-y-3 px-4 pt-4">
          <OpenButtons />
          <SleepNow />
          <SleepStrip />
        </main>
      </SleepProvider>
    </FixtureContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(<MotionConfig reducedMotion="user"><Fixture /></MotionConfig>);

"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { tick } from "@/components/atlas/haptics";
import { ApiError } from "@/lib/maple/client-request";
import { numberTries, planToday, sleepAge, sleepSignals, stageSuggestion, tryDayKey, tryDayLabel, type PlanToday, type StageSuggestion } from "@/lib/maple/sleep/engine";
import { nightWords, seesCheckins } from "@/lib/maple/sleep/goals";
import type { BassinetTry, CheckinExtras, GoalInput, GoalStep, HoldingShift, PlanPatch, ProtectedAnswer, SleepCheckin, SleepGoal, SleepPlan, SleepState, TryOutcome, TryTag } from "@/lib/maple/sleep/types";
import { OUTCOME_LABEL, PROTECTED_LABEL } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, SleepPlace } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
import { useMaple, type ToastAction } from "../useMaple";

/**
 * The sleep plan on a phone: what the shared state says (the plan, a
 * running try, who's holding her, the sleep goals and, for owners and
 * members, the adults' check-ins), the writes (each answered with the fresh
 * sleep state, applied at once), and which sleep sheet is open. Every write
 * names the version it was made against, so another phone's change is
 * never overwritten: the answer is a 409 and the sheet shows it as it is.
 *
 * One tap does the common thing (Put down, an outcome, a handoff, a step,
 * a check-in), and its toast carries the fix (a minute or five earlier) and
 * Undo, which puts back exactly what the server had.
 */

export type PlanTab = "plan" | "goals" | "guidance" | "progress";

export type SleepSheet =
  | { kind: "plan"; tab?: PlanTab }
  | { kind: "outcome"; tryId: number; at?: string }
  | { kind: "sleepy" }
  | { kind: "holding"; mode: "start" | "handoff" }
  | { kind: "try"; tryId: number }
  | { kind: "log" }
  /** A sleep goal's form: a new one, or `goalId` to change. It goes back to the plan's Goals when it closes. */
  | { kind: "goal"; goalId?: number }
  /** "How did last night go?": the signed-in adult's own check-in (last night unless `night`); `back` returns to Goals. */
  | { kind: "checkin"; night?: string; back?: "goals" };

type Answer = {
  result?: Record<string, unknown>;
  entries?: Entry[];
  removed?: number[];
  sleep?: SleepState;
  plan?: SleepPlan;
  created?: boolean;
  error?: string;
  code?: string;
  /** A 409's record as it is now (a goal, for goal writes). */
  current?: unknown;
  progress?: unknown;
  lines?: string[];
};

type Write = { try: BassinetTry; before: BassinetTry | null; sleep: Entry | null; sleepBefore: Entry | null; status: string; link?: string; endedShift?: HoldingShift | null; endedShiftBefore?: HoldingShift | null };
type ShiftResult = { shift: HoldingShift; before: HoldingShift | null; status: string; ended?: HoldingShift | null; endedBefore?: HoldingShift | null };
type GoalResult = { goal: SleepGoal; before: SleepGoal | null; status: "created" | "deduped" | "updated" | "unchanged" };
type CheckinResult = { checkin: SleepCheckin; before: SleepCheckin | null; status: "created" | "updated" | "unchanged" | "deduped" };

/**
 * A goal form's save: the goal as saved; or, for an edit made from an older
 * revision (409), the goal as it is now, with nothing saved; or the rules'
 * words for what to fix (400). Null: it didn't reach the server (the toast
 * says so).
 */
export type GoalSave = { saved: SleepGoal; status: GoalResult["status"] } | { conflict: SleepGoal } | { problem: string } | null;

const EMPTY: SleepState = { plan: null, tries: [], shifts: [], goals: [] };
const OFFLINE = "Couldn't save that. Check the connection, then try again.";

export type SleepApi = {
  data: SleepState;
  plan: SleepPlan | null;
  running: BassinetTry | null;
  shift: HoldingShift | null;
  today: PlanToday | null;
  suggestion: StageSuggestion | null;
  /** "try 1 tonight", "try 2 tonight, a retry". */
  nth: (t: BassinetTry) => string;
  canWrite: boolean;
  busy: boolean;
  sheet: SleepSheet | null;
  openSheet: (s: SleepSheet) => void;
  closeSheet: () => void;
  createPlan: (init?: PlanPatch) => Promise<SleepPlan | null>;
  updatePlan: (patch: PlanPatch) => Promise<SleepPlan | null>;
  startTry: (opts?: { tags?: TryTag[] }) => Promise<BassinetTry | null>;
  finishTry: (t: BassinetTry, outcome: TryOutcome, opts?: { at?: Date; tags?: TryTag[]; note?: string | null }) => Promise<BassinetTry | null>;
  fixTry: (t: BassinetTry, patch: { started_at?: string; ended_at?: string; outcome?: TryOutcome; tags?: TryTag[]; note?: string | null; put_down_by?: string | null }) => Promise<BassinetTry | null>;
  deleteTry: (t: BassinetTry) => Promise<boolean>;
  /** A try that already happened (nobody tapped Put down). A likely twin saves nothing and comes back as `duplicate`. */
  logTry: (opts: { start: Date; end: Date; outcome: TryOutcome; tags: TryTag[]; note: string | null; putDownBy: string | null; allowDuplicate?: boolean }) => Promise<{ saved: BassinetTry } | { duplicate: BassinetTry } | null>;
  startShift: (opts: { holder: string; handoffAt: Date | null; nextHolder: string | null }) => Promise<HoldingShift | null>;
  handOff: (s: HoldingShift, opts: { to: string; handoffAt?: Date | null; wake?: boolean }) => Promise<HoldingShift | null>;
  endShift: (s: HoldingShift) => Promise<boolean>;
  laterHandoff: (s: HoldingShift, minutes: number) => Promise<boolean>;
  /** This phone ended or deleted that try (so a sheet open on it closes without "already ended"). */
  endedHere: (tryId: number) => boolean;

  // ── sleep goals and check-ins ──
  /** Open goals and those closed in the last 60 days, newest first. */
  goals: SleepGoal[];
  /** The adults' check-ins for the last 14 nights; null for a view-only guest, who never sees one. */
  checkins: SleepCheckin[] | null;
  /** The signed-in person (a member id). */
  me: string;
  /** Owners and members: they read every adult's check-in, change goals and save their own check-in. */
  seesCheckins: boolean;
  createGoal: (input: GoalInput) => Promise<GoalSave>;
  /**
   * Names the goal's revision: a goal changed elsewhere since is a 409, applied here and handed back as `conflict`.
   * `form`: a refusal comes back as `problem` and a 409 unspoken, for the form to show by the field; otherwise both are toasts.
   */
  updateGoal: (goal: SleepGoal, patch: GoalInput, opts?: { form?: boolean; saved?: string }) => Promise<GoalSave>;
  /** A step done or not (applies to the goal as it is now); Undo toggles it back. */
  toggleStep: (goal: SleepGoal, step: GoalStep, done: boolean) => Promise<boolean>;
  /** Close as met or set aside, with an optional note; Undo opens it again as it was. */
  closeGoal: (goal: SleepGoal, status: "met" | "dropped", note?: string | null) => Promise<boolean>;
  /** The signed-in adult's own check-in (last night unless `night`); Undo deletes a new one or puts the earlier answer back. */
  saveCheckin: (answer: ProtectedAnswer, opts?: { night?: string; note?: string | null }) => Promise<SleepCheckin | null>;
  /** Their own check-in only; Undo saves it again. */
  deleteCheckin: (c: SleepCheckin) => Promise<boolean>;
  /**
   * The night's other answers (where the baby spent it, a try the log doesn't
   * have, the planned handoff) on the signed-in adult's own check-in for that
   * night, which comes first: null without one. `said`: the toast's words.
   * Undo puts back what it had.
   */
  saveCheckinExtras: (night: string, extras: CheckinExtras, said: string) => Promise<SleepCheckin | null>;
};

const Ctx = createContext<SleepApi | null>(null);

export function useSleep(): SleepApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSleep must be used inside <SleepProvider>");
  return ctx;
}

/** The provider's value, or null outside one (test fixtures that render a dock without it). */
export function useSleepMaybe(): SleepApi | null {
  return useContext(Ctx);
}

export function SleepProvider({ children, sheets }: { children: ReactNode; sheets?: (api: SleepApi) => ReactNode }) {
  const m = useMaple();
  const { state, api, toast, now, readOnly } = m;
  const v = useVoice();
  const helper = m.sleep;
  const data = state?.sleep ?? EMPTY;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email ?? "";
  const adult = !!state && seesCheckins(state.me.role);
  const [sheet, setSheet] = useState<SleepSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const ownEnds = useRef(new Set<number>());
  const endedHere = useCallback((id: number) => ownEnds.current.has(id), []);

  const running = data.tries.find((t) => !t.ended_at) ?? null;
  const shift = data.shifts.find((s) => !s.ended_at) ?? null;
  const t0 = state ? now() : new Date();
  const today = data.plan ? planToday(data.plan, data.tries, t0, tz) : null;
  const suggestion = stageSuggestion(data.plan, data.tries, t0, tz);

  const nth = useCallback(
    (t: BassinetTry) => {
      const n = numberTries(data.tries, tz).get(t.id);
      return n ? `try ${n.n} ${tryDayLabel(n.day, tryDayKey(now(), tz))}${n.retry ? ", a retry" : ""}` : "";
    },
    [data.tries, now, tz]
  );

  /** One write: the answer's sleep state and entries go straight into the shared state, a refusal's too (then it throws). */
  const send = useCallback(
    async (body: Record<string, unknown>): Promise<Answer> => {
      const run = async () => {
        setBusy(true);
        try {
          const r = await api<Answer>("/api/maple/sleep", { method: "POST", body: JSON.stringify(body) });
          helper?.apply(r.sleep, r.entries ?? [], r.removed ?? []);
          return r;
        } catch (err) {
          const b = err instanceof ApiError ? (err.body as Answer | null) : null;
          if (b?.sleep) helper?.apply(b.sleep);
          throw err;
        } finally {
          setBusy(false);
        }
      };
      return helper ? helper.track(run) : run();
    },
    [api, helper]
  );

  /** Why a write didn't save, in a toast (a connection problem offers Try again, which sends the same request). */
  const refused = useCallback(
    (err: unknown, retry: () => void) => {
      const b = err instanceof ApiError ? (err.body as Answer | null) : null;
      const offline = !(err instanceof ApiError) || err.status >= 500;
      toast(b?.error ?? (offline ? OFFLINE : "That didn't save."), {
        tone: "error",
        ...(offline ? { actions: [{ label: "Try again", onClick: retry }] } : {}),
      });
    },
    [toast]
  );

  /** One write, saying why in a toast when it's refused (`quiet`: no toast). */
  const post = useCallback(
    async (body: Record<string, unknown>, opts: { quiet?: boolean } = {}): Promise<Answer | null> => {
      try {
        return await send(body);
      } catch (err) {
        if (!opts.quiet) refused(err, () => void post(body, opts));
        return null;
      }
    },
    [refused, send]
  );

  const createPlan = useCallback(
    async (init: PlanPatch = {}) => {
      const r = await post({ action: "plan.create", plan: init });
      return (r?.plan as SleepPlan | undefined) ?? null;
    },
    [post]
  );

  const updatePlan = useCallback(
    async (patch: PlanPatch) => {
      if (!data.plan) return null;
      const r = await post({ action: "plan.update", revision: data.plan.revision, patch });
      return (r?.plan as SleepPlan | undefined) ?? null;
    },
    [data.plan, post]
  );

  /** "In the bassinet at 2:10 AM · try 1 tonight", with a minute or five earlier and Undo (which takes back the sleep it started too). */
  const startTry = useCallback(
    async (opts: { tags?: TryTag[] } = {}) => {
      tick();
      const fedRecently = (state?.entries ?? []).some((e) => e.kind === "feed" && !e.active && e.ended_at && now().getTime() - Date.parse(e.ended_at) <= 30 * 60_000);
      const tags = [...new Set([...(opts.tags ?? []), ...(fedRecently ? (["fed"] as TryTag[]) : [])])];
      const r = await post({ action: "try.start", client_id: `try-${crypto.randomUUID()}`, tags });
      const w = r?.result as Write | undefined;
      if (!w) return null;
      if (w.status === "running") {
        toast(`Already in the bassinet since ${formatTime(w.try.started_at, tz)}${w.try.put_down_by && w.try.put_down_by !== me ? ` (${m.memberName(w.try.put_down_by)} laid ${v.them} down)` : ""}.`, { tone: "info" });
        return w.try;
      }
      const feed = (state?.entries ?? []).find((e) => e.kind === "feed" && e.active);
      const undo = async () => {
        const d = await post({ action: "try.delete", id: w.try.id, expect_updated_at: w.try.updated_at });
        if (d && w.endedShift) await post({ action: "shift.reopen", id: w.endedShift.id, expect_updated_at: w.endedShift.updated_at }, { quiet: true });
        if (d) toast("Undone", { tone: "info" });
      };
      const earlier = (n: number): ToastAction => {
        const to = new Date(Date.parse(w.try.started_at) - n * 60_000);
        return {
          label: `${n} min`,
          sub: formatTimeNear(to, w.try.started_at, tz),
          ariaLabel: `Laid down ${n} minutes earlier, at ${formatTime(to, tz)}`,
          onClick: () => void post({ action: "try.update", id: w.try.id, started_at: to.toISOString(), expect_updated_at: w.try.updated_at }).then((x) => x && toast(`Laid down at ${formatTime(to, tz)}`, { tone: "ok" })),
        };
      };
      const label = nthOf(w.try, r?.sleep?.tries ?? data.tries, tz, now());
      toast(`In the bassinet at ${formatTime(w.try.started_at, tz)}${label ? ` · ${label}` : ""}.${feed ? " The nursing timer is still running." : " Earlier?"}`, {
        tone: "ok",
        group: "timer",
        undo: () => void undo(),
        actions: feed ? [{ label: `Stop the feed`, onClick: () => void m.timerCall({ action: "stop", id: feed.id, at: w.try.started_at }) }] : [earlier(1), earlier(2), earlier(5)],
      });
      return w.try;
    },
    [data.tries, m, me, now, post, state?.entries, toast, tz, v.them]
  );

  const finishTry = useCallback(
    async (t: BassinetTry, outcome: TryOutcome, opts: { at?: Date; tags?: TryTag[]; note?: string | null } = {}) => {
      tick();
      ownEnds.current.add(t.id);
      const r = await post({
        action: "try.finish",
        id: t.id,
        outcome,
        expect_updated_at: t.updated_at,
        ...(opts.at ? { at: opts.at.toISOString() } : {}),
        ...(opts.tags ? { tags: opts.tags } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      });
      const w = r?.result as Write | undefined;
      if (!w) return null;
      if (w.status === "already_finished") {
        toast(`That try already ended at ${formatTime(w.try.ended_at!, tz)}: ${OUTCOME_LABEL[w.try.outcome!].toLowerCase()}.`, { tone: "info" });
        return w.try;
      }
      const sleepAfter = (r?.entries ?? []).find((e) => e.id === w.try.sleep_entry_id) ?? null;
      const stopped = !!w.sleepBefore?.active && !!sleepAfter && !sleepAfter.active;
      const mins = Math.round((Date.parse(w.try.ended_at!) - Date.parse(w.try.started_at)) / 60_000);
      const undo = async () => {
        const back = await post({
          action: "try.undo_finish",
          id: w.try.id,
          expect_updated_at: w.try.updated_at,
          ...(sleepAfter && w.sleepBefore && w.sleepBefore.kind === "sleep"
            ? { sleep: { id: sleepAfter.id, expect_updated_at: sleepAfter.updated_at, was_active: !!w.sleepBefore.active, ...(outcome === "picked_up" ? { place: (w.sleepBefore.data as { place?: SleepPlace }).place ?? null } : {}) } }
            : {}),
        });
        if (back) toast("Undone: the try is running again", { tone: "info" });
      };
      const tail = outcome === "picked_up" ? ` ${v.They}${v.verb("'s")} still asleep, so ${v.their} sleep timer keeps running.` : stopped ? " Sleep timer stopped." : "";
      toast(`${OUTCOME_LABEL[outcome]} after ${mins} min.${tail}`, { tone: "ok", group: "timer", undo: () => void undo() });
      return w.try;
    },
    [post, toast, tz, v]
  );

  const fixTry = useCallback(
    async (t: BassinetTry, patch: Record<string, unknown>) => {
      const r = await post({ action: "try.update", id: t.id, expect_updated_at: t.updated_at, ...patch });
      const w = r?.result as Write | undefined;
      if (!w) return null;
      toast("Try updated", { tone: "ok" });
      return w.try;
    },
    [post, toast]
  );

  const deleteTry = useCallback(
    async (t: BassinetTry) => {
      ownEnds.current.add(t.id);
      const r = await post({ action: "try.delete", id: t.id, expect_updated_at: t.updated_at });
      if (!r) return false;
      const res = r.result as { sleepDeleted?: Entry | null } | undefined;
      toast(res?.sleepDeleted ? "Try deleted, with the sleep it started" : "Try deleted", {
        tone: "info",
        undo: () => void post({ action: "try.restore", id: t.id, sleep_id: res?.sleepDeleted?.id ?? null }),
      });
      return true;
    },
    [post, toast]
  );

  const logTry = useCallback(
    async (opts: { start: Date; end: Date; outcome: TryOutcome; tags: TryTag[]; note: string | null; putDownBy: string | null; allowDuplicate?: boolean }) => {
      const r = await post({
        action: "try.log",
        client_id: `try-${crypto.randomUUID()}`,
        started_at: opts.start.toISOString(),
        ended_at: opts.end.toISOString(),
        outcome: opts.outcome,
        tags: opts.tags,
        note: opts.note,
        put_down_by: opts.putDownBy,
        allow_duplicate: !!opts.allowDuplicate,
      });
      const w = r?.result as Write | undefined;
      if (!w) return null;
      if (w.status === "duplicate") return { duplicate: w.try };
      const mins = Math.round((opts.end.getTime() - opts.start.getTime()) / 60_000);
      toast(`Try saved: ${OUTCOME_LABEL[opts.outcome].toLowerCase()} after ${mins} min, from ${formatTime(opts.start, tz)}`, {
        tone: "ok",
        ...(w.status === "created" ? { undo: () => void post({ action: "try.delete", id: w.try.id, expect_updated_at: w.try.updated_at }).then((d) => d && toast("Undone", { tone: "info" })) } : {}),
      });
      return { saved: w.try };
    },
    [post, toast, tz]
  );

  const startShift = useCallback(
    async (opts: { holder: string; handoffAt: Date | null; nextHolder: string | null }) => {
      tick();
      const r = await post({ action: "shift.start", holder: opts.holder, handoff_at: opts.handoffAt?.toISOString() ?? null, next_holder: opts.nextHolder, client_id: `shift-${crypto.randomUUID()}` });
      const w = r?.result as ShiftResult | undefined;
      if (!w) return null;
      if (w.status === "open") toast(`${m.memberName(w.shift.holder)} is already holding ${v.them}.`, { tone: "info" });
      else toast(`Holding ${v.them}${w.shift.handoff_at ? ` · handoff ${formatTime(w.shift.handoff_at, tz)}` : ""}`, { tone: "ok", undo: () => void post({ action: "shift.delete", id: w.shift.id, expect_updated_at: w.shift.updated_at }) });
      return w.shift;
    },
    [m, post, toast, tz, v.them]
  );

  const handOff = useCallback(
    async (s: HoldingShift, opts: { to: string; handoffAt?: Date | null; wake?: boolean }) => {
      tick();
      const r = await post({ action: "shift.handoff", id: s.id, to: opts.to, expect_updated_at: s.updated_at, wake: !!opts.wake, ...(opts.handoffAt !== undefined ? { handoff_at: opts.handoffAt?.toISOString() ?? null } : {}) });
      const w = r?.result as ShiftResult | undefined;
      if (!w) return null;
      const ended = w.ended;
      toast(`${opts.to === me ? "You're" : `${m.memberName(opts.to)} is`} holding ${v.them} now${w.shift.handoff_at ? ` · next handoff ${formatTime(w.shift.handoff_at, tz)}` : ""}`, {
        tone: "ok",
        ...(ended
          ? { undo: () => void post({ action: "shift.undo_handoff", started_id: w.shift.id, started_updated_at: w.shift.updated_at, ended_id: ended.id, ended_updated_at: ended.updated_at }) }
          : {}),
      });
      return w.shift;
    },
    [m, me, post, toast, tz, v.them]
  );

  const endShift = useCallback(
    async (s: HoldingShift) => {
      const r = await post({ action: "shift.end", id: s.id, expect_updated_at: s.updated_at });
      const w = r?.result as ShiftResult | undefined;
      if (!w) return false;
      toast("Shift ended", { tone: "info", undo: () => void post({ action: "shift.reopen", id: w.shift.id, expect_updated_at: w.shift.updated_at }) });
      return true;
    },
    [post, toast]
  );

  const laterHandoff = useCallback(
    async (s: HoldingShift, minutes: number) => {
      const base = Math.max(now().getTime(), s.handoff_at ? Date.parse(s.handoff_at) : now().getTime());
      const to = new Date(base + minutes * 60_000);
      const r = await post({ action: "shift.update", id: s.id, handoff_at: to.toISOString(), expect_updated_at: s.updated_at });
      if (r) toast(`Handoff planned for ${formatTime(to, tz)}`, { tone: "ok" });
      return !!r;
    },
    [now, post, toast, tz]
  );

  // ── sleep goals ──

  /**
   * A goal write. A stale revision (409) comes back as the goal as it is now
   * (already applied here); with `form`, the rules' refusals (400) come back
   * as words for the form to show by the field, and a 409 is the form's to
   * explain. Otherwise both are toasts.
   */
  const goalWrite = useCallback(
    async (body: Record<string, unknown>, opts: { form?: boolean } = {}): Promise<GoalSave> => {
      try {
        const w = (await send(body)).result as GoalResult | undefined;
        return w ? { saved: w.goal, status: w.status } : null;
      } catch (err) {
        const b = err instanceof ApiError ? (err.body as Answer | null) : null;
        if (err instanceof ApiError && err.status === 409) {
          const current = (b?.current as SleepGoal | null | undefined) ?? null;
          if (!opts.form) toast("Someone changed this goal on another phone just now, so that didn't save. It shows as it is now.", { tone: "info" });
          return current ? { conflict: current } : null;
        }
        if (err instanceof ApiError && err.status === 400 && opts.form) return { problem: b?.error ?? "That didn't save." };
        refused(err, () => void goalWrite(body, opts));
        return null;
      }
    },
    [refused, send, toast]
  );

  const createGoal = useCallback(
    async (input: GoalInput) => {
      // One client id per save: a retried request (Try again, a lost answer) gets the first save back.
      const r = await goalWrite({ action: "goal.create", goal: input, client_id: `goal-${crypto.randomUUID()}` }, { form: true });
      if (r && "saved" in r) toast(`Sleep goal saved: ${r.saved.title}`, { tone: "ok" });
      return r;
    },
    [goalWrite, toast]
  );

  const updateGoal = useCallback(
    async (goal: SleepGoal, patch: GoalInput, opts: { form?: boolean; saved?: string } = {}) => {
      const r = await goalWrite({ action: "goal.update", id: goal.id, revision: goal.revision, patch }, { form: !!opts.form });
      if (r && "saved" in r) toast(r.status === "unchanged" ? "Nothing changed" : (opts.saved ?? "Sleep goal updated"), { tone: "ok" });
      return r;
    },
    [goalWrite, toast]
  );

  const toggleStep = useCallback(
    async (goal: SleepGoal, step: GoalStep, done: boolean) => {
      tick();
      // No revision: a step means the same on the goal as it is now, so another phone's edit never turns it away.
      const r = await post({ action: "goal.step", id: goal.id, step: step.id, done });
      const w = r?.result as GoalResult | undefined;
      if (!w) return false;
      if (w.status === "unchanged") {
        toast(done ? `Already done: ${step.title}` : `Already not done: ${step.title}`, { tone: "info" });
        return true;
      }
      toast(done ? `Step done: ${step.title}` : `Marked not done: ${step.title}`, {
        tone: "ok",
        undo: () => void post({ action: "goal.step", id: goal.id, step: step.id, done: !done }).then((x) => x && toast("Undone", { tone: "info" })),
      });
      return true;
    },
    [post, toast]
  );

  const closeGoal = useCallback(
    async (goal: SleepGoal, status: "met" | "dropped", note?: string | null) => {
      const r = await post({ action: "goal.close", id: goal.id, status, ...(note ? { note } : {}) });
      const w = r?.result as GoalResult | undefined;
      if (!w) return false;
      if (w.status === "unchanged") {
        toast(status === "met" ? "That goal is already closed as met." : "That goal is already set aside.", { tone: "info" });
        return true;
      }
      // Undo opens it again as it was (active or paused), from the revision this close made.
      const was = w.before?.status === "paused" ? "paused" : "active";
      toast(status === "met" ? `Closed as met: ${goal.title}` : `Set aside: ${goal.title}`, {
        tone: "ok",
        undo: () =>
          void goalWrite({ action: "goal.update", id: w.goal.id, revision: w.goal.revision, patch: { status: was } }).then((x) => x && "saved" in x && toast("Undone: the goal is open again", { tone: "info" })),
      });
      return true;
    },
    [goalWrite, post, toast]
  );

  // ── check-ins: always the signed-in adult's own ──

  const saveCheckin = useCallback(
    async (answer: ProtectedAnswer, opts: { night?: string; note?: string | null } = {}) => {
      tick();
      const r = await post({
        action: "checkin.save",
        protected: answer,
        client_id: `checkin-${crypto.randomUUID()}`,
        ...(opts.night ? { night: opts.night } : {}),
        // Left out (one tap on Today), the note already there stays.
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      });
      const w = r?.result as CheckinResult | undefined;
      if (!w) return null;
      const c = w.checkin;
      const before = w.before;
      // Undo deletes a new check-in, or puts back the answer (and note) it replaced.
      const undo =
        w.status === "created"
          ? () => void post({ action: "checkin.delete", id: c.id }).then((x) => x && toast("Undone", { tone: "info" }))
          : w.status === "updated" && before
            ? () => void post({ action: "checkin.save", night: before.night, protected: before.protected, note: before.note, client_id: `checkin-${crypto.randomUUID()}` }).then((x) => x && toast("Undone", { tone: "info" }))
            : undefined;
      toast(`Checked in for ${nightWords(c.night, now(), tz)}: ${PROTECTED_LABEL[c.protected].toLowerCase()}`, { tone: "ok", ...(undo ? { undo } : {}) });
      return c;
    },
    [now, post, toast, tz]
  );

  const deleteCheckin = useCallback(
    async (c: SleepCheckin) => {
      const r = await post({ action: "checkin.delete", id: c.id });
      if (!r) return false;
      toast("Check-in removed", {
        tone: "info",
        undo: () => void post({ action: "checkin.save", night: c.night, protected: c.protected, note: c.note, client_id: `checkin-${crypto.randomUUID()}` }),
      });
      return true;
    },
    [post, toast]
  );

  const saveCheckinExtras = useSaveCheckinExtras({ checkins: adult ? (data.checkins ?? []) : null, me, post, toast });

  const value = useMemo<SleepApi>(
    () => ({
      data,
      plan: data.plan,
      running,
      shift,
      today,
      suggestion,
      nth,
      canWrite: !readOnly,
      busy,
      sheet,
      openSheet: setSheet,
      closeSheet: () => setSheet(null),
      createPlan,
      updatePlan,
      startTry,
      finishTry,
      fixTry: fixTry as SleepApi["fixTry"],
      deleteTry,
      logTry,
      startShift,
      handOff,
      endShift,
      laterHandoff,
      endedHere,
      goals: data.goals ?? [],
      checkins: adult ? (data.checkins ?? []) : null,
      me,
      seesCheckins: adult,
      createGoal,
      updateGoal,
      toggleStep,
      closeGoal,
      saveCheckin,
      deleteCheckin,
      saveCheckinExtras,
    }),
    [
      adult,
      saveCheckinExtras,
      busy,
      closeGoal,
      createGoal,
      createPlan,
      data,
      deleteCheckin,
      deleteTry,
      endShift,
      endedHere,
      finishTry,
      fixTry,
      handOff,
      laterHandoff,
      logTry,
      me,
      nth,
      readOnly,
      running,
      saveCheckin,
      sheet,
      shift,
      startShift,
      startTry,
      suggestion,
      today,
      toggleStep,
      updateGoal,
      updatePlan,
    ]
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {sheets?.(value)}
    </Ctx.Provider>
  );
}

/** The keys an extra answer lives under, so Undo can put each back as it was (null for none). */
const EXTRA_KEYS = ["place", "untimed_try", "untimed_min", "handoff"] as const;

/**
 * The night's other answers, saved on this adult's own check-in for it (one
 * write with the answer it already has), with Undo putting back what those
 * keys held before.
 */
function useSaveCheckinExtras(o: {
  checkins: SleepCheckin[] | null;
  me: string;
  post: (body: Record<string, unknown>, opts?: { quiet?: boolean }) => Promise<Answer | null>;
  toast: (text: string, opts?: Partial<{ tone: "ok" | "info" | "error"; undo: () => void }>) => number;
}) {
  const { checkins, me, post, toast } = o;
  return useCallback(
    async (night: string, extras: CheckinExtras, said: string) => {
      const mine = checkins?.find((c) => c.member === me && c.night === night) ?? null;
      if (!mine) return null;
      tick();
      const r = await post({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...extras });
      const w = r?.result as CheckinResult | undefined;
      if (!w) return null;
      const back = Object.fromEntries(EXTRA_KEYS.filter((k) => k in extras).map((k) => [k, mine[k] ?? null]));
      toast(said, {
        tone: "ok",
        undo: () => void post({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...back }).then((x) => x && toast("Undone", { tone: "info" })),
      });
      return w.checkin;
    },
    [checkins, me, post, toast]
  );
}

function nthOf(t: BassinetTry, tries: BassinetTry[], tz: string, now: Date): string {
  const all = tries.some((x) => x.id === t.id) ? tries : [t, ...tries];
  const n = numberTries(all, tz).get(t.id);
  return n ? `try ${n.n} ${tryDayLabel(n.day, tryDayKey(now, tz))}${n.retry ? ", a retry" : ""}` : "";
}

/**
 * After Woke up (the dock, the Lantern): a bassinet try laid on that sleep
 * asks how it went, ending when she woke. The sleep stops either way, so a
 * dismissed sheet leaves the log right and the try's card still asks.
 */
export function useTryAfterWake(): (sleepId: number, at: Date) => void {
  const s = useSleepMaybe();
  return useCallback(
    (sleepId: number, at: Date) => {
      const t = s?.running;
      if (!s || !t || !s.canWrite || t.sleep_entry_id !== sleepId) return;
      s.openSheet({ kind: "outcome", tryId: t.id, at: at.toISOString() });
    },
    [s]
  );
}

/** Her age for the plan's words, and the signals for guidance, from the shared state. */
export function useSleepContext() {
  const { state, now } = useMaple();
  const s = useSleep();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const age = state ? sleepAge(state.baby, t) : null;
  const signals = sleepSignals(s.data.tries, t, tz, { suggestion: s.suggestion });
  return { age, signals, tz, now: t };
}

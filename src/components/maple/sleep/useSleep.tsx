"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { tick } from "@/components/atlas/haptics";
import { ApiError } from "@/lib/maple/client-request";
import { numberTries, planToday, sleepAge, sleepSignals, stageSuggestion, tryDayKey, tryDayNowLabel, tryWhenLabel, type PlanToday, type StageSuggestion } from "@/lib/maple/sleep/engine";
import { checkinTryOn, nightWords, seesCheckins } from "@/lib/maple/sleep/goals";
import { handoffWhyWords, type HandoffWhy } from "@/lib/maple/sleep/handoff";
import type { BassinetTry, CheckinExtras, GoalInput, GoalStep, HoldingShift, PlanPatch, ProtectedAnswer, SleepCheckin, SleepGoal, SleepPlan, SleepState, TryOutcome, TryTag } from "@/lib/maple/sleep/types";
import { cryingLine, downWords, OUTCOME_LABEL, PROTECTED_LABEL } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, Member, SleepPlace } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
import { noteTap } from "../tapCooldown";
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
  /** How did it go? (`details`: opened for tags, a note or an earlier end, so Add details starts open). */
  | { kind: "outcome"; tryId: number; at?: string; details?: boolean }
  | { kind: "sleepy" }
  /** Start a turn, or record a handoff (`to`: who has her, preselected: the strip's "Hand off to Alex", or "Take over"). */
  | { kind: "holding"; mode: "start" | "handoff"; to?: string }
  | { kind: "try"; tryId: number }
  | { kind: "log" }
  /** A sleep goal's form: a new one, or `goalId` to change. It goes back to the plan's Goals when it closes. */
  | { kind: "goal"; goalId?: number }
  /** "How did last night go?": the signed-in adult's own check-in (last night unless `night`); `back` returns to Goals; `card`: opened from Today's Last night card, whose receipt it shows. */
  | { kind: "checkin"; night?: string; back?: "goals"; card?: boolean }
  /** "I've got her": a short catch-up for the person who just took over, with Undo (the turn they took and the one handed over). */
  | { kind: "catchup"; started: HoldingShift; ended: HoldingShift | null; why?: HandoffWhy | null };

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
type ShiftResult = {
  shift: HoldingShift;
  before: HoldingShift | null;
  status: string;
  ended?: HoldingShift | null;
  endedBefore?: HoldingShift | null;
  /** Her sleep in arms, when the write touched it (sleep/store.ts ShiftWrite). */
  sleep?: Entry | null;
  sleepBefore?: Entry | null;
  madeSleep?: boolean;
  /** A handoff's next one moved off the next holder's protected window (sleep/handoff.ts). */
  handoffWhy?: HandoffWhy | null;
};
type GoalResult = { goal: SleepGoal; before: SleepGoal | null; status: "created" | "deduped" | "updated" | "unchanged" };
/**
 * A write's options: `done` follows a save that took the refusal toast's Try again; `conflict` takes a 409's answer
 * (false: a toast says it); `gaveUp`: refused with no Try again to come.
 */
type WriteOpts<T> = { quiet?: boolean; done?: (v: T) => void; conflict?: (b: Answer | null) => boolean; gaveUp?: () => void };
type WriteFn = <T>(body: Record<string, unknown>, after: (r: Answer) => T | null, opts?: WriteOpts<T>) => Promise<T | null>;
/** A refusal the toast offers Try again for: the connection, or the server's own trouble. */
const retryable = (err: unknown) => !(err instanceof ApiError) || err.status >= 500;
/** What a sheet or card hands a write: once it saves on Try again (its first answer was null), `done` (the sheet closing, a receipt). */
type Then<T> = { done?: (v: T) => void };

/** A try's 409 for the sheet it came from: the try as it is now (the answer's `current`, else its state); false without one. */
const tryConflict =
  (id: number, fn: (now: BassinetTry) => void) =>
  (b: Answer | null): boolean => {
    const cur = (b?.current as BassinetTry | null | undefined) ?? b?.sleep?.tries.find((x) => x.id === id) ?? null;
    if (!cur) return false;
    fn(cur);
    return true;
  };
type CheckinResult = { checkin: SleepCheckin; before: SleepCheckin | null; status: "created" | "updated" | "unchanged" | "deduped" };

/**
 * A goal form's save: the goal as saved; or, for an edit made from an older
 * revision (409), the goal as it is now, with nothing saved; or the rules'
 * words for what to fix (400). Null: it didn't reach the server (the toast
 * says so).
 */
export type GoalSave = GoalSaved | { conflict: SleepGoal } | { problem: string } | null;
type GoalSaved = { saved: SleepGoal; status: GoalResult["status"] };

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
  /**
   * A sheet's own way out (closed, or `next` in its place), only while it's still the one open: a save that took Try
   * again can land after another sheet opened.
   */
  leaveSheet: (from: SleepSheet, next?: SleepSheet | null) => void;
  createPlan: (init?: PlanPatch) => Promise<SleepPlan | null>;
  updatePlan: (patch: PlanPatch) => Promise<SleepPlan | null>;
  // Each write's toast with Undo (or catch-up) shows once it saves, now or on the refusal toast's Try again; `done` is the
  // caller's part after a save that took Try again (its first answer was null), such as closing its sheet.
  startTry: (opts?: { tags?: TryTag[] }) => Promise<BassinetTry | null>;
  /** `onConflict`: another phone's change to `t` since comes back there as the try as it is now (a sheet shows it), nothing saved. */
  finishTry: (t: BassinetTry, outcome: TryOutcome, opts?: { at?: Date; tags?: TryTag[]; note?: string | null; onConflict?: (now: BassinetTry) => void } & Then<BassinetTry>) => Promise<BassinetTry | null>;
  fixTry: (
    t: BassinetTry,
    patch: { started_at?: string; ended_at?: string; outcome?: TryOutcome; tags?: TryTag[]; note?: string | null; put_down_by?: string | null },
    opts?: { onConflict?: (now: BassinetTry) => void } & Then<BassinetTry>
  ) => Promise<BassinetTry | null>;
  deleteTry: (t: BassinetTry, opts?: Then<true>) => Promise<boolean>;
  /** A try that already happened (nobody tapped Put down). A likely twin saves nothing and comes back as `duplicate`. */
  logTry: (
    opts: { start: Date; end: Date; outcome: TryOutcome; tags: TryTag[]; note: string | null; putDownBy: string | null; allowDuplicate?: boolean } & Then<{ saved: BassinetTry } | { duplicate: BassinetTry }>
  ) => Promise<{ saved: BassinetTry } | { duplicate: BassinetTry } | null>;
  /** `asleep`: she's asleep in the holder's arms, so a sleep in arms starts with the turn (Undo takes back both). */
  startShift: (opts: { holder: string; handoffAt: Date | null; nextHolder: string | null; asleep?: boolean } & Then<HoldingShift>) => Promise<HoldingShift | null>;
  /** Records the handoff: `to` has her now (the holder's "Alex has her", or the Hand off sheet). To the signed-in person, it opens the catch-up. */
  handOff: (s: HoldingShift, opts: { to: string; handoffAt?: Date | null } & Then<HoldingShift>) => Promise<HoldingShift | null>;
  endShift: (s: HoldingShift) => Promise<boolean>;
  laterHandoff: (s: HoldingShift, minutes: number) => Promise<boolean>;
  /** "Wake [partner]": asks `to` to take over (their phones with handoff reminders on hear of it). Never a handoff; Undo takes back a first ask. */
  askHandoff: (s: HoldingShift | null, to: string) => Promise<HoldingShift | null>;
  /** "I've got her": the signed-in person takes over the turn as it is now, then sees the catch-up. */
  acceptHandoff: (s: HoldingShift) => Promise<HoldingShift | null>;
  /** "Asleep in arms" during a turn: a running sleep in arms from now (Undo deletes it). */
  asleepInArms: () => Promise<Entry | null>;
  /** Undo a handoff to this phone's person (from the catch-up): the turn handed over is open again. */
  undoTakeOver: (started: HoldingShift, ended: HoldingShift, opts?: Then<true>) => Promise<boolean>;
  /**
   * The plan editor's save, from the plan it started with: saved; or, changed
   * on another phone since (409), the plan as it is now (already applied), for
   * the editor to rebase on; or null (the toast says why).
   */
  savePlan: (base: SleepPlan, patch: PlanPatch, opts?: Then<{ saved: SleepPlan }>) => Promise<{ saved: SleepPlan } | { conflict: SleepPlan } | null>;
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
  createGoal: (input: GoalInput, opts?: Then<GoalSave>) => Promise<GoalSave>;
  /**
   * Names the goal's revision: a goal changed elsewhere since is a 409, applied here and handed back as `conflict`.
   * `form`: a refusal comes back as `problem` and a 409 unspoken, for the form to show by the field; otherwise both are toasts.
   */
  updateGoal: (goal: SleepGoal, patch: GoalInput, opts?: { form?: boolean; saved?: string } & Then<GoalSave>) => Promise<GoalSave>;
  /** A step done or not (applies to the goal as it is now); Undo toggles it back. */
  toggleStep: (goal: SleepGoal, step: GoalStep, done: boolean) => Promise<boolean>;
  /** Close as met or set aside, with an optional note; Undo opens it again as it was, with the review a note replaced. */
  closeGoal: (goal: SleepGoal, status: "met" | "dropped", note?: string | null, opts?: Then<true>) => Promise<boolean>;
  /** The signed-in adult's own check-in (last night unless `night`); Undo deletes a new one or puts the earlier answer back. */
  saveCheckin: (answer: ProtectedAnswer, opts?: { night?: string; note?: string | null } & Then<SleepCheckin>) => Promise<SleepCheckin | null>;
  /** Their own check-in only; Undo saves it again. */
  deleteCheckin: (c: SleepCheckin, opts?: Then<boolean>) => Promise<boolean>;
  /**
   * The night's other answers (where the baby spent it, a try the log doesn't
   * have, the planned handoff) on the signed-in adult's own check-in for that
   * night, which comes first: null without one. `said`: the toast's words.
   * Undo puts back what it had.
   */
  saveCheckinExtras: (night: string, extras: CheckinExtras, said: string) => Promise<SleepCheckin | null>;

  // ── the Last night card's own answers: no toast (at 320px it would sit on the next question); the card shows the receipt ──
  /** saveCheckin for the card (with a note from its Add a note sheet): the words to show and an Undo (null when nothing changed). */
  answerCheckin: (answer: ProtectedAnswer, night: string, opts?: { note?: string | null } & Then<CardReceipt>) => Promise<CardReceipt | null>;
  /** saveCheckinExtras for the card. */
  answerExtras: (night: string, extras: CheckinExtras, said: string, opts?: Then<CardReceipt>) => Promise<CardReceipt | null>;
  /**
   * A goal write with no toast of its own (the card's look-back and return card show their receipts): the goal as saved,
   * a 409's goal as it is now (applied here, with a toast saying so), or null when refused (the toast says why).
   */
  goalCall: (body: Record<string, unknown>, opts?: Then<GoalSave>) => Promise<GoalSave>;
};

/** What the Last night card shows after an answer it saved: the words, and its Undo (true once undone). */
export type CardReceipt = { said: string; undo: (() => Promise<boolean>) | null };

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
  // A try last night's check-in said happened counts toward today's, shown apart (only on a phone that reads check-ins).
  const today = data.plan ? todayOnPhone(data.plan, data.tries, t0, tz, checkinTryOn(adult ? data.checkins : null, tryDayKey(t0, tz))) : null;
  const suggestion = stageSuggestion(data.plan, data.tries, t0, tz);

  const nth = useCallback(
    (t: BassinetTry) => {
      const n = numberTries(data.tries, tz).get(t.id);
      return n ? `try ${n.n} ${tryWhenLabel(t.started_at, now(), tz)}${n.retry ? ", a retry" : ""}` : "";
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
      const offline = retryable(err);
      toast(b?.error ?? (offline ? OFFLINE : "That didn't save."), {
        tone: "error",
        ...(offline ? { actions: [{ label: "Try again", onClick: retry }] } : {}),
      });
    },
    [toast]
  );

  /**
   * One write and what follows it once it saves (`after`: its toast with Undo, the catch-up, a card's receipt; null when
   * there's nothing to follow up). Refused, the toast says why, and its Try again sends the same request (the same
   * client id) and, once that saves, runs `after` and then the caller's `done` (a sheet closing, a receipt showing): the
   * first call has answered null by then. `conflict`: a 409's answer for the caller (the try or goal as it is now) instead
   * of a toast. `quiet`: no toast.
   */
  const write: WriteFn = useCallback(
    async <T,>(body: Record<string, unknown>, after: (r: Answer) => T | null, opts: WriteOpts<T> = {}): Promise<T | null> => {
      let answer: Answer;
      try {
        answer = await send(body);
      } catch (err) {
        if (opts.conflict && err instanceof ApiError && err.status === 409 && opts.conflict(err.body as Answer | null)) return null;
        if (!opts.quiet) refused(err, () => void write(body, after, opts).then((v) => v != null && opts.done?.(v)));
        // Refused for good (no Try again to come): a 400 or 409's words, or a quiet write.
        if (opts.quiet || !retryable(err)) opts.gaveUp?.();
        return null;
      }
      // Saved: what follows is never taken for a refusal (no Try again for a write that went through).
      return after(answer);
    },
    [refused, send]
  );

  /**
   * One write with no follow-up of its own (an Undo's, mostly): its answer once it saves, now or on the refusal toast's
   * Try again (so an Undo's "Undone" still shows); null once it's refused for good.
   */
  const post = useCallback(
    (body: Record<string, unknown>, opts: { quiet?: boolean } = {}): Promise<Answer | null> =>
      new Promise((resolve) => void write(body, (r) => r, { ...opts, done: resolve, gaveUp: () => resolve(null) }).then((r) => r && resolve(r))),
    [write]
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
      const feed = (state?.entries ?? []).find((e) => e.kind === "feed" && e.active);
      return write({ action: "try.start", client_id: `try-${crypto.randomUUID()}`, tags }, (r) => {
        const w = r.result as Write | undefined;
        if (!w) return null;
        if (w.status === "running") {
          toast(`Already in the bassinet since ${formatTime(w.try.started_at, tz)}${w.try.put_down_by && w.try.put_down_by !== me ? ` (${m.memberName(w.try.put_down_by)} laid ${v.them} down)` : ""}.`, { tone: "info" });
          return w.try;
        }
        const undo = () =>
          void write({ action: "try.delete", id: w.try.id, expect_updated_at: w.try.updated_at }, () => {
            if (w.endedShift) void post({ action: "shift.reopen", id: w.endedShift.id, expect_updated_at: w.endedShift.updated_at }, { quiet: true });
            return toast("Undone", { tone: "info" });
          });
        const earlier = (n: number): ToastAction => {
          const to = new Date(Date.parse(w.try.started_at) - n * 60_000);
          return {
            label: `${n} min`,
            sub: formatTimeNear(to, w.try.started_at, tz),
            ariaLabel: `Laid down ${n} minutes earlier, at ${formatTime(to, tz)}`,
            onClick: () => void write({ action: "try.update", id: w.try.id, started_at: to.toISOString(), expect_updated_at: w.try.updated_at }, () => toast(`Laid down at ${formatTime(to, tz)}`, { tone: "ok" })),
          };
        };
        const label = nthOf(w.try, r.sleep?.tries ?? data.tries, tz, now());
        toast(`In the bassinet at ${formatTime(w.try.started_at, tz)}${label ? ` · ${label}` : ""}.${feed ? " The nursing timer is still running." : " Earlier?"}`, {
          tone: "ok",
          group: "timer",
          undo,
          actions: feed ? [{ label: `Stop the feed`, onClick: () => void m.timerCall({ action: "stop", id: feed.id, at: w.try.started_at }) }] : [earlier(1), earlier(2), earlier(5)],
        });
        return w.try;
      });
    },
    [data.tries, m, me, now, post, state?.entries, toast, tz, v.them, write]
  );

  /**
   * The try's end. A sheet names the try as it opened (so its expect_updated_at is that version's) and sends tags and a
   * note only when it changed them; with `onConflict`, another phone's change since comes back there as the try as it is
   * now, and nothing is saved.
   */
  const finishTry = useCallback(
    async (t: BassinetTry, outcome: TryOutcome, opts: { at?: Date; tags?: TryTag[]; note?: string | null; onConflict?: (now: BassinetTry) => void } & Then<BassinetTry> = {}) => {
      tick();
      ownEnds.current.add(t.id);
      const body = {
        action: "try.finish",
        id: t.id,
        outcome,
        expect_updated_at: t.updated_at,
        ...(opts.at ? { at: opts.at.toISOString() } : {}),
        ...(opts.tags ? { tags: opts.tags } : {}),
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      };
      return write(
        body,
        (r) => {
          const w = r.result as Write | undefined;
          if (!w) return null;
          if (w.status === "already_finished") {
            toast(`That try already ended at ${formatTime(w.try.ended_at!, tz)}: ${OUTCOME_LABEL[w.try.outcome!].toLowerCase()}.`, { tone: "info" });
            return w.try;
          }
          const sleepAfter = (r.entries ?? []).find((e) => e.id === w.try.sleep_entry_id) ?? null;
          const stopped = !!w.sleepBefore?.active && !!sleepAfter && !sleepAfter.active;
          const mins = Math.round((Date.parse(w.try.ended_at!) - Date.parse(w.try.started_at)) / 60_000);
          const undo = () =>
            void write(
              {
                action: "try.undo_finish",
                id: w.try.id,
                expect_updated_at: w.try.updated_at,
                ...(sleepAfter && w.sleepBefore && w.sleepBefore.kind === "sleep"
                  ? { sleep: { id: sleepAfter.id, expect_updated_at: sleepAfter.updated_at, was_active: !!w.sleepBefore.active, ...(outcome === "picked_up" ? { place: (w.sleepBefore.data as { place?: SleepPlace }).place ?? null } : {}) } }
                  : {}),
              },
              () => toast("Undone: the try is running again", { tone: "info" })
            );
          const tail = outcome === "picked_up" ? ` ${v.They}${v.verb("'s")} still asleep, so ${v.their} sleep timer keeps running.` : stopped ? " Sleep timer stopped." : "";
          // After a crying wake, and after the retry: what the plan says to do now (soothe, retry once, then pause).
          const signals = sleepSignals(r.sleep?.tries ?? data.tries, now(), tz);
          const next = signals.has("retry_done") ? ` ${cryingLine(v, "retry_done")}.` : signals.has("after_crying") ? ` ${cryingLine(v, "after_crying")}.` : "";
          toast(`${OUTCOME_LABEL[outcome]} after ${downWords(mins)}.${tail}${next}`, { tone: "ok", group: "timer", undo });
          return w.try;
        },
        { done: opts.done, conflict: opts.onConflict && tryConflict(t.id, opts.onConflict) }
      );
    },
    [data.tries, now, toast, tz, v, write]
  );

  /** A try's edit: only the fields given, against `t`'s version; with `onConflict`, a 409 comes back there (the try as it is now). */
  const fixTry = useCallback(
    async (t: BassinetTry, patch: Record<string, unknown>, opts: { onConflict?: (now: BassinetTry) => void } & Then<BassinetTry> = {}) =>
      write(
        { action: "try.update", id: t.id, expect_updated_at: t.updated_at, ...patch },
        (r) => {
          const w = r.result as Write | undefined;
          if (!w) return null;
          toast("Try updated", { tone: "ok" });
          return w.try;
        },
        { done: opts.done, conflict: opts.onConflict && tryConflict(t.id, opts.onConflict) }
      ),
    [toast, write]
  );

  const deleteTry = useCallback(
    async (t: BassinetTry, opts: Then<true> = {}) => {
      ownEnds.current.add(t.id);
      const r = await write(
        { action: "try.delete", id: t.id, expect_updated_at: t.updated_at },
        (a) => {
          const res = a.result as { sleepDeleted?: Entry | null } | undefined;
          toast(res?.sleepDeleted ? "Try deleted, with the sleep it started" : "Try deleted", {
            tone: "info",
            undo: () => void post({ action: "try.restore", id: t.id, sleep_id: res?.sleepDeleted?.id ?? null }),
          });
          return true as const;
        },
        opts
      );
      return !!r;
    },
    [post, toast, write]
  );

  const logTry = useCallback(
    async (opts: { start: Date; end: Date; outcome: TryOutcome; tags: TryTag[]; note: string | null; putDownBy: string | null; allowDuplicate?: boolean } & Then<{ saved: BassinetTry } | { duplicate: BassinetTry }>) => {
      const body = {
        action: "try.log",
        client_id: `try-${crypto.randomUUID()}`,
        started_at: opts.start.toISOString(),
        ended_at: opts.end.toISOString(),
        outcome: opts.outcome,
        tags: opts.tags,
        note: opts.note,
        put_down_by: opts.putDownBy,
        allow_duplicate: !!opts.allowDuplicate,
      };
      return write(
        body,
        (r): { saved: BassinetTry } | { duplicate: BassinetTry } | null => {
          const w = r.result as Write | undefined;
          if (!w) return null;
          if (w.status === "duplicate") return { duplicate: w.try };
          const mins = Math.round((opts.end.getTime() - opts.start.getTime()) / 60_000);
          toast(`Try saved: ${OUTCOME_LABEL[opts.outcome].toLowerCase()} after ${downWords(mins)}, from ${formatTime(opts.start, tz)}`, {
            tone: "ok",
            ...(w.status === "created" ? { undo: () => void write({ action: "try.delete", id: w.try.id, expect_updated_at: w.try.updated_at }, () => toast("Undone", { tone: "info" })) } : {}),
          });
          return { saved: w.try };
        },
        { done: opts.done }
      );
    },
    [toast, tz, write]
  );

  const startShift = useCallback(
    async (opts: { holder: string; handoffAt: Date | null; nextHolder: string | null; asleep?: boolean } & Then<HoldingShift>) => {
      tick();
      const body = {
        action: "shift.start",
        holder: opts.holder,
        handoff_at: opts.handoffAt?.toISOString() ?? null,
        next_holder: opts.nextHolder,
        client_id: `shift-${crypto.randomUUID()}`,
        ...(opts.asleep ? { asleep: true } : {}),
      };
      return write(
        body,
        (r) => {
          const w = r.result as ShiftResult | undefined;
          if (!w) return null;
          if (w.status === "open") toast(`${m.memberName(w.shift.holder)} is already holding ${v.them}.`, { tone: "info" });
          else {
            // Undo takes back the turn, and the sleep in arms it started (while that's still as it was).
            const made = w.madeSleep && w.sleep ? w.sleep : null;
            const asleep = made ? ` · asleep in arms since ${formatTime(made.started_at, tz)}` : "";
            toast(`Holding ${v.them}${w.shift.handoff_at ? ` · handoff ${formatTime(w.shift.handoff_at, tz)}` : ""}${asleep}`, {
              tone: "ok",
              undo: () => void post({ action: "shift.delete", id: w.shift.id, expect_updated_at: w.shift.updated_at, ...(made ? { sleep: { id: made.id, expect_updated_at: made.updated_at } } : {}) }),
            });
          }
          return w.shift;
        },
        { done: opts.done }
      );
    },
    [m, post, toast, tz, v.them, write]
  );

  const handOff = useCallback(
    async (s: HoldingShift, opts: { to: string; handoffAt?: Date | null } & Then<HoldingShift>) => {
      tick();
      return write(
        { action: "shift.handoff", id: s.id, to: opts.to, expect_updated_at: s.updated_at, ...(opts.handoffAt !== undefined ? { handoff_at: opts.handoffAt?.toISOString() ?? null } : {}) },
        (r) => {
          const w = r.result as ShiftResult | undefined;
          if (!w) return null;
          const ended = w.ended ?? null;
          // Taken over by this phone's person: the catch-up, with its own Undo.
          if (opts.to === me) {
            setSheet({ kind: "catchup", started: w.shift, ended, why: w.handoffWhy ?? null });
            return w.shift;
          }
          toast(`${m.memberName(opts.to)} has ${v.them} now${nextHandoffToast(w, me, m.memberName, tz)}`, {
            tone: "ok",
            ...(ended
              ? { undo: () => void post({ action: "shift.undo_handoff", started_id: w.shift.id, started_updated_at: w.shift.updated_at, ended_id: ended.id, ended_updated_at: ended.updated_at }) }
              : {}),
          });
          return w.shift;
        },
        { done: opts.done }
      );
    },
    [m, me, post, toast, tz, v.them, write]
  );

  const endShift = useCallback(
    async (s: HoldingShift) => {
      const r = await write({ action: "shift.end", id: s.id, expect_updated_at: s.updated_at }, (a) => {
        const w = a.result as ShiftResult | undefined;
        if (!w) return null;
        // Ended awake: her sleep in arms stopped then too; Undo runs both again.
        const stopped = w.sleep && w.sleepBefore?.active ? w.sleep : null;
        toast(stopped ? `Shift ended · ${v.their} sleep in arms stopped at ${formatTime(stopped.ended_at ?? w.shift.ended_at!, tz)}` : "Shift ended", {
          tone: "info",
          undo: () => void post({ action: "shift.reopen", id: w.shift.id, expect_updated_at: w.shift.updated_at, ...(stopped ? { sleep: { id: stopped.id, expect_updated_at: stopped.updated_at } } : {}) }),
        });
        return true as const;
      });
      return !!r;
    },
    [post, toast, tz, v.their, write]
  );

  const laterHandoff = useCallback(
    async (s: HoldingShift, minutes: number) => {
      const base = Math.max(now().getTime(), s.handoff_at ? Date.parse(s.handoff_at) : now().getTime());
      const to = new Date(base + minutes * 60_000);
      return !!(await write({ action: "shift.update", id: s.id, handoff_at: to.toISOString(), expect_updated_at: s.updated_at }, () => toast(`Handoff planned for ${formatTime(to, tz)}`, { tone: "ok" })));
    },
    [now, toast, tz, write]
  );

  // ── handoffs that close the loop: ask, then whoever has her says so ──

  const askHandoff = useCallback(
    async (sh: HoldingShift | null, to: string) => {
      tick();
      return write({ action: "shift.ask", id: sh?.id ?? null, to }, (r) => {
        const w = r.result as ShiftResult | undefined;
        if (!w) return null;
        // Asking again only moves the ask's time, and nothing can put the earlier ask back: Undo is for a first ask, which
        // it takes back exactly (nobody asked); an ask over an earlier one stands, as that one did.
        const earlier = w.before?.asked_to ?? null;
        toast(`Asked ${m.memberName(to)}${earlier === to ? " again" : ""} to take over`, {
          tone: "ok",
          ...(earlier ? {} : { undo: () => void write({ action: "shift.cancel_ask", id: w.shift.id, expect_updated_at: w.shift.updated_at }, () => toast("Undone: nobody is asked now", { tone: "info" })) }),
        });
        return w.shift;
      });
    },
    [m, toast, write]
  );

  const acceptHandoff = useCallback(
    async (sh: HoldingShift) => {
      tick();
      return write({ action: "shift.accept", id: sh.id }, (r) => {
        const w = r.result as ShiftResult | undefined;
        if (!w) return null;
        setSheet({ kind: "catchup", started: w.shift, ended: w.ended ?? null, why: w.handoffWhy ?? null });
        return w.shift;
      });
    },
    [write]
  );

  const undoTakeOver = useCallback(
    async (started: HoldingShift, ended: HoldingShift, opts: Then<true> = {}) =>
      !!(await write(
        { action: "shift.undo_handoff", started_id: started.id, started_updated_at: started.updated_at, ended_id: ended.id, ended_updated_at: ended.updated_at },
        () => {
          toast(`Undone: ${m.memberName(ended.holder)} is holding ${v.them} again`, { tone: "info" });
          return true as const;
        },
        opts
      )),
    [m, toast, v.them, write]
  );

  const asleepInArms = useCallback(async () => {
    tick();
    return write({ action: "shift.asleep", client_id: `arms-${crypto.randomUUID()}` }, (r) => {
      const w = r.result as { sleep: Entry; made: boolean } | undefined;
      if (!w) return null;
      if (!w.made) {
        toast(`Already asleep since ${formatTime(w.sleep.started_at, tz)}`, { tone: "info" });
        return w.sleep;
      }
      toast(`Asleep in arms since ${formatTime(w.sleep.started_at, tz)}`, {
        tone: "ok",
        undo: () => void write({ action: "shift.asleep_undo", sleep: { id: w.sleep.id, expect_updated_at: w.sleep.updated_at } }, () => toast("Undone", { tone: "info" })),
      });
      return w.sleep;
    });
  }, [toast, tz, write]);

  const savePlan = useCallback(
    async (base: SleepPlan, patch: PlanPatch, opts: Then<{ saved: SleepPlan }> = {}): Promise<{ saved: SleepPlan } | { conflict: SleepPlan } | null> => {
      // Changed on another phone: the answer's state is applied already; the editor keeps this person's changes on top.
      const changed: { plan: SleepPlan | null } = { plan: null };
      const r = await write(
        { action: "plan.update", revision: base.revision, patch },
        (a) => (a.plan ? { saved: a.plan } : null),
        {
          done: opts.done,
          conflict: (b) => !!(changed.plan = (b?.current as SleepPlan | null | undefined) ?? null),
        }
      );
      return r ?? (changed.plan ? { conflict: changed.plan } : null);
    },
    [write]
  );

  // ── sleep goals ──

  /**
   * A goal write. A stale revision (409) comes back as the goal as it is now
   * (already applied here); with `form`, the rules' refusals (400) come back
   * as words for the form to show by the field, and a 409 is the form's to
   * explain. Otherwise both are toasts.
   */
  const goalWrite = useCallback(
    async (body: Record<string, unknown>, opts: { form?: boolean; after?: (s: GoalSaved) => void } & Then<GoalSave> = {}): Promise<GoalSave> => {
      let w: GoalResult | undefined;
      try {
        w = (await send(body)).result as GoalResult | undefined;
      } catch (err) {
        const b = err instanceof ApiError ? (err.body as Answer | null) : null;
        if (err instanceof ApiError && err.status === 409) {
          const current = (b?.current as SleepGoal | null | undefined) ?? null;
          if (!opts.form) toast("Someone changed this goal on another phone just now, so that didn't save. It shows as it is now.", { tone: "info" });
          return current ? { conflict: current } : null;
        }
        if (err instanceof ApiError && err.status === 400 && opts.form) return { problem: b?.error ?? "That didn't save." };
        refused(err, () => void goalWrite(body, opts).then((x) => x && opts.done?.(x)));
        return null;
      }
      if (!w) return null;
      const saved: GoalSaved = { saved: w.goal, status: w.status };
      // What follows the save (its toast, its Undo), now or after Try again; never taken for a refusal.
      opts.after?.(saved);
      return saved;
    },
    [refused, send, toast]
  );

  const createGoal = useCallback(
    async (input: GoalInput, opts: Then<GoalSave> = {}) =>
      // One client id per save: a retried request (Try again, a lost answer) gets the first save back.
      goalWrite({ action: "goal.create", goal: input, client_id: `goal-${crypto.randomUUID()}` }, { form: true, after: (r) => toast(`Sleep goal saved: ${r.saved.title}`, { tone: "ok" }), done: opts.done }),
    [goalWrite, toast]
  );

  const updateGoal = useCallback(
    async (goal: SleepGoal, patch: GoalInput, opts: { form?: boolean; saved?: string } & Then<GoalSave> = {}) =>
      goalWrite(
        { action: "goal.update", id: goal.id, revision: goal.revision, patch },
        { form: !!opts.form, after: (r) => toast(r.status === "unchanged" ? "Nothing changed" : (opts.saved ?? "Sleep goal updated"), { tone: "ok" }), done: opts.done }
      ),
    [goalWrite, toast]
  );

  const toggleStep = useCallback(
    async (goal: SleepGoal, step: GoalStep, done: boolean) => {
      tick();
      // No revision: a step means the same on the goal as it is now, so another phone's edit never turns it away.
      const r = await write({ action: "goal.step", id: goal.id, step: step.id, done }, (a) => {
        const w = a.result as GoalResult | undefined;
        if (!w) return null;
        if (w.status === "unchanged") toast(done ? `Already done: ${step.title}` : `Already not done: ${step.title}`, { tone: "info" });
        else
          toast(done ? `Step done: ${step.title}` : `Marked not done: ${step.title}`, {
            tone: "ok",
            undo: () => void write({ action: "goal.step", id: goal.id, step: step.id, done: !done }, () => toast("Undone", { tone: "info" })),
          });
        return true as const;
      });
      return !!r;
    },
    [toast, write]
  );

  const closeGoal = useCallback(
    async (goal: SleepGoal, status: "met" | "dropped", note?: string | null, opts: Then<true> = {}) => {
      const r = await write(
        { action: "goal.close", id: goal.id, status, ...(note ? { note } : {}) },
        (a) => {
          const w = a.result as GoalResult | undefined;
          if (!w) return null;
          if (w.status === "unchanged") {
            toast(status === "met" ? "That goal is already closed as met." : "That goal is already set aside.", { tone: "info" });
            return true as const;
          }
          // Undo opens it again as it was (active or paused), from the revision this close made; a note it closed with was
          // its last review, so the review before it comes back too (that week's look-back is due again, as it was).
          const was = w.before?.status === "paused" ? "paused" : "active";
          const before = w.before;
          const reviewed = !!before && (before.last_review_at !== w.goal.last_review_at || before.review_note !== w.goal.review_note);
          const undone = () => toast("Undone: the goal is open again", { tone: "info" });
          toast(status === "met" ? `Closed as met: ${goal.title}` : `Set aside: ${goal.title}`, {
            tone: "ok",
            undo: () =>
              void goalWrite(
                { action: "goal.update", id: w.goal.id, revision: w.goal.revision, patch: { status: was } },
                {
                  after: (x) =>
                    reviewed && before
                      ? void goalWrite({ action: "goal.review", id: w.goal.id, revision: x.saved.revision, back: { at: before.last_review_at, note: before.review_note } }, { after: undone })
                      : undone(),
                }
              ),
          });
          return true as const;
        },
        opts
      );
      return !!r;
    },
    [goalWrite, toast, write]
  );

  // ── check-ins: always the signed-in adult's own ──

  /** saveCheckin's toast, with its Undo: after the save, or after Try again. */
  const checkinSaved = useCallback(
    (r: Answer) => {
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

  const saveCheckin = useCallback(
    async (answer: ProtectedAnswer, opts: { night?: string; note?: string | null } & Then<SleepCheckin> = {}) => {
      tick();
      const body = {
        action: "checkin.save",
        protected: answer,
        client_id: `checkin-${crypto.randomUUID()}`,
        ...(opts.night ? { night: opts.night } : {}),
        // Left out (one tap on Today), the note already there stays.
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      };
      return write(body, checkinSaved, { done: opts.done });
    },
    [checkinSaved, write]
  );

  /** deleteCheckin's toast, with its Undo: after the removal, or after Try again. */
  const checkinRemoved = useCallback(
    (c: SleepCheckin) => {
      // Undo brings that one back exactly as it was: the answer, the note and the night's other answers.
      toast("Check-in removed", { tone: "info", undo: () => void post({ action: "checkin.restore", id: c.id }) });
      return true;
    },
    [post, toast]
  );

  const deleteCheckin = useCallback(
    async (c: SleepCheckin, opts: Then<boolean> = {}) => !!(await write({ action: "checkin.delete", id: c.id }, () => checkinRemoved(c), { done: opts.done })),
    [checkinRemoved, write]
  );

  const saveCheckinExtras = useSaveCheckinExtras({ checkins: adult ? (data.checkins ?? []) : null, me, post, write, toast });
  const { answerCheckin, answerExtras } = useCardAnswers({ checkins: adult ? (data.checkins ?? []) : null, me, post, write, now, tz });

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
      leaveSheet: (from: SleepSheet, next: SleepSheet | null = null) => setSheet((cur) => (cur === from ? next : cur)),
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
      askHandoff,
      acceptHandoff,
      asleepInArms,
      undoTakeOver,
      savePlan,
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
      answerCheckin,
      answerExtras,
      goalCall: (body: Record<string, unknown>, opts: Then<GoalSave> = {}) => goalWrite(body, opts),
    }),
    [
      acceptHandoff,
      adult,
      answerCheckin,
      answerExtras,
      goalWrite,
      askHandoff,
      asleepInArms,
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
      saveCheckinExtras,
      savePlan,
      sheet,
      shift,
      startShift,
      startTry,
      suggestion,
      today,
      toggleStep,
      undoTakeOver,
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
  write: WriteFn;
  toast: (text: string, opts?: Partial<{ tone: "ok" | "info" | "error"; undo: () => void }>) => number;
}) {
  const { checkins, me, post, write, toast } = o;
  /** Its toast, with its Undo: after the save, or after Try again. */
  const saved = useCallback(
    (night: string, mine: SleepCheckin, extras: CheckinExtras, said: string) => (r: Answer) => {
      const w = r?.result as CheckinResult | undefined;
      if (!w) return null;
      const back = Object.fromEntries(EXTRA_KEYS.filter((k) => k in extras).map((k) => [k, mine[k] ?? null]));
      toast(said, {
        tone: "ok",
        undo: () => void post({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...back }).then((x) => x && toast("Undone", { tone: "info" })),
      });
      return w.checkin;
    },
    [post, toast]
  );
  return useCallback(
    async (night: string, extras: CheckinExtras, said: string) => {
      const mine = checkins?.find((c) => c.member === me && c.night === night) ?? null;
      if (!mine) return null;
      tick();
      return write({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...extras }, saved(night, mine, extras, said));
    },
    [checkins, me, saved, write]
  );
}

/**
 * The Last night card's answers, saved as Today's card always has (the
 * adult's own check-in, then the night's other answers on it), with no
 * toast: at 320 × 568 a toast sits on the next question's chips. The card
 * shows the receipt and its Undo, which puts back what was there (deletes a
 * new check-in, or puts back the answer or extras it replaced).
 */
function useCardAnswers(o: {
  checkins: SleepCheckin[] | null;
  me: string;
  post: (body: Record<string, unknown>, opts?: { quiet?: boolean }) => Promise<Answer | null>;
  write: WriteFn;
  now: () => Date;
  tz: string;
}) {
  const { checkins, me, post, write, now, tz } = o;
  /** answerCheckin's receipt, with its Undo: after the save, or after Try again. */
  const checkinReceipt = useCallback(
    (opts: { note?: string | null }) => (r: Answer): CardReceipt | null => {
      const w = r?.result as CheckinResult | undefined;
      if (!w) return null;
      const c = w.checkin;
      const before = w.before;
      const undo =
        w.status === "created"
          ? async () => !!(await post({ action: "checkin.delete", id: c.id }))
          : w.status === "updated" && before
            ? async () => !!(await post({ action: "checkin.save", night: before.night, protected: before.protected, note: before.note, client_id: `checkin-${crypto.randomUUID()}` }))
            : null;
      // The card is about last night already; any other night is named. One short line, so it never pushes the next question down.
      const when = nightWords(c.night, now(), tz);
      const noteOnly = w.status === "updated" && before?.protected === c.protected && before.note !== c.note;
      const head = noteOnly ? "Note saved" : `Checked in${when === "last night" ? "" : ` for ${when}`}: ${PROTECTED_LABEL[c.protected].toLowerCase()}${opts.note ? ", with a note" : ""}`;
      return { said: head, undo };
    },
    [now, post, tz]
  );
  const answerCheckin = useCallback(
    async (answer: ProtectedAnswer, night: string, opts: { note?: string | null } & Then<CardReceipt> = {}): Promise<CardReceipt | null> => {
      tick();
      // Left out (one tap on the card), the note already there stays; the Add a note sheet sends its note.
      return write({ action: "checkin.save", protected: answer, night, client_id: `checkin-${crypto.randomUUID()}`, ...(opts.note !== undefined ? { note: opts.note } : {}) }, checkinReceipt(opts), { done: opts.done });
    },
    [checkinReceipt, write]
  );
  /** answerExtras' receipt, with its Undo: after the save, or after Try again. */
  const extrasReceipt = useCallback(
    (night: string, mine: SleepCheckin, extras: CheckinExtras, said: string) => (r: Answer): CardReceipt | null => {
      if (!(r?.result as CheckinResult | undefined)) return null;
      const back = Object.fromEntries(EXTRA_KEYS.filter((k) => k in extras).map((k) => [k, mine[k] ?? null]));
      return { said, undo: async () => !!(await post({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...back })) };
    },
    [post]
  );
  const answerExtras = useCallback(
    async (night: string, extras: CheckinExtras, said: string, opts: Then<CardReceipt> = {}): Promise<CardReceipt | null> => {
      const mine = checkins?.find((c) => c.member === me && c.night === night) ?? null;
      if (!mine) return null;
      tick();
      return write({ action: "checkin.save", night, protected: mine.protected, client_id: `checkin-${crypto.randomUUID()}`, ...extras }, extrasReceipt(night, mine, extras, said), { done: opts.done });
    },
    [checkins, extrasReceipt, me, write]
  );
  return { answerCheckin, answerExtras };
}

/**
 * A handoff toast's tail: " · next handoff 4:10 AM", or, moved off the
 * next holder's protected window, " · next handoff 6:30 AM, after Sam's
 * protected sleep (1:30–6:30 AM)" (or "none planned: …").
 */
function nextHandoffToast(w: Pick<ShiftResult, "shift" | "handoffWhy">, me: string, name: (email: string) => string, tz: string): string {
  const why = w.handoffWhy;
  if (why) return ` · next handoff ${why.planned_at ? `${formatTime(why.planned_at, tz)}, ` : ""}${handoffWhyWords(why, why.member === me ? "your" : name(why.member), tz)}`;
  return w.shift.handoff_at ? ` · next handoff ${formatTime(w.shift.handoff_at, tz)}` : "";
}

/** Today against the plan, in a phone's words: the try day runs noon to noon, so at 7:30 AM it's "since last night", not "tonight". */
function todayOnPhone(plan: SleepPlan, tries: readonly BassinetTry[], now: Date, tz: string, fromCheckins = 0): PlanToday {
  return { ...planToday(plan, tries, now, tz, { fromCheckins }), label: tryDayNowLabel(now, tz) };
}

function nthOf(t: BassinetTry, tries: BassinetTry[], tz: string, now: Date): string {
  const all = tries.some((x) => x.id === t.id) ? tries : [t, ...tries];
  const n = numberTries(all, tz).get(t.id);
  return n ? `try ${n.n} ${tryWhenLabel(t.started_at, now, tz)}${n.retry ? ", a retry" : ""}` : "";
}

/** People who can hold her or lay her down: everyone in the family but photos-only guests. */
export function usePeople(): Member[] {
  const { state } = useMaple();
  return useMemo(() => (state?.members ?? []).filter((m) => m.role !== "photos"), [state?.members]);
}

/**
 * Who's next by default: the person asked or named for it, else the other
 * parent (an owner or member). Never the signed-in person, and never the
 * one holding her (the turn's holder, or the signed-in person with no turn).
 */
export function partnerOf(sh: Pick<HoldingShift, "holder" | "next_holder" | "asked_to"> | null, people: Member[], me: string): Member | null {
  const holder = sh?.holder ?? me;
  const fits = (p: Member) => p.email !== me && p.email !== holder;
  for (const named of [sh?.asked_to, sh?.next_holder]) {
    const p = named ? people.find((x) => x.email === named) : undefined;
    if (p && fits(p)) return p;
  }
  return people.find((p) => fits(p) && (p.role === "owner" || p.role === "member") && p.email !== "admin") ?? null;
}

/**
 * The running sleep a bassinet try sits on: Today shows it once, as the
 * try's card ("one sleep, one card"), so the sleep's own timer card steps
 * aside while the try runs (the dock's Woke up still stops it). Null with no
 * running try, or outside a SleepProvider.
 */
export function useTrySleepId(): number | null {
  const s = useSleepMaybe();
  return s?.running?.sleep_entry_id ?? null;
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
      // The tap (or the Lantern's hold) that stopped her sleep brought this sheet in under the thumb: a second tap there waits.
      noteTap();
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

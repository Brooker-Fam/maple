"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AT_BREAST_WORDS, feedingPlanOf, feedPlanNow, PLAN_LATE_TOP_UP_MS, type FeedingPlan, type FeedPlanNow, type NurseStep, type PlanFeedView } from "@/lib/maple/feeding-plan";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { Side, StartWith } from "@/lib/maple/types";
import { feedTargetOf, type FeedTarget } from "@/lib/maple/units";
import { useBabyWords } from "../familyWords";
import { useMaple, useNow } from "../useMaple";
import { missedItems, namedAt, nursedOnly, nursingOf, stepRows, type MissedItem, type OneTapLog, type RowWords, type StepAction, type StepRow } from "./nextFeed";

/**
 * The feeding plan as Today reads it, now, for every part of Today that acts on
 * it: the Next feed card, the dock and the running timer cards, so they all
 * agree on which feed it is and what its next step is. One computation
 * (feedPlanNow) of the plan against the log, with this phone's own memory:
 *
 * - a pick ("Do … instead", the card's Other feed): kept in this tab for the
 *   plan's turn it was picked in, so a new turn (a feed logged, the night)
 *   drops it;
 * - a finished feed's unlogged steps set aside (Got it), by that feed's start;
 * - a step said to be finished as it is (a row's `close`, "She's done", "Not
 *   needed"), by the feed's start and the step: from then on it reads as done
 *   on this phone, and the next step's turn comes.
 *
 * The pick is sessionStorage (this tab); what's set aside is localStorage, so
 * a Home Screen app closed overnight and opened again still has it, and it's
 * cleared a day after the feed it's for. Either falls back to this page's
 * memory when storage is blocked, and every reader updates at once when it
 * changes.
 *
 * What the dock takes from it: whether the next step is nursing (only then does
 * it outline the next side, the plan's own when that nursing is on one side
 * only, as Last fed does); with a pick on this phone, the start the card's
 * own Start would make (the picked feed and its nipple shield), while the next
 * step is that nursing (without a pick a dock start names no plan feed: the log
 * decides which it was); and the plan's bottle when its current step is one
 * (the underway feed's next step, a top-up or milk at the breast still owed
 * under 90 minutes after its nursing, the night's bottle before its pump, a
 * feed that starts with a bottle, formula to finish a bottle feed left short),
 * as the form's preset the card's own button opens.
 */

/** A step's row as the card shows it. `secondary` and `close` come from the view model (nextFeed.ts) where it has them. */
export type PlanRow = StepRow & {
  /** A small second action beside the row (milk at the breast still to log once the nursing is over). */
  secondary?: StepAction | null;
  /** The words of a quiet way to say the step is finished as it is ("She's done"). */
  close?: string | null;
};

// ── This phone's memory ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60_000;
const memory = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** "tab": this tab's (sessionStorage); "phone": this phone's, across closing the app (localStorage). */
type Keep = "tab" | "phone";
const store = (keep: Keep): Storage => (keep === "tab" ? window.sessionStorage : window.localStorage);

function memoryRead(keep: Keep, key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return store(keep).getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function memoryWrite(keep: Keep, key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) store(keep).removeItem(key);
    else store(keep).setItem(key, value);
  } catch {
    // Storage blocked (a private window): this page's memory carries it.
  }
  version++;
  for (const l of listeners) l();
}

/** What this phone set aside (Got it, She's done, Not needed) for a feed that began over a day ago: gone. */
const SET_ASIDE = /^maple-plan-(?:missed|close):\d+:(\d+)(?::|$)/;
function pruneSetAside(nowMs: number): void {
  if (typeof window === "undefined") return;
  const old = (key: string) => {
    const m = SET_ASIDE.exec(key);
    return !!m && nowMs - Number(m[1]) > DAY_MS;
  };
  for (const key of [...memory.keys()]) if (old(key)) memory.delete(key);
  try {
    const ls = window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && old(k)) keys.push(k);
    }
    for (const k of keys) ls.removeItem(k);
  } catch {
    // Storage blocked: nothing kept there to clear.
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => version;
const serverSnapshot = () => 0;

/** "Do … instead", for the plan's turn it was picked in (`turn`). */
type Pick = { turn: string; id: string };
const pickKey = (family: number) => `maple-plan-pick:${family}`;
function readPick(family: number): Pick | null {
  const raw = memoryRead("tab", pickKey(family));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pick> | null;
    return typeof p?.turn === "string" && typeof p.id === "string" ? { turn: p.turn, id: p.id } : null;
  } catch {
    return null;
  }
}
/** A finished feed's unlogged steps, set aside on this phone (Got it), by the feed's start. */
const missedKey = (family: number, start: number) => `maple-plan-missed:${family}:${start}`;
/** A step closed as it is ("She's done"), by the feed's start and the step. */
const closeKey = (family: number, start: number, step: string) => `maple-plan-close:${family}:${start}:${step}`;

// ── What the plan says now ─────────────────────────────────────────────────

export type PlanBottle = {
  /** The bottle form's preset (amount, milk, how, the plan's feed, the feed it tops up). */
  preset: Record<string, unknown>;
  /**
   * What it is, in a word or two for the dock's tile: "Top-up", "Syringe", "SNS", "Next step" (only the card's own
   * big button), else what it's for: "To finish" (formula to finish, the rest of a bottle), "Night feed" (the night's
   * bottle before its pump), "Not logged" (a finished feed's bottle nobody logged).
   */
  word: string;
  /** Its accessible name ("Log top-up: opens the bottle form"). */
  aria: string;
  /** It's the plan's next step (the card's own big button), not something still owed beside it. */
  primary: boolean;
};

/** What Today takes from the plan's reading now, with this phone's memory (planReading). */
export type PlanReading = {
  /** The focus's steps (closed ones read as done). */
  rows: PlanRow[];
  /** The next physical step's row and its action: the card's big button. */
  primary: { row: PlanRow; action: StepAction } | null;
  /** A finished feed's steps nobody logged (minus those set aside here). */
  missed: MissedItem[];
  /** That feed's name in words, its first nursing or first bottle ("2:22 AM feed"), never a pump begun before it. */
  missedName: number | null;
  /** The next step is nursing (the card's Start): the dock outlines the next side only then. */
  nurseNext: boolean;
  /** That nursing is on one side only ("left only, pump the right"): the side the dock and Last fed outline, else null. */
  nurseSide: Side | null;
  /** What the dock's nursing start carries: the picked plan feed and its nipple shield, with a pick on this phone; else null. */
  startWith: StartWith | null;
  /** The plan's bottle now, as the form's preset, or null. */
  bottle: PlanBottle | null;
};

export type PlanNow = PlanReading & {
  plan: FeedingPlan;
  target: FeedTarget | null;
  tz: string;
  family: number;
  /** The clock it was read at (Today's 20-second tick). */
  now: Date;
  /** The plan's own turn, without this phone's pick. */
  base: FeedPlanNow;
  /** With this phone's pick, when one applies. */
  fp: FeedPlanNow;
  /** The plan feed picked on this phone for this turn (the card shows it instead), or null. */
  chosen: string | null;
  /** The finished feed the missed line is for: its start (what this phone's memory of it goes by). */
  missedStart: number | null;
  /** Show another plan feed instead (null: back to the plan's turn), on this phone. */
  pick: (id: string | null) => void;
  /** Set a finished feed's unlogged steps aside on this phone. */
  setMissedAside: () => void;
  /** Say a step of the focus is finished as it is, on this phone. */
  closeRow: (key: string) => void;
};

/** A bottle-ish action as the bottle form's preset (a one-tap log or the two milk choices become the form, milk left to say). */
export function actionPreset(a: StepAction | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  if (a.kind === "form") return a.sheet === "feed" ? a.preset : null;
  if (a.kind === "log") return { ...a.log.data, ...(a.log.started_at ? { started_at: a.log.started_at } : {}) };
  if (a.kind === "choose") {
    const o = a.options[0];
    if (!o) return null;
    return { ...o.data, milk: null, ...(o.started_at ? { started_at: o.started_at } : {}) };
  }
  return null;
}

/**
 * A feed's part (a top-up, milk at the breast) as its form opens it: with the feed it's part of named as the card
 * names it (`feed_at`, its first nursing or bottle), so the form never calls one feed by another time (a pause or a
 * re-latch makes the run it tops up begin later). Any other preset as it is.
 */
export function withFeedAt(preset: Record<string, unknown>, at: number | null): Record<string, unknown> {
  const part = typeof preset.top_up_of === "number" || preset.via === "syringe" || preset.via === "sns";
  return part && at !== null ? { ...preset, feed_at: new Date(at).toISOString() } : preset;
}

const actionAria = (a: StepAction): string => (a.kind === "form" ? a.aria : a.kind === "log" ? a.log.aria : a.kind === "choose" ? a.prompt.replace(/:$/, "") : "");

/**
 * The dock tile's word for a plan bottle, short enough for the tile's one line: milk at the breast by how it goes in,
 * a top-up, the rest of a bottle ("To finish"), else `own` (the card's next step, or whose bottle it is).
 */
function bottleWord(a: StepAction, preset: Record<string, unknown>, own: string): string {
  const via = preset.via;
  if (via === "syringe" || via === "sns") return AT_BREAST_WORDS[via].name;
  if (typeof preset.top_up_of === "number") return "Top-up";
  return a.kind === "form" && /^Log (?:formula to finish|the rest of)/.test(a.label) ? "To finish" : own;
}

/**
 * The plan's bottle now: the first step (or its secondary) whose action is a bottle, else a top-up, milk at the
 * breast or the rest of a bottle the feed still owes under 90 minutes after its nursing, or after its last part when
 * it had none (the night's bottle feed, its formula to finish): the underway feed's, then the finished one's. "Next
 * step" is only for the card's own big button; anything else says what it's for.
 */
function planBottle(fp: FeedPlanNow, rows: readonly PlanRow[], missed: readonly MissedItem[], nowMs: number): PlanBottle | null {
  const first = rows.find((r) => r.action)?.action ?? null;
  const focusAt = namedAt(fp.focus);
  const focusWord = fp.focus.night ? "Night feed" : "Plan feed";
  for (const r of rows) {
    for (const a of [r.action, r.secondary]) {
      const preset = actionPreset(a);
      if (!a || !preset) continue;
      const primary = a === first;
      return { preset: withFeedAt(preset, focusAt), word: bottleWord(a, preset, primary ? "Next step" : focusWord), aria: actionAria(a), primary };
    }
  }
  const owed = (view: PlanFeedView, items: readonly MissedItem[], own: string) => {
    if (nursedOnly(view)) return null;
    // From the end of her nursing (none while she's on), or, for a feed with no nursing (a bottle feed), its last part.
    const end = view.group?.run ? nursingOf(view).end : view.lastAt !== null ? new Date(view.lastAt).toISOString() : null;
    if (!end || nowMs - Date.parse(end) > PLAN_LATE_TOP_UP_MS) return null;
    for (const m of items) {
      const preset = actionPreset(m.fix);
      if (m.fix && preset) return { preset: withFeedAt(preset, namedAt(view)), word: bottleWord(m.fix, preset, own), aria: actionAria(m.fix), primary: false };
    }
    return null;
  };
  // The feed underway, its nursing over: what it still owes beside its next step (a top-up after the pump).
  if (fp.focus.state === "underway" && fp.focus.group?.run) {
    const steps = fp.focus.steps.filter((s) => s.status === "todo" || s.milkMissing);
    const items = missedItems({ ...fp, missed: { view: fp.focus, steps } }).filter((m) => !rows.some((r) => r.key === m.key && r.state === "done"));
    const got = owed(fp.focus, items, focusWord);
    if (got) return got;
  }
  if (fp.missed) return owed(fp.missed.view, missed, "Not logged");
  return null;
}

/**
 * What Today takes from the plan read now (the rows, the card's big button, the missed line, the dock's start and
 * Bottle), with this phone's memory: `closed` says whether a step of the feed that began at `start` was set aside
 * here, `missedAside` whether the missed line was (Got it), `choose` the pick ("Do … instead"). Pure: the hook and
 * the checks read it alike.
 */
export function planReading(
  fp: FeedPlanNow,
  o: { now: Date; tz: string; words?: RowWords; closed?: (start: number | null, key: string) => boolean; missedAside?: boolean; choose?: string | null }
): PlanReading {
  const closed = o.closed ?? (() => false);
  const focusStart = fp.focus.start ?? null;
  const missedAt = fp.missed?.view.start ?? null;
  // A closed step reads as done (no action, no second action, no way to close it again; one only if needed, with
  // nothing given, says it wasn't needed), and the next step moves on past it.
  const keys = fp.focus.steps.map((s) => `${fp.focus.feed.id}:${s.i}`);
  const rows: PlanRow[] = stepRows(fp, fp.focus, o.words, new Set(keys.filter((k) => closed(focusStart, k))), o.now);
  const primaryRow = rows.find((r) => r.action) ?? null;
  const primary = primaryRow?.action ? { row: primaryRow, action: primaryRow.action } : null;
  const missed = o.missedAside ? [] : missedItems(fp).filter((m) => !closed(missedAt, m.key));
  const nurse = primary?.action.kind === "nurse" ? primary.action : null;
  // A start from the dock names a plan feed only when this phone picked one ("Do … instead"), as the card's Start
  // does: otherwise the log decides which feed it was (its shield, its milk at the breast, a top-up), since a tag
  // would win over what was logged, and the dock's sides are just "she's on".
  const startWith: StartWith | null = nurse && o.choose ? { ...(nurse.shield ? { shield: true } : {}), plan: fp.focus.feed.id } : null;
  const bottle = planBottle(fp, rows, missed, o.now.getTime());
  const missedName = fp.missed ? (namedAt(fp.missed.view) ?? missedAt) : null;
  return { rows, primary, missed, missedName, nurseNext: !!nurse, nurseSide: nurse?.side ?? null, startWith, bottle };
}

/** The once-a-page clearing of what this phone set aside for feeds over a day old. */
let pruned = false;

/**
 * The plan now, or null with no plan (or nothing to read it against: no baby yet, a photos-only guest). Read at
 * Today's 20-second tick, so the dock's one-second clock doesn't redo it.
 */
export function usePlanNow(): PlanNow | null {
  const { state, summary, volumeBoth } = useMaple();
  const words = useBabyWords();
  const now = useNow(20_000);
  // This phone's memory's version: every reader reads it again when any part of Today changes it.
  const seen = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const settings = state?.baby.settings;
  const plan = useMemo(() => feedingPlanOf(settings), [settings]);
  const target = useMemo(() => feedTargetOf(settings), [settings]);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const family = state?.family?.id ?? 0;
  const entries = state?.entries;
  const shown = !!state?.baby.born_at && state?.me.role !== "photos";

  // What this phone set aside for feeds over a day old goes, once a page (by the app's clock, not the phone's).
  const nowMs = now.getTime();
  useEffect(() => {
    if (pruned || !plan) return;
    pruned = true;
    pruneSetAside(nowMs);
  }, [plan, nowMs]);

  // The plan's own turn, then this phone's pick for that turn (a new turn drops it: a feed logged, the night, a feed going).
  const base = useMemo(() => (shown && plan && entries ? feedPlanNow(plan, entries, now, { tz, target }) : null), [shown, plan, entries, now, tz, target]);
  const turn = base ? `${base.focus.state}|${base.focus.feed.id}|${summary?.lastFed?.at ?? ""}` : "";
  const choose = useMemo(() => {
    void seen;
    const saved = base ? readPick(family) : null;
    return base && base.focus.state === "upcoming" && saved && saved.turn === turn && saved.id !== base.focus.feed.id && plan?.feeds.some((f) => f.id === saved.id)
      ? saved.id
      : null;
  }, [base, family, turn, plan, seen]);
  const fp = useMemo(
    () => (choose && plan && entries ? feedPlanNow(plan, entries, now, { tz, target, choose }) : base),
    [choose, plan, entries, now, tz, target, base]
  );

  const pick = useCallback((id: string | null) => memoryWrite("tab", pickKey(family), id ? JSON.stringify({ turn, id } satisfies Pick) : null), [family, turn]);
  const missedAt = fp?.missed?.view.start ?? null;
  const setMissedAside = useCallback(() => {
    if (missedAt === null) return;
    pruneSetAside(nowMs);
    memoryWrite("phone", missedKey(family, missedAt), "1");
  }, [family, missedAt, nowMs]);
  const focusStart = fp?.focus.start ?? null;
  const closeRow = useCallback(
    (key: string) => {
      if (focusStart === null) return;
      pruneSetAside(nowMs);
      memoryWrite("phone", closeKey(family, focusStart, key), "1");
    },
    [family, focusStart, nowMs]
  );

  // The rows, the missed line and what the dock takes, read again when the plan's reading or this phone's memory changes.
  const derived = useMemo(() => {
    void seen;
    void volumeBoth; // the rows' words say amounts, both ways with this phone's switch on
    if (!fp) return null;
    return planReading(fp, {
      now,
      tz,
      words: { Hes: words.Hes },
      closed: (start, key) => start !== null && memoryRead("phone", closeKey(family, start, key)) === "1",
      missedAside: missedAt !== null && memoryRead("phone", missedKey(family, missedAt)) === "1",
      choose,
    });
  }, [fp, family, missedAt, now, tz, seen, words.Hes, choose, volumeBoth]);

  if (!plan || !fp || !base || !derived) return null;
  return { plan, target, tz, family, now, base, fp, chosen: choose, ...derived, missedStart: missedAt, pick, setMissedAside, closeRow };
}

/** Log a bottle in one tap from the plan (milk at the breast, a top-up), with its toast ("20 ml of formula in the SNS · 9:42 AM"). */
export function usePlanLog(): (l: OneTapLog) => Promise<unknown> {
  const { log, now, state } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  return useCallback(
    (l: OneTapLog) => log({ kind: "feed", ...(l.started_at ? { started_at: l.started_at } : {}), data: l.data }, { toast: `${l.toast} · ${formatTime(l.started_at ?? now(), tz)}` }),
    [log, now, tz]
  );
}

/** The nursing step of a plan feed view's steps, with its index (its row's key is `${feed id}:${index}`). */
export function nurseStepOf(p: PlanNow): { index: number; step: NurseStep } | null {
  const i = p.fp.focus.steps.findIndex((s) => s.step.do === "nurse");
  return i >= 0 ? { index: i, step: p.fp.focus.steps[i].step as NurseStep } : null;
}

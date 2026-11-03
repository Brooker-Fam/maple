"use client";

import { useEffect, useRef, useState } from "react";
import { goalStartKey, lastNightKey, nightWords, seesCheckins, windowOn, windowOnNight } from "@/lib/maple/sleep/goals";
import { CHECKIN_NOTE_MAX, PROTECTED_ANSWERS, type ProtectedAnswer, type RosterWindow, type SleepCheckin, type SleepGoal } from "@/lib/maple/sleep/types";
import { checkinQuestion, dateWords, PROTECTED_LABEL, windowTimes } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import type { Role } from "@/lib/maple/types";
import { ContextNote, Label } from "../sheets/parts";
import { Button, cx, Sheet, TextArea, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useSleep, useSleepMaybe, type CardReceipt } from "./useSleep";

/**
 * The adults' morning check-in: one question about their own protected
 * sleep last night ("Did you get your 10 PM–2 AM sleep?": yes, partly, not
 * this time) and an optional note, saved for the signed-in adult only.
 * Today's Last night card (LastNight.tsx) asks it the morning after, only of
 * someone the night's roster (or a protected-window target) names, and only
 * for a night the goal was set by; nothing here sends a notification. Never
 * hours slept, mood or anyone's health. The question never says "hold": a
 * holding turn is someone holding the baby awake.
 */

/** From this local hour the morning after (and once their window that night is over), Today asks how it went. */
export const MORNING_HOUR = 5;

export type CheckinDue = {
  /** The night it's about (the evening it began). */
  night: string;
  /** Their windows on that night's roster (none for a protected-window target without a roster). */
  windows: RosterWindow[];
  goals: SleepGoal[];
};

/**
 * Whether Today asks this adult about last night: an owner or member, with
 * an active goal set by that night that has a window for them on that
 * night's roster, or a protected-window target for them and no window of
 * theirs on the roster at all; from MORNING_HOUR and once their windows that
 * night are over; and only until they've checked in for it. A goal set this
 * morning never asks about the night before it.
 */
export function checkinDue(o: { goals: readonly SleepGoal[]; checkins: readonly SleepCheckin[] | null; me: string; role: Role; now: Date; tz: string }): CheckinDue | null {
  if (!seesCheckins(o.role) || !o.checkins || !o.me) return null;
  const night = lastNightKey(o.now, o.tz);
  if (o.checkins.some((c) => c.member === o.me && c.night === night)) return null;
  const goals: SleepGoal[] = [];
  const windows: RosterWindow[] = [];
  for (const g of o.goals) {
    if (g.status !== "active" || goalStartKey(g, o.tz) > night) continue;
    const mine = g.roster.filter((w) => w.member === o.me);
    const on = mine.filter((w) => windowOnNight(w, night));
    const target = g.targets.some((t) => t.kind === "protected_window" && t.member === o.me);
    if (!on.length && !(target && !mine.length)) continue;
    goals.push(g);
    windows.push(...on);
  }
  if (!goals.length) return null;
  const over = Math.max(morningOf(o.now, o.tz), ...windows.map((w) => windowOn(w, night, o.tz)[1].getTime()));
  return o.now.getTime() >= over ? { night, windows, goals } : null;
}

/** MORNING_HOUR today, in the family's timezone. */
export function morningOf(now: Date, tz: string): number {
  const today = parseDayKey(dayKey(now, tz));
  return zonedTimeToUtc(today.year, today.month, today.day, MORNING_HOUR, 0, tz).getTime();
}

/** Today's check-in for the signed-in adult, or null (outside a SleepProvider too). */
export function useCheckinDue(): CheckinDue | null {
  const s = useSleepMaybe();
  const { state } = useMaple();
  const now = useNow(60_000);
  if (!s || !state) return null;
  return checkinDue({ goals: s.goals, checkins: s.checkins, me: s.me, role: state.me.role, now, tz: state.baby.timezone ?? DEFAULT_TZ });
}

/** "10:00 PM–2:00 AM and 4:00 AM–6:00 AM": each window once, never broken inside a time. */
export const timesOf = (windows: readonly RosterWindow[]) => [...new Set(windows.map((w) => windowTimes(w).replace(/ /g, " ")))].join(" and ");

/** Their own windows on that night, across the open goals. */
export function myWindows(goals: readonly SleepGoal[], me: string, night: string): RosterWindow[] {
  return goals.filter((g) => g.status === "active" || g.status === "paused").flatMap((g) => g.roster.filter((w) => w.member === me && windowOnNight(w, night)));
}

/** Yes, Partly, Not this time: big, and one tap saves. `question` names the group for a screen reader. */
export function AnswerButtons({ question, onPick, selected, disabled, row }: { question: string; onPick: (a: ProtectedAnswer) => void; selected?: ProtectedAnswer | null; disabled?: boolean; row?: boolean }) {
  return (
    <div role="group" aria-label={question} className={cx("grid gap-2", row ? "grid-cols-3" : "grid-cols-1")}>
      {PROTECTED_ANSWERS.map((a) => (
        <button
          key={a}
          type="button"
          disabled={disabled}
          aria-pressed={selected ? selected === a : undefined}
          onClick={() => onPick(a)}
          className={cx(
            "mp-control flex items-center justify-center rounded-2xl px-2 text-center font-semibold leading-tight transition active:scale-[0.98] disabled:opacity-40",
            row ? "min-h-[48px] text-[15px]" : "min-h-[60px] text-[17px]",
            selected === a ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink"
          )}
        >
          {PROTECTED_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

/**
 * A receipt for Today's Last night card from a sheet it opened (Add a note): the card shows it in its date's place,
 * with its Undo, never as a toast over its next question. False when no card is listening (the sheet toasts instead).
 */
const cardInbox = new Set<(r: CardReceipt) => void>();
export function sendCardReceipt(r: CardReceipt): boolean {
  if (!cardInbox.size) return false;
  for (const fn of cardInbox) fn(r);
  return true;
}
/** The Last night card's side of sendCardReceipt. */
export function useCardReceipts(fn: (r: CardReceipt) => void): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    const on = (r: CardReceipt) => latest.current(r);
    cardInbox.add(on);
    return () => {
      cardInbox.delete(on);
    };
  }, []);
}

/** Every useNightValue on this page hears a change to its key (Today's card and the dock's strip read the same answers). */
const NIGHT_VALUE_EVENT = "maple-night-value";
/** With storage blocked, what this page set, until it reloads. */
const nightValues = new Map<string, string>();

/**
 * A value kept for one night on this phone (in this browser's storage; with
 * storage blocked, until the page reloads), like Not now: undefined until
 * read, so a hidden card never flashes in first. Every hook on the page with
 * the same key sees a change at once.
 */
export function useNightValue(key: string | null): [string | null | undefined, (value: string) => void] {
  const [value, setValue] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!key) return;
    const read = () => {
      try {
        setValue(localStorage.getItem(key) ?? nightValues.get(key) ?? null);
      } catch {
        setValue(nightValues.get(key) ?? null);
      }
    };
    read();
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) read();
    };
    window.addEventListener(NIGHT_VALUE_EVENT, on);
    return () => window.removeEventListener(NIGHT_VALUE_EVENT, on);
  }, [key]);
  const set = (next: string) => {
    setValue(next);
    if (!key) return;
    nightValues.set(key, next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // storage blocked: kept until this page reloads
    }
    window.dispatchEvent(new CustomEvent(NIGHT_VALUE_EVENT, { detail: key }));
  };
  return [value, set];
}

// ── the sheet ────────────────────────────────────────────────────────────

/**
 * The signed-in adult's own check-in for one night (last night unless
 * given): the note first (optional), then one tap on an answer saves both.
 * An answer already saved shows selected; tapping another changes it.
 */
export function CheckinSheet({ night: given, open = true, onClose }: { night?: string; open?: boolean; onClose: () => void }) {
  const { state, now, toast } = useMaple();
  const s = useSleep();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const night = given ?? lastNightKey(t, tz);
  const mine = s.checkins?.find((c) => c.member === s.me && c.night === night) ?? null;
  const [note, setNote] = useState(mine?.note ?? "");
  const windows = myWindows(s.goals, s.me, night);
  const question = checkinQuestion(windows);
  const when = nightWords(night, t, tz);
  // Opened from Today's Last night card: its receipt and Undo show in the card (a toast at 320px would cover its next question).
  const fromCard = s.sheet?.kind === "checkin" && !!s.sheet.card;
  const pick = async (a: ProtectedAnswer) => {
    if (fromCard) {
      const r = await s.answerCheckin(a, night, { note: note.trim() || null });
      if (!r) return;
      const undo = r.undo;
      if (!sendCardReceipt(r)) toast(r.said, { tone: "ok", ...(undo ? { undo: () => void undo().then((x) => x && toast("Undone", { tone: "info" })) } : {}) });
      onClose();
      return;
    }
    const saved = await s.saveCheckin(a, { night, note: note.trim() || null });
    if (saved) onClose();
  };
  const remove = async () => {
    if (mine && (await s.deleteCheckin(mine))) onClose();
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      dirty={(note.trim() || null) !== (mine?.note ?? null)}
      title={when === "last night" ? "How did last night go?" : `How did ${when} go?`}
      subtitle={`${when.charAt(0).toUpperCase()}${when.slice(1)} · ${dateWords(night, dayKey(t, tz))}${windows.length ? ` · your window ${timesOf(windows)}` : ""}`}
    >
      <div className="space-y-5">
        <div>
          <Label optional>Note</Label>
          <TextArea ariaLabel="Note" maxLength={CHECKIN_NOTE_MAX} value={note} onChange={setNote} placeholder="About the night, like “up once at 3 for a feed”" />
        </div>
        <section aria-labelledby="checkin-question" className="space-y-3">
          <h3 id="checkin-question" className={cx(tone.heading, "text-[17px] leading-snug")}>
            {question}
          </h3>
          <AnswerButtons question={question} selected={mine?.protected ?? null} disabled={s.busy} onPick={(a) => void pick(a)} />
          {mine && (
            <p className={cx(tone.muted, "text-[14px]")}>
              Saved: {PROTECTED_LABEL[mine.protected].toLowerCase()}. Tap an answer to change it or to save the note.
            </p>
          )}
        </section>
        {mine && (
          <Button variant="ghost" size="sm" disabled={s.busy} onClick={() => void remove()}>
            Remove my check-in
          </Button>
        )}
        <ContextNote>Just this answer and the note, about your own sleep. The family&apos;s owners and members see check-ins; view-only guests never do.</ContextNote>
      </div>
    </Sheet>
  );
}

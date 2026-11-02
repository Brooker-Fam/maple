"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { goalStartKey, lastNightKey, nightWords, seesCheckins, windowOn, windowOnNight } from "@/lib/maple/sleep/goals";
import { CHECKIN_NOTE_MAX, PROTECTED_ANSWERS, type ProtectedAnswer, type RosterWindow, type SleepCheckin, type SleepGoal } from "@/lib/maple/sleep/types";
import { CHECKIN_QUESTION, dateWords, PROTECTED_LABEL, windowTimes } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import type { Role } from "@/lib/maple/types";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { ContextNote, Label } from "../sheets/parts";
import { Button, cx, Sheet, TextArea, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useSleep, useSleepMaybe } from "./useSleep";

/**
 * The adults' morning check-in: one question about their own protected
 * window last night (yes, partly, not this time) and an optional note,
 * saved for the signed-in adult only. Today asks the morning after, only
 * someone the night's roster (or a protected-window target) names, until
 * they answer or tap Not now; nothing here sends a notification. Never
 * hours slept, mood or anyone's health.
 */

/** From this local hour the morning after (and once their window that night is over), Today asks how it went. */
const MORNING_HOUR = 5;

export type CheckinDue = {
  /** The night it's about (the evening it began). */
  night: string;
  /** Their windows on that night's roster (none for a protected-window target without a roster). */
  windows: RosterWindow[];
  goals: SleepGoal[];
};

/**
 * Whether Today asks this adult "How did last night go?": an owner or
 * member, with an active goal set by that night that has a window for them
 * on that night's roster, or a protected-window target for them and no
 * window of theirs on the roster at all; from MORNING_HOUR and once their
 * windows that night are over; and only until they've checked in for it.
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
  const today = parseDayKey(dayKey(o.now, o.tz));
  const morning = zonedTimeToUtc(today.year, today.month, today.day, MORNING_HOUR, 0, o.tz).getTime();
  const over = Math.max(morning, ...windows.map((w) => windowOn(w, night, o.tz)[1].getTime()));
  return o.now.getTime() >= over ? { night, windows, goals } : null;
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
const timesOf = (windows: readonly RosterWindow[]) => [...new Set(windows.map((w) => windowTimes(w).replace(/ /g, "\u00a0")))].join(" and ");

/** Their own windows on that night, across the open goals. */
function myWindows(goals: readonly SleepGoal[], me: string, night: string): RosterWindow[] {
  return goals.filter((g) => g.status === "active" || g.status === "paused").flatMap((g) => g.roster.filter((w) => w.member === me && windowOnNight(w, night)));
}

/** Yes, Partly, Not this time: big, and one tap saves. */
function AnswerButtons({ onPick, selected, disabled, row }: { onPick: (a: ProtectedAnswer) => void; selected?: ProtectedAnswer | null; disabled?: boolean; row?: boolean }) {
  return (
    <div role="group" aria-label={CHECKIN_QUESTION} className={cx("grid gap-2", row ? "grid-cols-3" : "grid-cols-1")}>
      {PROTECTED_ANSWERS.map((a) => (
        <button
          key={a}
          type="button"
          disabled={disabled}
          aria-pressed={selected ? selected === a : undefined}
          onClick={() => onPick(a)}
          className={cx(
            "mp-control flex items-center justify-center rounded-2xl px-2 text-center font-semibold leading-tight transition active:scale-[0.98] disabled:opacity-40",
            row ? "min-h-[52px] text-[15px]" : "min-h-[60px] text-[17px]",
            selected === a ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink"
          )}
        >
          {PROTECTED_LABEL[a]}
        </button>
      ))}
    </div>
  );
}

// ── Today's card ─────────────────────────────────────────────────────────

const hiddenKey = (family: number, me: string) => `maple-sleep-checkin-hidden:${family}:${me}`;

/**
 * Not now: that night's card stays hidden on this phone (in this browser's
 * storage; with storage blocked, until the page reloads). Undefined until
 * read, so a hidden card never flashes in first.
 */
function useHiddenNight(key: string | null): [string | null | undefined, (night: string) => void] {
  const [hidden, setHidden] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!key) return;
    try {
      setHidden(localStorage.getItem(key));
    } catch {
      setHidden(null);
    }
  }, [key]);
  const hide = (night: string) => {
    setHidden(night);
    if (!key) return;
    try {
      localStorage.setItem(key, night);
    } catch {
      // storage blocked: hidden until this page reloads
    }
  };
  return [hidden, hide];
}

/**
 * "How did last night go?" on Today, the morning after, for an adult the
 * night's roster names: one tap on an answer saves (Undo in its toast), Add
 * a note opens the sheet, and Not now hides it until the next night.
 */
export function SleepCheckinCard() {
  const s = useSleepMaybe();
  const { state } = useMaple();
  const due = useCheckinDue();
  const [hidden, hide] = useHiddenNight(state && s?.seesCheckins ? hiddenKey(state.family?.id ?? 1, s.me) : null);
  if (!s || !due || !s.canWrite || hidden === undefined || hidden === due.night) return null;
  const goal = due.goals[0];
  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby="sleep-checkin"
      className={cx(tone.card, "space-y-3 px-4 py-3.5")}
    >
      <div className="flex items-start gap-3">
        <KindBadge icon="moon" color={KIND_COLOR.sleep} size={40} />
        <div className="min-w-0 flex-1">
          <h3 id="sleep-checkin" className={cx(tone.heading, "text-[17px]")}>
            How did last night go?
          </h3>
          <p className={cx(tone.muted, "text-[14px] leading-snug")}>
            {due.windows.length ? `Your protected window, ${timesOf(due.windows)}` : `Your protected sleep, for “${goal.title}”`}
          </p>
        </div>
      </div>
      <p className={cx(tone.label)}>{CHECKIN_QUESTION}</p>
      <AnswerButtons row disabled={s.busy} onPick={(a) => void s.saveCheckin(a, { night: due.night })} />
      <div className="flex flex-wrap gap-x-1">
        <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "checkin", night: due.night })}>
          Add a note
        </Button>
        <Button variant="ghost" size="sm" onClick={() => hide(due.night)}>
          Not now
        </Button>
      </div>
    </motion.section>
  );
}

// ── the sheet ────────────────────────────────────────────────────────────

/**
 * The signed-in adult's own check-in for one night (last night unless
 * given): the note first (optional), then one tap on an answer saves both.
 * An answer already saved shows selected; tapping another changes it.
 */
export function CheckinSheet({ night: given, open = true, onClose }: { night?: string; open?: boolean; onClose: () => void }) {
  const { state, now } = useMaple();
  const s = useSleep();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const night = given ?? lastNightKey(t, tz);
  const mine = s.checkins?.find((c) => c.member === s.me && c.night === night) ?? null;
  const [note, setNote] = useState(mine?.note ?? "");
  const windows = myWindows(s.goals, s.me, night);
  const when = nightWords(night, t, tz);
  const pick = async (a: ProtectedAnswer) => {
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
            {CHECKIN_QUESTION}
          </h3>
          <AnswerButtons selected={mine?.protected ?? null} disabled={s.busy} onPick={(a) => void pick(a)} />
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
        <ContextNote>Just this one answer and the note, about your own window. The family&apos;s owners and members see check-ins; view-only guests never do.</ContextNote>
      </div>
    </Sheet>
  );
}

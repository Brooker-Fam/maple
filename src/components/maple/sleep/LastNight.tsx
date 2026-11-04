"use client";

import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { SLEEP_GUIDES } from "@/lib/maple/guidelines/sleep";
import { sleepByPlace, tryDayKey } from "@/lib/maple/sleep/engine";
import { goalStartKey, lastNightKey, nightAnswers, nightPicture, plannedHandoff, windowOn, windowOnNight, type NightBar, type NightGap, type NightPicture } from "@/lib/maple/sleep/goals";
import { CHECKIN_PLACES, HANDOFF_ANSWERS, UNTIMED_TRIES, type CheckinExtras, type CheckinPlace, type HoldingShift, type ProtectedAnswer, type SleepGoal } from "@/lib/maple/sleep/types";
import { checkinQuestion, dateWords, HANDOFF_LABEL, handoffQuestion, PLACE_LABEL, placeQuestion, shortClock, UNTIMED_QUESTION, untimedLabels } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, formatDuration, formatTime, formatTimeNear, localParts } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import type { Voice } from "@/lib/maple/voice";
import { AskChatButton } from "../chat/AskChat";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { focusNext, useTapGuard } from "../tapCooldown";
import { holdTodayTaps } from "../tapShield";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { AnswerButtons, checkinDue, morningOf, myWindows, useCardReceipts, useNightValue, type CheckinDue } from "./SleepCheckin";
import { LookBackPart, useLookBackDue, type LookBackDue } from "./SleepReview";
import { useSleepMaybe, useTryAfterWake, type CardReceipt } from "./useSleep";

/**
 * Today's Last night card, from 5 AM the morning after, with no
 * notification: the night as a strip from the log (goals.ts nightPicture);
 * a sleep timer left running past something logged later, with "Woke at"
 * that moment (or Still asleep); the adult's own check-in ("Did you get your
 * 10 PM–2 AM sleep?"); the two longest stretches over 90 minutes with
 * nothing logged between two things that were, asked only of whoever was on
 * duty then (its protected window's other adult, or a holding turn's
 * holder; anyone when nobody was), with Not sure first ("Up or feeding" and
 * "Not sure" save nothing and the night stays partly logged; "She slept
 * through" logs a sleep for it; Skip the rest); then the night's other
 * one-tap questions, each once a night, the place prefilled from the log
 * when every sleep has one, folded into one "More about last night" row
 * after noon. Folded with nothing else to show (no receipt, look-back or
 * safe-sleep line), the card is that row alone and stands at the end of Up
 * next instead (LastNightRow), so it no longer pushes her Took it and the
 * plan's Put down under the dock all afternoon and evening; its Answer
 * opens the card again above Up next, on this phone, for that night (the
 * memo's `open`). One thing at a time, so it stays small on a 320 × 568
 * phone, and an answer's one-line receipt (with its Undo, for that night only)
 * shows in the card, never as a toast over the next question; a note from
 * Add a note comes back here too. On a goal's review morning it ends with
 * the week's look-back (SleepReview.tsx). Tell Maple opens the chat with
 * "Last night: " typed (a photo of a paper log is read back before anything
 * saves). Not now hides it for that night on this phone. For owners and
 * members of a family with a sleep plan or goal.
 *
 * useLastNight is the card's one question, shared: the dock's strip carries
 * it in the morning, and a sleep timer's card (or the holding turn's, for a
 * sleep in arms) carries its "Woke at" (LeftRunningAsk).
 */

type Gap = NightGap;
type Bar = NightBar;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const countParts = (c: NightPicture["counts"]) =>
  [c.sleeps ? plural(c.sleeps, "sleep") : "", c.feeds ? plural(c.feeds, "feed") : "", c.diapers ? plural(c.diapers, "diaper") : "", c.other ? plural(c.other, "other entry", "other entries") : ""].filter(Boolean);

/** "2 sleeps, 3 feeds and 1 diaper logged", "Nothing logged". */
function loggedWords(c: NightPicture["counts"]): string {
  const parts = countParts(c);
  if (!parts.length) return "Nothing logged";
  return `${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]} logged`;
}

/** Under the strip, between its ends: "2 sleeps · 3 feeds · 1 diaper", "Nothing logged". */
const countsLine = (c: NightPicture["counts"]) => countParts(c).join(" · ") || "Nothing logged";

/** Each kind's own color; a holding turn (not a kind) in the app's muted ink, dimmed to amber at night like the rest. */
const BAR_COLOR: Record<Bar["kind"], string> = { ...KIND_COLOR, try: KIND_COLOR.sleep, hold: "var(--mp-ink-3)" };

/**
 * The night as one bar: sleeps and feeds where they were logged, other
 * entries as ticks, and the stretch asked about outlined. Each kind's own
 * color by day; at night mp-kind-fill dims them all to the night look's
 * amber, and their shapes (inset sleeps, full-height feeds, ticks, a low
 * band for a holding turn) still tell them apart.
 */
function NightStrip({ pic, tz, ask }: { pic: NightPicture; tz: string; ask: Gap | null }) {
  const span = Math.max(1, pic.to - pic.from);
  const x = (t: number) => `${(((t - pic.from) / span) * 100).toFixed(2)}%`;
  const w = (s: number, e: number) => `max(3px, ${(((e - s) / span) * 100).toFixed(2)}%)`;
  const label = `${loggedWords(pic.counts)} between ${formatTime(pic.from, tz)} and ${formatTime(pic.to, tz)}${pic.gaps.length ? `; nothing logged ${pic.gaps.map((g) => `${formatTimeNear(g.start, g.end, tz)}–${formatTime(g.end, tz)}`).join(" and ")}` : ""}.`;
  return (
    <div>
      <div role="img" aria-label={label} data-night-strip className="relative h-7 overflow-hidden rounded-lg bg-mp-sunken">
        {pic.bars.map((b, i) => (
          <span
            key={i}
            data-bar={b.kind}
            className={cx(
              "mp-kind-fill absolute",
              b.kind === "sleep" || b.kind === "try" ? "top-1 bottom-1 rounded-[5px] opacity-80" : b.kind === "hold" ? "bottom-0 h-1.5 rounded-sm opacity-70" : "top-0 bottom-0 rounded-[2px]"
            )}
            style={{ left: x(b.start), width: w(b.start, b.end), backgroundColor: BAR_COLOR[b.kind] }}
          />
        ))}
        {ask && <span aria-hidden className="absolute top-0 bottom-0 rounded-lg border-2 border-dashed border-mp-accent-fg" style={{ left: x(ask.start), width: w(ask.start, ask.end) }} />}
      </div>
      {/* The strip's ends and the night's counts (all in the strip's label for screen readers). */}
      <div aria-hidden data-night-counts className="mt-1 flex justify-between gap-2 text-[12px] text-mp-ink-3 tabular-nums">
        <span className="shrink-0">{formatTime(pic.from, tz)}</span>
        <span className="min-w-0 truncate">{countsLine(pic.counts)}</span>
        <span className="shrink-0">{pic.toNow ? "now" : formatTime(pic.to, tz)}</span>
      </div>
    </div>
  );
}

/**
 * This phone's answers that save nothing, for one night: Not now, the stretches answered or skipped, a timer said to be
 * still asleep ("sleepId:nextId"), and Answer on the folded card or Up next's row (`open`: the night's optional questions
 * show again after noon; a memo saved before there was `open` reads as folded).
 */
type Memo = { night: string; hidden?: boolean; open?: true; gaps?: number[]; still?: string[] };
const memoKey = (family: number, me: string) => `maple-last-night:${family}:${me}`;
const readMemo = (raw: string | null | undefined, night: string): Memo => {
  try {
    const m = raw ? (JSON.parse(raw) as Memo) : null;
    return m && m.night === night ? m : { night };
  } catch {
    return { night };
  }
};

/** The safe-sleep line for "Somewhere else": the guidance's own words. */
function safeSleepLine(v: Voice): string {
  const pick = (id: string) => SLEEP_GUIDES.find((g) => g.id === id)?.body(v) ?? "";
  return [pick("safe-back"), pick("safe-room")].filter(Boolean).join(" ");
}

/** At most this many stretches with nothing logged are asked about: the longest (a gappy night took 7 taps). */
export const GAPS_ASKED = 2;

/** A stretch's protected window: whose (a member id), its local times, and how much of the stretch it covers. */
export type GapWindow = { member: string; from: string; to: string; share: number };

/** The card's one question now, in order. */
export type NightAsk =
  | { kind: "running"; sleep: Entry; next: Entry }
  | { kind: "checkin"; due: CheckinDue; question: string }
  | { kind: "gap"; gap: Gap; window: GapWindow | null; left: number }
  | { kind: "place"; prefill: CheckinPlace | null }
  | { kind: "untimed"; minutes: number }
  | { kind: "handoff"; at: string };

/** Which question it is (its kind and what it's about), so a new one is known as new. */
const askId = (a: NightAsk | null): string => {
  if (!a) return "";
  switch (a.kind) {
    case "running":
      return `running:${a.sleep.id}:${a.next.id}`;
    case "checkin":
      return `checkin:${a.due.night}`;
    case "gap":
      return `gap:${a.gap.start}`;
    case "place":
      return `place:${a.prefill ?? ""}`;
    case "untimed":
      return `untimed:${a.minutes}`;
    case "handoff":
      return `handoff:${a.at}`;
  }
};

/**
 * Where the baby spent the night, from the log, when every sleep in the
 * strip has a place: the bassinet (or crib), held (in arms), or some of
 * each; nothing for anywhere else, a carrier included (never prefilled as
 * held by someone awake), which is the family's to say.
 */
export function placeFromLog(entries: readonly Entry[], tries: Parameters<typeof sleepByPlace>[1], from: number, to: number, now: number): CheckinPlace | null {
  const r = sleepByPlace(entries, tries, from, to, now);
  if (!r.totalSec) return null;
  let bassinet = 0;
  let held = 0;
  for (const p of r.places) {
    if (p.place === "bassinet" || p.place === "crib") bassinet += p.sec;
    else if (p.place === "arms") held += p.sec;
    else if (p.sec > 0) return null;
  }
  const total = bassinet + held;
  if (bassinet >= (total * 2) / 3) return "bassinet";
  if (held >= (total * 2) / 3) return "held";
  return "mixed";
}

/** The window (of an active goal's roster, that night) covering most of a stretch, if any covers it. */
function gapWindow(goals: readonly SleepGoal[], night: string, gap: Gap, tz: string): GapWindow | null {
  let best: GapWindow | null = null;
  for (const g of goals) {
    if (g.status !== "active") continue;
    for (const w of g.roster) {
      if (!windowOnNight(w, night)) continue;
      const [s, e] = windowOn(w, night, tz).map((d) => d.getTime());
      const share = (Math.min(e, gap.end) - Math.max(s, gap.start)) / Math.max(1, gap.end - gap.start);
      if (share > 0 && (!best || share > best.share)) best = { member: w.member, from: w.from, to: w.to, share };
    }
  }
  return best;
}

/**
 * The questions a card can leave for later: after noon, a half-answered card folds them behind one row (with nothing else
 * on the card, that row stands at the end of Up next instead: LastNightRow).
 */
const OPTIONAL: readonly NightAsk["kind"][] = ["gap", "place", "untimed", "handoff"];

/** The folded card's one row, in the card and as Up next's row (no break inside "last night"). */
const FOLD_WORDS = "More about last\u00a0night, if you'd like.";

/**
 * Who was on duty during a stretch: the holder of a holding turn across most of it, else, when it was mostly someone's
 * protected window, not them (they were asleep in it); null when nothing says (then anyone can answer it).
 */
function onDuty(gap: Gap, w: GapWindow | null, shifts: readonly HoldingShift[], now: number): { member: string } | { notMember: string } | null {
  const span = Math.max(1, gap.end - gap.start);
  const held = shifts
    .filter((x) => !(x as { deleted_at?: unknown }).deleted_at)
    .map((x) => ({ member: x.holder, share: (Math.min(gap.end, x.ended_at ? Date.parse(x.ended_at) : now) - Math.max(gap.start, Date.parse(x.started_at))) / span }))
    .filter((x) => x.share > 0)
    .sort((a, b) => b.share - a.share)[0];
  if (held && held.share >= 0.5) return { member: held.member };
  if (w && w.share >= 0.5) return { notMember: w.member };
  return null;
}

export type LastNight = {
  night: string;
  pic: NightPicture;
  ask: NightAsk | null;
  /**
   * After noon, the night's optional questions (stretches, place, an untimed try, the handoff) wait behind one row, until
   * Answer opens them again on this phone for that night (`unfold`).
   */
  folded: boolean;
  /** Answer on the fold (the card's row, or Up next's): the night's optional questions show again, on this phone, for that night. */
  unfold: () => void;
  /** "Somewhere else" was answered: the card stays for the safe-sleep line. */
  elsewhere: boolean;
  /** Their windows that night, and their check-in for it (Add a note). */
  windows: ReturnType<typeof myWindows>;
  due: CheckinDue | null;
  checkedIn: boolean;
  memo: Memo;
  save: (next: Memo) => void;
  /** "Woke at" the next thing logged: stops the timer then, and asks how a try on it went. */
  wokeAt: (sleep: Entry, next: Entry) => Promise<boolean>;
  /** "Still asleep": that timer's question goes, on this phone, for that night. */
  stillAsleep: (sleep: Entry, next: Entry) => void;
};

/**
 * The Last night card's state and its one question, for the card, the
 * strip and a timer's card: null when the card wouldn't show (not an owner
 * or member, no plan or active goal, before 5 AM, or Not now). `keep`: the
 * card itself, while it holds a receipt or the look-back's second tap, so
 * easing off the only goal (no longer counting) doesn't take them away.
 */
export function useLastNight(o: { keep?: boolean } = {}): LastNight | null {
  const s = useSleepMaybe();
  const m = useMaple();
  const { state } = m;
  const now = useNow(60_000);
  const afterWake = useTryAfterWake();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const night = lastNightKey(now, tz);
  const [raw, setRaw] = useNightValue(state && s?.canWrite ? memoKey(state.family?.id ?? 1, s.me) : null);
  if (!s || !state || !s.canWrite || raw === undefined) return null;
  const active = s.goals.filter((g) => g.status === "active" && goalStartKey(g, tz) <= night);
  if (!s.plan && !active.length && !o.keep) return null;
  if (now.getTime() < morningOf(now, tz)) return null;
  const memo = readMemo(raw, night);
  if (memo.hidden) return null;
  const save = (next: Memo) => setRaw(JSON.stringify(next));

  const pic = nightPicture({ night, entries: state.entries, tries: s.data.tries, shifts: s.data.shifts, tz, now: now.getTime() });
  const due = checkinDue({ goals: s.goals, checkins: s.checkins, me: s.me, role: state.me.role, now, tz });
  const mine = s.checkins?.find((c) => c.member === s.me && c.night === night) ?? null;
  const said = s.checkins ? nightAnswers(s.checkins, night) : null;
  // At most GAPS_ASKED stretches a night, the longest, in the night's order; answered or skipped ones stay answered on this phone
  // (a stretch "She slept through" filled counts as asked, so a shorter one never takes its place).
  const answered = memo.gaps ?? [];
  const budget = Math.max(0, GAPS_ASKED - answered.length);
  // Only whoever was on duty is asked about a stretch (the holder then, or not the adult asleep in their own window), so
  // one answer settles it: nobody is asked about a stretch they slept through.
  const mineToAnswer = (g: Gap) => {
    const d = onDuty(g, gapWindow(active, night, g, tz), s.data.shifts, now.getTime());
    return !d || ("member" in d ? d.member === s.me : d.notMember !== s.me);
  };
  const open = pic.gaps
    .filter((g) => !answered.includes(g.start) && mineToAnswer(g))
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
    .slice(0, budget)
    .sort((a, b) => a.start - b.start);
  const nightsTries = s.data.tries.some((t) => tryDayKey(Date.parse(t.started_at), tz) === night);
  const minutes = active.flatMap((g: SleepGoal) => g.targets.flatMap((t) => (t.kind === "bassinet_nights" ? [t.min_minutes] : [])))[0] ?? null;
  const handoff = mine ? plannedHandoff(active, s.data.shifts, night, tz) : null;
  const running = pic.leftRunning && !(memo.still ?? []).includes(`${pic.leftRunning.sleep.id}:${pic.leftRunning.next.id}`) ? pic.leftRunning : null;

  let ask: NightAsk | null = null;
  if (running) ask = { kind: "running", sleep: running.sleep, next: running.next };
  else if (due) ask = { kind: "checkin", due, question: checkinQuestion(due.windows) };
  else if (open.length) ask = { kind: "gap", gap: open[0], window: gapWindow(active, night, open[0], tz), left: open.length };
  else if (mine && said && !said.place) ask = { kind: "place", prefill: placeFromLog(state.entries, s.data.tries, pic.from, pic.to, now.getTime()) };
  else if (mine && said && !said.untimed && minutes != null && !nightsTries) ask = { kind: "untimed", minutes };
  else if (mine && said && !said.handoff && handoff) ask = { kind: "handoff", at: handoff.at };

  return {
    night,
    pic,
    ask,
    folded: !!ask && OPTIONAL.includes(ask.kind) && localParts(now, tz).hour >= 12 && !memo.open,
    unfold: () => save({ ...memo, open: true }),
    elsewhere: said?.place === "elsewhere",
    windows: myWindows(s.goals, s.me, night),
    due,
    checkedIn: !!mine,
    memo,
    save,
    wokeAt: async (sleep, next) => {
      const done = await m.timerCall({ action: "stop", id: sleep.id, at: next.started_at, expect_updated_at: sleep.updated_at });
      if (done) afterWake(sleep.id, new Date(next.started_at));
      return !!done;
    },
    stillAsleep: (sleep, next) => save({ ...memo, still: [...(memo.still ?? []), `${sleep.id}:${next.id}`] }),
  };
}

/** Where focus goes once an answer takes its button away: the next question, the look-back's, the card's heading, else Right now. */
const AFTER_ANSWER = ["#last-night-ask", "#look-back-move", "#look-back", "#last-night", "#right-now", "#recent"];

/** "A feed was logged at 6:30 AM": what came after a sleep that's still running. */
export const nextWords = (next: Entry, tz: string) => `${next.kind === "feed" ? "A feed" : next.kind === "diaper" ? "A diaper" : "Something"} was logged at ${formatTime(next.started_at, tz)}`;

/** One answer in a two-column grid: big, and a long one wraps inside its button, so a row never spills onto another at 320px. */
function GridAnswer({ children, onClick, disabled, "aria-label": ariaLabel }: { children: ReactNode; onClick: () => void; disabled?: boolean; "aria-label"?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={onClick}
      className="mp-control flex min-h-[44px] items-center justify-center rounded-2xl bg-mp-sunken px-2 py-1 text-center text-[14px] leading-tight font-semibold text-mp-ink transition active:scale-[0.98] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Woke at / Still asleep: two big answers on one row, even at 320px. */
function WokeButtons({ at, onWoke, onStill, busy }: { at: string; onWoke: () => void; onStill: () => void; busy?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <GridAnswer disabled={busy} onClick={onWoke}>
        Woke at {at}
      </GridAnswer>
      <GridAnswer onClick={onStill}>Still asleep</GridAnswer>
    </div>
  );
}

/**
 * "Woke at 6:30 AM?" on a running sleep's own card (a timer left running
 * overnight, or a sleep in arms with a feed logged after it began): one tap
 * stops it then; Still asleep keeps it running and lets it be.
 */
export function WokeAsk({ sleep, next, onWoke, onStill, busy }: { sleep: Entry; next: Entry; onWoke: () => void; onStill: () => void; busy?: boolean }) {
  const { state } = useMaple();
  const v = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  // It comes in above a card's buttons when something's logged (here or on another phone): a tap meant for them waits.
  const guard = useTapGuard(`${sleep.id}:${next.id}`);
  return (
    <div role="group" aria-label={`Did ${v.they} wake at ${formatTime(next.started_at, tz)}?`} data-woke-ask={sleep.id} {...guard.props} className="space-y-2">
      <p className="text-[14px] leading-snug font-medium text-mp-ink">
        {nextWords(next, tz)}. Did {v.they} wake then?
      </p>
      <WokeButtons at={formatTime(next.started_at, tz)} busy={busy} onWoke={onWoke} onStill={onStill} />
    </div>
  );
}

/** A sleep timer's card's ask: the Last night card's "Woke at" when it's about this timer (from 5 AM, for owners and members). */
export function LeftRunningAsk({ entry }: { entry: Entry }) {
  const ln = useLastNight();
  const { timerBusy } = useMaple();
  if (!ln || ln.ask?.kind !== "running" || ln.ask.sleep.id !== entry.id) return null;
  const { sleep, next } = ln.ask;
  return (
    <WokeAsk
      sleep={sleep}
      next={next}
      busy={timerBusy(sleep.id)}
      onWoke={() => void ln.wokeAt(sleep, next).then((ok) => ok && focusNext(...AFTER_ANSWER))}
      onStill={() => {
        ln.stillAsleep(sleep, next);
        focusNext(...AFTER_ANSWER);
      }}
    />
  );
}

/** Scroll Today to the Last night card (its question on screen, above the dock) and put focus on its first answer: the strip's Answer. */
export function showLastNight(): void {
  const card = document.querySelector<HTMLElement>("[data-last-night]");
  if (!card) return;
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  card.querySelector<HTMLElement>("[aria-labelledby='last-night-ask'] button")?.focus({ preventScroll: true });
}

/**
 * The night whose folded card stands as Up next's row (LastNightRow), or null. The card says, since only it knows its
 * receipt and a look-back held for its second tap; it says so in a layout effect, so the row follows before the paint.
 */
let rowNight: string | null = null;
const rowListeners = new Set<() => void>();
const setRowNight = (night: string | null) => {
  if (rowNight === night) return;
  rowNight = night;
  for (const l of rowListeners) l();
};
const subscribeRow = (l: () => void) => {
  rowListeners.add(l);
  return () => {
    rowListeners.delete(l);
  };
};
const useRowNight = () => useSyncExternalStore(subscribeRow, () => rowNight, () => null);

/** The card's one thing to answer: a title and its choices. */
function Ask({ id, title, sub, children }: { id: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h4 id={id} className={cx(tone.heading, "text-[15px] leading-snug")}>
        {title}
      </h4>
      {sub && <p className={cx(tone.muted, "-mt-1 text-[13px] leading-snug")}>{sub}</p>}
      {children}
    </section>
  );
}

const PREFILL_WORDS: Partial<Record<CheckinPlace, { line: string; yes: string }>> = {
  bassinet: { line: "From the log: mostly the bassinet. Right?", yes: "Yes, the bassinet" },
  held: { line: "From the log: mostly in arms. Right?", yes: "Yes, held by someone awake" },
  mixed: { line: "From the log: some bassinet, some in arms. Right?", yes: "Yes, some of each" },
};

export function LastNightCard() {
  const s = useSleepMaybe();
  // An answer's receipt with its Undo, in the card (a toast here would sit on the next question at 320px), for its own
  // night only: the next morning never shows yesterday's receipt, whose Undo would take back yesterday's check-in.
  const [kept, setKept] = useState<(CardReceipt & { night: string }) | null>(null);
  // The weekly look-back, held in the card after Ease off for its second tap (see below).
  const [held, setHeld] = useState<LookBackDue | null>(null);
  const ln = useLastNight({ keep: !!kept || !!held });
  const m = useMaple();
  const { state, timerBusy } = m;
  const v = useVoice();
  const now = useNow(60_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const night0 = ln?.night ?? "";
  const receipt = kept && kept.night === night0 ? kept : null;
  const setReceipt = (r: CardReceipt | null) => setKept(r ? { ...r, night: night0 } : null);
  // A note saved from this card's Add a note sheet: its receipt lands here too.
  useCardReceipts((r) => setKept({ ...r, night: night0 }));
  const [placeOpen, setPlaceOpen] = useState(false);
  // The weekly look-back, on a goal's review day: after the night's questions, at the card's end; held there after Ease off for its second tap.
  const lookDue = useLookBackDue();
  const look = lookDue ?? held;
  // The card's state as it is when an Undo runs (answers since then included).
  const latest = useRef(ln);
  useEffect(() => {
    latest.current = ln;
  });
  // After noon, a half-answered card folds its optional questions behind one row: Answer opens them again, on this phone,
  // for that night (the memo's `open`, which Up next's row reads too).
  const folded = !!ln?.folded;
  // Folded with nothing else to show (no receipt, look-back or safe-sleep line), the card would be that row alone: it
  // stands at the end of Up next instead (LastNightRow), so it doesn't push her Took it and Put down under the dock.
  const rowed = folded && !receipt && !look && !ln?.elsewhere;
  useLayoutEffect(() => {
    if (!rowed) return;
    setRowNight(night0);
    return () => setRowNight(null);
  }, [rowed, night0]);
  const done = !!ln && !ln.ask && !ln.elsewhere && !look;
  // The last answer leaves nothing to ask: the card goes, and its receipt rides one toast instead (nothing left under it),
  // replacing any earlier one of the card's.
  useEffect(() => {
    if (!done || !receipt) return;
    const undo = receipt.undo;
    m.toast(receipt.said, { tone: "ok", group: "last-night", ...(undo ? { undo: () => void undo().then((x) => x && m.toast("Undone", { tone: "info", group: "last-night" })) } : {}) });
    setKept(null);
  }, [done, receipt, m]);
  // Each answer brings its next question in where the last one was (here, or another adult's answer on a poll): the card's
  // buttons wait out a double tap's second half (tapCooldown.ts), so one tap never answers two questions.
  const guard = useTapGuard(ln ? [night0, folded ? "folded" : askId(ln.ask), placeOpen, look ? `look-${look.goal.id}` : ""].join("|") : "");
  // The card going (Not now, its last answer, folding into Up next's row) moves Up next up under the thumb, her Took it
  // where an answer was: taps on the page wait out the cooldown, so a double tap's second half lands on nothing.
  const showing = !!s && !!ln && !!state && !done && !rowed;
  const wasShowing = useRef(showing);
  useEffect(() => {
    if (wasShowing.current && !showing) holdTodayTaps();
    wasShowing.current = showing;
  }, [showing]);
  // (Rendering nothing keeps this card's state: a receipt arriving just after the last answer still reaches its toast.)
  if (!s || !ln || !state || done || rowed) return null;
  const { night, pic } = ln;
  // Folded after noon: the optional question waits behind its row.
  const ask = folded ? null : ln.ask;

  // An answer that takes its own button away: focus goes to what came in its place.
  const moved = () => focusNext(...AFTER_ANSWER);
  const show = (r: CardReceipt | null) => {
    if (r) setReceipt(r);
  };
  /** A saved answer's receipt, and focus on what's next (after Try again too, through `done`). */
  const answered = (r: CardReceipt | null) => {
    show(r);
    if (r) moved();
  };
  /** Stretches answered without saving anything (remembered on this phone); `said` replaces the receipt. */
  const answerGap = (gs: Gap[], said?: string) => {
    ln.save({ ...ln.memo, gaps: [...(ln.memo.gaps ?? []), ...gs.map((g) => g.start)] });
    if (said) setReceipt({ said, undo: null });
    moved();
  };
  const sleptThrough = async (g: Gap) => {
    const saved = await m.log({ kind: "sleep", client_id: `lastnight-${night}-${g.start}`, started_at: new Date(g.start).toISOString(), ended_at: new Date(g.end).toISOString(), data: {} }, { silent: true });
    if (!saved) return;
    ln.save({ ...ln.memo, gaps: [...(ln.memo.gaps ?? []), g.start] });
    // Undo: the sleep goes, and the stretch is asked again.
    const undo = async () => {
      const gone = await m.remove(saved.id, { toast: "Undone" });
      const cur = latest.current;
      if (gone && cur) cur.save({ ...cur.memo, gaps: (cur.memo.gaps ?? []).filter((x) => x !== g.start) });
      return gone;
    };
    setReceipt({ said: `Logged: asleep ${formatTimeNear(g.start, g.end, tz)}–${formatTime(g.end, tz)}`, undo });
    moved();
  };
  const extras = async (x: CheckinExtras, said: string) => answered(await s.answerExtras(night, x, said, { done: answered }));
  const place = (p: CheckinPlace) => extras({ place: p }, `Saved: ${PLACE_LABEL[p].toLowerCase()}`);

  let body: ReactNode = null;
  if (ask?.kind === "running") {
    const { sleep, next } = ask;
    body = (
      <Ask id="last-night-ask" title={`The sleep timer is still running from ${formatTime(sleep.started_at, tz)}`} sub={`${nextWords(next, tz)}.`}>
        <WokeButtons
          at={formatTime(next.started_at, tz)}
          busy={timerBusy(sleep.id)}
          onWoke={() => void ln.wokeAt(sleep, next).then((ok) => ok && moved())}
          onStill={() => {
            ln.stillAsleep(sleep, next);
            moved();
          }}
        />
      </Ask>
    );
  } else if (ask?.kind === "checkin") {
    body = (
      <Ask id="last-night-ask" title={ask.question}>
        <AnswerButtons row question={ask.question} disabled={s.busy} onPick={(a: ProtectedAnswer) => void s.answerCheckin(a, ask.due.night, { done: answered }).then(answered)} />
      </Ask>
    );
  } else if (ask?.kind === "gap") {
    const { gap, window: w, left } = ask;
    // Whose protected window it was (one short line at 320px): someone asleep then may not know, and Not sure is right.
    const whose = w ? `${w.share >= 0.9 ? "" : w.share >= 0.5 ? "mostly " : "partly "}${w.member === s.me ? "your" : `${m.memberName(w.member)}'s`} window` : null;
    const dur = formatDuration((gap.end - gap.start) / 1000);
    const range = w ? `${shortClock(w.from)}–${shortClock(w.to)}` : "";
    body = (
      <Ask id="last-night-ask" title={`Nothing logged ${formatTimeNear(gap.start, gap.end, tz)}–${formatTime(gap.end, tz)}`} sub={whose ? `${dur} · ${whose}` : `${dur} between two logged things`}>
        {/* Not sure first: nobody has to guess about a stretch they slept through. Two rows at most, so it fits above the dock at 320px. */}
        <div className="grid grid-cols-2 gap-2" aria-label={whose ? `${dur} with nothing logged, ${whose} (${range})` : undefined} role="group">
          <GridAnswer onClick={() => answerGap([gap], "Left out of the counts")}>Not sure</GridAnswer>
          <GridAnswer onClick={() => answerGap([gap])}>Up or feeding</GridAnswer>
          <GridAnswer disabled={s.busy} onClick={() => void sleptThrough(gap)}>
            {v.They} slept through
          </GridAnswer>
          {left > 1 && (
            <GridAnswer aria-label="Skip the rest of the stretches" onClick={() => answerGap(pic.gaps, "Skipped: left out of the counts")}>
              Skip the rest
            </GridAnswer>
          )}
        </div>
      </Ask>
    );
  } else if (ask?.kind === "place") {
    const pre = ask.prefill ? PREFILL_WORDS[ask.prefill] : undefined;
    body =
      pre && !placeOpen ? (
        <Ask id="last-night-ask" title={placeQuestion(v)} sub={pre.line}>
          <div className="grid grid-cols-2 gap-2">
            <GridAnswer disabled={s.busy} onClick={() => void place(ask.prefill!)}>
              {pre.yes}
            </GridAnswer>
            <GridAnswer
              onClick={() => {
                setPlaceOpen(true);
                moved();
              }}
            >
              Something else
            </GridAnswer>
          </div>
        </Ask>
      ) : (
        <Ask id="last-night-ask" title={placeQuestion(v)}>
          <div className="grid grid-cols-2 gap-2">
            {CHECKIN_PLACES.map((p) => (
              <GridAnswer key={p} disabled={s.busy} onClick={() => void place(p)}>
                {PLACE_LABEL[p]}
              </GridAnswer>
            ))}
          </div>
        </Ask>
      );
  } else if (ask?.kind === "untimed") {
    const labels = untimedLabels(ask.minutes);
    body = (
      <Ask id="last-night-ask" title={UNTIMED_QUESTION} sub="No try is in the log for last night.">
        <div className="grid grid-cols-2 gap-2">
          {UNTIMED_TRIES.map((u) => (
            <GridAnswer key={u} disabled={s.busy} onClick={() => void extras({ untimed_try: u, untimed_min: u === "no" ? null : ask.minutes }, `Saved: ${labels[u].toLowerCase()}`)}>
              {labels[u]}
            </GridAnswer>
          ))}
        </div>
      </Ask>
    );
  } else if (ask?.kind === "handoff") {
    body = (
      <Ask id="last-night-ask" title={handoffQuestion(formatTime(ask.at, tz))}>
        <div className="grid grid-cols-2 gap-2">
          {HANDOFF_ANSWERS.map((h) => (
            <GridAnswer key={h} disabled={s.busy} onClick={() => void extras({ handoff: h }, `Saved: ${HANDOFF_LABEL[h].toLowerCase()}`)}>
              {HANDOFF_LABEL[h]}
            </GridAnswer>
          ))}
        </div>
      </Ask>
    );
  }
  const undo = receipt?.undo;
  return (
    <motion.section
      layout
      // Opened again after noon (Up next's Answer scrolls to it as it comes in), it only fades in: the scroll is measured
      // mid-slide, which would leave its top 8px off the screen.
      initial={ln.memo.open ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby="last-night"
      data-last-night
      {...guard.props}
      className={cx(tone.card, "space-y-3 px-4 py-3.5")}
    >
      {/* Not now sits by the title, so the card's question, its answers and a way out fit above the dock on a 320 × 568 phone. */}
      <div className="flex items-center gap-3">
        {/* Under 360px the badge steps aside, so the line under the title (a receipt) has room to read in full. */}
        <span className="shrink-0 max-[359px]:hidden">
          <KindBadge icon="moon" color={KIND_COLOR.sleep} size={36} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="last-night" className={cx(tone.heading, "text-[17px] leading-tight")}>
            Last night
          </h3>
          {/* The last answer's receipt takes the date's line, on one line (the strip says the night), its Undo a 44px target. */}
          {receipt ? (
            <p role="status" data-last-night-receipt className="flex min-w-0 items-center gap-1 text-[13px] leading-snug text-mp-ink-2">
              <span className="min-w-0 truncate">{receipt.said}</span>
              {undo && (
                <button
                  type="button"
                  disabled={s.busy}
                  onClick={() =>
                    void undo().then((x) => {
                      if (!x) return;
                      setReceipt(null);
                      moved();
                    })
                  }
                  className="-my-3 inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center font-semibold text-mp-accent-fg disabled:opacity-40"
                >
                  Undo
                </button>
              )}
            </p>
          ) : (
            <p className={cx(tone.muted, "truncate text-[13px] leading-snug")}>{dateWords(night, dayKey(now, tz))}</p>
          )}
        </div>
        {/* The card goes at once and Up next slides up into its place (her Took it under the thumb): taps on the page wait. */}
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2 shrink-0"
          onClick={() => {
            holdTodayTaps();
            ln.save({ ...ln.memo, hidden: true });
            focusNext("#right-now", "#recent");
          }}
        >
          Not now
        </Button>
      </div>
      {/* Folded after noon: no strip, one row for the rest of last night's questions. */}
      {folded ? (
        <div className="flex items-center justify-between gap-3">
          <p className={cx(tone.muted, "min-w-0 text-[14px] leading-snug")}>{FOLD_WORDS}</p>
          <Button
            variant="soft"
            size="sm"
            className="shrink-0"
            onClick={() => {
              ln.unfold();
              moved();
            }}
          >
            Answer
          </Button>
        </div>
      ) : (
        <NightStrip pic={pic} tz={tz} ask={ask?.kind === "gap" ? ask.gap : null} />
      )}
      {body}
      {ln.elsewhere && (
        <p role="note" data-safe-sleep className={cx(tone.inset, "px-3 py-2.5 text-[13px] leading-snug text-mp-ink")}>
          {safeSleepLine(v)}
        </p>
      )}
      {/* The weekly look-back ends the card, once the night's own questions are answered (or folded). */}
      {look && !ask && (
        <LookBackPart
          key={look.goal.id}
          due={look}
          onReceipt={(r) => {
            setReceipt(r);
            moved();
          }}
          onHold={(on) => setHeld(on ? look : null)}
        />
      )}
      <div className="-mx-1 flex flex-wrap items-center gap-x-1">
        <AskChatButton prompt="Last night: " label="Last night">
          Tell Maple
        </AskChatButton>
        {(ln.due || ln.checkedIn) && ln.windows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "checkin", night, card: true })}>
            Add a note
          </Button>
        )}
      </div>
    </motion.section>
  );
}

/**
 * After noon, the folded Last night card with nothing else to show, as one
 * row at the end of Today's Up next card (UpNext.tsx), after the Sleep plan
 * row and drawn like it: the card no longer stands above her Took it and the
 * plan's Put down all afternoon and evening. The fold's own words, and
 * Answer, quiet: it opens the card again in its place above Up next, on this
 * phone, for that night (the memo's `open`), and brings its first answer
 * into view. For whoever sees the card (owners and members of a family with
 * a sleep plan or goal); its Not now is the card's.
 */
export function LastNightRow() {
  const ln = useLastNight();
  const night = useRowNight();
  // The card says when it stands here; once Answer opens it (the memo, read by both at once), the row steps aside with it.
  if (!ln || ln.memo.open || night !== ln.night) return null;
  const answer = () => {
    // The card comes in above this card, moving the page under the thumb: for the tap cooldown a tap on the page does
    // nothing (tapShield), so a double tap's second half never lands on what slid under it.
    holdTodayTaps();
    ln.unfold();
    // The card renders with this tap; on the next frame it's there to scroll to, with focus on its first answer.
    requestAnimationFrame(showLastNight);
  };
  return (
    <div data-last-night-row className="flex min-h-[60px] items-center gap-1 pr-3">
      <div className="flex min-h-[60px] min-w-0 flex-1 items-center gap-2.5 py-2 pl-3.5">
        <KindBadge icon="moon" color={KIND_COLOR.sleep} size={32} />
        <span className="min-w-0 flex-1 leading-[18px]">
          <span className={cx(tone.heading, "block text-[15px] leading-[20px]")}>Last night</span>
          {/* Balanced, so it wraps at its comma ("More about last night, / if you'd like."), never leaving "like." alone. */}
          <span className={cx(tone.muted, "block text-[13px] leading-snug text-balance")}>{FOLD_WORDS}</span>
        </span>
      </div>
      {/* A 44px target around a 36px pill, as the Sleep plan row's Put down above it; quiet, since it can wait. */}
      <button type="button" onClick={answer} aria-label="Answer: more about last night" className="-my-1 flex min-h-[44px] shrink-0 items-center">
        <span className="inline-flex min-h-[36px] items-center rounded-[10px] bg-mp-sunken px-3.5 text-sm font-semibold whitespace-nowrap text-mp-ink active:scale-[0.97]">Answer</span>
      </button>
    </div>
  );
}

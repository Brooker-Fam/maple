"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SLEEP_GUIDES } from "@/lib/maple/guidelines/sleep";
import { sleepByPlace, tryDayKey } from "@/lib/maple/sleep/engine";
import { goalStartKey, lastNightKey, nightAnswers, nightPicture, plannedHandoff, windowOn, windowOnNight, type NightBar, type NightGap, type NightPicture } from "@/lib/maple/sleep/goals";
import { CHECKIN_PLACES, HANDOFF_ANSWERS, UNTIMED_TRIES, type CheckinPlace, type ProtectedAnswer, type SleepGoal } from "@/lib/maple/sleep/types";
import { checkinQuestion, dateWords, HANDOFF_LABEL, handoffQuestion, PLACE_LABEL, placeQuestion, shortClock, UNTIMED_QUESTION, untimedLabels } from "@/lib/maple/sleep/words";
import { dayKey, DEFAULT_TZ, formatDuration, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import type { Voice } from "@/lib/maple/voice";
import { AskChatButton } from "../chat/AskChat";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { AnswerButtons, checkinDue, morningOf, myWindows, useNightValue, type CheckinDue } from "./SleepCheckin";
import { useSleepMaybe, useTryAfterWake, type CardReceipt } from "./useSleep";

/**
 * Today's Last night card, from 5 AM the morning after, with no
 * notification: the night as a strip from the log (goals.ts nightPicture);
 * a sleep timer left running past something logged later, with "Woke at"
 * that moment (or Still asleep); the adult's own check-in ("Did you get your
 * 10 PM–2 AM sleep?"); the two longest stretches over 90 minutes with
 * nothing logged between two things that were, each named by whose
 * protected window it was in, with Not sure first ("Up or feeding" and
 * "Not sure" save nothing and the night stays partly logged; "She slept
 * through" logs a sleep for it; Skip the rest); then the night's other
 * one-tap questions, each once a night, the place prefilled from the log
 * when every sleep has one. One thing at a time, so it stays small on a
 * 320 × 568 phone, and an answer's receipt (with its Undo) shows in the
 * card, never as a toast over the next question. Tell Maple opens the chat
 * with "Last night: " typed (a photo of a paper log is read back before
 * anything saves). Not now hides it for that night on this phone. For
 * owners and members of a family with a sleep plan or goal.
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

const BAR_COLOR: Record<Bar["kind"], string> = { ...KIND_COLOR, try: KIND_COLOR.sleep, hold: "#7F8C6A" };

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

/** This phone's answers that save nothing, for one night: Not now, the stretches answered or skipped, a timer said to be still asleep ("sleepId:nextId"). */
type Memo = { night: string; hidden?: boolean; gaps?: number[]; still?: string[] };
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

/**
 * Where the baby spent the night, from the log, when every sleep in the
 * strip has a place: the bassinet (or crib), held (in arms or a carrier), or
 * some of each; nothing for anywhere else, which is the family's to say.
 */
export function placeFromLog(entries: readonly Entry[], tries: Parameters<typeof sleepByPlace>[1], from: number, to: number, now: number): CheckinPlace | null {
  const r = sleepByPlace(entries, tries, from, to, now);
  if (!r.totalSec) return null;
  let bassinet = 0;
  let held = 0;
  for (const p of r.places) {
    if (p.place === "bassinet" || p.place === "crib") bassinet += p.sec;
    else if (p.place === "arms" || p.place === "carrier") held += p.sec;
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

export type LastNight = {
  night: string;
  pic: NightPicture;
  ask: NightAsk | null;
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
 * or member, no plan or active goal, before 5 AM, or Not now).
 */
export function useLastNight(): LastNight | null {
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
  if (!s.plan && !active.length) return null;
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
  const open = pic.gaps
    .filter((g) => !answered.includes(g.start))
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
  return (
    <div role="group" aria-label={`Did ${v.they} wake at ${formatTime(next.started_at, tz)}?`} data-woke-ask={sleep.id} className="space-y-2">
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
  return <WokeAsk sleep={sleep} next={next} busy={timerBusy(sleep.id)} onWoke={() => void ln.wokeAt(sleep, next)} onStill={() => ln.stillAsleep(sleep, next)} />;
}

/** Scroll Today to the Last night card (its question on screen, above the dock) and put focus on its first answer: the strip's Answer. */
export function showLastNight(): void {
  const card = document.querySelector<HTMLElement>("[data-last-night]");
  if (!card) return;
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  card.querySelector<HTMLElement>("[aria-labelledby='last-night-ask'] button")?.focus({ preventScroll: true });
}

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
  const ln = useLastNight();
  const m = useMaple();
  const { state, timerBusy } = m;
  const v = useVoice();
  const now = useNow(60_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  // An answer's receipt with its Undo, in the card (a toast here would sit on the next question at 320px).
  const [receipt, setReceipt] = useState<CardReceipt | null>(null);
  const [placeOpen, setPlaceOpen] = useState(false);
  // The card's state as it is when an Undo runs (answers since then included).
  const latest = useRef(ln);
  useEffect(() => {
    latest.current = ln;
  });
  const done = !!ln && !ln.ask && !ln.elsewhere;
  // The last answer leaves nothing to ask: the card goes, and its receipt rides a toast instead (nothing left under it).
  useEffect(() => {
    if (!done || !receipt) return;
    const undo = receipt.undo;
    m.toast(receipt.said, { tone: "ok", ...(undo ? { undo: () => void undo().then((x) => x && m.toast("Undone", { tone: "info" })) } : {}) });
    setReceipt(null);
  }, [done, receipt, m]);
  // (Rendering nothing keeps this card's state: a receipt arriving just after the last answer still reaches its toast.)
  if (!s || !ln || !state || done) return null;
  const { night, pic, ask } = ln;

  const show = (r: CardReceipt | null) => {
    if (r) setReceipt(r);
  };
  /** Stretches answered without saving anything (remembered on this phone); `said` replaces the receipt. */
  const answerGap = (gs: Gap[], said?: string) => {
    ln.save({ ...ln.memo, gaps: [...(ln.memo.gaps ?? []), ...gs.map((g) => g.start)] });
    if (said) setReceipt({ said, undo: null });
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
  };
  const place = async (p: CheckinPlace) => show(await s.answerExtras(night, { place: p }, `Saved: ${PLACE_LABEL[p].toLowerCase()}`));

  let body: ReactNode = null;
  if (ask?.kind === "running") {
    const { sleep, next } = ask;
    body = (
      <Ask id="last-night-ask" title={`The sleep timer is still running from ${formatTime(sleep.started_at, tz)}`} sub={`${nextWords(next, tz)}.`}>
        <WokeButtons at={formatTime(next.started_at, tz)} busy={timerBusy(sleep.id)} onWoke={() => void ln.wokeAt(sleep, next)} onStill={() => ln.stillAsleep(sleep, next)} />
      </Ask>
    );
  } else if (ask?.kind === "checkin") {
    body = (
      <Ask id="last-night-ask" title={ask.question}>
        <AnswerButtons row question={ask.question} disabled={s.busy} onPick={(a: ProtectedAnswer) => void s.answerCheckin(a, ask.due.night).then(show)} />
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
          <GridAnswer onClick={() => answerGap([gap], "Left as not logged: that stretch stays out of the counts.")}>Not sure</GridAnswer>
          <GridAnswer onClick={() => answerGap([gap])}>Up or feeding</GridAnswer>
          <GridAnswer disabled={s.busy} onClick={() => void sleptThrough(gap)}>
            {v.They} slept through
          </GridAnswer>
          {left > 1 && (
            <GridAnswer aria-label="Skip the rest of the stretches" onClick={() => answerGap(pic.gaps, "Skipped: those stretches stay out of the counts.")}>
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
            <GridAnswer onClick={() => setPlaceOpen(true)}>Something else</GridAnswer>
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
            <GridAnswer key={u} disabled={s.busy} onClick={() => void s.answerExtras(night, { untimed_try: u, untimed_min: u === "no" ? null : ask.minutes }, `Saved: ${labels[u].toLowerCase()}`).then(show)}>
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
            <GridAnswer key={h} disabled={s.busy} onClick={() => void s.answerExtras(night, { handoff: h }, `Saved: ${HANDOFF_LABEL[h].toLowerCase()}`).then(show)}>
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
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      aria-labelledby="last-night"
      data-last-night
      className={cx(tone.card, "space-y-3 px-4 py-3.5")}
    >
      {/* Not now sits by the title, so the card's question, its answers and a way out fit above the dock on a 320 × 568 phone. */}
      <div className="flex items-center gap-3">
        <KindBadge icon="moon" color={KIND_COLOR.sleep} size={36} />
        <div className="min-w-0 flex-1">
          <h3 id="last-night" className={cx(tone.heading, "text-[17px] leading-tight")}>
            Last night
          </h3>
          {/* The last answer's receipt takes the date's line (the strip says the night), its Undo a 44px target that keeps the line short. */}
          {receipt ? (
            <p role="status" data-last-night-receipt className="text-[13px] leading-snug text-mp-ink-2">
              {receipt.said}
              {undo && (
                <>
                  {" · "}
                  <button
                    type="button"
                    disabled={s.busy}
                    onClick={() => void undo().then((x) => x && setReceipt(null))}
                    className="-my-3 inline-flex min-h-[44px] items-center px-1 align-middle font-semibold text-mp-accent-fg disabled:opacity-40"
                  >
                    Undo
                  </button>
                </>
              )}
            </p>
          ) : (
            <p className={cx(tone.muted, "truncate text-[13px] leading-snug")}>{dateWords(night, dayKey(now, tz))}</p>
          )}
        </div>
        <Button variant="ghost" size="sm" className="-mr-2 shrink-0" onClick={() => ln.save({ ...ln.memo, hidden: true })}>
          Not now
        </Button>
      </div>
      <NightStrip pic={pic} tz={tz} ask={ask?.kind === "gap" ? ask.gap : null} />
      {body}
      {ln.elsewhere && (
        <p role="note" data-safe-sleep className={cx(tone.inset, "px-3 py-2.5 text-[13px] leading-snug text-mp-ink")}>
          {safeSleepLine(v)}
        </p>
      )}
      <div className="-mx-1 flex flex-wrap items-center gap-x-1">
        <AskChatButton prompt="Last night: " label="Last night">
          Tell Maple
        </AskChatButton>
        {(ln.due || ln.checkedIn) && ln.windows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => s.openSheet({ kind: "checkin", night })}>
            Add a note
          </Button>
        )}
      </div>
    </motion.section>
  );
}

"use client";

import { useRef } from "react";
import { askState, shiftStatus, sleepSignals } from "@/lib/maple/sleep/engine";
import { cryingLine, downWords, slotShort } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime, formatTimeNear, localParts } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { TAP_COOLDOWN_MS } from "../tapCooldown";
import { cx } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { showLastNight, useLastNight, type LastNight } from "./LastNight";
import { partnerOf, usePeople, useSleepMaybe } from "./useSleep";

type Action = { label: string; onClick: () => void; strong?: boolean };

/**
 * What the sleep plan says right now to someone who can log: the words, the
 * one action, its badge, and whether it's urgent. `idle`: nothing is going on
 * (no try, no turn, no crying aftermath, no morning question), so the plan's
 * next step is Put down, which rides in Today's Up next card (SleepPlanRow);
 * every other moment rides on the dock's strip.
 */
export type SleepMoment = { idle: boolean; words: string; sub: string; action: Action; icon: "bassinet" | "hold" | "moon"; urgent: boolean };

/** " · 25m" after "since 2:10 AM": how long so far, and nothing under a minute (never "· 0s"). */
const forSoFar = (since: string, now: Date, say: (sec: number) => string) => {
  const sec = (now.getTime() - Date.parse(since)) / 1000;
  return sec < 60 ? "" : ` · ${say(sec)}`;
};

/** The try day's morning (5 AM to noon, the family's zone): the Last night card's hours on the strip. */
const isMorning = (now: Date, tz: string) => {
  const h = localParts(now, tz).hour;
  return h >= 5 && h < 12;
};

/**
 * The Last night card's first question, carried on the strip in the
 * morning, so a short phone reaches it without scrolling: "Woke at 6:30 AM"
 * in one tap for a timer left running, else Answer, which brings the card
 * into view with focus on its first answer.
 */
function morningAsk(ln: LastNight, tz: string, name: string): { words: string; sub: string; action: Action } | null {
  const a = ln.ask;
  if (!a) return null;
  const answer: Action = { label: "Answer", onClick: showLastNight, strong: true };
  switch (a.kind) {
    case "running":
      // Two lines at 320px beside its button: the answer names the time something was logged after it.
      return {
        words: `Still asleep since ${formatTime(a.sleep.started_at, tz)}?`,
        sub: "",
        action: { label: `Woke at ${formatTime(a.next.started_at, tz)}`, onClick: () => void ln.wokeAt(a.sleep, a.next), strong: true },
      };
    case "checkin":
      return { words: a.question, sub: "last night", action: answer };
    case "gap":
      return { words: `Nothing logged ${formatTimeNear(a.gap.start, a.gap.end, tz)}–${formatTime(a.gap.end, tz)}`, sub: "last night", action: answer };
    case "place":
      return { words: `Where did ${name} spend most of last night?`, sub: "", action: answer };
    case "untimed":
      return { words: "Any bassinet try that isn't in the log?", sub: "last night", action: answer };
    case "handoff":
      return { words: `Did the ${formatTime(a.at, tz)} handoff happen as planned?`, sub: "", action: answer };
  }
}

/**
 * The sleep plan's strip on top of Today's dock, where a thumb lands at 3am,
 * for people who can log, only while something is going on: the dock is the
 * baby's buttons otherwise, and the plan's everyday Put down (with the day's
 * count) sits in Today's Up next card (SleepPlanRow), so it isn't there all
 * day. One tap does what the moment needs:
 * - After a crying wake, Try again with "soothe her; try once more when
 *   she's deeply asleep"; after the retry, "pause until the next try", with
 *   Put down quiet.
 * - How did it go? while she's down, the strong button: its sheet's four
 *   outcomes sit in thumb reach.
 * - For the person holding her: I'm getting sleepy (two safe choices), or,
 *   while she's asleep in their arms, Put her down (I'm getting sleepy is on
 *   the turn's card then); Hand off to Alex at the planned time, and once
 *   Alex was asked, Alex has her (ten minutes on with nobody taking over:
 *   the two choices again).
 * - For everyone else: Take over, or I've got her when they were asked.
 * - From 5 AM to noon, the Last night card's first question (morningAsk).
 * Tapping the words opens the plan. A tap waits out the dock's cooldown, so
 * a double tap never lands on the button it turned into. Up to three lines
 * of words, so nothing is cut at 320px.
 */
export function SleepStrip() {
  const s = useSleepMaybe();
  const m = useSleepMoment();
  const cool = useRef(Number.NEGATIVE_INFINITY);
  // The everyday Put down is Up next's (SleepPlanRow): the strip is only for a moment.
  if (!s || !m || m.idle) return null;
  const { words, sub, action, icon, urgent } = m;

  // A tap that turns this button into another (Put down → How did it go?) waits out the dock's cooldown.
  const tap = () => {
    const t = performance.now();
    if (t - cool.current < TAP_COOLDOWN_MS) return;
    cool.current = t;
    action.onClick();
  };

  return (
    // A ring, not a border, so the words' button is the strip's full 44px.
    <div role="group" aria-label="Sleep plan" className="-mt-0.5 mb-1.5 flex min-h-11 items-stretch gap-1 rounded-2xl bg-mp-surface pr-1 shadow-[0_1px_2px_rgb(28_38_25/0.06)] ring-1 ring-(--mp-edge)">
      <button
        type="button"
        onClick={() => s.openSheet({ kind: "plan" })}
        aria-label={`${words}${sub ? `, ${sub}` : ""}. Open the sleep plan.`}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl py-0.5 pl-2 text-left transition active:bg-mp-ink/[0.04]"
      >
        <KindBadge icon={icon} color={KIND_COLOR.sleep} size={28} />
        {/* Up to three lines when it needs them, so the crying line is never cut at 320px. */}
        <span className="line-clamp-3 min-w-0 flex-1 text-[13px] leading-[17px]">
          <span className={cx("font-semibold text-mp-ink", urgent && "text-mp-accent-fg")}>{words}</span>
          {sub && <span className="text-mp-ink-2"> · {sub}</span>}
        </span>
      </button>
      {/* A 44px target around a 36px pill. */}
      <button type="button" disabled={s.busy} onClick={tap} className="flex min-h-[44px] max-w-[52%] shrink-0 items-center disabled:opacity-40">
        <span
          className={cx(
            "inline-flex min-h-[36px] items-center rounded-[10px] px-3.5 text-left text-sm leading-tight font-semibold active:scale-[0.97]",
            action.strong ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink"
          )}
        >
          {action.label}
        </span>
      </button>
    </div>
  );
}

/**
 * The moment the strip (or, when idle, Up next's Sleep plan row) shows: null
 * for a reader, or before there's a plan, a try or a turn.
 */
export function useSleepMoment(): SleepMoment | null {
  const s = useSleepMaybe();
  const { state, memberName } = useMaple();
  const v = useVoice();
  const now = useNow(30_000);
  const people = usePeople();
  const ln = useLastNight();
  if (!s || !s.canWrite || (!s.plan && !s.running && !s.shift)) return null;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email ?? "";
  const sh = s.shift;

  let words: string;
  let sub: string;
  let action: Action;
  let icon: "bassinet" | "hold" | "moon" = "bassinet";
  let urgent = false;
  const sleep = s.running?.sleep_entry_id ? state?.entries.find((e) => e.id === s.running!.sleep_entry_id) : undefined;
  const woke = !!sleep && !sleep.active && !!sleep.ended_at;
  const signals = sleepSignals(s.data.tries, now, tz);
  const morning = !s.running && !sh && !signals.has("after_crying") && !signals.has("retry_done") && ln && isMorning(now, tz) ? morningAsk(ln, tz, v.name) : null;
  if (s.running) {
    words = woke ? `${v.They} woke at ${formatTime(sleep!.ended_at!, tz)}` : "In the bassinet";
    sub = woke ? "the try is still open" : `since ${formatTime(s.running.started_at, tz)}${forSoFar(s.running.started_at, now, formatDuration)}`;
    // The strong button while she's down: its sheet's outcomes sit low, in thumb reach (the card's are at the top of the screen).
    action = { label: "How did it go?", onClick: () => s.openSheet({ kind: "outcome", tryId: s.running!.id }), strong: true };
  } else if (sh) {
    icon = "hold";
    const due = shiftStatus(sh, now).due;
    const ask = askState(sh, now);
    const asked = ask.asked ? memberName(ask.to!) : null;
    const holder = memberName(sh.holder);
    const asleep = (state?.entries ?? []).find((e) => e.kind === "sleep" && e.active) ?? null;
    const since = asleep ? `asleep since ${formatTime(asleep.started_at, tz)}` : null;
    if (sh.holder === me) {
      const partner = partnerOf(sh, people, me);
      if (ask.asked && !ask.stale) {
        words = `Waking ${asked}…`;
        sub = `asked ${formatTime(ask.at!, tz)}`;
        action = { label: `${asked} has ${v.them}`, onClick: () => void s.handOff(sh, { to: ask.to! }), strong: true };
      } else if (ask.asked) {
        // Ten minutes and nobody took over: the two safe choices again, never "keep holding".
        words = "Nobody has taken over yet";
        sub = `asked ${asked} ${formatTime(ask.at!, tz)}`;
        action = { label: "I'm getting sleepy", onClick: () => s.openSheet({ kind: "sleepy" }), strong: true };
        urgent = true;
      } else if (due && partner) {
        words = "Handoff time";
        sub = `planned ${formatTime(sh.handoff_at!, tz)}`;
        action = { label: `Hand off to ${memberName(partner.email)}`, onClick: () => s.openSheet({ kind: "holding", mode: "handoff", to: partner.email }), strong: true };
        urgent = true;
      } else if (asleep) {
        // Asleep in their arms: the safe choice in thumb reach is the bassinet (I'm getting sleepy is on the turn's card).
        words = `Asleep in your arms`;
        sub = `since ${formatTime(asleep.started_at, tz)}${forSoFar(asleep.started_at, now, (sec) => downWords(sec / 60))}`;
        action = { label: `Put ${v.them} down`, onClick: () => void s.startTry(), strong: true };
        urgent = due;
      } else {
        words = due ? "Handoff time" : `You're holding ${v.them}`;
        sub = sh.handoff_at ? `handoff ${formatTime(sh.handoff_at, tz)}` : `since ${formatTime(sh.started_at, tz)}`;
        action = { label: "I'm getting sleepy", onClick: () => s.openSheet({ kind: "sleepy" }), strong: true };
        urgent = due;
      }
    } else if (ask.asked && ask.to === me) {
      words = `${holder} asked you to take over`;
      sub = `at ${formatTime(ask.at!, tz)}`;
      action = { label: `I've got ${v.them}`, onClick: () => void s.acceptHandoff(sh), strong: true };
      urgent = true;
    } else {
      words = `${holder} is holding ${v.them}`;
      sub = ask.asked ? `asked ${asked} to take over` : (since ?? (sh.handoff_at ? `handoff ${formatTime(sh.handoff_at, tz)}` : `since ${formatTime(sh.started_at, tz)}`));
      action = { label: "Take over", onClick: () => s.openSheet({ kind: "holding", mode: "handoff", to: me }) };
    }
  } else if (signals.has("after_crying")) {
    // After a crying wake: soothe first; the retry is for when she's deeply asleep again.
    words = cryingLine(v, "after_crying");
    sub = "";
    action = { label: "Try again", onClick: () => void s.startTry(), strong: true };
  } else if (signals.has("retry_done")) {
    const t = s.today;
    words = cryingLine(v, "retry_done");
    sub = t?.next ? slotShort(t.next) : t ? `${t.done} of ${t.planned} ${t.label}` : "";
    action = { label: "Put down", onClick: () => void s.startTry() };
  } else if (morning) {
    icon = "moon";
    ({ words, sub, action } = morning);
  } else {
    // Nothing going on: the plan's next step, Put down, in Up next (the strip steps aside).
    const t = s.today;
    const tally = t ? `${t.done} of ${t.planned} ${t.label}` : "";
    const asleep = (state?.entries ?? []).some((e) => e.kind === "sleep" && e.active);
    // Filled only when it's the moment: she's asleep and the plan's tries for the day aren't done ("1 of 1" is quiet).
    const strong = asleep && (!t || t.done < t.planned);
    return { idle: true, words: "Bassinet try", sub: t ? `${tally}${t.next ? ` · ${slotShort(t.next)}` : ""}` : "", action: { label: "Put down", onClick: () => void s.startTry(), strong }, icon: "bassinet", urgent: false };
  }
  return { idle: false, words, sub, action, icon, urgent };
}

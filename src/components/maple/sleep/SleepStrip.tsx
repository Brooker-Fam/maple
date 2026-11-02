"use client";

import { useRef } from "react";
import { askState, shiftStatus, sleepSignals } from "@/lib/maple/sleep/engine";
import { cryingLine, slotShort } from "@/lib/maple/sleep/words";
import { DEFAULT_TZ, formatDuration, formatTime } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { KindBadge } from "../icons";
import { KIND_COLOR } from "../palette";
import { TAP_COOLDOWN_MS } from "../tapCooldown";
import { cx } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { partnerOf, usePeople, useSleepMaybe } from "./useSleep";

type Action = { label: string; onClick: () => void; strong?: boolean };

/**
 * The sleep plan's strip on top of Today's dock, where a thumb lands at 3am,
 * for people who can log, once there's a plan (or a try or a turn going).
 * One tap does what the moment needs:
 * - Put down; after a crying wake, Try again with "soothe her; try once more
 *   when she's deeply asleep"; after the retry, "pause until the next try",
 *   with Put down quiet.
 * - How did it go? while she's down.
 * - For the person holding her: I'm getting sleepy (two safe choices), Hand
 *   off to Alex at the planned time, and once Alex was asked, Alex has her
 *   (ten minutes on with nobody taking over: the two choices again).
 * - For everyone else: Take over, or I've got her when they were asked.
 * Tapping the words opens the plan. A tap waits out the dock's cooldown, so
 * a double tap never lands on the button it turned into.
 */
export function SleepStrip() {
  const s = useSleepMaybe();
  const { state, memberName } = useMaple();
  const v = useVoice();
  const now = useNow(30_000);
  const people = usePeople();
  const cool = useRef(Number.NEGATIVE_INFINITY);
  if (!s || !s.canWrite || (!s.plan && !s.running && !s.shift)) return null;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email ?? "";
  const sh = s.shift;

  let words: string;
  let sub: string;
  let action: Action;
  let icon: "bassinet" | "hold" = "bassinet";
  let urgent = false;
  const sleep = s.running?.sleep_entry_id ? state?.entries.find((e) => e.id === s.running!.sleep_entry_id) : undefined;
  const woke = !!sleep && !sleep.active && !!sleep.ended_at;
  if (s.running) {
    words = woke ? `${v.They} woke at ${formatTime(sleep!.ended_at!, tz)}` : "In the bassinet";
    sub = woke ? "the try is still open" : `since ${formatTime(s.running.started_at, tz)} · ${formatDuration(Math.max(0, (now.getTime() - Date.parse(s.running.started_at)) / 1000))}`;
    action = { label: "How did it go?", onClick: () => s.openSheet({ kind: "outcome", tryId: s.running!.id }), strong: woke };
  } else if (sh) {
    icon = "hold";
    const due = shiftStatus(sh, now).due;
    const ask = askState(sh, now);
    const asked = ask.asked ? memberName(ask.to!) : null;
    const holder = memberName(sh.holder);
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
      sub = ask.asked ? `asked ${asked} to take over` : sh.handoff_at ? `handoff ${formatTime(sh.handoff_at, tz)}` : `since ${formatTime(sh.started_at, tz)}`;
      action = { label: "Take over", onClick: () => s.openSheet({ kind: "holding", mode: "handoff", to: me }) };
    }
  } else {
    const t = s.today;
    const signals = sleepSignals(s.data.tries, now, tz);
    const tally = t ? `${t.done} of ${t.planned} ${t.label}` : "";
    if (signals.has("after_crying")) {
      // After a crying wake: soothe first; the retry is for when she's deeply asleep again.
      words = cryingLine(v, "after_crying");
      sub = "";
      action = { label: "Try again", onClick: () => void s.startTry(), strong: true };
    } else if (signals.has("retry_done")) {
      words = cryingLine(v, "retry_done");
      sub = t?.next ? slotShort(t.next) : tally;
      action = { label: "Put down", onClick: () => void s.startTry() };
    } else {
      words = "Bassinet try";
      sub = t ? `${tally}${t.next ? ` · ${slotShort(t.next)}` : ""}` : "";
      action = { label: "Put down", onClick: () => void s.startTry(), strong: true };
    }
  }

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
        {/* Two lines when it needs them, so "0 of 1 tonight" is never cut to "0 of 1 to…" at 320px. */}
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-[17px]">
          <span className={cx("font-semibold text-mp-ink", urgent && "text-mp-accent-fg")}>{words}</span>
          {sub && <span className="text-mp-ink-2"> · {sub}</span>}
        </span>
      </button>
      {/* A 44px target around a 36px pill, as her strip's Took it. */}
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

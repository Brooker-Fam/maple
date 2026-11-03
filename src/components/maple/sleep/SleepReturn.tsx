"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { tryDayBounds } from "@/lib/maple/sleep/engine";
import { goalSpan, goalsByUrgency, lastNightKey, QUIET_NIGHTS, quietNow, tonightKey, type QuietStretch } from "@/lib/maple/sleep/goals";
import { EASE_OFF_DAYS, type SleepGoal } from "@/lib/maple/sleep/types";
import { easingWords, nightsRange } from "@/lib/maple/sleep/words";
import { addDays, dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import { KindBadge } from "../icons";
import { holdTodayTaps } from "../tapShield";
import { KIND_COLOR } from "../palette";
import { Button, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useNightValue } from "./SleepCheckin";
import { useGoalsView } from "./SleepGoals";
import { useSleepMaybe, type CardReceipt } from "./useSleep";

/**
 * Back after a quiet stretch (goals.ts QuietStretch: QUIET_NIGHTS nights in
 * a row with nothing logged and no check-in, still going): the next time
 * someone who writes goals opens Today or the plan, one card, once per
 * stretch on that phone: "Back to "Bassinet by Dec 1"? Nothing was logged
 * Oct 20–27, so those nights don't count." with Pick up from tonight
 * (counts_from), Ease off a week (paused_until) and Set it aside (closed as
 * dropped, opened again from Closed recently or its Undo). A goal never
 * pauses, closes or re-dates itself: only these taps do. Its receipt and
 * Undo stay in the card; Not now dismisses it. A view-only guest never sees it.
 */

type Slot = "today" | "plan";
type Shown = { key: string; slot: Slot; goal: SleepGoal; quiet: QuietStretch };

/** This page's one return card, once it has shown (so it stays where it showed, and never shows twice at once). */
let shown: Shown | null = null;
const listeners = new Set<() => void>();
const setShown = (x: Shown | null) => {
  shown = x;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const useShown = () => useSyncExternalStore(subscribe, () => shown, () => null);

const seenKey = (family: number, me: string) => `maple-goal-return:${family}:${me}`;
const seenList = (raw: string | null | undefined): string[] => {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-20) : [];
  } catch {
    return [];
  }
};

/**
 * Whether something was logged (or checked in) in the last three nights, from what this phone already has: then no
 * stretch of QUIET_NIGHTS can still be going, and the goals view isn't asked.
 */
function loggedLately(o: { entries: readonly { started_at: string; ended_at: string | null; active?: boolean }[]; tries: readonly { started_at: string }[]; shifts: readonly { started_at: string }[]; checkins: readonly { night: string }[] | null; now: Date; tz: string }): boolean {
  const last = lastNightKey(o.now, o.tz);
  const from = tryDayBounds(addDays(last, -2), o.tz)[0].getTime();
  const t = o.now.getTime();
  const after = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= from;
  return (
    o.entries.some((e) => after(e.started_at) || after(e.ended_at) || (e.active && t >= from)) ||
    o.tries.some((x) => after(x.started_at)) ||
    o.shifts.some((x) => after(x.started_at)) ||
    !!o.checkins?.some((c) => c.night >= addDays(last, -2))
  );
}

/** The return card for this slot (Today or the plan), or null. */
export function useGoalReturn(slot: Slot): Shown | null {
  const s = useSleepMaybe();
  const { state } = useMaple();
  const now = useNow(60_000);
  const current = useShown();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [raw, setRaw] = useNightValue(state && s?.canWrite ? seenKey(state.family?.id ?? 1, s.me) : null);
  // Only goals counted long enough to have a quiet stretch, and only when this phone has nothing from the last three nights.
  const last = lastNightKey(now, tz);
  const candidates = s && state && s.canWrite && !current ? s.goals.filter((g) => g.status === "active" && goalSpan(g, now, tz).startsOn <= addDays(last, -(QUIET_NIGHTS - 1))) : [];
  const maybe = !!s && !!state && candidates.length > 0 && !loggedLately({ entries: state.entries, tries: s.data.tries, shifts: s.data.shifts, checkins: s.checkins, now, tz });
  const { views } = useGoalsView(maybe);
  let found: Shown | null = null;
  if (maybe && views && raw !== undefined) {
    const seen = seenList(raw);
    for (const g of goalsByUrgency(candidates, now, tz)) {
      const v = views.find((x) => x.goal.id === g.id);
      const q = v ? quietNow(v.progress) : null;
      if (q && !seen.includes(`${g.id}:${q.from}`)) {
        found = { key: `${g.id}:${q.from}`, slot, goal: g, quiet: q };
        break;
      }
    }
  }
  // Once shown, it's seen on this phone (once per stretch), and stays where it showed until it's dismissed.
  useEffect(() => {
    if (!found || shown) return;
    setShown(found);
    setRaw(JSON.stringify([...seenList(raw), found.key]));
  }, [found, raw, setRaw]);
  return current && current.slot === slot ? current : null;
}

/** Today's slot for the return card (above the Last night card). */
export function GoalReturnToday() {
  const r = useGoalReturn("today");
  return r ? <GoalReturnCard r={r} /> : null;
}

/** The plan sheet's slot for it (above its tabs), when the plan is opened first. */
export function GoalReturnPlan() {
  const r = useGoalReturn("plan");
  return r ? <GoalReturnCard r={r} /> : null;
}

export function GoalReturnCard({ r }: { r: Shown }) {
  const s = useSleepMaybe();
  const { state, now } = useMaple();
  const [receipt, setReceipt] = useState<CardReceipt | null>(null);
  if (!s || !state) return null;
  const tz = state.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  // The goal as it is now (another phone may have moved it on), for each write's revision.
  const goal = s.goals.find((g) => g.id === r.goal.id) ?? r.goal;
  const write = s.goalCall;
  const done = (said: string, undo: CardReceipt["undo"]) => setReceipt({ said, undo });

  const pickUp = async () => {
    const from = tonightKey(now(), tz);
    const easing = !!goal.paused_until && today < goal.paused_until;
    const w = await write({ action: "goal.update", id: goal.id, revision: goal.revision, patch: { counts_from: from, ...(easing ? { paused_until: null } : {}) } });
    if (!w || !("saved" in w)) return;
    const saved = w.saved;
    done("Picked up: counting from tonight", async () => {
      const u = await write({ action: "goal.update", id: goal.id, revision: saved.revision, patch: { counts_from: goal.counts_from ?? null, ...(easing ? { paused_until: goal.paused_until } : {}) } });
      return !!u && "saved" in u;
    });
  };
  const easeOff = async () => {
    const until = addDays(today, EASE_OFF_DAYS);
    const w = await write({ action: "goal.update", id: goal.id, revision: goal.revision, patch: { paused_until: until } });
    if (!w || !("saved" in w)) return;
    const saved = w.saved;
    done(easingWords(until, today), async () => {
      const u = await write({ action: "goal.update", id: goal.id, revision: saved.revision, patch: { paused_until: goal.paused_until ?? null } });
      return !!u && "saved" in u;
    });
  };
  const setAside = async () => {
    // The goal's own close path: Closed recently keeps it, with Open again; Undo opens it again as it was.
    const w = await write({ action: "goal.close", id: goal.id, status: "dropped" });
    if (!w || !("saved" in w)) return;
    const saved = w.saved;
    done(`Set aside: ${goal.title}`, async () => {
      const u = await write({ action: "goal.update", id: goal.id, revision: saved.revision, patch: { status: goal.status === "paused" ? "paused" : "active" } });
      return !!u && "saved" in u;
    });
  };
  // The card goes and the page slides up under the thumb (Up next's Took it and Put down): taps on the page wait.
  const dismiss = () => {
    holdTodayTaps();
    setShown(null);
  };
  const undo = receipt?.undo;
  return (
    <section aria-labelledby="goal-return" data-goal-return className={cx(tone.card, "space-y-3 px-4 py-3.5")}>
      <div className="flex items-start gap-3">
        <KindBadge icon="moon" color={KIND_COLOR.sleep} size={36} />
        <div className="min-w-0 flex-1">
          <h3 id="goal-return" className={cx(tone.heading, "text-[17px] leading-snug break-words")}>
            Back to “{goal.title}”?
          </h3>
          <p className={cx(tone.muted, "text-[14px] leading-snug")}>Nothing was logged {nightsRange(r.quiet.from, r.quiet.to, today)}, so those nights don&apos;t count.</p>
        </div>
      </div>
      {receipt ? (
        <div className="flex items-center gap-2">
          <p role="status" data-goal-return-receipt className="min-w-0 flex-1 truncate text-[14px] leading-snug text-mp-ink">
            {receipt.said}
          </p>
          {undo && (
            <button
              type="button"
              disabled={s.busy}
              onClick={() => void undo().then((x) => x && setReceipt(null))}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center px-2 text-[14px] font-semibold text-mp-accent-fg disabled:opacity-40"
            >
              Undo
            </button>
          )}
          <Button variant="ghost" size="sm" className="shrink-0" onClick={dismiss}>
            Done
          </Button>
        </div>
      ) : (
        <>
          <div role="group" aria-label="What's next for this goal" className="grid grid-cols-3 gap-2">
            {(
              [
                ["Pick up from tonight", pickUp],
                ["Ease off a week", easeOff],
                ["Set it aside", setAside],
              ] as const
            ).map(([label, run]) => (
              <button
                key={label}
                type="button"
                disabled={s.busy}
                onClick={() => void run()}
                className="mp-control flex min-h-[48px] items-center justify-center rounded-2xl bg-mp-sunken px-2 py-1 text-center text-[14px] leading-tight font-semibold text-mp-ink transition active:scale-[0.98] disabled:opacity-40"
              >
                {label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" className="-ml-2" onClick={dismiss}>
            Not now
          </Button>
        </>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import { goalSpan, goalsByUrgency, lookBack, quietNow, reviewWeek, type GoalWeek, type LookBack } from "@/lib/maple/sleep/goals";
import { EASE_OFF_DAYS, type SleepGoal } from "@/lib/maple/sleep/types";
import { dateWords } from "@/lib/maple/sleep/words";
import { addDays, dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import { useChatNav } from "../chat/ChatNav";
import { focusNext } from "../tapCooldown";
import { cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useGoalsView, type GoalView } from "./SleepGoals";
import { useSleepMaybe, type CardReceipt, type GoalSave } from "./useSleep";

/**
 * The weekly look-back at the end of Today's Last night card, on a goal's
 * review day (goals.ts reviewWeek: the day after a counted week's last
 * night, with its review due, steps planned and its target date ahead): the
 * targets with what each is out of, this week's step and each adult's
 * check-ins, then "This week's step?" in one tap: Keep it (records the
 * review), Ease off a week (with "Move the target date a week later?" as a
 * second tap) or Next step (marks the step done and brings the next one into
 * this week, or opens the chat when none is planned), offered only once the
 * week has ENOUGH_NIGHTS nights to read. Every choice's receipt and Undo show
 * in the card. No push, never "overdue", no streaks or scores; the card's
 * Not now hides it for the day. For owners and members only: a view-only
 * guest never sees the card.
 */

export type LookBackDue = { goal: SleepGoal; week: GoalWeek; view: GoalView };

/**
 * The goal whose look-back is due today (the most urgent), with the week it reads and its progress from the server; null
 * on any other day, for a reader who can't write goals, until its progress has loaded, and while a quiet stretch is
 * still going on it (the return card says that once, SleepReturn.tsx, so no look-back on top of it).
 */
export function useLookBackDue(): LookBackDue | null {
  const s = useSleepMaybe();
  const { state } = useMaple();
  const now = useNow(60_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  let found: { goal: SleepGoal; week: GoalWeek } | null = null;
  if (s && state && s.canWrite) {
    for (const goal of goalsByUrgency(s.goals.filter((g) => g.status === "active"), now, tz)) {
      const week = reviewWeek(goal, goalSpan(goal, now, tz), now, tz);
      if (week) {
        found = { goal, week };
        break;
      }
    }
  }
  const { views } = useGoalsView(!!found, { id: found?.goal.id, night: found?.week.to });
  const view = found ? (views?.find((x) => x.goal.id === found.goal.id) ?? null) : null;
  if (!found || !view || quietNow(view.progress)) return null;
  return { ...found, view };
}

/** One choice: big, two lines at most, and a 44px target. */
function Choice({ children, onClick, disabled, label }: { children: string; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
      className="mp-control flex min-h-[44px] items-center justify-center rounded-2xl bg-mp-sunken px-2 py-1 text-center text-[14px] leading-tight font-semibold text-mp-ink transition active:scale-[0.98] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * The look-back's body. `onReceipt`: the card shows a choice's receipt (with its Undo); `onHold`: keeps the look-back in
 * the card after Ease off, for its second tap, until that's answered.
 */
export function LookBackPart({ due, onReceipt, onHold }: { due: LookBackDue; onReceipt: (r: CardReceipt) => void; onHold: (held: boolean) => void }) {
  const s = useSleepMaybe();
  const { state, memberName, now } = useMaple();
  const chat = useChatNav();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  // After Ease off: the second tap, the target date a week later (the goal as Ease off saved it).
  const [eased, setEased] = useState<SleepGoal | null>(null);
  if (!s) return null;
  const goal = s.goals.find((g) => g.id === due.goal.id) ?? due.goal;
  const lb: LookBack = lookBack(goal, due.view.progress, due.week, { name: memberName });
  const write = s.goalCall;

  // Each choice's receipt, once its write saves: now, or after the refusal toast's Try again (`done`).
  const keep = async () => {
    const settle = (r: GoalSave) => {
      if (!r || !("saved" in r)) return;
      const saved = r.saved;
      // Short, so the card's one-line receipt reads in full beside its Undo (the step was named just above the tap).
      onReceipt({
        said: lb.step.current ? "Keeping this week's step" : "Looked back on the week",
        undo: async () => {
          const u = await write({ action: "goal.review", id: goal.id, revision: saved.revision, back: { at: goal.last_review_at, note: goal.review_note } });
          return !!u && "saved" in u;
        },
      });
    };
    settle(await write({ action: "goal.review", id: goal.id, revision: goal.revision, note: null }, { done: settle }));
  };

  const easeOff = async () => {
    const until = addDays(today, EASE_OFF_DAYS);
    const settle = (r: GoalSave) => {
      if (!r || !("saved" in r)) return onHold(false);
      const saved = r.saved;
      if (saved.target_date) {
        onHold(true);
        setEased(saved);
      } else onHold(false);
      onReceipt({
        // The date shows on the goal card; the card's one-line receipt keeps to the action.
        said: "Easing off a week",
        // Its own revision: a later write (the target date moved) has its own receipt and Undo, which replace this one.
        undo: async () => {
          setEased(null);
          onHold(false);
          const u = await write({ action: "goal.update", id: goal.id, revision: saved.revision, patch: { paused_until: goal.paused_until ?? null } });
          return !!u && "saved" in u;
        },
      });
    };
    // Held first: once the goal is easing off its look-back isn't due, and this part must stay for the second tap.
    onHold(true);
    settle(await write({ action: "goal.update", id: goal.id, revision: goal.revision, patch: { paused_until: until } }, { done: settle }));
  };

  const moveDate = async (g: SleepGoal) => {
    const to = addDays(g.target_date!, 7);
    const settle = (r: GoalSave) => {
      setEased(null);
      onHold(false);
      if (!r || !("saved" in r)) return;
      const saved = r.saved;
      onReceipt({
        said: `Target date ${dateWords(to, today)}`,
        undo: async () => {
          const u = await write({ action: "goal.update", id: g.id, revision: saved.revision, patch: { target_date: g.target_date } });
          return !!u && "saved" in u;
        },
      });
    };
    settle(await write({ action: "goal.update", id: g.id, revision: g.revision, patch: { target_date: to } }, { done: settle }));
  };

  const nextStep = async () => {
    const { current, following } = lb.step;
    // No step planned after this one: the chat helps choose it (its sleep tools load for a family with a goal).
    if (!current || !following) {
      chat.ask({ prompt: lb.prompt, label: "Sleep goal" });
      return;
    }
    const stepped = await write({ action: "goal.step", id: goal.id, step: current.id, done: true }, { done: (r) => void rest(r) });
    await rest(stepped);
  };
  /** Next step after its step is marked done (now, or after Try again): the next one comes into this week, the review, the receipt. */
  const rest = async (done: GoalSave) => {
    const { current, following, bringTo } = lb.step;
    if (!current || !following || !done || !("saved" in done)) return;
    let at = done.saved;
    // The next planned step comes into this week.
    if (bringTo) {
      const steps = at.steps.map((x) => ({ id: x.id, title: x.title, week_of: x.id === following.id ? bringTo : x.week_of }));
      const moved = await write({ action: "goal.update", id: goal.id, revision: at.revision, patch: { steps } });
      if (moved && "saved" in moved) at = moved.saved;
    }
    const reviewed = await write({ action: "goal.review", id: goal.id, revision: at.revision, note: null });
    const last = reviewed && "saved" in reviewed ? reviewed.saved : at;
    onReceipt({
      said: `Next step: ${following.title}`,
      undo: async () => {
        let rev = last.revision;
        if (reviewed && "saved" in reviewed) {
          const u = await write({ action: "goal.review", id: goal.id, revision: rev, back: { at: goal.last_review_at, note: goal.review_note } });
          if (!u || !("saved" in u)) return false;
          rev = u.saved.revision;
        }
        if (bringTo) {
          const steps = goal.steps.map((x) => ({ id: x.id, title: x.title, week_of: x.week_of }));
          const u = await write({ action: "goal.update", id: goal.id, revision: rev, patch: { steps } });
          if (!u || !("saved" in u)) return false;
        }
        const u = await write({ action: "goal.step", id: goal.id, step: current.id, done: false });
        return !!u && "saved" in u;
      },
    });
  };

  if (eased) {
    const to = addDays(eased.target_date!, 7);
    return (
      <section aria-labelledby="look-back-move" data-look-back className="space-y-2 border-t border-mp-line pt-3">
        <h4 id="look-back-move" className={cx(tone.heading, "text-[15px] leading-snug")}>
          Move the target date a week later?
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <Choice disabled={s.busy} onClick={() => void moveDate(eased)}>{`Yes, to ${dateWords(to, today)}`}</Choice>
          <Choice
            onClick={() => {
              setEased(null);
              onHold(false);
              // Its question goes: focus on the card's heading, not the top of the page.
              focusNext("#look-back", "#last-night");
            }}
          >{`Keep ${dateWords(eased.target_date!, today)}`}</Choice>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="look-back" data-look-back className="space-y-2 border-t border-mp-line pt-3">
      <h4 id="look-back" className={cx(tone.heading, "text-[15px] leading-snug")}>
        {lb.title}
      </h4>
      <ul className="space-y-1 text-[13px] leading-snug text-mp-ink">
        {lb.targets.map((t) => (
          <li key={t.id} className="break-words">
            <span className="font-semibold">{t.label}:</span> {t.line}
          </li>
        ))}
        <li className="break-words">
          <span className="font-semibold">This week&apos;s step:</span> {lb.step.current ? lb.step.current.title : "every step is done"}
        </li>
        {lb.checkins && lb.checkins.length > 0 && (
          <li className="break-words">
            <span className="font-semibold">Check-ins:</span> {lb.checkins.map((c) => `${memberName(c.member)} ${c.line}`).join(" · ")}
          </li>
        )}
      </ul>
      <section aria-labelledby="look-back-ask" className="space-y-2">
        <h5 id="look-back-ask" className={cx(tone.heading, "text-[14px]")}>
          This week&apos;s step?
        </h5>
        <div className={cx("grid gap-2", lb.enough ? "grid-cols-3" : "grid-cols-2")}>
          <Choice disabled={s.busy} onClick={() => void keep()}>
            Keep it
          </Choice>
          <Choice disabled={s.busy} onClick={() => void easeOff()}>
            Ease off a week
          </Choice>
          {lb.enough && (
            <Choice disabled={s.busy} label={lb.step.following ? `Next step: ${lb.step.following.title}` : "Next step: ask Maple"} onClick={() => void nextStep()}>
              Next step
            </Choice>
          )}
        </div>
        {!lb.enough && <p className={cx(tone.muted, "text-[12px] leading-snug")}>Next step waits for a week with three nights logged or answered.</p>}
      </section>
    </section>
  );
}

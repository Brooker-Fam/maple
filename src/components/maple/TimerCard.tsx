"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { adminActsAs } from "@/lib/maple/insights";
import { atBreastOf, feedPartWords, milkWords, planUnitsOf } from "@/lib/maple/describe";
import { minutesText, nursingRuns, staleFeed } from "@/lib/maple/feed";
import { amountText, type NurseStep, type PlanUnit } from "@/lib/maple/feeding-plan";
import { nightFeedLine } from "@/lib/maple/guidelines/sleep";
import { DEFAULT_TZ, formatDuration, formatTime, localParts } from "@/lib/maple/time";
import type { Entry, EntryOf, FeedData, Side, TimerKind } from "@/lib/maple/types";
import { useBabyWords, useVoice } from "./familyWords";
import { namedMilk, type OneTapLog, type StepAction } from "./feeding/nextFeed";
import { actionPreset, usePlanLog, usePlanNow, type PlanNow } from "./feeding/usePlanNow";
import { fixPreset, KIND_TITLE, LiveBlock, PartRows, SIDE_NAME, timerNumbers, useCompact, useStillGoing, type FixExpand, type FixTarget, type TimerNumbers } from "./FeedParts";
import { Icon, KindBadge, type IconName } from "./icons";
import Lantern from "./Lantern";
import { useNightActive } from "./nightLook";
import { SIDE_COLOR, SIDE_INK } from "./palette";
import { useSheets } from "./sheets";
import { useClusterInfo } from "./sheets/ClusterInfoSheet";
import { holdTodayTaps } from "./tapShield";
import { Button, cx, tone } from "./ui";
import { ApiError, useMaple, useNow } from "./useMaple";
import { useTimerActions } from "./useTimerActions";

/**
 * A running timer (nursing, sleep, tummy time, pumping) on the Today screen.
 *
 * Going back and forth (both sides, not tracked) is a part like a side:
 * "Both sides · 6:14–6:52 · 38 min" in the rows, "Both sides · since 6:14"
 * live, with a line under it that opens the Cluster feeding sheet. The …
 * menu always offers back and forth (or, while both, "She's on the Left /
 * Right" to track sides again).
 *
 * The card shows what happened and is where you fix it: one labelled row per
 * part of a feed (a side or a break), then the live part with its clock, then
 * Fix times. It has no timer buttons of its own: Switch, Pause, Resume, Done
 * and Woke up live in the dock (tummy time and pumping keep a Done here,
 * since the dock has no tile for them). A timer left running past a sensible
 * length turns into a "Still nursing?" prompt, so a forgotten tap doesn't
 * become a nine-hour feed in the log. During a nursing feed between 10 PM
 * and 6 AM (the family's timezone) it says quietly what to do if the
 * parent gets sleepy (guidelines/sleep.ts nightFeedLine, NICHD's two
 * options); no notice, nothing sent.
 *
 * A nursing feed's own parts sit in one row of small chips above Edit times
 * (FeedExtras): the nipple shield, on or off, and milk at the breast, which
 * opens the bottle form for it and, once logged, says what was given ("20 ml
 * in the SNS") and opens it to change.
 */

export { SIDE_COLOR, SIDE_NAME, timerNumbers };
export { doneText, useTimerActions } from "./useTimerActions";
/** Filled "switch to" buttons, with text that stays readable on each. */
export const SWITCH_STYLE: Record<Side, { bg: string; fg: string }> = {
  L: { bg: SIDE_COLOR.L, fg: SIDE_INK.L },
  R: { bg: SIDE_COLOR.R, fg: SIDE_INK.R },
};

const VIA: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", muse: "Muse", grok: "Grok", mcp: "Claude", chat: "Maple chat" };
/** What a Discard would lose, for "Discard 20 min of sleep?" (a timed feed says "nursing"). */
const DISCARD_WHAT: Record<TimerKind, string> = { feed: "feeding", sleep: "sleep", tummy: "tummy time", pump: "pumping" };

const ICON_BTN = "flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-2 transition active:scale-95 disabled:opacity-40";

/** Keeps a just-opened menu clear of the dock and tab bar (the dock publishes its height). */
const CLEAR_DOCK = "scroll-mt-4 scroll-mb-[calc(var(--maple-dock-h,0px)+72px+env(safe-area-inset-bottom))]";

/** Scroll a just-opened menu into view if the dock covers it (instantly with reduced motion or at night). */
function revealAboveDock(el: HTMLElement | null) {
  if (!el) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("maple-night");
  el.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
}

/** True once `on` has lasted `ms`: a quick round trip doesn't flash a "saving…" label. */
function useSlow(on: boolean, ms: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!on) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(t);
  }, [on, ms]);
  return on && slow;
}

/**
 * `ask`: a question about this timer from elsewhere, right under its header,
 * where a short phone still shows it above the dock (the sleep plan's
 * "Woke at 6:30 AM?" for a sleep timer left running overnight).
 */
export default function TimerCard({ entry, ask }: { entry: Entry; ask?: ReactNode }) {
  const { state, memberLabel, isNight, readOnly, timerBusy, toasts } = useMaple();
  const w = useBabyWords();
  const v = useVoice();
  const { open, current: sheetOpen } = useSheets();
  const now = useNow(1000);
  const actions = useTimerActions();
  const night = useNightActive();
  const compact = useCompact();
  // Viewers just watch the clock. And until the server answers a start, the
  // timer has a temporary id the API can't act on, so its fixes wait.
  const pending = entry.id < 0;
  // A tap from this phone still on its way (Switch, Pause, a toast chip): fixes wait for its answer too, so
  // Fix times never pins this phone's early copy and then reads the server's version as someone else's change.
  const saving = !pending && timerBusy(entry.id);
  // A Fix times tap made while that tap is out (Switch, then Fix times at once): it opens when the answer is in.
  const [fixLater, setFixLater] = useState<{ target: FixTarget; expand?: FixExpand; seen: Set<number> } | null>(null);
  const savingSlow = useSlow(saving, 400) || (saving && !!fixLater);
  const controls = !readOnly;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const kind = entry.kind as TimerKind;
  const n = timerNumbers(entry, now);
  const isFeed = kind === "feed" && n.parts.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const [lantern, setLantern] = useState(false);
  const clusterInfo = useClusterInfo();
  // The care team's feeding plan beside the timer: the plan's feed and its next step (usePlanNow, as the card reads it).
  const rp = runningPlan(usePlanNow(), entry);
  const parts = useFeedParts(entry);
  const planNext = rp?.next ?? null;
  const menuWrap = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // The … menu floats over the card (so the clock never jumps) and closes on Escape or a tap anywhere else.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      menuBtn.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (menuWrap.current && !menuWrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [menuOpen]);

  // "Still nursing?" once the side she's on has run long, "Still on a break?" after a long break; other timers by wall
  // time. The same test turns the dock's Done (and the Lantern's) into "when did she finish?".
  const { forgotten, snooze } = useStillGoing(entry, n, now);

  // Never drop a Fix times tap made while this phone's own tap is out: it opens once the answer is in, pinned on the
  // server's version (the entry here is already that answer). If another sheet opened meanwhile, that one was the later tap.
  const openFix = (target: FixTarget, expand?: FixExpand) => {
    if (pending) return;
    if (saving) setFixLater({ target, expand, seen: new Set(toasts.map((t) => t.id)) });
    else open({ kind: entry.kind, entry, preset: fixPreset(target, expand) });
  };
  useEffect(() => {
    if (!fixLater || saving) return;
    setFixLater(null);
    // The tap didn't happen (its failure toast, the one non-timer toast since, says why and offers the way on): that
    // toast is the answer, and a sheet opening over it would hide it.
    const failed = toasts.some((t) => !fixLater.seen.has(t.id) && t.group !== "timer" && t.tone !== "ok");
    if (!sheetOpen && !failed) open({ kind: entry.kind, entry, preset: fixPreset(fixLater.target, fixLater.expand) });
  }, [fixLater, saving, sheetOpen, entry, open, toasts]);
  // Waits (disabled) only while the timer is still starting; a tap that's out just says "saving…" and queues the open.
  const waiting = pending;

  // Who started it, under the title ("Started by Brittany"), only when it names someone other than the viewer (never "Admin").
  const name = memberLabel(entry.created_by);
  const via = !name && entry.created_by === "admin" && state && !adminActsAs(state.baby, state.members) ? VIA[entry.source] : undefined;
  const starter = name ? `Started by ${name}` : via ? `Started from ${via}` : null;

  // Discard asks first once the timer has run 2 minutes: what would go, in the card's own minutes.
  const discardQuestion =
    n.wallSec < 120 ? null : n.totalMin > 0 ? `Discard ${minutesText(n.totalMin)} of ${isFeed ? "nursing" : DISCARD_WHAT[kind]}?` : `Discard this ${isFeed ? "feed" : DISCARD_WHAT[kind]}?`;

  // Every part before the live one (the open side or the open break).
  const past = isFeed ? n.parts.slice(0, -1) : [];
  const title = isFeed ? (n.paused ? "Nursing · paused" : "Nursing") : KIND_TITLE[kind];
  const canLantern = kind === "feed" || kind === "sleep";
  // A nursing feed at night, 10 PM to 6 AM where the family lives: someone to sit with you, or the bassinet.
  const hour = localParts(now, tz).hour;
  const nightFeed = isFeed && !n.paused && controls && (hour >= 22 || hour < 6);
  const ownDone = kind === "tummy" || kind === "pump";

  const fixButton = (
    <button
      type="button"
      disabled={waiting}
      aria-busy={!!fixLater || undefined}
      onClick={() => openFix("current")}
      className={cx(
        // A filled well like the app's other secondary buttons (an outline here was the only one in the app).
        "inline-flex w-full items-center justify-center gap-2 rounded-[14px] bg-mp-sunken text-[15px] font-semibold text-mp-ink transition active:bg-mp-ink/10 disabled:opacity-50",
        "[.maple-night_&]:bg-[rgb(224_169_59/0.1)] [.maple-night_&]:text-[#E8A23F]",
        compact ? "min-h-[44px]" : "min-h-[48px]"
      )}
    >
      <Icon name="pencil" size={16} />
      {pending ? "Edit times · starting…" : savingSlow ? "Edit times · saving…" : "Edit times"}
    </button>
  );

  return (
    <motion.section
      layout={!night}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      aria-label={`${title} timer`}
      className={cx(tone.card, compact ? "p-[14px]" : "p-4", menuOpen && "relative z-20")}
    >
      <div className={cx("flex items-center gap-3", compact ? "min-h-[40px]" : "min-h-[44px]")}>
        <KindBadge kind={kind} size={28} />
        {/* Who started it sits in the header's own height (a second line, not a footer under the clock), so the card still clears the dock on short screens. */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] leading-tight font-semibold text-mp-ink">{title}</p>
          {starter && <p className="truncate text-[12px] leading-tight text-mp-ink-2">{starter}</p>}
        </div>
        {controls && (
          <div className="-my-2 -mr-2 flex shrink-0 items-center">
            {/* At night the 3am feature says its name (a labelled pill in the same 44px hit area); by day it's just the lamp. */}
            {canLantern && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setLantern(true)}
                aria-label="Lantern: dim full-screen timer that keeps the screen on"
                className={night ? "flex h-11 shrink-0 items-center justify-center text-mp-ink-2 transition active:scale-95 disabled:opacity-40" : ICON_BTN}
              >
                {/* (Snug: "Nursing · paused" still fits beside it at 375 px.) */}
                {night ? (
                  <span className="inline-flex min-h-[36px] items-center gap-1 rounded-full border border-[rgb(224_169_59/0.35)] px-2.5 text-[13px] font-semibold">
                    <Icon name="lamp" size={17} />
                    Lantern
                  </span>
                ) : (
                  <Icon name="lamp" size={21} />
                )}
              </button>
            )}
            <div ref={menuWrap} className="relative">
              <button
                ref={menuBtn}
                type="button"
                disabled={pending}
                onClick={() => setMenuOpen((m) => !m)}
                aria-expanded={menuOpen}
                aria-label="More timer options"
                className={cx(ICON_BTN, menuOpen && "bg-mp-sunken text-mp-ink")}
              >
                <Icon name="ellipsis" size={22} strokeWidth={2.25} />
              </button>
              <AnimatePresence>
                {menuOpen && !pending && (
                  <TimerMenu
                    key="menu"
                    entry={entry}
                    n={n}
                    close={() => setMenuOpen(false)}
                    actions={actions}
                    confirm={discardQuestion}
                    onInfo={() => clusterInfo.open()}
                    onSwitchEarlier={() => openFix("current", "switch")}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      {ask && <div className="mt-2 empty:hidden">{ask}</div>}

      {past.length > 0 && (
        <>
          <div className="mt-2">
            <PartRows
              parts={past}
              mode="card"
              fold
              // A short phone folds two or more past parts into one row (Left, Right, then back and forth is the usual case).
              tight={compact}
              tz={tz}
              readOnly={!controls}
              disabled={waiting}
              onPick={(p) => (p.kind === "side" ? openFix({ ref: p.ref }) : openFix({ breakAfter: p.before }))}
            />
          </div>
          <div aria-hidden className="my-2 h-px bg-mp-line" />
        </>
      )}

      {forgotten ? (
        <ForgottenPrompt
          entry={entry}
          n={n}
          tz={tz}
          onSnooze={snooze}
          onEarlier={() => openFix("current", "finished")}
          onSwitchEarlier={() => openFix("current", "switch")}
          onBackOn={() => openFix("current", "backOn")}
          onDone={() => void actions.stop(entry)}
          stale={entry.kind === "feed" && n.paused && staleFeed(entry as Entry & { data: FeedData }, now)}
          compact={compact}
          disabled={waiting}
          className={past.length ? "mt-1" : "mt-3"}
        />
      ) : (
        <>
          <div className={past.length ? undefined : "mt-2"}>
            <LiveBlock entry={entry} n={n} tz={tz} onPick={() => openFix("current")} disabled={waiting} readOnly={!controls} compact={compact} />
          </div>
          {/* The plan's feed and what comes after the nursing ("Nurse + SNS · then pump 15 min"), on every phone. */}
          {isFeed && rp?.line && (
            <p data-plan-line className={cx("text-[13px] font-medium text-mp-ink-2 [overflow-wrap:anywhere]", compact ? "leading-[15px]" : "mt-0.5 leading-snug")}>
              {rp.line}
            </p>
          )}
          {isFeed && n.paused && controls && (
            <p className={cx("text-[13px] text-mp-ink-2", compact ? "leading-[15px]" : "mt-1 leading-snug")}>
              {n.both ? `When ${w.he} latches, tap Back on in the dock below.` : `When ${w.he} latches, tap ${w.his} side in the dock below.`}
            </p>
          )}
          {nightFeed && (
            <p data-night-feed className={cx("text-[13px] text-mp-ink-2", compact ? "leading-[15px]" : "mt-1 leading-snug")}>
              {nightFeedLine(v)}
            </p>
          )}
          {/*
            Going back and forth: no Switch taps, and one tap to what the sources say about it (the Cluster
            feeding sheet). On a short screen it's the … menu's "About back and forth" instead, so the card
            and the Since tiles still clear the dock.
          */}
          {isFeed && n.both && !n.paused && !compact && controls && (
            <button
              type="button"
              onClick={() => clusterInfo.open()}
              aria-label={`No need to tap Switch while ${w.he} goes back and forth. About back and forth`}
              className="-mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-1.5 rounded-xl px-2 text-left text-[13px] text-mp-ink-2 active:bg-mp-ink/5"
            >
              <span className="min-w-0 flex-1 truncate">No need to tap Switch.</span>
              <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-mp-accent-fg">
                <Icon name="info" size={15} />
                About back and forth
              </span>
            </button>
          )}
          {/* The feed's own parts: small chips, never a primary button (the dock has those). */}
          {isFeed && <FeedExtras entry={entry as EntryOf<"feed">} controls={controls} disabled={waiting} compact={compact} parts={parts} plan={rp} />}
          {/*
            The plan's next step while the pump runs, when it's a bottle: one parent pumps while the other gives it, so it's
            here, above the dock, not only on the card further down.
          */}
          {kind === "pump" && planNext && controls && (
            <div data-plan-timer className={compact ? "mt-2.5" : "mt-3"}>
              <Button
                variant="soft"
                size="lg"
                disabled={pending}
                className={cx("w-full", compact && "min-h-[44px]!")}
                aria-label={`Next: ${planNext.kind === "form" ? planNext.aria : "Log bottle: opens the bottle form"}`}
                onClick={() => open({ kind: "feed", preset: actionPreset(planNext) ?? { method: "bottle" } })}
              >
                <Icon name="bottle" size={19} />
                Next: {planNext.kind === "form" ? planNext.label : "Log bottle"}
              </Button>
            </div>
          )}
          {controls &&
            (ownDone ? (
              <div className={cx("flex gap-2", compact ? "mt-2.5" : "mt-3")}>
                <div className="flex-1">{fixButton}</div>
                <Button size="lg" disabled={pending} onClick={() => void actions.stop(entry)} className={cx("flex-1", compact ? "min-h-[44px]!" : "min-h-[48px]!")}>
                  <Icon name="check" size={19} strokeWidth={2.1} />
                  Done
                </Button>
              </div>
            ) : (
              <div className={compact ? "mt-2.5" : "mt-3"}>{fixButton}</div>
            ))}
        </>
      )}

      {lantern && controls && <Lantern entry={entry} onClose={() => setLantern(false)} dim={isNight()} />}
      {clusterInfo.sheet}
    </motion.section>
  );
}

/** A small chip: a 44px target around a quiet pill. */
const CHIP_HIT = "group flex min-h-[44px] shrink-0 items-center disabled:opacity-45";
const CHIP =
  "inline-flex min-h-[32px] items-center gap-1 rounded-full px-3 text-[13px] font-semibold transition group-active:scale-[0.97] group-disabled:group-active:scale-100";

/**
 * What the feeding plan says beside a running timer (usePlanNow, the reading
 * the Next feed card and the dock share): for a nursing feed the plan's feed,
 * its line ("Nurse + SNS · then pump 15 min") and its milk at the breast (the
 * plan's own action for it, while it's still to log); for a pump, the next
 * step when it's a bottle.
 */
type RunningPlan = {
  feedId: string;
  unit: PlanUnit;
  line: string | null;
  supplement: NurseStep["supplement"] | null;
  milk: StepAction | null;
  next: StepAction | null;
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function runningPlan(p: PlanNow | null, entry: Entry): RunningPlan | null {
  if (!p) return null;
  const focus = p.fp.focus;
  if (focus.state !== "underway") return null;
  const isThis = (e: { id: number }) => e.id === entry.id;
  const base = { feedId: focus.feed.id, unit: p.plan.unit, line: null, supplement: null, milk: null, next: null };
  if (entry.kind === "feed") {
    if (!focus.group?.run?.entries.some(isThis)) return null;
    const i = focus.steps.findIndex((s) => s.step.do === "nurse");
    const step = i >= 0 ? (focus.steps[i].step as NurseStep) : null;
    const row = i >= 0 ? p.rows[i] : null;
    const then = p.rows.slice(i + 1).find((r) => r.state !== "note" && r.state !== "done");
    const milk = row ? ([row.action, row.secondary].find((a) => !!actionPreset(a)) ?? null) : null;
    return { ...base, line: `${focus.feed.name}${then ? ` · then ${lowerFirst(then.text)}` : ""}`, supplement: step?.supplement ?? null, milk };
  }
  if (entry.kind === "pump") {
    const i = focus.steps.findIndex((s) => s.step.do === "pump" && s.entries.some(isThis));
    if (i < 0) return null;
    // One parent pumps while the other gives the bottle: the bottle after it has its action already.
    return { ...base, next: p.rows.slice(i + 1).map((r) => r.action).find((a) => !!actionPreset(a)) ?? null };
  }
  return null;
}

/**
 * A nursing feed's parts while she's on: the nipple shield, a toggle saved on
 * the feed itself (data.shield, a PATCH made against the version this phone
 * shows: if a tap or the other phone changed the feed first, it's made once
 * more on what's there now, else it says it wasn't saved), the milk at the
 * breast and top-ups given with it, and the newest milk given at the breast
 * (how it went in and how much, for the next one's form without a plan).
 * Shared by the card's chips and its … menu.
 */
function useFeedParts(entry: Entry) {
  const { state, update, toast, now: clock } = useMaple();
  // The shield as tapped, shown at once until the server's answer is in.
  const [want, setWant] = useState<boolean | null>(null);
  const busy = useRef(false);
  const shield = want ?? (entry.kind === "feed" && !!entry.data.shield);
  const entries = state?.entries;
  // This feed's milk at the breast and top-ups (the whole feed: a side started again within 10 minutes is the same one).
  const given = useMemo(() => {
    if (!entries || entry.kind !== "feed") return [];
    return nursingRuns(entries, clock()).find((r) => r.entries.some((e) => e.id === entry.id))?.topUps ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `clock` is the server-corrected now; the log decides it.
  }, [entries, entry.id, entry.kind]);
  const last = useMemo(() => entries?.find((e): e is EntryOf<"feed"> => e.kind === "feed" && e.data.method === "bottle" && !!atBreastOf(e.data)) ?? null, [entries]);

  const setShield = async (next: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setWant(next);
    const save = (base: Entry) => update(base.id, { data: { shield: next ? true : null }, expect_updated_at: base.updated_at }, { toast: "", throwOnError: true });
    try {
      try {
        await save(entry);
      } catch (err) {
        // Changed since this phone's copy (a tap of its own, the other phone): the shield is its own field, so once more on the feed as it is now.
        const latest = err instanceof ApiError && err.status === 409 ? (err.body as { entry?: Entry } | null)?.entry : undefined;
        if (!latest || latest.id !== entry.id || latest.kind !== "feed") throw err;
        if (!!latest.data.shield === next) return;
        await save(latest);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) toast("The feed just changed on another phone, so the shield wasn't saved. Tap it again.", { tone: "info" });
      else if (err instanceof ApiError) toast(err.status < 500 ? err.message : "The shield wasn't saved. Try again in a moment.", { tone: "error" });
      else toast("You're offline, so the shield wasn't saved. Try again when you're back online.", { tone: "error" });
    } finally {
      busy.current = false;
      setWant(null);
    }
  };

  /** The milk at the breast's form as last time (by syringe unless the last one went in an SNS, its amount and milk), tied to this feed. */
  const lastTimeMilk = (planFeed: string | null): Record<string, unknown> => ({
    method: "bottle",
    via: (last && atBreastOf(last.data)) ?? "syringe",
    ...(last?.data.amount_ml != null ? { amount_ml: last.data.amount_ml } : {}),
    ...(last?.data.milk ? { milk: last.data.milk } : {}),
    ...(planFeed ? { plan: planFeed } : {}),
    top_up_of: entry.id,
  });
  const atBreast = given.filter((b) => atBreastOf(b.data));
  return { shield, setShield, given, atBreast, lastTimeMilk };
}
type FeedPartsNow = ReturnType<typeof useFeedParts>;

/**
 * A nursing feed's parts while she's on (the chips' row), on every nursing
 * feed, plan or not (a family going off the plan still needs them): the nipple
 * shield, filled while it's on; the milk at the breast given with it, each
 * saying what was given ("20 ml in the SNS") and opening it to change; and the
 * milk at the breast still to give. When the plan's feed has milk at the
 * breast, that chip is the plan's: "+ 20 ml SNS" in one tap when its amount is
 * one number and its milk is named, the two milk choices when only the milk
 * isn't, else the bottle form with the plan's amount and way, all tied to this
 * feed and the plan's feed. Otherwise "Milk at the breast" opens the form as
 * last time (by syringe unless the last one went in an SNS, its amount and
 * milk). Viewers see what's on, with nothing to tap.
 */
function FeedExtras({ entry, controls, disabled, compact, parts, plan }: { entry: EntryOf<"feed">; controls: boolean; disabled: boolean; compact: boolean; parts: FeedPartsNow; plan: RunningPlan | null }) {
  const { state, units } = useMaple();
  const { open } = useSheets();
  const logOne = usePlanLog();
  const logging = useRef(false);
  const [busy, setBusy] = useState(false);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const { shield, given, atBreast } = parts;

  if (!controls && !shield && !given.length) return null;

  // The plan's milk at the breast in one tap: once (a double tap waits for the first), and the page under the thumb holds.
  const logPlan = (l: OneTapLog) => {
    if (logging.current) return;
    logging.current = true;
    setBusy(true);
    holdTodayTaps();
    void logOne(l).finally(() => {
      logging.current = false;
      setBusy(false);
    });
  };
  const sup = plan?.supplement ?? null;
  // "+ 20 ml SNS", "+ 15–20 ml syringe": the plan's amount and way.
  const planWords = sup ? `${amountText(sup.ml, plan!.unit)} ${sup.via === "sns" ? "SNS" : "syringe"}` : "";
  const planForm = () => open({ kind: "feed", preset: actionPreset(plan?.milk) ?? { method: "bottle", via: sup!.via, amount_ml: sup!.ml.min, milk: namedMilk(sup!.milk) ?? null, plan: plan!.feedId, top_up_of: entry.id } });

  return (
    <div role="group" aria-label="With this feed" className={cx("-mb-1.5 flex flex-wrap items-center gap-x-2", compact ? "mt-0.5" : "mt-1")}>
      {controls ? (
        <button type="button" disabled={disabled} aria-pressed={shield} aria-label="Nipple shield" onClick={() => void parts.setShield(!shield)} className={CHIP_HIT}>
          {/* On is the filled pill; off is an outline. */}
          <span className={cx(CHIP, shield ? "bg-mp-accent text-mp-on-accent" : "text-mp-ink-2 ring-[1.5px] ring-mp-ink-2/35 ring-inset")}>
            {shield && <Icon name="check" size={14} strokeWidth={2.4} />}
            Shield
          </span>
        </button>
      ) : (
        shield && (
          <span className={cx(CHIP, "my-1.5 bg-mp-sunken text-mp-ink-2")}>
            <Icon name="check" size={14} strokeWidth={2.4} />
            Shield
          </span>
        )
      )}
      {given.map((b) => {
        // "20 ml in the SNS", "Milk in the syringe", "30 ml top-up": the row's words for it, without the "+".
        const part = feedPartWords(b, units, planUnitsOf(state?.baby.settings)).slice(2);
        const words = part.charAt(0).toUpperCase() + part.slice(1);
        const more = [milkWords(b.data, units), b.data.via === "paced" ? "paced bottle" : null].filter(Boolean).join(" · ");
        return (
          <button
            key={b.id}
            type="button"
            onClick={() => open({ kind: "feed", entry: b })}
            aria-label={`${controls && b.id > 0 ? "Edit: " : ""}${words}${more ? ` · ${more}` : ""}, at ${formatTime(b.started_at, tz)}`}
            className={CHIP_HIT}
          >
            <span className={cx(CHIP, "bg-mp-sunken text-mp-ink")}>
              {words}
              {controls && <Icon name="chevron-right" size={13} className="-mr-1 text-mp-ink-3" />}
            </span>
          </button>
        );
      })}
      {controls &&
        !atBreast.length &&
        (!sup ? (
          <button type="button" disabled={disabled} onClick={() => open({ kind: "feed", preset: parts.lastTimeMilk(plan?.feedId ?? null) })} className={CHIP_HIT}>
            <span className={cx(CHIP, "bg-mp-sunken text-mp-ink-2")}>
              <Icon name="plus" size={14} strokeWidth={2.2} />
              Milk at the breast
            </span>
          </button>
        ) : plan?.milk?.kind === "log" ? (
          <MilkChip label={planWords} aria={plan.milk.log.aria} disabled={disabled || busy} onClick={() => logPlan((plan.milk as Extract<StepAction, { kind: "log" }>).log)} />
        ) : plan?.milk?.kind === "choose" ? (
          // The plan's amount and way, its milk not named: formula or breast milk, one tap each. The words end this row
          // and the two choices take the next one together, at any width (each choice's name says the whole thing).
          <>
            <span aria-hidden className="flex min-h-[44px] items-center text-[13px] font-semibold text-mp-ink-2">
              + {planWords}:
            </span>
            <span aria-hidden className="h-0 basis-full" />
            {plan.milk.options.map((o) => (
              <button key={o.label} type="button" disabled={disabled || busy} onClick={() => logPlan(o)} aria-label={o.aria} className={CHIP_HIT}>
                <span className={cx(CHIP, "bg-mp-sunken text-mp-ink")}>{o.label}</span>
              </button>
            ))}
          </>
        ) : (
          <MilkChip label={planWords} aria={`${planWords}: opens the bottle form`} disabled={disabled || busy} onClick={planForm} />
        ))}
    </div>
  );
}

/** The plan's milk at the breast still to give: "+ 20 ml SNS". */
function MilkChip({ label, aria, disabled, onClick }: { label: string; aria: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={aria} className={CHIP_HIT}>
      <span className={cx(CHIP, "bg-mp-sunken text-mp-ink")}>
        <Icon name="plus" size={14} strokeWidth={2.2} />
        {label}
      </span>
    </button>
  );
}

type Actions = ReturnType<typeof useTimerActions>;

/** A Discard tap this soon after the question appeared is the first tap's double, not an answer. */
const CONFIRM_ARM_MS = 600;

/**
 * The … menu: a small card anchored under the button, floating over the
 * timer. A timed feed always offers back and forth here ("Back and forth ·
 * Stop tracking sides from now"; on a break, back on going back and forth);
 * while she goes both, "She's on the Left / Right" track sides again, and
 * "About back and forth" opens the Cluster feeding sheet. Discard on a timer
 * that has run a while asks first, in place ("Discard 20 min of nursing?"),
 * since it sits right under Fell asleep.
 */
function TimerMenu({
  entry,
  n,
  close,
  actions,
  confirm,
  onInfo,
  onSwitchEarlier,
}: {
  entry: Entry;
  n: TimerNumbers;
  close: () => void;
  actions: Actions;
  confirm: string | null;
  onInfo: () => void;
  onSwitchEarlier: () => void;
}) {
  const w = useBabyWords();
  const ref = useRef<HTMLDivElement>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  // The question takes the menu's place: focus moves to Keep, the safe answer.
  useEffect(() => {
    if (askedAt !== null) ref.current?.querySelector<HTMLButtonElement>("[data-keep]")?.focus();
  }, [askedAt]);
  const discard = () => {
    close();
    void actions.discard(entry);
  };
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.14 }}
      // A card low on the screen (an alert above it) would open its menu under the dock.
      onAnimationComplete={(def) => (def as { opacity?: number }).opacity === 1 && revealAboveDock(ref.current)}
      style={{ transformOrigin: "top right" }}
      role="group"
      aria-label="Timer options"
      className={cx(
        "absolute top-full right-0 z-20 mt-1 w-[260px] overflow-hidden rounded-2xl border border-mp-line bg-mp-surface shadow-[0_10px_30px_rgba(0,0,0,0.16)] [.maple-night_&]:shadow-none",
        CLEAR_DOCK,
        tone.divide
      )}
    >
      {askedAt !== null && confirm ? (
        <div className="px-4 py-3">
          <p className="text-[15px] leading-snug font-semibold text-mp-ink">{confirm}</p>
          <p className="mt-0.5 text-[13px] text-mp-ink-2">It goes to Recently removed.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="danger" onClick={() => performance.now() - askedAt >= CONFIRM_ARM_MS && discard()} className="flex-1">
              Discard
            </Button>
            <button type="button" data-keep onClick={close} className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl bg-mp-sunken px-4 text-[15px] font-semibold text-mp-ink transition active:scale-[0.98]">
              Keep
            </button>
          </div>
        </div>
      ) : (
        <>
          {entry.kind === "feed" && n.parts.length > 0 && !n.paused && !n.both && (
            <MenuItem
              icon="arrow-left-right"
              label="Switch earlier"
              sub="Record when you changed sides"
              onClick={() => { close(); onSwitchEarlier(); }}
            />
          )}
          {entry.kind === "feed" && n.parts.length > 0 &&
            (n.both ? (
              <>
                {/* One row, two answers: the menu stays short enough to clear the dock on a small phone. */}
                <div className="flex min-h-[60px] items-center gap-2 px-4 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold text-mp-ink">Track sides</span>
                    <span className="block text-[13px] text-mp-ink-2">{n.paused ? "Back on the…" : `${w.Hes} on the…`}</span>
                  </span>
                  {(["L", "R"] as Side[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-label={`${w.Hes} ${n.paused ? "back " : ""}on the ${SIDE_NAME[s]}: track sides again from now`}
                      onClick={() => {
                        close();
                        void actions.trackSides(entry, s);
                      }}
                      className="inline-flex min-h-[44px] min-w-[52px] shrink-0 items-center justify-center rounded-xl bg-mp-sunken px-2.5 text-[14px] font-semibold text-mp-ink active:scale-[0.97] [.maple-night_&]:text-[#E8A23F]"
                    >
                      {SIDE_NAME[s]}
                    </button>
                  ))}
                </div>
                <MenuItem
                  icon="info"
                  label="About back and forth"
                  sub="What's normal, who to ask"
                  onClick={() => {
                    close();
                    onInfo();
                  }}
                />
              </>
            ) : (
              <MenuItem
                icon="arrow-left-right"
                label={n.paused ? "Back on, back and forth" : "Back and forth"}
                sub={n.paused ? "Both sides from now, no Switch taps" : "Stop tracking sides from now"}
                onClick={() => {
                  close();
                  void actions.backAndForth(entry);
                }}
              />
            ))}
          {entry.kind === "feed" && (
            <MenuItem
              icon="moon"
              label="Fell asleep"
              sub="Stop the feed and start sleep now"
              onClick={() => {
                close();
                void actions.fellAsleep(entry);
              }}
            />
          )}
          <MenuItem icon="trash-2" label="Discard" sub="Started by mistake" danger onClick={() => (confirm ? setAskedAt(performance.now()) : discard())} />
        </>
      )}
    </motion.div>
  );
}

function MenuItem({ icon, label, sub, onClick, danger }: { icon: IconName; label: string; sub: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cx(tone.row, "min-h-[56px] py-2.5")}>
      <Icon name={icon} size={20} className={cx("shrink-0", danger ? "text-mp-danger" : "text-mp-ink-2")} />
      <span className="min-w-0">
        <span className={cx("block text-[15px] font-semibold", danger ? "text-mp-danger" : "text-mp-ink")}>{label}</span>
        <span className="block text-[13px] text-mp-ink-2">{sub}</span>
      </span>
    </button>
  );
}

/**
 * "Still nursing?" after a long side, "Still on a break?" after a long
 * break, "Still asleep?" and friends for the other timers. It takes the place
 * of the live block and Fix times (the past rows stay above it).
 *
 * The break's likeliest story is that she went back on and nobody tapped, so
 * its primary is "She's back on…" (Fix times with the sides showing); "Still
 * on a break" and "She's done" sit under it, and the dock hint stays.
 */
function ForgottenPrompt({
  entry,
  n,
  tz,
  onSnooze,
  onEarlier,
  onSwitchEarlier,
  onBackOn,
  onDone,
  stale,
  compact,
  disabled,
  className,
}: {
  entry: Entry;
  n: TimerNumbers;
  tz: string;
  onSnooze: () => void;
  onEarlier: () => void;
  onSwitchEarlier: () => void;
  onBackOn: () => void;
  onDone: () => void;
  /** On a break over an hour (staleFeed, the dock's "New feed"): the next latch is a new feed, so ending this one leads. */
  stale?: boolean;
  compact?: boolean;
  /** A timer still starting: the fix buttons wait for it (a tap still on its way queues them instead, see openFix). */
  disabled?: boolean;
  className?: string;
}) {
  const w = useBabyWords();
  const kind = entry.kind as TimerKind;
  const isFeed = kind === "feed" && n.parts.length > 0;
  const lastSide = [...n.parts].reverse().find((p) => p.kind === "side");
  let question: string;
  let sub: string;
  let primary: { label: string; onClick: () => void };
  const btn = compact ? "min-h-[44px]!" : undefined;
  if (isFeed && n.paused) {
    const ends = formatTime(n.current.since, tz).replace(/\s[AP]M$/i, "");
    return (
      <div className={className}>
        <p className={cx(tone.heading, "leading-tight", compact ? "text-[20px]" : "text-[22px]")}>Still on a break?</p>
        <p className={cx("text-sm text-mp-ink-2 tabular-nums", compact ? "mt-0.5" : "mt-1")}>
          Since {formatTime(n.current.since, tz)} ({minutesText(n.current.min)})
          {lastSide?.kind === "side" ? ` · ${lastSide.side === "B" ? "back and forth" : SIDE_NAME[lastSide.side]} ${minutesText(lastSide.min)}` : ""}
        </p>
        {stale ? (
          <>
            {/* Over an hour: she's most likely done, and the dock's sides now start a new feed, so ending this one leads. */}
            <Button size="lg" onClick={onDone} aria-label={`${w.Hes} done: end the feed at ${formatTime(n.current.since, tz)}, when the break began`} className={cx("w-full", compact ? "mt-2.5" : "mt-4", btn)}>
              {w.Hes} done · ends {ends}
            </Button>
            <div className="mt-2 flex gap-2">
              <Button variant="soft" size="lg" disabled={disabled} onClick={onBackOn} className={cx("flex-1 px-2 text-[15px]", btn)}>
                Same feed, back on…
              </Button>
              <Button variant="soft" size="lg" onClick={onSnooze} className={cx("flex-1 px-2 text-[15px]", btn)}>
                Still on a break
              </Button>
            </div>
            <p className={cx("text-[13px] text-mp-ink-2", compact ? "mt-1.5 leading-[15px]" : "mt-2 leading-snug")}>When {w.he} latches, tap {w.his} side in the dock to start a new feed.</p>
          </>
        ) : (
          <>
            <Button size="lg" disabled={disabled} onClick={onBackOn} className={cx("w-full", compact ? "mt-2.5" : "mt-4", btn)}>
              {w.Hes} back on…
            </Button>
            <div className="mt-2 flex gap-2">
              <Button variant="soft" size="lg" onClick={onSnooze} className={cx("flex-1 px-2 text-[15px]", btn)}>
                Still on a break
              </Button>
              {/* Done while paused ends the feed at the pause, as the dock's Done says ("ends 4:10" under it, like the tile). */}
              <Button variant="soft" size="lg" onClick={onDone} aria-label={`${w.Hes} done: end the feed at ${formatTime(n.current.since, tz)}, when the break began`} className={cx("flex-1 px-2 text-[15px]", btn)}>
                <span className="flex flex-col items-center leading-tight">
                  <span>{w.Hes} done</span>
                  <span className="text-[12px] font-normal text-mp-ink-2 tabular-nums">ends {ends}</span>
                </span>
              </Button>
            </div>
            <p className={cx("text-[13px] text-mp-ink-2", compact ? "mt-1.5 leading-[15px]" : "mt-2 leading-snug")}>When {w.he} latches, tap {w.his} side in the dock below.</p>
          </>
        )}
      </div>
    );
  }
  if (isFeed) {
    question = "Still nursing?";
    // The feed's start only when it's another time (on a one-side feed it's the side's own start, said once).
    const since = formatTime(n.current.since, tz);
    const began = formatTime(entry.started_at, tz);
    sub = `${n.both ? "Back and forth" : `${SIDE_NAME[n.current.side ?? "L"]} side`} for ${minutesText(n.current.min)}, since ${since}${began === since ? "" : ` · feed started ${began}`}`;
    primary = { label: `${w.He} finished earlier…`, onClick: onEarlier };
  } else {
    question = kind === "sleep" ? "Still asleep? Lucky you." : kind === "tummy" ? "Still doing tummy time?" : "Still pumping?";
    sub = `The timer says ${formatDuration(n.wallSec)}, since ${formatTime(entry.started_at, tz)}.`;
    primary = { label: "Ended earlier…", onClick: onEarlier };
  }
  return (
    <div className={className}>
      <p className={cx(tone.heading, "text-[22px] leading-tight")}>{question}</p>
      <p className="mt-1 text-sm text-mp-ink-2 tabular-nums">{sub}</p>
      {isFeed && !n.both && (
        <Button size="lg" disabled={disabled} onClick={onSwitchEarlier} className={cx("mt-3 w-full", btn)}>
          Switch earlier…
        </Button>
      )}
      <div className={cx("flex gap-2", compact ? "mt-3" : "mt-4")}>
        <Button variant="soft" size="lg" onClick={onSnooze} className={cx("flex-1", btn)}>
          Still going
        </Button>
        <Button variant={isFeed && !n.both ? "soft" : "primary"} size="lg" disabled={disabled} onClick={primary.onClick} className={cx("flex-[1.4]", btn)}>
          {primary.label}
        </Button>
      </div>
    </div>
  );
}

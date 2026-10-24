"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { adminActsAs } from "@/lib/maple/insights";
import { minutesText } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatDuration, formatTime } from "@/lib/maple/time";
import type { Entry, Side, TimerKind } from "@/lib/maple/types";
import { fixPreset, KIND_TITLE, LiveBlock, PartRows, SIDE_NAME, timerNumbers, useCompact, type FixExpand, type FixTarget, type TimerNumbers } from "./FeedParts";
import { Icon, KindBadge, type IconName } from "./icons";
import Lantern from "./Lantern";
import { useNightActive } from "./nightLook";
import { SIDE_COLOR, SIDE_INK } from "./palette";
import { useSheets } from "./sheets";
import { Button, cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";
import { useTimerActions } from "./useTimerActions";

/**
 * A running timer (nursing, sleep, tummy time, pumping) on the Today screen.
 *
 * The card shows what happened and is where you fix it: one labelled row per
 * part of a feed (a side or a break), then the live part with its clock, then
 * Fix times. It has no timer buttons of its own: Switch, Pause, Resume, Done
 * and Woke up live in the dock (tummy time and pumping keep a Done here,
 * since the dock has no tile for them). A timer left running past a sensible
 * length turns into a "Still nursing?" prompt, so a forgotten tap doesn't
 * become a nine-hour feed in the log.
 */

export { SIDE_COLOR, SIDE_NAME, timerNumbers };
export { doneText, useTimerActions } from "./useTimerActions";
/** Filled "switch to" buttons, with text that stays readable on each. */
export const SWITCH_STYLE: Record<Side, { bg: string; fg: string }> = {
  L: { bg: SIDE_COLOR.L, fg: SIDE_INK.L },
  R: { bg: SIDE_COLOR.R, fg: SIDE_INK.R },
};

/** UX defaults (not health rules): when a running timer asks "still going?". Family settings can override. */
const CHECK_AFTER_MIN: Record<TimerKind, number> = { feed: 45, sleep: 300, tummy: 30, pump: 60 };
/** A break this long asks "Still on a break?". */
const CHECK_BREAK_MIN = 20;
const SNOOZE_MIN = 30;
const SNOOZE_KEY = "maple-timer-snooze";
const VIA: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", mcp: "Claude" };

function readSnoozes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

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

export default function TimerCard({ entry }: { entry: Entry }) {
  const { state, memberLabel, isNight, readOnly, timerBusy } = useMaple();
  const { open } = useSheets();
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
  const savingSlow = useSlow(saving, 400);
  const controls = !readOnly;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const kind = entry.kind as TimerKind;
  const n = timerNumbers(entry, now);
  const isFeed = kind === "feed" && n.parts.length > 0;
  const [menuOpen, setMenuOpen] = useState(false);
  const [lantern, setLantern] = useState(false);
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});
  const menuWrap = useRef<HTMLDivElement>(null);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => setSnoozes(readSnoozes()), []);

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

  // "Still nursing?" once the side she's on has run long, "Still on a break?" after a long break; other timers by wall time.
  const settings = (state?.baby.settings ?? {}) as Record<string, unknown>;
  const checkMin = Number(settings[`timer_check_${kind}_min`]) || CHECK_AFTER_MIN[kind];
  const longSec = isFeed ? (n.paused ? n.current.sec / 60 >= CHECK_BREAK_MIN : n.current.sec / 60 >= checkMin) : n.wallSec / 60 >= checkMin;
  const snoozedUntil = snoozes[String(entry.id)] ?? 0;
  const forgotten = controls && !pending && longSec && now.getTime() > snoozedUntil;

  const snooze = () => {
    const next = { ...readSnoozes(), [String(entry.id)]: now.getTime() + SNOOZE_MIN * 60_000 };
    // Drop stale snoozes so the key never grows.
    for (const [k, v] of Object.entries(next)) if (v < now.getTime() - 86_400_000) delete next[k];
    try {
      localStorage.setItem(SNOOZE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the snooze lasts until reload
    }
    setSnoozes(next);
  };

  const openFix = (target: FixTarget, expand?: FixExpand) => {
    if (pending || saving) return;
    open({ kind: entry.kind, entry, preset: fixPreset(target, expand) });
  };
  // Disabled-looking only once a tap has been out a moment (taps are ignored meanwhile either way).
  const waiting = pending || savingSlow;

  // Who started it, under the title ("Started by Brittany"), only when it names someone other than the viewer (never "Admin").
  const name = memberLabel(entry.created_by);
  const via = !name && entry.created_by === "admin" && state && !adminActsAs(state.baby, state.members) ? VIA[entry.source] : undefined;
  const starter = name ? `Started by ${name}` : via ? `Started from ${via}` : null;

  // Every part before the live one (the open side or the open break).
  const past = isFeed ? n.parts.slice(0, -1) : [];
  const title = isFeed ? (n.paused ? "Nursing · paused" : "Nursing") : KIND_TITLE[kind];
  const canLantern = kind === "feed" || kind === "sleep";
  const ownDone = kind === "tummy" || kind === "pump";

  const fixButton = (
    <button
      type="button"
      disabled={waiting}
      onClick={() => openFix("current")}
      className={cx(
        "inline-flex w-full items-center justify-center gap-2 rounded-[14px] border border-mp-line text-[15px] font-semibold text-mp-ink transition active:bg-mp-ink/5 disabled:opacity-50",
        "[.maple-night_&]:border-[rgb(224_169_59/0.35)] [.maple-night_&]:text-[#E8A23F]",
        compact ? "min-h-[44px]" : "min-h-[48px]"
      )}
    >
      <Icon name="pencil" size={16} />
      {pending ? "Fix times · starting…" : savingSlow ? "Fix times · saving…" : "Fix times"}
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
            {canLantern && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setLantern(true)}
                aria-label="Lantern: dim full-screen timer that keeps the screen on"
                className={ICON_BTN}
              >
                <Icon name="lamp" size={21} />
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
              <AnimatePresence>{menuOpen && !pending && <TimerMenu key="menu" entry={entry} close={() => setMenuOpen(false)} actions={actions} />}</AnimatePresence>
            </div>
          </div>
        )}
      </div>

      {past.length > 0 && (
        <>
          <div className="mt-2">
            <PartRows
              parts={past}
              mode="card"
              fold
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
          onBackOn={() => openFix("current", "backOn")}
          onDone={() => void actions.stop(entry)}
          compact={compact}
          disabled={waiting}
          className={past.length ? "mt-1" : "mt-3"}
        />
      ) : (
        <>
          <div className={past.length ? undefined : "mt-2"}>
            <LiveBlock entry={entry} n={n} tz={tz} onPick={() => openFix("current")} disabled={waiting} readOnly={!controls} compact={compact} />
          </div>
          {isFeed && n.paused && controls && (
            <p className={cx("text-[13px] text-mp-ink-2", compact ? "leading-[15px]" : "mt-1 leading-snug")}>When she latches, tap her side in the dock below.</p>
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
    </motion.section>
  );
}

type Actions = ReturnType<typeof useTimerActions>;

/** The … menu: a small card anchored under the button, floating over the timer. */
function TimerMenu({ entry, close, actions }: { entry: Entry; close: () => void; actions: Actions }) {
  const ref = useRef<HTMLDivElement>(null);
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
      <MenuItem
        icon="trash-2"
        label="Discard"
        sub="Started by mistake"
        danger
        onClick={() => {
          close();
          void actions.discard(entry);
        }}
      />
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
  onBackOn,
  onDone,
  compact,
  disabled,
  className,
}: {
  entry: Entry;
  n: TimerNumbers;
  tz: string;
  onSnooze: () => void;
  onEarlier: () => void;
  onBackOn: () => void;
  onDone: () => void;
  compact?: boolean;
  /** A tap still on its way: the fix buttons wait for it. */
  disabled?: boolean;
  className?: string;
}) {
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
          {lastSide?.kind === "side" ? ` · ${SIDE_NAME[lastSide.side]} ${minutesText(lastSide.min)}` : ""}
        </p>
        <Button size="lg" disabled={disabled} onClick={onBackOn} className={cx("w-full", compact ? "mt-2.5" : "mt-4", btn)}>
          She&apos;s back on…
        </Button>
        <div className="mt-2 flex gap-2">
          <Button variant="soft" size="lg" onClick={onSnooze} className={cx("flex-1 px-2 text-[15px]", btn)}>
            Still on a break
          </Button>
          {/* Done while paused ends the feed at the pause, as the dock's Done says ("ends 4:10" under it, like the tile). */}
          <Button variant="soft" size="lg" onClick={onDone} aria-label={`She's done: end the feed at ${formatTime(n.current.since, tz)}, when the break began`} className={cx("flex-1 px-2 text-[15px]", btn)}>
            <span className="flex flex-col items-center leading-tight">
              <span>She&apos;s done</span>
              <span className="text-[12px] font-normal text-mp-ink-2 tabular-nums">ends {ends}</span>
            </span>
          </Button>
        </div>
        <p className={cx("text-[13px] text-mp-ink-2", compact ? "mt-1.5 leading-[15px]" : "mt-2 leading-snug")}>When she latches, tap her side in the dock below.</p>
      </div>
    );
  }
  if (isFeed) {
    question = "Still nursing?";
    sub = `${SIDE_NAME[n.current.side ?? "L"]} side for ${minutesText(n.current.min)}, since ${formatTime(n.current.since, tz)} · feed started ${formatTime(entry.started_at, tz)}`;
    primary = { label: "She finished earlier…", onClick: onEarlier };
  } else {
    question = kind === "sleep" ? "Still asleep? Lucky you." : kind === "tummy" ? "Still doing tummy time?" : "Still pumping?";
    sub = `The timer says ${formatDuration(n.wallSec)}, since ${formatTime(entry.started_at, tz)}.`;
    primary = { label: "Ended earlier…", onClick: onEarlier };
  }
  return (
    <div className={className}>
      <p className={cx(tone.heading, "text-[22px] leading-tight")}>{question}</p>
      <p className="mt-1 text-sm text-mp-ink-2 tabular-nums">{sub}</p>
      <div className={cx("flex gap-2", compact ? "mt-3" : "mt-4")}>
        <Button variant="soft" size="lg" onClick={onSnooze} className={cx("flex-1", btn)}>
          Still going
        </Button>
        <Button size="lg" disabled={disabled} onClick={primary.onClick} className={cx("flex-[1.4]", btn)}>
          {primary.label}
        </Button>
      </div>
    </div>
  );
}

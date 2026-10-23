"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { tick } from "@/components/atlas/haptics";
import { feedTotals, openSegment, other, suggestNextSide } from "@/lib/maple/feed";
import { addDays, dayKey, DEFAULT_TZ, formatClock, formatDuration, formatTime, localParts, parseDayKey, zonedTimeToUtc } from "@/lib/maple/time";
import type { Entry, FeedData, Side, TimerKind } from "@/lib/maple/types";
import Lantern from "./Lantern";
import { useNightActive } from "./nightLook";
import { useSheets } from "./sheets";
import { cx, tone } from "./ui";
import { useMaple, useNow } from "./useMaple";

/**
 * A running timer (nursing, sleep, tummy time, pumping) on the Today screen,
 * plus the timer actions the dock and the lantern share.
 *
 * Done saves straight away (no sheet) and the toast offers Undo, which puts the
 * timer back exactly as it was. A timer left running past a sensible length
 * turns into a "Still nursing?" prompt so a forgotten tap doesn't become a
 * nine-hour feed in the log.
 */

export const SIDE_NAME: Record<Side, string> = { L: "Left", R: "Right" };
export const SIDE_COLOR: Record<Side, string> = { L: "#B5452B", R: "#E0A93B" };
/** Filled "switch to" buttons, with text that stays readable on each (rust takes white, honey takes ink). */
export const SWITCH_STYLE: Record<Side, { bg: string; fg: string }> = { L: { bg: "#B5452B", fg: "#FFFFFF" }, R: { bg: "#E0A93B", fg: "#2A1A08" } };

const KIND_TITLE: Record<TimerKind, string> = { feed: "Nursing", sleep: "Asleep", tummy: "Tummy time", pump: "Pumping" };
const KIND_ICON: Record<TimerKind, string> = { feed: "🤱", sleep: "🌙", tummy: "🐢", pump: "🫙" };
const KIND_ACCENT: Record<TimerKind, string> = { feed: "#D9772B", sleep: "#8E7CB0", tummy: "#6B8448", pump: "#C98E78" };

/** UX defaults (not health rules): when a running timer asks "still going?". Family settings can override. */
const CHECK_AFTER_MIN: Record<TimerKind, number> = { feed: 60, sleep: 300, tummy: 30, pump: 60 };
const SNOOZE_MIN = 30;
const SNOOZE_KEY = "maple-timer-snooze";

const mins = (sec: number) => Math.max(0, Math.round(sec / 60));

/** "Nursed 18m (L 11 · R 7) · Right next time" and friends, for the Done toast. */
export function doneText(e: Entry, now: Date): { text: string; emoji: string } {
  const dur = e.ended_at ? (Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000 : 0;
  if (e.kind === "feed" && e.data.method === "breast") {
    const t = feedTotals(e.data, now);
    const sides = [t.left >= 30 ? `L ${mins(t.left)}` : "", t.right >= 30 ? `R ${mins(t.right)}` : ""].filter(Boolean).join(" · ");
    const next = suggestNextSide(e.data);
    return {
      text: `Nursed ${formatDuration(t.total)}${sides ? ` (${sides})` : ""}${next ? ` · ${SIDE_NAME[next]} next time` : ""}`,
      emoji: "🤱",
    };
  }
  if (e.kind === "sleep") return { text: `Slept ${formatDuration(dur)}`, emoji: "😴" };
  if (e.kind === "tummy") return { text: `Tummy time ${formatDuration(dur)}`, emoji: "🐢" };
  if (e.kind === "pump") return { text: `Pumped ${formatDuration(dur)}`, emoji: "🫙" };
  return { text: "Saved", emoji: "🍁" };
}

/** A clock time typed into <input type="time">, as the most recent such moment (today, or yesterday if that's still ahead). */
export function pickedTime(hhmm: string, now: Date, tz: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  const key = dayKey(now, tz);
  const d = parseDayKey(key);
  let t = zonedTimeToUtc(d.year, d.month, d.day, Number(m[1]), Number(m[2]), tz);
  if (t.getTime() > now.getTime() + 60_000) {
    const y = parseDayKey(addDays(key, -1));
    t = zonedTimeToUtc(y.year, y.month, y.day, Number(m[1]), Number(m[2]), tz);
  }
  return t;
}

export function clockValue(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Timer actions shared by the dock, the timer card and the lantern, with the
 * rules between timers: starting a feed ends a running nap; starting sleep
 * during a feed offers to stop the feed too.
 */
export function useTimerActions() {
  const { state, timer, toast, api, refresh, now, memberName, restore } = useMaple();
  const { open } = useSheets();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const me = state?.me.email;
  const entries = state?.entries;

  const running = useCallback((kind: TimerKind) => entries?.find((e) => e.active && e.kind === kind) ?? null, [entries]);

  /** Put a just-stopped (or just-discarded) timer back to running. */
  const reopen = useCallback(
    async (e: Entry) => {
      try {
        await api("timer", { method: "POST", body: JSON.stringify({ action: "reopen", id: e.id }) });
      } catch (err) {
        toast(err instanceof Error ? err.message : "Couldn't restart that timer", { tone: "error" });
      } finally {
        await refresh();
      }
    },
    [api, refresh, toast]
  );

  const stop = useCallback(
    async (e: Entry, at?: Date) => {
      tick();
      const saved = await timer({ action: "stop", id: e.id, at: at?.toISOString() });
      // A 409 (someone else stopped it first) already said so in its own toast.
      if (!saved || saved.active || (saved.updated_by && saved.updated_by !== me)) return saved;
      const d = doneText(saved, now());
      toast(at ? `${d.text} · ended ${formatTime(saved.ended_at ?? at, tz)}` : d.text, {
        emoji: d.emoji,
        undo: () => void reopen(saved),
        actions: [{ label: "Edit", onClick: () => open({ kind: saved.kind, entry: saved }) }],
      });
      return saved;
    },
    [me, now, open, reopen, timer, toast, tz]
  );

  const adjust = useCallback(
    async (e: Entry, at: Date) => {
      const saved = await timer({ action: "adjust", id: e.id, at: at.toISOString() });
      if (saved?.active) {
        toast(`Start moved to ${formatTime(saved.started_at, tz)}`, {
          emoji: "🕰️",
          undo: () => void timer({ action: "adjust", id: e.id, at: e.started_at }),
        });
      }
    },
    [timer, toast, tz]
  );

  /** Right after a start: one tap if she'd actually started a few minutes earlier. */
  const offerEarlier = useCallback(
    (e: Entry, what: string, emoji: string) => {
      if (!e.active || e.id < 0) return;
      const from = Date.parse(e.started_at);
      toast(`${what} · started earlier?`, {
        emoji,
        actions: [5, 10].map((m) => ({ label: `${m} min ago`, onClick: () => void adjust(e, new Date(from - m * 60_000)) })),
      });
    },
    [adjust, toast]
  );

  const startFeed = useCallback(
    async (side: Side) => {
      tick();
      const nap = running("sleep");
      if (nap && nap.id > 0) {
        const s = await timer({ action: "stop", id: nap.id });
        if (s && !s.active && s.ended_at) {
          toast(`Nap ended (${formatDuration((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000)})`, {
            emoji: "😴",
            undo: () => void reopen(s),
          });
        }
      }
      const wasRunning = !!running("feed");
      const s = await timer({ action: "start", kind: "feed", side });
      if (s && !wasRunning) offerEarlier(s, `${SIDE_NAME[side]} side`, "🤱");
      return s;
    },
    [offerEarlier, reopen, running, timer, toast]
  );

  const startTimer = useCallback(
    async (kind: Exclude<TimerKind, "feed">) => {
      tick();
      const feed = kind === "sleep" ? running("feed") : null;
      const wasRunning = !!running(kind);
      const s = await timer({ action: "start", kind });
      if (feed && feed.id > 0 && s) {
        toast("Stop the feed too?", {
          emoji: "🌙",
          actions: [
            { label: "Yes, she fell asleep", onClick: () => void stop(feed, new Date(s.started_at)) },
            { label: "Keep both", onClick: () => {} },
          ],
        });
      } else if (s && !wasRunning) {
        offerEarlier(s, KIND_TITLE[kind], KIND_ICON[kind]);
      }
      return s;
    },
    [offerEarlier, running, stop, timer, toast]
  );

  /** Fell asleep at the breast: stop the feed and start sleep at the same instant. */
  const fellAsleep = useCallback(
    async (feed: Entry) => {
      tick();
      const at = now();
      const stopped = await timer({ action: "stop", id: feed.id, at: at.toISOString() });
      if (!stopped || stopped.active) return;
      const s = await timer({ action: "start", kind: "sleep" });
      if (s && Math.abs(Date.parse(s.started_at) - at.getTime()) > 1500) {
        await timer({ action: "adjust", id: s.id, at: at.toISOString() });
      }
      const d = doneText(stopped, now());
      toast(`${d.text} · sleep timer on`, {
        emoji: "🌙",
        undo: async () => {
          if (s) await timer({ action: "discard", id: s.id });
          await reopen(stopped);
        },
      });
    },
    [now, reopen, timer, toast]
  );

  const switchSide = useCallback(
    (e: Entry, side: Side) => {
      tick();
      return timer({ action: "switch", id: e.id, side });
    },
    [timer]
  );
  const pause = useCallback(
    (e: Entry) => {
      tick();
      return timer({ action: "pause", id: e.id });
    },
    [timer]
  );
  const resume = useCallback(
    (e: Entry, side: Side) => {
      tick();
      return timer({ action: "resume", id: e.id, side });
    },
    [timer]
  );


  const discard = useCallback(
    async (e: Entry) => {
      const gone = await timer({ action: "discard", id: e.id });
      if (!gone) return;
      toast(`${KIND_TITLE[e.kind as TimerKind] ?? "Timer"} discarded`, {
        emoji: "🍂",
        // A discarded timer comes back running (or stopped, with its own toast,
        // if another one started meanwhile), so there's nothing to reopen.
        undo: () => void restore(e.id),
      });
    },
    [restore, timer, toast]
  );

  return { running, startFeed, startTimer, stop, fellAsleep, switchSide, pause, resume, adjust, discard, reopen, memberName };
}

function readSnoozes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

/** Live numbers for a running timer. */
export function timerNumbers(e: Entry, now: Date) {
  const wallSec = Math.max(0, (now.getTime() - Date.parse(e.started_at)) / 1000);
  if (e.kind === "feed" && e.data.method === "breast") {
    const d = e.data as FeedData;
    const open = openSegment(d.segments);
    const t = feedTotals(d, now);
    const lastEnd = d.segments?.length ? d.segments[d.segments.length - 1].end : null;
    const side: Side = open?.side ?? d.last_side ?? "L";
    return {
      elapsed: t.total,
      wallSec,
      left: t.left,
      right: t.right,
      side,
      paused: !open,
      pausedSec: !open && lastEnd ? Math.max(0, (now.getTime() - Date.parse(lastEnd)) / 1000) : 0,
      lastSegStart: d.segments?.length ? Date.parse(d.segments[d.segments.length - 1].start) : Date.parse(e.started_at),
    };
  }
  return { elapsed: wallSec, wallSec, left: 0, right: 0, side: null as Side | null, paused: false, pausedSec: 0, lastSegStart: Date.parse(e.started_at) };
}

export default function TimerCard({ entry }: { entry: Entry }) {
  const { state, memberName, member, isNight, readOnly } = useMaple();
  const now = useNow(1000);
  const actions = useTimerActions();
  const night = useNightActive();
  // Viewers just watch the clock. And until the server answers a start, the
  // timer has a temporary id the API can't act on, so its controls wait.
  const pending = entry.id < 0;
  const controls = !readOnly;
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const kind = entry.kind as TimerKind;
  const n = timerNumbers(entry, now);
  const isFeed = kind === "feed";
  const accent = isFeed ? SIDE_COLOR[n.side ?? "L"] : KIND_ACCENT[kind];
  const [menu, setMenu] = useState<null | "menu" | "adjust">(null);
  const [lantern, setLantern] = useState(false);
  const [snoozes, setSnoozes] = useState<Record<string, number>>({});
  const [ending, setEnding] = useState(false);

  useEffect(() => setSnoozes(readSnoozes()), []);

  const settings = (state?.baby.settings ?? {}) as Record<string, unknown>;
  const checkMin = Number(settings[`timer_check_${kind}_min`]) || CHECK_AFTER_MIN[kind];
  const snoozedUntil = snoozes[String(entry.id)] ?? 0;
  const forgotten = controls && !pending && n.wallSec / 60 >= checkMin && now.getTime() > snoozedUntil;

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
    setEnding(false);
  };

  const who = member(entry.created_by);
  const startedBy = entry.created_by && entry.created_by !== state?.me.email ? `started by ${memberName(entry.created_by)}` : memberName(entry.created_by);
  const target = n.side ? other(n.side) : "L";
  const title = isFeed ? `Nursing · ${SIDE_NAME[n.side ?? "L"]}` : KIND_TITLE[kind];
  const canLantern = kind === "feed" || kind === "sleep";

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      aria-label={`${title} timer`}
      className={cx(tone.card, "relative overflow-hidden p-4 [.maple-night_&]:border-[#E0A93B]/10 [.maple-night_&]:bg-[#11140F]")}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 [.maple-night_&]:opacity-50" style={{ backgroundColor: accent }} />
      <div className="flex items-start justify-between gap-2 pl-1">
        <div className="min-w-0">
          <p className={cx(tone.label, "flex items-center gap-1.5 [.maple-night_&]:text-[#E0A93B]/70")}>
            <span aria-hidden className="text-base leading-none">
              {KIND_ICON[kind]}
            </span>
            {title}
            {isFeed && (
              <span
                aria-hidden
                className="ml-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white [.maple-night_&]:opacity-60"
                style={{ backgroundColor: SIDE_COLOR[n.side ?? "L"] }}
              >
                {n.side}
              </span>
            )}
          </p>
        </div>
        {controls && (
          <div className="-mt-1.5 -mr-1.5 flex shrink-0 items-center">
            {canLantern && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setLantern(true)}
                aria-label="Lantern: dim full-screen timer that keeps the screen on"
                className="flex h-11 w-11 items-center justify-center rounded-full text-xl transition hover:bg-[#1D4420]/5 active:scale-95 disabled:opacity-40 dark:hover:bg-[#F5EDDF]/10"
              >
                🏮
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() => setMenu((m) => (m ? null : "menu"))}
              aria-expanded={!!menu}
              aria-label="More timer options"
              className={cx(
                "flex h-11 w-11 items-center justify-center rounded-full text-xl font-bold tracking-tight transition active:scale-95 disabled:opacity-40",
                menu ? "bg-[#1D4420]/10 dark:bg-[#F5EDDF]/15" : "hover:bg-[#1D4420]/5 dark:hover:bg-[#F5EDDF]/10",
                tone.body
              )}
            >
              ⋯
            </button>
          </div>
        )}
      </div>

      <AnimatePresence initial={false}>
        {menu && controls && !pending && <TimerMenu key="menu" entry={entry} view={menu} setView={setMenu} tz={tz} now={now} actions={actions} />}
      </AnimatePresence>

      {forgotten ? (
        <ForgottenPrompt entry={entry} n={n} now={now} tz={tz} ending={ending} setEnding={setEnding} onSnooze={snooze} actions={actions} />
      ) : (
        <>
          <div className={cx("pl-1", controls ? "mt-1" : "mt-3")}>
            <p
              className={cx(
                "font-[family-name:var(--font-display)] text-[48px] leading-none font-semibold tracking-tight lining-nums tabular-nums transition-opacity",
                "text-[#1D4420] dark:text-[#F5EDDF] [.maple-night_&]:text-[#E0A93B]/85",
                n.paused && "opacity-50"
              )}
            >
              {formatClock(n.elapsed)}
            </p>
            {n.paused && (
              <p className="mt-1 text-sm font-semibold text-[#9A6B12] tabular-nums dark:text-[#E0C27A] [.maple-night_&]:text-[#E0A93B]/70">
                Paused {formatClock(n.pausedSec)}
              </p>
            )}
            {isFeed && (
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <p className={cx(tone.body, "text-[15px] tabular-nums [.maple-night_&]:text-[#E0A93B]/70")}>
                  <span className={cx(n.side === "L" && !n.paused ? "font-bold" : "opacity-75")}>L {formatClock(n.left)}</span>
                  <span className="mx-1.5 opacity-50">·</span>
                  <span className={cx(n.side === "R" && !n.paused ? "font-bold" : "opacity-75")}>R {formatClock(n.right)}</span>
                </p>
                {!n.paused && controls && (
                  // Pause is secondary: most feeds just switch and finish.
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void actions.pause(entry)}
                    className={cx(tone.muted, "-my-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-sm font-semibold hover:bg-[#1D4420]/5 disabled:opacity-40 dark:hover:bg-[#F5EDDF]/10")}
                  >
                    <span aria-hidden className="inline-flex gap-[3px]">
                      <i className="h-3 w-[3px] rounded-sm bg-current" />
                      <i className="h-3 w-[3px] rounded-sm bg-current" />
                    </span>
                    Pause
                  </button>
                )}
              </div>
            )}
            <p className={cx(tone.muted, "mt-1 flex items-center gap-1 text-[13px] [.maple-night_&]:text-[#E0A93B]/55")}>
              {controls && !pending ? (
                // Tap to fix the start ("she'd started five minutes before I tapped").
                <button
                  type="button"
                  onClick={() => setMenu((m) => (m === "adjust" ? null : "adjust"))}
                  aria-expanded={menu === "adjust"}
                  aria-label={`Started ${formatTime(entry.started_at, tz)}. Change the start time`}
                  className="-my-2 -ml-1.5 inline-flex min-h-[44px] items-center gap-1 rounded-full px-1.5 underline decoration-dotted underline-offset-4 hover:bg-[#1D4420]/5 dark:hover:bg-[#F5EDDF]/10"
                >
                  since {formatTime(entry.started_at, tz)}
                  <span aria-hidden className="text-[11px] no-underline">
                    ✎
                  </span>
                </button>
              ) : (
                <>since {formatTime(entry.started_at, tz)}</>
              )}{" "}
              · {startedBy}
              {who?.emoji && <span aria-hidden>{who.emoji}</span>}
              {pending && <span className="ml-1 italic opacity-80">· starting…</span>}
            </p>
          </div>

          {controls && (
            <fieldset disabled={pending} className={cx("mt-4 flex min-w-0 gap-2 transition-opacity", pending && "opacity-50")}>
              {isFeed && !n.paused && (
                <button
                  type="button"
                  onClick={() => void actions.switchSide(entry, target)}
                  className="flex min-h-[52px] flex-[2] items-center justify-center gap-2 rounded-2xl px-3 text-[15px] font-semibold whitespace-nowrap shadow-sm transition active:scale-[0.97]"
                  style={
                    night
                      ? { backgroundColor: `${SWITCH_STYLE[target].bg}40`, color: "#E8A23F" }
                      : { backgroundColor: SWITCH_STYLE[target].bg, color: SWITCH_STYLE[target].fg }
                  }
                >
                  <span aria-hidden>⇄</span> Switch to {SIDE_NAME[target]}
                </button>
              )}
              {isFeed && n.paused && (
                <>
                  {(["L", "R"] as Side[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-label={`Resume ${SIDE_NAME[s]}`}
                      onClick={() => void actions.resume(entry, s)}
                      className="flex min-h-[52px] flex-1 flex-col items-center justify-center rounded-2xl px-2 leading-tight transition active:scale-[0.97]"
                      style={{ backgroundColor: `${SIDE_COLOR[s]}22`, boxShadow: `inset 0 0 0 1.5px ${SIDE_COLOR[s]}88` }}
                    >
                      <span className={cx(tone.muted, "text-[11px] font-semibold tracking-wide uppercase")}>Resume</span>
                      <span className={cx(tone.body, "text-[15px] font-semibold")}>
                        <span aria-hidden className="mr-1 text-[11px]">
                          ▶
                        </span>
                        {SIDE_NAME[s]}
                      </span>
                    </button>
                  ))}
                </>
              )}
              <button
                type="button"
                onClick={() => void actions.stop(entry)}
                className={cx(
                  "flex min-h-[52px] items-center justify-center gap-1.5 rounded-2xl px-4 text-[15px] font-semibold transition active:scale-[0.97]",
                  "bg-[#1D4420] text-[#FDF8F0] dark:bg-[#C49A3C] dark:text-[#14210F] [.maple-night_&]:bg-[#E0A93B]/80",
                  isFeed ? "flex-1" : "flex-[2]"
                )}
              >
                {kind === "sleep" ? (
                  <>
                    Woke up <span aria-hidden>☀️</span>
                  </>
                ) : (
                  <>
                    Done <span aria-hidden>✓</span>
                  </>
                )}
              </button>
            </fieldset>
          )}
        </>
      )}

      {lantern && controls && <Lantern entry={entry} onClose={() => setLantern(false)} dim={isNight()} />}
    </motion.section>
  );
}

type Actions = ReturnType<typeof useTimerActions>;
type Numbers = ReturnType<typeof timerNumbers>;

function TimerMenu({
  entry,
  view,
  setView,
  tz,
  now,
  actions,
}: {
  entry: Entry;
  view: "menu" | "adjust";
  setView: (v: null | "menu" | "adjust") => void;
  tz: string;
  now: Date;
  actions: Actions;
}) {
  const start = new Date(entry.started_at);
  const [pick, setPick] = useState(false);
  // Typing a time fires change events mid-entry, so nothing moves until "Set".
  const [picked, setPicked] = useState(() => clockValue(start, tz));
  const pickedAt = pickedTime(picked, now, tz);
  const move = (min: number) => {
    void actions.adjust(entry, new Date(start.getTime() - min * 60_000));
    setView(null);
  };
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="overflow-hidden"
    >
      <div className={cx(tone.inset, "mt-2 space-y-1 p-2 [.maple-night_&]:bg-[#0B0F0A]")}>
        {view === "menu" ? (
          <>
            <MenuItem icon="🕰️" label="Adjust start" sub="Forgot to tap at the start" onClick={() => setView("adjust")} />
            {entry.kind === "feed" && (
              <MenuItem
                icon="😴"
                label="Fell asleep"
                sub="Stop the feed and start sleep now"
                onClick={() => {
                  setView(null);
                  void actions.fellAsleep(entry);
                }}
              />
            )}
            <MenuItem
              icon="🍂"
              label="Discard"
              sub="Oops, didn't mean to start"
              danger
              onClick={() => {
                setView(null);
                void actions.discard(entry);
              }}
            />
          </>
        ) : (
          <div className="p-1">
            <p className={cx(tone.label, "mb-2")}>Started earlier? · now {formatTime(start, tz)}</p>
            <div className="flex flex-wrap gap-2">
              {[2, 5, 10, 15].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => move(m)}
                  className="min-h-[44px] min-w-[56px] rounded-full border border-[#1D4420]/15 bg-white/70 px-3 text-sm font-semibold text-[#1D4420] active:scale-95 dark:border-[#F5EDDF]/15 dark:bg-transparent dark:text-[#E8DCC0]"
                >
                  −{m}m
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPick((p) => !p)}
                aria-pressed={pick}
                className="min-h-[44px] rounded-full border border-[#1D4420]/15 bg-white/70 px-3 text-sm font-semibold text-[#1D4420] active:scale-95 dark:border-[#F5EDDF]/15 dark:bg-transparent dark:text-[#E8DCC0]"
              >
                Pick…
              </button>
            </div>
            {pick && (
              <div className="mt-2 flex gap-2">
                <input
                  type="time"
                  aria-label="Actual start time"
                  value={picked}
                  onChange={(e) => setPicked(e.target.value)}
                  className={cx(tone.input, "min-w-0 flex-1")}
                />
                <button
                  type="button"
                  disabled={!pickedAt}
                  onClick={() => {
                    if (!pickedAt) return;
                    void actions.adjust(entry, pickedAt);
                    setView(null);
                  }}
                  className="min-h-[48px] shrink-0 rounded-2xl bg-[#1D4420] px-5 text-[15px] font-semibold text-[#FDF8F0] active:scale-[0.97] disabled:opacity-40 dark:bg-[#C49A3C] dark:text-[#14210F]"
                >
                  Set {pickedAt ? formatTime(pickedAt, tz) : ""}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function MenuItem({ icon, label, sub, onClick, danger }: { icon: string; label: string; sub: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-2 text-left transition hover:bg-[#1D4420]/5 active:scale-[0.99] dark:hover:bg-[#F5EDDF]/5"
    >
      <span aria-hidden className="text-xl">
        {icon}
      </span>
      <span className="min-w-0">
        <span className={cx("block text-[15px] font-semibold", danger ? "text-[#9A3A24] dark:text-[#F4A68F]" : tone.body)}>{label}</span>
        <span className={cx(tone.muted, "block text-xs")}>{sub}</span>
      </span>
    </button>
  );
}

/** "Still nursing?" after a long stretch: keep going, or say when it really ended. */
function ForgottenPrompt({
  entry,
  n,
  now,
  tz,
  ending,
  setEnding,
  onSnooze,
  actions,
}: {
  entry: Entry;
  n: Numbers;
  now: Date;
  tz: string;
  ending: boolean;
  setEnding: (v: boolean) => void;
  onSnooze: () => void;
  actions: Actions;
}) {
  const kind = entry.kind as TimerKind;
  const question =
    kind === "feed" ? "Still nursing?" : kind === "sleep" ? "Still asleep? Lucky you." : kind === "tummy" ? "Still doing tummy time?" : "Still pumping?";
  // A feed most likely ended about 15 minutes into its last side.
  const suggested = kind === "feed" && n.lastSegStart + 15 * 60_000 < now.getTime() ? new Date(n.lastSegStart + 15 * 60_000) : null;
  const [choice, setChoice] = useState<Date | null>(suggested);
  const [pick, setPick] = useState(false);
  const floor = Date.parse(entry.started_at);
  const options = [
    ...(suggested ? [{ key: "s", label: `${formatTime(suggested, tz)}`, at: suggested }] : []),
    ...[10, 20, 30].map((m) => ({ key: `${m}`, label: `${m}m ago`, at: new Date(now.getTime() - m * 60_000) })),
  ].filter((o) => o.at.getTime() > floor);

  return (
    <div className="mt-1 pl-1">
      <p className={cx(tone.heading, "text-2xl [.maple-night_&]:text-[#E0A93B]/85")}>{question}</p>
      <p className={cx(tone.muted, "mt-0.5 text-sm tabular-nums [.maple-night_&]:text-[#E0A93B]/55")}>
        The timer says {formatDuration(n.wallSec)}, since {formatTime(entry.started_at, tz)}.
      </p>
      {!ending ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onSnooze}
            className="min-h-[52px] flex-1 rounded-2xl bg-[#1D4420]/[0.07] px-3 text-[15px] font-semibold text-[#1D4420] active:scale-[0.97] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
          >
            Still going
          </button>
          <button
            type="button"
            onClick={() => setEnding(true)}
            className="min-h-[52px] flex-1 rounded-2xl bg-[#1D4420] px-3 text-[15px] font-semibold text-[#FDF8F0] active:scale-[0.97] dark:bg-[#C49A3C] dark:text-[#14210F] [.maple-night_&]:bg-[#E0A93B]/80"
          >
            Ended earlier…
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className={cx(tone.label, "mb-2")}>When did it end?</p>
          <div className="flex flex-wrap gap-2">
            {options.map((o) => {
              const selected = !pick && choice && Math.abs(choice.getTime() - o.at.getTime()) < 30_000;
              return (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={!!selected}
                  onClick={() => {
                    setPick(false);
                    setChoice(o.at);
                  }}
                  className={cx(
                    "min-h-[44px] rounded-full border px-3.5 text-sm font-semibold transition active:scale-95",
                    selected
                      ? "border-[#1D4420] bg-[#1D4420] text-[#FDF8F0] dark:border-[#C49A3C] dark:bg-[#C49A3C] dark:text-[#14210F]"
                      : "border-[#1D4420]/15 bg-white/70 text-[#1D4420] dark:border-[#F5EDDF]/15 dark:bg-transparent dark:text-[#E8DCC0]"
                  )}
                >
                  {o.key === "s" ? `${o.label} · likely` : o.label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={pick}
              onClick={() => setPick(true)}
              className={cx(
                "min-h-[44px] rounded-full border px-3.5 text-sm font-semibold transition active:scale-95",
                pick
                  ? "border-[#1D4420] bg-[#1D4420] text-[#FDF8F0] dark:border-[#C49A3C] dark:bg-[#C49A3C] dark:text-[#14210F]"
                  : "border-[#1D4420]/15 bg-white/70 text-[#1D4420] dark:border-[#F5EDDF]/15 dark:bg-transparent dark:text-[#E8DCC0]"
              )}
            >
              Pick…
            </button>
          </div>
          {pick && (
            <input
              type="time"
              aria-label="When it ended"
              defaultValue={clockValue(choice ?? now, tz)}
              onChange={(e) => setChoice(pickedTime(e.target.value, now, tz))}
              className={cx(tone.input, "mt-2")}
            />
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setEnding(false)}
              className={cx(tone.body, "min-h-[52px] rounded-2xl px-4 text-sm font-semibold opacity-80 active:scale-[0.97]")}
            >
              Back
            </button>
            <button
              type="button"
              disabled={!choice}
              onClick={() => choice && void actions.stop(entry, choice)}
              className="min-h-[52px] flex-1 rounded-2xl bg-[#1D4420] px-3 text-[15px] font-semibold text-[#FDF8F0] transition active:scale-[0.97] disabled:opacity-40 dark:bg-[#C49A3C] dark:text-[#14210F] [.maple-night_&]:bg-[#E0A93B]/80"
            >
              {choice ? `Save · ended ${formatTime(choice, tz)}` : "Pick a time"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef } from "react";
import { tick } from "@/components/atlas/haptics";
import {
  CLUSTER_GAP_MS,
  edgeBounds,
  feedCtx,
  feedMinutes,
  feedParts,
  minutesShort,
  minutesText,
  nextSideFor,
  nursingRuns,
  openSegment,
  other,
  previousFeed,
  previousFeedEnd,
  SAME_FEED_MS,
  sideMinutesText,
  staleFeed,
  suggestNextSide,
  undoLastTap,
  type Moment,
  type Part,
  type TapFeedData,
} from "@/lib/maple/feed";
import { DEFAULT_TZ, formatDuration, formatMinutes, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, FeedEdit, Side, StretchSide, TimerKind, TimerResponse } from "@/lib/maple/types";
import { fixPreset, KIND_TITLE, SIDE_NAME } from "./FeedParts";
import type { IconName } from "./icons";
import { useSheets } from "./sheets";
import { useMaple, type TimerCallOptions, type TimerFailure, type ToastAction } from "./useMaple";

/**
 * Timer actions shared by the dock, the timer card, the lantern and Fix
 * times, with the rules between timers (starting a feed ends a running nap;
 * starting sleep during a feed offers to stop the feed too) and the toast
 * each tap leaves behind.
 *
 * Toasts come only from the request that made the change, so only the phone
 * that tapped sees them, and only once the server has answered: a noop
 * (already on that side, already paused) leaves none. One timer toast shows
 * at a time; its chips move the moment the tap recorded ("5 min earlier"),
 * counted from the server's value, never from the phone clock, and its
 * trailing button puts back exactly what the server says was there before.
 */

type SidePart = Extract<Part, { kind: "side" }>;

/**
 * A feed the other phone ended this recently can still be carried on from a
 * stale Resume, and a feed started this soon after the last one ended offers
 * "Back and forth" on its start toast (a cluster's next latch).
 * (SAME_FEED_MS, 10 minutes: the start toast's "Same feed as 8:30".)
 */
const CONTINUE_WITHIN_MS = CLUSTER_GAP_MS;
/** "Back and forth" joins the switch toast from a feed's second Switch. */
const OFFER_AFTER_SWITCHES = 2;

const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * "Nursed 18m (L 11 · R 7) · Left if she wants more" and friends, for the Done toast.
 * `ended` goes before the next side ("· ended 4:10, when you paused") and
 * drops the per-side minutes. With `all` (the loaded entries), the next side
 * is the one Today's card and the dock show (nextSideFor over the feeds as
 * counted): within 30 minutes of the end, the other side from the one she was
 * last on ("if she wants more"); otherwise the opposite of the side the feed
 * started on ("next time").
 */
export function doneText(e: Entry, now: Date, ended?: string, all?: readonly Entry[]): { text: string } {
  const dur = e.ended_at ? (Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000 : 0;
  if (e.kind === "feed" && e.data.method === "breast") {
    // The card's rows added up (feedMinutes), so the sides always sum to the total ("L 12 · R 9 · both 38").
    const t = feedMinutes(e, now);
    const sides = ended ? "" : sideMinutesText(t);
    const next = nextSideWords(e, now, all);
    return {
      text: `Nursed ${minutesShort(t.total)}${sides ? ` (${sides})` : ""}${ended ? ` · ${ended}` : ""}${next ? ` · ${next}` : ""}`,
    };
  }
  if (e.kind === "sleep") return { text: `Slept ${formatDuration(dur)}` };
  if (e.kind === "tummy") return { text: `Tummy time ${formatDuration(dur)}` };
  if (e.kind === "pump") return { text: `Pumped ${formatDuration(dur)}` };
  return { text: "Saved" };
}

/**
 * The next side once nursing feed `e` is in the log, as Done's toast says it:
 * "Left if she wants more", "Right next time", ", or the fuller side" after
 * back and forth (AAP; guidelines.ts NEXT_SIDE_NOTE). With `all` (the loaded
 * entries) it's the side Today's card and the dock show (nextSideFor); "" if
 * there's none to say. The feed sheet words a feed logged by minutes with it.
 */
export function nextSideWords(e: Entry, now: Date, all?: readonly Entry[]): string {
  if (e.kind !== "feed" || e.data.method !== "breast") return "";
  const ns = all ? nextSideFor(nursingRuns([...all.filter((x) => x.id !== e.id), e], now), now) : null;
  const next = ns?.side ?? suggestNextSide(e.data);
  if (!next) return "";
  const fuller = ns ? ns.fuller : feedMinutes(e, now).has.B;
  return `${SIDE_NAME[next]} ${ns?.rule === "relatch" ? "if she wants more" : "next time"}${fuller ? ", or the fuller side" : ""}`;
}

/** The side parts of a timed feed as it stands at `now` (none for anything else). */
export function sideParts(e: Entry, now: Date): SidePart[] {
  if (e.kind !== "feed" || e.data.method !== "breast" || !e.data.segments?.length) return [];
  return feedParts(e.data, feedCtx(e, now)).filter((p): p is SidePart => p.kind === "side");
}

function allParts(e: Entry, now: Date): Part[] {
  if (e.kind !== "feed" || e.data.method !== "breast" || !e.data.segments?.length) return [];
  return feedParts(e.data, feedCtx(e, now));
}

/**
 * "Back on the Left" after a break only when she came off the Left; on the other side it's "On the Right" (as the
 * sheets word it). Going back and forth: "Back on, back and forth" after a back-and-forth part, else "Back and forth".
 */
const onSide = (side: StretchSide, prev: StretchSide | undefined) =>
  side === "B" ? (prev === "B" ? "Back on, back and forth" : "Back and forth") : prev && prev !== side ? `On the ${SIDE_NAME[side]}` : `Back on the ${SIDE_NAME[side]}`;

/** The side she's on now (the open part's), or null on a break or a finished feed. */
const openSide = (e: Entry): StretchSide | null => (e.kind === "feed" && e.active ? openSegment(e.data.segments)?.side ?? null : null);
/** On a break right after going back and forth (the dock's "Track sides" / "Back on"). */
const pausedBoth = (e: Entry): boolean => e.kind === "feed" && e.active && !openSegment(e.data.segments) && e.data.segments?.at(-1)?.side === "B";

/** The pause a merged resume took back was under a minute: from when she came off to the tap (a "No break" picked later isn't). */
function shortPause(res: TimerResponse, tapped: Date): boolean {
  const off = res.before?.segments.at(-1)?.end;
  return !!off && tapped.getTime() - Date.parse(off) < 60_000;
}

/** "when you paused" for this phone's own pause, "at its pause" for the other phone's (or Claude's). */
function pauseWords(e: Entry, me: string | undefined): string {
  const tap = (e.data as TapFeedData).last_tap;
  return tap?.kind === "pause" && tap.by && me && tap.by !== me ? "at its pause" : "when you paused";
}

export function useTimerActions() {
  const { state, timerCall, timerBusy, toast, now, isNight, memberName, restore, dismissTimerToast, holdTimerToasts } = useMaple();
  const me = state?.me.email;
  const { open } = useSheets();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const entries = state?.entries;

  const running = useCallback((kind: TimerKind) => entries?.find((e) => e.active && e.kind === kind) ?? null, [entries]);
  // Toast buttons run long after the render that made them: they read the entries as they are now.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  });
  /** The newest copy of an entry: this phone's state, or `e` when that's newer (a server answer not rendered yet). */
  const live = useCallback((e: Entry) => {
    const cur = entriesRef.current?.find((x) => x.id === e.id);
    return cur && Date.parse(cur.updated_at) >= Date.parse(e.updated_at) ? cur : e;
  }, []);

  const clock = useCallback((t: string | number | Date) => formatTime(t, tz), [tz]);
  /** "4:05": toasts name times beside words that already say when. */
  const short = useCallback((t: string | number | Date) => formatTimeNear(t, t, tz), [tz]);

  /** A timer toast: one at a time, 10 s by day and 20 s at night, closed early if someone else changes `entry`. */
  const timerToast = useCallback(
    (text: string, entry: Entry | null, opts: { actions?: ToastAction[]; undo?: () => void; undoLabel?: string; icon?: IconName } = {}) =>
      toast(text, {
        group: "timer",
        duration: isNight() ? 20_000 : 10_000,
        ...(entry ? { watch: { entryId: entry.id, updatedAt: entry.updated_at } } : {}),
        ...opts,
      }),
    [isNight, toast]
  );

  /**
   * "{N} min earlier" chips over the time each produces. `to` is always the
   * recorded value minus N, so tapping two chips never adds up. A chip at or
   * before `floor` (a resume's pause) becomes one "No break" chip. One before
   * `after` (when the feed before this one ended) is dropped, and the last
   * chip becomes "Since the last feed", so a chip never lays a new feed over
   * the last one (as in Fix times).
   */
  const earlierChips = useCallback(
    (recorded: number, mins: number[], aria: (n: number, at: string) => string, commit: (to: Date) => void, limits: { min?: number; floor?: number; after?: number | null } = {}) => {
      const chips: ToastAction[] = [];
      let floored = false;
      let clipped = false;
      let lastTo = recorded;
      for (const n of mins) {
        const to = recorded - n * 60_000;
        if (limits.min !== undefined && to < limits.min) continue;
        if (limits.floor !== undefined && to <= limits.floor) {
          if (!floored && recorded - limits.floor >= 60_000) {
            floored = true;
            const f = limits.floor;
            chips.push({ label: "No break", sub: formatTimeNear(f, recorded, tz), ariaLabel: `No break, from ${clock(f)}`, onClick: () => commit(new Date(f)) });
            lastTo = f;
          }
          continue;
        }
        if (limits.after != null && to < limits.after) {
          clipped = true;
          continue;
        }
        chips.push({ label: `${n} min earlier`, sub: formatTimeNear(to, recorded, tz), ariaLabel: aria(n, clock(to)), onClick: () => commit(new Date(to)) });
        lastTo = to;
      }
      const f = limits.after;
      // (Not when the last chip kept already lands within a minute of it: two chips would show one clock time.)
      if (clipped && f != null && lastTo - f >= 60_000 && (limits.min === undefined || f >= limits.min)) {
        // It takes the last of the two places.
        chips.length = Math.min(chips.length, 1);
        chips.push({ label: "Since the last feed", sub: formatTimeNear(f, recorded, tz), ariaLabel: `Since the last feed ended, at ${clock(f)}`, onClick: () => commit(new Date(f)) });
      }
      return chips.slice(0, 2);
    },
    [clock, tz]
  );

  /** Put back what a change replaced (`before`), only if nobody changed the feed since. `said` words the toast after it. */
  const restoreFrom = useCallback(
    async (res: TimerResponse, said?: (back: TimerResponse) => string) => {
      const b = res.before;
      if (!b) return null;
      const edit: FeedEdit = {
        op: "restore",
        segments: b.segments,
        started_at: b.started_at,
        ended_at: b.ended_at,
        expect_updated_at: res.entry.updated_at,
        // A finished feed comes back as its Done left it: ended at its pause, so a later reopen brings it back paused.
        ...(b.paused_at_stop ? { paused_at_stop: true as const } : {}),
        ...(res.nap ? { nap: { id: res.nap.entry.id, ended_at: res.nap.before_ended_at, expect_updated_at: res.nap.entry.updated_at } } : {}),
      };
      const back = await timerCall({ action: "retime", id: res.entry.id, edit });
      if (back) toast(said?.(back) ?? "Undone", { group: "timer" });
      return back;
    },
    [timerCall, toast]
  );

  /**
   * The fix toast (what changed, from the server's answer) and its "Back
   * to …" button. `moved` is the moment as it was recorded before the fix,
   * `undid` the tap an undo_tap took back, `wasActive` whether this phone
   * still showed the feed running when the fix was asked for.
   */
  const fixToast = useCallback(
    (
      res: TimerResponse,
      edit: FeedEdit,
      moved: { moment: Moment; recorded: Date } | null,
      undid: "switch" | "resume" | "pause" | null,
      wasActive: boolean,
      /** The side the undone switch went to ("B": going back and forth). */
      undidTo?: StretchSide
    ) => {
      const after = res.entry;
      const n = now();
      const parts = allParts(after, n);
      const sides = parts.filter((p): p is SidePart => p.kind === "side");
      const breakBefore = (s: SidePart) => parts.find((p) => p.kind === "break" && p.end === s.start) ?? null;
      const breakAfter = (s: SidePart) => parts.find((p) => p.kind === "break" && s.end !== null && p.start === s.end) ?? null;
      const nearT = (a: string, t: number) => Math.abs(Date.parse(a) - t) <= 1500;
      let text = "Times updated";
      let back = "Put it back";
      // "Left", "Right", "both sides" in the middle of a sentence.
      const word = (x: StretchSide) => (x === "B" ? "both sides" : SIDE_NAME[x]);
      if (edit.op === "set_side") {
        text = edit.side === "B" ? "That part is now both sides" : `That part is now ${SIDE_NAME[edit.side]}`;
        back = `Back to ${word(edit.ref.side)}`;
      } else if (edit.op === "undo_tap") {
        const last = sides[sides.length - 1];
        const open = parts[parts.length - 1];
        if (undid === "switch" && last && last.side === "B") text = `Back to both sides · since ${short(last.start)}`;
        else if (undid === "switch" && last && undidTo === "B") text = `Back and forth undone · ${SIDE_NAME[last.side]} since ${short(last.start)}`;
        else if (undid === "switch" && last) text = `Switch undone · back on ${SIDE_NAME[last.side]}`;
        else if (undid === "resume" && open?.kind === "break") text = `Back to paused · break since ${short(open.start)}`;
        else if (undid === "pause" && last) text = last.side === "B" ? "Pause undone · still going back and forth" : `Pause undone · ${SIDE_NAME[last.side]} still going`;
      } else if (edit.op === "move" && moved) {
        const to = Date.parse(edit.to);
        back = `Back to ${short(moved.recorded)}`;
        const side = edit.ref?.side;
        switch (moved.moment) {
          case "feed_start":
            text = `Feed now starts ${short(after.started_at)}${res.nap ? " · nap ends then too" : ""}`;
            break;
          case "switch": {
            const i = sides.findIndex((s) => nearT(s.start, to));
            const s = sides[i];
            const p = sides[i - 1];
            // "Back and forth from 9:14 · Left 8 min", "Left at 9:40 · back and forth 26 min".
            const was = p ? `${p.side === "B" ? "back and forth" : SIDE_NAME[p.side]} ${minutesText(p.min)}` : "";
            if (s && p) text = s.side === "B" ? `Back and forth from ${short(s.start)} · ${was}` : p.side === "B" ? `${SIDE_NAME[s.side]} at ${short(s.start)} · ${was}` : `Switched to ${SIDE_NAME[s.side]} at ${short(s.start)} · ${was}`;
            break;
          }
          case "resume": {
            const s =
              sides.find((x) => x.side === side && nearT(x.start, to)) ??
              sides.find((x) => x.side === side && Date.parse(x.start) <= to && (x.end === null || Date.parse(x.end) >= to));
            const b = s ? breakBefore(s) : null;
            // "Right side from 3:11", as the card says "Right side · since": "Right now from" read as the phrase "right now".
            const what = s?.side === "B" ? "Back and forth" : s ? `${SIDE_NAME[s.side]} side` : "";
            if (s) text = b ? `${what} from ${short(s.start)} · break ${minutesText(b.min)}` : `${what} from ${short(to)} · no break`;
            break;
          }
          case "pause": {
            const s = sides.find((x) => x.end !== null && nearT(x.end, to));
            const b = s ? breakAfter(s) : null;
            const was = s?.side === "B" ? "back and forth" : s ? SIDE_NAME[s.side] : "";
            if (s && b && b.end === null) text = `Came off at ${short(s.end!)} · ${was} ${minutesText(s.min)}`;
            else if (s) text = `Came off${s.side === "B" ? "" : ` ${SIDE_NAME[s.side]}`} at ${short(s.end!)} · ${b ? `break ${minutesText(b.min)}` : "no break"}`;
            break;
          }
          case "feed_end": {
            const t = after.kind === "feed" ? feedMinutes(after, n) : null;
            const each = t ? sideMinutesText(t) : "";
            text = `Ended ${short(after.ended_at ?? to)} · nursed ${minutesShort(t?.total ?? 0)}${each ? ` (${each})` : ""}`;
            break;
          }
        }
      }
      // A stale chip on a feed the other phone had already ended: the fix saved, but say the feed is over.
      if (wasActive && !after.active && after.ended_at && moved?.moment !== "feed_end") text += ` · the feed ended ${short(after.ended_at)}`;
      timerToast(text, after, { undo: () => void restoreFrom(res), undoLabel: back });
    },
    [now, restoreFrom, short, timerToast]
  );

  /**
   * Fix one moment of a feed (Fix times, a toast chip): `retime` with the
   * server's answer, then the fix toast. Resolves to the answer, or null
   * when nothing was saved (opts.onError hears why).
   */
  const retime = useCallback(
    async (e: Entry, edit: FeedEdit, opts: TimerCallOptions = {}) => {
      const before = live(e);
      let moved: { moment: Moment; recorded: Date } | null = null;
      let undid: "switch" | "resume" | "pause" | null = null;
      let undidTo: StretchSide | undefined;
      if (before.kind === "feed") {
        try {
          if (edit.op === "move") moved = edgeBounds(before.data, { edge: edit.edge, ref: edit.ref }, feedCtx(before, now()));
          if (edit.op === "undo_tap") {
            undid = undoLastTap(before.data, edit.expect, { active: before.active }).what;
            undidTo = (before.data as TapFeedData).last_tap?.side;
          }
        } catch {
          // The server has the last word (and the copy for why).
        }
      }
      const res = await timerCall({ action: "retime", id: e.id, edit }, opts);
      if (!res || res.noop) return res;
      if (edit.op === "restore") toast("Undone", { group: "timer" });
      else fixToast(res, edit, moved, undid, before.active, undidTo);
      return res;
    },
    [fixToast, live, now, timerCall, toast]
  );

  /** Undo the newest tap (a switch, resume or pause) on the feed as this phone shows it. */
  const undoTap = useCallback(
    (e: Entry, opts: TimerCallOptions = {}) => {
      const cur = live(e);
      const sides = sideParts(cur, now());
      const last = sides[sides.length - 1];
      if (!last) return Promise.resolve(null);
      return retime(cur, { op: "undo_tap", expect: { side: last.side, start: last.start, end: last.end } }, opts);
    },
    [live, now, retime]
  );

  /** "Wrong side?": a part is the other side, or both sides ("That was both sides"), or one side after all ("That was the Left"). */
  const setSide = useCallback(
    (e: Entry, ref: { side: StretchSide; start: string }, side: StretchSide, opts: TimerCallOptions = {}) => retime(e, { op: "set_side", ref, side }, opts),
    [retime]
  );

  /** Put a just-stopped timer back to running (a paused feed comes back paused). */
  const reopen = useCallback(async (e: Entry) => (await timerCall({ action: "reopen", id: e.id }))?.entry ?? null, [timerCall]);

  /** After undoing a Continue or a side added after Done, what's back: "Undone · the 8:10 feed ended 8:24". */
  const endedAgain = useCallback(
    (back: TimerResponse) =>
      back.entry.active || !back.entry.ended_at ? "Undone" : `Undone · the ${short(back.entry.started_at)} feed ended ${short(back.entry.ended_at)}`,
    [short]
  );

  /**
   * The toast of a feed carried on (reopen with a side), read off the
   * server's answer: where she is now and since when, the break if there was
   * one, then `tail` ("the 8:10 feed goes on", "still going"). Its Undo puts
   * the finished feed back exactly (retime restore of `before`, with
   * paused_at_stop), so the other phone's Done comes back too.
   */
  const carriedToast = useCallback(
    (res: TimerResponse, side: StretchSide, tail: string, more: { at?: Date; afterUndo?: () => Promise<unknown> } = {}) => {
      const after = res.entry;
      const parts = allParts(after, now());
      const sides = parts.filter((p): p is SidePart => p.kind === "side");
      const cur = sides.at(-1);
      const name = SIDE_NAME[side];
      // "Left side", or "Back and forth" (a part going both sides).
      const part = (x: StretchSide) => (x === "B" ? "Back and forth" : `${SIDE_NAME[x]} side`);
      const brk = cur ? parts.find((p) => p.kind === "break" && p.end === cur.start) : undefined;
      // A part the finished feed already had: ended while she was on it, so the Done is taken back and it runs on.
      const kept = !!cur && !!res.before?.segments.some((x) => x.side === cur.side && Math.abs(Date.parse(x.start) - Date.parse(cur.start)) <= 1500);
      let text = tail;
      if (cur) {
        // A carried-on feed never "paused under a minute": it was a Done (or a picked time), so just "no break".
        if (res.merged) text = `${side === "B" ? "Back on" : `Back on the ${name}`} · no break · ${tail}`;
        else if (res.clamped) text = `${side === "B" ? "Back and forth" : name} from ${short(cur.start)}, when the break began (no break) · ${tail}`;
        else if (kept) text = `${part(cur.side)} still going, since ${short(cur.start)} · ${tail}`;
        else if (brk) text = `${onSide(side, sides.at(-2)?.side)} since ${short(cur.start)} · break ${minutesText(brk.min)} · ${tail}`;
        else text = cur.side === "B" ? `Back and forth from ${short(cur.start)} · ${tail}` : `Switched to ${SIDE_NAME[cur.side]} at ${short(cur.start)} · ${tail}`;
      }
      const undo = async () => {
        // "Same feed as 8:30": the feed it discarded comes back too, so Undo leaves both as they were.
        if ((await restoreFrom(res, endedAgain)) && more.afterUndo) await more.afterUndo();
      };
      timerToast(text, after, { undo: () => void undo() });
    },
    [endedAgain, now, restoreFrom, short, timerToast]
  );

  /**
   * Carry a finished feed on on `side`, from `at` (default now), in one
   * write the server checks against the feed this phone saw (e.updated_at:
   * changed since, 409 and nothing is written): the dock's "Continue that
   * feed on Right", the start toast's "Same feed as 8:30", Fix times'
   * "Continue it on Right". Ended at its pause, it's a resume after the
   * break; ended while running, she switches at the Done (the same side just
   * runs on). Resolves to the answer, or null when nothing was saved.
   */
  const continueFeed = useCallback(
    async (e: Entry, side: StretchSide, at?: Date, opts: TimerCallOptions = {}, afterUndo?: () => Promise<unknown>): Promise<TimerResponse | null> => {
      tick();
      const res = await timerCall({ action: "reopen", id: e.id, side, at: at?.toISOString(), expect_updated_at: e.updated_at }, opts);
      if (!res || res.noop || !res.entry.active) return res;
      carriedToast(res, side, `the ${short(res.entry.started_at)} feed goes on`, { at, afterUndo });
      return res;
    },
    [carriedToast, short, timerCall]
  );

  /**
   * "She went back on…" after a Done, once the sheet has an answer (nothing
   * is reopened to ask, so a phone locked mid-question leaves the Done as it
   * was). On `side` from `from` until `until` (the Done tap) adds that side to
   * the finished feed, which then ends there (add_part); `until` null ("She's
   * still on") carries the feed on from `from` (reopen with a side). Each is
   * one write checked against the finished feed this phone saw, and its Undo
   * puts that feed back exactly as Done left it.
   */
  const backOnAfterDone = useCallback(
    async (e: Entry, side: StretchSide, from: Date, until: Date | null, opts: TimerCallOptions = {}): Promise<TimerResponse | null> => {
      tick();
      if (!until) {
        const res = await timerCall({ action: "reopen", id: e.id, side, at: from.toISOString(), expect_updated_at: e.updated_at }, opts);
        if (!res || res.noop || !res.entry.active) return res;
        carriedToast(res, side, "still going", { at: from });
        return res;
      }
      const edit: FeedEdit = { op: "add_part", side, start: from.toISOString(), end: until.toISOString(), expect_updated_at: e.updated_at };
      const res = await timerCall({ action: "retime", id: e.id, edit }, opts);
      if (!res || res.noop) return res;
      const last = sideParts(res.entry, now()).at(-1);
      const ended = res.entry.ended_at ?? until.toISOString();
      const text = last?.end ? `${last.side === "B" ? "Back and forth" : SIDE_NAME[last.side]} ${short(last.start)} – ${short(last.end)} · ended ${short(ended)}` : `Ended ${short(ended)}`;
      timerToast(text, res.entry, { undo: () => void restoreFrom(res, endedAgain) });
      return res;
    },
    [carriedToast, endedAgain, now, restoreFrom, short, timerCall, timerToast]
  );

  /**
   * A Resume or Switch from a dock that hadn't caught up with the other
   * phone's Done (409 "stopped"): if that feed ended in the last half hour,
   * the toast offers to carry it on rather than leave a second feed as the
   * only way forward, in one checked write (continueFeed).
   */
  const continueAction = useCallback(
    (side: StretchSide) =>
      (f: TimerFailure): ToastAction[] | undefined => {
        const e = f.entry;
        if (f.kind !== "stopped" || !e || e.kind !== "feed" || e.data.method !== "breast" || e.active || !e.ended_at) return undefined;
        if (now().getTime() - Date.parse(e.ended_at) > CONTINUE_WITHIN_MS) return undefined;
        // Another feed already on (this one still shows running here: the 409 is how this phone hears it ended).
        if (entriesRef.current?.some((x) => x.active && x.kind === "feed" && x.id !== e.id)) return undefined;
        return [{ label: side === "B" ? "Continue that feed, back and forth" : `Continue that feed on ${SIDE_NAME[side]}`, onClick: () => void continueFeed(e, side) }];
      },
    [continueFeed, now]
  );

  /**
   * Throw away a timer this phone just started (a start toast's Undo), only
   * as the start left it: if the other phone has switched or paused since,
   * the server says so (409, "Brittany just changed this feed. Have another
   * look.") and keeps it.
   */
  const unstart = useCallback(
    async (e: Entry, nap?: Entry | null) => {
      const gone = await timerCall({ action: "discard", id: e.id, expect_updated_at: e.updated_at });
      if (!gone) return;
      // The nap only comes back once the feed is gone.
      if (nap) await reopen(nap);
      toast("Undone", { group: "timer" });
    },
    [reopen, timerCall, toast]
  );

  /**
   * Done (or Woke up). A feed ends by the one stop rule: running, at `at`
   * (default now); paused, at the pause. The toast offers the fix that fits:
   * "Ended earlier…" after a running feed, "She went back on…" after one
   * that ended at its pause, which opens Fix times on the finished feed.
   */
  const stop = useCallback(
    async (e: Entry, at?: Date, opts: TimerCallOptions = {}) => {
      tick();
      // When Done was tapped here: "She went back on…" ends the side it adds then, so that tap isn't lost.
      const doneAt = now().toISOString();
      const res = await timerCall({ action: "stop", id: e.id, at: at?.toISOString() }, opts);
      if (!res || res.noop || res.entry.active) return res?.entry ?? null;
      const saved = res.entry;
      const ended = saved.ended_at ?? new Date().toISOString();
      const timed = saved.kind === "feed" && saved.data.method === "breast" && !!saved.data.segments?.length;
      const undo = () => void reopen(saved);
      if (!timed) {
        const d = doneText(saved, now(), undefined, entriesRef.current);
        timerToast(at ? `${d.text} · ended ${short(ended)}` : d.text, saved, {
          undo,
          actions: [{ label: "Edit", onClick: () => open({ kind: saved.kind, entry: saved }) }],
        });
      } else if (at) {
        timerToast(`${doneText(saved, now(), undefined, entriesRef.current).text} · ended ${short(ended)}`, saved, { undo });
      } else if (saved.kind === "feed" && saved.data.paused_at_stop === true) {
        // Ended at its pause (the server's word for it, even if this phone still showed her on).
        timerToast(doneText(saved, now(), `ended ${short(ended)}, ${pauseWords(saved, me)}`, entriesRef.current).text, saved, {
          undo,
          actions: [
            {
              label: "She went back on…",
              // Asked of the finished feed: the sheet's answer is one write (backOnAfterDone), so nothing is reopened to ask.
              onClick: () => open({ kind: "feed", entry: saved, preset: fixPreset("current", "backOn", doneAt) }),
            },
          ],
        });
      } else {
        timerToast(doneText(saved, now(), undefined, entriesRef.current).text, saved, {
          undo,
          actions: [{ label: "Ended earlier…", onClick: () => open({ kind: "feed", entry: saved, preset: fixPreset("finish") }) }],
        });
      }
      return saved;
    },
    [me, now, open, reopen, short, timerCall, timerToast]
  );

  /**
   * The start toast's "Same feed as 8:30": the feed before ended a few
   * minutes before this one started (a Done by mistake, or the other
   * phone's), so this one goes (only as it was started) and that one carries
   * on on this side from this start. If carrying on fails, this one comes back.
   */
  const sameFeed = useCallback(
    async (e: Entry, prev: Entry, side: StretchSide, opts: TimerCallOptions = {}): Promise<TimerResponse | null> => {
      tick();
      const p = live(prev);
      // One request (join): the new feed is set aside and the old one carried on from its start, or neither happens.
      const res = await timerCall(
        { action: "join", id: e.id, into: p.id, side, expect_updated_at: live(e).updated_at, expect_into_updated_at: p.updated_at },
        opts
      );
      if (!res || !res.entry.active) return res;
      carriedToast(res, side, `one feed from ${short(res.entry.started_at)}`, { afterUndo: () => restore(e.id, { quiet: true }) });
      return res;
    },
    [carriedToast, live, restore, short, timerCall]
  );

  /** resume, which is defined further down (backAndForth on a break goes back on through it). */
  const resumeRef = useRef<(e: Entry, side: StretchSide, at?: Date, opts?: TimerCallOptions) => Promise<TimerResponse | null>>(async () => null);

  /**
   * Back and forth from now: she goes between sides as she likes and nobody
   * taps Switch (the start or switch toast's [Back and forth], the card's
   * menu, the Lantern's hold). The side she's on ends now and a both-sides
   * part opens; a side under a minute old (the toast right after a Switch or a
   * start) becomes the both part instead. On a break it's "back on, back and
   * forth". The toast's Undo puts the side back (undo_tap).
   */
  const backAndForth = useCallback(
    async (e: Entry, opts: TimerCallOptions = {}, at?: Date) => {
      const cur = live(e);
      if (cur.kind === "feed" && cur.active && cur.data.segments?.length && !openSegment(cur.data.segments)) {
        return (await resumeRef.current(cur, "B", undefined, opts))?.entry ?? null;
      }
      tick();
      const res = await timerCall({ action: "switch", id: e.id, side: "B", at: at?.toISOString() }, opts);
      // Already going back and forth (the other phone, or Claude): nothing changed, nothing to say.
      if (!res || res.noop) return res?.entry ?? null;
      const after = res.entry;
      const part = sideParts(after, now()).at(-1);
      timerToast(`Both sides from ${short(part?.start ?? now())} · no need to tap Switch`, after, { undo: () => void undoTap(after) });
      return after;
    },
    [live, now, short, timerCall, timerToast, undoTap]
  );
  /**
   * The [Back and forth] a toast offers (a start within 30 minutes of the last feed, a feed's second Switch), over the
   * time it records: the side just tapped becomes the both part from its start. The chip sends that time, so it
   * records what it shows however late it's tapped (a toast held while the Lantern was open can be minutes old;
   * without the time, a side over a minute old would end at the tap and leave a stray Left or Right part behind).
   * If the feed changed meanwhile, the time no longer fits and the server says why.
   */
  const bothChip = useCallback(
    (e: Entry): ToastAction => {
      const from = sideParts(e, now()).at(-1)?.start ?? e.started_at;
      return {
        label: "Back and forth",
        sub: short(from),
        ariaLabel: `Going back and forth: both sides from ${clock(from)}, no need to tap Switch`,
        onClick: () => void backAndForth(e, {}, new Date(from)),
      };
    },
    [backAndForth, clock, now, short]
  );

  const startFeed = useCallback(
    async (side: Side) => {
      tick();
      const nap = running("sleep");
      let napEnded: Entry | null = null;
      if (nap && nap.id > 0) {
        const s = (await timerCall({ action: "stop", id: nap.id }))?.entry;
        if (s && !s.active && s.ended_at) napEnded = s;
      }
      const napText = napEnded ? `Nap ended ${short(napEnded.ended_at!)} (${formatMinutes((Date.parse(napEnded.ended_at!) - Date.parse(napEnded.started_at)) / 1000)})` : "";
      const res = await timerCall({ action: "start", kind: "feed", side });
      // Not started here (failed, or the other phone's feed was already running): no start toast.
      if (!res || res.alreadyRunning !== false) {
        if (napEnded) timerToast(napText, napEnded, { undo: () => void reopen(napEnded!) });
        return res?.entry ?? null;
      }
      const e = res.entry;
      const first = sideParts(e, now())[0];
      const name = SIDE_NAME[first?.side ?? side];
      const ref = first?.ref ?? { side, start: e.started_at };
      const chips = earlierChips(
        Date.parse(ref.start),
        [2, 5],
        (n, at) => `${name} started ${minutesWord(n)} earlier, at ${at}`,
        (to) => void retime(e, { op: "move", edge: "start", ref, to: to.toISOString() }),
        // Never over the feed before this one (two-phones #53): Fix times stops its chips there too.
        { after: previousFeedEnd(entriesRef.current, e) }
      );
      // The last feed ended minutes ago (fresh-eyes: a Done by mistake split one feed in two): one tap joins them.
      const prev = previousFeed(entriesRef.current, e);
      const prevNursed = !napEnded && prev?.kind === "feed" && prev.data.method === "breast" && !!prev.ended_at;
      const gap = prevNursed ? Date.parse(e.started_at) - Date.parse(prev.ended_at!) : Infinity;
      const joinable = prevNursed && !!prev?.data.segments?.length && gap <= SAME_FEED_MS;
      if (joinable && prev) {
        const join: ToastAction = { label: `Same feed as ${short(prev.started_at)}`, onClick: () => void sameFeed(e, prev, first?.side ?? side) };
        // She's back on minutes after the last feed: "Same feed" first (a Done by mistake), then going back and forth.
        timerToast(`${name} started ${clock(e.started_at)} · the ${short(prev.started_at)} feed ended ${short(prev.ended_at!)}`, e, {
          actions: [join, bothChip(e)],
          undo: () => void unstart(e),
        });
        return e;
      }
      // Within 30 minutes of the last feed (a cluster's next latch): Back and forth first, then one "earlier" chip.
      const cluster = prevNursed && gap <= CLUSTER_GAP_MS;
      const ask = chips.length && !cluster ? ". Started earlier?" : "";
      // One toast for both: the nap it ended, then the feed.
      const text = napEnded ? `${napText} · ${name} started ${short(e.started_at)}${ask}` : `${name} started ${clock(e.started_at)}${ask}`;
      timerToast(text, e, { actions: cluster ? [bothChip(e), ...chips.slice(0, 1)] : chips, undo: () => void unstart(e, napEnded) });
      return e;
    },
    [bothChip, clock, earlierChips, now, reopen, retime, running, sameFeed, short, timerCall, timerToast, unstart]
  );

  /**
   * A paused feed nobody came back to for over an hour (staleFeed, the Siri
   * and Claude rule): the dock's side tiles start a new feed instead of
   * gluing this one onto it. The old one ends at its pause (only as this
   * phone saw it), then the new one starts; one toast says both, and Undo
   * throws the new one away and brings the old one back paused.
   */
  const freshFeed = useCallback(
    async (old: Entry, side: Side) => {
      tick();
      // The other phone may have ended it already (its Done): then there's just the new feed to start.
      let gone: Entry | null = null;
      const ended = await timerCall(
        { action: "stop", id: old.id, expect_updated_at: old.updated_at },
        {
          onError: (f) => {
            if (f.kind === "stopped" && f.entry && !f.entry.active) gone = f.entry;
            else toast(f.message, { tone: "info" });
          },
        }
      );
      const was = ended && !ended.entry.active ? ended.entry : (gone as Entry | null);
      if (!was) return null;
      const res = await timerCall({ action: "start", kind: "feed", side });
      if (!res || res.alreadyRunning !== false) return res?.entry ?? null;
      const e = res.entry;
      const end = was.ended_at ?? was.started_at;
      const how = ended ? pauseWords(was, me) : "on the other phone";
      timerToast(`${SIDE_NAME[side]} started ${short(e.started_at)} · the ${short(old.started_at)} feed ended ${short(end)}, ${how}`, e, {
        undo: () =>
          void (async () => {
            if (!(await timerCall({ action: "discard", id: e.id, expect_updated_at: e.updated_at }))) return;
            // Only this phone's ending comes back; the other phone's Done stays.
            if (ended && (await reopen(was))) toast(`Undone · the ${short(old.started_at)} feed is back, paused`, { group: "timer" });
            else toast("Undone", { group: "timer" });
          })(),
      });
      return e;
    },
    [me, reopen, short, timerCall, timerToast, toast]
  );

  /** Move a sleep, tummy-time or pumping start (Fix times, a start toast chip). */
  const adjust = useCallback(
    async (e: Entry, at: Date, opts: TimerCallOptions = {}) => {
      const was = live(e).started_at;
      const res = await timerCall({ action: "adjust", id: e.id, at: at.toISOString() }, opts);
      if (!res?.entry.active) return res;
      const what = e.kind === "sleep" ? "Sleep" : KIND_TITLE[e.kind as TimerKind] ?? "Timer";
      timerToast(`${what} now starts ${short(res.entry.started_at)}`, res.entry, {
        undoLabel: `Back to ${short(was)}`,
        undo: () =>
          void (async () => {
            if (await timerCall({ action: "adjust", id: e.id, at: was })) toast("Undone", { group: "timer" });
          })(),
      });
      return res;
    },
    [live, short, timerCall, timerToast, toast]
  );

  const startTimer = useCallback(
    async (kind: Exclude<TimerKind, "feed">) => {
      tick();
      const feed = kind === "sleep" ? running("feed") : null;
      const res = await timerCall({ action: "start", kind });
      if (!res) return null;
      const e = res.entry;
      if (feed && feed.id > 0) {
        // Asleep at the breast is the likelier story, so this question wins over "Fell asleep earlier?".
        timerToast("Stop the feed too?", null, {
          actions: [
            { label: "Yes, she fell asleep", onClick: () => void stop(feed, new Date(e.started_at)) },
            { label: "Keep both", onClick: () => {} },
          ],
        });
        return e;
      }
      if (res.alreadyRunning !== false) return e;
      const sleep = kind === "sleep";
      const what = sleep ? "Sleep" : KIND_TITLE[kind];
      timerToast(`${what} started ${clock(e.started_at)}. ${sleep ? "Fell asleep earlier?" : "Earlier?"}`, e, {
        actions: earlierChips(
          Date.parse(e.started_at),
          sleep ? [5, 10] : [2, 5],
          (n, at) => `${sleep ? "Fell asleep" : `${what} started`} ${minutesWord(n)} earlier, at ${at}`,
          (to) => void adjust(e, to)
        ),
        undo: () => void unstart(e),
      });
      return e;
    },
    [adjust, clock, earlierChips, running, stop, timerCall, timerToast, unstart]
  );

  /** Fell asleep at the breast: stop the feed (by the stop rule) and start sleep at the same instant. */
  const fellAsleep = useCallback(
    async (feed: Entry) => {
      tick();
      const at = now();
      const stopped = (await timerCall({ action: "stop", id: feed.id, at: at.toISOString() }))?.entry;
      if (!stopped || stopped.active) return;
      let s = (await timerCall({ action: "start", kind: "sleep" }))?.entry ?? null;
      if (s && Math.abs(Date.parse(s.started_at) - at.getTime()) > 1500) {
        s = (await timerCall({ action: "adjust", id: s.id, at: at.toISOString() }))?.entry ?? s;
      }
      const sleep = s;
      timerToast(`${doneText(stopped, now(), undefined, entriesRef.current).text} · sleep timer on`, stopped, {
        undo: async () => {
          // The feed only comes back once the sleep is gone, and the sleep only goes as it was started.
          if (sleep && !(await timerCall({ action: "discard", id: sleep.id, expect_updated_at: sleep.updated_at }))) return;
          await reopen(stopped);
        },
      });
    },
    [now, reopen, timerCall, timerToast]
  );

  /**
   * Switch to a side. While she's going back and forth, a side means she's on
   * it now: tracking sides again ("On the Left from 9:31 · tracking sides"),
   * or, within 15 s of going both, that tap taken back. "B" is backAndForth.
   */
  const switchSide = useCallback(
    async (e: Entry, side: StretchSide, opts: TimerCallOptions = {}): Promise<Entry | null> => {
      if (side === "B") return backAndForth(e, opts);
      tick();
      // Going back and forth when this was tapped: a side now is "tracking sides again", not a switch.
      const fromBoth = openSide(live(e)) === "B";
      const res = await timerCall({ action: "switch", id: e.id, side }, { failActions: continueAction(side), ...opts });
      if (!res || res.noop) return res?.entry ?? null;
      const after = res.entry;
      if (res.reverted) {
        timerToast(`Back on the ${SIDE_NAME[side]} · ${fromBoth ? "back and forth undone" : "that switch is undone"}`, after, { undo: () => void restoreFrom(res) });
        return after;
      }
      const sides = sideParts(after, now());
      const cur = sides.at(-1);
      if (!cur) return after;
      if (res.resided && fromBoth) {
        // A side a moment after going both (the other side from the one she was on): that part is this side after all.
        timerToast(`${SIDE_NAME[side]} from ${short(cur.start)}, not back and forth`, after, { undo: () => void restoreFrom(res), undoLabel: "Back to both sides" });
        return after;
      }
      if (res.resided) {
        // A Switch just after going back on: she went back on this side, not the one tapped (no stray second-long part).
        const was = SIDE_NAME[other(side)];
        timerToast(`${onSide(side, sides.at(-2)?.side)}, not the ${was} · since ${short(cur.start)}`, after, {
          undo: () => void restoreFrom(res),
          undoLabel: `Back to ${was}`,
        });
        return after;
      }
      let min: number | undefined;
      try {
        min = edgeBounds(after.kind === "feed" ? after.data : { method: "breast" }, { edge: "start", ref: cur.ref }, feedCtx(after, now())).uiMin.getTime();
      } catch {
        min = undefined;
      }
      const chips = earlierChips(
        Date.parse(cur.start),
        [2, 5],
        (n, at) => `${SIDE_NAME[cur.side]} started ${minutesWord(n)} earlier, at ${at}`,
        (to) => void retime(after, { op: "move", edge: "start", ref: cur.ref, to: to.toISOString() }),
        { min }
      );
      if (fromBoth) {
        timerToast(`On the ${SIDE_NAME[cur.side]} from ${short(cur.start)} · tracking sides${chips.length ? ". Earlier?" : ""}`, after, {
          actions: chips,
          undo: () => void undoTap(after),
        });
        return after;
      }
      // From the feed's second Switch: going back and forth, so she can stop tapping (then one "earlier" chip).
      const offer = sides.filter((p) => p.startMoment === "switch").length >= OFFER_AFTER_SWITCHES;
      timerToast(`Switched to ${SIDE_NAME[cur.side]} · ${short(cur.start)}${chips.length && !offer ? ". Earlier?" : ""}`, after, {
        actions: offer ? [bothChip(after), ...chips.slice(0, 1)] : chips,
        undo: () => void undoTap(after),
      });
      return after;
    },
    [backAndForth, bothChip, continueAction, earlierChips, live, now, restoreFrom, retime, short, timerCall, timerToast, undoTap]
  );

  const pause = useCallback(
    async (e: Entry) => {
      tick();
      const res = await timerCall({ action: "pause", id: e.id });
      if (!res || res.noop) return res?.entry ?? null;
      const last = sideParts(res.entry, now()).at(-1);
      const what = last ? `${last.side === "B" ? "back and forth" : SIDE_NAME[last.side]} ${minutesText(last.min)}` : "";
      timerToast(what ? `Paused · ${what}` : "Paused", res.entry, { undo: () => void undoTap(res.entry) });
      return res.entry;
    },
    [now, timerCall, timerToast, undoTap]
  );

  /**
   * A Resume from a dock that hadn't caught up with the other phone's resume
   * on the other side (409 "changed"; the server never switches over it):
   * the toast says where she is now, and "Switch to Right" does what he meant
   * in one tap. A stale Resume after the other phone's Done gets
   * continueAction's offer instead.
   */
  const staleResume = useCallback(
    (side: StretchSide): Pick<TimerCallOptions, "failActions" | "failText"> => {
      const stillOn = (f: TimerFailure) => {
        const e = f.kind === "changed" ? f.entry : undefined;
        if (!e?.active || e.kind !== "feed") return null;
        const cur = sideParts(e, now()).at(-1);
        return cur && cur.end === null && cur.side !== side ? { e, cur } : null;
      };
      return {
        failText: (f) => {
          const s = stillOn(f);
          if (!s) return undefined;
          const t = short(s.cur.start);
          const both = s.cur.side === "B";
          const name = SIDE_NAME[s.cur.side];
          if (!f.who) return both ? `She's already going back and forth · since ${t}` : `She's already on the ${name} side · since ${t}`;
          const tap = (s.e.data as TapFeedData).last_tap;
          // Brittany's "Keep Left going" took back the pause this phone still showed.
          if ((tap?.kind === "pause" && tap.undone) || s.cur.startMoment === "feed_start") return `${f.who} took back the pause · ${both ? "back and forth" : `${name} side`} since ${t}`;
          if (both) return `${f.who} already put her back on, back and forth, at ${t}`;
          return s.cur.startMoment === "switch" ? `${f.who} already switched her to the ${name} at ${t}` : `${f.who} already put her back on the ${name} at ${t}`;
        },
        failActions: (f) => {
          const s = stillOn(f);
          if (!s) return continueAction(side)(f);
          return [{ label: side === "B" ? "Back and forth" : `${s.cur.side === "B" ? "On the" : "Switch to"} ${SIDE_NAME[side]}`, onClick: () => void switchSide(s.e, side) }];
        },
      };
    },
    [continueAction, now, short, switchSide]
  );

  /**
   * Back on a side after a break. `at` (Fix times' "Already back on?") is
   * when she really went back on; without it, now.
   */
  const resume = useCallback(
    async (e: Entry, side: StretchSide, at?: Date, opts: TimerCallOptions = {}) => {
      tick();
      const res = await timerCall({ action: "resume", id: e.id, side, at: at?.toISOString() }, { ...staleResume(side), ...opts });
      if (!res || res.noop) return res;
      const after = res.entry;
      const both = side === "B";
      const name = SIDE_NAME[side];
      const parts = allParts(after, now());
      const cur = parts.filter((p): p is SidePart => p.kind === "side").at(-1);
      const brk = cur ? parts.find((p) => p.kind === "break" && p.end === cur.start) : undefined;
      // Already back on (the other phone resumed first): the time moved when she went back on, so undo puts that back.
      const wasOpen = res.moved ? res.before?.segments.at(-1) : undefined;
      const back = wasOpen && wasOpen.end == null ? `Back to ${short(wasOpen.start)}` : "Back to paused";
      if (res.merged) {
        // The pause was under a minute, so it counts as nursing: say so, or the pause just tapped seems to vanish
        // (a "No break" picked after a long pause is just no break).
        timerToast(`${both ? "Back on" : `Back on the ${name}`} · ${shortPause(res, now()) ? "paused under a minute, so " : ""}no break`, after, { undo: () => void restoreFrom(res) });
      } else if (res.clamped && cur) {
        timerToast(`${both ? "Back and forth" : name} starts ${short(cur.start)}, when the break began (no break)`, after, { undo: () => void restoreFrom(res), undoLabel: back });
      } else if (at && cur) {
        // A time someone gave (Fix times): say what's recorded now, and put the break back on undo.
        timerToast(`${both ? "Back and forth" : `${name} side`} from ${short(cur.start)} · ${brk ? `break ${minutesText(brk.min)}` : "no break"}`, after, {
          undo: () => void restoreFrom(res),
          undoLabel: back,
        });
      } else if (cur) {
        const chips = brk
          ? earlierChips(
              Date.parse(cur.start),
              [2, 5],
              (n, t) => `${both ? "Back on" : `${name} started`} ${minutesWord(n)} earlier, at ${t}`,
              (to) => void retime(after, { op: "move", edge: "start", ref: cur.ref, to: to.toISOString() }),
              { floor: Date.parse(brk.start) }
            )
          : [];
        const prev = parts.filter((p): p is SidePart => p.kind === "side").at(-2)?.side;
        const text = `${brk ? onSide(side, prev) : `Back on the ${name}`} · ${short(cur.start)}${brk ? ` · break ${minutesText(brk.min)}` : ""}${chips.length ? ". Earlier?" : ""}`;
        timerToast(text, after, { actions: chips, undo: () => void undoTap(after) });
      }
      return res;
    },
    [earlierChips, now, restoreFrom, retime, short, staleResume, timerCall, timerToast, undoTap]
  );
  useEffect(() => {
    resumeRef.current = resume;
  });

  /**
   * "Which side is she on now?" answered: tracking sides again. Going back
   * and forth, she's on that side from now (switch); on a break after it,
   * she's back on that side (resume, or a new feed after an hour's break).
   */
  const trackSides = useCallback(
    async (e: Entry, side: Side) => {
      const cur = live(e);
      if (!cur.active || cur.kind !== "feed") return null;
      if (!openSegment(cur.data.segments)) {
        if (staleFeed(cur as Entry & { data: FeedData }, now())) return freshFeed(cur, side);
        return (await resume(cur, side))?.entry ?? null;
      }
      return switchSide(cur, side);
    },
    [freshFeed, live, now, resume, switchSide]
  );

  /**
   * The dock's "Back & forth" / "Track sides" tile: it only asks "Which side
   * is she on now?" [Left] [Right], and saves nothing until one is picked,
   * so a habit tap where Switch used to be is harmless. The question closes
   * if the feed changes meanwhile (the other phone, Claude).
   */
  const askSide = useCallback(
    (e: Entry) => {
      const paused = pausedBoth(live(e));
      timerToast("Which side is she on now?", live(e), {
        // A question, not a saved thing: no check mark.
        icon: "arrow-left-right",
        actions: (["L", "R"] as Side[]).map((s) => ({
          label: SIDE_NAME[s],
          sub: paused ? "back on now" : "from now",
          ariaLabel: `She's ${paused ? "back " : ""}on the ${SIDE_NAME[s]} now: track sides again`,
          onClick: () => void trackSides(e, s),
        })),
      });
    },
    [live, timerToast, trackSides]
  );

  const discard = useCallback(
    async (e: Entry) => {
      const gone = await timerCall({ action: "discard", id: e.id });
      if (!gone) return;
      toast(`${KIND_TITLE[e.kind as TimerKind] ?? "Timer"} discarded`, {
        group: "timer",
        // A discarded timer comes back running (or stopped, with its own toast,
        // if another one started meanwhile), so there's nothing to reopen.
        undo: () => void restore(e.id),
      });
    },
    [restore, timerCall, toast]
  );

  return {
    running,
    startFeed,
    startTimer,
    stop,
    fellAsleep,
    switchSide,
    /** Back and forth from now (both sides, not tracked); on a break, back on going back and forth. */
    backAndForth,
    /** Ask "Which side is she on now?" (saves nothing until answered), then track sides again from that side. */
    askSide,
    trackSides,
    pause,
    resume,
    retime,
    undoTap,
    setSide,
    adjust,
    discard,
    reopen,
    /** Carry a finished feed on on a side, in one checked write (reopen with a side); Undo puts the finished feed back. */
    continueFeed,
    freshFeed,
    sameFeed,
    /** "She went back on…" after a Done: a side until the Done tap (add_part), or, with until null, still on (reopen with a side). */
    backOnAfterDone,
    memberName,
    dismissToast: dismissTimerToast,
    /** Timer toasts wait while the Lantern or Fix times is open (see useMaple's holdTimerToasts / useHoldTimerToasts). */
    holdToasts: holdTimerToasts,
    /** A timer call for this entry is queued or out (see useMaple's timerBusy). */
    busy: timerBusy,
  };
}

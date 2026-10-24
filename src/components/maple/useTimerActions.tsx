"use client";

import { useCallback, useEffect, useRef } from "react";
import { tick } from "@/components/atlas/haptics";
import { edgeBounds, feedCtx, feedParts, feedTotals, openSegment, suggestNextSide, undoLastTap, type Moment, type Part } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatDuration, formatMinutes, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedEdit, Side, TimerKind, TimerResponse } from "@/lib/maple/types";
import { fixPreset, KIND_TITLE, SIDE_NAME } from "./FeedParts";
import { useSheets } from "./sheets";
import { useMaple, type TimerCallOptions, type ToastAction } from "./useMaple";

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

const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/**
 * "Nursed 18m (L 11 · R 7) · Right next time" and friends, for the Done toast.
 * `ended` goes before the next side ("· ended 4:10, when you paused") and
 * drops the per-side minutes.
 */
export function doneText(e: Entry, now: Date, ended?: string): { text: string } {
  const dur = e.ended_at ? (Date.parse(e.ended_at) - Date.parse(e.started_at)) / 1000 : 0;
  if (e.kind === "feed" && e.data.method === "breast") {
    const t = feedTotals(e.data, now);
    const sides = ended ? "" : [t.left >= 30 ? `L ${Math.round(t.left / 60)}` : "", t.right >= 30 ? `R ${Math.round(t.right / 60)}` : ""].filter(Boolean).join(" · ");
    const next = suggestNextSide(e.data);
    return {
      text: `Nursed ${formatDuration(t.total)}${sides ? ` (${sides})` : ""}${ended ? ` · ${ended}` : ""}${next ? ` · ${SIDE_NAME[next]} next time` : ""}`,
    };
  }
  if (e.kind === "sleep") return { text: `Slept ${formatDuration(dur)}` };
  if (e.kind === "tummy") return { text: `Tummy time ${formatDuration(dur)}` };
  if (e.kind === "pump") return { text: `Pumped ${formatDuration(dur)}` };
  return { text: "Saved" };
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

export function useTimerActions() {
  const { state, timerCall, toast, now, isNight, memberName, restore, dismissTimerToast, holdTimerToasts } = useMaple();
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
    (text: string, entry: Entry | null, opts: { actions?: ToastAction[]; undo?: () => void; undoLabel?: string } = {}) =>
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
   * before `floor` (a resume's pause) becomes one "No break" chip.
   */
  const earlierChips = useCallback(
    (recorded: number, mins: number[], aria: (n: number, at: string) => string, commit: (to: Date) => void, limits: { min?: number; floor?: number } = {}) => {
      const chips: ToastAction[] = [];
      let floored = false;
      for (const n of mins) {
        const to = recorded - n * 60_000;
        if (limits.min !== undefined && to < limits.min) continue;
        if (limits.floor !== undefined && to <= limits.floor) {
          if (!floored && recorded - limits.floor >= 60_000) {
            floored = true;
            const f = limits.floor;
            chips.push({ label: "No break", sub: formatTimeNear(f, recorded, tz), ariaLabel: `No break, from ${clock(f)}`, onClick: () => commit(new Date(f)) });
          }
          continue;
        }
        chips.push({ label: `${n} min earlier`, sub: formatTimeNear(to, recorded, tz), ariaLabel: aria(n, clock(to)), onClick: () => commit(new Date(to)) });
      }
      return chips.slice(0, 2);
    },
    [clock, tz]
  );

  /** Put back what a change replaced (`before`), only if nobody changed the feed since. */
  const restoreFrom = useCallback(
    async (res: TimerResponse) => {
      const b = res.before;
      if (!b) return null;
      const edit: FeedEdit = {
        op: "restore",
        segments: b.segments,
        started_at: b.started_at,
        ended_at: b.ended_at,
        expect_updated_at: res.entry.updated_at,
        ...(res.nap ? { nap: { id: res.nap.entry.id, ended_at: res.nap.before_ended_at, expect_updated_at: res.nap.entry.updated_at } } : {}),
      };
      const back = await timerCall({ action: "retime", id: res.entry.id, edit });
      if (back) toast("Undone", { group: "timer" });
      return back;
    },
    [timerCall, toast]
  );

  /**
   * The fix toast (what changed, from the server's answer) and its "Back
   * to …" button. `moved` is the moment as it was recorded before the fix,
   * `undid` the tap an undo_tap took back.
   */
  const fixToast = useCallback(
    (res: TimerResponse, edit: FeedEdit, moved: { moment: Moment; recorded: Date } | null, undid: "switch" | "resume" | "pause" | null) => {
      const after = res.entry;
      const n = now();
      const parts = allParts(after, n);
      const sides = parts.filter((p): p is SidePart => p.kind === "side");
      const breakBefore = (s: SidePart) => parts.find((p) => p.kind === "break" && p.end === s.start) ?? null;
      const breakAfter = (s: SidePart) => parts.find((p) => p.kind === "break" && s.end !== null && p.start === s.end) ?? null;
      const nearT = (a: string, t: number) => Math.abs(Date.parse(a) - t) <= 1500;
      let text = "Times updated";
      let back = "Put it back";
      if (edit.op === "set_side") {
        text = `That part is now ${SIDE_NAME[edit.side]}`;
        back = `Back to ${SIDE_NAME[edit.ref.side]}`;
      } else if (edit.op === "undo_tap") {
        const last = sides[sides.length - 1];
        const open = parts[parts.length - 1];
        if (undid === "switch" && last) text = `Switch undone · back on ${SIDE_NAME[last.side]}`;
        else if (undid === "resume" && open?.kind === "break") text = `Back to paused · break since ${short(open.start)}`;
        else if (undid === "pause" && last) text = `Pause undone · ${SIDE_NAME[last.side]} still going`;
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
            if (s && p) text = `Switched to ${SIDE_NAME[s.side]} at ${short(s.start)} · ${SIDE_NAME[p.side]} ${formatMinutes(p.sec)}`;
            break;
          }
          case "resume": {
            const s =
              sides.find((x) => x.side === side && nearT(x.start, to)) ??
              sides.find((x) => x.side === side && Date.parse(x.start) <= to && (x.end === null || Date.parse(x.end) >= to));
            const b = s ? breakBefore(s) : null;
            if (s) text = b ? `${SIDE_NAME[s.side]} now from ${short(s.start)} · break ${formatMinutes(b.sec)}` : `${SIDE_NAME[s.side]} now from ${short(to)} · no break`;
            break;
          }
          case "pause": {
            const s = sides.find((x) => x.end !== null && nearT(x.end, to));
            const b = s ? breakAfter(s) : null;
            if (s && b && b.end === null) text = `Came off at ${short(s.end!)} · ${SIDE_NAME[s.side]} ${formatMinutes(s.sec)}`;
            else if (s) text = `Came off ${SIDE_NAME[s.side]} at ${short(s.end!)} · ${b ? `break ${formatMinutes(b.sec)}` : "no break"}`;
            break;
          }
          case "feed_end": {
            const t = feedTotals(after.kind === "feed" ? after.data : { method: "breast" }, n);
            const each = [t.left >= 30 ? `L ${Math.round(t.left / 60)}` : "", t.right >= 30 ? `R ${Math.round(t.right / 60)}` : ""].filter(Boolean).join(" · ");
            text = `Ended ${short(after.ended_at ?? to)} · nursed ${formatDuration(t.total)}${each ? ` (${each})` : ""}`;
            break;
          }
        }
      }
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
      if (before.kind === "feed") {
        try {
          if (edit.op === "move") moved = edgeBounds(before.data, { edge: edit.edge, ref: edit.ref }, feedCtx(before, now()));
          if (edit.op === "undo_tap") undid = undoLastTap(before.data, edit.expect, { active: before.active }).what;
        } catch {
          // The server has the last word (and the copy for why).
        }
      }
      const res = await timerCall({ action: "retime", id: e.id, edit }, opts);
      if (!res || res.noop) return res;
      if (edit.op === "restore") toast("Undone", { group: "timer" });
      else fixToast(res, edit, moved, undid);
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

  const setSide = useCallback(
    (e: Entry, ref: { side: Side; start: string }, side: Side, opts: TimerCallOptions = {}) => retime(e, { op: "set_side", ref, side }, opts),
    [retime]
  );

  /** Put a just-stopped timer back to running (a paused feed comes back paused). */
  const reopen = useCallback(async (e: Entry) => (await timerCall({ action: "reopen", id: e.id }))?.entry ?? null, [timerCall]);

  /** Throw away a timer this phone just started (a start toast's Undo). */
  const unstart = useCallback(
    async (e: Entry, nap?: Entry | null) => {
      const gone = await timerCall({ action: "discard", id: e.id });
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
   * that ended at its pause.
   */
  const stop = useCallback(
    async (e: Entry, at?: Date, opts: TimerCallOptions = {}) => {
      tick();
      const cur = live(e);
      const wasPaused = cur.kind === "feed" && cur.data.method === "breast" && !!cur.data.segments?.length && !openSegment(cur.data.segments);
      const res = await timerCall({ action: "stop", id: e.id, at: at?.toISOString() }, opts);
      if (!res || res.noop || res.entry.active) return res?.entry ?? null;
      const saved = res.entry;
      const ended = saved.ended_at ?? new Date().toISOString();
      const timed = saved.kind === "feed" && saved.data.method === "breast" && !!saved.data.segments?.length;
      const undo = () => void reopen(saved);
      if (!timed) {
        const d = doneText(saved, now());
        timerToast(at ? `${d.text} · ended ${short(ended)}` : d.text, saved, {
          undo,
          actions: [{ label: "Edit", onClick: () => open({ kind: saved.kind, entry: saved }) }],
        });
      } else if (at) {
        timerToast(`${doneText(saved, now()).text} · ended ${short(ended)}`, saved, { undo });
      } else if (wasPaused) {
        timerToast(doneText(saved, now(), `ended ${short(ended)}, when you paused`).text, saved, {
          undo,
          actions: [
            {
              label: "She went back on…",
              onClick: () =>
                void (async () => {
                  const back = await reopen(saved);
                  if (back?.active) open({ kind: "feed", entry: back, preset: fixPreset("current", "backOn") });
                })(),
            },
          ],
        });
      } else {
        timerToast(doneText(saved, now()).text, saved, {
          undo,
          actions: [{ label: "Ended earlier…", onClick: () => open({ kind: "feed", entry: saved, preset: fixPreset("finish") }) }],
        });
      }
      return saved;
    },
    [live, now, open, reopen, short, timerCall, timerToast]
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
      // One toast for both: the nap it ended, then the feed.
      const text = napEnded ? `${napText} · ${name} started ${short(e.started_at)}. Started earlier?` : `${name} started ${clock(e.started_at)}. Started earlier?`;
      const ref = first?.ref ?? { side, start: e.started_at };
      timerToast(text, e, {
        actions: earlierChips(
          Date.parse(ref.start),
          [2, 5],
          (n, at) => `${name} started ${minutesWord(n)} earlier, at ${at}`,
          (to) => void retime(e, { op: "move", edge: "start", ref, to: to.toISOString() })
        ),
        undo: () => void unstart(e, napEnded),
      });
      return e;
    },
    [clock, earlierChips, now, reopen, retime, running, short, timerCall, timerToast, unstart]
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
      const s = (await timerCall({ action: "start", kind: "sleep" }))?.entry ?? null;
      if (s && Math.abs(Date.parse(s.started_at) - at.getTime()) > 1500) {
        await timerCall({ action: "adjust", id: s.id, at: at.toISOString() });
      }
      timerToast(`${doneText(stopped, now()).text} · sleep timer on`, stopped, {
        undo: async () => {
          if (s) await timerCall({ action: "discard", id: s.id });
          await reopen(stopped);
        },
      });
    },
    [now, reopen, timerCall, timerToast]
  );

  const switchSide = useCallback(
    async (e: Entry, side: Side) => {
      tick();
      const res = await timerCall({ action: "switch", id: e.id, side });
      if (!res || res.noop) return res?.entry ?? null;
      const after = res.entry;
      if (res.reverted) {
        timerToast(`Back on the ${SIDE_NAME[side]} · that switch is undone`, after, { undo: () => void restoreFrom(res) });
        return after;
      }
      const cur = sideParts(after, now()).at(-1);
      if (!cur) return after;
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
      timerToast(`Switched to ${SIDE_NAME[cur.side]} · ${short(cur.start)}${chips.length ? ". Earlier?" : ""}`, after, {
        actions: chips,
        undo: () => void undoTap(after),
      });
      return after;
    },
    [earlierChips, now, restoreFrom, retime, short, timerCall, timerToast, undoTap]
  );

  const pause = useCallback(
    async (e: Entry) => {
      tick();
      const res = await timerCall({ action: "pause", id: e.id });
      if (!res || res.noop) return res?.entry ?? null;
      const last = sideParts(res.entry, now()).at(-1);
      timerToast(last ? `Paused · ${SIDE_NAME[last.side]} ${formatMinutes(last.sec)}` : "Paused", res.entry, { undo: () => void undoTap(res.entry) });
      return res.entry;
    },
    [now, timerCall, timerToast, undoTap]
  );

  /**
   * Back on a side after a break. `at` (Fix times' "Already back on?") is
   * when she really went back on; without it, now.
   */
  const resume = useCallback(
    async (e: Entry, side: Side, at?: Date, opts: TimerCallOptions = {}) => {
      tick();
      const res = await timerCall({ action: "resume", id: e.id, side, at: at?.toISOString() }, opts);
      if (!res || res.noop) return res;
      const after = res.entry;
      const name = SIDE_NAME[side];
      const parts = allParts(after, now());
      const cur = parts.filter((p): p is SidePart => p.kind === "side").at(-1);
      const brk = cur ? parts.find((p) => p.kind === "break" && p.end === cur.start) : undefined;
      if (res.merged) {
        timerToast(`Back on the ${name} · no break`, after, { undo: () => void restoreFrom(res) });
      } else if (res.clamped && cur) {
        timerToast(`${name} starts ${short(cur.start)}, when the break began (no break)`, after, { undo: () => void restoreFrom(res), undoLabel: "Back to paused" });
      } else if (at && cur) {
        // A time someone gave (Fix times): say what's recorded now, and put the break back on undo.
        timerToast(`${name} now from ${short(cur.start)} · ${brk ? `break ${formatMinutes(brk.sec)}` : "no break"}`, after, {
          undo: () => void restoreFrom(res),
          undoLabel: "Back to paused",
        });
      } else if (cur) {
        const chips = brk
          ? earlierChips(
              Date.parse(cur.start),
              [2, 5],
              (n, t) => `${name} started ${minutesWord(n)} earlier, at ${t}`,
              (to) => void retime(after, { op: "move", edge: "start", ref: cur.ref, to: to.toISOString() }),
              { floor: Date.parse(brk.start) }
            )
          : [];
        const text = `Back on the ${name} · ${short(cur.start)}${brk ? ` · break ${formatMinutes(brk.sec)}` : ""}${chips.length ? ". Earlier?" : ""}`;
        timerToast(text, after, { actions: chips, undo: () => void undoTap(after) });
      }
      return res;
    },
    [earlierChips, now, restoreFrom, retime, short, timerCall, timerToast, undoTap]
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
    pause,
    resume,
    retime,
    undoTap,
    setSide,
    adjust,
    discard,
    reopen,
    memberName,
    dismissToast: dismissTimerToast,
    /** The Lantern holds timer toasts while it's open (see useMaple's holdTimerToasts). */
    holdToasts: holdTimerToasts,
  };
}

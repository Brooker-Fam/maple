"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { edgeBounds, feedCtx, feedParts, minutesShort, minutesText, momentQuestion, other, partTotals, previousFeed, previousFeedEnd, undoableTap, type Part, type TapWhat } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatRange, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, FeedEdit, Side, StretchRef, TimerKind, TimerResponse } from "@/lib/maple/types";
import {
  BreakMark,
  KIND_TITLE,
  LinkRow,
  MomentEditor,
  SIDE_NAME,
  SideMark,
  TimeChip,
  type FixExpand,
  type FixPreset,
  type FixTarget,
  type MomentEdge,
} from "../FeedParts";
import { useNightActive } from "../nightLook";
import { Sheet, cx } from "../ui";
import { useHoldTimerToasts, useMaple, useNow, type TimerCallOptions, type TimerFailure } from "../useMaple";
import { useTimerActions } from "../useTimerActions";
import type { SheetProps } from "./index";
import { useOpenCount } from "./parts";

/**
 * Fix times: one sheet for every "the times are wrong" moment, opened from
 * the timer card (its rows, its live block, its Fix times button), toast
 * chips ("Ended earlier…", "She went back on…"), "Still nursing?" and Recent.
 *
 *   open({ kind, entry, preset: fixPreset(target, expand?, doneAt?) })
 *
 * It pins one part when it opens (the live side, the open break, a past
 * side, or a finished feed's end) and shows that part's panel; each control
 * moves exactly one moment and names it. It reads the entry live, so when
 * the other phone switches, pauses, moves the same moment or ends the feed,
 * a banner says who and what, and the controls wait a moment before they
 * take another tap. Every commit goes to the server first: success closes
 * the sheet and the toast says what changed (with a way back); a 409, a
 * bounds error or no connection keeps the sheet open with a notice.
 *
 * Timer toasts wait while it's open (one would cover its chips, and a toast
 * chip would fix the same moment twice); the sheet's own fix leaves the
 * toast that shows when it closes.
 */

type SidePart = Extract<Part, { kind: "side" }>;

type Pin =
  /** A side part: "open" is the stretch she's on now (panel A), "closed" a past one (panel B). */
  | { kind: "side"; ref: StretchRef; index: number; panel: "open" | "closed"; fromBreak?: boolean }
  /** The open break after the stretch `ref` (panel C). */
  | { kind: "break"; ref: StretchRef }
  /** A finished feed's end (panel D). */
  | { kind: "finish" }
  /** "She went back on…" after a Done at the pause: a finished feed and the Done tap (panel E). */
  | { kind: "after" }
  /** Sleep, tummy time, pumping (one panel). */
  | { kind: "timer" };

/** What's live (the side she's on, the open break, the end): its kind, side, start, and how many side parts lead to it. */
type Cur = { kind: "ended" | "side" | "break" | "none"; side?: Side; start?: string; count: number };

type Snap = { recorded: string; current: Cur };

/**
 * What a commit was for, when the answer needs reading: "Already back on?"
 * racing the other phone's Resume or Done (`until`: the side ends at this
 * Done tap, panel E), or "She already finished" on the stretch the panel
 * showed (`ref`) when the other phone has switched since.
 */
type BackOnMeta = { side: Side; at: number | null; until?: number };
type RunMeta = { backOn?: BackOnMeta; stop?: { ref: StretchRef } };

/**
 * A moment editor. `edge` editors (a recorded moment) follow their stretch if
 * the other phone moves it and commit `retime move` on it; `free` ones (a new
 * moment: back on at, ended at) commit through `commit`.
 */
type Editor = {
  id: string;
  edge?: MomentEdge;
  free?: { title: string; recorded: Date; min: Date; max: Date; notes?: { low?: string; high?: string } };
  commit?: (to: Date, o: TimerCallOptions) => Promise<unknown>;
  /** What the commit was for, given the time picked. */
  meta?: (to: Date) => RunMeta;
};

/** `id`: the commit it makes (run's id): it waits with the controls and says "Saving…" while out. */
type BannerAction = { label: string; onClick: () => void; id?: string };
type Banner = { kind: "discarded" | "gone" | "current" | "moved" | "already"; text: string; actions?: BannerAction[] };

/**
 * The other phone got there first, so nothing was saved:
 *   back:  "Brittany already put her back on the Right at 3:17" (its Resume; `entry`: the server's copy, when the answer carried one);
 *   ended: "Brittany ended this feed at 3:10, at its pause" (its Done), with a way to carry it on (continueFeed) when that
 *          records what this phone said: back on at its time after a pause, or the same side running on;
 *   stop:  "Brittany switched to the Left at 3:17. Pick again." (a stop chip meant for the stretch `ref`).
 */
type Already = ({ kind: "back"; entry: Entry | null } & BackOnMeta) | ({ kind: "ended"; entry: Entry } & BackOnMeta) | { kind: "stop"; ref: StretchRef };

type Run = (id: string, go: (o: TimerCallOptions) => Promise<unknown>, meta?: RunMeta) => Promise<void>;

const HOLD_MS = 1500;
const MIN = 60_000;
/** A feed the other phone ended this recently can still be carried on (as the dock's "Continue that feed on Right"). */
const CONTINUE_WITHIN_MS = 30 * 60_000;
const ELSEWHERE = "on another device or through Claude";

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1500;
const timed = (e: Entry): e is Entry & { kind: "feed"; data: FeedData } => e.kind === "feed" && e.data.method === "breast" && !!e.data.segments?.length;
const partsOf = (e: Entry, now: Date): Part[] => (timed(e) ? feedParts(e.data, feedCtx(e, now)) : []);
const sidesOf = (parts: Part[]) => parts.filter((p): p is SidePart => p.kind === "side");
const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
/** "back on the Left" after a break only when she came off the Left (`prev`); otherwise "on the Right" (as the feed sheet says it). */
const putOn = (side: Side, prev?: Side | null) => `${prev && prev !== side ? "on" : "back on"} the ${SIDE_NAME[side]}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The clock minute a time shows ("6:03"): two chips in one minute read as the same time. */
const clockMinute = (t: number) => Math.floor(t / MIN);
/**
 * Ended at its pause (Done during a break), in the server's word for it. Not
 * "the last side ends at the end": a Done while she's on closes her side at
 * the Done too, and that feed didn't end at a pause.
 */
const endedAtPause = (e: Entry) => timed(e) && !e.active && !!e.ended_at && e.data.paused_at_stop === true;
/** The tap undo_tap would take back now, if it's one of `whats` and made in the last 10 minutes (what the server undoes, not a guess from the parts). */
const freshTap = (e: Entry & { data: FeedData }, now: Date, whats: TapWhat[]) => {
  const tap = undoableTap(e.data, feedCtx(e, now));
  return tap && whats.includes(tap.what) && Date.parse(tap.at) >= now.getTime() - 10 * MIN ? tap.what : null;
};
const isResponse = (r: unknown): r is TimerResponse => typeof r === "object" && r !== null && "entry" in r;
/** A 404 from the timer route: the entry was discarded under this commit. */
const isGone = (f: TimerFailure) => f.kind === "gone" || (f.kind === "error" && /not found/i.test(f.message));
/** The stretch she's on now, if any. */
const openStretch = (e: Entry, now: Date) => {
  const s = sidesOf(partsOf(e, now)).at(-1);
  return e.active && s && s.end === null ? s : null;
};

function currentOf(e: Entry, now: Date): Cur {
  if (!e.active) return { kind: "ended", start: e.ended_at ?? undefined, count: 0 };
  const parts = partsOf(e, now);
  const last = parts.at(-1);
  const count = sidesOf(parts).length;
  if (!last) return { kind: "none", count };
  return last.kind === "break" ? { kind: "break", side: last.before.side, start: last.start, count } : { kind: "side", side: last.side, start: last.start, count };
}

/**
 * How the live part differs from the one the sheet saw: a new part
 * (switched, paused, resumed, ended), the same stretch on the other side
 * ("side"), or null when it's the same part. Matched by what it is, not its
 * exact start: a start the other phone moved is the same part (the "moved"
 * banner says so), and this phone's own tap, answered a few hundred ms after
 * its early copy, is no change at all.
 */
function currentChange(a: Cur, b: Cur): "ended" | "paused" | "resumed" | "merged" | "switched" | "side" | null {
  if (a.kind === "ended" && b.kind === "ended") return null;
  if (b.kind === "ended") return "ended";
  const same = !!a.start && !!b.start && near(a.start, b.start);
  if (a.kind !== b.kind) {
    if (b.kind === "break") return "paused";
    if (b.kind !== "side") return null;
    // Back on the same side within a minute of the pause: the stretch reopened (it started before the break did).
    return a.kind === "break" && a.start && b.start && Date.parse(b.start) < Date.parse(a.start) - 1500 ? "merged" : "resumed";
  }
  if (b.kind === "side" && a.side !== b.side) return same ? "side" : "switched";
  if (same || a.count === b.count) return null;
  return b.kind === "break" ? "paused" : "switched";
}

/** `afterDone`: opened from the Done toast's "She went back on…" (panel E, while the feed is still as that Done left it). */
function resolvePin(target: FixTarget, e: Entry, now: Date, afterDone = false): Pin {
  if (!timed(e)) return { kind: "timer" };
  if (afterDone && endedAtPause(e)) return { kind: "after" };
  const parts = partsOf(e, now);
  const sides = sidesOf(parts);
  const sidePin = (i: number, fromBreak?: boolean): Pin => ({
    kind: "side",
    ref: sides[i].ref,
    index: i,
    panel: sides[i].end === null && e.active ? "open" : "closed",
    ...(fromBreak ? { fromBreak } : {}),
  });
  const current = (): Pin => {
    if (!e.active) return { kind: "finish" };
    const last = parts.at(-1);
    if (last?.kind === "break") return { kind: "break", ref: last.before };
    return sidePin(sides.length - 1);
  };
  if (target === "current") return current();
  if (target === "finish") return e.active ? current() : { kind: "finish" };
  const find = (ref: StretchRef) => sides.findIndex((s) => s.side === ref.side && near(s.start, ref.start));
  if ("ref" in target) {
    const i = find(target.ref);
    return i < 0 ? current() : sidePin(i);
  }
  const i = find(target.breakAfter);
  if (i < 0) return current();
  if (i + 1 < sides.length) return sidePin(i + 1, true);
  return current();
}

/** The pinned part in the live entry: by its ref, else the same side in the same place (its start moved; the open one stays the open one). */
function locate(pin: Pin, e: Entry, now: Date): { part: SidePart | null; moved: boolean } {
  if (pin.kind !== "side" && pin.kind !== "break") return { part: null, moved: false };
  const sides = sidesOf(partsOf(e, now));
  const i = sides.findIndex((s) => s.side === pin.ref.side && near(s.start, pin.ref.start));
  if (i >= 0) return { part: sides[i], moved: false };
  const last = pin.kind === "break" || pin.panel === "open";
  const c = last ? sides.at(-1) : sides[pin.index];
  const ok = !!c && c.side === pin.ref.side && (!last || (pin.kind === "break" ? c.end !== null : c.end === null));
  return ok ? { part: c!, moved: true } : { part: null, moved: false };
}

/** The pinned moment's recorded value(s), to notice the other phone moving it. */
function recordedOf(pin: Pin, e: Entry, now: Date): string {
  if (pin.kind === "finish" || pin.kind === "after") return e.ended_at ?? "";
  if (pin.kind === "timer") return e.started_at;
  const { part } = locate(pin, e, now);
  if (!part) return "";
  return pin.kind === "break" ? part.end ?? "" : `${part.start}|${part.end ?? ""}`;
}

/** Same recorded moment, within the 1.5 s an early copy and the server's answer can differ by. */
function sameRecorded(a: string, b: string): boolean {
  const x = a.split("|");
  const y = b.split("|");
  return x.length === y.length && x.every((v, i) => (v === "" || y[i] === "" ? v === y[i] : near(v, y[i])));
}

export default function FixTimesSheet({ open, onClose, kind, entry, preset }: SheetProps) {
  const { state, memberLabel, timerBusy } = useMaple();
  const count = useOpenCount(open);
  useHoldTimerToasts(open);
  const [committing, setCommitting] = useState(false);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const live = entry ? state?.entries.find((e) => e.id === entry.id) ?? null : null;
  const e = live ?? entry;
  const fix = (preset?.fix ?? { target: "current" }) as FixPreset["fix"];
  // The Done tap that ended this feed at its pause (the Done toast's "She went back on…", asked of the finished feed:
  // nothing is reopened to ask, so closing without an answer, or a phone locked mid-question, leaves the Done as it was).
  const doneAt = fix.expand === "backOn" && fix.doneAt && Number.isFinite(Date.parse(fix.doneAt)) ? fix.doneAt : undefined;

  if (!e) return null;
  const by = memberLabel(e.created_by);
  const subtitle = timed(e)
    ? `Nursing · feed started ${formatTime(e.started_at, tz)}${by ? ` · by ${by}` : ""}`
    : `${KIND_TITLE[kind as TimerKind] ?? "Timer"} · since ${formatTime(e.started_at, tz)}`;
  // A tap from this phone (the dock, a toast) still on its way: the sheet waits for its answer, as for a timer that's still starting.
  const saving = e.id > 0 && timerBusy(e.id) && !committing;
  return (
    <Sheet open={open} onClose={onClose} title={saving ? `${fix.expand === "done" ? "Done" : "Fix times"} · saving…` : fix.expand === "done" ? "Done" : "Fix times"} subtitle={subtitle} calm>
      {/* A fresh pin each time it opens (the router keeps one instance per entry mounted). */}
      <FixBody
        key={count}
        start={e}
        live={live}
        target={fix.target}
        expand={fix.expand}
        doneAt={doneAt}
        open={open}
        onClose={onClose}
        tz={tz}
        onCommitting={setCommitting}
      />
    </Sheet>
  );
}

function FixBody({
  start,
  live,
  target,
  expand,
  doneAt,
  open,
  onClose,
  tz,
  onCommitting,
}: {
  start: Entry;
  live: Entry | null;
  target: FixTarget;
  expand?: FixExpand;
  doneAt?: string;
  open: boolean;
  onClose: () => void;
  tz: string;
  onCommitting: (on: boolean) => void;
}) {
  const { state, now: nowFn, memberLabel, readOnly, timerBusy, refresh, whoDiscarded } = useMaple();
  const actions = useTimerActions();
  const now = useNow(1000);
  const e = live ?? start;
  const me = state?.me.email ?? null;
  const [pin, setPin] = useState<Pin>(() => resolvePin(target, start, nowFn(), !!doneAt));
  const [snap, setSnap] = useState<Snap>(() => ({ recorded: recordedOf(pin, start, nowFn()), current: currentOf(start, nowFn()) }));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; gone?: { updatedAt: string | null; away: boolean; who: string | null } } | null>(null);
  const [already, setAlready] = useState<Already | null>(null);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [finished, setFinished] = useState(expand === "finished" || expand === "done");
  // "She's back on…" / "She went back on…": the other side is the likely one (the dock's next side), one tap from the chips.
  const [backSide, setBackSide] = useState<Side | null>(() => {
    if (expand !== "backOn") return null;
    if (pin.kind === "break") return other(pin.ref.side);
    const last = pin.kind === "after" ? sidesOf(partsOf(start, nowFn())).at(-1) : undefined;
    return last ? other(last.side) : null;
  });
  // Opened to say she's back on: that question alone, with "Came off earlier?" folded behind one row.
  const [backOnly, setBackOnly] = useState(expand === "backOn");
  // A tap from this phone still on its way (not this sheet's own commit).
  const flight = e.id > 0 && timerBusy(e.id) && !busy;

  const repin = (p: Pin) => {
    const n = nowFn();
    setPin(p);
    setSnap({ recorded: recordedOf(p, e, n), current: currentOf(e, n) });
    setEditor(null);
    setNotice(null);
    setAlready(null);
    setFinished(false);
    setBackSide(null);
    setBackOnly(false);
  };

  // This phone's own tap landed while the sheet was open: its answer is the new baseline, not someone else's change.
  const [flew, setFlew] = useState(false);
  useEffect(() => {
    if (flight) {
      setFlew(true);
      return;
    }
    if (!flew) return;
    setFlew(false);
    if (live && me && live.updated_by === me) {
      const n = nowFn();
      setSnap({ recorded: recordedOf(pin, live, n), current: currentOf(live, n) });
    }
  }, [flight, flew, live, me, pin, nowFn]);

  // A discarded feed that comes back (the other phone's Undo) takes its "nothing was saved" with it.
  useEffect(() => {
    const g = notice?.gone;
    if (!g) return;
    if (!live) {
      if (!g.away) setNotice({ ...notice, gone: { ...g, away: true } });
    } else if (g.away || live.updated_at !== g.updatedAt) setNotice(null);
  }, [live, notice]);

  // Gone on a poll (not under a commit, whose 404 names who): ask who discarded it, so the banner can say so.
  const [discarder, setDiscarder] = useState<{ id: number; who: string | null | undefined } | null>(null);
  const goneOnPoll = open && !live && start.id > 0;
  useEffect(() => {
    if (!goneOnPoll) return;
    let on = true;
    void whoDiscarded(start.id).then((who) => {
      if (on) setDiscarder({ id: start.id, who });
    });
    return () => {
      on = false;
    };
  }, [goneOnPoll, start.id, whoDiscarded]);

  // ── what changed on the other phone ──
  const what = e.kind === "feed" ? "feed" : "timer";
  const who = memberLabel(e.updated_by);
  // The viewer's own change (another tab, the same login on the other phone): no name, and never "another device".
  const mine = !!me && e.updated_by === me;
  const byWho = (named: (w: string) => string, plain: string) => (who ? named(who) : mine ? plain : `${plain} ${ELSEWHERE}`);
  const clock = (t: string | number | Date) => formatTime(t, tz);
  const short = (t: string | number | Date) => formatTimeNear(t, t, tz);
  let banner: Banner | null = null;
  let moveRef: StretchRef | null = null;
  // (Not while a commit or this phone's own tap is in flight: its early copy isn't someone else's change.)
  if (open && !busy && !flight) {
    if (!live) {
      const g = notice?.gone;
      // The 404 that stopped this sheet's commit may name who discarded it; else the server's list of discarded entries
      // (null: this viewer, or nobody worth naming); only if that lookup found nothing, the last person to change it.
      const d = discarder?.id === start.id ? discarder : null;
      const text = g?.who
        ? `${g.who} discarded this ${what}`
        : d?.who
          ? `${d.who} discarded this ${what}`
          : !d || d.who === null
            ? `This ${what} was discarded`
            : byWho((w) => `${w} discarded this ${what}`, `This ${what} was discarded`);
      banner = { kind: "discarded", text: `${text}${g ? ", so nothing was saved" : ""}.`, actions: [{ label: "Close", onClick: onClose }] };
    } else if (already) {
      banner = alreadyBanner(already);
    } else if (pin.kind === "side" || pin.kind === "break") {
      const found = locate(pin, live, now);
      const parts = partsOf(live, now);
      const sides = sidesOf(parts);
      const last = parts.at(-1);
      const watchesCurrent = pin.kind === "break" || pin.panel === "open";
      const change = watchesCurrent ? currentChange(snap.current, currentOf(live, now)) : null;
      const showOpen = (s: SidePart): BannerAction => ({ label: `Show ${SIDE_NAME[s.side]}`, onClick: () => repin({ kind: "side", ref: s.ref, index: sides.length - 1, panel: "open" }) });
      // "Wrong side" from the other phone: this stretch is now the other side (merged into the one before it, if that touched).
      const absorbed = !found.part && pin.kind === "side" && pin.panel === "open" && last?.kind === "side" && last.end === null && last.side !== pin.ref.side && Date.parse(last.start) <= Date.parse(pin.ref.start) + 1500;
      if ((change === "side" || absorbed) && last?.kind === "side") {
        banner = { kind: "current", text: byWho((w) => `${w} changed this part to ${SIDE_NAME[last.side]}`, `This part is now ${SIDE_NAME[last.side]}`), actions: [showOpen(last)] };
      } else if (!found.part) {
        banner = {
          kind: "gone",
          text: who ? `Changed on ${who}'s phone. This part is gone.` : mine ? "This part changed, so it's gone." : "Changed on another device. This part is gone.",
          actions: [{ label: "Show current", onClick: () => repin(resolvePin("current", live, nowFn())) }],
        };
      } else {
        if (found.moved) moveRef = found.part.ref;
        if (change === "ended") {
          const t = clock(live.ended_at ?? now);
          banner = { kind: "current", text: byWho((w) => `${w} ended the feed at ${t}`, `The feed ended at ${t}`), actions: [{ label: "Show finished feed", onClick: () => repin({ kind: "finish" }) }] };
        } else if (change === "paused" && last?.kind === "break") {
          const t = clock(last.start);
          banner = { kind: "current", text: byWho((w) => `${w} paused at ${t}`, `Paused at ${t}`), actions: [{ label: "Show break", onClick: () => repin({ kind: "break", ref: last.before }) }] };
        } else if (change && last?.kind === "side") {
          const t = clock(last.start);
          const s = SIDE_NAME[last.side];
          const text =
            change === "merged"
              ? byWho((w) => `${w} put her back on the ${s} (no break)`, `Back on the ${s} (no break)`)
              : change === "resumed"
                ? byWho((w) => `${w} resumed on ${s} at ${t}`, `Resumed on ${s} at ${t}`)
                : byWho((w) => `${w} switched to ${s} at ${t}`, `Switched to ${s} at ${t}`);
          banner = { kind: "current", text, actions: [showOpen(last)] };
        }
        if (!banner) {
          const rec = recordedOf(moveRef && pin.kind === "side" ? { ...pin, ref: moveRef } : moveRef && pin.kind === "break" ? { ...pin, ref: moveRef } : pin, live, now);
          if (!sameRecorded(rec, snap.recorded)) {
            const [a, b] = rec.split("|");
            const [oa] = snap.recorded.split("|");
            const t = clock(pin.kind === "break" ? a : !oa || !a || !near(a, oa) ? a : b || a);
            banner = { kind: "moved", text: byWho((w) => `${w} just moved this to ${t}`, `This just moved to ${t}`) };
          }
        }
      }
    } else if (pin.kind === "after") {
      // Asked of the feed as Done left it: what the other phone has made of it since.
      const o = openStretch(live, now);
      const toCurrent = (label: string): BannerAction => ({ label, onClick: () => repin(resolvePin("current", live, nowFn())) });
      if (o) {
        const on = putOn(o.side, sidesOf(partsOf(live, now)).at(-2)?.side);
        const t = clock(o.start);
        banner = { kind: "current", text: byWho((w) => `${w} put her ${on} at ${t}`, `She's ${on} since ${t}`), actions: [toCurrent(`Show ${SIDE_NAME[o.side]}`)] };
      } else if (live.active) {
        banner = { kind: "current", text: byWho((w) => `${w} reopened this feed`, "This feed was reopened"), actions: [toCurrent("Show current")] };
      } else if (!endedAtPause(live) || !sameRecorded(live.ended_at ?? "", snap.recorded)) {
        const t = clock(live.ended_at ?? now);
        banner = { kind: "current", text: byWho((w) => `${w} changed this feed: it ends at ${t} now`, `This feed now ends at ${t}`), actions: [{ label: "Show finished feed", onClick: () => repin({ kind: "finish" }) }] };
      }
    } else if (pin.kind === "finish") {
      if (live.active) {
        banner = {
          kind: "current",
          text: byWho((w) => `${w} reopened this feed`, "This feed was reopened"),
          actions: [{ label: "Show current", onClick: () => repin(resolvePin("current", live, nowFn())) }],
        };
      } else if (!sameRecorded(live.ended_at ?? "", snap.recorded)) {
        const t = clock(live.ended_at ?? now);
        banner = { kind: "moved", text: byWho((w) => `${w} just moved this to ${t}`, `This just moved to ${t}`) };
      }
    } else if (!live.active) {
      const t = clock(live.ended_at ?? now);
      banner = { kind: "gone", text: `${byWho((w) => `${w} stopped this timer at ${t}`, `This timer stopped at ${t}`)}.`, actions: [{ label: "Close", onClick: onClose }] };
    } else if (!sameRecorded(live.started_at, snap.recorded)) {
      const t = clock(live.started_at);
      banner = { kind: "moved", text: byWho((w) => `${w} just moved this to ${t}`, `This just moved to ${t}`) };
    }
  }

  /** The other phone got there first: say what's recorded, and offer this phone's time for it or show that part. */
  function alreadyBanner(a: Already): Banner {
    const x = live ?? (a.kind === "stop" ? null : a.entry);
    const o = x ? openStretch(x, now) : null;
    const name = x ? memberLabel(x.updated_by) : null;
    const changed: Banner = { kind: "already", text: name ? `${name} just changed this feed, so nothing was saved.` : "This feed just changed, so nothing was saved." };
    if (a.kind === "ended" && x && !x.active && x.ended_at) {
      const t = clock(x.ended_at);
      const acts: BannerAction[] = [];
      const atPause = endedAtPause(x);
      const lastSide = sidesOf(partsOf(x, now)).at(-1);
      const otherFeed = state?.entries.some((y) => y.active && y.kind === "feed" && y.id !== x.id);
      const recent = !otherFeed && now.getTime() - Date.parse(x.ended_at) <= CONTINUE_WITHIN_MS;
      // As the dock offers after a stale Resume, one checked write carries the feed on (continueFeed: 409 if it changed again).
      const carry = (label: string, at: number | null): BannerAction => ({
        label,
        id: "continue",
        onClick: () => void run("continue", (o) => actions.continueFeed(x, a.side, at !== null ? new Date(at) : undefined, o), { backOn: { side: a.side, at } }),
      });
      if (recent && atPause) {
        // Ended at its pause: back on from the time this phone asked for ("Now": now).
        acts.push(carry(`Continue it on ${SIDE_NAME[a.side]} from ${short(a.at ?? now.getTime())}`, a.at));
      } else if (recent && lastSide?.end && lastSide.side === a.side) {
        // Ended while she was on the side this phone says she's on: that side just runs on, from when it began (the Done is taken back).
        acts.push(carry(`Continue it on ${SIDE_NAME[a.side]}, since ${short(lastSide.start)}`, null));
      }
      // (Ended while she was on the other side: carrying it on would record a side this phone never said, so only the feed.)
      acts.push({ label: "Show finished feed", onClick: () => repin({ kind: "finish" }) });
      // Ended while she was on: that side up to the Done ("· Left 9:44 – 9:46"), which no "at its pause" could say.
      const how = atPause ? ", at its pause" : lastSide?.end ? ` · ${SIDE_NAME[lastSide.side]} ${short(lastSide.start)} – ${short(lastSide.end)}` : "";
      return { kind: "already", text: `${name ? `${name} ended this feed at ${t}` : `This feed ended at ${t}`}${how}.`, actions: acts };
    }
    if (!x || !o) return changed;
    const sides = sidesOf(partsOf(x, now));
    if (a.kind === "stop") {
      // Still the stretch the chip was meant for: some other change (the banner can't say which).
      if (o.side === a.ref.side && near(o.start, a.ref.start)) return changed;
      const s = SIDE_NAME[o.side];
      const t = clock(o.start);
      const brk = partsOf(x, now).some((p) => p.kind === "break" && p.end === o.start);
      const did = brk || o.side === a.ref.side ? `put her ${putOn(o.side, sides.at(-2)?.side)} at ${t}` : `switched her to the ${s} at ${t}`;
      return { kind: "already", text: `${name ? `${name} ${did}` : `She's on the ${s} since ${t}`}, so nothing was saved. Pick again.` };
    }
    const s = SIDE_NAME[o.side];
    const t = clock(o.start);
    const sameSide = o.side === a.side;
    // Worded as the dock's toast for the same race ("Brittany already put her back on the Left at 7:08").
    // (The same side agrees with this phone, unless this phone said she'd finished by its Done.)
    const text = `${name ? `${name} already put her ${putOn(o.side, sides.at(-2)?.side)} at ${t}` : `She's already on the ${s} side, since ${t}`}${sameSide && a.until === undefined ? "." : ", so nothing was saved."}`;
    const acts: BannerAction[] = [];
    // (Not for "until Done" from panel E: the other phone says she's still on, so a time of this phone's would be half of each.)
    if (sameSide && a.until === undefined && a.at !== null && Math.abs(a.at - Date.parse(o.start)) >= MIN) {
      const to = a.at;
      acts.push({
        label: `Make it ${short(to)}`,
        id: "already-move",
        onClick: () => void run("already-move", (opts) => actions.retime(x, { op: "move", edge: "start", ref: o.ref, to: new Date(to).toISOString() }, opts)),
      });
    }
    // She's on the side this phone picked, not the other phone's: one tap switches her there now (as the dock's toast offers).
    if (!sameSide && a.until === undefined) acts.push({ label: `Switch to ${SIDE_NAME[a.side]}`, id: "switch", onClick: () => void run("switch", (o) => actions.switchSide(x, a.side, o)) });
    acts.push({ label: `Show ${s}`, onClick: () => repin({ kind: "side", ref: o.ref, index: sides.length - 1, panel: "open" }) });
    return { kind: "already", text, actions: acts };
  }

  // A moved stretch keeps its pin (and an open editor) under its new start, so the next chip names the stretch the server has.
  const moveKey = moveRef ? `${moveRef.side}|${moveRef.start}` : "";
  useEffect(() => {
    if (!moveKey || (pin.kind !== "side" && pin.kind !== "break")) return;
    const [side, startIso] = moveKey.split("|");
    const ref: StretchRef = { side: side as Side, start: startIso };
    const old = pin.ref;
    setPin({ ...pin, ref });
    setEditor((ed) => (ed?.edge?.ref && ed.edge.ref.side === old.side && near(ed.edge.ref.start, old.start) ? { ...ed, edge: { ...ed.edge, ref } } : ed));
  }, [moveKey, pin]);

  // Any change from elsewhere: controls wait 1.5 s, so a tap meant for the old times can't land on the new ones.
  const hold = useCallback(() => {
    setHolding(true);
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setHolding(false), HOLD_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);
  const sig = banner ? `${banner.kind}:${banner.text}` : "";
  const [heldSig, setHeldSig] = useState("");
  useEffect(() => {
    if (!sig || sig === heldSig) return;
    setHeldSig(sig);
    hold();
  }, [sig, heldSig, hold]);
  // The render that first shows a banner already waits (the effect starts the timer a frame later).
  const fresh = !!sig && sig !== heldSig;
  const dead = banner?.kind === "gone" || banner?.kind === "discarded";
  const disabled = !!busy || flight || holding || fresh || dead || readOnly;

  /** Commit one change: server first; success closes the sheet (the toast says what changed). */
  const run: Run = async (id, go, meta = {}) => {
    if (disabled) return;
    setBusy(id);
    onCommitting(true);
    setNotice(null);
    setAlready(null);
    let failure = null as TimerFailure | null;
    const res = await go({
      onError: (f) => {
        failure = f;
      },
    });
    onCommitting(false);
    const f = failure as TimerFailure | null;
    const r = isResponse(res) ? res : null;
    // "Already back on?" after the other phone's Resume on that side: nothing moved, so say what's there instead of closing as if saved.
    if (meta.backOn && !f && r?.noop) {
      setBusy(null);
      setAlready({ kind: "back", entry: r.entry, ...meta.backOn });
      return;
    }
    if (res && !f) {
      onClose();
      return;
    }
    setBusy(null);
    if (!f) return;
    if (meta.backOn && f.kind === "changed" && f.entry && openStretch(f.entry, nowFn())) {
      setAlready({ kind: "back", entry: f.entry, ...meta.backOn });
      return;
    }
    // The other phone's Done got there first: say so once (the banner, not a notice too), with a way to carry the feed on.
    if (meta.backOn && f.kind === "stopped" && f.entry) {
      setAlready({ kind: "ended", entry: f.entry, ...meta.backOn });
      return;
    }
    // An older server answers "Can't be before Left started" when the other phone resumed on the other side: a change, not a
    // mistake (the poll after the call brings her side in, and the banner names it then).
    if (meta.backOn && meta.backOn.until === undefined && f.kind === "bad" && f.code === "before_own_start") {
      setAlready({ kind: "back", entry: null, ...meta.backOn });
      return;
    }
    // A stop chip for the side this panel showed, after the other phone switched or resumed: "Can't be before Left started"
    // names a Left he can't see yet, so it's a change, not his mistake. Fetch it; the panel follows her new side (stop chips
    // for it) and the banner says who put her there.
    const moved = f.kind === "changed" && !!f.entry && openStretch(f.entry, nowFn());
    if (meta.stop && ((f.kind === "bad" && f.code === "before_own_start") || (moved && !(moved.side === meta.stop.ref.side && near(moved.start, meta.stop.ref.start))))) {
      setAlready({ kind: "stop", ref: meta.stop.ref });
      hold();
      if (f.kind === "bad") await refresh();
      return;
    }
    if (isGone(f)) {
      const text = f.who ? `${f.who} discarded this ${what}` : byWho((w) => `${w} discarded this ${what}`, `This ${what} was discarded`);
      setNotice({ text: `${text}, so nothing was saved.`, gone: { updatedAt: live?.updated_at ?? null, away: !live, who: f.who } });
      return;
    }
    if (f.kind === "changed") {
      const fWho = f.who;
      const fMine = !!me && f.entry?.updated_by === me;
      setNotice({
        text: fWho
          ? `${fWho} just changed this ${what}, so nothing was saved. Have another look.`
          : fMine || !f.entry
            ? `This ${what} just changed, so nothing was saved. Have another look.`
            : `This ${what} just changed ${ELSEWHERE}, so nothing was saved. Have another look.`,
      });
      // The banner (from the entry the 409 sent back) says what changed; the controls wait a moment.
      hold();
    } else if (f.kind === "offline") {
      setNotice({ text: "You're offline, so nothing was saved. Try again when you're back online." });
    } else {
      setNotice({ text: f.message });
    }
  };

  // "Pick again": a stop chip lost to the other phone's switch follows her to the side she's on now (its stop chips, as before).
  useEffect(() => {
    if (already?.kind !== "stop" || !live) return;
    const n = nowFn();
    const o = openStretch(live, n);
    if (!o || (o.side === already.ref.side && near(o.start, already.ref.start))) return;
    if (pin.kind === "side" && pin.ref.side === o.side && near(pin.ref.start, o.start)) return;
    const p: Pin = { kind: "side", ref: o.ref, index: sidesOf(partsOf(live, n)).length - 1, panel: "open" };
    setPin(p);
    setSnap({ recorded: recordedOf(p, live, n), current: currentOf(live, n) });
    setEditor(null);
  }, [already, live, pin, nowFn]);

  const openEditor = (ed: Editor) => {
    setNotice(null);
    setEditor(ed);
  };

  const panelProps: PanelProps = { e, tz, now, disabled, busy, run, openEditor };
  const parts = partsOf(e, now);

  let panel: ReactNode = null;
  if (editor) {
    const ed = editor;
    panel = (
      <MomentEditor
        entry={e}
        tz={tz}
        edge={ed.edge}
        free={ed.free}
        mode="commit"
        busy={busy === ed.id}
        disabled={disabled}
        who={who}
        mine={mine}
        onCancel={() => setEditor(null)}
        onSave={(to) =>
          void run(
            ed.id,
            (o) =>
              ed.edge
                ? actions.retime(e, { op: "move", edge: ed.edge.edge, ...(ed.edge.ref ? { ref: ed.edge.ref } : {}), to: to.toISOString() } as FeedEdit, o)
                : ed.commit!(to, o),
            ed.meta?.(to)
          )
        }
      />
    );
  } else if (pin.kind === "timer") {
    panel = <TimerPanel {...panelProps} finished={finished} setFinished={setFinished} actions={actions} />;
  } else if (pin.kind === "finish") {
    panel = <FinishPanel {...panelProps} actions={actions} />;
  } else if (pin.kind === "after") {
    panel = <AfterDonePanel {...panelProps} doneAt={doneAt ? Date.parse(doneAt) : Date.parse(e.ended_at ?? "")} backSide={backSide} setBackSide={setBackSide} actions={actions} />;
  } else if (pin.kind === "break") {
    panel = <BreakPanel {...panelProps} pinRef={pin.ref} backSide={backSide} setBackSide={setBackSide} backOnly={backOnly} actions={actions} />;
  } else if (pin.panel === "open") {
    panel = <OpenSidePanel {...panelProps} pin={pin} finished={finished} setFinished={setFinished} fromDone={expand === "done"} actions={actions} />;
  } else {
    panel = <ClosedSidePanel {...panelProps} pin={pin} actions={actions} />;
  }

  return (
    <>
      {/* An open editor says "Brittany just changed this to 4:22" itself, beside its picker; the sheet's banner would repeat it. */}
      {banner && !(editor?.edge && banner.kind === "moved") && (
        // One action sits beside the text; two go on their own row under it.
        <div role="status" className={cx("flex min-h-[44px] gap-x-3 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] leading-snug text-mp-ink-2", (banner.actions?.length ?? 0) > 1 ? "flex-col" : "items-center")}>
          <span className="min-w-0 flex-1">{banner.text}</span>
          {!!banner.actions?.length && (
            <span className={cx("flex shrink-0 flex-wrap gap-x-1", (banner.actions?.length ?? 0) > 1 ? "-mb-1 -ml-2" : "-my-1")}>
              {banner.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  disabled={!!a.id && disabled}
                  className="min-h-[44px] shrink-0 rounded-lg px-2 text-[13px] font-semibold text-mp-accent-fg disabled:opacity-45"
                >
                  {a.id && busy === a.id ? "Saving…" : a.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {/* "When did she go back on?" after a Done is one question about a feed that's over: no parts to pick from. */}
      {timed(e) && pin.kind !== "after" && (
        <PartPicker e={e} parts={parts} pin={pin} editing={editor?.edge?.ref} tz={tz} onPick={repin} disabled={!!busy} />
      )}
      {notice && !(notice.gone && !live) && (
        <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
          {notice.text}
        </p>
      )}
      {readOnly ? <p className="text-[15px] text-mp-ink-2">View only. Ask Matt or Brittany to fix the times.</p> : panel}
    </>
  );
}

/**
 * One chip per part ("(L) Left · 4:00–4:10", "‖ Break · since 4:10", "Ended
 * 4:50"): the filled one is the part on screen, which is the part an open
 * editor is about ("fix when Left ended" from Right's panel fills Left).
 * A long feed wraps onto more lines rather than scrolling sideways, so no
 * chip is ever cut to "5:20–5:32" without its side, or hidden off the edge.
 */
function PartPicker({
  e,
  parts,
  pin,
  editing,
  tz,
  onPick,
  disabled,
}: {
  e: Entry;
  parts: Part[];
  pin: Pin;
  /** The stretch an open editor moves a moment of, when it isn't the pinned one. */
  editing?: StretchRef;
  tz: string;
  onPick: (p: Pin) => void;
  disabled?: boolean;
}) {
  const shows: StretchRef | null = (pin.kind === "side" || pin.kind === "break") && editing ? editing : pin.kind === "side" ? pin.ref : null;
  const sides = sidesOf(parts);
  const openBreak = e.active && parts.at(-1)?.kind === "break" ? parts.at(-1)! : null;
  const chip = (key: string, selected: boolean, label: ReactNode, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cx(
        // (px-3: two parts fit side by side at 375 px.)
        "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium whitespace-nowrap tabular-nums transition disabled:opacity-60",
        selected
          ? "bg-mp-ink text-mp-surface [.maple-night_&]:bg-[rgb(224_169_59/0.2)] [.maple-night_&]:text-[#E8A23F]"
          : "bg-mp-sunken text-mp-ink"
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Which part">
      {sides.map((s, i) =>
        chip(
          `s-${s.ref.start}`,
          !!shows && shows.side === s.side && near(shows.start, s.start),
          <>
            <SideMark side={s.side} size={20} />
            {SIDE_NAME[s.side]} · {formatRange(s.start, s.end, tz, { compact: true })}
          </>,
          () => onPick({ kind: "side", ref: s.ref, index: i, panel: s.end === null && e.active ? "open" : "closed" })
        )
      )}
      {openBreak &&
        openBreak.kind === "break" &&
        chip(
          "break",
          pin.kind === "break" && !editing,
          <>
            <BreakMark open size={20} />
            Break · {formatRange(openBreak.start, null, tz, { compact: true })}
          </>,
          () => onPick({ kind: "break", ref: openBreak.before })
        )}
      {!e.active && e.ended_at && chip("end", pin.kind === "finish", `Ended ${formatTimeNear(e.ended_at, e.ended_at, tz)}`, () => onPick({ kind: "finish" }))}
    </div>
  );
}

type Actions = ReturnType<typeof useTimerActions>;
type PanelProps = {
  e: Entry;
  tz: string;
  now: Date;
  disabled: boolean;
  busy: string | null;
  run: Run;
  openEditor: (ed: Editor) => void;
};

function Title({ children, sub, focusRef }: { children: ReactNode; sub?: ReactNode; focusRef?: Ref<HTMLParagraphElement> }) {
  return (
    <div>
      <p ref={focusRef} tabIndex={focusRef ? -1 : undefined} className="text-[20px] leading-snug font-semibold text-mp-ink outline-none">
        {children}
      </p>
      {sub && <p className="mt-0.5 text-[14px] text-mp-ink-2">{sub}</p>}
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-snug text-mp-ink-2">{children}</p>;
}

/** "Wrong side? [It was Left]" and "Tapped Switch by mistake? [Undo the switch]": a question and one button. */
function QuestionRow({ question, label, onClick, disabled, busy }: { question: string; label: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="flex min-h-[48px] items-center gap-3">
      <span className="min-w-0 flex-1 text-[15px] text-mp-ink">{question}</span>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="min-h-[44px] shrink-0 rounded-xl bg-mp-sunken px-3.5 text-[14px] font-semibold text-mp-ink disabled:opacity-45 [.maple-night_&]:text-[#E8A23F]"
      >
        {busy ? "Saving…" : label}
      </button>
    </div>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

/**
 * "When did she finish?" on its own (a running feed, sleep, tummy time,
 * pumping): stop chips, Other time…, and one row back to the start's fix.
 * It takes the place of the start's chips, so "5 min earlier" and "5 min
 * ago" are never on screen together. Opened by a tap, it comes into view
 * at once (no glide at night or with reduced motion) and takes the focus.
 */
function FinishQuestion({
  title,
  sub,
  focus,
  children,
  back,
}: {
  title: string;
  sub: string;
  /** Opened by a tap here (not by the sheet opening): bring it into view and move focus to it. */
  focus: boolean;
  children: ReactNode;
  back: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLParagraphElement>(null);
  const night = useNightActive();
  const [focusOnMount] = useState(focus);
  const [still] = useState(night);
  useEffect(() => {
    if (!focusOnMount) return;
    const calm = still || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    wrap.current?.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
    head.current?.focus({ preventScroll: true });
  }, [focusOnMount, still]);
  return (
    <div ref={wrap} className="space-y-4">
      <Title sub={sub} focusRef={head}>
        {title}
      </Title>
      <div className="space-y-2">{children}</div>
      <div className="border-t border-mp-line pt-2">{back}</div>
    </div>
  );
}

/** "20 min ago", "1h ago", "3h 05m ago". */
const agoText = (m: number) => (m < 60 ? `${m} min ago` : m % 60 === 0 ? `${m / 60}h ago` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m ago`);

/**
 * Stop chips for "When did she finish?" / "When did she wake up?": "{N} min
 * ago" over the time, in time order. The likely end (15 min on the side) is a
 * tag on the chip nearest it, or its own "{N} min ago" chip in its place when
 * none is within 2 min, never a chip out of order. `nowChip` puts "Now" first
 * (Done now, as the dock's Done would).
 */
function StopChips({
  sinceStart,
  mins,
  likely,
  likelyWhy,
  verb,
  tooSoon,
  nowChip,
  now,
  tz,
  disabled,
  busy,
  onStop,
}: {
  /** The earliest end allowed (the current part's start + 1 min). */
  sinceStart: number;
  mins: number[];
  likely?: number | null;
  /** "15 min after she went on the Right": what the likely tag means. */
  likelyWhy?: string;
  /** "Ended" / "Woke up", for the chips' accessible names. */
  verb: string;
  tooSoon: string;
  nowChip?: boolean;
  now: Date;
  tz: string;
  disabled: boolean;
  busy: string | null;
  /** `at` undefined: now. */
  onStop: (id: string, at?: Date) => void;
}) {
  const n = now.getTime();
  const fits = (m: number) => n - m * MIN >= sinceStart;
  // A side left on for hours (the forgotten overnight feed): hours to pick from, not "185 min ago".
  let set = fits(60) ? [10, 30, 60, 120, 180].filter(fits) : mins.filter(fits);
  // A short part: the usual minutes don't fit, so smaller ones do.
  if (set.length < 2) set = [...new Set([1, 2, 3, ...mins])].filter(fits).sort((a, b) => a - b);
  // "Likely" is exactly what it says (15 min on the side): its own chip, unless one already shows that minute.
  let tagged: number | null = null;
  if (likely != null && likely >= sinceStart) {
    const lm = Math.max(1, Math.round((n - likely) / MIN));
    if (!set.includes(lm) && fits(lm)) set = [...set, lm].sort((a, b) => a - b);
    if (set.includes(lm)) tagged = lm;
  }
  if (!set.length && !nowChip) return <Caption>{tooSoon}</Caption>;
  return (
    <>
      <Grid>
        {nowChip && (
          <TimeChip
            variant="stop"
            tall
            line1="Now"
            line2={formatTimeNear(n, n, tz)}
            ariaLabel={`${verb} now, at ${formatTime(n, tz)}`}
            disabled={disabled}
            busy={busy === "stop-now"}
            onClick={() => onStop("stop-now")}
          />
        )}
        {set.map((m) => {
          const at = n - m * MIN;
          const isLikely = m === tagged;
          return (
            <TimeChip
              key={m}
              variant="stop"
              tall
              line1={agoText(m)}
              line2={`${formatTimeNear(at, at, tz)}${isLikely ? " · likely" : ""}`}
              ariaLabel={`${verb} ${minutesWord(m)} ago, at ${formatTime(at, tz)}${isLikely && likelyWhy ? `, likely (${likelyWhy})` : ""}`}
              disabled={disabled}
              busy={busy === `stop-${m}`}
              onClick={() => onStop(`stop-${m}`, new Date(at))}
            />
          );
        })}
      </Grid>
      {tagged !== null && likelyWhy && <Caption>&ldquo;Likely&rdquo; is {likelyWhy}.</Caption>}
    </>
  );
}

/** Panel A: the side she's on now. The common fix: she was on it before the tap. Or, folded away, she already finished. */
function OpenSidePanel({
  e,
  tz,
  now,
  disabled,
  busy,
  run,
  openEditor,
  pin,
  finished,
  setFinished,
  fromDone,
  actions,
}: PanelProps & { pin: Extract<Pin, { kind: "side" }>; finished: boolean; setFinished: (v: boolean) => void; fromDone?: boolean; actions: Actions }) {
  const { state } = useMaple();
  // Expanded by a tap (not by the sheet opening with it): that one scrolls into view and takes focus.
  const [tapped, setTapped] = useState(false);
  // Folded back by "Fix when Right started": focus goes to this panel's question (the row that had it is gone).
  const titleRef = useRef<HTMLParagraphElement>(null);
  const [back, setBack] = useState(0);
  useEffect(() => {
    if (back) titleRef.current?.focus();
  }, [back]);
  if (!timed(e)) return null;
  const parts = partsOf(e, now);
  const sides = sidesOf(parts);
  const found = locate(pin, e, now).part;
  const k = found ? sides.findIndex((x) => x.side === found.side && x.start === found.start) : -1;
  if (k < 0) return <Caption>This part changed, so there&apos;s nothing to fix here.</Caption>;
  const s = sides[k];
  const prev = k > 0 ? sides[k - 1] : null;
  const brk = parts.find((p) => p.kind === "break" && p.end === s.start) ?? null;
  const name = SIDE_NAME[s.side];
  const recorded = Date.parse(s.start);
  const stillOn = e.active && s.end === null;

  // Asked when she finished: of the side she's on now, even if the other phone switched her since. Never the start
  // chips under that question (a "10 min" meant "she finished 10 min ago" would move the start back instead).
  const fin = finished ? (stillOn ? s : e.active ? (sides.find((x) => x.end === null) ?? null) : null) : null;
  if (finished && !fin) {
    return <Caption>{e.active ? "She's on a break now, so Done ends the feed at its pause." : `This feed already ended${e.ended_at ? ` at ${formatTime(e.ended_at, tz)}` : ""}.`}</Caption>;
  }
  if (finished && fin) {
    const fName = SIDE_NAME[fin.side];
    const fFrom = Date.parse(fin.start);
    const likely = fFrom + 15 * MIN < now.getTime() - 2 * MIN ? fFrom + 15 * MIN : null;
    return (
      <FinishQuestion
        title="When did she finish?"
        sub={`${fName} side since ${formatTime(fin.start, tz)} (${minutesText(fin.min)}).`}
        focus={tapped}
        back={
          <LinkRow
            disabled={!!busy}
            onClick={() => {
              setFinished(false);
              setBack((b) => b + 1);
            }}
          >
            Fix when {fName} started
          </LinkRow>
        }
      >
        <StopChips
          sinceStart={fFrom + MIN}
          mins={[5, 10, 20, 30]}
          likely={likely}
          likelyWhy={`15 min after she went on the ${fName}`}
          verb="Ended"
          tooSoon={`${fName} only started ${formatTime(fin.start, tz)}, so use Other time…`}
          // Opened by Done (the dock's or the Lantern's, past "Still nursing?"): she may have just finished. Not from
          // "She finished earlier…", which says it wasn't now.
          nowChip={fromDone && !tapped}
          now={now}
          tz={tz}
          disabled={disabled}
          busy={busy}
          onStop={(id, at) => void run(id, (o) => actions.stop(e, at, o), { stop: { ref: fin.ref } })}
        />
        <LinkRow
          disabled={disabled}
          onClick={() =>
            openEditor({
              id: "editor",
              free: {
                title: "When did the feed end?",
                recorded: now,
                min: new Date(fFrom + MIN),
                max: now,
                notes: { low: `Can't be before ${fName} started (${formatTime(fin.start, tz)}).`, high: "That's in the future." },
              },
              commit: (to, o) => actions.stop(e, to, o),
              meta: () => ({ stop: { ref: fin.ref } }),
            })
          }
        >
          Other time…
        </LinkRow>
      </FinishQuestion>
    );
  }

  const ctx = feedCtx(e, now);
  let uiMin = recorded - 6 * 3600_000;
  try {
    uiMin = edgeBounds(e.data, { edge: "start", ref: s.ref }, ctx).uiMin.getTime();
  } catch {
    // keep the 6-hour floor
  }
  const floor = brk && prev?.end ? Date.parse(prev.end) : null;
  // The feed before this one: a feed start can't be laid over it by a chip (Other time… still can, with a word in its preview).
  const feedFloor = k === 0 ? previousFeedEnd(state?.entries, e) : null;
  const chips: { id: string; to: number; line1: string; aria: string; wide?: boolean }[] = [];
  let clipped = false;
  for (const n of [1, 2, 3, 4, 5, 10, 15]) {
    const to = recorded - n * MIN;
    if (floor !== null ? to <= floor : to < uiMin) continue;
    if (feedFloor !== null && to < feedFloor) {
      clipped = true;
      continue;
    }
    chips.push({ id: `a-${n}`, to, line1: `${n} min earlier`, aria: `${name} started ${minutesWord(n)} earlier, at ${formatTime(to, tz)}` });
  }
  // Any break, even one under a minute, can be no break at all.
  if (floor !== null && brk) chips.push({ id: "a-floor", to: floor, line1: "No break", aria: `No break: ${name} from ${formatTime(floor, tz)}, when she came off` });
  // (Not when the last chip kept already lands within a minute of it.)
  const lastTo = chips.at(-1)?.to ?? recorded;
  if (clipped && feedFloor !== null && lastTo - feedFloor >= MIN && feedFloor >= uiMin) {
    chips.push({ id: "a-feed", to: feedFloor, line1: "Since the last feed", aria: `${name} started when the last feed ended, at ${formatTime(feedFloor, tz)}`, wide: true });
  }
  // Two chips showing one clock time ("1 min earlier / 6:03" beside "No break / 6:03") would read as one: the named one stays.
  const named = new Set(chips.filter((c) => c.id === "a-floor" || c.id === "a-feed").map((c) => clockMinute(c.to)));
  const shown = chips.filter((c) => c.id === "a-floor" || c.id === "a-feed" || !named.has(clockMinute(c.to))).slice(0, 8);
  const move = (id: string, to: number) => void run(id, (o) => actions.retime(e, { op: "move", edge: "start", ref: s.ref, to: new Date(to).toISOString() }, o));

  let caption: string;
  if (k === 0) caption = `The whole feed starts earlier.${clipped && feedFloor !== null ? ` The last feed ended at ${formatTime(feedFloor, tz)}.` : ""}`;
  else if (brk && prev) {
    // Two parts on the same side: "Right stays 6 min" would read as this one.
    const prevName = prev.side === s.side ? `The earlier ${SIDE_NAME[prev.side]} (${formatRange(prev.start, prev.end, tz)})` : SIDE_NAME[prev.side];
    caption = `Comes out of the ${brk.min > 0 ? `${minutesText(brk.min)} ` : ""}break. ${prevName} stays ${minutesText(prev.min)}.`;
  } else caption = prev ? `Comes out of the ${SIDE_NAME[prev.side]} side (${minutesText(prev.min)} now).` : "";

  // "Same feed as 11:03?": a one-side feed started within 30 min of a timed feed ending (the start toast's offer is
  // only there for its 20 seconds).
  const before = k === 0 && stillOn && sides.length === 1 ? previousFeed(state?.entries, e) : null;
  const joinInto =
    before && before.kind === "feed" && before.data.method === "breast" && !!before.data.segments?.length && Date.parse(e.started_at) - Date.parse(before.ended_at!) <= 30 * MIN
      ? before
      : null;

  // Undo the tap that started this part, while that tap is fresh (its own start, not the feed's last edit).
  const mistap = k > 0 && stillOn ? freshTap(e, now, ["switch", "resume"]) : null;

  return (
    <div className="space-y-4">
      {/* (The feed's first side: the dock's tile is the side's name, never "Start".) */}
      <Title sub={`${name} shows since ${formatTime(s.start, tz)}.`} focusRef={titleRef}>{k === 0 ? `Was she nursing before you tapped ${name}?` : `Was she on the ${name} before you tapped?`}</Title>
      {shown.length ? (
        <div className="space-y-2">
          <Grid>
            {shown.map((c) => (
              <TimeChip
                key={c.id}
                tall
                line1={c.line1}
                line2={formatTimeNear(c.to, recorded, tz)}
                ariaLabel={c.aria}
                disabled={disabled}
                busy={busy === c.id}
                onClick={() => move(c.id, c.to)}
                className={c.wide ? "col-span-2" : undefined}
              />
            ))}
          </Grid>
          {caption && (
            <Caption>
              {caption}
              {/* The nap that ended as this feed began moves with an earlier start (the server does it). */}
              {k === 0 && <NapNote e={e} tz={tz} />}
            </Caption>
          )}
        </div>
      ) : prev ? (
        <Caption>{brk ? "The break was under a minute" : `${SIDE_NAME[prev.side]} was under a minute`}, so use Other time…</Caption>
      ) : (
        feedFloor !== null && <Caption>The last feed ended at {formatTime(feedFloor, tz)}, so use Other time…</Caption>
      )}
      <div>
        <LinkRow disabled={disabled} onClick={() => openEditor({ id: "editor", edge: { edge: "start", ref: s.ref } })}>
          Other time…
        </LinkRow>
        {pin.fromBreak && prev && (
          <LinkRow disabled={disabled} onClick={() => openEditor({ id: "editor", edge: { edge: "end", ref: prev.ref } })}>
            Or she came off later: fix when {SIDE_NAME[prev.side]} ended
          </LinkRow>
        )}
        <QuestionRow
          question="Wrong side?"
          label={`It was ${SIDE_NAME[other(s.side)]}`}
          disabled={disabled}
          busy={busy === "side"}
          onClick={() => void run("side", (o) => actions.setSide(e, s.ref, other(s.side), o))}
        />
        {joinInto && (
          // Started a few minutes after the last feed ended (a Done too early, or she came back for more): one feed.
          <QuestionRow
            question={`Same feed as ${formatTime(joinInto.started_at, tz)}?`}
            label="Join them"
            disabled={disabled}
            busy={busy === "join"}
            onClick={() => void run("join", (o) => actions.sameFeed(e, joinInto, s.side, o))}
          />
        )}
        {mistap && (
          <QuestionRow
            // The tile tapped: Switch, or her side's (the dock's resume tile is the side's name, "Right · Next side").
            question={mistap === "switch" ? "Tapped Switch by mistake?" : `Tapped ${name} by mistake?`}
            label={mistap === "switch" ? "Undo the switch" : "Back to paused"}
            disabled={disabled}
            busy={busy === "undo"}
            onClick={() => void run("undo", (o) => actions.undoTap(e, o))}
          />
        )}
      </div>
      {stillOn && (
        <div className="border-t border-mp-line pt-2">
          <LinkRow
            disabled={!!busy}
            onClick={() => {
              setTapped(true);
              setFinished(true);
            }}
          >
            She already finished
          </LinkRow>
        </div>
      )}
    </div>
  );
}

/** " The nap that ended at 4:05 moves too.": an earlier feed start takes the nap that ended as it began. */
function NapNote({ e, tz }: { e: Entry; tz: string }) {
  const { state } = useMaple();
  const start = Date.parse(e.started_at);
  const nap = state?.entries.find((x) => x.kind === "sleep" && !x.active && x.ended_at && Math.abs(Date.parse(x.ended_at) - start) <= 60_000);
  if (!nap?.ended_at) return null;
  return <> The nap that ended at {formatTimeNear(nap.ended_at, nap.ended_at, tz)} moves too.</>;
}

/** Panel B: a side part that's over. Each of its two moments opens its own editor. */
function ClosedSidePanel({ e, tz, now, disabled, busy, run, openEditor, pin, actions }: PanelProps & { pin: Extract<Pin, { kind: "side" }>; actions: Actions }) {
  if (!timed(e)) return null;
  const sides = sidesOf(partsOf(e, now));
  const found = locate(pin, e, now).part;
  const k = found ? sides.findIndex((x) => x.side === found.side && x.start === found.start) : -1;
  const s = sides[k];
  if (!s || s.end === null) return <Caption>This part changed, so there&apos;s nothing to fix here.</Caption>;
  const next = sides[k + 1];
  const name = SIDE_NAME[s.side];
  // After a break: "Back on the Left" only when she came off the Left, else "On the Right after the break" (as the feed sheet says it).
  const resumed = sides[k - 1]?.side === s.side ? `Back on the ${name}` : `On the ${name} after the break`;
  const startLabel = s.startMoment === "feed_start" ? "Feed started" : s.startMoment === "switch" ? `Switched to ${name}` : resumed;
  const endLabel = s.endMoment === "switch" && next ? `Switched to ${SIDE_NAME[next.side]}` : s.endMoment === "feed_end" ? "Feed ended" : "Came off";
  const edit = (edge: "start" | "end") => openEditor({ id: "editor", edge: { edge, ref: s.ref } });
  return (
    <div className="space-y-3">
      <p className="text-[17px] leading-snug font-semibold text-mp-ink tabular-nums">
        {name} · {formatRange(s.start, s.end, tz)} · {minutesText(s.min)}
      </p>
      <div>
        <LinkRow disabled={disabled} onClick={() => edit("start")}>
          {startLabel} {formatTime(s.start, tz)}
        </LinkRow>
        <LinkRow disabled={disabled} onClick={() => edit("end")}>
          {endLabel} {formatTime(s.end, tz)}
        </LinkRow>
        <QuestionRow
          question="Wrong side?"
          label={`It was ${SIDE_NAME[other(s.side)]}`}
          disabled={disabled}
          busy={busy === "side"}
          onClick={() => void run("side", (o) => actions.setSide(e, s.ref, other(s.side), o))}
        />
      </div>
    </div>
  );
}

/** Which side she went back on: the two sides, always both showing (the likely one picked when it opens). */
function SidePicker({ side, label, disabled, onPick }: { side: Side | null; label: string; disabled: boolean; onPick: (s: Side) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label}>
      {(["L", "R"] as Side[]).map((x) => (
        <button
          key={x}
          type="button"
          role="radio"
          aria-checked={side === x}
          disabled={disabled}
          onClick={() => onPick(x)}
          className={cx(
            "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition disabled:opacity-45",
            side === x ? "bg-mp-ink text-mp-surface [.maple-night_&]:bg-[rgb(224_169_59/0.2)] [.maple-night_&]:text-[#E8A23F]" : "bg-mp-sunken text-mp-ink"
          )}
        >
          <SideMark side={x} size={22} />
          {SIDE_NAME[x]}
        </button>
      ))}
    </div>
  );
}

/**
 * Panel C: the open break. Back on already (its two sides always showing),
 * came off earlier, or didn't mean to pause. Opened to say she's back on
 * (`backOnly`), that question stands alone and "Came off earlier?" folds
 * behind one row.
 */
function BreakPanel({
  e,
  tz,
  now,
  disabled,
  busy,
  run,
  openEditor,
  pinRef,
  backSide,
  setBackSide,
  backOnly,
  actions,
}: PanelProps & {
  pinRef: StretchRef;
  backSide: Side | null;
  setBackSide: (s: Side) => void;
  backOnly: boolean;
  actions: Actions;
}) {
  const { now: nowFn } = useMaple();
  const [cameOff, setCameOff] = useState(false);
  if (!timed(e)) return null;
  const parts = partsOf(e, now);
  const last = locate({ kind: "break", ref: pinRef }, e, now).part;
  const brk = parts.at(-1);
  if (!last || last.end === null || brk?.kind !== "break" || brk.end !== null) {
    if (!e.active && e.ended_at) return <Caption>{endedAtPause(e) ? `The feed ended at its pause (${formatTime(e.ended_at, tz)}).` : `The feed ended at ${formatTime(e.ended_at, tz)}.`}</Caption>;
    return <Caption>The break is over, so there&apos;s nothing to fix here.</Caption>;
  }
  const pauseAt = Date.parse(last.end);
  const n = now.getTime();
  const lastName = SIDE_NAME[last.side];

  const since: { id: string; at: number | null; line1: string; line2: string }[] = [{ id: "back-now", at: null, line1: "Now", line2: formatTimeNear(n, pauseAt, tz) }];
  for (const m of [2, 5, 10, 20]) {
    const at = n - m * MIN;
    // (One in the pause's own minute would show the same time as No break.)
    if (at <= pauseAt || clockMinute(at) === clockMinute(pauseAt)) continue;
    since.push({ id: `back-${m}`, at, line1: `${m} min ago`, line2: formatTimeNear(at, pauseAt, tz) });
  }
  // Back on since the break began: no break at all (the same words as panel A's floor chip).
  since.push({ id: "back-floor", at: pauseAt, line1: "No break", line2: formatTimeNear(pauseAt, pauseAt, tz) });

  const earlier: { id: string; to: number; n: number }[] = [];
  for (const m of [1, 2, 3, 5]) {
    const to = pauseAt - m * MIN;
    if (to < Date.parse(last.start) + MIN) continue;
    earlier.push({ id: `off-${m}`, to, n: m });
  }
  const showCameOff = !backOnly || cameOff;
  // Off the Left: "Back on the Left", but "On the Right" (the feed sheet's words).
  const on = backSide ? putOn(backSide, last.side) : "";

  return (
    <div className="space-y-4">
      <Title>
        On a break since {formatTime(last.end, tz)} ({minutesText(brk.min)})
      </Title>
      <div className="space-y-3">
        <p className="text-[15px] font-medium text-mp-ink">Already back on?</p>
        <SidePicker side={backSide} label="Which side is she on" disabled={disabled} onPick={setBackSide} />
        {backSide && (
          <>
            <Grid>
              {since.map((c) => (
                <TimeChip
                  key={c.id}
                  tall
                  line1={c.line1}
                  line2={c.line2}
                  ariaLabel={`${cap(on)} ${c.at === null ? "now" : c.id === "back-floor" ? "since the break began (no break)" : c.line1}, at ${formatTime(c.at ?? n, tz)}`}
                  disabled={disabled}
                  busy={busy === c.id}
                  onClick={() =>
                    // "Now" goes with its time too, so the server's rule for a time applies: the other phone's Resume on that side is
                    // "already", on the other side a 409, never a silent switch. (No "Make it" for it: now isn't a time he picked.)
                    void run(c.id, (o) => actions.resume(e, backSide, new Date(c.at ?? nowFn().getTime()), o), { backOn: { side: backSide, at: c.at } })
                  }
                />
              ))}
            </Grid>
            <LinkRow
              disabled={disabled}
              onClick={() =>
                openEditor({
                  id: "editor",
                  free: {
                    title: momentQuestion("resume", backSide, last.side),
                    recorded: now,
                    min: new Date(pauseAt),
                    max: now,
                    notes: { low: `Can't be before she came off (${formatTime(pauseAt, tz)}).`, high: "That's in the future." },
                  },
                  commit: (to, o) => actions.resume(e, backSide, to, o),
                  meta: (to) => ({ backOn: { side: backSide, at: to.getTime() } }),
                })
              }
            >
              Other time…
            </LinkRow>
          </>
        )}
      </div>
      {showCameOff ? (
        <div className="space-y-2">
          <p className="text-[15px] font-medium text-mp-ink">Came off earlier?</p>
          {earlier.length > 0 && (
            <Grid>
              {earlier.map((c) => (
                <TimeChip
                  key={c.id}
                  line1={`${c.n} min earlier`}
                  line2={formatTimeNear(c.to, pauseAt, tz)}
                  ariaLabel={`Came off ${minutesWord(c.n)} earlier, at ${formatTime(c.to, tz)}`}
                  disabled={disabled}
                  busy={busy === c.id}
                  onClick={() => void run(c.id, (o) => actions.retime(e, { op: "move", edge: "end", ref: last.ref, to: new Date(c.to).toISOString() }, o))}
                />
              ))}
            </Grid>
          )}
          <LinkRow disabled={disabled} onClick={() => openEditor({ id: "editor", edge: { edge: "end", ref: last.ref } })}>
            Other time…
          </LinkRow>
        </div>
      ) : (
        // Opened to say she's back on: when she came off is one quiet row, so its chips never sit beside the back-on ones.
        <div className="border-t border-mp-line pt-2">
          <LinkRow disabled={!!busy} onClick={() => setCameOff(true)}>
            Fix when she came off
          </LinkRow>
        </div>
      )}
      {!backOnly && freshTap(e, now, ["pause"]) && (
        <QuestionRow
          question="Didn't mean to pause?"
          label={`Keep ${lastName} going`}
          disabled={disabled}
          busy={busy === "undo"}
          onClick={() => void run("undo", (o) => actions.undoTap(e, o))}
        />
      )}
      {!backOnly && <Caption>Done in the dock ends the feed at {formatTimeNear(pauseAt, pauseAt, tz)}.</Caption>}
    </div>
  );
}

/**
 * Panel E: "She went back on…" on the Done toast, asked of the finished
 * feed as that Done left it (ended at its pause). Nothing is reopened to
 * ask, so closing without an answer, or a phone locked mid-question, leaves
 * the Done as it was. Which side (the other one first) and since when: a
 * chip between the pause and the Done tap adds that side up to the Done,
 * where the feed now ends; "She's still on" is the other answer, and its
 * chips carry the feed on from then, running (not paused, so the card never
 * asks "Still on a break?" right after). Each is one write, checked against
 * the feed this phone saw (backOnAfterDone), with an Undo back to the Done.
 */
function AfterDonePanel({
  e,
  tz,
  now,
  disabled,
  busy,
  run,
  openEditor,
  doneAt,
  backSide,
  setBackSide,
  actions,
}: PanelProps & {
  /** The Done tap (the side added ends there). */
  doneAt: number;
  backSide: Side | null;
  setBackSide: (s: Side) => void;
  actions: Actions;
}) {
  const [stillOn, setStillOn] = useState(false);
  const last = endedAtPause(e) ? sidesOf(partsOf(e, now)).at(-1) : undefined;
  // The other phone carried it on, added a side or moved the end: the banner says what, and how to see it.
  if (!last?.end) return <Caption>This feed changed, so there&apos;s nothing to add here.</Caption>;
  const pauseAt = Date.parse(last.end);
  const n = now.getTime();
  const side = backSide ?? other(last.side);
  const on = putOn(side, last.side);
  const done = formatTime(doneAt, tz);
  // Finished: the side runs to the Done tap (a minute at least); still on: it runs on from the time picked.
  const until = stillOn ? null : doneAt;
  const latest = until !== null ? until - MIN : n;
  const chips: { id: string; at: number; line1: string; line2: string }[] = [];
  if (stillOn) chips.push({ id: "after-now", at: n, line1: "Now", line2: formatTimeNear(n, pauseAt, tz) });
  for (const m of [2, 5, 10, 15, 20, 30]) {
    const at = n - m * MIN;
    // (One in the pause's own minute would show the same time as No break.)
    if (at <= pauseAt || at > latest || clockMinute(at) === clockMinute(pauseAt)) continue;
    chips.push({ id: `after-${m}`, at, line1: `${m} min ago`, line2: formatTimeNear(at, pauseAt, tz) });
  }
  chips.splice(5);
  chips.push({ id: "after-floor", at: pauseAt, line1: "No break", line2: formatTimeNear(pauseAt, pauseAt, tz) });
  const commit = (from: Date, o: TimerCallOptions) => actions.backOnAfterDone(e, side, from, until !== null ? new Date(until) : null, o);
  const meta = (at: number): RunMeta => ({ backOn: { side, at, ...(until !== null ? { until } : {}) } });
  const tail = until !== null ? `until ${done}` : "and still on";
  return (
    <div className="space-y-4">
      <Title sub={until !== null ? `You tapped Done at ${done}; the feed ended at ${formatTime(pauseAt, tz)}, when she came off.` : "She's still on, so the feed goes on from then."}>When did she go back on?</Title>
      <div className="space-y-3">
        <SidePicker side={side} label="Which side she went back on" disabled={disabled} onPick={setBackSide} />
        <Grid>
          {chips.map((c) => (
            <TimeChip
              key={c.id}
              tall
              line1={c.line1}
              line2={c.line2}
              ariaLabel={`${cap(on)} ${c.id === "after-floor" ? "when she came off (no break)" : c.id === "after-now" ? "now" : c.line1}, ${formatTime(c.at, tz)}, ${tail}`}
              disabled={disabled}
              busy={busy === c.id}
              onClick={() => void run(c.id, (o) => commit(new Date(c.at), o), meta(c.at))}
            />
          ))}
        </Grid>
        <LinkRow
          disabled={disabled}
          onClick={() =>
            openEditor({
              id: "editor",
              free: {
                title: momentQuestion("resume", side, last.side),
                recorded: new Date(until ?? n),
                min: new Date(pauseAt),
                max: new Date(until ?? n),
                notes: { low: `Can't be before she came off (${formatTime(pauseAt, tz)}).`, high: until !== null ? `That's when she finished (${done}).` : "That's in the future." },
              },
              commit,
              meta: (to) => meta(to.getTime()),
            })
          }
        >
          Other time…
        </LinkRow>
      </div>
      <div className="border-t border-mp-line pt-2">
        <LinkRow disabled={!!busy} onClick={() => setStillOn(!stillOn)}>
          {stillOn ? `She finished at ${done}` : "She's still on"}
        </LinkRow>
      </div>
    </div>
  );
}

/** Panel D: a finished feed's end ("Ended earlier…" on the Done toast). */
function FinishPanel({ e, tz, now, disabled, busy, run, openEditor, actions }: PanelProps & { actions: Actions }) {
  if (!timed(e) || e.active || !e.ended_at) return <Caption>This feed is still going.</Caption>;
  const parts = partsOf(e, now);
  const last = sidesOf(parts).at(-1);
  if (!last || last.end === null) return null;
  const legacy = parts.at(-1)?.kind === "break";
  const edge: MomentEdge = legacy ? { edge: "ended" } : { edge: "end", ref: last.ref };
  const recorded = Date.parse(e.ended_at);
  let uiMin = Date.parse(last.start) + MIN;
  try {
    uiMin = edgeBounds(e.data, edge, feedCtx(e, now)).uiMin.getTime();
  } catch {
    // keep a minute on the last side
  }
  const total = partTotals(parts).min.nursing;
  const chipsFor = (mins: number[]) => mins.map((m) => ({ id: `end-${m}`, m, to: recorded - m * MIN })).filter((c) => c.to >= uiMin);
  // A short last part: the usual chips would all land before it started, so offer the minutes that fit.
  let chips = chipsFor([5, 10, 15, 20, 30]);
  if (chips.length < 2) chips = chipsFor([1, 2, 3, 5, 10, 15, 20, 30]).slice(0, 5);
  const commit = (to: Date, o: TimerCallOptions) => actions.retime(e, { op: "move", ...edge, to: to.toISOString() } as FeedEdit, o);
  return (
    <div className="space-y-4">
      <Title>
        Ended {formatTime(e.ended_at, tz)} · nursed {minutesShort(total)}
      </Title>
      <div className="space-y-2">
        {chips.length > 0 ? (
          <>
            <p className="text-[15px] font-medium text-mp-ink">Ended earlier?</p>
            <Grid>
              {chips.map((c) => (
                <TimeChip
                  key={c.id}
                  tall
                  line1={`${c.m} min earlier`}
                  line2={formatTimeNear(c.to, recorded, tz)}
                  ariaLabel={`Ended ${minutesWord(c.m)} earlier, at ${formatTime(c.to, tz)}`}
                  disabled={disabled}
                  busy={busy === c.id}
                  onClick={() => void run(c.id, (o) => commit(new Date(c.to), o))}
                />
              ))}
            </Grid>
          </>
        ) : (
          <Caption>
            {legacy ? "The end is right after the last side" : `${SIDE_NAME[last.side]} only ran ${minutesText(last.min)}`}, so there&apos;s no earlier minute to pick here.
          </Caption>
        )}
        <LinkRow disabled={disabled} onClick={() => openEditor({ id: "editor", edge })}>
          Other time…
        </LinkRow>
      </div>
    </div>
  );
}

/** Sleep, tummy time and pumping: when it started, and (folded) when it already ended. */
function TimerPanel({ e, tz, now, disabled, busy, run, openEditor, finished, setFinished, actions }: PanelProps & { finished: boolean; setFinished: (v: boolean) => void; actions: Actions }) {
  const [tapped, setTapped] = useState(false);
  const sleep = e.kind === "sleep";
  const start = Date.parse(e.started_at);
  const earlierMins = sleep ? [5, 10, 15, 20, 30, 45] : [1, 2, 3, 5, 10, 15];
  const endMins = sleep ? [5, 10, 15, 20, 30, 45] : [2, 5, 10, 15, 20];
  const what = KIND_TITLE[e.kind as TimerKind] ?? "Timer";
  const endOther = (
    <LinkRow
      disabled={disabled}
      onClick={() =>
        openEditor({
          id: "editor",
          free: {
            title: sleep ? "When did she wake up?" : `When did ${what.toLowerCase()} end?`,
            recorded: now,
            min: new Date(start + MIN),
            max: now,
            notes: { low: `Can't be before it started (${formatTime(start, tz)}).`, high: "That's in the future." },
          },
          commit: (to, o) => actions.stop(e, to, o),
        })
      }
    >
      Other time…
    </LinkRow>
  );
  if (finished) {
    return (
      <FinishQuestion
        title={sleep ? "When did she wake up?" : `When did ${what.toLowerCase()} end?`}
        sub={`${sleep ? "Asleep" : what} since ${formatTime(start, tz)}.`}
        focus={tapped}
        back={
          <LinkRow disabled={!!busy} onClick={() => setFinished(false)}>
            {sleep ? "Fix when she fell asleep" : `Fix when ${what.toLowerCase()} started`}
          </LinkRow>
        }
      >
        <StopChips
          sinceStart={start + MIN}
          mins={endMins}
          verb={sleep ? "Woke up" : "Ended"}
          tooSoon="It only just started, so use Other time…"
          now={now}
          tz={tz}
          disabled={disabled}
          busy={busy}
          onStop={(id, at) => void run(id, (o) => actions.stop(e, at, o))}
        />
        {endOther}
      </FinishQuestion>
    );
  }
  return (
    <div className="space-y-4">
      <Title sub={`${sleep ? "Asleep" : what} since ${formatTime(start, tz)}.`}>{sleep ? "Fell asleep before you tapped?" : "Started before you tapped?"}</Title>
      <Grid>
        {earlierMins.map((m) => {
          const to = start - m * MIN;
          return (
            <TimeChip
              key={m}
              tall
              line1={`${m} min earlier`}
              line2={formatTimeNear(to, start, tz)}
              ariaLabel={`${sleep ? "Fell asleep" : "Started"} ${minutesWord(m)} earlier, at ${formatTime(to, tz)}`}
              disabled={disabled}
              busy={busy === `s-${m}`}
              onClick={() => void run(`s-${m}`, (o) => actions.adjust(e, new Date(to), o))}
            />
          );
        })}
      </Grid>
      <LinkRow
        disabled={disabled}
        onClick={() =>
          openEditor({
            id: "editor",
            free: {
              title: sleep ? "When did she fall asleep?" : `When did ${what.toLowerCase()} start?`,
              recorded: new Date(start),
              min: new Date(start - 6 * 3600_000),
              max: now,
              notes: { low: "That's more than 6 hours back.", high: "That's in the future." },
            },
            commit: (to, o) => actions.adjust(e, to, o),
          })
        }
      >
        Other time…
      </LinkRow>
      <div className="border-t border-mp-line pt-2">
        <LinkRow
          disabled={!!busy}
          onClick={() => {
            setTapped(true);
            setFinished(true);
          }}
        >
          {sleep ? "She's already awake" : "Already done"}
        </LinkRow>
      </div>
    </div>
  );
}

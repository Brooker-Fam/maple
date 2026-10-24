"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { edgeBounds, feedCtx, feedParts, minutesShort, minutesText, other, partTotals, undoableTap, type Part, type TapWhat } from "@/lib/maple/feed";
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
 *   open({ kind, entry, preset: fixPreset(target, expand?) })
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
  /** Sleep, tummy time, pumping (one panel). */
  | { kind: "timer" };

/** What's live (the side she's on, the open break, the end): its kind, side, start, and how many side parts lead to it. */
type Cur = { kind: "ended" | "side" | "break" | "none"; side?: Side; start?: string; count: number };

type Snap = { recorded: string; current: Cur };

/** What a commit was for, when the answer needs reading ("Already back on?" racing the other phone's Resume). */
type RunMeta = { backOn?: { side: Side; at: number | null } };

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
  meta?: RunMeta;
};

type BannerAction = { label: string; onClick: () => void };
type Banner = { kind: "discarded" | "gone" | "current" | "moved" | "already"; text: string; actions?: BannerAction[] };

/** "Brittany already put her on the Right at 3:17": the other phone's Resume got there first (`entry`: the server's copy, when the answer carried one). */
type Already = { entry: Entry | null; side: Side; at: number | null };

type Run = (id: string, go: (o: TimerCallOptions) => Promise<unknown>, meta?: RunMeta) => Promise<void>;

const HOLD_MS = 1500;
const MIN = 60_000;
const ELSEWHERE = "on another device or through Claude";

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1500;
const timed = (e: Entry): e is Entry & { kind: "feed"; data: FeedData } => e.kind === "feed" && e.data.method === "breast" && !!e.data.segments?.length;
const partsOf = (e: Entry, now: Date): Part[] => (timed(e) ? feedParts(e.data, feedCtx(e, now)) : []);
const sidesOf = (parts: Part[]) => parts.filter((p): p is SidePart => p.kind === "side");
const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;
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

function resolvePin(target: FixTarget, e: Entry, now: Date): Pin {
  if (!timed(e)) return { kind: "timer" };
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
  if (pin.kind === "finish") return e.ended_at ?? "";
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

/** When the feed before this one ended (start chips stop there, so a fix can't lay this feed over it). */
function lastFeedEnd(entries: Entry[] | undefined, e: Entry): number | null {
  const start = Date.parse(e.started_at);
  let best: number | null = null;
  for (const x of entries ?? []) {
    if (x.kind !== "feed" || x.id === e.id || x.active || !x.ended_at) continue;
    const t = Date.parse(x.ended_at);
    if (t <= start + 1000 && (best === null || t > best)) best = t;
  }
  return best;
}

export default function FixTimesSheet({ open, onClose, kind, entry, preset }: SheetProps) {
  const { state, memberLabel, timerBusy } = useMaple();
  const count = useOpenCount(open);
  useHoldTimerToasts(open);
  const [committing, setCommitting] = useState(false);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const live = entry ? state?.entries.find((e) => e.id === entry.id) ?? null : null;
  const e = live ?? entry;
  if (!e) return null;
  const by = memberLabel(e.created_by);
  const subtitle = timed(e)
    ? `Nursing · feed started ${formatTime(e.started_at, tz)}${by ? ` · by ${by}` : ""}`
    : `${KIND_TITLE[kind as TimerKind] ?? "Timer"} · since ${formatTime(e.started_at, tz)}`;
  const fix = (preset?.fix ?? { target: "current" }) as FixPreset["fix"];
  // A tap from this phone (the dock, a toast) still on its way: the sheet waits for its answer, as for a timer that's still starting.
  const saving = e.id > 0 && timerBusy(e.id) && !committing;
  return (
    <Sheet open={open} onClose={onClose} title={saving ? "Fix times · saving…" : "Fix times"} subtitle={subtitle} calm>
      {/* A fresh pin each time it opens (the router keeps one instance per entry mounted). */}
      <FixBody key={count} start={e} live={live} target={fix.target} expand={fix.expand} open={open} onClose={onClose} tz={tz} onCommitting={setCommitting} />
    </Sheet>
  );
}

function FixBody({
  start,
  live,
  target,
  expand,
  open,
  onClose,
  tz,
  onCommitting,
}: {
  start: Entry;
  live: Entry | null;
  target: FixTarget;
  expand?: FixExpand;
  open: boolean;
  onClose: () => void;
  tz: string;
  onCommitting: (on: boolean) => void;
}) {
  const { state, now: nowFn, memberLabel, readOnly, timerBusy } = useMaple();
  const actions = useTimerActions();
  const now = useNow(1000);
  const e = live ?? start;
  const me = state?.me.email ?? null;
  const [pin, setPin] = useState<Pin>(() => resolvePin(target, start, nowFn()));
  const [snap, setSnap] = useState<Snap>(() => ({ recorded: recordedOf(pin, start, nowFn()), current: currentOf(start, nowFn()) }));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; gone?: { updatedAt: string | null; away: boolean; who: string | null } } | null>(null);
  const [already, setAlready] = useState<Already | null>(null);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [finished, setFinished] = useState(expand === "finished");
  // "She's back on…" / "She went back on…": the other side is the likely one (the dock's next side), one tap from the chips.
  const [backSide, setBackSide] = useState<Side | null>(() => (expand === "backOn" && pin.kind === "break" ? other(pin.ref.side) : null));
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
      // The 404 that stopped this sheet's commit may name who discarded it; otherwise the last person to change it.
      const text = g?.who ? `${g.who} discarded this ${what}` : byWho((w) => `${w} discarded this ${what}`, `This ${what} was discarded`);
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

  /** The other phone's Resume got there first: say what's recorded, offer this phone's time for it, or show that side. */
  function alreadyBanner(a: Already): Banner {
    const x = live ?? a.entry;
    const o = x ? openStretch(x, now) : null;
    const name = x ? memberLabel(x.updated_by) : null;
    if (!x || !o) return { kind: "already", text: name ? `${name} just changed this feed, so nothing was saved.` : "This feed just changed, so nothing was saved." };
    const sides = sidesOf(partsOf(x, now));
    const s = SIDE_NAME[o.side];
    const t = clock(o.start);
    const sameSide = o.side === a.side;
    const text = `${name ? `${name} already put her on the ${s} at ${t}` : `She's already on the ${s}, since ${t}`}${sameSide ? "." : ", so nothing was saved."}`;
    const acts: BannerAction[] = [];
    if (sameSide && a.at !== null && Math.abs(a.at - Date.parse(o.start)) >= MIN) {
      const to = a.at;
      acts.push({
        label: `Make it ${short(to)}`,
        onClick: () => void run("already-move", (opts) => actions.retime(x, { op: "move", edge: "start", ref: o.ref, to: new Date(to).toISOString() }, opts)),
      });
    }
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
      setAlready({ entry: r.entry, side: meta.backOn.side, at: meta.backOn.at });
      return;
    }
    if (res && !f) {
      onClose();
      return;
    }
    setBusy(null);
    if (!f) return;
    if (meta.backOn && f.kind === "changed" && f.entry && openStretch(f.entry, nowFn())) {
      setAlready({ entry: f.entry, side: meta.backOn.side, at: meta.backOn.at });
      return;
    }
    // An older server answers "Can't be before Left started" when the other phone resumed on the other side: a change, not a
    // mistake (the poll after the call brings her side in, and the banner names it then).
    if (meta.backOn && f.kind === "bad" && f.code === "before_own_start") {
      setAlready({ entry: null, side: meta.backOn.side, at: meta.backOn.at });
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
            ed.meta
          )
        }
      />
    );
  } else if (pin.kind === "timer") {
    panel = <TimerPanel {...panelProps} finished={finished} setFinished={setFinished} actions={actions} />;
  } else if (pin.kind === "finish") {
    panel = <FinishPanel {...panelProps} actions={actions} />;
  } else if (pin.kind === "break") {
    panel = <BreakPanel {...panelProps} pinRef={pin.ref} backSide={backSide} setBackSide={setBackSide} actions={actions} />;
  } else if (pin.panel === "open") {
    panel = <OpenSidePanel {...panelProps} pin={pin} finished={finished} setFinished={setFinished} actions={actions} />;
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
            <span className={cx("flex shrink-0 gap-1", (banner.actions?.length ?? 0) > 1 ? "-mb-1 -ml-2" : "-my-1")}>
              {banner.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.onClick}
                  disabled={a.label.startsWith("Make it") && disabled}
                  className="min-h-[44px] shrink-0 rounded-lg px-2 text-[13px] font-semibold text-mp-accent-fg disabled:opacity-45"
                >
                  {busy === "already-move" && a.label.startsWith("Make it") ? "Saving…" : a.label}
                </button>
              ))}
            </span>
          )}
        </div>
      )}
      {timed(e) && <PartPicker e={e} parts={parts} pin={pin} tz={tz} onPick={repin} disabled={!!busy} />}
      {notice && !(notice.gone && !live) && (
        <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
          {notice.text}
        </p>
      )}
      {readOnly ? <p className="text-[15px] text-mp-ink-2">View only. Ask Matt or Brittany to fix the times.</p> : panel}
    </>
  );
}

/** One chip per part ("(L) Left · 4:00–4:10", "‖ Break · since 4:10", "Ended 4:50"): the pinned one is filled. */
function PartPicker({ e, parts, pin, tz, onPick, disabled }: { e: Entry; parts: Part[]; pin: Pin; tz: string; onPick: (p: Pin) => void; disabled?: boolean }) {
  const row = useRef<HTMLDivElement>(null);
  const pinKey = pin.kind === "side" ? `${pin.ref.side}${pin.ref.start}` : pin.kind;
  // The pinned chip in view (a long feed scrolls the row sideways).
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row.current && el) row.current.scrollLeft = Math.max(0, el.offsetLeft - 20);
  }, [pinKey]);
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
        "inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-medium whitespace-nowrap tabular-nums transition disabled:opacity-60",
        selected
          ? "bg-mp-ink text-mp-surface [.maple-night_&]:bg-[rgb(224_169_59/0.2)] [.maple-night_&]:text-[#E8A23F]"
          : "bg-mp-sunken text-mp-ink"
      )}
    >
      {label}
    </button>
  );
  return (
    <div ref={row} className="relative -mx-5 flex gap-2 overflow-x-auto px-5 pb-0.5 [scrollbar-width:none]" role="group" aria-label="Which part">
      {sides.map((s, i) =>
        chip(
          `s-${s.ref.start}`,
          pin.kind === "side" && pin.ref.side === s.side && near(pin.ref.start, s.start),
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
          pin.kind === "break",
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

/**
 * Stop chips for "When did she finish?" / "When did she wake up?": "{N} min
 * ago" over the time, in time order. The likely end (15 min on the side) is a
 * tag on the chip nearest it, or its own "{N} min ago" chip in its place when
 * none is within 2 min, never a chip out of order.
 */
function StopChips({
  sinceStart,
  mins,
  likely,
  likelyWhy,
  verb,
  tooSoon,
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
  now: Date;
  tz: string;
  disabled: boolean;
  busy: string | null;
  onStop: (id: string, at: Date) => void;
}) {
  const n = now.getTime();
  const fits = (m: number) => n - m * MIN >= sinceStart;
  let set = mins.filter(fits);
  // A short part: the usual minutes don't fit, so smaller ones do.
  if (set.length < 2) set = [...new Set([1, 2, 3, ...mins])].filter(fits).sort((a, b) => a - b);
  let tagged: number | null = null;
  if (likely != null && likely >= sinceStart) {
    const lm = Math.max(1, Math.round((n - likely) / MIN));
    const closest = set.reduce<number | null>((best, m) => (best === null || Math.abs(m - lm) < Math.abs(best - lm) ? m : best), null);
    if (closest !== null && Math.abs(closest - lm) <= 2) tagged = closest;
    else if (fits(lm)) {
      set = [...set, lm].sort((a, b) => a - b);
      tagged = lm;
    }
  }
  if (!set.length) return <Caption>{tooSoon}</Caption>;
  return (
    <>
      <Grid>
        {set.map((m) => {
          const at = n - m * MIN;
          const isLikely = m === tagged;
          return (
            <TimeChip
              key={m}
              variant="stop"
              tall
              line1={`${m} min ago`}
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
  actions,
}: PanelProps & { pin: Extract<Pin, { kind: "side" }>; finished: boolean; setFinished: (v: boolean) => void; actions: Actions }) {
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

  if (finished && stillOn) {
    const likely = recorded + 15 * MIN < now.getTime() - 2 * MIN ? recorded + 15 * MIN : null;
    return (
      <FinishQuestion
        title="When did she finish?"
        sub={`${name} side since ${formatTime(s.start, tz)} (${minutesText(s.min)}).`}
        focus={tapped}
        back={
          <LinkRow
            disabled={!!busy}
            onClick={() => {
              setFinished(false);
              setBack((b) => b + 1);
            }}
          >
            Fix when {name} started
          </LinkRow>
        }
      >
        <StopChips
          sinceStart={recorded + MIN}
          mins={[5, 10, 20, 30]}
          likely={likely}
          likelyWhy={`15 min after she went on the ${name}`}
          verb="Ended"
          tooSoon={`${name} only started ${formatTime(s.start, tz)}, so use Other time…`}
          now={now}
          tz={tz}
          disabled={disabled}
          busy={busy}
          onStop={(id, at) => void run(id, (o) => actions.stop(e, at, o))}
        />
        <LinkRow
          disabled={disabled}
          onClick={() =>
            openEditor({
              id: "editor",
              free: {
                title: "When did the feed end?",
                recorded: now,
                min: new Date(recorded + MIN),
                max: now,
                notes: { low: `Can't be before ${name} started (${formatTime(s.start, tz)}).`, high: "That's in the future." },
              },
              commit: (to, o) => actions.stop(e, to, o),
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
  const feedFloor = k === 0 ? lastFeedEnd(state?.entries, e) : null;
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
  if (floor !== null && brk && brk.sec >= 60) chips.push({ id: "a-floor", to: floor, line1: "No break", aria: `No break: ${name} from ${formatTime(floor, tz)}, when she came off` });
  // (Not when the last chip kept already lands within a minute of it.)
  const lastTo = chips.at(-1)?.to ?? recorded;
  if (clipped && feedFloor !== null && lastTo - feedFloor >= MIN && feedFloor >= uiMin) {
    chips.push({ id: "a-feed", to: feedFloor, line1: "Since the last feed", aria: `${name} started when the last feed ended, at ${formatTime(feedFloor, tz)}`, wide: true });
  }
  const shown = chips.slice(0, 8);
  const move = (id: string, to: number) => void run(id, (o) => actions.retime(e, { op: "move", edge: "start", ref: s.ref, to: new Date(to).toISOString() }, o));

  let caption: string;
  if (k === 0) caption = `The whole feed starts earlier.${clipped && feedFloor !== null ? ` The last feed ended at ${formatTime(feedFloor, tz)}.` : ""}`;
  else if (brk && prev) {
    // Two parts on the same side: "Right stays 6 min" would read as this one.
    const prevName = prev.side === s.side ? `The earlier ${SIDE_NAME[prev.side]} (${formatRange(prev.start, prev.end, tz)})` : SIDE_NAME[prev.side];
    caption = `Comes out of the ${minutesText(brk.min)} break. ${prevName} stays ${minutesText(prev.min)}.`;
  } else caption = prev ? `Comes out of the ${SIDE_NAME[prev.side]} side (${minutesText(prev.min)} now).` : "";

  // Undo the tap that started this part, while that tap is fresh (its own start, not the feed's last edit).
  const mistap = k > 0 && stillOn ? freshTap(e, now, ["switch", "resume"]) : null;

  return (
    <div className="space-y-4">
      <Title sub={`${name} shows since ${formatTime(s.start, tz)}.`} focusRef={titleRef}>{k === 0 ? `Was she on the ${name} before you tapped Start?` : `Was she on the ${name} before you tapped?`}</Title>
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
        <Caption>{SIDE_NAME[prev.side]} was under a minute, so use Other time…</Caption>
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
        {mistap && (
          <QuestionRow
            question={mistap === "switch" ? "Tapped Switch by mistake?" : "Tapped Resume by mistake?"}
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
  const startLabel = s.startMoment === "feed_start" ? "Feed started" : s.startMoment === "switch" ? `Switched to ${name}` : `Back on the ${name}`;
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

/** Panel C: the open break. Back on already (its two sides always showing), came off earlier, or didn't mean to pause. */
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
  actions,
}: PanelProps & {
  pinRef: StretchRef;
  backSide: Side | null;
  setBackSide: (s: Side) => void;
  actions: Actions;
}) {
  if (!timed(e)) return null;
  const parts = partsOf(e, now);
  const last = locate({ kind: "break", ref: pinRef }, e, now).part;
  const brk = parts.at(-1);
  if (!last || last.end === null || brk?.kind !== "break" || brk.end !== null) {
    return <Caption>The break is over, so there&apos;s nothing to fix here.</Caption>;
  }
  const pauseAt = Date.parse(last.end);
  const n = now.getTime();
  const lastName = SIDE_NAME[last.side];

  const since: { id: string; at: number | null; line1: string; line2: string; wide?: boolean }[] = [{ id: "back-now", at: null, line1: "Now", line2: formatTimeNear(n, pauseAt, tz) }];
  for (const m of [2, 5, 10, 20]) {
    const at = n - m * MIN;
    if (at <= pauseAt) continue;
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

  return (
    <div className="space-y-4">
      <Title>
        On a break since {formatTime(last.end, tz)} ({minutesText(brk.min)})
      </Title>
      <div className="space-y-3">
        <p className="text-[15px] font-medium text-mp-ink">Already back on?</p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Which side is she on">
          {(["L", "R"] as Side[]).map((side) => (
            <button
              key={side}
              type="button"
              role="radio"
              aria-checked={backSide === side}
              disabled={disabled}
              onClick={() => setBackSide(side)}
              className={cx(
                "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition disabled:opacity-45",
                backSide === side ? "bg-mp-ink text-mp-surface [.maple-night_&]:bg-[rgb(224_169_59/0.2)] [.maple-night_&]:text-[#E8A23F]" : "bg-mp-sunken text-mp-ink"
              )}
            >
              <SideMark side={side} size={22} />
              {SIDE_NAME[side]}
            </button>
          ))}
        </div>
        {backSide && (
          <>
            <Grid>
              {since.map((c) => (
                <TimeChip
                  key={c.id}
                  tall
                  line1={c.line1}
                  line2={c.line2}
                  ariaLabel={`Back on the ${SIDE_NAME[backSide]} ${c.at === null ? "now" : c.id === "back-floor" ? "since the break began (no break)" : c.line1}, at ${formatTime(c.at ?? n, tz)}`}
                  disabled={disabled}
                  busy={busy === c.id}
                  onClick={() => void run(c.id, (o) => actions.resume(e, backSide, c.at === null ? undefined : new Date(c.at), o), { backOn: { side: backSide, at: c.at } })}
                />
              ))}
            </Grid>
            <LinkRow
              disabled={disabled}
              onClick={() =>
                openEditor({
                  id: "editor",
                  free: {
                    title: `When did she go back on the ${SIDE_NAME[backSide]}?`,
                    recorded: now,
                    min: new Date(pauseAt),
                    max: now,
                    notes: { low: `Can't be before she came off (${formatTime(pauseAt, tz)}).`, high: "That's in the future." },
                  },
                  commit: (to, o) => actions.resume(e, backSide, to, o),
                  meta: { backOn: { side: backSide, at: null } },
                })
              }
            >
              Other time…
            </LinkRow>
          </>
        )}
      </div>
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
      {freshTap(e, now, ["pause"]) && (
        <QuestionRow
          question="Didn't mean to pause?"
          label={`Keep ${lastName} going`}
          disabled={disabled}
          busy={busy === "undo"}
          onClick={() => void run("undo", (o) => actions.undoTap(e, o))}
        />
      )}
      <Caption>Done in the dock ends the feed at {formatTimeNear(pauseAt, pauseAt, tz)}.</Caption>
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

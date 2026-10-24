"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { edgeBounds, feedCtx, feedParts, other, partTotals, type Part } from "@/lib/maple/feed";
import { DEFAULT_TZ, formatDuration, formatMinutes, formatRange, formatTime, formatTimeNear } from "@/lib/maple/time";
import type { Entry, FeedData, Side, StretchRef, TimerKind } from "@/lib/maple/types";
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
import { Sheet, cx } from "../ui";
import { useMaple, useNow, type TimerCallOptions, type TimerFailure } from "../useMaple";
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

type Snap = { recorded: string; current: string };

type Editor = { id: string; edge?: MomentEdge; free?: { title: string; recorded: Date; min: Date; max: Date; notes?: { low?: string; high?: string } }; commit: (to: Date, o: TimerCallOptions) => Promise<unknown> };

type Banner = { kind: "discarded" | "gone" | "current" | "moved"; text: string; action?: { label: string; onClick: () => void } };

const HOLD_MS = 1500;
const MIN = 60_000;
const ELSEWHERE = "on another device or through Claude";

const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1500;
const timed = (e: Entry): e is Entry & { kind: "feed"; data: FeedData } => e.kind === "feed" && e.data.method === "breast" && !!e.data.segments?.length;
const partsOf = (e: Entry, now: Date): Part[] => (timed(e) ? feedParts(e.data, feedCtx(e, now)) : []);
const sidesOf = (parts: Part[]) => parts.filter((p): p is SidePart => p.kind === "side");
const minutesWord = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** What's live right now: the side she's on, the open break, or the end. */
function currentKey(e: Entry, now: Date): string {
  if (!e.active) return `ended:${e.ended_at}`;
  const last = partsOf(e, now).at(-1);
  if (!last) return "running";
  return last.kind === "break" ? `break:${last.start}` : `side:${last.side}:${last.start}`;
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

/** The pinned part in the live entry: by its ref, else the same side at the same place (its start moved). */
function locate(pin: Pin, e: Entry, now: Date): { part: SidePart | null; moved: boolean } {
  if (pin.kind !== "side" && pin.kind !== "break") return { part: null, moved: false };
  const sides = sidesOf(partsOf(e, now));
  const i = sides.findIndex((s) => s.side === pin.ref.side && near(s.start, pin.ref.start));
  if (i >= 0) return { part: sides[i], moved: false };
  const c = pin.kind === "side" ? sides[pin.index] : undefined;
  return c && c.side === pin.ref.side ? { part: c, moved: true } : { part: null, moved: false };
}

/** The pinned moment's recorded value(s), to notice the other phone moving it. */
function recordedOf(pin: Pin, e: Entry, now: Date): string {
  if (pin.kind === "finish") return e.ended_at ?? "";
  if (pin.kind === "timer") return e.started_at;
  const { part } = locate(pin, e, now);
  if (!part) return "";
  return pin.kind === "break" ? part.end ?? "" : `${part.start}|${part.end ?? ""}`;
}

export default function FixTimesSheet({ open, onClose, kind, entry, preset }: SheetProps) {
  const { state, memberLabel } = useMaple();
  const count = useOpenCount(open);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const live = entry ? state?.entries.find((e) => e.id === entry.id) ?? null : null;
  const e = live ?? entry;
  if (!e) return null;
  const by = memberLabel(e.created_by);
  const subtitle = timed(e)
    ? `Nursing · feed started ${formatTime(e.started_at, tz)}${by ? ` · by ${by}` : ""}`
    : `${KIND_TITLE[kind as TimerKind] ?? "Timer"} · since ${formatTime(e.started_at, tz)}`;
  const fix = (preset?.fix ?? { target: "current" }) as FixPreset["fix"];
  return (
    <Sheet open={open} onClose={onClose} title="Fix times" subtitle={subtitle} calm>
      {/* A fresh pin each time it opens (the router keeps one instance per entry mounted). */}
      <FixBody key={count} start={e} live={live} target={fix.target} expand={fix.expand} open={open} onClose={onClose} tz={tz} />
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
}: {
  start: Entry;
  live: Entry | null;
  target: FixTarget;
  expand?: FixExpand;
  open: boolean;
  onClose: () => void;
  tz: string;
}) {
  const { now: nowFn, memberLabel, readOnly, dismissTimerToast } = useMaple();
  const actions = useTimerActions();
  const now = useNow(1000);
  const e = live ?? start;
  const [pin, setPin] = useState<Pin>(() => resolvePin(target, start, nowFn()));
  const [snap, setSnap] = useState<Snap>(() => ({ recorded: recordedOf(pin, start, nowFn()), current: currentKey(start, nowFn()) }));
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [finished, setFinished] = useState(expand === "finished");
  const [backOn, setBackOn] = useState(expand === "backOn");
  const [backSide, setBackSide] = useState<Side | null>(null);

  // Opening Fix times closes the timer toast (its chips would fix the same moment twice).
  useEffect(() => {
    if (open) dismissTimerToast();
  }, [open, dismissTimerToast]);

  const repin = (p: Pin) => {
    const n = nowFn();
    setPin(p);
    setSnap({ recorded: recordedOf(p, e, n), current: currentKey(e, n) });
    setEditor(null);
    setNotice(null);
    setFinished(false);
    setBackOn(false);
    setBackSide(null);
  };

  // ── what changed on the other phone ──
  const who = memberLabel(e.updated_by);
  const named = (withName: (w: string) => string, without: string) => (who ? withName(who) : without);
  const clock = (t: string | number | Date) => formatTime(t, tz);
  let banner: Banner | null = null;
  let moveRef: StretchRef | null = null;
  // (Not while this phone's own commit is in flight: its optimistic copy isn't someone else's change.)
  if (open && !busy) {
    if (!live) {
      banner = { kind: "discarded", text: named((w) => `${w} discarded this feed.`, `This feed was discarded ${ELSEWHERE}.`), action: { label: "Close", onClick: onClose } };
    } else if (pin.kind === "side" || pin.kind === "break") {
      const found = locate(pin, live, now);
      if (!found.part) {
        banner = {
          kind: "gone",
          text: named((w) => `Changed on ${w}'s phone. This part is gone.`, "Changed on another device. This part is gone."),
          action: { label: "Show current", onClick: () => repin(resolvePin("current", live, nowFn())) },
        };
      } else {
        if (found.moved && pin.kind === "side") moveRef = found.part.ref;
        const watchesCurrent = pin.kind === "break" || pin.panel === "open";
        const parts = partsOf(live, now);
        const last = parts.at(-1);
        if (watchesCurrent && currentKey(live, now) !== snap.current) {
          if (!live.active) {
            const t = clock(live.ended_at ?? now);
            banner = {
              kind: "current",
              text: named((w) => `${w} ended the feed at ${t}`, `The feed ended at ${t} ${ELSEWHERE}`),
              action: { label: "Show finished feed", onClick: () => repin({ kind: "finish" }) },
            };
          } else if (last?.kind === "break") {
            const t = clock(last.start);
            banner = {
              kind: "current",
              text: named((w) => `${w} paused at ${t}`, `Paused at ${t} ${ELSEWHERE}`),
              action: { label: "Show break", onClick: () => repin({ kind: "break", ref: last.before }) },
            };
          } else if (last?.kind === "side") {
            const t = clock(last.start);
            const s = SIDE_NAME[last.side];
            const resumed = last.startMoment === "resume";
            const sides = sidesOf(parts);
            banner = {
              kind: "current",
              text: resumed
                ? named((w) => `${w} resumed on ${s} at ${t}`, `Resumed on ${s} at ${t} ${ELSEWHERE}`)
                : named((w) => `${w} switched to ${s} at ${t}`, `Switched to ${s} at ${t} ${ELSEWHERE}`),
              action: { label: `Show ${s}`, onClick: () => repin({ kind: "side", ref: last.ref, index: sides.length - 1, panel: "open" }) },
            };
          }
        }
        if (!banner) {
          const rec = recordedOf(moveRef && pin.kind === "side" ? { ...pin, ref: moveRef } : pin, live, now);
          if (rec !== snap.recorded) {
            const [a, b] = rec.split("|");
            const [oa] = snap.recorded.split("|");
            const t = clock(pin.kind === "break" ? a : a !== oa ? a : b || a);
            banner = { kind: "moved", text: named((w) => `${w} just moved this to ${t}`, `This just moved to ${t} ${ELSEWHERE}`) };
          }
        }
      }
    } else if (pin.kind === "finish") {
      if (live.active) {
        banner = {
          kind: "current",
          text: named((w) => `${w} reopened this feed`, `This feed was reopened ${ELSEWHERE}`),
          action: { label: "Show current", onClick: () => repin(resolvePin("current", live, nowFn())) },
        };
      } else if ((live.ended_at ?? "") !== snap.recorded) {
        const t = clock(live.ended_at ?? now);
        banner = { kind: "moved", text: named((w) => `${w} just moved this to ${t}`, `This just moved to ${t} ${ELSEWHERE}`) };
      }
    } else if (!live.active) {
      const t = clock(live.ended_at ?? now);
      banner = { kind: "gone", text: named((w) => `${w} stopped this timer at ${t}.`, `This timer stopped at ${t} ${ELSEWHERE}.`), action: { label: "Close", onClick: onClose } };
    } else if (live.started_at !== snap.recorded) {
      const t = clock(live.started_at);
      banner = { kind: "moved", text: named((w) => `${w} just moved this to ${t}`, `This just moved to ${t} ${ELSEWHERE}`) };
    }
  }

  // A moved stretch keeps its pin under its new start, so the next chip names the stretch the server has.
  const moveKey = moveRef ? `${moveRef.side}|${moveRef.start}` : "";
  useEffect(() => {
    if (!moveKey || pin.kind !== "side") return;
    const [side, startIso] = moveKey.split("|");
    setPin({ ...pin, ref: { side: side as Side, start: startIso } });
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
  const disabled = !!busy || holding || fresh || dead || readOnly;

  /** Commit one change: server first; success closes the sheet (the toast says what changed). */
  const run = async (id: string, go: (o: TimerCallOptions) => Promise<unknown>) => {
    if (disabled) return;
    setBusy(id);
    setNotice(null);
    let failure = null as TimerFailure | null;
    const res = await go({
      onError: (f) => {
        failure = f;
      },
    });
    if (res && !failure) {
      onClose();
      return;
    }
    setBusy(null);
    const f = failure as TimerFailure | null;
    if (!f) return;
    if (f.kind === "changed") {
      const what = e.kind === "feed" ? "feed" : "timer";
      setNotice(f.who ? `${f.who} just changed this ${what}, so nothing was saved. Have another look.` : `This ${what} just changed ${ELSEWHERE}, so nothing was saved. Have another look.`);
      // The banner (from the entry the 409 sent back) says what changed; the controls wait a moment.
      hold();
    } else if (f.kind === "offline") {
      setNotice("You're offline, so nothing was saved. Try again when you're back online.");
    } else {
      setNotice(f.message);
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
    panel = (
      <MomentEditor
        entry={e}
        tz={tz}
        edge={editor.edge}
        free={editor.free}
        mode="commit"
        busy={busy === editor.id}
        disabled={disabled}
        who={who}
        onCancel={() => setEditor(null)}
        onSave={(to) => void run(editor.id, (o) => editor.commit(to, o))}
      />
    );
  } else if (pin.kind === "timer") {
    panel = <TimerPanel {...panelProps} finished={finished} setFinished={setFinished} actions={actions} />;
  } else if (pin.kind === "finish") {
    panel = <FinishPanel {...panelProps} actions={actions} />;
  } else if (pin.kind === "break") {
    panel = <BreakPanel {...panelProps} pinRef={pin.ref} backOn={backOn} setBackOn={setBackOn} backSide={backSide} setBackSide={setBackSide} actions={actions} />;
  } else if (pin.panel === "open") {
    panel = <OpenSidePanel {...panelProps} pin={pin} finished={finished} setFinished={setFinished} expandFinished={expand === "finished"} actions={actions} />;
  } else {
    panel = <ClosedSidePanel {...panelProps} pin={pin} actions={actions} />;
  }

  return (
    <>
      {banner && (
        <div role="status" className="flex min-h-[44px] items-center gap-3 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] leading-snug text-mp-ink-2">
          <span className="min-w-0 flex-1">{banner.text}</span>
          {banner.action && (
            <button type="button" onClick={banner.action.onClick} className="-my-1 min-h-[44px] shrink-0 rounded-lg px-2 text-[13px] font-semibold text-mp-accent-fg">
              {banner.action.label}
            </button>
          )}
        </div>
      )}
      {timed(e) && <PartPicker e={e} parts={parts} pin={pin} tz={tz} onPick={repin} disabled={!!busy} />}
      {notice && (
        <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
          {notice}
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
  run: (id: string, go: (o: TimerCallOptions) => Promise<unknown>) => Promise<void>;
  openEditor: (ed: Editor) => void;
};

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <p className="text-[20px] leading-snug font-semibold text-mp-ink">{children}</p>
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

/** A section the sheet opened expanded ("Still nursing?" → "Ended at…"): brought into view once. */
function Reveal({ on, children }: { on: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: "nearest" });
  }, [on]);
  return <div ref={ref}>{children}</div>;
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

/**
 * Stop chips for "She already finished" / "She's already awake": "{N} min
 * ago" over the time, the likely end first (tagged on the chip it lands on).
 */
function StopChips({
  sinceStart,
  mins,
  likely,
  ring,
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
  ring?: boolean;
  now: Date;
  tz: string;
  disabled: boolean;
  busy: string | null;
  onStop: (id: string, at: Date) => void;
}) {
  const n = now.getTime();
  const chips: { id: string; at: number; line1: string; likely: boolean }[] = [];
  let likelyTaken = false;
  for (const m of mins) {
    const at = n - m * MIN;
    if (at < sinceStart) continue;
    const isLikely = likely != null && !likelyTaken && Math.abs(at - likely) <= 30_000;
    if (isLikely) likelyTaken = true;
    chips.push({ id: `stop-${m}`, at, line1: `${m} min ago`, likely: isLikely });
  }
  if (likely != null && !likelyTaken && likely >= sinceStart) chips.push({ id: "stop-likely", at: likely, line1: "Likely", likely: true });
  chips.sort((a, b) => Number(b.likely) - Number(a.likely));
  if (!chips.length) return <Caption>Too soon for these; use Other time…</Caption>;
  return (
    <Grid>
      {chips.map((c) => (
        <TimeChip
          key={c.id}
          variant="stop"
          tall
          line1={c.line1}
          line2={`${formatTimeNear(c.at, c.at, tz)}${c.likely && c.line1 !== "Likely" ? " · likely" : ""}`}
          ring={ring && c.likely}
          ariaLabel={`Ended ${c.line1 === "Likely" ? "at the likely time" : c.line1}, at ${formatTime(c.at, tz)}`}
          disabled={disabled}
          busy={busy === c.id}
          onClick={() => onStop(c.id, new Date(c.at))}
        />
      ))}
    </Grid>
  );
}

/** Panel A: the side she's on now. The common fix: she was on it before the tap. */
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
  expandFinished,
  actions,
}: PanelProps & { pin: Extract<Pin, { kind: "side" }>; finished: boolean; setFinished: (v: boolean) => void; expandFinished: boolean; actions: Actions }) {
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
  const ctx = feedCtx(e, now);
  let uiMin = recorded - 6 * 3600_000;
  try {
    uiMin = edgeBounds(e.data, { edge: "start", ref: s.ref }, ctx).uiMin.getTime();
  } catch {
    // keep the 6-hour floor
  }
  const floor = brk && prev?.end ? Date.parse(prev.end) : null;
  const chips: { id: string; to: number; line1: string; aria: string }[] = [];
  for (const n of [1, 2, 3, 4, 5, 10, 15]) {
    const to = recorded - n * MIN;
    if (floor !== null ? to <= floor : to < uiMin) continue;
    chips.push({ id: `a-${n}`, to, line1: `${n} min earlier`, aria: `${name} started ${minutesWord(n)} earlier, at ${formatTime(to, tz)}` });
  }
  if (floor !== null && brk && brk.sec >= 60) chips.push({ id: "a-floor", to: floor, line1: "No break", aria: `No break: ${name} from ${formatTime(floor, tz)}, when she came off` });
  const shown = chips.slice(0, 8);
  const move = (id: string, to: number) => void run(id, (o) => actions.retime(e, { op: "move", edge: "start", ref: s.ref, to: new Date(to).toISOString() }, o));

  let caption: string;
  if (k === 0) caption = "The whole feed starts earlier.";
  else if (brk && prev) caption = `Comes out of the ${formatMinutes(brk.sec)} break. ${SIDE_NAME[prev.side]} stays ${formatMinutes(prev.sec)}.`;
  else caption = prev ? `Comes out of the ${SIDE_NAME[prev.side]} side (${formatMinutes(prev.sec)} now).` : "";

  // Undo the tap that started this part, while it's fresh.
  const segs = e.data.segments ?? [];
  const newest = Math.max(...segs.map((x) => Math.max(Date.parse(x.start), x.end ? Date.parse(x.end) : 0)), Date.parse(e.updated_at));
  const mistap = k > 0 && s.end === null && e.active && newest >= now.getTime() - 10 * MIN;
  const likely = recorded + 15 * MIN < now.getTime() - 2 * MIN ? recorded + 15 * MIN : null;
  const stillOn = e.active && s.end === null;

  return (
    <div className="space-y-4">
      <Title sub={`${name} shows since ${formatTime(s.start, tz)}.`}>{k === 0 ? `Was she on the ${name} before you tapped Start?` : `Was she on the ${name} before you tapped?`}</Title>
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
      ) : (
        prev && <Caption>{SIDE_NAME[prev.side]} was under a minute, so use Other time…</Caption>
      )}
      <div>
        <LinkRow
          disabled={disabled}
          onClick={() => openEditor({ id: "editor", edge: { edge: "start", ref: s.ref }, commit: (to, o) => actions.retime(e, { op: "move", edge: "start", ref: s.ref, to: to.toISOString() }, o) })}
        >
          Other time…
        </LinkRow>
        {pin.fromBreak && prev && (
          <LinkRow
            disabled={disabled}
            onClick={() => openEditor({ id: "editor", edge: { edge: "end", ref: prev.ref }, commit: (to, o) => actions.retime(e, { op: "move", edge: "end", ref: prev.ref, to: to.toISOString() }, o) })}
          >
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
            question={s.startMoment === "switch" ? "Tapped Switch by mistake?" : "Tapped Resume by mistake?"}
            label={s.startMoment === "switch" ? "Undo the switch" : "Back to paused"}
            disabled={disabled}
            busy={busy === "undo"}
            onClick={() => void run("undo", (o) => actions.undoTap(e, o))}
          />
        )}
      </div>
      {stillOn && (
        <div className="border-t border-mp-line pt-2">
          <LinkRow expanded={finished} onClick={() => setFinished(!finished)}>
            She already finished
          </LinkRow>
          {finished && (
            <Reveal on={expandFinished}>
            <div className="mt-2 space-y-2">
              <p className="text-[13px] font-medium text-mp-ink-2">Ended at…</p>
              <StopChips
                sinceStart={recorded + MIN}
                mins={[5, 10, 20, 30]}
                likely={likely}
                ring={expandFinished}
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
            </div>
            </Reveal>
          )}
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
  const edit = (edge: "start" | "end") =>
    openEditor({ id: "editor", edge: { edge, ref: s.ref }, commit: (to, o) => actions.retime(e, { op: "move", edge, ref: s.ref, to: to.toISOString() }, o) });
  return (
    <div className="space-y-3">
      <p className="text-[17px] leading-snug font-semibold text-mp-ink tabular-nums">
        {name} · {formatRange(s.start, s.end, tz)} · {formatMinutes(s.sec)}
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

/** Panel C: the open break. Back on already, came off earlier, or didn't mean to pause. */
function BreakPanel({
  e,
  tz,
  now,
  disabled,
  busy,
  run,
  openEditor,
  pinRef,
  backOn,
  setBackOn,
  backSide,
  setBackSide,
  actions,
}: PanelProps & {
  pinRef: StretchRef;
  backOn: boolean;
  setBackOn: (v: boolean) => void;
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

  const since: { id: string; at: number | null; line1: string; line2: string }[] = [{ id: "back-now", at: null, line1: "Now", line2: formatTimeNear(n, pauseAt, tz) }];
  for (const m of [2, 5, 10, 20]) {
    const at = n - m * MIN;
    if (at <= pauseAt) continue;
    since.push({ id: `back-${m}`, at, line1: `${m} min ago`, line2: formatTimeNear(at, pauseAt, tz) });
  }
  since.push({ id: "back-floor", at: pauseAt, line1: "Since the break began", line2: formatTimeNear(pauseAt, pauseAt, tz) });

  const earlier: { id: string; to: number; n: number }[] = [];
  for (const m of [1, 2, 3, 5]) {
    const to = pauseAt - m * MIN;
    if (to < Date.parse(last.start) + MIN) continue;
    earlier.push({ id: `off-${m}`, to, n: m });
  }

  return (
    <div className="space-y-4">
      <Title>
        On a break since {formatTime(last.end, tz)} ({formatMinutes(brk.sec)})
      </Title>
      <div>
        <LinkRow expanded={backOn} onClick={() => setBackOn(!backOn)}>
          Already back on?
        </LinkRow>
        {backOn && (
          <div className="mt-1 space-y-3">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Which side">
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
                      ariaLabel={`Back on the ${SIDE_NAME[backSide]} ${c.at === null ? "now" : c.id === "back-floor" ? "since the break began" : c.line1}, at ${formatTime(c.at ?? n, tz)}`}
                      disabled={disabled}
                      busy={busy === c.id}
                      onClick={() => void run(c.id, (o) => actions.resume(e, backSide, c.at === null ? undefined : new Date(c.at), o))}
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
                    })
                  }
                >
                  Other time…
                </LinkRow>
              </>
            )}
          </div>
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
        <LinkRow
          disabled={disabled}
          onClick={() => openEditor({ id: "editor", edge: { edge: "end", ref: last.ref }, commit: (to, o) => actions.retime(e, { op: "move", edge: "end", ref: last.ref, to: to.toISOString() }, o) })}
        >
          Other time…
        </LinkRow>
      </div>
      {brk.sec <= 10 * 60 && (
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
  const total = partTotals(parts).nursing;
  const chips = [5, 10, 15, 20, 30].map((m) => ({ id: `end-${m}`, m, to: recorded - m * MIN })).filter((c) => c.to >= uiMin);
  const commit = (to: Date, o: TimerCallOptions) => actions.retime(e, { op: "move", ...edge, to: to.toISOString() }, o);
  return (
    <div className="space-y-4">
      <Title>
        Ended {formatTime(e.ended_at, tz)} · nursed {formatDuration(total)}
      </Title>
      <div className="space-y-2">
        <p className="text-[15px] font-medium text-mp-ink">Ended earlier?</p>
        {chips.length > 0 && (
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
        )}
        <LinkRow disabled={disabled} onClick={() => openEditor({ id: "editor", edge, commit })}>
          Other time…
        </LinkRow>
      </div>
    </div>
  );
}

/** Sleep, tummy time and pumping: when it started, and (folded) when it already ended. */
function TimerPanel({ e, tz, now, disabled, busy, run, openEditor, finished, setFinished, actions }: PanelProps & { finished: boolean; setFinished: (v: boolean) => void; actions: Actions }) {
  const sleep = e.kind === "sleep";
  const start = Date.parse(e.started_at);
  const earlierMins = sleep ? [5, 10, 15, 20, 30, 45] : [1, 2, 3, 5, 10, 15];
  const endMins = sleep ? [5, 10, 15, 20, 30, 45] : [2, 5, 10, 15, 20];
  const what = KIND_TITLE[e.kind as TimerKind] ?? "Timer";
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
        <LinkRow expanded={finished} onClick={() => setFinished(!finished)}>
          {sleep ? "She's already awake" : "Already done"}
        </LinkRow>
        {finished && (
          <div className="mt-2 space-y-2">
            <p className="text-[13px] font-medium text-mp-ink-2">{sleep ? "Woke at…" : "Ended at…"}</p>
            <StopChips sinceStart={start + MIN} mins={endMins} now={now} tz={tz} disabled={disabled} busy={busy} onStop={(id, at) => void run(id, (o) => actions.stop(e, at, o))} />
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
          </div>
        )}
      </div>
    </div>
  );
}

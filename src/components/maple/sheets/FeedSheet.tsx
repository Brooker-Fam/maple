"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeEntry } from "@/lib/maple/describe";
import {
  addPart,
  edgeBounds,
  feedCtx,
  FeedEditError,
  feedEditCopy,
  feedMinutes,
  feedParts,
  feedTotals,
  isTracked,
  minutesText,
  moveEdge,
  other,
  partTotals,
  setSide,
  sideMinutesText,
  spanMinutes,
  type Part,
} from "@/lib/maple/feed";
import { BOTTLE_CUES, typicalBottle } from "@/lib/maple/guidelines";
import { formatRange, formatTime } from "@/lib/maple/time";
import { formatVolume, mlToOz, ozToMl } from "@/lib/maple/units";
import type { Entry, EntryOf, FeedData, Side, StretchSide, UpdateEntryInput } from "@/lib/maple/types";
import { BreakMark, LinkRow, MomentEditor, partAria, ROW_NAME, SIDE_NAME, SideFixRow, SideMark, type MomentEdge } from "../FeedParts";
import { logSwitches } from "../MoreSheet";
import { Icon } from "../icons";
import { Button, Chip, Segmented, Sheet, TimeRange, TimeScrubber, WhenField, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import type { SheetProps } from "./index";
import {
  CHECK_NUMBER_HINT,
  ContextNote,
  Label,
  LoggedBy,
  MiniStepper,
  MoreDetails,
  NoteField,
  RunningNote,
  SheetFooter,
  SideLabel,
  presetStart,
  pnum,
  pstr,
  useNumberChecks,
  useOpenCount,
  useSheetBase,
  useTouched,
} from "./parts";

/**
 * Log or edit a feed.
 *
 * Nursing logged afterwards (or a finished feed that was never timed): Left,
 * Right and Back and forth minutes (both sides, not tracked: never split into
 * made-up sides), which side she started on, and when it started and ended.
 * Typing the minutes for a new one slides the start back from the end, so
 * "15 left, 10 right, just finished" needs no time fiddling.
 *
 * A finished timed feed shows its times as what happened: a row per side and
 * break, "Ended", and "Add a side she nursed on". A row opens its moments
 * ("Switched to Right 4:15 PM"), and each moment opens an editor that stages
 * one move through the same engine as Fix times, so nothing else moves. The
 * rows show the staged times as they're nudged. The sheet's Save sends the
 * staged parts in one PATCH made against the version they were staged on; if
 * the other phone changed the times first, nothing is overwritten (and the
 * footer offers Start over). "Type minutes instead" keeps the old way: typed
 * minutes replace the timed parts.
 *
 * The note is sent only when it was changed here, and an untouched note box
 * follows the live entry, so a time fix never wipes the other phone's note.
 *
 * Bottle: the amount (oz or ml, per the units setting) starts at the last
 * bottle's amount and milk, so the primary button reads "Log 2 oz now". With
 * Bottles off (Family → On Today) a new feed has no Breast/Bottle choice;
 * a bottle already logged still opens as one.
 */

type Milk = NonNullable<FeedData["milk"]>;
const MILK_LABEL: Record<Milk, string> = { breastmilk: "Breast milk", formula: "Formula", mixed: "Mixed" };
const MIN = 60_000;
/** The engine's "same moment" slack: a break shorter than this is no break. */
const NEAR = 1500;
const ELSEWHERE = "on another device or through Claude";

/** No minutes typed on either side or going back and forth. */
const l0r0 = (left: number | null | undefined, right: number | null | undefined, both?: number | null) => (left ?? 0) + (right ?? 0) + (both ?? 0) === 0;

/** "Brittany discarded this feed, so nothing was saved." from a 404's deleted_by; null for any other error. */
function discardedText(err: unknown, what: string, label: (id: string | null | undefined) => string | null, lost: string): string | null {
  if (!(err instanceof ApiError) || err.status !== 404) return null;
  const b = err.body as { reason?: string; deleted_by?: string | null } | null;
  const done = what === "feed" ? "discarded" : "deleted";
  const who = b?.reason === "discarded" ? label(b.deleted_by) : null;
  return who ? `${who} ${done} this ${what}, so ${lost}.` : `This ${what} was ${done}, so ${lost}.`;
}
const ADD_BLOCKED = "Fix the side you're adding, or tap Don't add it.";

type FeedEntry = EntryOf<"feed">;
type SidePart = Extract<Part, { kind: "side" }>;
/** A staged change to a finished feed's times. */
type Staged = { data: FeedData; startedAt: string; endedAt: string | null };
/**
 * …and the version it was made on: its updated_at (Save expects it) and its
 * times (a newer version with the same times, say a note from the other
 * phone, isn't a clash).
 */
type Draft = Staged & { base: string; baseKey: string };

const isSide = (p: Part): p is SidePart => p.kind === "side";
const partsOf = (f: FeedEntry, now: Date) => feedParts(f.data, feedCtx(f, now));
const restOf = (f: FeedEntry): Staged => ({ data: f.data, startedAt: f.started_at, endedAt: f.ended_at });

/** A finished feed's parts and end as one string: does a staged change still differ from what's saved? */
function timesKey(data: FeedData, endedAt: string | null, now: Date): string {
  const parts = feedParts(data, { now, active: false, endedAt, pausedAtStop: data.paused_at_stop === true });
  const bits = parts.map((p) => `${p.kind === "side" ? p.side : "-"}${Date.parse(p.start)}~${p.end ? Date.parse(p.end) : ""}`);
  return [...bits, endedAt ? Date.parse(endedAt) : ""].join(",");
}

export default function FeedSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <FeedForm key={n} {...props} />;
}

function FeedForm({ open, onClose, entry, preset }: SheetProps) {
  const base = useSheetBase();
  const { tz, units, state, summary, log, update, remove, clock, now, ageDays, age, api, refresh, toast, memberLabel, readOnly } = base;
  const bottlesOn = logSwitches(state?.baby).bottles;
  const e = entry?.kind === "feed" ? entry : undefined;
  const running = !!e?.active;
  // A finished timed session: its times are its parts (the Times section), not a start and an end.
  const timed = !!e && !running && e.data.method === "breast" && !!e.data.segments?.length;

  const lastBottle = useMemo(
    () => state?.entries.find((x): x is EntryOf<"feed"> => x.kind === "feed" && x.data.method === "bottle" && x.id !== e?.id) ?? null,
    [state, e?.id]
  );

  // ── Shared ──
  const [method, setMethod] = useState<"breast" | "bottle">(() => {
    if (e) return e.data.method;
    return pstr(preset, "method") === "bottle" ? "bottle" : "breast";
  });
  // Read live by id: a change from the other phone shows here, and a staged change can't overwrite it.
  const liveEntry = e ? state?.entries.find((x) => x.id === e.id) : undefined;
  // Discarded on the other phone (or through Claude) while open: it was in the list and isn't now. An old feed
  // that was never in the list isn't "gone".
  const { whoDiscarded } = useMaple();
  const [seen, setSeen] = useState(false);
  if (liveEntry && !seen) setSeen(true);
  const gone = !!e && e.id > 0 && seen && !!state && !liveEntry;
  const [goneBy, setGoneBy] = useState<string | null | undefined>(undefined);
  const eId = e?.id;
  useEffect(() => {
    if (!gone || eId == null) return;
    let live = true;
    void whoDiscarded(eId).then((w) => live && setGoneBy(w));
    return () => {
      live = false;
    };
  }, [gone, eId, whoDiscarded]);
  // The note box and the saved note it was filled from (seed). An untouched box follows the live
  // entry, and only a note changed here is sent, so saving times can't wipe the other phone's note.
  const [noteBox, setNoteBox] = useState(() => ({ text: e?.note ?? pstr(preset, "note") ?? "", seed: e?.note ?? "" }));
  const note = noteBox.text;
  const setNote = (text: string) => setNoteBox((b) => ({ ...b, text }));
  const liveNote = liveEntry ? (liveEntry.note ?? "") : null;
  useEffect(() => {
    if (liveNote === null) return;
    setNoteBox((b) => (b.seed === liveNote || b.text !== b.seed ? b : { text: liveNote, seed: liveNote }));
  }, [liveNote]);
  const notePatch: { note?: string | null } = note.trim() !== noteBox.seed.trim() ? { note: note.trim() || null } : {};
  const [busy, setBusy] = useState(false);
  const fromPreset = presetStart(preset);
  const checks = useNumberChecks();
  const { touched, touch } = useTouched();

  // ── Nursing ──
  const totals = e && e.data.method === "breast" ? feedTotals(e.data, now()) : null;
  // Whole minutes as the rows count them (feedMinutes), so the steppers agree with the rows and the summary.
  const origMin = e && e.data.method === "breast" ? feedMinutes(e, now()) : null;
  const origL = origMin ? origMin.left : null;
  const origR = origMin ? origMin.right : null;
  const origB = origMin ? origMin.both : null;
  // The side she latched on: stored, or the first side tracked (a back-and-forth part never says it).
  const firstTracked = e?.data.segments?.find((x) => isTracked(x.side))?.side;
  const origFirst: Side | undefined = e?.data.first_side ?? (isTracked(firstTracked) ? firstTracked : undefined);
  const [left, setLeft] = useState<number | null>(origL ?? 0);
  const [right, setRight] = useState<number | null>(origR ?? 0);
  const [both, setBoth] = useState<number | null>(origB ?? 0);
  const [first, setFirst] = useState<Side>(() => {
    if (origFirst) return origFirst;
    const s = pstr(preset, "side") ?? pstr(preset, "first_side");
    if (s === "L" || s === "R") return s;
    return summary?.nextSide ?? "L";
  });
  const origRange = (): [Date, Date] => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : s];
    }
    const s = fromPreset ?? now();
    return [s, s];
  };
  const [range, setRange] = useState<[Date, Date]>(origRange);
  // New entries: minutes slide the start back from the end (or the end on from a preset start)
  // until someone moves a time by hand. A saved feed whose span is exactly its minutes keeps
  // its end in step with them.
  const [anchor, setAnchor] = useState<"end" | "start" | null>(() => {
    if (!e) return fromPreset ? "start" : "end";
    const span = e.ended_at ? Date.parse(e.ended_at) - Date.parse(e.started_at) : 0;
    return totals && Math.abs(span - totals.total * 1000) < MIN ? "start" : null;
  });
  // Typed minutes on a timed session replace its parts ("Type minutes instead").
  const [minutesTyped, setMinutesTyped] = useState(false);

  // ── Times (a finished timed session) ──
  const liveFeed = timed && e ? (liveEntry?.kind === "feed" ? liveEntry : e) : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped to start the Times section over (closes its rows and editors).
  const [epoch, setEpoch] = useState(0);
  const [timesNotice, setTimesNotice] = useState<string | null>(null);
  // An open "Add a side" whose times don't fit: Save waits, so what was typed is never dropped.
  const [addBlocked, setAddBlocked] = useState(false);
  // "Add a side" open with no side picked: Save with nothing else to save would close as if it added one.
  const [addPending, setAddPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const liveKey = liveFeed ? timesKey(liveFeed.data, liveFeed.ended_at, now()) : "";
  const dirty = !!liveFeed && !!draft && timesKey(draft.data, draft.endedAt, now()) !== liveKey;
  // The staged feed carries the version it was made on, so a change staged on top of it keeps that base.
  const working: FeedEntry | null =
    liveFeed && draft && dirty ? { ...liveFeed, data: draft.data, started_at: draft.startedAt, ended_at: draft.endedAt, updated_at: draft.base } : liveFeed;
  // Only the times clash: a newer version with the times the draft was made on (a note, say) saves on top of it.
  const conflict = dirty && !!liveFeed && !!draft && liveFeed.updated_at !== draft.base && liveKey !== draft.baseKey;
  const workingTotals = working ? partTotals(partsOf(working, now())) : null;

  const discardTimes = () => {
    setDraft(null);
    setAddBlocked(false);
    setEpoch((x) => x + 1);
  };
  const startOver = () => {
    discardTimes();
    setTimesNotice(null);
  };
  /** One staged change from the Times section; typed minutes give way to it (last one wins). */
  const stage = (next: Staged, builtOn: FeedEntry) => {
    // Built on the draft (it carries the draft's version): same version; else on a saved version, whose times are its own.
    const baseKey = draft && builtOn.updated_at === draft.base ? draft.baseKey : timesKey(builtOn.data, builtOn.ended_at, now());
    setDraft({ ...next, base: builtOn.updated_at, baseKey });
    setTimesNotice(null);
    if (minutesTyped || first !== origFirst) {
      setMinutesTyped(false);
      setLeft(origL ?? 0);
      setRight(origR ?? 0);
      setBoth(origB ?? 0);
      if (origFirst) setFirst(origFirst);
      setRange(origRange());
    }
  };

  // Until minutes are typed, they follow the parts (staged ones included).
  const shownL = timed && !minutesTyped && workingTotals ? workingTotals.min.left : left;
  const shownR = timed && !minutesTyped && workingTotals ? workingTotals.min.right : right;
  const shownB = timed && !minutesTyped && workingTotals ? workingTotals.min.both : both;
  const shownFirst = dirty && working?.data.first_side ? working.data.first_side : first;
  const typeMinutes = (l: number | null, r: number | null, b: number | null) => {
    setMinutesTyped(true);
    setMinutes(l, r, b);
    // Saving minutes replaces the parts, so a staged change to them goes.
    if (draft) discardTimes();
  };
  const pickFirst = (s: Side) => {
    setFirst(s);
    if (draft) discardTimes();
  };

  const setMinutes = (l: number | null, r: number | null, b: number | null) => {
    setLeft(l);
    setRight(r);
    setBoth(b);
    if (!anchor) return;
    const total = ((l ?? 0) + (r ?? 0) + (b ?? 0)) * MIN;
    const [s, en] = range;
    const limit = now().getTime();
    // The end can't pass now, so a feed that would run into the future starts earlier instead.
    if (anchor === "end") setRange([new Date(en.getTime() - total), en]);
    else if (s.getTime() + total > limit) setRange([new Date(limit - total), new Date(limit)]);
    else setRange([s, new Date(s.getTime() + total)]);
  };

  // Closing with a staged change asks first. Stable, because Sheet re-runs its open effect (and refocuses) when onClose changes.
  const guarded = useRef(false);
  useEffect(() => {
    guarded.current = (dirty || addBlocked) && !readOnly;
  });
  const close = useCallback(() => (guarded.current ? setConfirming(true) : onClose()), [onClose]);

  // ── Bottle ──
  const toDisplay = (ml: number) => (units === "metric" ? Math.round(ml / 5) * 5 : Math.round(mlToOz(ml) * 4) / 4);
  const [amount, setAmount] = useState<number | null>(() => {
    const ml = e?.data.method === "bottle" ? e.data.amount_ml : (pnum(preset, "amount_ml") ?? lastBottle?.data.amount_ml);
    return ml != null ? toDisplay(ml) : null;
  });
  const [milk, setMilk] = useState<Milk | undefined>(() =>
    e?.data.method === "bottle" ? e.data.milk : ((pstr(preset, "milk") as Milk | undefined) ?? lastBottle?.data.milk)
  );
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : fromPreset));
  const amountMl = amount == null ? undefined : Math.round((units === "metric" ? amount : ozToMl(amount)) * 10) / 10;
  const amountLabel = amountMl != null ? formatVolume(amountMl, units) : null;
  const chips = units === "metric" ? [30, 60, 90, 120] : [1, 2, 3, 4];

  // ── Save ──
  const save = async () => {
    if (e) {
      const patch = editPatch();
      // Nothing changed: close without a write (a bare write would bump the version under the other phone's edit).
      if (Object.values(patch).every((v) => v === undefined)) return onClose();
      setBusy(true);
      const prev = liveEntry?.kind === "feed" ? liveEntry : e;
      const res = await update(e.id, patch, { toast: "" });
      setBusy(false);
      if (res) {
        savedToast(`${method === "bottle" ? "Bottle" : "Feed"} updated`, prev, patch, res);
        onClose();
      }
      return;
    }
    onClose();
    if (method === "bottle") {
      const at = when ?? now();
      void log(
        { kind: "feed", started_at: when?.toISOString(), data: { method: "bottle", amount_ml: amountMl, milk }, note: note.trim() || null },
        { toast: `${amountLabel ? `${amountLabel} bottle` : "Bottle"} · ${clock(at)}` }
      );
      return;
    }
    const [s, en] = range;
    // No minutes typed but a start and an end ("15m ago" to now, after a hold on Left): that span is her first side's,
    // so it never saves as a feed of nothing.
    const spanMin = l0r0(left, right, both) ? spanMinutes(s, en) : 0;
    const l = (left ?? 0) + (spanMin && first !== "R" ? spanMin : 0);
    const r = (right ?? 0) + (spanMin && first === "R" ? spanMin : 0);
    const b = both ?? 0;
    const sides = sideFields(l, r, first, b);
    // After back and forth: "Left next, or the fuller side" (AAP; guidelines.ts NEXT_SIDE_NOTE).
    const nextSide = SIDE_NAME[other(sides.first_side)];
    const next = b > 0 ? `${nextSide} next, or the fuller side` : `${nextSide} next`;
    const each = sideMinutesText({ left: l, right: r, both: b, total: l + r + b, has: { L: l > 0, R: r > 0, B: b > 0 } });
    void log(
      {
        kind: "feed",
        started_at: s.toISOString(),
        ended_at: en.getTime() > s.getTime() ? en.toISOString() : undefined,
        data: { method: "breast", left_sec: l * 60, right_sec: r * 60, ...(b > 0 ? { both_sec: b * 60 } : {}), ...sides },
        note: note.trim() || null,
      },
      { toast: l + r + b > 0 ? `Nursed ${l + r + b}m (${each}) · ${next}` : `Nursed · ${clock(s)} · ${next}` }
    );
  };

  const editPatch = (): UpdateEntryInput => {
    if (!e) return {};
    if (running) return { ...notePatch };
    if (method === "bottle") {
      // Only what was changed: the amount shows rounded (¼ oz / 5 ml), so re-sending it would drift.
      const data: Record<string, unknown> = {};
      if (touched.amount) data.amount_ml = amountMl ?? null;
      if (touched.milk) data.milk = milk ?? null;
      return {
        data: Object.keys(data).length ? data : undefined,
        started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
        ...notePatch,
      };
    }
    const [s, en] = range;
    const startMoved = s.getTime() !== Date.parse(e.started_at);
    const endMoved = en.getTime() !== (e.ended_at ? Date.parse(e.ended_at) : s.getTime());
    // Typed minutes win whenever a time moved too (else the server would retime the segments instead).
    const minutesChanged = left !== origL || right !== origR || both !== origB || (timed && minutesTyped && (startMoved || endMoved));
    const data: Record<string, unknown> = {};
    if (minutesChanged) {
      // New side minutes replace the timer's segments (the server drops them); back and forth goes as its own minutes.
      Object.assign(data, {
        left_sec: (left ?? 0) * 60,
        right_sec: (right ?? 0) * 60,
        ...((both ?? 0) > 0 || (origB ?? 0) > 0 || !!e.data.both_sec ? { both_sec: (both ?? 0) * 60 } : {}),
        ...sideFields(left ?? 0, right ?? 0, first, both ?? 0),
      });
    } else if (first !== origFirst) {
      data.first_side = first;
    }
    return {
      started_at: startMoved ? s.toISOString() : undefined,
      // Keep the end where it shows (otherwise new minutes would move it).
      // A timed session keeps an end even at its start, so the server retimes what the sheet previewed.
      ended_at: endMoved || minutesChanged ? (en.getTime() > s.getTime() || (timed && !minutesChanged) ? en.toISOString() : null) : undefined,
      data: Object.keys(data).length ? data : undefined,
      ...notePatch,
    };
  };

  /**
   * "Feed updated · Undo": the Undo puts back what the save changed (times and parts, data it sent, the note), as
   * `prev` had them, in one PATCH against the version the save wrote, so it can't overwrite a change made since on
   * the other phone (that answers 409, and the toast says so). A save still waiting offline gets no Undo.
   */
  const savedToast = (text: string, prev: FeedEntry, sent: UpdateEntryInput, saved: Entry) => {
    if (saved.id < 0) return void toast(text);
    const what = prev.data.method === "bottle" ? "bottle" : "feed";
    const back: UpdateEntryInput = { expect_updated_at: saved.updated_at };
    if (sent.note !== undefined) back.note = prev.note;
    if (sent.started_at !== undefined || sent.ended_at !== undefined || sent.data) {
      back.started_at = prev.started_at;
      back.ended_at = prev.ended_at;
      const was = prev.data as Record<string, unknown>;
      const data: Record<string, unknown> = Object.fromEntries(Object.keys(sent.data ?? {}).map((k) => [k, was[k] ?? null]));
      // A timed feed gets its parts back as they were (typed minutes dropped them; a moved start or end retimed them).
      if (prev.data.method === "breast" && prev.data.segments?.length && !prev.active) {
        data.segments = prev.data.segments;
        data.paused_at_stop = prev.data.paused_at_stop ? true : null;
      }
      if (Object.keys(data).length) back.data = data;
    }
    const undo = async () => {
      try {
        await api(`entries?id=${prev.id}`, { method: "PATCH", body: JSON.stringify(back) });
        await refresh();
        toast("Undone");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          const who = memberLabel((err.body as { entry?: Entry } | null)?.entry?.updated_by);
          toast(who ? `${who} changed this ${what} again, so it wasn't put back.` : `This ${what} changed again ${ELSEWHERE}, so it wasn't put back.`, { tone: "info" });
          void refresh();
        } else if (err instanceof ApiError) {
          const gone = discardedText(err, what, memberLabel, "nothing was put back");
          toast(gone ?? err.message, { tone: gone ? "info" : "error" });
        } else {
          toast("You're offline, so it wasn't put back. Try again when you're back online.", { tone: "error" });
        }
      }
    };
    // Closes once someone else changes it (when it's an entry the app is watching: an old one isn't in state).
    const watched = state?.entries.some((x) => x.id === saved.id);
    toast(text, { undo: () => void undo(), ...(watched ? { watch: { entryId: saved.id, updatedAt: saved.updated_at } } : {}) });
  };

  /** The staged parts, in one PATCH against the version they were staged on (a newer one answers 409). */
  const saveTimes = async () => {
    if (!e || !draft || !liveFeed) return;
    setBusy(true);
    setTimesNotice(null);
    const data: Record<string, unknown> = { segments: draft.data.segments };
    // PATCH merges data: a flag the engine dropped (the end moved off the pause, a side added after it) has to be cleared by name.
    if (liveFeed.data.paused_at_stop && !draft.data.paused_at_stop) data.paused_at_stop = null;
    // A newer version with the same times (not a conflict) is the one this saves on top of.
    const expect = liveKey === draft.baseKey ? liveFeed.updated_at : draft.base;
    const patch: UpdateEntryInput = { data, started_at: draft.startedAt, ended_at: draft.endedAt, expect_updated_at: expect, ...notePatch };
    try {
      const res = await api<{ entry: Entry }>(`entries?id=${e.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      // Into state before the sheet goes, so Recent and the timeline show the new times at once.
      await refresh();
      savedToast("Feed updated", liveFeed, patch, res.entry);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const who = memberLabel((err.body as { entry?: Entry } | null)?.entry?.updated_by);
        discardTimes();
        setTimesNotice(who ? `${who} changed this feed; your change wasn't saved. Make it again.` : `This feed changed ${ELSEWHERE}; your change wasn't saved. Make it again.`);
        // Make it again on the times the server has now.
        await refresh();
      } else if (err instanceof ApiError) {
        setTimesNotice(discardedText(err, "feed", memberLabel, "nothing was saved") ?? err.message);
      } else {
        setTimesNotice("You're offline, so nothing was saved. Try again when you're back online.");
      }
    } finally {
      setBusy(false);
    }
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: `${describeEntry(e).title} deleted` });
  };

  // No minutes on either side and no times that give any: it would still count as a feed, move "Last fed" and flip
  // the next side (a hold on a side, then Log it). Typed 0 and 0 on a timed feed would replace its parts with nothing.
  const noMinutes = l0r0(left, right, both);
  const empty = method === "breast" && !running && !gone && (timed ? minutesTyped && noMinutes : noMinutes && spanMinutes(range[0], range[1]) === 0);

  const addOnly = addPending && !dirty && !("note" in notePatch);
  const title = e ? (running ? "Nursing now" : describeEntry(e).title) : "Feed";
  const primary = e ? "Save" : method === "bottle" ? (amountLabel ? `Log ${amountLabel}${when ? "" : " now"}` : "Log bottle") : "Log it";
  const changedBy = liveFeed ? memberLabel(liveFeed.updated_by) : null;

  // Left and Right abreast; back and forth (both sides, not split into made-up sides) under them, with what it means.
  const steppers = (
    <div className="grid grid-cols-2 gap-3">
      <MiniStepper key="left" label={<SideLabel side="L" />} unit="min" ariaLabel="minutes on the left" value={shownL} onChange={(v) => typeMinutes(v, shownR, shownB)} max={240} onInvalid={checks.watch("left")} />
      <MiniStepper key="right" label={<SideLabel side="R" />} unit="min" ariaLabel="minutes on the right" value={shownR} onChange={(v) => typeMinutes(shownL, v, shownB)} max={240} onInvalid={checks.watch("right")} />
      <MiniStepper
        key="both"
        label={<SideLabel side="B" />}
        unit="min"
        ariaLabel="minutes going back and forth"
        value={shownB}
        onChange={(v) => typeMinutes(shownL, shownR, v)}
        max={720}
        onInvalid={checks.watch("both")}
      />
      <p className={cx(tone.muted, "self-end pb-1 text-[13px] leading-snug")}>Both sides, without tracking which.</p>
    </div>
  );
  const startedOn = (
    <div className="flex items-center justify-between gap-4">
      <Label className="mb-0">Started on</Label>
      <Segmented<Side>
        value={shownFirst}
        onChange={pickFirst}
        options={[
          { value: "L", label: "Left" },
          { value: "R", label: "Right" },
        ]}
        className="w-[11.5rem] shrink-0"
      />
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={close}
      title={title}
      footer={
        confirming ? (
          <DiscardConfirm
            onKeep={() => setConfirming(false)}
            onDiscard={() => {
              setConfirming(false);
              onClose();
            }}
          />
        ) : (
          <>
            {dirty && !readOnly && (
              <p role="status" className="mb-3 flex items-center gap-2 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] leading-snug font-medium text-mp-ink">
                <Icon name={conflict ? "info" : "pencil"} size={14} className="shrink-0 text-mp-ink-2" />
                {conflict
                  ? `${changedBy ? `Changed on ${changedBy}'s phone` : `Changed ${ELSEWHERE}`} while you were editing. Start over to make your change on the new times.`
                  : "Unsaved change to the times"}
              </p>
            )}
            {/* In a clash, the button under the thumb is the way out: Start over, not a disabled Save. */}
            <SheetFooter
              onClose={close}
              onDelete={e ? del : undefined}
              onPrimary={() => void (conflict ? startOver() : dirty ? saveTimes() : save())}
              label={conflict ? "Start over" : primary}
              busy={busy}
              disabled={gone || (!!e && e.id < 0) || (!running && checks.invalid) || (!conflict && addBlocked) || empty || addOnly}
              hint={
                gone
                  ? "Nothing to save: it's gone."
                  : !running && checks.invalid
                  ? CHECK_NUMBER_HINT
                  : empty
                    ? "Add how long she nursed."
                    : addOnly
                    ? "Pick Left or Right to add a side."
                    : conflict
                    ? undefined
                    : addBlocked
                      ? ADD_BLOCKED
                      : e && e.id < 0
                        ? "Still syncing, so it can't be edited yet."
                        : undefined
              }
            />
          </>
        )
      }
    >
      {/* A timed feed's own times are its rows: the tap time up here would read as one more start. */}
      {e && <LoggedBy entry={e} noTime={e.data.method === "breast" && !!e.data.segments?.length} />}

      {gone && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] leading-snug font-medium text-mp-ink">
          <Icon name="info" size={14} className="shrink-0 text-mp-ink-2" />
          {goneBy ? `${goneBy} discarded this feed.` : `This feed was discarded ${ELSEWHERE}.`} Restore it from Recently removed in the Log.
        </p>
      )}

      {gone ? null : running ? (
        <RunningNote kind="feed" />
      ) : (
        <>
          {/* Bottles off (Family → On Today): a new feed is nursing, no choice to make. */}
          {!e && (bottlesOn || method === "bottle") && (
            <Segmented
              value={method}
              onChange={setMethod}
              options={[
                { value: "breast", label: "Breast" },
                { value: "bottle", label: "Bottle" },
              ]}
              className="[&>button]:min-h-[48px] [&>button]:text-[15px]"
            />
          )}

          {method === "breast" ? (
            liveFeed && working ? (
              // Reopened on the other phone: it's a running timer again, and the dock runs it.
              liveFeed.active ? (
                <RunningNote kind="feed" entry={liveFeed} />
              ) : (
                <>
                  {/* A clash is told (with Start over) in the footer, by the thumb, not up here. */}
                  {timesNotice && (
                    <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
                      {timesNotice}
                    </p>
                  )}
                  <TimesSection
                    key={epoch}
                    live={liveFeed}
                    working={working}
                    dirty={dirty}
                    tz={tz}
                    readOnly={readOnly}
                    disabled={busy}
                    who={changedBy}
                    onStage={stage}
                    onAddBlocked={setAddBlocked}
                    onAddPending={setAddPending}
                  />
                  {!readOnly && (
                    <MoreDetails label="Type minutes instead" summary={minutesTyped ? `L ${left ?? 0} · R ${right ?? 0}${(both ?? 0) > 0 ? ` · both ${both}` : ""} min` : undefined}>
                      <p className={cx(tone.muted, "text-[13px] leading-snug")}>Saving minutes replaces the timed parts.</p>
                      {steppers}
                      {startedOn}
                    </MoreDetails>
                  )}
                </>
              )
            ) : (
              <>
                {steppers}
                {startedOn}
                <TimeRange
                  start={range[0]}
                  end={range[1]}
                  tz={tz}
                  durations={[]}
                  onChange={(s, en) => {
                    setAnchor(null);
                    setRange([s, en]);
                  }}
                />
              </>
            )
          ) : (
            <>
              <div>
                <MiniStepper
                  key="amount"
                  label="Amount"
                  unit={units === "metric" ? "ml" : "oz"}
                  ariaLabel={units === "metric" ? "millilitres" : "ounces"}
                  value={amount}
                  onChange={(v) => {
                    touch("amount");
                    setAmount(v);
                  }}
                  onInvalid={checks.watch("amount")}
                  step={units === "metric" ? 5 : 0.5}
                  decimals={units === "metric" ? 0 : 2}
                  max={units === "metric" ? 500 : 16}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {chips.map((c) => (
                    <Chip
                      key={c}
                      selected={amount === c}
                      onClick={() => {
                        touch("amount");
                        setAmount(c);
                      }}
                    >
                      {c} {units === "metric" ? "ml" : "oz"}
                    </Chip>
                  ))}
                </div>
                {lastBottle?.data.amount_ml != null && !e && (
                  <p className={cx(tone.muted, "mt-1.5 text-xs")}>
                    Last bottle: {formatVolume(lastBottle.data.amount_ml, units)}
                    {lastBottle.data.milk ? ` of ${MILK_LABEL[lastBottle.data.milk].toLowerCase()}` : ""} at {clock(lastBottle.started_at)}
                  </p>
                )}
              </div>
              <WhenField value={when} onChange={setWhen} tz={tz} />
              <MoreDetails summary={milk ? MILK_LABEL[milk] : undefined}>
                <div>
                  <Label>Milk</Label>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(MILK_LABEL) as Milk[]).map((m) => (
                      <Chip
                        key={m}
                        selected={milk === m}
                        onClick={() => {
                          touch("milk");
                          setMilk(milk === m ? undefined : m);
                        }}
                      >
                        {MILK_LABEL[m]}
                      </Chip>
                    ))}
                  </div>
                </div>
              </MoreDetails>
              <ContextNote>
                {age ? <>Typical at her age: {typicalBottle(ageDays)}. </> : null}
                {BOTTLE_CUES}
              </ContextNote>
            </>
          )}
        </>
      )}

      <NoteField value={note} onChange={setNote} />
    </Sheet>
  );
}

/**
 * first/last side from the minutes: one side used → that side; both → the chosen start, then the other. With back
 * and forth (b), she started on the chosen side whatever else was typed (it's what the next side alternates from).
 */
function sideFields(l: number, r: number, chosen: Side, b = 0): { first_side: Side; last_side?: Side } {
  if (b > 0) return { first_side: chosen, last_side: l > 0 && r > 0 ? other(chosen) : l > 0 ? "L" : r > 0 ? "R" : chosen };
  if (l > 0 && r > 0) return { first_side: chosen, last_side: other(chosen) };
  if (l > 0) return { first_side: "L", last_side: "L" };
  if (r > 0) return { first_side: "R", last_side: "R" };
  return { first_side: chosen };
}

// ── Times: a finished timed feed, part by part ──────────────────────────

/** Which row is open: a part (by its place, and side), the Ended row, or Add a side (its form, and the feed it adds to). */
type Row = { kind: "side"; index: number; side: StretchSide } | { kind: "break"; index: number } | { kind: "ended" } | { kind: "add"; base: FeedEntry; form: AddForm };
/** The open moment editor: its line, the moment, and the feed as it was when it opened (`to`: the staged time). */
type StagedEditor = { id: string; edge: MomentEdge; base: FeedEntry; to?: Date };

/** The open part row in `parts`: where it was, or (after a merge or a new part) the nearest of the same kind and side. */
function rowIndex(row: Row | null, parts: Part[]): number | null {
  if (!row || (row.kind !== "side" && row.kind !== "break")) return null;
  const fits = (p: Part | undefined) => !!p && p.kind === row.kind && (row.kind !== "side" || (p.kind === "side" && p.side === row.side));
  if (fits(parts[row.index])) return row.index;
  let best: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (fits(parts[i]) && (best === null || Math.abs(i - row.index) < Math.abs(best - row.index))) best = i;
  }
  return best;
}

/** "30 min nursing · Left 15 · Right 15 · started on Left · 11 min break not counted" ("· back and forth 38" too). */
function summaryOf(parts: Part[], firstSide?: Side): string {
  // The rows' whole minutes added up, so Left + Right + back and forth is the nursing total and each matches its rows.
  const t = partTotals(parts);
  const sides = parts.filter(isSide);
  const has = (s: StretchSide) => sides.some((p) => p.side === s);
  const bits = [`${minutesText(t.min.nursing)} nursing`];
  if (has("L")) bits.push(`Left ${t.min.left || "<1"}`);
  if (has("R")) bits.push(`Right ${t.min.right || "<1"}`);
  if (has("B")) bits.push(`back and forth ${t.min.both >= 60 ? minutesText(t.min.both) : t.min.both || "<1"}`);
  // The side she latched on (a feed that went back and forth at once still has one).
  const started = sides[0] && isTracked(sides[0].side) ? sides[0].side : firstSide;
  if (started) bits.push(`started on ${SIDE_NAME[started]}`);
  if (t.breakCount) bits.push(`${minutesText(t.min.breaks)} ${t.breakCount > 1 ? "of breaks" : "break"} not counted`);
  return bits.join(" · ");
}

/** A part as one string: a row whose part isn't in the saved feed is a staged change. */
const partKey = (p: Part) => `${p.kind === "side" ? p.side : "-"}${Date.parse(p.start)}~${p.end ? Date.parse(p.end) : ""}`;
/** A break the staged change closes (its row stays while the editor is open). */
const isClosed = (p: Part) => p.kind === "break" && p.end !== null && Date.parse(p.end) - Date.parse(p.start) < NEAR;
/** A row's React key from the feed the rows are drawn on: steady while an editor nudges that feed's times. */
const rowKey = (p: Part) => (p.kind === "side" ? `s-${p.ref.start}` : `b-${p.before.start}`);

/**
 * The rows while an editor is open: the staged parts, on the rows of the
 * feed the editor opened on. Usually the change keeps every part, so that's
 * the staged parts themselves. When it closes a break (and maybe joins two
 * stretches of a side), the moved moment (`from` → `to`) moves on the old
 * rows instead, so no row vanishes from under the editor and the closed
 * break can say "No break".
 */
function previewParts(rows: Part[], staged: Part[], from: number | null, to: Date | undefined): Part[] {
  const same = rows.length === staged.length && rows.every((p, i) => p.kind === staged[i].kind && (p.kind !== "side" || (staged[i] as SidePart).side === p.side));
  if (same) return staged;
  if (from === null || !to) return rows;
  const at = (t: string) => (Date.parse(t) === from ? to.toISOString() : t);
  return rows.map((p): Part => {
    const start = at(p.start);
    const end = p.end === null ? null : at(p.end);
    if (end === null) return { ...p, start };
    return { ...p, start, end, sec: Math.max(0, (Date.parse(end) - Date.parse(start)) / 1000), min: spanMinutes(start, end) };
  });
}

/**
 * The Times section of a finished timed feed: every part as a row (no
 * folding), then "Ended 4:30 PM" and "Add a side she nursed on". A side row
 * opens its two moments and "Wrong side?"; a break row opens "Came off" and
 * "Back on"; Ended opens its editor directly. One editor is open at a time,
 * and each nudge stages the moved feed at once (onStage). Nothing here saves.
 *
 * The rows always show the staged times, and a row that differs from the
 * saved feed is marked. While an editor is open they stay the rows of the
 * feed as it was when it opened (previewParts), so a break the edit closes
 * can't pull the row, and the editor, out from under the thumb.
 *
 * Add a side has no button of its own: a side that fits is staged as it's
 * set, so the footer's Save saves what the form shows. One whose times don't
 * fit holds Save (onAddBlocked) until it's fixed or dropped.
 */
function TimesSection({
  live,
  working,
  dirty,
  tz,
  readOnly,
  disabled,
  who,
  onStage,
  onAddBlocked,
  onAddPending,
}: {
  /** The feed as the server has it now. */
  live: FeedEntry;
  /** The feed with the staged change (live when there's none). */
  working: FeedEntry;
  dirty: boolean;
  tz: string;
  readOnly: boolean;
  /** Saving: everything waits. */
  disabled: boolean;
  /** Who last changed it, for the editor's "{Who} just changed this" (null: unnamed). */
  who: string | null;
  onStage: (next: Staged, builtOn: FeedEntry) => void;
  /** An open Add a side whose times don't fit (Save waits), or not. */
  onAddBlocked: (blocked: boolean) => void;
  /** The add form is open and nothing is picked in it yet. */
  onAddPending: (pending: boolean) => void;
}) {
  const { now: nowFn } = useMaple();
  const [row, setRow] = useState<Row | null>(null);
  const [editor, setEditor] = useState<StagedEditor | null>(null);
  const [error, setError] = useState<string | null>(null);

  // With nothing staged, a change from the other phone replaces the editor's feed (and the editor says who moved it),
  // and the feed a side is being added to.
  const fresh = !!editor && !dirty && editor.base.updated_at !== live.updated_at;
  const add = row?.kind === "add" ? { form: row.form, base: !dirty && row.base.updated_at !== live.updated_at ? live : row.base } : null;
  const base = editor && !fresh ? editor.base : add ? add.base : working;
  const now = nowFn();
  const staged = partsOf(working, now);
  const parts = base === working ? staged : partsOf(base, now);
  let shown = parts;
  if (editor && !fresh && base !== working) {
    let from: number | null = null;
    try {
      from = edgeBounds(base.data, editor.edge, feedCtx(base, now)).recorded.getTime();
    } catch {
      // The moment's gone from that feed: the rows show it as it was.
    }
    shown = previewParts(parts, staged, from, editor.to);
  }
  const saved = new Set(partsOf(live, now).map(partKey));
  const openIndex = rowIndex(row, parts);
  const clock = (t: string) => formatTime(t, tz);

  const collapse = () => {
    setEditor(null);
    setError(null);
  };
  const openRow = (next: Row | null) => {
    if (add && next?.kind !== "add") {
      // Leaving Add a side: a side she set that fits stays staged (and shows as a row); times that don't fit go. The untouched guess staged nothing.
      if (add.form.touched && !tryAdd(add.base, add.form, nowFn(), tz).result) onStage(restOf(add.base), add.base);
      onAddBlocked(false);
      onAddPending(false);
    }
    setRow(next);
  };
  // Taps act on the staged feed, which the rows draw on the editor's feed while one is open:
  // find the open row there (a moved switch has a new start, so the shown part's ref won't do).
  const openInStaged = (): { p: Part; i: number } | null => {
    const i = rowIndex(row, staged);
    return i === null ? null : { p: staged[i], i };
  };
  const rowOf = (p: Part, i: number): Row => (p.kind === "side" ? { kind: "side", index: i, side: p.side } : { kind: "break", index: i });
  const edgeOf = (id: string, p: Part): MomentEdge | null => {
    if (p.kind === "side") return id === "start" ? { edge: "start", ref: p.ref } : id === "end" && p.end ? { edge: "end", ref: p.ref } : null;
    if (id === "off") return { edge: "end", ref: p.before };
    if (id === "on") return p.after ? { edge: "start", ref: p.after } : null;
    return id === "legacy-end" ? { edge: "ended" } : null;
  };
  const toggleEditor = (id: string) => {
    setError(null);
    if (editor?.id === id) return setEditor(null);
    const found = openInStaged();
    const edge = found && edgeOf(id, found.p);
    // The part went in the last change (a break closed): the rows show that once the editor's gone.
    if (!found || !edge) return setEditor(null);
    openRow(rowOf(found.p, found.i));
    setEditor({ id, edge, base: working });
  };
  const nudge = (to: Date) => {
    if (!editor) return;
    try {
      const moved = moveEdge(base.data, { ...editor.edge, to }, feedCtx(base, nowFn()));
      onStage({ data: moved.data, startedAt: moved.startedAt, endedAt: moved.endedAt }, base);
      setEditor({ ...editor, base, to });
    } catch {
      // Past a limit: the scrubber stops at the engine's bounds, and the editor's preview says why.
    }
  };
  /** "Wrong side?": the part is the other side, or both sides; one going back and forth is one side after all. */
  const flip = (side: StretchSide) => {
    const found = openInStaged();
    collapse();
    if (!found || found.p.kind !== "side") return;
    try {
      const r = setSide(working.data, found.p.ref, side, feedCtx(working, nowFn()));
      onStage({ data: r.data, startedAt: r.startedAt, endedAt: working.ended_at }, working);
      openRow({ kind: "side", index: found.i, side });
    } catch (err) {
      setError(err instanceof FeedEditError ? feedEditCopy(err, "ui", tz) : "That part changed; have another look.");
    }
  };
  const pickRow = (p: Part, i: number) => {
    collapse();
    openRow(openIndex === i ? null : rowOf(p, i));
  };
  const pickEnded = () => {
    if (row?.kind === "ended") {
      collapse();
      openRow(null);
      return;
    }
    const lastStaged = staged.filter(isSide).at(-1);
    if (!lastStaged) return;
    setError(null);
    openRow({ kind: "ended" });
    // A legacy trailing break: Ended moves ended_at alone (the last side's end is then the pause).
    const legacy = staged.some((p) => p.kind === "break" && p.legacy);
    setEditor({ id: "ended-row", edge: legacy ? { edge: "ended" } : { edge: "end", ref: lastStaged.ref }, base: working });
  };

  // ── Add a side ──
  /**
   * The form as set: once she's touched it, what it shows is what Save saves (a side that fits is staged now; one
   * that doesn't holds Save). Untouched, it's a guess: nothing is staged, so a peek and Save (for a note) adds nothing.
   */
  const putAdd = (on: FeedEntry, form: AddForm) => {
    onAddPending(!form.touched);
    if (form.touched) {
      const r = tryAdd(on, form, nowFn(), tz);
      onStage(r.result ?? restOf(on), on);
      onAddBlocked(!r.result);
    }
    setRow({ kind: "add", base: on, form });
  };
  const toggleAdd = () => {
    collapse();
    if (add) return openRow(null);
    putAdd(working, addDefaults(working, nowFn()));
  };
  const dropAdd = () => {
    if (!add) return;
    if (add.form.touched) onStage(restOf(add.base), add.base);
    onAddBlocked(false);
    onAddPending(false);
    setRow(null);
  };

  const editorFor = (id: string) =>
    editor?.id === id && (
      <InView again={dirty}>
        <div className="pt-1 pb-3">
          <MomentEditor entry={base} tz={tz} edge={editor.edge} mode="staged" draft={fresh ? undefined : editor.to} onDraft={nudge} disabled={disabled} who={who} />
        </div>
      </InView>
    );
  const line = (id: string, label: string) => (
    <div key={id}>
      <LinkRow expanded={editor?.id === id} disabled={disabled} onClick={() => toggleEditor(id)}>
        {label}
      </LinkRow>
      {editorFor(id)}
    </div>
  );

  /** Under an open row: its moments, worded from the part (p) and timed as shown (v, the staged times). */
  const renderOpen = (p: Part, v: Part, i: number) => {
    if (p.kind === "side") {
      const name = SIDE_NAME[p.side];
      const next = parts.slice(i + 1).find(isSide);
      // After a break, "Back on the Left" only if she was on the Left before it; another side is just "On the Right".
      const before = parts.slice(0, i).filter(isSide).at(-1);
      const resumed =
        p.side === "B" ? (before?.side === "B" ? "Back on, back and forth" : "Back and forth after the break") : before?.side === p.side ? `Back on the ${name}` : `On the ${name} after the break`;
      // A switch to back and forth "went back and forth"; a side after it is "On the Left" (tracking sides again).
      const switchedTo = (to: StretchSide, from?: StretchSide) => (to === "B" ? "Went back and forth" : from === "B" ? `On the ${SIDE_NAME[to]}` : `Switched to ${SIDE_NAME[to]}`);
      const startLabel = p.startMoment === "feed_start" ? "Feed started" : p.startMoment === "switch" ? switchedTo(p.side, before?.side) : resumed;
      const endLabel = p.endMoment === "switch" && next ? switchedTo(next.side, p.side) : p.endMoment === "feed_end" ? "Feed ended" : "Came off";
      const end = v.end ?? p.end;
      return (
        <Detail>
          {line("start", `${startLabel} ${clock(v.start)}`)}
          {end && line("end", `${endLabel} ${clock(end)}`)}
          <SideFixRow side={p.side} disabled={disabled} onPick={flip} />
        </Detail>
      );
    }
    const end = v.end ?? p.end;
    const back = !p.after ? "" : p.after.side === "B" ? (p.before.side === "B" ? "Back on, back and forth" : "Back and forth") : `${p.after.side === p.before.side ? "Back on the" : "On the"} ${SIDE_NAME[p.after.side]}`;
    return (
      <Detail>
        {line("off", p.before.side === "B" ? `Came off ${clock(v.start)}` : `Came off ${SIDE_NAME[p.before.side]} ${clock(v.start)}`)}
        {p.after && end ? line("on", `${back} ${clock(end)}`) : end && line("legacy-end", `Feed ended ${clock(end)}`)}
      </Detail>
    );
  };

  // Ended shows the staged end too (an add after the end, or the end being nudged).
  const endOf = (f: FeedEntry, ps: Part[]) => f.ended_at ?? ps.filter(isSide).at(-1)?.end ?? null;
  const endedAt = endOf(working, staged);
  const savedEnd = endOf(live, partsOf(live, now));
  const endChanged = !!endedAt && (!savedEnd || Date.parse(endedAt) !== Date.parse(savedEnd));
  return (
    <div>
      <Label>Times</Label>
      <p className="mb-1 text-[15px] leading-snug font-medium text-mp-ink">{summaryOf(staged, working.data.first_side)}</p>
      {error && (
        <p role="alert" className="my-2 rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
          {error}
        </p>
      )}
      {parts.map((p, i) => {
        const v = shown[i] ?? p;
        return (
          <div key={rowKey(p)}>
            <TimesRow part={v} changed={!saved.has(partKey(v))} open={openIndex === i} tz={tz} readOnly={readOnly} disabled={disabled} onClick={() => pickRow(p, i)} />
            {openIndex === i && renderOpen(p, v, i)}
          </div>
        );
      })}
      {endedAt && (
        <ExtraRow
          mark={
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
              <Icon name="check" size={13} strokeWidth={2.4} />
            </span>
          }
          name="Ended"
          value={clock(endedAt)}
          changed={endChanged}
          open={row?.kind === "ended"}
          onClick={pickEnded}
          disabled={disabled}
          readOnly={readOnly}
          ariaLabel={`Ended at ${clock(endedAt)}${endChanged ? ", not saved yet" : ""}. Fix when the feed ended.`}
        />
      )}
      {row?.kind === "ended" && editor?.id === "ended-row" && <Detail>{editorFor("ended-row")}</Detail>}
      {!readOnly && (
        <ExtraRow
          mark={
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-mp-sunken text-mp-accent-fg">
              <Icon name="plus" size={14} strokeWidth={2.2} />
            </span>
          }
          name="Add a side she nursed on"
          accent
          open={!!add}
          onClick={toggleAdd}
          disabled={disabled}
        />
      )}
      {add && (
        <InView>
          <AddSide feed={add.base} form={add.form} tz={tz} disabled={disabled} onForm={(form) => putAdd(add.base, form)} onDrop={dropAdd} />
        </InView>
      )}
    </div>
  );
}

/** What a row opens, under it: a hairline down its left edge says whose lines these are. */
function Detail({ children }: { children: ReactNode }) {
  return <div className="mb-2 ml-3 border-l-2 border-mp-line pl-3">{children}</div>;
}

/**
 * An editor that opens below the fold scrolls up into view, and again when
 * `again` turns on (the first nudge raises the Unsaved bar, which would hide
 * the preview line under the footer).
 */
function InView({ again, children }: { again?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [again]);
  return <div ref={ref}>{children}</div>;
}

/** "2:17 – 2:30 AM", its first AM/PM dropped under 360px (where the range wraps under the name), as on the card. */
function RangeText({ start, end, tz }: { start: string; end: string | null; tz: string }) {
  if (end === null) return <>since {formatTime(start, tz)}</>;
  const [a, b] = formatRange(start, end, tz).split(" – ");
  const m = /^(.*?)(\s[AP]M)$/i.exec(a);
  return (
    <>
      {m ? (
        <>
          {m[1]}
          <span className="max-[359px]:hidden">{m[2]}</span>
        </>
      ) : (
        a
      )}
      {" – "}
      {b}
    </>
  );
}

/** A staged change's mark: a small accent dot by the value that changed. */
function ChangedDot() {
  return <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 self-center rounded-full bg-mp-accent-fg" />;
}

/**
 * A part as a row of the Times list, on the card rows' grid (mark, name,
 * range, minutes, chevron), as it will save: a row that differs from the
 * saved feed has its times in the accent with a dot, and a break the change
 * closes keeps its row, reading "No break".
 */
function TimesRow({
  part: p,
  changed,
  open,
  onClick,
  disabled,
  readOnly,
  tz,
}: {
  part: Part;
  changed: boolean;
  open: boolean;
  onClick: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  tz: string;
}) {
  const closed = isClosed(p);
  const ink = changed ? "text-mp-accent-fg" : "text-mp-ink-2";
  const body = (
    <>
      <span className="flex w-7 shrink-0 justify-start">{p.kind === "side" ? <SideMark side={p.side} size={24} /> : <BreakMark size={24} />}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 max-[359px]:flex-col max-[359px]:gap-0">
        <span className={cx("w-[46px] shrink-0 text-mp-ink-2", p.kind === "side" ? "text-[15px] font-medium" : "text-[14px]")}>{p.kind === "side" ? ROW_NAME[p.side] : "Break"}</span>
        <span className={cx("min-w-0 text-[14px] tabular-nums", ink)}>{closed ? formatTime(p.start, tz) : <RangeText start={p.start} end={p.end} tz={tz} />}</span>
      </span>
      <span className={cx("flex shrink-0 items-center gap-1.5 text-[14px] tabular-nums", ink)}>
        {changed && <ChangedDot />}
        {closed ? "No break" : minutesText(p.min)}
      </span>
      {!readOnly && <Icon name={open ? "chevron-down" : "chevron-right"} size={16} className="shrink-0 text-mp-ink-3" />}
    </>
  );
  if (readOnly) return <div className="flex min-h-[44px] items-center gap-2">{body}</div>;
  const said = closed ? `No break at ${formatTime(p.start, tz)}` : partAria(p, tz);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${said}${changed ? ", not saved yet" : ""}. Fix this part.`}
      className="-mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-2 rounded-xl px-2 text-left transition active:bg-mp-ink/5 disabled:opacity-50"
    >
      {body}
    </button>
  );
}

/** "Ended 4:30 PM ›" and "Add a side she nursed on ›": rows on the part rows' grid (mark, name, time, chevron). */
function ExtraRow({
  mark,
  name,
  value,
  changed,
  open,
  onClick,
  disabled,
  readOnly,
  accent,
  ariaLabel,
}: {
  mark: ReactNode;
  name: string;
  value?: string;
  /** A staged value (accent, with a dot). */
  changed?: boolean;
  open: boolean;
  onClick: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  accent?: boolean;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <span aria-hidden className="flex w-7 shrink-0 justify-start">
        {mark}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={cx("shrink-0 text-[15px] font-medium", accent ? "text-mp-accent-fg" : "w-[46px] text-mp-ink-2")}>{name}</span>
        {value && <span className={cx("min-w-0 text-[14px] tabular-nums", changed ? "text-mp-accent-fg" : "text-mp-ink-2")}>{value}</span>}
      </span>
      {changed && <ChangedDot />}
      {!readOnly && <Icon name={open ? "chevron-down" : "chevron-right"} size={16} className="shrink-0 text-mp-ink-3" />}
    </>
  );
  if (readOnly) return <div className="flex min-h-[44px] items-center gap-2">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={open}
      aria-label={ariaLabel}
      className="-mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-2 rounded-xl px-2 text-left transition active:bg-mp-ink/5 disabled:opacity-50"
    >
      {body}
    </button>
  );
}

/**
 * Add a side's form: the side, Started, Ended (null: five minutes after
 * Started, following it until moved), which time moved last (its note goes
 * under it), whether anyone touched it, and when it opened (the five minutes
 * stop there).
 */
type AddForm = { side: StretchSide; start: Date; end: Date | null; moved: "start" | "end"; touched: boolean; at: Date };

/** The form's first guess: the other side from the last one (after back and forth, back and forth again), from the feed's end, for five minutes. */
function addDefaults(feed: FeedEntry, now: Date): AddForm {
  const lastSide = partsOf(feed, now).filter(isSide).at(-1);
  const side: StretchSide = !lastSide ? "L" : isTracked(lastSide.side) ? other(lastSide.side) : "B";
  return { side, start: new Date(feed.ended_at ?? lastSide?.end ?? feed.started_at), end: null, moved: "start", touched: false, at: now };
}

/** What the form adds: the feed with the side in it, or why it can't ("That overlaps Left 4:00–4:10."). */
function tryAdd(feed: FeedEntry, form: AddForm, now: Date, tz: string): { end: Date; result: Staged | null; error: string | null } {
  const end = form.end ?? new Date(Math.min(form.start.getTime() + 5 * MIN, form.at.getTime()));
  if (end.getTime() < form.start.getTime() + 1000) return { end, result: null, error: "Ended must be after Started." };
  try {
    const r = addPart(feed.data, { side: form.side, start: form.start, end }, feedCtx(feed, now));
    return { end, result: { data: r.data, startedAt: r.startedAt, endedAt: r.endedAt }, error: null };
  } catch (err) {
    return { end, result: null, error: err instanceof FeedEditError ? feedEditCopy(err, "ui", tz) : err instanceof Error ? err.message : "That side doesn't fit this feed." };
  }
}

/**
 * "Add a side she nursed on": which side, when it started (from the feed's
 * end) and ended (5 minutes on, until moved), checked as it's set. No Add
 * button (it sat over Save, and Save dropped what it held): the side is
 * staged as it's set, "Save adds Right · 6 min" says so, and "Don't add it"
 * takes it back. Until she picks a side or moves a time, the times are only
 * a guess: no side is picked, nothing is staged, and the line says what to do.
 */
function AddSide({
  feed,
  form,
  tz,
  disabled,
  onForm,
  onDrop,
}: {
  /** The feed it's added to (without it). */
  feed: FeedEntry;
  form: AddForm;
  tz: string;
  disabled: boolean;
  onForm: (form: AddForm) => void;
  onDrop: () => void;
}) {
  const { now: nowFn } = useMaple();
  const n = nowFn();
  const { end, result, error } = tryAdd(feed, form, n, tz);
  const set = (patch: Partial<AddForm>) => onForm({ ...form, ...patch, touched: true });

  // The guess's own trouble (say, a feed that only just ended) waits until she sets something.
  const note = form.touched && error && (
    <p aria-live="polite" className="text-[13px] leading-snug text-mp-ink-2">
      {error}
    </p>
  );

  return (
    <Detail>
      <div className="space-y-3 pt-1 pb-1">
        {/* No side picked until she picks one (or moves a time, which keeps the guess). */}
        <Segmented<StretchSide | "">
          value={form.touched ? form.side : ""}
          onChange={(side) => side && set({ side })}
          aria-label="Which side"
          options={[
            { value: "L", label: <SideLabel side="L" /> },
            { value: "R", label: <SideLabel side="R" /> },
            { value: "B", label: <SideLabel side="B" bothLabel="Both" /> },
          ]}
          className="[&>button]:min-h-[44px]"
        />
        <TimeScrubber label="Started" value={form.start} onChange={(d) => set({ start: d, moved: "start" })} tz={tz} quick={false} nudgeStyle="words" max={n} />
        {form.moved === "start" && note}
        <TimeScrubber label="Ended" value={end} onChange={(d) => set({ end: d, moved: "end" })} tz={tz} quick={false} nudgeStyle="words" max={n} />
        {form.moved === "end" && note}
        <div className="flex min-h-[44px] items-center gap-3">
          <p aria-live="polite" className="min-w-0 flex-1 text-[13px] leading-snug text-mp-ink-2">
            {/* The times are just above; this says the footer's Save is what keeps them. */}
            {!form.touched ? (
              "Pick the side and times, and Save adds it."
            ) : (
              result && (
                <>
                  Save adds{" "}
                  <span className="text-mp-accent-fg">
                    {form.side === "B" ? "back and forth" : SIDE_NAME[form.side]} · {minutesText(spanMinutes(form.start, end))}
                  </span>
                </>
              )
            )}
          </p>
          <button
            type="button"
            onClick={onDrop}
            disabled={disabled}
            className="-mr-2 min-h-[44px] shrink-0 rounded-xl px-2 text-[14px] font-semibold text-mp-ink-2 transition active:bg-mp-ink/5 disabled:opacity-45"
          >
            Don&apos;t add it
          </button>
        </div>
      </div>
    </Detail>
  );
}

/** Closing with a staged change: "Discard your change to the times?" [Keep editing] [Discard], in place of the footer. */
function DiscardConfirm({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);
  return (
    <div ref={ref} role="alertdialog" aria-label="Discard your change to the times?">
      <p className="mb-3 text-center text-[15px] font-semibold text-mp-ink">Discard your change to the times?</p>
      <div className="flex gap-3">
        <Button variant="soft" size="lg" className="flex-1" onClick={onKeep}>
          Keep editing
        </Button>
        <Button variant="danger" size="lg" className="flex-1" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );
}

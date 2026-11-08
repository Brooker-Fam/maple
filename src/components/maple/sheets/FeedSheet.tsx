"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { atBreastOf, describeEntry, feedPartWords, milkWords, partUnits } from "@/lib/maple/describe";
import { feedRowParts } from "@/lib/maple/feed-rows";
import { AT_BREAST_WORDS, feedById, feedingPlanOf, type AtBreastVia, type FeedingPlan, type Range } from "@/lib/maple/feeding-plan";
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
  nursingRuns,
  other,
  partTotals,
  setSide,
  spanMinutes,
  topUpIds,
  topUpRunFor,
  type Part,
} from "@/lib/maple/feed";
import { bottleCues, feedCues, typicalBottle } from "@/lib/maple/guidelines";
import { formatRange, formatTime } from "@/lib/maple/time";
import { feedTargetOf, formatVolume, formatVolumeRange, ML_PER_FL_OZ, mlToOz, ozToMl } from "@/lib/maple/units";
import {
  BOTTLE_VIAS,
  type BottleVia,
  type Entry,
  type EntryOf,
  type FeedData,
  type Side,
  type StretchSide,
  type UnitSystem,
  type UpdateEntryInput,
} from "@/lib/maple/types";
import { BreakMark, MomentEditor, partAria, ROW_NAME, SIDE_NAME, SideFixRow, SideMark, type MomentEdge } from "../FeedParts";
import { logSwitches } from "../MoreSheet";
import { Icon } from "../icons";
import { DETAIL_COLOR } from "../palette";
import { Button, Chip, Segmented, Sheet, TimeRange, TimeScrubber, WhenField, cx, tone } from "../ui";
import { useBabyWords, useVoice } from "../familyWords";
import type { Voice } from "@/lib/maple/voice";
import { ApiError, useMaple } from "../useMaple";
import { useDraftChanged } from "../useDraftChanged";
import { doneText, nextSideWords } from "../useTimerActions";
import type { SheetProps } from "./index";
import { useSavedEntryConflict } from "./useSavedEntryConflict";
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
  pbool,
  pnum,
  pstr,
  useNumberChecks,
  useOpenCount,
  useOpenSheet,
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
 * bottle's amount and milk, so the primary button reads "Log 2 oz now"; milk
 * given at the breast is never "the last bottle". From a plan step (a preset
 * naming the plan feed) it starts at the plan's amount and milk, and blank
 * where the plan leaves them open (a preset's null), never the last bottle's.
 * With Bottles off (Family → On Today) a new feed has no Breast/Bottle
 * choice; a bottle already logged still opens as one.
 *
 * A feed's parts say what they are. Opened for milk at the breast (a via
 * preset of syringe or SNS: the nursing card's chip, a plan's step, a feed's
 * own form) it's "Milk at the breast": no Breast/Bottle choice, "With the
 * 10:15 AM feed" on top, Syringe or SNS, small amounts (the plan's, or 5 to
 * 20 ml), "Log 20 ml in the syringe", starting at the last milk given that
 * way. Opened for a feed's top-up (a preset naming the feed, top_up_of) it's
 * "Top-up · 12:20 PM feed", its quick amounts the plan's range. A saved part
 * opens as "Syringe at the breast" or "Top-up". With a plan saved, a part's
 * amounts (and a plan step's) are in the plan's unit, the app's beside them.
 *
 * A nursing feed's parts: "Nipple shield" (data.shield, on the feed itself;
 * an edit sends it against the version shown, as the other fields), and milk
 * at the breast, its own bottle entry (so every milk total counts it). A new
 * feed logged afterwards can say it with the feed ("Milk at the breast": the
 * amount, syringe or SNS, which milk; saved as a bottle at the feed's start
 * naming the feed, top_up_of); a saved feed lists what was given with it, each
 * opening its own form, and offers to add milk at the breast if none was.
 *
 * With a plan saved, a nursing feed or a bottle on its own says which of the
 * plan's feeds it was ("Plan feed", data.plan): a feed Maple read as the wrong
 * kind is put right for every phone, since Today's card reads it first.
 */

type Milk = NonNullable<FeedData["milk"]>;
const MILK_LABEL: Record<Milk, string> = { breastmilk: "Breast milk", formula: "Formula", mixed: "Mixed" };
/** How the milk was given (FeedData.via). */
const VIA_LABEL: Record<BottleVia, string> = { bottle: "Bottle", paced: "Paced bottle", sns: "SNS at the breast", syringe: "Syringe" };
const MIN = 60_000;
/** The id of a feed being logged, not saved yet (its toast is worded from it). */
const DRAFT_ID = Number.MIN_SAFE_INTEGER;
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
const ZERO_BOTTLE_HINT = "Enter more than 0, or leave blank if the amount is unknown.";
const PART_OVER_HINT = "One part is more than the whole bottle. Check the amounts.";

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
  return <FeedForm key={`${n}-${props.entry?.updated_at ?? "new"}`} {...props} />;
}

function FeedForm({ open, onClose, entry, preset }: SheetProps) {
  const base = useSheetBase();
  const { tz, units, state, summary, log, update, remove, clock, now, ageDays, age, api, refresh, toast, memberLabel, readOnly } = base;
  const openSheet = useOpenSheet();
  const w = useBabyWords();
  const voice = useVoice();
  const bottlesOn = logSwitches(state?.baby).bottles;
  const e = entry?.kind === "feed" ? entry : undefined;
  const running = !!e?.active;
  // A finished timed session: its times are its parts (the Times section), not a start and an end.
  const timed = !!e && !running && e.data.method === "breast" && !!e.data.segments?.length;

  // The care team's feeding plan, when one is saved: a plan feed's parts and steps are in its unit, with its amounts.
  const plan = useMemo(() => feedingPlanOf(state?.baby.settings), [state?.baby.settings]);
  // Opened for milk at the breast (a via preset of syringe or SNS: the nursing card's chip, a plan's step), "last time"
  // is the last milk given that way, never a bottle's 90 ml; a bottle's "last bottle" is never milk given at the breast.
  const [forBreast] = useState(() => !e && (pstr(preset, "via") === "sns" || pstr(preset, "via") === "syringe"));
  // Opened for a nursing feed's top-up by bottle (the plan's card names the feed it's for): titled for that feed.
  const [forTopUp] = useState(() => !e && !forBreast && pstr(preset, "method") === "bottle" && pnum(preset, "top_up_of") != null);
  const lastBottle = useMemo(
    () => state?.entries.find((x): x is EntryOf<"feed"> => x.kind === "feed" && x.data.method === "bottle" && x.id !== e?.id && !!atBreastOf(x.data) === forBreast) ?? null,
    [state, e?.id, forBreast]
  );
  // A feed's parts as its row says them: in the plan's unit when one is saved ("20 ml in the syringe", as its card).
  const pu = partUnits(state?.baby.settings, units);
  // This form's amounts: a feed's part (milk at the breast, a top-up) or a plan step's bottle in the plan's unit, so
  // they read as the plan has them; any other bottle in the app's. Fixed when it opens, so a typed amount keeps its unit.
  const [vu] = useState<UnitSystem>(() => {
    if (!plan) return units;
    const planned =
      forBreast ||
      forTopUp ||
      !!pstr(preset, "plan") ||
      (e?.data.method === "bottle" && (!!atBreastOf(e.data) || e.data.top_up_of != null || !!e.data.plan || (!!state && topUpIds(nursingRuns(state.entries, now())).has(e.id))));
    return planned ? pu : units;
  });
  // The newest milk given at the breast, for a nursing feed's own "Milk at the breast" (how it went in, how much).
  const lastAtBreast = useMemo(
    () => state?.entries.find((x): x is EntryOf<"feed"> => x.kind === "feed" && x.data.method === "bottle" && x.id !== e?.id && !!atBreastOf(x.data)) ?? null,
    [state, e?.id]
  );

  // ── Shared ──
  const [method, setMethod] = useState<"breast" | "bottle">(() => {
    if (e) return e.data.method;
    return pstr(preset, "method") === "bottle" ? "bottle" : "breast";
  });
  // Read live by id: a change from the other phone shows here, and a staged change can't overwrite it.
  const loadedEntry = e ? state?.entries.find((x) => x.id === e.id) : undefined;
  // Old entries can briefly enter state after a save or conflict response. A
  // recent-state poll dropping them again is not a deletion; retain what was
  // reviewed and let the server check its version on Save.
  const [lastLoaded, setLastLoaded] = useState<Entry | undefined>(loadedEntry ?? e);
  if (loadedEntry && !base.timerBusy(loadedEntry.id) && lastLoaded !== loadedEntry &&
      (!lastLoaded || Date.parse(loadedEntry.updated_at) >= Date.parse(lastLoaded.updated_at))) setLastLoaded(loadedEntry);
  const knownEntry = loadedEntry && (!lastLoaded || Date.parse(loadedEntry.updated_at) >= Date.parse(lastLoaded.updated_at)) ? loadedEntry : lastLoaded ?? e;
  const historical = !!knownEntry && !knownEntry.active && Date.parse(knownEntry.ended_at ?? knownEntry.started_at) < now().getTime() - 72 * 60 * MIN;
  const liveEntry = loadedEntry || historical ? knownEntry : undefined;
  // An entry that belongs in the recent list and disappears was discarded.
  const { whoDiscarded } = useMaple();
  const [seen, setSeen] = useState(false);
  if (loadedEntry && !seen) setSeen(true);
  const gone = !!e && e.id > 0 && seen && !!state && !loadedEntry && !historical;
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
  // The nipple shield: said on the feed itself (a new one can start with it from a preset, the plan's feed).
  const origShield = e?.data.method === "breast" && !!e.data.shield;
  const [shield, setShield] = useState<boolean>(() => (e ? origShield : pbool(preset, "shield") === true));
  const shieldChanged = !!e && e.data.method === "breast" && shield !== origShield;
  // A new feed's milk at the breast: its own bottle entry, saved with the feed. Off until it's turned on, then as last
  // time (how it went in, how much, which milk); a syringe the first time.
  const [milkOn, setMilkOn] = useState(false);
  const [milkVia, setMilkVia] = useState<AtBreastVia>(() => (lastAtBreast && atBreastOf(lastAtBreast.data)) || "syringe");
  const [milkAmount, setMilkAmount] = useState<number | null>(() => {
    const ml = lastAtBreast?.data.amount_ml;
    if (ml == null) return null;
    return pu === "metric" ? ml : Number(mlToOz(ml).toFixed(2));
  });
  const [milkKind, setMilkKind] = useState<Milk | undefined>(() => lastAtBreast?.data.milk);
  // Which of the plan's feeds this is (data.plan): from the plan's card, or picked here ("Plan feed"). Today's card,
  // the chat and Siri read it first, so a feed read as the wrong kind is put right on every phone.
  const [planPick, setPlanPick] = useState<string | undefined>(() => (e ? e.data.plan : pstr(preset, "plan")));
  const planChanged = !!e && !running && (planPick ?? null) !== (e.data.plan ?? null);
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
  const savedEntry = e && !running && (!timed || minutesTyped || first !== origFirst || shieldChanged || planChanged) ? e : undefined;
  const { changed: savedChanged, onConflict, notice: savedNotice } = useSavedEntryConflict(savedEntry);

  // ── Times (a finished timed session) ──
  const liveFeed = timed && e ? (liveEntry?.kind === "feed" ? liveEntry : e) : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped to start the Times section over (closes its rows and editors).
  const [epoch, setEpoch] = useState(0);
  const [timesNotice, setTimesNotice] = useState<string | null>(null);
  // An open "Add a side" whose times don't fit: Save waits, so what was typed is never dropped.
  const [addBlocked, setAddBlocked] = useState(false);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const [manualTimeInvalid, setManualTimeInvalid] = useState(false);
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
    setTimeInvalid(false);
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
  const hasStagedChanges = (dirty || addBlocked || timeInvalid) && !readOnly;
  const guarded = useRef(false);
  useEffect(() => {
    guarded.current = hasStagedChanges;
  });
  useEffect(() => {
    if (!open || !hasStagedChanges) return;
    const beforeNavigate = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm("Leave and discard your unsaved changes?")) event.preventDefault();
    };
    window.addEventListener("maple-before-navigate", beforeNavigate);
    return () => window.removeEventListener("maple-before-navigate", beforeNavigate);
  }, [open, hasStagedChanges]);
  const close = useCallback(() => (guarded.current ? setConfirming(true) : onClose()), [onClose]);

  // ── Bottle ──
  // A plan step's bottle (the preset names the plan feed) starts at the plan's amount and milk: what the plan leaves
  // open (a preset's null, or nothing said) stays blank for the family to say, never the last bottle's.
  const presetBlank = (k: string) => !!preset && Object.hasOwn(preset, k) && preset[k] === null;
  const fromPlanStep = !e && !!pstr(preset, "plan");
  const [initialAmountMl] = useState(() => {
    if (e?.data.method === "bottle") return e.data.amount_ml;
    const given = pnum(preset, "amount_ml");
    if (given != null) return given;
    return presetBlank("amount_ml") || fromPlanStep ? undefined : lastBottle?.data.amount_ml;
  });
  const [amount, setAmount] = useState<number | null>(() => {
    if (initialAmountMl == null) return null;
    if (vu === "metric") return initialAmountMl;
    const oz = mlToOz(initialAmountMl);
    return Number(oz > 0 && oz < 0.01 ? oz.toPrecision(3) : oz.toFixed(2));
  });
  const [milk, setMilk] = useState<Milk | undefined>(() => {
    if (e?.data.method === "bottle") return e.data.milk;
    const given = pstr(preset, "milk");
    if (given === "breastmilk" || given === "formula" || given === "mixed") return given;
    return presetBlank("milk") || fromPlanStep ? undefined : lastBottle?.data.milk;
  });
  // How it was given: never copied from the last bottle (a plan can alternate an SNS and a paced bottle).
  const [via, setVia] = useState<BottleVia | undefined>(() =>
    e?.data.method === "bottle" ? e.data.via : (BOTTLE_VIAS as readonly string[]).includes(pstr(preset, "via") ?? "") ? (pstr(preset, "via") as BottleVia) : undefined
  );
  // A Mixed bottle's split, in the units shown: both parts set the amount; a new amount clears them (as the pump's sides).
  const shownMl = (ml: number | undefined) => (ml == null ? null : vu === "metric" ? ml : Number(mlToOz(ml).toFixed(2)));
  const [breastPart, setBreastPart] = useState<number | null>(() => (e?.data.method === "bottle" ? shownMl(e.data.breastmilk_ml) : null));
  const [formulaPart, setFormulaPart] = useState<number | null>(() => (e?.data.method === "bottle" ? shownMl(e.data.formula_ml) : null));
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : fromPreset));
  const fieldsDirty = useDraftChanged({ manualTimeInvalid, method, when, note: notePatch.note, amount, milk, via, breastPart, formulaPart, left, right, both, first, range, shield, milkOn, milkVia, milkAmount, milkKind, planPick, invalid: checks.invalid });
  const amountMl = !touched.amount ? initialAmountMl : amount == null ? undefined : Math.round((vu === "metric" ? amount : ozToMl(amount)) * 10) / 10;
  const partMl = (v: number | null) => (v == null ? undefined : Math.round((vu === "metric" ? v : ozToMl(v)) * 10) / 10);
  const hadSplit = e?.data.method === "bottle" && (e.data.breastmilk_ml != null || e.data.formula_ml != null);
  const splitShown = milk === "mixed";
  /** A part typed: with both, the amount is their sum. */
  const editPart = (which: "breast" | "formula", v: number | null) => {
    touch("split");
    const b = which === "breast" ? v : breastPart;
    const f = which === "formula" ? v : formulaPart;
    (which === "breast" ? setBreastPart : setFormulaPart)(v);
    if (b != null && f != null) {
      touch("amount");
      setAmount(vu === "metric" ? Math.round((b + f) * 10) / 10 : Number((b + f).toFixed(3)));
    }
  };
  /** The amount typed (or a chip): an old split no longer describes it. */
  const editAmount = (v: number | null) => {
    touch("amount");
    setAmount(v);
    if (breastPart != null || formulaPart != null) {
      touch("split");
      setBreastPart(null);
      setFormulaPart(null);
    }
  };
  // One part and the amount give the other (the server works it out the same way): said under the parts.
  const knownTotal = amountMl ?? null;
  const restMl =
    splitShown && knownTotal != null && (breastPart == null) !== (formulaPart == null) ? Math.max(0, Math.round((knownTotal - (partMl(breastPart ?? formulaPart) ?? 0)) * 10) / 10) : null;
  const partOver = restMl != null && (partMl(breastPart ?? formulaPart) ?? 0) > (knownTotal ?? 0) + 0.05;
  const bottleLimit = limitIn(vu);
  const maxAmount = Math.max(bottleLimit, !touched.amount && initialAmountMl != null && initialAmountMl <= 500 ? amount ?? 0 : 0);
  const amountOverLimit = method === "bottle" && !!touched.amount && amount != null && (vu === "metric" ? amount : ozToMl(amount)) > 500;
  const zeroBottle = method === "bottle" && amountMl === 0 && (!e || !!touched.amount);
  const amountLabel = amountMl != null ? formatVolume(amountMl, vu) : null;
  // Given with a nursing feed (during it, just before, or under 30 minutes after), a bottle is that feed's top-up
  // (feed.ts topUpRunFor): the form says so before it's saved, from the loaded feeds without this one.
  const otherRuns = useMemo(
    () => (method === "bottle" ? nursingRuns((state?.entries ?? []).filter((x) => x.id !== e?.id), now()) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a clock; the feeds and this entry decide it.
    [method, state?.entries, e?.id]
  );
  // The feed this bottle tops up, even late (data.top_up_of): named by the plan's card, or a saved one's own link (the
  // log reads it the same way, feed.ts nursingRuns).
  const [linkTo] = useState(() => (e ? (e.data.method === "bottle" ? e.data.top_up_of : undefined) : pnum(preset, "top_up_of")));
  const topUpOf = method === "bottle" ? topUpRunFor(otherRuns, (when ?? now()).getTime(), now(), linkTo) : null;
  const bottleWord = topUpOf ? "top-up" : "bottle";
  const target = feedTargetOf(state?.baby.settings);
  // Milk given at the breast, by this bottle form: it reads as what it is ("20 ml in the SNS"), part of the feed.
  const breastVia = method === "bottle" && (via === "sns" || via === "syringe") ? via : null;
  // The feed it goes with ("the 10:15 AM feed"), and the plan feed it's part of: the bottle's own, else its feed's.
  const feedClock = topUpOf ? clock(topUpOf.start) : null;
  const partPlan = planPick ?? topUpOf?.entries.find((x) => x.data.plan)?.data.plan;
  // Quick amounts: a feed's part from the plan's own amount for it (its syringe's, its top-up's range), else small
  // ones for milk at the breast and the usual bottle sizes for a bottle.
  const planRange = method === "bottle" ? partRange(plan, partPlan, breastVia ?? (topUpOf ? "top-up" : null)) : null;
  const chips = planRange ? rangeChips(planRange, vu) : breastVia ? (vu === "metric" ? [5, 10, 15, 20] : [0.25, 0.5, 0.75, 1]) : vu === "metric" ? [30, 60, 90, 120] : [1, 2, 3, 4];
  // A new nursing feed's own milk at the breast, in ml (blank: given, the amount not said).
  const milkMl = milkAmount == null ? undefined : Math.round((pu === "metric" ? milkAmount : ozToMl(milkAmount)) * 10) / 10;
  const zeroMilk = method === "breast" && !e && milkOn && milkMl === 0;

  // A saved nursing feed's parts, as its row shows them (feed-rows.ts): its milk at the breast, its top-ups.
  const feedPartsHere = useMemo(
    () => (e && e.data.method === "breast" && state ? feedRowParts(nursingRuns(state.entries, now())).byRow.get(e.id) ?? [] : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a clock; the feeds and this entry decide it.
    [state?.entries, e?.id]
  );

  // ── Save ──
  const save = async () => {
    if (busy || manualTimeInvalid || timeInvalid || addBlocked || savedChanged || zeroBottle || zeroMilk || amountOverLimit || partOver || (!running && checks.invalid)) return;
    if (e) {
      const patch = editPatch();
      // Nothing changed: close without a write (a bare write would bump the version under the other phone's edit).
      if (Object.values(patch).every((v) => v === undefined)) return onClose();
      setBusy(true);
      const prev = liveEntry?.kind === "feed" ? liveEntry : e;
      const res = await update(e.id, { ...patch, ...(savedEntry ? { expect_updated_at: savedEntry.updated_at } : {}) }, { toast: "", onConflict });
      setBusy(false);
      if (res) {
        // Said as what it is: milk at the breast and a top-up are part of a feed, not a bottle of their own.
        savedToast(`${method === "bottle" ? (breastVia ? "Milk at the breast" : topUpOf ? "Top-up" : "Bottle") : "Feed"} updated`, prev, patch, res);
        onClose();
      }
      return;
    }
    if (method === "bottle") {
      const at = when ?? now();
      setBusy(true);
      try {
        const split = splitShown ? { breastmilk_ml: partMl(breastPart), formula_ml: partMl(formulaPart) } : {};
        const saved = await log(
          {
            kind: "feed",
            started_at: when?.toISOString(),
            data: {
              method: "bottle",
              amount_ml: amountMl,
              milk,
              via,
              ...split,
              // Only while it still tops up that feed (a time moved past the next feed drops the link).
              ...(linkTo && topUpOf?.entries.some((x) => x.id === linkTo) ? { top_up_of: linkTo } : {}),
              ...(planPick ? { plan: planPick } : {}),
            },
            note: note.trim() || null,
          },
          {
            toast: `${breastVia ? `${amountLabel ?? "Milk"} ${AT_BREAST_WORDS[breastVia].inThe}` : amountLabel ? `${amountLabel} ${bottleWord}` : topUpOf ? "Top-up" : "Bottle"} · ${clock(at)}`,
          }
        );
        if (saved) onClose();
      } finally {
        setBusy(false);
      }
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
    const data: FeedData = {
      method: "breast",
      left_sec: l * 60,
      right_sec: r * 60,
      ...(b > 0 ? { both_sec: b * 60 } : {}),
      ...sides,
      ...(shield ? { shield: true } : {}),
      ...(planPick ? { plan: planPick } : {}),
    };
    const endedAt = en.getTime() > s.getTime() ? en.toISOString() : undefined;
    // The next side as the card and the dock will show it once this is in the log (the Done toast's words): within
    // 30 minutes of its end, the other side from the one she ended on ("Left if she wants more"); else the
    // alternate rule ("Right next time"); after back and forth ", or the fuller side" (AAP; NEXT_SIDE_NOTE).
    const t = now();
    const draft: Entry = {
      id: DRAFT_ID,
      kind: "feed",
      started_at: s.toISOString(),
      ended_at: endedAt ?? null,
      active: false,
      data,
      note: null,
      created_by: null,
      updated_by: null,
      source: "web",
      created_at: t.toISOString(),
      updated_at: t.toISOString(),
    };
    const next = nextSideWords(draft, t, w, state?.entries);
    const toastText = l + r + b > 0 ? doneText(draft, t, w, undefined, state?.entries).text : `Nursed · ${clock(s)}${next ? ` · ${next}` : ""}`;
    setBusy(true);
    try {
      const saved = await log(
        {
          kind: "feed",
          started_at: s.toISOString(),
          ended_at: endedAt,
          data,
          note: note.trim() || null,
        },
        milkOn ? { silent: true } : { toast: toastText }
      );
      if (saved && milkOn) await saveMilkWith(saved, s, toastText, next);
      if (saved) onClose();
    } finally {
      setBusy(false);
    }
  };

  /**
   * A new feed's milk at the breast, once the feed is saved: its own bottle entry at the feed's start, naming the feed
   * (top_up_of; a feed still waiting offline has no id yet, and its start is inside the feed anyway). One toast says
   * both ("Nursed 15m (L 10 · R 5) + 20 ml in the SNS · Right next time"), its Undo taking back both.
   */
  const saveMilkWith = async (feed: Entry, at: Date, feedText: string, next: string) => {
    const milkData: FeedData = { method: "bottle", via: milkVia, ...(milkMl != null ? { amount_ml: milkMl } : {}), ...(milkKind ? { milk: milkKind } : {}), ...(feed.id > 0 ? { top_up_of: feed.id } : {}) };
    const given = await log({ kind: "feed", started_at: at.toISOString(), data: milkData }, { silent: true });
    if (!given || given.kind !== "feed") {
      toast("The feed is saved, but its milk at the breast wasn't. Open the feed to add it.", { tone: "error" });
      return;
    }
    // The side words go last, as on the Done toast.
    const tail = next ? ` · ${next}` : "";
    const head = tail && feedText.endsWith(tail) ? feedText.slice(0, -tail.length) : feedText;
    toast(`${head} ${feedPartWords(given, pu)}${head === feedText ? "" : tail}`, {
      undo: () => {
        void remove(given.id, { toast: "Undone" }).then((ok) => ok && remove(feed.id, { toast: "Undone" }));
      },
    });
  };

  const editPatch = (): UpdateEntryInput => {
    if (!e) return {};
    if (running) return { ...notePatch };
    if (method === "bottle") {
      const data: Record<string, unknown> = {};
      if (touched.amount) data.amount_ml = amountMl ?? null;
      if (touched.milk) data.milk = milk ?? null;
      if (touched.via) data.via = via ?? null;
      // Which of the plan's feeds it was (null: not said, read from what was logged).
      if (planChanged) data.plan = planPick ?? null;
      // The split goes whenever it, the amount or the milk changed on a bottle that has one (so Undo can put it back).
      if (touched.split || ((touched.amount || touched.milk) && hadSplit)) {
        data.breastmilk_ml = splitShown ? partMl(breastPart) ?? null : null;
        data.formula_ml = splitShown ? partMl(formulaPart) ?? null : null;
      }
      return {
        data: Object.keys(data).length ? data : undefined,
        started_at: !when || when.getTime() !== Date.parse(e.started_at) ? (when ?? now()).toISOString() : undefined,
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
    // The shield, on or off (null takes it off the feed); the plan feed it was (null: not said).
    if (shieldChanged) data.shield = shield ? true : null;
    if (planChanged) data.plan = planPick ?? null;
    const hasData = Object.keys(data).length > 0;
    // The store otherwise infers a manual feed's end after any start or data edit.
    const keepEnd = endMoved || minutesChanged || (!timed && (startMoved || hasData));
    return {
      started_at: startMoved ? s.toISOString() : undefined,
      // Keep the end where it shows (otherwise new minutes would move it).
      // A timed session keeps an end even at its start, so the server retimes what the sheet previewed.
      ended_at: keepEnd ? (en.getTime() > s.getTime() || (timed && !minutesChanged) ? en.toISOString() : null) : undefined,
      data: hasData ? data : undefined,
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
    if (busy || !e || !draft || !liveFeed || manualTimeInvalid || timeInvalid || addBlocked) return;
    setBusy(true);
    setTimesNotice(null);
    const data: Record<string, unknown> = { segments: draft.data.segments };
    // PATCH merges data: a flag the engine dropped (the end moved off the pause, a side added after it) has to be cleared by name.
    if (liveFeed.data.paused_at_stop && !draft.data.paused_at_stop) data.paused_at_stop = null;
    // The shield switched too, or the plan feed it was: they go in the same save.
    if (shieldChanged) data.shield = shield ? true : null;
    if (planChanged) data.plan = planPick ?? null;
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
        const current = (err.body as { entry?: Entry } | null)?.entry;
        const who = memberLabel(current?.updated_by);
        if (current?.id === e.id && current.kind === "feed") {
          setLastLoaded((latest) => !latest || Date.parse(current.updated_at) >= Date.parse(latest.updated_at) ? current : latest);
        }
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
  // A bottle says what it is: milk at the breast ("Milk at the breast", a saved one "Syringe at the breast"), a feed's
  // top-up ("Top-up · 12:20 PM feed" when opened for that feed), or a bottle ("Feed" while Breast or Bottle is a choice).
  const bottleTitle = breastVia
    ? e
      ? `${AT_BREAST_WORDS[breastVia].name} at the breast`
      : "Milk at the breast"
    : e
      ? topUpOf
        ? "Top-up"
        : "Bottle"
      : forTopUp
        ? feedClock
          ? `Top-up · ${feedClock} feed`
          : "Top-up"
        : "Feed";
  const title = e ? (running ? "Nursing now" : timed && preset?.editTime ? "Edit nursing times" : e.data.method === "bottle" ? bottleTitle : describeEntry(e).title) : method === "bottle" ? bottleTitle : "Feed";
  // "Log 20 ml in the syringe", "Log 30 ml top-up", "Log 2 oz now".
  const logBottle = breastVia
    ? `Log ${amountLabel ?? "milk"} ${AT_BREAST_WORDS[breastVia].inThe}`
    : forTopUp
      ? amountLabel
        ? `Log ${amountLabel} top-up`
        : "Log top-up"
      : amountLabel
        ? `Log ${amountLabel}${when ? "" : " now"}`
        : "Log bottle";
  const primary = e ? (timed && (dirty || preset?.editTime) ? "Save time" : "Save") : method === "bottle" ? logBottle : "Log it";
  // A feed's part opened for its feed: no Breast or Bottle to choose, and it says which feed it's with, on top.
  const asPart = !e && method === "bottle" && (forBreast || forTopUp);
  // Which of the plan's feeds it was: a nursing feed, or a bottle on its own (a feed's part goes with its feed).
  const planFeedShown = !!plan && !running && (method === "breast" || (!breastVia && !topUpOf));
  const changedBy = liveFeed ? memberLabel(liveFeed.updated_by) : null;

  // Full-width rows leave room for precise minutes and ±1/±5 controls on narrow phones.
  const steppers = (
    <div className="space-y-3">
      <MiniStepper key="left" label={<SideLabel side="L" />} unit="min" ariaLabel="minutes on the left" value={shownL} onChange={(v) => typeMinutes(v, shownR, shownB)} quickStep={5} max={240} onInvalid={checks.watch("left")} />
      <MiniStepper key="right" label={<SideLabel side="R" />} unit="min" ariaLabel="minutes on the right" value={shownR} onChange={(v) => typeMinutes(shownL, v, shownB)} quickStep={5} max={240} onInvalid={checks.watch("right")} />
      <div>
        <MiniStepper
          key="both"
          label={<SideLabel side="B" />}
          unit="min"
          ariaLabel="minutes going back and forth"
          value={shownB}
          onChange={(v) => typeMinutes(shownL, shownR, v)}
          quickStep={5}
          max={720}
          onInvalid={checks.watch("both")}
        />
        <p className={cx(tone.muted, "mt-1 text-[13px] leading-snug")}>Both sides, without tracking which.</p>
      </div>
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

  // Another entry's form (a part of this feed) replaces this one: unsaved changes here ask first.
  const leaveFor = (go: () => void) => {
    if ((fieldsDirty || dirty || addBlocked || timeInvalid) && !readOnly && !window.confirm("Leave and discard your unsaved changes?")) return;
    go();
  };
  const lastVia = (lastAtBreast && atBreastOf(lastAtBreast.data)) || "syringe";
  // A saved feed's milk at the breast, added afterwards: a bottle at the feed's start that names it. A plan feed's is
  // as its plan says (its way in, its amount when that's one number, its milk when named; the rest left to say), any
  // other as last time.
  const addMilkTo = (f: EntryOf<"feed">) => {
    const sup = plan && f.data.plan ? feedById(plan, f.data.plan)?.steps.flatMap((s) => (s.do === "nurse" && s.supplement ? [s.supplement] : []))[0] : undefined;
    const as = sup
      ? { via: sup.via, amount_ml: sup.ml.min === sup.ml.max ? sup.ml.min : null, milk: sup.milk === "formula" || sup.milk === "breastmilk" ? sup.milk : null, plan: f.data.plan }
      : {
          via: lastVia,
          ...(lastAtBreast?.data.amount_ml != null ? { amount_ml: lastAtBreast.data.amount_ml } : {}),
          ...(lastAtBreast?.data.milk ? { milk: lastAtBreast.data.milk } : {}),
        };
    leaveFor(() => openSheet({ kind: "feed", preset: { method: "bottle", ...as, started_at: f.started_at, top_up_of: f.id } }));
  };
  // Which of the plan's feeds this was: one chip each; the one picked, tapped again, clears it.
  const planFeedPick = planFeedShown && plan ? <PlanFeedPick plan={plan} value={planPick} onChange={setPlanPick} disabled={readOnly} /> : null;
  const allAtBreast = feedPartsHere.length > 0 && feedPartsHere.every((b) => !!atBreastOf(b.data));
  // The feed's own parts: its shield, and its milk at the breast (a new feed's to say here; a saved one's to open).
  const feedOwnParts = (
    <>
      <div className="flex min-h-[44px] items-center justify-between gap-4">
        <Label className="mb-0">Nipple shield</Label>
        <FormSwitch checked={shield} onChange={setShield} label="Nipple shield" disabled={readOnly} />
      </div>
      {!e ? (
        <section aria-label="Milk at the breast">
          <div className="flex min-h-[44px] items-center justify-between gap-4">
            <span className="min-w-0">
              <Label className="mb-0">Milk at the breast</Label>
              {!milkOn && <span className={cx(tone.muted, "block text-[13px] leading-snug")}>By syringe or SNS while {w.he} nursed</span>}
            </span>
            <FormSwitch checked={milkOn} onChange={setMilkOn} label="Milk at the breast" disabled={readOnly} />
          </div>
          {milkOn && (
            <div className="mt-3 space-y-4">
              <div role="group" aria-label="Which milk" className="flex flex-wrap gap-2">
                {(Object.keys(MILK_LABEL) as Milk[]).map((m) => (
                  <Chip key={m} selected={milkKind === m} onClick={() => setMilkKind(milkKind === m ? undefined : m)}>
                    {MILK_LABEL[m]}
                  </Chip>
                ))}
              </div>
              <div>
                <MiniStepper
                  key="milk-amount"
                  label="Amount"
                  unit={pu === "metric" ? "ml" : "oz"}
                  ariaLabel={`milk at the breast, ${pu === "metric" ? "millilitres" : "ounces"}`}
                  value={milkAmount}
                  onChange={setMilkAmount}
                  onInvalid={checks.watch("milk-amount")}
                  step={pu === "metric" ? 5 : 0.25}
                  decimals={pu === "metric" ? 1 : 3}
                  max={limitIn(pu)}
                />
                {zeroMilk && <p role="alert" className="mt-1.5 text-[13px] text-mp-danger">{ZERO_BOTTLE_HINT}</p>}
              </div>
              <Segmented<AtBreastVia>
                aria-label="How it was given"
                value={milkVia}
                onChange={setMilkVia}
                options={[
                  { value: "syringe", label: AT_BREAST_WORDS.syringe.name },
                  { value: "sns", label: AT_BREAST_WORDS.sns.name },
                ]}
              />
              <p className={cx(tone.muted, "text-[13px] leading-snug")}>Saved with this feed: part of it, not a feed of its own.</p>
            </div>
          )}
        </section>
      ) : (
        (feedPartsHere.length > 0 || !readOnly) && (
          <section aria-label={feedPartsHere.length && !allAtBreast ? "With this feed" : "Milk at the breast"}>
            <Label>{feedPartsHere.length && !allAtBreast ? "With this feed" : "Milk at the breast"}</Label>
            <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
              {feedPartsHere.map((b) => {
                const part = feedPartWords(b, pu).slice(2);
                const more = [milkWords(b.data, pu), b.data.via === "paced" ? "paced bottle" : null, clock(b.started_at)].filter(Boolean).join(" · ");
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => leaveFor(() => openSheet({ kind: "feed", entry: b }))}
                    aria-label={`${readOnly ? "" : "Edit: "}${part}, ${more}`}
                    className={cx(tone.row, "min-h-[52px] py-2")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cx(tone.body, "block text-[15px] font-medium")}>{part.charAt(0).toUpperCase() + part.slice(1)}</span>
                      <span className={cx(tone.muted, "block text-[13px]")}>{more}</span>
                    </span>
                    <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
                  </button>
                );
              })}
              {!readOnly && !feedPartsHere.some((b) => !!atBreastOf(b.data)) && (
                <button type="button" onClick={() => addMilkTo(e)} className={cx(tone.row, "min-h-[48px] py-2 text-[15px] font-medium text-mp-accent-fg")}>
                  <Icon name="plus" size={18} className="shrink-0" />
                  <span className="min-w-0 flex-1">Add milk at the breast</span>
                </button>
              )}
            </div>
          </section>
        )
      )}
      {planFeedPick}
    </>
  );

  // ── A bottle's fields (milk at the breast and a top-up are bottles too, each said as what it is) ──
  const unitWord = vu === "metric" ? "ml" : "oz";
  const unitName = vu === "metric" ? "millilitres" : "ounces";
  // A feed's part opened for its feed: the feed it goes with, first (or, its time moved off any feed, what it is then).
  const partLine = asPart ? (
    <p className="flex items-start gap-2 text-[15px] leading-snug text-mp-ink">
      <Icon name="baby" size={18} className="mp-kind-ink mt-px shrink-0" style={{ color: DETAIL_COLOR.nursing }} />
      <span className="min-w-0">
        {!topUpOf ? (
          "No nursing feed then, so it counts as a feed of its own."
        ) : forTopUp && !breastVia ? (
          "Part of that feed, not a feed of its own."
        ) : (
          <>
            With the <span className="font-semibold whitespace-nowrap">{feedClock}</span> feed: part of it, not a feed of its own.
          </>
        )}
      </span>
    </p>
  ) : null;
  const milkSection = (
    <section aria-label="Milk">
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
      {splitShown && (
        // Mixed: how much of each (optional). Both set the amount; one and the amount give the other.
        <div className="mt-3">
          <p className={cx(tone.muted, "mb-1.5 text-[13px]")}>How much of each (optional)</p>
          <div className="grid grid-cols-2 gap-3">
            <MiniStepper key="breast-part" label="Breast milk" unit={unitWord} ariaLabel={`breast milk, ${unitName}`} value={breastPart} onChange={(v) => editPart("breast", v)} onInvalid={checks.watch("breast-part")} step={vu === "metric" ? 5 : 0.25} decimals={vu === "metric" ? 1 : 3} max={bottleLimit} />
            <MiniStepper key="formula-part" label="Formula" unit={unitWord} ariaLabel={`formula, ${unitName}`} value={formulaPart} onChange={(v) => editPart("formula", v)} onInvalid={checks.watch("formula-part")} step={vu === "metric" ? 5 : 0.25} decimals={vu === "metric" ? 1 : 3} max={bottleLimit} />
          </div>
          {partOver ? (
            <p role="alert" className="mt-1.5 text-[13px] text-mp-danger">{PART_OVER_HINT}</p>
          ) : restMl != null ? (
            <p className={cx(tone.muted, "mt-1.5 text-[13px]")}>
              The rest, {formatVolume(restMl, vu)}, is {breastPart != null ? "formula" : "breast milk"}.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
  const amountSection = (
    <div>
      <MiniStepper
        key="amount"
        // Milk at the breast: "In the syringe", "In the SNS".
        label={breastVia ? AT_BREAST_WORDS[breastVia].inThe.replace(/^i/, "I") : "Amount consumed"}
        unit={unitWord}
        ariaLabel={breastVia ? `${AT_BREAST_WORDS[breastVia].inThe}, ${unitName}` : unitName}
        value={amount}
        onChange={editAmount}
        onInvalid={checks.watch("amount")}
        step={vu === "metric" ? 5 : breastVia ? 0.25 : 0.5}
        decimals={vu === "metric" ? 1 : 3}
        max={maxAmount}
      />
      {(checks.invalid || amountOverLimit) && <p role="alert" className="mt-1.5 text-[13px] text-mp-danger">Bottle amounts can be up to {vu === "metric" ? "500 ml" : `${bottleLimit} oz (500 ml)`}. Correct the amount, or leave it blank if unknown.</p>}
      {zeroBottle && <p role="alert" className="mt-1.5 text-[13px] text-mp-danger">{ZERO_BOTTLE_HINT}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {chips.map((c) => (
          <Chip key={c} selected={amount === c} onClick={() => editAmount(c)}>
            {c} {unitWord}
          </Chip>
        ))}
      </div>
      {/* In the plan's unit while the app shows the other: the app's beside it, so it can be checked either way. */}
      {vu !== units && amountMl != null && amountMl > 0 && <p className={cx(tone.muted, "mt-1.5 text-xs")}>That&apos;s {formatVolume(amountMl, units)}.</p>}
      {lastBottle?.data.amount_ml != null && !e && (
        <p className={cx(tone.muted, "mt-1.5 text-xs")}>
          {forBreast ? "Last at the breast" : "Last bottle"}: {formatVolume(lastBottle.data.amount_ml, vu)}
          {lastBottle.data.milk ? ` of ${MILK_LABEL[lastBottle.data.milk].toLowerCase()}` : ""} at {clock(lastBottle.started_at)}
        </p>
      )}
    </div>
  );

  return (
    <Sheet
      open={open}
      locked={busy}
      onClose={close}
      dirty={fieldsDirty && !dirty && !addBlocked && !timeInvalid && !readOnly}
      title={title}
      calm={preset?.editTime === true}
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
          <fieldset disabled={busy} className="min-w-0">
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
              disabled={savedChanged || manualTimeInvalid || gone || (!!e && e.id < 0) || (!running && checks.invalid) || (!conflict && (addBlocked || timeInvalid)) || empty || addOnly || zeroBottle || zeroMilk || amountOverLimit || partOver}
              hint={
                gone
                  ? "Nothing to save: it's gone."
                  : !running && (checks.invalid || amountOverLimit)
                  ? CHECK_NUMBER_HINT
                  : zeroBottle || zeroMilk
                    ? ZERO_BOTTLE_HINT
                  : partOver
                    ? PART_OVER_HINT
                  : empty
                    ? `Add how long ${w.he} nursed.`
                    : addOnly
                    ? "Pick Left or Right to add a side."
                    : conflict
                    ? undefined
                    : timeInvalid || manualTimeInvalid
                      ? "Check the date and time above."
                    : addBlocked
                      ? ADD_BLOCKED
                      : e && e.id < 0
                        ? "Still syncing, so it can't be edited yet."
                        : undefined
              }
            />
          </fieldset>
        )
      }
    >
      <fieldset disabled={busy} aria-busy={busy} className="min-w-0 space-y-5">
      {/* A timed feed's own times are its rows: the tap time up here would read as one more start. */}
      {e && <LoggedBy entry={e} noTime={e.data.method === "breast" && !!e.data.segments?.length} />}
      {savedNotice}

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
          {/* Bottles off (Family → On Today): a new feed is nursing, no choice to make. A feed's part is what it is. */}
          {!e && !asPart && (bottlesOn || method === "bottle") && (
            <Segmented
              aria-label="Feed type"
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
                    openTime={preset?.editTime === true}
                    onTimeInvalid={setTimeInvalid}
                  />
                  {!readOnly && (
                    <MoreDetails label="Type minutes instead" summary={minutesTyped ? `L ${left ?? 0} · R ${right ?? 0}${(both ?? 0) > 0 ? ` · both ${both}` : ""} min` : undefined}>
                      <p className={cx(tone.muted, "text-[13px] leading-snug")}>Saving minutes replaces the timed parts.</p>
                      {steppers}
                      {startedOn}
                    </MoreDetails>
                  )}
                  {!preset?.editTime && feedOwnParts}
                </>
              )
            ) : (
              <>
                {steppers}
                {startedOn}
                <TimeRange
                  onInvalidChange={(invalid) => {
                    setManualTimeInvalid(invalid);
                    // An explicit draft owns its time even before it is valid.
                    if (invalid) setAnchor(null);
                  }}
                  start={range[0]}
                  end={range[1]}
                  tz={tz}
                  durations={[]}
                  startQuick={[1, 5, 10, 20, 30, 60, 120]}
                  onChange={(s, en) => {
                    setAnchor(null);
                    setRange([s, en]);
                  }}
                />
                {feedOwnParts}
              </>
            )
          ) : (
            <>
              {/* A feed's part says which feed it's with, on top. Milk at the breast: how it went in, then how much, then
                  which milk. A bottle: what's in it first (formula, breast milk or both is the first thing to say, and
                  on a phone the last thing in the form sits below the fold). */}
              {partLine}
              {asPart && breastVia && (
                <Segmented<AtBreastVia>
                  aria-label="How it was given"
                  value={breastVia}
                  onChange={setVia}
                  options={[
                    { value: "syringe", label: AT_BREAST_WORDS.syringe.name },
                    { value: "sns", label: AT_BREAST_WORDS.sns.name },
                  ]}
                />
              )}
              {!breastVia && milkSection}
              {amountSection}
              {breastVia && milkSection}
              <WhenField value={when} onChange={setWhen} onInvalidChange={setManualTimeInvalid} tz={tz} />
              {!asPart && topUpOf && (
                <p className={cx(tone.muted, "-mt-2 text-[13px] leading-snug")}>
                  {breastVia
                    ? `Milk at the breast with the ${feedClock} feed: part of that feed, not a feed of its own.`
                    : `A top-up for the ${feedClock} feed: part of that feed, not a feed of its own.`}
                </p>
              )}
              {!(asPart && breastVia) && (
                <section aria-label="How it was given">
                  <Label>How</Label>
                  <div className="flex flex-wrap gap-2">
                    {BOTTLE_VIAS.map((v) => (
                      <Chip
                        key={v}
                        selected={via === v}
                        onClick={() => {
                          touch("via");
                          setVia(via === v ? undefined : v);
                        }}
                      >
                        {VIA_LABEL[v]}
                      </Chip>
                    ))}
                  </div>
                </section>
              )}
              {planFeedPick}
              {!breastVia && (
                <ContextNote>
                  {/* A target from their care team replaces the typical amount (it counts what's taken at the breast too). */}
                  {target ? (
                    <>
                      Target from your care team: {formatVolumeRange(target, vu)} a feed, counting what {voice.they} {voice.verb("takes")} at the breast. {feedCues(voice)}
                    </>
                  ) : (
                    <>
                      {age ? <>Typical at {w.his} age: {typicalBottle(ageDays)}. </> : null}
                      {bottleCues(voice)}
                    </>
                  )}
                </ContextNote>
              )}
            </>
          )}
        </>
      )}

      <NoteField value={note} onChange={setNote} readOnly={readOnly} />
      </fieldset>
    </Sheet>
  );
}

/** The most one bottle can hold, in the unit shown (500 ml). */
const limitIn = (u: UnitSystem) => (u === "metric" ? 500 : Math.floor(mlToOz(500) * 1000) / 1000);

/**
 * A plan feed's own amount (ml) for one of a feed's parts: its milk at the
 * breast (given that way, else any), or its top-up (a bottle step's amount,
 * after the nursing). Null when the plan has none (a top-up "up to the
 * target" is the target less what she took, so it has no amount of its own).
 */
function partRange(plan: FeedingPlan | null, feedId: string | undefined, part: AtBreastVia | "top-up" | null): Range | null {
  const feed = plan && part ? feedById(plan, feedId) : null;
  if (!feed) return null;
  if (part !== "top-up") {
    const given = feed.steps.flatMap((s) => (s.do === "nurse" && s.supplement ? [s.supplement] : []));
    return (given.find((x) => x.via === part) ?? given[0])?.ml ?? null;
  }
  let nursed = false;
  for (const s of feed.steps) {
    if (s.do === "nurse") nursed = true;
    else if (s.do === "bottle" && nursed && s.ml) return s.ml;
  }
  return null;
}

/** Quick amounts from a plan's range, in the unit shown: its ends, and the middle of a wide one ("25", "30", "35" ml). */
function rangeChips(r: Range, u: UnitSystem): number[] {
  const shown = (ml: number) => (u === "metric" ? Math.round(ml * 10) / 10 : Number((ml / ML_PER_FL_OZ).toFixed(2)));
  const lo = shown(r.min);
  const hi = shown(r.max);
  const step = u === "metric" ? 5 : 0.25;
  const mid = Math.round((lo + hi) / 2 / step) * step;
  return [...new Set([lo, ...(hi - lo >= 2 * step && mid > lo && mid < hi ? [mid] : []), hi])];
}

/**
 * Which of the plan's feeds this was (data.plan), one chip each: Today's card,
 * the chat and Siri read it before anything logged with the feed, so a feed
 * read as the wrong kind is put right here for every phone. The one picked,
 * tapped again, clears it (then what was logged with it decides).
 */
function PlanFeedPick({ plan, value, onChange, disabled }: { plan: FeedingPlan; value: string | undefined; onChange: (id: string | undefined) => void; disabled?: boolean }) {
  const known = !!value && plan.feeds.some((f) => f.id === value);
  return (
    <section aria-label="Plan feed">
      <Label>Plan feed</Label>
      <div className="flex flex-wrap gap-2">
        {plan.feeds.map((f) => (
          <Chip key={f.id} selected={value === f.id} disabled={disabled} onClick={() => onChange(value === f.id ? undefined : f.id)}>
            {f.name}
          </Chip>
        ))}
      </div>
      <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>
        {known ? "Every phone counts it as this feed of the plan." : "Not set: Maple goes by what was logged with it."}
      </p>
    </section>
  );
}

/** An iOS-style switch (Family's): a 44px target around the 51×31 track; at night on is filled and off is hollow. */
function FormSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="-my-1.5 flex h-11 shrink-0 items-center disabled:opacity-40"
    >
      <span
        className={cx(
          "relative block h-[31px] w-[51px] rounded-full transition-colors",
          checked ? "bg-mp-accent [.maple-night_&]:bg-[rgb(224_169_59/0.3)]" : "bg-mp-sunken ring-1 ring-mp-line ring-inset [.maple-night_&]:bg-transparent"
        )}
      >
        <span
          className={cx(
            "absolute top-[2px] left-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.18)] transition-transform",
            checked ? "translate-x-5 [.maple-night_&]:bg-mp-on-accent" : "[.maple-night_&]:bg-transparent [.maple-night_&]:shadow-[inset_0_0_0_2px_rgb(224_169_59/0.5)]"
          )}
        />
      </span>
    </button>
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

type Row = { kind: "side"; key: string; index: number; side: StretchSide } | { kind: "break"; key: string; index: number } | { kind: "ended" } | { kind: "add"; base: FeedEntry; form: AddForm };
/** The open moment editor: its line, the moment, and the feed as it was when it opened (`to`: the staged time). */
type StagedEditor = { id: string; edge: MomentEdge; base: FeedEntry; to?: Date };

export function rowIndex(row: Row | null, parts: Part[]): number | null {
  if (!row || (row.kind !== "side" && row.kind !== "break")) return null;
  const fits = (p: Part | undefined) => !!p && p.kind === row.kind && (row.kind !== "side" || (p.kind === "side" && p.side === row.side));
  const exact = parts.findIndex((p) => fits(p) && rowKey(p) === row.key);
  if (exact !== -1) return exact;
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
export function previewParts(rows: Part[], staged: Part[], from: number | null, to: Date | undefined): Part[] {
  const same = rows.length === staged.length && rows.every((p, i) => p.kind === staged[i].kind && (p.kind !== "side" || (staged[i] as SidePart).side === p.side));
  if (same) return staged;
  if (staged.length > rows.length) return rows.map((p) => staged.find((next) => rowKey(next) === rowKey(p)) ?? p);
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
  openTime,
  onTimeInvalid,
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
  openTime: boolean;
  onTimeInvalid: (invalid: boolean) => void;
}) {
  const { now: nowFn } = useMaple();
  const w = useBabyWords();
  const vo = useVoice();
  const initialParts = partsOf(working, nowFn());
  const initialSide = initialParts.find(isSide);
  const [row, setRow] = useState<Row | null>(() => openTime && initialSide ? { kind: "side", key: rowKey(initialSide), index: initialParts.indexOf(initialSide), side: initialSide.side } : null);
  const [editor, setEditor] = useState<StagedEditor | null>(() => openTime && initialSide ? { id: `${rowKey(initialSide)}:start`, edge: { edge: "start", ref: initialSide.ref }, base: working } : null);
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
  const clock = (t: string) => formatTime(t, tz);

  const collapse = () => {
    onTimeInvalid(false);
    setEditor(null);
    setError(null);
  };
  const openRow = (next: Row | null) => {
    if (add && next?.kind !== "add") {
      // Leaving Add a side: a side she set that fits stays staged (and shows as a row); times that don't fit go. The untouched guess staged nothing.
      if (add.form.touched && !tryAdd(add.base, add.form, nowFn(), tz, vo).result) onStage(restOf(add.base), add.base);
      onAddBlocked(false);
      onAddPending(false);
    }
    setRow(next);
  };
  // Taps act on the staged feed, which the rows draw on the editor's feed while one is open:
  // find the open row there (a moved switch has a new start, so the shown part's ref won't do).
  const openInStaged = (p: Part, at: number): { p: Part; i: number } | null => {
    const target: Row = p.kind === "side" ? { kind: "side", key: rowKey(p), index: at, side: p.side } : { kind: "break", key: rowKey(p), index: at };
    const i = rowIndex(target, staged);
    return i === null ? null : { p: staged[i], i };
  };
  const rowOf = (p: Part, i: number): Row => (p.kind === "side" ? { kind: "side", key: rowKey(p), index: i, side: p.side } : { kind: "break", key: rowKey(p), index: i });
  const edgeOf = (id: string, p: Part): MomentEdge | null => {
    if (p.kind === "side") return id === "start" ? { edge: "start", ref: p.ref } : id === "end" && p.end ? { edge: "side_end", ref: p.ref } : null;
    if (id === "off") return { edge: "end", ref: p.before };
    if (id === "on") return p.after ? { edge: "start", ref: p.after } : null;
    return id === "legacy-end" ? { edge: "ended" } : null;
  };
  const toggleEditor = (moment: string, p: Part, i: number) => {
    onTimeInvalid(false);
    setError(null);
    const id = `${rowKey(p)}:${moment}`;
    if (editor?.id === id) return setEditor(null);
    const found = openInStaged(p, i);
    const edge = found && edgeOf(moment, found.p);
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
      setError(null);
    } catch (err) {
      setError(err instanceof FeedEditError ? feedEditCopy(err, "ui", tz, vo) : "That time couldn't be changed. Have another look.");
      onTimeInvalid(true);
    }
  };
  /** "Wrong side?": the part is the other side, or both sides; one going back and forth is one side after all. */
  const flip = (side: StretchSide, part: Part, index: number) => {
    const found = openInStaged(part, index);
    collapse();
    if (!found || found.p.kind !== "side") return;
    try {
      const r = setSide(working.data, found.p.ref, side, feedCtx(working, nowFn()));
      onStage({ data: r.data, startedAt: r.startedAt, endedAt: working.ended_at }, working);
      openRow({ kind: "side", key: rowKey(found.p), index: found.i, side });
    } catch (err) {
      setError(err instanceof FeedEditError ? feedEditCopy(err, "ui", tz, vo) : "That part changed; have another look.");
    }
  };
  const pickEnded = () => {
    onTimeInvalid(false);
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
      const r = tryAdd(on, form, nowFn(), tz, vo);
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
          <MomentEditor entry={base} tz={tz} edge={editor.edge} mode="staged" draft={fresh ? undefined : editor.to} onDraft={nudge} onInvalidChange={onTimeInvalid} disabled={disabled} who={who} />
        </div>
      </InView>
    );
  const line = (moment: string, label: string, part: Part, index: number) => {
    const id = `${rowKey(part)}:${moment}`;
    return (
      <div key={id}>
        {readOnly ? <p className="py-2 text-[14px] text-mp-ink-2">{label}</p> : (
          <button type="button" aria-expanded={editor?.id === id} disabled={disabled} onClick={() => toggleEditor(moment, part, index)} className="flex min-h-[48px] w-full items-center justify-between gap-3 rounded-lg py-2 text-left disabled:opacity-45">
            <span className="min-w-0 text-[14px] text-mp-ink tabular-nums">{label}</span>
            <span className="shrink-0 text-[14px] font-medium text-mp-accent-fg">Edit time</span>
          </button>
        )}
        {editorFor(id)}
      </div>
    );
  };

  /** Under an open row: its moments, worded from the part (p) and timed as shown (v, the staged times). */
  const renderOpen = (p: Part, v: Part, i: number) => {
    if (p.kind === "side") {
      const name = SIDE_NAME[p.side];
      // After a break, "Back on the Left" only if she was on the Left before it; another side is just "On the Right".
      const before = parts.slice(0, i).filter(isSide).at(-1);
      const resumed =
        p.side === "B" ? (before?.side === "B" ? "Back on, back and forth" : "Back and forth after the break") : before?.side === p.side ? `Back on the ${name}` : `On the ${name} after the break`;
      // A switch to back and forth "went back and forth"; a side after it is "On the Left" (tracking sides again).
      const switchedTo = (to: StretchSide, from?: StretchSide) => (to === "B" ? "Went back and forth" : from === "B" ? `On the ${SIDE_NAME[to]}` : `Switched to ${SIDE_NAME[to]}`);
      const startLabel = p.startMoment === "feed_start" ? `Started ${name}` : p.startMoment === "switch" ? switchedTo(p.side, before?.side) : resumed;
      const endLabel = p.side === "B" ? "Ended both sides" : `Ended ${name}`;
      const end = v.end ?? p.end;
      return (
        <Detail>
          {line("start", `${startLabel} · ${clock(v.start)}`, p, i)}
          {end && i < parts.length - 1 && line("end", `${endLabel} · ${clock(end)}`, p, i)}
          {!readOnly && <section aria-label="Change side" className="pt-3 text-[14px] text-mp-ink-2">
            <Label>Change side</Label>
            <SideFixRow side={p.side} disabled={disabled} onPick={(side) => flip(side, p, i)} />
          </section>}
        </Detail>
      );
    }
    const end = v.end ?? p.end;
    const back = !p.after ? "" : p.after.side === "B" ? (p.before.side === "B" ? "Back on, back and forth" : "Back and forth") : `${p.after.side === p.before.side ? "Back on the" : "On the"} ${SIDE_NAME[p.after.side]}`;
    return (
      <Detail>
        {line("off", p.before.side === "B" ? `Came off · ${clock(v.start)}` : `Came off ${SIDE_NAME[p.before.side]} · ${clock(v.start)}`, p, i)}
        {p.after && end ? line("on", `${back} · ${clock(end)}`, p, i) : end && line("legacy-end", `Feed ended · ${clock(end)}`, p, i)}
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
            <TimesRow part={v} changed={!saved.has(partKey(v))} open={false} tz={tz} readOnly disabled={disabled} onClick={() => {}} />
            {p.kind === "side" && renderOpen(p, v, i)}
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
          editTime
          value={clock(endedAt)}
          changed={endChanged}
          open={row?.kind === "ended"}
          onClick={pickEnded}
          disabled={disabled}
          readOnly={readOnly}
          ariaLabel={`Ended at ${clock(endedAt)}${endChanged ? ", not saved yet" : ""}. Edit time when the feed ended.`}
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
          name={`Add a side ${w.he} nursed on`}
          accent
          open={!!add}
          onClick={toggleAdd}
          disabled={disabled}
        />
      )}
      {add && (
        <InView>
          <AddSide onInvalidChange={onTimeInvalid} feed={add.base} form={add.form} tz={tz} disabled={disabled} onForm={(form) => putAdd(add.base, form)} onDrop={dropAdd} />
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
  editTime,
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
  editTime?: boolean;
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
      {!readOnly && (editTime ? <span className="shrink-0 text-[14px] font-medium text-mp-accent-fg">Edit time</span> : <Icon name={open ? "chevron-down" : "chevron-right"} size={16} className="shrink-0 text-mp-ink-3" />)}
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
function tryAdd(feed: FeedEntry, form: AddForm, now: Date, tz: string, vo: Voice): { end: Date; result: Staged | null; error: string | null } {
  const end = form.end ?? new Date(Math.min(form.start.getTime() + 5 * MIN, form.at.getTime()));
  if (end.getTime() < form.start.getTime() + 1000) return { end, result: null, error: "Ended must be after Started." };
  try {
    const r = addPart(feed.data, { side: form.side, start: form.start, end }, feedCtx(feed, now));
    return { end, result: { data: r.data, startedAt: r.startedAt, endedAt: r.endedAt }, error: null };
  } catch (err) {
    return { end, result: null, error: err instanceof FeedEditError ? feedEditCopy(err, "ui", tz, vo) : err instanceof Error ? err.message : "That side doesn't fit this feed." };
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
  onInvalidChange,
  feed,
  form,
  tz,
  disabled,
  onForm,
  onDrop,
}: {
  onInvalidChange: (invalid: boolean) => void;
  /** The feed it's added to (without it). */
  feed: FeedEntry;
  form: AddForm;
  tz: string;
  disabled: boolean;
  onForm: (form: AddForm) => void;
  onDrop: () => void;
}) {
  const { now: nowFn } = useMaple();
  const vo = useVoice();
  const invalidFields = useRef({ start: false, end: false });
  const [timeInvalid, setTimeInvalid] = useState(false);
  const reportInvalid = (edge: "start" | "end", invalid: boolean) => {
    invalidFields.current[edge] = invalid;
    const anyInvalid = invalidFields.current.start || invalidFields.current.end;
    setTimeInvalid(anyInvalid);
    onInvalidChange(anyInvalid);
    // Once an end is being typed, moving the start must not replace that
    // draft with another guessed five-minute end.
    if (edge === "end" && invalid && form.end === null) onForm({ ...form, end });
  };
  const n = nowFn();
  const { end, result, error } = tryAdd(feed, form, n, tz, vo);
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
        <TimeScrubber label="Started" onInvalidChange={(invalid) => reportInvalid("start", invalid)} value={form.start} onChange={(d) => set({ start: d, moved: "start" })} tz={tz} quick={false} nudgeStyle="words" max={n} />
        {form.moved === "start" && note}
        <TimeScrubber label="Ended" onInvalidChange={(invalid) => reportInvalid("end", invalid)} value={end} onChange={(d) => set({ end: d, moved: "end" })} tz={tz} quick={false} nudgeStyle="words" max={n} />
        {form.moved === "end" && note}
        <div className="flex min-h-[44px] items-center gap-3">
          <p aria-live="polite" className="min-w-0 flex-1 text-[13px] leading-snug text-mp-ink-2">
            {/* The times are just above; this says the footer's Save is what keeps them. */}
            {timeInvalid ? (
              "Check the date and time above before saving."
            ) : !form.touched ? (
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

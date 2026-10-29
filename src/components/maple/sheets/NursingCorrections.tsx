"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyFeedCorrections, CLUSTER_GAP_MS, describeChange, edgeBounds, FeedEditError,
  feedCtx, feedEditCopy, feedParts, minutesText, partTotals, previousFeed, undoableTap, type Part,
} from "@/lib/maple/feed";
import { formatRange, formatTime } from "@/lib/maple/time";
import type { Entry, FeedCorrection, StretchSide } from "@/lib/maple/types";
import { BreakMark, LinkRow, MomentEditor, SIDE_NAME, SideFixRow, SideMark, Spinner, type FixExpand, type FixTarget, type MomentEdge } from "../FeedParts";
import { useBabyWords, useVoice } from "../familyWords";
import { cx } from "../ui";
import { useMaple, useNow, type TimerFailure } from "../useMaple";
import { useTimerActions } from "../useTimerActions";
import { useSheets } from "./index";

type SidePart = Extract<Part, { kind: "side" }>;
type Selection = { index: number; edge: MomentEdge["edge"] };
// original owns the one revision checked at Save. edits/before contain the
// corrections already staged by visiting other moments. The current candidate
// stays separate so its presets and bounds keep a fixed, pre-edit baseline.
type Draft = { original: Entry; edits: FeedCorrection[]; before: Entry; selection: Selection; candidate: Date | null; revision: number };
type Destination = { kind: "recovery"; expand: FixExpand; side?: StretchSide } | { kind: "details" } | { kind: "undo" } | { kind: "join"; previous: Entry; side: StretchSide };
const partsOf = (e: Entry, now: Date) => e.kind === "feed" ? feedParts(e.data, feedCtx(e, now)) : [];
const sidesOf = (e: Entry, now: Date) => partsOf(e, now).filter((p): p is SidePart => p.kind === "side");
const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 1500;
const same = (a: Entry, b: Entry) => a.kind === "feed" && b.kind === "feed" && a.started_at === b.started_at && a.ended_at === b.ended_at && JSON.stringify(a.data.segments) === JSON.stringify(b.data.segments) && a.data.paused_at_stop === b.data.paused_at_stop;

function initialSelection(e: Entry, target: FixTarget, now: Date): Selection {
  const sides = sidesOf(e, now);
  let index = sides.length - 1;
  let edge: MomentEdge["edge"] = sides[index]?.end === null ? "start" : "side_end";
  if (typeof target === "object") {
    const ref = "ref" in target ? target.ref : target.breakAfter;
    const found = sides.findIndex((p) => p.side === ref.side && near(p.start, ref.start));
    if (found >= 0) {
      index = "breakAfter" in target && sides[found + 1] ? found + 1 : found;
      edge = "breakAfter" in target && sides[found + 1] ? "start" : sides[index].end === null ? "start" : "side_end";
      if ("breakAfter" in target && !sides[found + 1] && !e.active && partsOf(e, now).at(-1)?.kind === "break") edge = "ended";
    }
  } else if (!e.active && partsOf(e, now).at(-1)?.kind === "break") edge = "ended";
  return { index, edge };
}

const edgeFor = (e: Entry, selection: Selection, now: Date): MomentEdge => selection.edge === "ended"
  ? { edge: "ended" }
  : { edge: selection.edge, ref: sidesOf(e, now)[selection.index]?.ref };

/** A correction can merge same-side stretches; follow the edited side, not its old array slot. */
function selectionAfter(draft: Draft, working: Entry, now: Date): Selection {
  const source = sidesOf(draft.before, now)[draft.selection.index];
  const sides = sidesOf(working, now);
  if (!source) return { ...draft.selection, index: Math.max(0, sides.length - 1) };
  const at = draft.selection.edge === "start" && draft.candidate ? draft.candidate.getTime() : Date.parse(source.start);
  const index = sides.findIndex((p) => p.side === source.side && Date.parse(p.start) <= at && (p.end === null || Date.parse(p.end) > at));
  return { ...draft.selection, index: index < 0 ? Math.min(draft.selection.index, sides.length - 1) : index };
}

/** A whole-feed draft. Only Save writes; switching parts keeps all valid corrections. */
export default function NursingCorrections({ start, live, target, open, onClose, tz, actionsContainer, onCommitting, onDirtyChange, onEditorActionsChange, onKnownEntry, onRecovery }: {
  start: Entry; live: Entry | null; target: FixTarget; open: boolean; onClose: () => void; tz: string;
  actionsContainer: HTMLElement | null; onCommitting: (value: boolean) => void; onDirtyChange: (value: boolean) => void;
  onEditorActionsChange: (value: boolean) => void; onKnownEntry: (entry: Entry) => void;
  onRecovery: (expand: FixExpand, side?: StretchSide) => void;
}) {
  const { state, now: nowFn, timerBusy, whoDiscarded, readOnly } = useMaple();
  const words = useBabyWords();
  const voice = useVoice();
  const now = useNow(1000);
  const actions = useTimerActions();
  const sheets = useSheets();
  const [draft, setDraft] = useState<Draft>(() => ({ original: start, before: start, edits: [], selection: initialSelection(start, target, nowFn()), candidate: null, revision: 0 }));
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedLatest, setFailedLatest] = useState<Entry | null>(null);
  const [gone, setGone] = useState(false);
  const [leaving, setLeaving] = useState<Destination | null>(null);
  const saveLock = useRef(false);
  const editorHost = useRef<HTMLDivElement>(null);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!leaving) return;
    keepEditingButton.current?.scrollIntoView({ block: "nearest" });
    keepEditingButton.current?.focus({ preventScroll: true });
  }, [leaving]);
  const edge = useMemo(() => edgeFor(draft.before, draft.selection, nowFn()), [draft.before, draft.selection, nowFn]);
  const correction = useMemo<FeedCorrection | null>(() => {
    if (!draft.candidate || draft.before.kind !== "feed") return null;
    const recorded = edgeBounds(draft.before.data, edge, feedCtx(draft.before, nowFn())).recorded;
    if (recorded.getTime() === draft.candidate.getTime()) return null;
    return { op: "move", ...edge, to: draft.candidate.toISOString() };
  }, [draft.before, draft.candidate, edge, nowFn]);
  const computed = useMemo(() => {
    try {
      return { entry: correction ? applyFeedCorrections(draft.before, [correction], nowFn()) : draft.before, error: null };
    } catch (error) {
      return { entry: draft.before, error: error instanceof FeedEditError ? feedEditCopy(error, "ui", tz, voice) : "That time cannot be saved. Choose another time." };
    }
  }, [correction, draft.before, nowFn, tz, voice]);
  const working = computed.entry;
  const selection = selectionAfter(draft, working, now);
  const edits = correction ? [...draft.edits, correction] : draft.edits;
  const dirty = invalid || !!computed.error || !same(draft.original, working);
  const latest = failedLatest && (!live || Date.parse(failedLatest.updated_at) > Date.parse(live.updated_at)) ? failedLatest : live;
  const changed = !!latest && latest.updated_at !== draft.original.updated_at;
  const flight = timerBusy(start.id) && !busy;
  const missing = open && !live && start.id > 0;
  const disabled = readOnly || busy || flight || gone || missing || changed;

  useLayoutEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onEditorActionsChange(!readOnly); }, [onEditorActionsChange, readOnly]);
  useEffect(() => { onCommitting(busy); }, [busy, onCommitting]);
  useEffect(() => {
    if (!changed || dirty || busy || !latest) return;
    setDraft((d) => ({ original: latest, before: latest, edits: [], candidate: null, selection: initialSelection(latest, target, nowFn()), revision: d.revision + 1 }));
  }, [changed, dirty, busy, latest, nowFn, target]);
  useEffect(() => {
    if (!missing) return;
    let active = true;
    void whoDiscarded(start.id).then((who) => {
      if (active) setNotice(who ? `${who} discarded this feed, so nothing can be saved.` : "This feed is no longer available, so nothing can be saved.");
    });
    return () => { active = false; };
  }, [missing, start.id, whoDiscarded]);
  useEffect(() => {
    if (live && gone && live.updated_at !== draft.original.updated_at) setGone(false);
  }, [live, gone, draft.original.updated_at]);

  const reset = (e: Entry) => {
    setDraft((d) => ({ original: e, before: e, edits: [], selection: initialSelection(e, target, nowFn()), candidate: null, revision: d.revision + 1 }));
    setInvalid(false);
    setNotice(null);
    setLeaving(null);
    setFailedLatest(null);
  };
  const choose = (nextSelection: Selection) => {
    if (disabled || invalid || computed.error) return;
    // Re-selecting the current moment must not make its preset baseline the
    // draft time (then tapping Likely again would be another correction).
    if (nextSelection.index === selection.index && nextSelection.edge === selection.edge) {
      const afterEdge = edgeFor(working, nextSelection, nowFn());
      const afterTime = working.kind === "feed" ? edgeBounds(working.data, afterEdge, feedCtx(working, nowFn())).recorded : null;
      // A merged side's visible start/end can now be a different moment.
      if (!draft.candidate || afterTime?.getTime() === draft.candidate.getTime()) return;
    }
    setDraft((d) => ({ ...d, before: working, edits, candidate: null, selection: nextSelection, revision: d.revision + 1 }));
    setNotice(null);
  };
  const changeSide = (side: StretchSide) => {
    if (disabled || invalid || computed.error) return;
    const part = sidesOf(working, nowFn())[selection.index];
    if (!part || part.side === side) return;
    const edit: FeedCorrection = { op: "set_side", ref: part.ref, side };
    try {
      const next = applyFeedCorrections(working, [edit], nowFn());
      const sides = sidesOf(next, nowFn());
      const index = sides.findIndex((s) => Date.parse(s.start) <= Date.parse(part.start) && (s.end === null || Date.parse(s.end) > Date.parse(part.start)));
      const selection = { index: Math.max(index, 0), edge: draft.selection.edge };
      if (selection.edge !== "start" && sides[selection.index]?.end === null) selection.edge = "start";
      setDraft((d) => ({ ...d, before: next, edits: [...edits, edit], candidate: null, selection, revision: d.revision + 1 }));
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof FeedEditError ? feedEditCopy(error, "ui", tz, voice) : "That side cannot be changed. Try again.");
    }
  };
  const failed = (failure: TimerFailure) => {
    if (failure.entry) { onKnownEntry(failure.entry); setFailedLatest(failure.entry); }
    if (failure.kind === "gone" || (failure.kind === "error" && /not found/i.test(failure.message))) {
      setGone(true);
      setNotice(`${failure.who ? `${failure.who} discarded this feed` : "This feed was discarded"}, so nothing was saved.`);
    } else if (failure.kind === "changed") {
      setNotice("This feed changed, so nothing was saved. Your changes are still here. Use the latest version to start again.");
    } else setNotice(failure.kind === "offline" ? "You're offline, so nothing was saved. Try again when you're back online." : failure.message);
  };
  const proceed = async (destination: Destination, e: Entry) => {
    setLeaving(null);
    if (destination.kind === "details") { onDirtyChange(false); sheets.open({ kind: e.kind, entry: e }); return; }
    if (destination.kind === "recovery") { onDirtyChange(false); onRecovery(destination.expand, destination.side); return; }
    setBusy(true);
    const response = destination.kind === "undo" ? await actions.undoTap(e, { onError: failed }) : await actions.sameFeed(e, destination.previous, destination.side, { onError: failed });
    setBusy(false);
    if (response) { onDirtyChange(false); onClose(); }
  };
  const navigate = (destination: Destination) => {
    if (dirty) setLeaving(destination);
    else void proceed(destination, latest ?? draft.original);
  };
  const save = async () => {
    if (saveLock.current || disabled || invalid || computed.error || !dirty || !edits.length) return;
    saveLock.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const response = await actions.retime(draft.original, { op: "batch", edits, expect_updated_at: draft.original.updated_at }, { onError: failed });
      if (response) {
        onKnownEntry(response.entry);
        onDirtyChange(false);
        if (leaving) { reset(response.entry); await proceed(leaving, response.entry); }
        else onClose();
      }
    } finally { saveLock.current = false; setBusy(false); }
  };
  const parts = partsOf(working, now);
  const sides = sidesOf(working, now);
  const selectedIndex = selection.index;
  const selected = sides[selectedIndex];
  const current = selected === sides.at(-1);
  const paused = working.active && parts.at(-1)?.kind === "break";
  const tap = current && working.active && working.kind === "feed" ? undoableTap(working.data, feedCtx(working, now)) : null;
  const undo = tap && Date.parse(tap.at) >= now.getTime() - 10 * 60_000 ? tap.what : null;
  const previous = current && working.active && !paused && sides.length === 1 ? previousFeed(state?.entries, working) : null;
  const join = previous?.ended_at && Date.parse(working.started_at) - Date.parse(previous.ended_at) <= CLUSTER_GAP_MS ? previous : null;
  const totals = partTotals(parts).min;
  const preview = describeChange(partsOf(draft.original, now), parts);
  const summary = [sides.some((p) => p.side === "L") ? `Left ${minutesText(totals.left)}` : "", sides.some((p) => p.side === "R") ? `Right ${minutesText(totals.right)}` : "", sides.some((p) => p.side === "B") ? `Both sides ${minutesText(totals.both)}` : "", parts.some((p) => p.kind === "break") ? `Break ${minutesText(totals.breaks)}` : ""].filter(Boolean).join(" · ");
  const earlierFeed = state?.entries.find((e) => e.kind === "feed" && e.id !== working.id && !e.active && e.ended_at && Date.parse(e.started_at) < Date.parse(draft.original.started_at));
  const overlaps = earlierFeed?.ended_at && Date.parse(working.started_at) < Date.parse(draft.original.started_at) && Date.parse(working.started_at) < Date.parse(earlierFeed.ended_at) - 1500;
  const footer = !readOnly && (
    <div className="space-y-3" data-nursing-correction-actions>
      <div aria-live="polite" data-nursing-correction-preview className="space-y-1 text-[13px] leading-snug text-mp-ink-2">
        <p className="font-medium text-mp-ink">{changed ? "This feed changed. Use latest above, or Cancel." : invalid ? "Enter a valid time before saving." : computed.error ?? (dirty && preview !== "No change" ? preview : dirty ? "Times updated" : "Choose any times or sides to correct.")}{overlaps ? ` · overlaps the ${formatTime(earlierFeed.started_at, tz)} feed` : ""}</p>
        <p>{summary} · Total nursing {minutesText(totals.nursing)}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="min-h-[48px] rounded-[14px] bg-mp-sunken px-5 text-[15px] font-semibold text-mp-ink disabled:opacity-45">Cancel</button>
        <button type="button" onClick={() => void save()} disabled={disabled || invalid || !!computed.error || !dirty} className="inline-flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-[14px] bg-mp-accent px-5 text-[15px] font-semibold text-mp-on-accent disabled:opacity-45">{busy ? <><Spinner />Saving…</> : "Save"}</button>
      </div>
    </div>
  );

  return <>
    {changed && dirty && <div role="status" className="space-y-2 rounded-xl bg-mp-sunken p-3 text-[13px] text-mp-ink"><p>This feed changed on another device. Your unsaved changes are still shown. Use the latest version to start again, or cancel.</p><button type="button" disabled={busy} onClick={() => latest && reset(latest)} className="min-h-[44px] rounded-xl bg-mp-surface px-3 font-semibold text-mp-accent-fg">Use latest</button></div>}
    {notice && <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] text-mp-ink">{notice}</p>}
    <div className="flex flex-wrap gap-2" role="group" aria-label="Which part">
      {sides.map((part, index) => <button key={`${part.start}-${index}`} type="button" disabled={disabled || invalid || !!computed.error} aria-pressed={index === selectedIndex && draft.selection.edge !== "ended"} aria-label={`${SIDE_NAME[part.side]} part, ${formatRange(part.start, part.end, tz)}`} onClick={() => choose({ index, edge: part.end === null ? "start" : "side_end" })} className={cx("inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-[14px] font-medium tabular-nums disabled:opacity-45", index === selectedIndex && draft.selection.edge !== "ended" ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink")}><SideMark side={part.side} size={20} />{formatRange(part.start, part.end, tz, { compact: true })}</button>)}
      {parts.filter((p) => p.kind === "break").map((part) => {
        const before = sides.findIndex((s) => s.side === part.before.side && near(s.start, part.before.start));
        const after = part.end ? sides.findIndex((s) => s.start === part.end) : -1;
        return <button key={`break-${part.start}`} type="button" disabled={disabled || invalid || !!computed.error} aria-label={`Break, ${formatRange(part.start, part.end, tz)}`} onClick={() => choose({ index: after >= 0 ? after : before, edge: after >= 0 ? "start" : "side_end" })} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-mp-sunken px-3 text-[14px] font-medium text-mp-ink disabled:opacity-45"><BreakMark size={20} />Break · {formatRange(part.start, part.end, tz, { compact: true })}</button>;
      })}
      {!working.active && working.ended_at && <button type="button" disabled={disabled || invalid || !!computed.error} onClick={() => choose({ index: sides.length - 1, edge: parts.at(-1)?.kind === "break" ? "ended" : "side_end" })} className="min-h-[44px] rounded-full bg-mp-sunken px-3 text-[14px] font-medium text-mp-ink disabled:opacity-45">Ended {formatTime(working.ended_at, tz)}</button>}
    </div>
    {invalid && <p role="status" className="text-[13px] text-mp-ink-2">Enter a valid time before choosing another part or side.</p>}
    {selected && <div role="group" aria-label="Which time to edit" className="flex flex-wrap gap-2">
      {[{ edge: "start" as const, label: `Started ${SIDE_NAME[selected.side]}`, at: selected.start }, ...(selected.end ? [{ edge: "side_end" as const, label: `Ended ${SIDE_NAME[selected.side]}`, at: selected.end }] : [])].map((choice) => <button key={choice.edge} type="button" disabled={disabled || invalid || !!computed.error} aria-pressed={draft.selection.edge === choice.edge} onClick={() => choose({ index: selectedIndex, edge: choice.edge })} className="min-h-[44px] rounded-xl border border-mp-line bg-mp-surface px-3 py-2 text-[14px] font-medium text-mp-ink aria-pressed:border-mp-accent-fg aria-pressed:text-mp-accent-fg disabled:opacity-45">{choice.label} · {formatTime(choice.at, tz)}</button>)}
    </div>}
    {leaving && <div role="alertdialog" aria-label="Unsaved nursing changes" className="space-y-2 rounded-xl border border-mp-line bg-mp-sunken p-3"><p className="text-[15px] font-medium text-mp-ink">Save your changes below, or discard them to continue.</p><div className="flex gap-2"><button ref={keepEditingButton} type="button" onClick={() => { setLeaving(null); window.requestAnimationFrame(() => editorHost.current?.querySelector<HTMLElement>('input[type="time"], button')?.focus()); }} className="min-h-[44px] rounded-xl bg-mp-surface px-3 text-[14px] font-semibold text-mp-ink">Keep editing</button><button type="button" disabled={busy} onClick={() => { const destination = leaving; reset(latest ?? draft.original); void proceed(destination, latest ?? draft.original); }} className="min-h-[44px] rounded-xl bg-mp-surface px-3 text-[14px] font-semibold text-mp-ink">Discard changes</button></div></div>}
    <div ref={editorHost}><MomentEditor key={draft.revision} entry={draft.before} edge={edge} tz={tz} mode="staged" draft={draft.candidate ?? undefined} hidePreview onDraft={(candidate) => setDraft((d) => ({ ...d, candidate }))} onInvalidChange={setInvalid} disabled={disabled || !!leaving} /></div>
    {selected && <div className="space-y-3 border-t border-mp-line pt-3">
      <SideFixRow side={selected.side} disabled={disabled || invalid || !!computed.error || !!leaving} onPick={changeSide} />
      {current && working.active && !paused && <LinkRow disabled={disabled} onClick={() => navigate({ kind: "recovery", expand: "finished" })}>{words.He} already finished</LinkRow>}
      {current && paused && <div className="space-y-2"><p className="text-[15px] font-medium text-mp-ink">Already back on?</p><div role="group" aria-label={`Which side is ${words.he} on`} className="flex gap-2">{(["L", "R", ...(selected.side === "B" ? ["B"] : [])] as StretchSide[]).map((side) => <button key={side} type="button" disabled={disabled} onClick={() => navigate({ kind: "recovery", expand: "backOn", side })} className="min-h-[44px] flex-1 rounded-xl bg-mp-sunken px-3 text-[14px] font-semibold text-mp-ink disabled:opacity-45">{SIDE_NAME[side]}</button>)}</div></div>}
      {join && <LinkRow disabled={disabled} onClick={() => navigate({ kind: "join", previous: join, side: selected.side })}>Same feed as {formatTime(join.started_at, tz)}? Join them</LinkRow>}
      {undo && <LinkRow disabled={disabled} onClick={() => navigate({ kind: "undo" })}>Tapped {undo === "switch" ? "Switch" : undo === "pause" ? "Pause" : "Resume"} by mistake? Undo {undo}</LinkRow>}
    </div>}
    {!working.active && <LinkRow disabled={disabled} onClick={() => navigate({ kind: "details" })}>Edit feed details or add a side</LinkRow>}
    {footer && (actionsContainer ? createPortal(footer, actionsContainer) : footer)}
  </>;
}

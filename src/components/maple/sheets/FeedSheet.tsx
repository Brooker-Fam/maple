"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { addPart, feedCtx, FeedEditError, feedEditCopy, feedParts, feedTotals, moveEdge, other, partTotals, setSide, type Part } from "@/lib/maple/feed";
import { BOTTLE_CUES, typicalBottle } from "@/lib/maple/guidelines";
import { formatMinutes, formatTime } from "@/lib/maple/time";
import { formatVolume, mlToOz, ozToMl } from "@/lib/maple/units";
import type { Entry, EntryOf, FeedData, Side, UpdateEntryInput } from "@/lib/maple/types";
import { LinkRow, MomentEditor, PartRows, SIDE_NAME, type MomentEdge } from "../FeedParts";
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
 * Nursing logged afterwards (or a finished feed that was never timed): Left
 * and Right minutes, which side she started on, and when it started and
 * ended. Typing the minutes for a new one slides the start back from the end,
 * so "15 left, 10 right, just finished" needs no time fiddling.
 *
 * A finished timed feed shows its times as what happened: a row per side and
 * break, "Ended", and "Add a side she nursed on". A row opens its moments
 * ("Switched to Right 4:15 PM"), and each moment opens an editor that stages
 * one move through the same engine as Fix times, so nothing else moves. The
 * sheet's Save sends the staged parts in one PATCH made against the version
 * they were staged on; if the other phone changed the feed first, nothing is
 * overwritten. "Type minutes instead" keeps the old way: typed minutes
 * replace the timed parts.
 *
 * Bottle: the amount (oz or ml, per the units setting) starts at the last
 * bottle's amount and milk, so the primary button reads "Log 2 oz now".
 */

type Milk = NonNullable<FeedData["milk"]>;
const MILK_LABEL: Record<Milk, string> = { breastmilk: "Breast milk", formula: "Formula", mixed: "Mixed" };
const MIN = 60_000;
const ELSEWHERE = "on another device or through Claude";

type FeedEntry = EntryOf<"feed">;
type SidePart = Extract<Part, { kind: "side" }>;
/** A staged change to a finished feed's times. */
type Staged = { data: FeedData; startedAt: string; endedAt: string | null };
/** …and the updated_at of the version it was made on (Save expects it). */
type Draft = Staged & { base: string };

const isSide = (p: Part): p is SidePart => p.kind === "side";
const partsOf = (f: FeedEntry, now: Date) => feedParts(f.data, feedCtx(f, now));

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
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);
  const fromPreset = presetStart(preset);
  const checks = useNumberChecks();
  const { touched, touch } = useTouched();

  // ── Nursing ──
  const totals = e && e.data.method === "breast" ? feedTotals(e.data, now()) : null;
  const origL = totals ? Math.round(totals.left / 60) : null;
  const origR = totals ? Math.round(totals.right / 60) : null;
  const origFirst: Side | undefined = e?.data.first_side ?? e?.data.segments?.[0]?.side;
  const [left, setLeft] = useState<number | null>(origL ?? 0);
  const [right, setRight] = useState<number | null>(origR ?? 0);
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
  // Read live by id, so a change from the other phone shows here and a staged change can't overwrite it.
  const liveFeed = timed && e ? (state?.entries.find((x): x is FeedEntry => x.id === e.id && x.kind === "feed") ?? e) : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  // Bumped to start the Times section over (closes its rows and editors).
  const [epoch, setEpoch] = useState(0);
  const [timesNotice, setTimesNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const dirty = !!liveFeed && !!draft && timesKey(draft.data, draft.endedAt, now()) !== timesKey(liveFeed.data, liveFeed.ended_at, now());
  // The staged feed carries the version it was made on, so a change staged on top of it keeps that base.
  const working: FeedEntry | null =
    liveFeed && draft && dirty ? { ...liveFeed, data: draft.data, started_at: draft.startedAt, ended_at: draft.endedAt, updated_at: draft.base } : liveFeed;
  const conflict = dirty && !!liveFeed && !!draft && liveFeed.updated_at !== draft.base;
  const workingTotals = working ? partTotals(partsOf(working, now())) : null;

  const discardTimes = () => {
    setDraft(null);
    setEpoch((x) => x + 1);
  };
  /** One staged change from the Times section; typed minutes give way to it (last one wins). */
  const stage = (next: Staged, builtOn: FeedEntry) => {
    setDraft({ ...next, base: builtOn.updated_at });
    setTimesNotice(null);
    if (minutesTyped || first !== origFirst) {
      setMinutesTyped(false);
      setLeft(origL ?? 0);
      setRight(origR ?? 0);
      if (origFirst) setFirst(origFirst);
      setRange(origRange());
    }
  };

  // Until minutes are typed, they follow the parts (staged ones included).
  const shownL = timed && !minutesTyped && workingTotals ? Math.round(workingTotals.left / 60) : left;
  const shownR = timed && !minutesTyped && workingTotals ? Math.round(workingTotals.right / 60) : right;
  const shownFirst = dirty && working?.data.first_side ? working.data.first_side : first;
  const typeMinutes = (l: number | null, r: number | null) => {
    setMinutesTyped(true);
    setMinutes(l, r);
    // Saving minutes replaces the parts, so a staged change to them goes.
    if (draft) discardTimes();
  };
  const pickFirst = (s: Side) => {
    setFirst(s);
    if (draft) discardTimes();
  };

  const setMinutes = (l: number | null, r: number | null) => {
    setLeft(l);
    setRight(r);
    if (!anchor) return;
    const total = ((l ?? 0) + (r ?? 0)) * MIN;
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
    guarded.current = dirty && !readOnly;
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
      setBusy(true);
      const res = await update(e.id, editPatch(), { toast: `${method === "bottle" ? "Bottle" : "Feed"} updated` });
      setBusy(false);
      if (res) onClose();
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
    const l = left ?? 0;
    const r = right ?? 0;
    const sides = sideFields(l, r, first);
    const [s, en] = range;
    const next = other(sides.first_side);
    void log(
      {
        kind: "feed",
        started_at: s.toISOString(),
        ended_at: en.getTime() > s.getTime() ? en.toISOString() : undefined,
        data: { method: "breast", left_sec: l * 60, right_sec: r * 60, ...sides },
        note: note.trim() || null,
      },
      {
        toast:
          l + r > 0
            ? `Nursed ${l + r}m (L ${l} · R ${r}) · ${next === "L" ? "Left" : "Right"} next`
            : `Nursed · ${clock(s)} · ${next === "L" ? "Left" : "Right"} next`,
      }
    );
  };

  const editPatch = () => {
    if (!e) return {};
    const noteVal = note.trim() || null;
    if (running) return { note: noteVal };
    if (method === "bottle") {
      // Only what was changed: the amount shows rounded (¼ oz / 5 ml), so re-sending it would drift.
      const data: Record<string, unknown> = {};
      if (touched.amount) data.amount_ml = amountMl ?? null;
      if (touched.milk) data.milk = milk ?? null;
      return {
        data: Object.keys(data).length ? data : undefined,
        started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
        note: noteVal,
      };
    }
    const [s, en] = range;
    const startMoved = s.getTime() !== Date.parse(e.started_at);
    const endMoved = en.getTime() !== (e.ended_at ? Date.parse(e.ended_at) : s.getTime());
    // Typed minutes win whenever a time moved too (else the server would retime the segments instead).
    const minutesChanged = left !== origL || right !== origR || (timed && minutesTyped && (startMoved || endMoved));
    const data: Record<string, unknown> = {};
    if (minutesChanged) {
      // New side minutes replace the timer's segments (the server drops them).
      Object.assign(data, { left_sec: (left ?? 0) * 60, right_sec: (right ?? 0) * 60, ...sideFields(left ?? 0, right ?? 0, first) });
    } else if (first !== origFirst) {
      data.first_side = first;
    }
    return {
      started_at: startMoved ? s.toISOString() : undefined,
      // Keep the end where it shows (otherwise new minutes would move it).
      // A timed session keeps an end even at its start, so the server retimes what the sheet previewed.
      ended_at: endMoved || minutesChanged ? (en.getTime() > s.getTime() || (timed && !minutesChanged) ? en.toISOString() : null) : undefined,
      data: Object.keys(data).length ? data : undefined,
      note: noteVal,
    };
  };

  /** The staged parts, in one PATCH against the version they were staged on (a newer one answers 409). */
  const saveTimes = async () => {
    if (!e || !draft || !liveFeed) return;
    setBusy(true);
    setTimesNotice(null);
    const data: Record<string, unknown> = { segments: draft.data.segments };
    // PATCH merges data: a flag the engine dropped (the end moved off the pause, a side added after it) has to be cleared by name.
    if (liveFeed.data.paused_at_stop && !draft.data.paused_at_stop) data.paused_at_stop = null;
    const patch: UpdateEntryInput = { data, started_at: draft.startedAt, ended_at: draft.endedAt, expect_updated_at: draft.base, note: note.trim() || null };
    try {
      await api(`entries?id=${e.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      // Into state before the sheet goes, so Recent and the timeline show the new times at once.
      await refresh();
      toast("Feed updated");
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const who = memberLabel((err.body as { entry?: Entry } | null)?.entry?.updated_by);
        discardTimes();
        setTimesNotice(who ? `${who} changed this feed; your change wasn't saved. Make it again.` : `This feed changed ${ELSEWHERE}; your change wasn't saved. Make it again.`);
        // Make it again on the times the server has now.
        await refresh();
      } else if (err instanceof ApiError) {
        setTimesNotice(err.status === 404 ? "This feed was deleted, so nothing was saved." : err.message);
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

  const title = e ? (running ? "Nursing now" : describeEntry(e).title) : "Feed";
  const primary = e ? "Save" : method === "bottle" ? (amountLabel ? `Log ${amountLabel}${when ? "" : " now"}` : "Log bottle") : "Log it";
  const changedBy = liveFeed ? memberLabel(liveFeed.updated_by) : null;

  const steppers = (
    <div className="grid grid-cols-2 gap-3">
      <MiniStepper key="left" label={<SideLabel side="L" />} unit="min" ariaLabel="minutes on the left" value={shownL} onChange={(v) => typeMinutes(v, shownR)} max={240} onInvalid={checks.watch("left")} />
      <MiniStepper key="right" label={<SideLabel side="R" />} unit="min" ariaLabel="minutes on the right" value={shownR} onChange={(v) => typeMinutes(shownL, v)} max={240} onInvalid={checks.watch("right")} />
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
              <p role="status" className="mb-3 flex items-center gap-2 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] font-medium text-mp-ink">
                <Icon name="pencil" size={14} className="shrink-0 text-mp-ink-2" />
                Unsaved change to the times
              </p>
            )}
            <SheetFooter
              onClose={close}
              onDelete={e ? del : undefined}
              onPrimary={() => void (dirty ? saveTimes() : save())}
              label={primary}
              busy={busy}
              disabled={(!!e && e.id < 0) || (!running && checks.invalid) || conflict}
              hint={
                !running && checks.invalid
                  ? CHECK_NUMBER_HINT
                  : conflict
                    ? "Start over to make your change on the new times."
                    : e && e.id < 0
                      ? "Still syncing, so it can't be edited yet."
                      : undefined
              }
            />
          </>
        )
      }
    >
      {e && <LoggedBy entry={e} />}

      {running ? (
        <RunningNote kind="feed" />
      ) : (
        <>
          {!e && (
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
                  {conflict && (
                    <div role="status" className="flex min-h-[44px] items-center gap-3 rounded-xl bg-mp-sunken px-3 py-2 text-[13px] leading-snug text-mp-ink-2">
                      <span className="min-w-0 flex-1">{changedBy ? `Changed on ${changedBy}'s phone.` : `Changed ${ELSEWHERE}.`}</span>
                      <button
                        type="button"
                        onClick={() => {
                          discardTimes();
                          setTimesNotice(null);
                        }}
                        className="-my-1 min-h-[44px] shrink-0 rounded-lg px-2 text-[13px] font-semibold text-mp-accent-fg"
                      >
                        Start over
                      </button>
                    </div>
                  )}
                  {timesNotice && (
                    <p role="alert" className="rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
                      {timesNotice}
                    </p>
                  )}
                  <TimesSection key={epoch} live={liveFeed} working={working} dirty={dirty} tz={tz} readOnly={readOnly} disabled={busy} who={changedBy} onStage={stage} />
                  {!readOnly && (
                    <MoreDetails label="Type minutes instead" summary={minutesTyped ? `L ${left ?? 0} · R ${right ?? 0} min` : undefined}>
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

/** first/last side from the minutes: one side used → that side; both → the chosen start, then the other. */
function sideFields(l: number, r: number, chosen: Side): { first_side: Side; last_side?: Side } {
  if (l > 0 && r > 0) return { first_side: chosen, last_side: other(chosen) };
  if (l > 0) return { first_side: "L", last_side: "L" };
  if (r > 0) return { first_side: "R", last_side: "R" };
  return { first_side: chosen };
}

// ── Times: a finished timed feed, part by part ──────────────────────────

/** Which row is open: a part (by its place, and side), the Ended row, or Add a side. */
type Row = { kind: "side"; index: number; side: Side } | { kind: "break"; index: number } | { kind: "ended" } | { kind: "add" };
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

/** "30 min nursing · Left 15 · Right 15 · started on Left · 11 min break not counted" */
function summaryOf(parts: Part[]): string {
  const t = partTotals(parts);
  const sides = parts.filter(isSide);
  const has = (s: Side) => sides.some((p) => p.side === s);
  const bits = [`${formatMinutes(t.nursing)} nursing`];
  if (has("L")) bits.push(`Left ${Math.round(t.left / 60)}`);
  if (has("R")) bits.push(`Right ${Math.round(t.right / 60)}`);
  if (sides[0]) bits.push(`started on ${SIDE_NAME[sides[0].side]}`);
  if (t.breakCount) bits.push(`${formatMinutes(t.breaks)} ${t.breakCount > 1 ? "of breaks" : "break"} not counted`);
  return bits.join(" · ");
}

/**
 * The Times section of a finished timed feed: every part as a row (no
 * folding), then "Ended 4:30 PM" and "Add a side she nursed on". A side row
 * opens its two moments and "Wrong side?"; a break row opens "Came off" and
 * "Back on"; Ended opens its editor directly. One editor is open at a time,
 * and each nudge stages the moved feed at once (onStage). Nothing here saves.
 *
 * While an editor is open the rows show the feed as it was when the editor
 * opened (the editor's own preview says what the change does), so a break the
 * edit closes can't pull the row, and the editor, out from under the thumb.
 * The summary line always shows the staged result.
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
}) {
  const { now: nowFn } = useMaple();
  const [row, setRow] = useState<Row | null>(null);
  const [editor, setEditor] = useState<StagedEditor | null>(null);
  const [error, setError] = useState<string | null>(null);

  // With nothing staged, a change from the other phone replaces the editor's feed (and the editor says who moved it).
  const fresh = !!editor && !dirty && editor.base.updated_at !== live.updated_at;
  const base = editor && !fresh ? editor.base : working;
  const now = nowFn();
  const staged = partsOf(working, now);
  const parts = base === working ? staged : partsOf(base, now);
  const sides = parts.filter(isSide);
  const last = sides.at(-1);
  const openIndex = rowIndex(row, parts);
  const clock = (t: string) => formatTime(t, tz);

  const collapse = () => {
    setEditor(null);
    setError(null);
  };
  // Taps act on the staged feed, which the rows don't show yet while an editor is open:
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
    setRow(rowOf(found.p, found.i));
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
  const flip = () => {
    const found = openInStaged();
    collapse();
    if (!found || found.p.kind !== "side") return;
    const side = other(found.p.side);
    try {
      const r = setSide(working.data, found.p.ref, side, feedCtx(working, nowFn()));
      onStage({ data: r.data, startedAt: r.startedAt, endedAt: working.ended_at }, working);
      setRow({ kind: "side", index: found.i, side });
    } catch (err) {
      setError(err instanceof FeedEditError ? feedEditCopy(err, "ui", tz) : "That part changed; have another look.");
    }
  };
  const pickRow = (p: Part, i: number) => {
    collapse();
    setRow(openIndex === i ? null : rowOf(p, i));
  };
  const pickEnded = () => {
    if (row?.kind === "ended") {
      collapse();
      setRow(null);
      return;
    }
    const lastStaged = staged.filter(isSide).at(-1);
    if (!lastStaged) return;
    setError(null);
    setRow({ kind: "ended" });
    // A legacy trailing break: Ended moves ended_at alone (the last side's end is then the pause).
    const legacy = staged.some((p) => p.kind === "break" && p.legacy);
    setEditor({ id: "ended-row", edge: legacy ? { edge: "ended" } : { edge: "end", ref: lastStaged.ref }, base: working });
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

  const renderOpen = (p: Part, i: number) => {
    if (p.kind === "side") {
      const name = SIDE_NAME[p.side];
      const next = parts.slice(i + 1).find(isSide);
      const startLabel = p.startMoment === "feed_start" ? "Feed started" : p.startMoment === "switch" ? `Switched to ${name}` : `Back on the ${name}`;
      const endLabel = p.endMoment === "switch" && next ? `Switched to ${SIDE_NAME[next.side]}` : p.endMoment === "feed_end" ? "Feed ended" : "Came off";
      return (
        <Detail>
          {line("start", `${startLabel} ${clock(p.start)}`)}
          {p.end && line("end", `${endLabel} ${clock(p.end)}`)}
          <QuestionRow question="Wrong side?" label={`It was ${SIDE_NAME[other(p.side)]}`} disabled={disabled} onClick={flip} />
        </Detail>
      );
    }
    return (
      <Detail>
        {line("off", `Came off ${SIDE_NAME[p.before.side]} ${clock(p.start)}`)}
        {p.after && p.end ? line("on", `Back on the ${SIDE_NAME[p.after.side]} ${clock(p.end)}`) : p.end && line("legacy-end", `Feed ended ${clock(p.end)}`)}
      </Detail>
    );
  };

  const endedAt = base.ended_at ?? last?.end ?? null;
  return (
    <div>
      <Label>Times</Label>
      <p className="mb-1 text-[15px] leading-snug font-medium text-mp-ink">{summaryOf(staged)}</p>
      {error && (
        <p role="alert" className="my-2 rounded-xl border border-mp-danger/30 px-3 py-2.5 text-[13px] leading-snug text-mp-ink">
          {error}
        </p>
      )}
      <PartRows parts={parts} mode="staged" tz={tz} readOnly={readOnly} disabled={disabled} onPick={pickRow} openIndex={openIndex} renderOpen={renderOpen} />
      {endedAt && (
        <ExtraRow
          mark={
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
              <Icon name="check" size={13} strokeWidth={2.4} />
            </span>
          }
          name="Ended"
          value={clock(endedAt)}
          open={row?.kind === "ended"}
          onClick={pickEnded}
          disabled={disabled}
          readOnly={readOnly}
          ariaLabel={`Ended at ${clock(endedAt)}. Fix when the feed ended.`}
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
          open={row?.kind === "add"}
          onClick={() => {
            collapse();
            setRow(row?.kind === "add" ? null : { kind: "add" });
          }}
          disabled={disabled}
        />
      )}
      {row?.kind === "add" && (
        <AddSide
          feed={working}
          tz={tz}
          disabled={disabled}
          onAdd={(next) => {
            onStage(next, working);
            setRow(null);
          }}
        />
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

/** "Ended 4:30 PM ›" and "Add a side she nursed on ›": rows on the part rows' grid (mark, name, time, chevron). */
function ExtraRow({
  mark,
  name,
  value,
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
        {value && <span className="min-w-0 text-[14px] text-mp-ink-2 tabular-nums">{value}</span>}
      </span>
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

/** "Wrong side? [It was Right]": a question and one button. */
function QuestionRow({ question, label, onClick, disabled }: { question: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <div className="flex min-h-[48px] items-center gap-3">
      <span className="min-w-0 flex-1 text-[15px] text-mp-ink">{question}</span>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="min-h-[44px] shrink-0 rounded-xl bg-mp-sunken px-3.5 text-[14px] font-semibold text-mp-ink disabled:opacity-45"
      >
        {label}
      </button>
    </div>
  );
}

/**
 * "Add a side she nursed on": which side, when it started (from the feed's
 * end) and ended (5 minutes on, until moved), checked against the parts as
 * it's set ("That overlaps Left 4:00–4:10."). Adding stages it.
 */
function AddSide({ feed, tz, disabled, onAdd }: { feed: FeedEntry; tz: string; disabled: boolean; onAdd: (next: Staged) => void }) {
  const { now: nowFn } = useMaple();
  const sides = partsOf(feed, nowFn()).filter(isSide);
  const lastSide = sides.at(-1);
  const [side, pickSide] = useState<Side>(() => other(lastSide?.side ?? "L"));
  const [start, setStart] = useState(() => new Date(feed.ended_at ?? lastSide?.end ?? feed.started_at));
  // null: five minutes after Started, following it until Ended is moved by hand.
  const [end, setEnd] = useState<Date | null>(null);
  // The note goes under the time last moved, where the thumb is.
  const [moved, setMoved] = useState<"start" | "end">("start");
  const n = nowFn();
  const endShown = end ?? new Date(Math.min(start.getTime() + 5 * MIN, n.getTime()));

  let error: string | null = null;
  let result: Staged | null = null;
  if (endShown.getTime() < start.getTime() + 1000) error = "Ended must be after Started.";
  else {
    try {
      const r = addPart(feed.data, { side, start, end: endShown }, feedCtx(feed, n));
      result = { data: r.data, startedAt: r.startedAt, endedAt: r.endedAt };
    } catch (err) {
      error = err instanceof FeedEditError ? feedEditCopy(err, "ui", tz) : err instanceof Error ? err.message : "That side doesn't fit this feed.";
    }
  }

  const note = error && (
    <p aria-live="polite" className="text-[13px] leading-snug text-mp-ink-2">
      {error}
    </p>
  );

  return (
    <Detail>
      <div className="space-y-3 pt-1 pb-3">
        <Segmented<Side>
          value={side}
          onChange={pickSide}
          aria-label="Which side"
          options={[
            { value: "L", label: <SideLabel side="L" /> },
            { value: "R", label: <SideLabel side="R" /> },
          ]}
          className="[&>button]:min-h-[44px]"
        />
        <TimeScrubber
          label="Started"
          value={start}
          onChange={(d) => {
            setMoved("start");
            setStart(d);
          }}
          tz={tz}
          quick={false}
          nudgeStyle="words"
          max={n}
        />
        {moved === "start" && note}
        <TimeScrubber
          label="Ended"
          value={endShown}
          onChange={(d) => {
            setMoved("end");
            setEnd(d);
          }}
          tz={tz}
          quick={false}
          nudgeStyle="words"
          max={n}
        />
        {moved === "end" && note}
        <Button className="w-full" disabled={disabled || !result} onClick={() => result && onAdd(result)}>
          Add to the feed
        </Button>
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

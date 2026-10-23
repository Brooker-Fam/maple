"use client";

import { useMemo, useState } from "react";
import { describeEntry, entryEmoji } from "@/lib/maple/describe";
import { feedTotals, other, retimeBreast } from "@/lib/maple/feed";
import { BOTTLE_CUES, typicalBottle } from "@/lib/maple/guidelines";
import { formatVolume, mlToOz, ozToMl } from "@/lib/maple/units";
import type { EntryOf, FeedData, Side } from "@/lib/maple/types";
import { Chip, Segmented, Sheet, TimeRange, WhenField, cx, tone } from "../ui";
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
 * Nursing (logged afterwards, or a finished timer): Left and Right minutes,
 * which side she started on, and when it started and ended. Typing the
 * minutes for a new one slides the start back from the end, so "15 left, 10
 * right, just finished" needs no time fiddling. On a timed session, moving the
 * start grows or shrinks the first side and moving the end the last side
 * ("she'd started five minutes before I tapped"); typing the minutes instead
 * replaces its segments with the two totals (there's no segment editor).
 *
 * Bottle: the amount (oz or ml, per the units setting) starts at the last
 * bottle's amount and milk, so the primary button reads "Log 2 oz now".
 */

type Milk = NonNullable<FeedData["milk"]>;
const MILK_LABEL: Record<Milk, string> = { breastmilk: "Breast milk", formula: "Formula", mixed: "Mixed" };
const MIN = 60_000;

export default function FeedSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <FeedForm key={n} {...props} />;
}

function FeedForm({ open, onClose, entry, preset }: SheetProps) {
  const base = useSheetBase();
  const { tz, units, state, summary, log, update, remove, clock, now, ageDays, age } = base;
  const e = entry?.kind === "feed" ? entry : undefined;
  const running = !!e?.active;

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
  const [range, setRange] = useState<[Date, Date]>(() => {
    if (e) {
      const s = new Date(e.started_at);
      return [s, e.ended_at ? new Date(e.ended_at) : s];
    }
    const s = fromPreset ?? now();
    return [s, s];
  });
  // New entries: minutes slide the start back from the end (or the end on from a preset start)
  // until someone moves a time by hand. A saved feed whose span is exactly its minutes keeps
  // its end in step with them.
  const [anchor, setAnchor] = useState<"end" | "start" | null>(() => {
    if (!e) return fromPreset ? "start" : "end";
    const span = e.ended_at ? Date.parse(e.ended_at) - Date.parse(e.started_at) : 0;
    return totals && Math.abs(span - totals.total * 1000) < MIN ? "start" : null;
  });

  // A timed session keeps its sides: until the minutes are typed, they follow
  // the start and end (the server moves the first and last side the same way).
  const timed = !!e && !running && e.data.method === "breast" && !!e.data.segments?.length;
  const [minutesTyped, setMinutesTyped] = useState(false);
  const retimed = (() => {
    if (!e || !timed || minutesTyped || e.data.method !== "breast") return null;
    const [s, en] = range;
    const startMoved = s.getTime() !== Date.parse(e.started_at);
    const endMoved = !!e.ended_at && en.getTime() !== Date.parse(e.ended_at);
    if (!startMoved && !endMoved) return null;
    try {
      const data = retimeBreast(e.data, {
        start: startMoved ? s : undefined,
        end: endMoved ? en : undefined,
        prevEnd: e.ended_at ? new Date(e.ended_at) : null,
      });
      const t = feedTotals(data, now());
      return { l: Math.round(t.left / 60), r: Math.round(t.right / 60), error: null };
    } catch (err) {
      return { l: origL ?? 0, r: origR ?? 0, error: err instanceof Error ? err.message : "Those times don't fit this feed" };
    }
  })();
  const shownL = retimed ? retimed.l : left;
  const shownR = retimed ? retimed.r : right;
  const typeMinutes = (l: number | null, r: number | null) => {
    setMinutesTyped(true);
    setMinutes(l, r);
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
        { toast: `${amountLabel ? `${amountLabel} bottle` : "Bottle"} · ${clock(at)}`, emoji: "🍼" }
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
        emoji: "🤱",
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

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: `${describeEntry(e).title} deleted` });
  };

  const title = e ? (running ? "Nursing now" : describeEntry(e).title) : "Feed";
  const emoji = e ? entryEmoji(e) : method === "bottle" ? "🍼" : "🤱";
  const primary = e ? "Save" : method === "bottle" ? (amountLabel ? `Log ${amountLabel}${when ? "" : " now"}` : "Log bottle") : "Log it";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      emoji={emoji}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={primary}
          busy={busy}
          disabled={(!!e && e.id < 0) || (!running && checks.invalid) || !!retimed?.error}
          hint={
            !running && checks.invalid
              ? CHECK_NUMBER_HINT
              : retimed?.error
                ? `${retimed.error}. Change the minutes instead.`
                : e && e.id < 0
                  ? "Still syncing, so it can't be edited yet."
                  : undefined
          }
        />
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
            <>
              <div className="grid grid-cols-2 gap-3">
                <MiniStepper key="left" label="Left" unit="min" ariaLabel="minutes on the left" value={shownL} onChange={(v) => typeMinutes(v, shownR)} max={240} onInvalid={checks.watch("left")} />
                <MiniStepper key="right" label="Right" unit="min" ariaLabel="minutes on the right" value={shownR} onChange={(v) => typeMinutes(shownL, v)} max={240} onInvalid={checks.watch("right")} />
              </div>
              {timed && !minutesTyped && (
                <p className={cx(tone.muted, "-mt-1 px-1 text-xs leading-snug")}>
                  Started earlier or ended sooner? Move the times below and the first or last side follows.
                </p>
              )}
              <div>
                <Label>Started on</Label>
                <Segmented<Side>
                  value={first}
                  onChange={setFirst}
                  options={[
                    { value: "L", label: "Left" },
                    { value: "R", label: "Right" },
                  ]}
                />
              </div>
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
              <ContextNote emoji="🍼">
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

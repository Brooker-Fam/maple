"use client";

import { useEffect, useState } from "react";
import { loggedBy, unitCount } from "@/lib/maple/care";
import { DEFAULT_TZ, addDays, dayKey, daysBetween, formatTime, isDayKey } from "@/lib/maple/time";
import type { CareEntry, CarePlan } from "@/lib/maple/types";
import { formatTemp } from "@/lib/maple/units";
import { useOpenCount } from "../sheets/parts";
import { Button, Segmented, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP } from "./parts";
import type { UseCare } from "./useCare";

type Kind = "dose" | "temp" | "all";
type Props = { open: boolean; onClose: () => void; care: UseCare; plan?: CarePlan; kind?: Kind };
type Period = { from: string; to: string; kind: Kind };
type HistoryEntry = Extract<CareEntry, { kind: "dose" | "temp" }>;
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const historyDate = (key: string) => dateFormat.format(new Date(`${key}T12:00:00Z`));

export default function CareHistorySheet(props: Props) {
  const n = useOpenCount(props.open);
  return <History key={`${n}-${props.plan?.id ?? props.kind ?? "all"}`} {...props} />;
}

function History({ open, onClose, care, plan, kind = "all" }: Props) {
  const { state, now, api, units } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const today = dayKey(now(), tz);
  const [period, setPeriod] = useState<Period>({ from: addDays(today, -29), to: today, kind: plan ? "dose" : kind });
  const [draft, setDraft] = useState(period);
  const [result, setResult] = useState<{ entries: CareEntry[]; tz: string } | null>(null);
  const [problem, setProblem] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || !care.access.read) return;
    let current = true;
    const query = new URLSearchParams({ from: period.from, to: period.to, kind: period.kind === "all" ? "dose,temp" : period.kind });
    api<{ entries: CareEntry[]; tz: string }>(`care/entries?${query}`).then(
      (next) => { if (current) setResult(next); },
      () => { if (current) setProblem(true); }
    );
    return () => { current = false; };
  }, [open, care.access.read, period, api, attempt]);

  const load = (next: Period) => {
    setDraft(next);
    setPeriod(next);
    setResult(null);
    setProblem(false);
    setAttempt((n) => n + 1);
  };
  const validDays = isDayKey(draft.from) && isDayKey(draft.to);
  const span = validDays ? daysBetween(draft.from, draft.to) : -1;
  const invalid = !validDays ? "Choose both dates." : span < 0 ? "The end date must be on or after the start." : span > 400 ? "Choose up to 400 days at a time." : draft.to > today ? "Choose an end date no later than today." : null;
  const move = (direction: -1 | 1) => {
    const length = daysBetween(period.from, period.to) + 1;
    const to = direction < 0 ? addDays(period.from, -1) : [addDays(period.to, length), today].sort()[0];
    load({ ...period, from: addDays(to, 1 - length), to });
  };
  const entries = (result?.entries ?? []).filter((e): e is HistoryEntry => (e.kind === "dose" || e.kind === "temp") && (!plan || e.med_id === plan.id));
  const resultTz = result?.tz ?? tz;
  const who = { members: state?.members ?? [], me: state?.me.email };

  return <Sheet open={open} onClose={onClose} title={plan ? `${plan.name} history` : kind === "temp" ? "Temperature history" : "Care history"} subtitle={care.name}>
    <p className={cx(tone.muted, "text-[14px] leading-snug")}>Browse saved doses and temperatures by date. Older entries are read only here; recent entries can be changed from their usual screens.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!invalid) load(draft); }} className="space-y-3">
      {!plan && kind === "all" && <Segmented aria-label="History entries" value={draft.kind} onChange={(value) => setDraft({ ...draft, kind: value })} options={[{ value: "all", label: "All" }, { value: "dose", label: "Medicines" }, { value: "temp", label: "Temperatures" }]} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))] gap-3">
        <label className={cx(tone.label, "min-w-0 space-y-1.5")}><span className="block">From</span><input type="date" aria-label="History from date" max={today} value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} className={cx(tone.input, "min-w-0 max-w-full")} /></label>
        <label className={cx(tone.label, "min-w-0 space-y-1.5")}><span className="block">To</span><input type="date" aria-label="History to date" max={today} value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} className={cx(tone.input, "min-w-0 max-w-full")} /></label>
      </div>
      {invalid && <p role="alert" className="text-sm text-mp-danger">{invalid}</p>}
      <Button type="submit" disabled={!!invalid} className="w-full">Show history</Button>
    </form>
    <section className="space-y-3" aria-label="History results">
      <p className={cx(tone.muted, "text-[14px] tabular-nums")}>{historyDate(period.from)} to {historyDate(period.to)} · {resultTz}</p>
      <div className="flex gap-2">
        <Button variant="soft" className="flex-1" onClick={() => move(-1)}>Previous period</Button>
        <Button variant="soft" className="flex-1" disabled={period.to >= today} onClick={() => move(1)}>Next period</Button>
      </div>
      {problem ? <div role="alert" className={cx(tone.inset, "space-y-2 p-3")}><p className="text-sm text-mp-ink">Couldn&apos;t load care history. Try again.</p><Button variant="soft" onClick={() => load(period)}>Retry history</Button></div> : !result ? <p role="status" className={tone.muted}>Loading history…</p> : <>
        {result.entries.length >= 2000 && <p role="status" className={cx(tone.inset, "p-3 text-sm text-mp-ink")}>Showing the newest 2,000 entries in this period{plan ? " before filtering by medicine" : ""}. Choose a narrower date range to see every entry.</p>}
        {entries.length === 0 ? <p className={cx(tone.muted, "text-[15px]")}>No entries in this date range.</p> : <div className={GROUP}>{entries.map((entry) => <article key={entry.id} className="space-y-1 px-4 py-3">
          <p className={cx(tone.label, "tabular-nums")}>{historyDate(dayKey(new Date(entry.at), resultTz))} · {formatTime(entry.at, resultTz)}</p>
          {entry.kind === "temp" ? <p className={cx(tone.body, "text-[16px] tabular-nums")}>{formatTemp(entry.data.temp_c, units)}</p> : <>
            <p className={cx(tone.body, "text-[16px]")}>{entry.data.name || plan?.name || care.state.plans.find((p) => p.id === entry.med_id)?.name || "Medicine"}{entry.data.skipped ? " · skipped" : ""}</p>
            {entry.data.dose && <p className={cx(tone.muted, "text-[14px]")}>{entry.data.dose}</p>}
            {entry.data.units != null && entry.data.unit && <p className={cx(tone.muted, "text-[14px]")}>{unitCount(entry.data.units, entry.data.unit)}</p>}
          </>}
          {entry.note && <p className={cx(tone.body, "whitespace-pre-wrap text-[14px]")}>{entry.note}</p>}
          <p className={cx(tone.faint, "text-[13px]")}>{loggedBy(entry.created_by, who)}</p>
        </article>)}</div>}
      </>}
    </section>
  </Sheet>;
}

"use client";

import { useEffect, useState } from "react";
import { RECENT_MS, type PlanView, careTime, countedAs, doseNotes, loggedBy, matchPlan, normName, oneOffNotes, parseUnits, planView, recentDose } from "@/lib/maple/care";
import type { DoseEntry, DoseResult, OneTapAsk } from "@/lib/maple/types";
import { ContextNote, Label, MoreDetails, NoteField, useOpenCount } from "../sheets/parts";
import { Button, Chip, Sheet, WhenField, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useCareNav } from "./CareNav";
import OverLimitList from "./OverLimitList";
import { NoteCard, Problem, errorText, isOverLimit, useCareCtx } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * Logging one dose (§5.2–5.6): the status sentence, the ask that brought it
 * up (a likely duplicate, or already logged today), how many (optional),
 * When, a note, and the live early and over-limit notes before Save. With
 * no `planId` it's the one-off "Another medicine" (`name` fills it in).
 *
 * Nothing here is ever blocked: an early or over-limit dose shows its note
 * and still saves, and a count left out counts as countedAs says. Every number on screen
 * is hers (care.ts arithmetic on her plan); the units chips are her own
 * typed choice, never preselected.
 */
export type DoseSheetProps = {
  open: boolean;
  onClose: () => void;
  planId?: number;
  ask?: OneTapAsk;
  name?: string;
  /** What she'd already picked when this reopens as a plan's sheet (Maple's medicine sheet, the one-off sheet). */
  start?: { at?: string; dose?: string };
};

/** A dose can be logged up to 10 minutes ahead (her phone's clock vs. the kitchen's); further is a typo. */
const FUTURE_SLACK_MS = 10 * 60_000;

export default function DoseSheet(props: DoseSheetProps) {
  const n = useOpenCount(props.open);
  return <DoseForm key={n} {...props} />;
}

function DoseForm({ open, onClose, planId: startPlan, ask, name, start }: DoseSheetProps) {
  const care = useCare();
  // "Open Ibuprofen" turns the one-off into that plan's sheet, keeping the time and dose text.
  const [planId, setPlanId] = useState(startPlan);
  const [carried, setCarried] = useState<{ when: Date | null; dose: string }>({ when: start?.at ? new Date(start.at) : null, dose: start?.dose ?? "" });
  if (!care) return null;
  if (planId == null) {
    return (
      <OneOffDose
        care={care}
        open={open}
        onClose={onClose}
        startName={name}
        startWhen={carried.when}
        startDose={carried.dose}
        onUsePlan={(id, when, dose) => {
          setCarried({ when, dose });
          setPlanId(id);
        }}
      />
    );
  }
  const view = [...care.plans, ...care.finished].find((v) => v.plan.id === planId);
  if (!view) return <Gone open={open} onClose={onClose} />;
  return <PlanDose care={care} view={view} open={open} onClose={onClose} ask={planId === startPlan ? ask : undefined} startWhen={carried.when} startDose={carried.dose} />;
}

/** The plan went away while the sheet was opening (deleted on the other phone, or no longer shared). */
function Gone({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (open) onClose();
  }, [open, onClose]);
  return null;
}

const isDose = (e: { kind: string }): e is DoseEntry => e.kind === "dose";

function PlanDose({
  care,
  view: shown,
  open,
  onClose,
  ask,
  startWhen,
  startDose,
}: {
  care: UseCare;
  view: PlanView;
  open: boolean;
  onClose: () => void;
  ask?: OneTapAsk;
  startWhen: Date | null;
  startDose: string;
}) {
  const { now: nowFn, toast } = useMaple();
  const nav = useCareNav();
  const tick = useNow(30_000);
  const ctx = useCareCtx(care);
  const plan = shown.plan;

  const [when, setWhen] = useState<Date | null>(startWhen);
  const [units, setUnits] = useState<number | null>(null);
  const [unitsTyped, setUnitsTyped] = useState("");
  const [note, setNote] = useState("");
  const [doseText, setDoseText] = useState(startDose);
  // The duplicate ask: from "Took it" (recent), or the server's answer (the other phone's dose, not synced here yet).
  const [dup, setDup] = useState<{ by: string | null; at: string } | null>(ask?.reason === "recent" && ask.at ? { by: ask.by ?? null, at: ask.at } : null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const doses = care.doses(plan.id, 2).filter(isDose);
  const at = when ?? tick;
  // Live: the sentence follows the clock (wait → ok) and this phone's unsynced doses.
  const view = planView(plan, doses, { ...ctx, now: tick, pending: doses.some((d) => d.pending) });

  const parsed = parseUnits(plan.units_per_dose);
  const counted = !!plan.limit_unit && plan.limit_unit !== "doses";
  const needUnits = counted && parsed.fixed == null;
  const unitsBad = needUnits && unitsTyped !== "" && (units == null || units <= 0 || units > 1000);
  const future = when != null && when.getTime() > nowFn().getTime() + FUTURE_SLACK_MS;

  const notes = doseNotes(plan, doses, { at: at.toISOString(), units: needUnits ? units : (parsed.fixed ?? null) }, { ...ctx, now: tick });
  const over = notes.find(isOverLimit);
  const windowDoses = over
    ? doses.filter((d) => !d.data.skipped && Date.parse(d.at) <= at.getTime() && Date.parse(d.at) > at.getTime() - 24 * 3600_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : [];

  // The dose this one could repeat (anyone's within 30 minutes), as the one-tap reads it; further back it's the early note.
  const near = recentDose(plan, doses, at);
  const showDup = !confirmed && (dup ?? (near ? { by: near.created_by, at: near.at } : null));
  // Once "Yes, another dose" answered the ask, Save is that answer.
  const sawEarlier = confirmed;

  /**
   * The sheet closes first, so the dose's toast (when the next one is OK, the
   * earlier chips, Undo) lands where she's going back to: a toast raised in a
   * sheet that then closes would wait behind the sheet under it. If the server
   * finds a dose this phone hadn't seen (the other phone's), it comes back as
   * the ask.
   */
  const save = async (opts: { skipped?: boolean; allow?: boolean } = {}) => {
    if (busy) return;
    setBusy(true);
    onClose();
    try {
      const r: DoseResult = await care.act.logDose({
        planId: plan.id,
        at: (when ?? nowFn()).toISOString(),
        units: !opts.skipped && needUnits && units != null ? units : undefined,
        dose: doseText.trim() || undefined,
        note: note.trim() || undefined,
        skipped: opts.skipped || undefined,
        // Anything the sheet already showed about an earlier dose was the ask; a skip never repeats a dose.
        allowDuplicate: opts.skipped || opts.allow || sawEarlier,
      });
      if (r.created || r.deduped) return;
      const d = r.possible_duplicate;
      nav.openDose(plan.id, d ? { reason: "recent", by: d.created_by, at: d.at } : { reason: r.reason ?? "recent" });
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const yesAnother = () => {
    setConfirmed(true);
    setDup(null);
    void save({ allow: true });
  };

  const whoText = (by: string | null) => loggedBy(by, ctx);
  const label = when ? `Took it at ${careTime(when.toISOString(), tick, ctx.tz)}` : "Took it";
  const skippable = plan.schedule.type !== "as_needed";
  const ready = !future && !unitsBad;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={plan.name}
      subtitle={plan.dose_text ? `As prescribed: ${plan.dose_text}` : undefined}
      footer={
        showDup ? undefined : (
          <div>
            <div className="flex items-center gap-3">
              {skippable && (
                <Button variant="soft" size="lg" onClick={() => void save({ skipped: true })} disabled={busy || future}>
                  Skipped
                </Button>
              )}
              <Button size="lg" className="flex-1" onClick={() => void save()} disabled={busy || !ready}>
                {busy ? "Saving…" : label}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-1">
        <p className="text-[16px] leading-snug text-mp-ink-2 tabular-nums">{view.sentence}</p>
        {view.meta.map((m) => (
          <p key={m} className="text-[13px] leading-snug text-mp-ink-2 tabular-nums">
            {m}
          </p>
        ))}
      </div>

      {showDup && (
        <div className={cx(tone.card, "p-4")} role="group" aria-label="Is this another dose?">
          <p className={cx(tone.heading, "text-[17px] leading-snug")}>
            {whoText(showDup.by)} logged {plan.name} at {careTime(showDup.at, tick, ctx.tz)}
          </p>
          <p className={cx(tone.muted, "mt-1 text-[15px]")}>Is this another dose?</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button size="md" onClick={yesAnother} disabled={busy}>
              Yes, another dose
            </Button>
            <Button size="md" variant="soft" onClick={onClose}>
              No, same one
            </Button>
          </div>
        </div>
      )}

      {ask?.reason === "logged_today" && !showDup && (
        <p className={cx(tone.inset, tone.body, "px-4 py-3 text-[15px] leading-snug")}>Already logged today. You can still log another.</p>
      )}

      {/* While it asks "another dose?", the early nudge (and its Poison Help line) would read as if she'd already doubled up:
          it comes with the toast after "Yes, another dose". Over the limit always shows, before Save. */}
      {notes.filter((a) => !showDup || isOverLimit(a)).map((a) => (
        <div key={a.title}>
          <NoteCard note={a} care={care} />
          {isOverLimit(a) && <OverLimitList doses={windowDoses} plan={plan} care={care} className="mt-2" />}
        </div>
      ))}

      {needUnits && plan.limit_unit && (
        <div>
          <Label optional>How many {plan.limit_unit} this time?</Label>
          {parsed.options?.length ? (
            <div className="flex flex-wrap gap-2">
              {parsed.options.map((o) => (
                <Chip
                  key={o}
                  selected={units === o}
                  onClick={() => {
                    setUnits(o);
                    setUnitsTyped(String(o));
                  }}
                  className="min-w-[56px] justify-center text-base"
                >
                  {o}
                </Chip>
              ))}
            </div>
          ) : (
            <input
              inputMode="decimal"
              aria-label={`How many ${plan.limit_unit} this time`}
              value={unitsTyped}
              onChange={(e) => {
                const t = e.target.value.replace(",", ".").replace(/[^\d.]/g, "");
                setUnitsTyped(t);
                const v = t === "" ? null : Number(t);
                setUnits(v != null && Number.isFinite(v) ? v : null);
              }}
              className={cx(tone.input, "w-32! text-center text-xl font-semibold tabular-nums", unitsBad && "border-mp-danger! ring-2! ring-mp-danger/25!")}
            />
          )}
          {unitsBad && <Problem>Check this number.</Problem>}
          {units == null && !unitsBad && <p className={cx(tone.muted, "mt-1.5 text-xs")}>Left blank, it counts as {countedAs(plan, null)} toward the limit.</p>}
        </div>
      )}

      <div>
        <WhenField value={when} onChange={setWhen} tz={ctx.tz} />
        {future && <Problem>That time is in the future.</Problem>}
      </div>

      <MoreDetails label="Add a note">
        <NoteField value={note} onChange={setNote} />
        <div>
          <Label optional>Dose, if different</Label>
          <input value={doseText} maxLength={80} onChange={(e) => setDoseText(e.target.value)} aria-label="Dose, if different" className={tone.input} />
        </div>
      </MoreDetails>
    </Sheet>
  );
}

/**
 * "Another medicine" (§5.3, step 1): a one-time dose that isn't on her list.
 * A name that matches one of her plans is logged on that plan ("It's on your
 * list as Ibuprofen", with "It's something else" to keep it a one-off), and
 * an acetaminophen name while a plan contains it shows the overlap note.
 */
function OneOffDose({
  care,
  open,
  onClose,
  onUsePlan,
  startName,
  startWhen,
  startDose,
}: {
  care: UseCare;
  open: boolean;
  onClose: () => void;
  onUsePlan: (planId: number, when: Date | null, dose: string) => void;
  startName?: string;
  startWhen: Date | null;
  startDose: string;
}) {
  const { now: nowFn, toast } = useMaple();
  const nav = useCareNav();
  const tick = useNow(30_000);
  const ctx = useCareCtx(care);
  const [name, setName] = useState(startName ?? "");
  const [dose, setDose] = useState(startDose);
  const [when, setWhen] = useState<Date | null>(startWhen);
  const [notMatch, setNotMatch] = useState<string | null>(null);
  // A name that fits more than one plan: which one she picked.
  const [picked, setPicked] = useState<{ key: string; id: number } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const typed = name.trim();
  const active = care.plans.map((v) => v.plan);
  const key = normName(typed);
  const match = typed ? matchPlan(typed, active, { includePrivate: true }) : null;
  const kept = notMatch === key;
  const choices = match?.kind === "ambiguous" && !kept ? match.plans : [];
  const onPlan = kept
    ? null
    : match?.kind === "match"
      ? match.plan
      : (picked?.key === key ? choices.find((p) => p.id === picked.id) : undefined) ?? null;
  const asking = choices.length > 0 && !onPlan;
  // Its notes are the plan's own once it's going on the plan (no "two acetaminophen medicines" about itself).
  const notes = typed && !onPlan ? oneOffNotes(typed, active, ctx) : [];
  const future = when != null && when.getTime() > nowFn().getTime() + FUTURE_SLACK_MS;
  // The same medicine, by anyone, within 30 minutes: ask before saving, as the server would (on her list: that plan's doses).
  const at = when ?? tick;
  const near = !typed
    ? undefined
    : onPlan
      ? (recentDose(onPlan, care.doses(onPlan.id, 2).filter(isDose), at) ?? undefined)
      : care.state.entries.find(
          (e): e is DoseEntry =>
            e.kind === "dose" && e.med_id == null && !e.data.skipped && normName(e.data.name) === key && Math.abs(Date.parse(e.at) - at.getTime()) < RECENT_MS
        );
  const dup = !confirmed && near ? { by: near.created_by, at: near.at } : null;

  // Closes first, like a plan's dose, so its toast lands on the screen underneath. A dose the server knew of and this
  // phone didn't (the other phone's) can't come back as this sheet, so its toast asks instead.
  const save = async (allowDuplicate: boolean) => {
    if (busy || !typed) return;
    setBusy(true);
    onClose();
    if (onPlan) {
      // On her list: a dose of that plan, so it counts toward her schedule. One the server knew of and this phone didn't
      // comes back as that plan's sheet, with the time and dose text she picked.
      const pickedAt = (when ?? nowFn()).toISOString();
      try {
        const r = await care.act.logDose({ planId: onPlan.id, at: pickedAt, dose: dose.trim() || undefined, allowDuplicate });
        if (!r.created && !r.deduped) {
          const d = r.possible_duplicate;
          nav.openDose(onPlan.id, d ? { reason: "recent", by: d.created_by, at: d.at } : { reason: r.reason ?? "recent" }, undefined, { at: pickedAt, dose: dose.trim() });
        }
      } catch (e) {
        toast(errorText(e), { tone: "error" });
      } finally {
        setBusy(false);
      }
      return;
    }
    const input = {
      oneOff: { name: typed, dose: dose.trim() || undefined },
      at: (when ?? nowFn()).toISOString(),
    };
    try {
      const r = await care.act.logDose({ ...input, allowDuplicate });
      const d = r.possible_duplicate;
      if (!r.created && !r.deduped) {
        toast(d ? `${loggedBy(d.created_by, ctx)} logged ${typed} at ${careTime(d.at, nowFn(), ctx.tz)}. Is this another dose?` : "That didn't save. Try again.", {
          tone: "info",
          actions: d ? [{ label: "Yes, another dose", onClick: () => void care.act.logDose({ ...input, allowDuplicate: true }).catch((e) => toast(errorText(e), { tone: "error" })) }] : undefined,
        });
      }
    } catch (e) {
      toast(errorText(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const whoText = (by: string | null) => loggedBy(by, ctx);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Another medicine"
      footer={
        dup || asking ? undefined : (
          <div>
            {!typed && <p className={cx(tone.muted, "mb-2 text-center text-xs")}>What was it?</p>}
            <Button size="lg" className="w-full" onClick={() => void save(confirmed || !!near)} disabled={busy || !typed || future}>
              {busy ? "Saving…" : when ? `Took it at ${careTime(when.toISOString(), tick, ctx.tz)}` : "Took it"}
            </Button>
          </div>
        )
      }
    >
      <ContextNote>For a one-time medicine. To keep time against a schedule, add it to the list instead.</ContextNote>

      <div>
        <Label>Name</Label>
        <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Name" autoComplete="off" className={tone.input} />
      </div>

      {onPlan && (
        <div className={cx(tone.inset, "px-4 py-3")} role="status">
          <p className={cx(tone.body, "text-[15px] leading-snug")}>
            It&apos;s on {care.self ? "your" : "her"} list as {onPlan.name}, so it&apos;s logged there.
          </p>
          <div className="mt-1 flex flex-wrap gap-x-4">
            <button type="button" onClick={() => onUsePlan(onPlan.id, when, dose)} className="min-h-[44px] text-sm font-semibold text-mp-accent-fg">
              Open {onPlan.name}
            </button>
            <button
              type="button"
              onClick={() => {
                setPicked(null);
                setNotMatch(key);
              }}
              className="min-h-[44px] text-sm font-semibold text-mp-accent-fg"
            >
              It&apos;s something else
            </button>
          </div>
        </div>
      )}

      {asking && (
        <div className={cx(tone.card, "p-4")} role="group" aria-label="Which one?">
          <p className={cx(tone.heading, "text-[17px] leading-snug")}>Which one?</p>
          <div className="mt-3 flex flex-col gap-2">
            {choices.map((p) => (
              <Button key={p.id} size="md" onClick={() => setPicked({ key, id: p.id })}>
                {p.name}
              </Button>
            ))}
            <Button size="md" variant="soft" onClick={() => setNotMatch(key)}>
              Something else
            </Button>
          </div>
        </div>
      )}

      {dup && (
        <div className={cx(tone.card, "p-4")} role="group" aria-label="Is this another dose?">
          <p className={cx(tone.heading, "text-[17px] leading-snug")}>
            {whoText(dup.by)} logged {typed} at {careTime(dup.at, tick, ctx.tz)}
          </p>
          <p className={cx(tone.muted, "mt-1 text-[15px]")}>Is this another dose?</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button
              size="md"
              disabled={busy}
              onClick={() => {
                setConfirmed(true);
                void save(true);
              }}
            >
              Yes, another dose
            </Button>
            <Button size="md" variant="soft" onClick={onClose}>
              No, same one
            </Button>
          </div>
        </div>
      )}

      {notes.map((a) => (
        <NoteCard key={a.title} note={a} care={care} />
      ))}

      <div>
        <Label optional>Dose</Label>
        <input value={dose} maxLength={80} onChange={(e) => setDose(e.target.value)} aria-label="Dose" className={tone.input} />
      </div>

      <div>
        <WhenField value={when} onChange={setWhen} tz={ctx.tz} />
        {future && <Problem>That time is in the future.</Problem>}
      </div>
    </Sheet>
  );
}

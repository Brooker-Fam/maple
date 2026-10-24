"use client";

import { useEffect, useState } from "react";
import { RECENT_MS, type PlanView, careTime, doseNotes, loggedBy, matchPlan, normName, oneOffNotes, parseUnits, planView, recentDose } from "@/lib/maple/care";
import { ZURANOLONE_NAMES } from "@/lib/maple/guidelines";
import type { DoseEntry, DoseResult, OneTapAsk } from "@/lib/maple/types";
import { ContextNote, Label, MoreDetails, NoteField, useOpenCount } from "../sheets/parts";
import { Button, Chip, Sheet, WhenField, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useCareNav } from "./CareNav";
import OverLimitList from "./OverLimitList";
import { NoteCard, Problem, Switch, errorText, isOverLimit, useCareCtx } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * Logging one dose (§5.2–5.6): the status sentence, the ask that brought it
 * up (early, recent, at the limit, units, already logged today), the units
 * ask, When, a note, and the live early and over-limit notes before Save.
 * With no `planId` it's the one-off "Another medicine".
 *
 * Nothing here is ever blocked: an early or over-limit dose shows its note
 * and still saves. Every number on screen is hers (care.ts arithmetic on her
 * plan); the units chips are her own typed choice, never preselected.
 */
export type DoseSheetProps = { open: boolean; onClose: () => void; planId?: number; ask?: OneTapAsk };

/** A dose can be logged up to 10 minutes ahead (her phone's clock vs. the kitchen's); further is a typo. */
const FUTURE_SLACK_MS = 10 * 60_000;

export default function DoseSheet(props: DoseSheetProps) {
  const n = useOpenCount(props.open);
  return <DoseForm key={n} {...props} />;
}

function DoseForm({ open, onClose, planId: startPlan, ask }: DoseSheetProps) {
  const care = useCare();
  // "Is this your Ibuprofen?" → "Yes, log it there" turns the one-off into that plan's sheet, keeping the time.
  const [planId, setPlanId] = useState(startPlan);
  const [carried, setCarried] = useState<Date | null>(null);
  if (!care) return null;
  if (planId == null) {
    return (
      <OneOffDose
        care={care}
        open={open}
        onClose={onClose}
        onUsePlan={(id, when) => {
          setCarried(when);
          setPlanId(id);
        }}
      />
    );
  }
  const view = [...care.plans, ...care.finished].find((v) => v.plan.id === planId);
  if (!view) return <Gone open={open} onClose={onClose} />;
  return <PlanDose care={care} view={view} open={open} onClose={onClose} ask={planId === startPlan ? ask : undefined} startWhen={carried} />;
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
}: {
  care: UseCare;
  view: PlanView;
  open: boolean;
  onClose: () => void;
  ask?: OneTapAsk;
  startWhen: Date | null;
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
  const [doseText, setDoseText] = useState("");
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
  const decimals = plan.limit_unit === "mL";
  const unitsBad = needUnits && unitsTyped !== "" && (units == null || units <= 0 || units > 1000 || (!decimals && !Number.isInteger(units)));
  const future = when != null && when.getTime() > nowFn().getTime() + FUTURE_SLACK_MS;

  const notes = doseNotes(plan, doses, { at: at.toISOString(), units: needUnits ? units : (parsed.fixed ?? null) }, { ...ctx, now: tick });
  const over = notes.find(isOverLimit);
  const windowDoses = over
    ? doses.filter((d) => !d.data.skipped && Date.parse(d.at) <= at.getTime() && Date.parse(d.at) > at.getTime() - 24 * 3600_000).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : [];

  // The dose this one could repeat (inside her gap, or 30 minutes with none set), as the one-tap reads it: anyone's
  // within 30 minutes, or someone else's inside the gap, asks; her own earlier one inside the gap is the early note.
  const near = recentDose(plan, doses, at);
  const asksNear = near && (Math.abs(Date.parse(near.at) - at.getTime()) < RECENT_MS || near.created_by !== ctx.me);
  const showDup = !confirmed && (dup ?? (asksNear && near ? { by: near.created_by, at: near.at } : null));
  // Whatever the sheet showed about an earlier dose (the ask, or the early note) was the question; Save is the answer.
  const sawEarlier = confirmed || !!near;

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
    if (!needUnits || units != null) void save({ allow: true });
  };

  const whoText = (by: string | null) => loggedBy(by, ctx);
  const label = when ? `Took it at ${careTime(when.toISOString(), tick, ctx.tz)}` : "Took it";
  const skippable = plan.schedule.type !== "as_needed";
  const ready = !future && !unitsBad && (!needUnits || units != null);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={plan.name}
      subtitle={plan.dose_text ? `As prescribed: ${plan.dose_text}` : undefined}
      footer={
        showDup ? undefined : (
          <div>
            {needUnits && units == null && <p className={cx(tone.muted, "mb-2 text-center text-xs")}>How many this time? Choose above.</p>}
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

      {notes.map((a) => (
        <div key={a.title}>
          <NoteCard note={a} care={care} />
          {isOverLimit(a) && <OverLimitList doses={windowDoses} plan={plan} care={care} className="mt-2" />}
        </div>
      ))}

      {needUnits && plan.limit_unit && (
        <div>
          <Label>How many {plan.limit_unit} this time?</Label>
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
              inputMode={decimals ? "decimal" : "numeric"}
              aria-label={`How many ${plan.limit_unit} this time`}
              value={unitsTyped}
              onChange={(e) => {
                const t = e.target.value.replace(",", ".").replace(decimals ? /[^\d.]/g : /\D/g, "");
                setUnitsTyped(t);
                const v = t === "" ? null : Number(t);
                setUnits(v != null && Number.isFinite(v) ? v : null);
              }}
              className={cx(tone.input, "w-32! text-center text-xl font-semibold tabular-nums", unitsBad && "border-mp-danger! ring-2! ring-mp-danger/25!")}
            />
          )}
          {unitsBad && <Problem>{decimals ? "Check this number." : "Enter a whole number."}</Problem>}
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
 * A name that matches one of her plans asks "Is this your Ibuprofen?" first,
 * and an acetaminophen name while a plan contains it shows the overlap note.
 */
function OneOffDose({ care, open, onClose, onUsePlan }: { care: UseCare; open: boolean; onClose: () => void; onUsePlan: (planId: number, when: Date | null) => void }) {
  const { now: nowFn, toast } = useMaple();
  const tick = useNow(30_000);
  const ctx = useCareCtx(care);
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const [when, setWhen] = useState<Date | null>(null);
  const [priv, setPriv] = useState<boolean | null>(null);
  const [notMatch, setNotMatch] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const typed = name.trim();
  const active = care.plans.map((v) => v.plan);
  const match = typed ? matchPlan(typed, active, { includePrivate: care.access.private }) : null;
  const askMatch = match?.kind === "match" && notMatch !== normName(typed) ? match.plan : null;
  const notes = typed ? oneOffNotes(typed, active, ctx) : [];
  // Only me starts on for a mood medicine she names (S9); once she touches it, it's hers.
  const onlyMe = care.access.private && (priv ?? ZURANOLONE_NAMES.test(typed));
  const future = when != null && when.getTime() > nowFn().getTime() + FUTURE_SLACK_MS;
  // The same one-off (by its normalized name), by anyone, within 30 minutes: ask before saving, as the server would.
  const at = when ?? tick;
  const near = typed
    ? care.state.entries.find(
        (e): e is DoseEntry =>
          e.kind === "dose" && e.med_id == null && !e.data.skipped && normName(e.data.name) === normName(typed) && Math.abs(Date.parse(e.at) - at.getTime()) < RECENT_MS
      )
    : undefined;
  const dup = !confirmed && near ? { by: near.created_by, at: near.at } : null;

  // Closes first, like a plan's dose, so its toast lands on the screen underneath. A dose the server knew of and this
  // phone didn't (the other phone's) can't come back as this sheet, so its toast asks instead.
  const save = async (allowDuplicate: boolean) => {
    if (busy || !typed) return;
    setBusy(true);
    onClose();
    const input = {
      oneOff: { name: typed, dose: dose.trim() || undefined, private: care.access.private ? onlyMe : undefined },
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
        dup || askMatch ? undefined : (
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

      {askMatch && (
        <div className={cx(tone.card, "p-4")} role="group" aria-label={`Is this your ${askMatch.name}?`}>
          <p className={cx(tone.heading, "text-[17px] leading-snug")}>Is this your {askMatch.name}?</p>
          <div className="mt-3 flex flex-col gap-2">
            <Button size="md" onClick={() => onUsePlan(askMatch.id, when)}>
              Yes, log it there
            </Button>
            <Button size="md" variant="soft" onClick={() => setNotMatch(normName(typed))}>
              No, something else
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

      {care.access.private && (
        <div className={cx(tone.card, "flex min-h-[52px] items-center gap-3 px-4 py-2.5")}>
          <div className="min-w-0 flex-1">
            <div className={cx(tone.body, "text-[15px]")}>Only me</div>
            <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>Hidden from everyone else, their assistants and the admin login.</p>
          </div>
          <Switch checked={onlyMe} onChange={setPriv} label="Only me" />
        </div>
      )}
    </Sheet>
  );
}

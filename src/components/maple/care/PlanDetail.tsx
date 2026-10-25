"use client";

import { useState } from "react";
import { parseUnits } from "@/lib/maple/care";
import { DEFAULT_TZ, dayKey, formatDayLabel } from "@/lib/maple/time";
import type { CarePlan, DoseEntry } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Label, MoreDetails, NoteField, SheetFooter, useOpenCount } from "../sheets/parts";
import { Button, Chip, Segmented, Sheet, WhenField, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import MedPlanSheet from "./MedPlanSheet";
import { GROUP, Problem, errorText, useDoseText } from "./parts";
import type { UseCare } from "./useCare";

/**
 * One medicine (§5.8, step 1): her schedule as typed, "As prescribed", the
 * label's words, and the last 7 days by local day ("Today · 3"), each dose a
 * row to fix ("3:05 AM · 2 caplets · Matt", "8:00 PM · skipped"). Edit,
 * "Stop taking it" and, once stopped, "Take it again" (each at once, with
 * Undo; history stays with the plan).
 */
export default function PlanDetail({ planId, onClose, care }: { planId: number | null; onClose: () => void; care: UseCare }) {
  // Keep the last plan while the sheet animates closed.
  const [last, setLast] = useState(planId);
  if (planId != null && planId !== last) setLast(planId);
  const id = planId ?? last;
  const open = planId != null;
  const view = id == null ? undefined : [...care.plans, ...care.finished].find((v) => v.plan.id === id);
  const [sub, setSub] = useState<"edit" | { dose: DoseEntry } | null>(null);
  const { state, now } = useMaple();
  const text = useDoseText();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  if (!view) return null;
  const { plan, status } = view;
  const active = care.plans.some((v) => v.plan.id === plan.id);
  const write = care.access.write;

  const doses = care
    .doses(plan.id, 7)
    .filter((e): e is DoseEntry => e.kind === "dose")
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const todayKey = dayKey(now(), tz);
  const days: { key: string; doses: DoseEntry[] }[] = [];
  for (const d of doses) {
    const k = dayKey(new Date(d.at), tz);
    if (days[days.length - 1]?.key === k) days[days.length - 1].doses.push(d);
    else days.push({ key: k, doses: [d] });
  }

  return (
    <>
      <Sheet open={open && !sub} onClose={onClose} title={plan.name} subtitle={view.summary}>
        <div className="space-y-1">
          {plan.dose_text && <p className={cx(tone.body, "text-[15px]")}>As prescribed: {plan.dose_text}</p>}
          {plan.label_text && <p className={cx(tone.muted, "text-[14px]")}>Label: &ldquo;{plan.label_text}&rdquo;</p>}
          {plan.instructions && <p className={cx(tone.muted, "text-[14px]")}>{plan.instructions}</p>}
          {plan.also_called && <p className={cx(tone.faint, "text-[13px]")}>Also called {plan.also_called}</p>}
          <p className="pt-1 text-[15px] leading-snug text-mp-ink-2 tabular-nums">{view.sentence}</p>
          {view.meta.map((m) => (
            <p key={m} className="text-[13px] leading-snug text-mp-ink-2 tabular-nums">
              {m}
            </p>
          ))}
        </div>

        <section className="space-y-4">
          {days.length ? (
            days.map((g) => (
              <div key={g.key}>
                <p className={cx(tone.label, "mb-1.5 px-1")}>
                  {formatDayLabel(g.key, todayKey)} · {g.doses.filter((d) => !d.data.skipped).length}
                </p>
                <div className={GROUP}>
                  {g.doses.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      disabled={!write || d.id < 0}
                      onClick={() => setSub({ dose: d })}
                      className={cx(tone.row, "min-h-[48px] py-2 disabled:active:bg-transparent")}
                    >
                      <span className={cx(d.data.skipped ? tone.muted : tone.body, "min-w-0 flex-1 text-[15px] tabular-nums")}>
                        {text(d, plan, { noDay: true })}
                        {d.data.name && d.data.name !== plan.name ? ` · ${d.data.name}` : ""}
                        {d.pending && <span className={tone.faint}> · on this phone, not synced</span>}
                      </span>
                      {write && d.id > 0 && <Icon name="chevron-right" size={16} className="shrink-0 text-mp-ink-3" />}
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className={cx(tone.muted, "px-1 text-[15px]")}>Nothing logged in the last 7 days.</p>
          )}
        </section>

        {write && (
          <div className="flex flex-wrap gap-2 pb-1">
            <Button variant="soft" className="flex-1" onClick={() => setSub("edit")}>
              <Icon name="pencil" size={16} />
              Edit
            </Button>
            {active && status.state !== "stopped" && (
              <Button
                variant="soft"
                className="flex-1"
                onClick={() => {
                  // Close first so "{name} stopped" and its Undo land on her screen (useCare says it, and any refusal).
                  onClose();
                  void care.act.stopPlan(plan.id).catch(() => {});
                }}
              >
                Stop taking it
              </Button>
            )}
            {plan.stopped_at && (
              <Button
                variant="soft"
                className="flex-1"
                onClick={() => {
                  onClose();
                  void care.act.resumePlan(plan.id).catch(() => {});
                }}
              >
                Take it again
              </Button>
            )}
          </div>
        )}
      </Sheet>

      <MedPlanSheet open={open && sub === "edit"} onClose={() => setSub(null)} care={care} plan={plan} onDeleted={onClose} />
      <DoseEdit
        open={open && typeof sub === "object" && sub !== null}
        dose={typeof sub === "object" && sub !== null ? sub.dose : null}
        plan={plan}
        care={care}
        onClose={() => setSub(null)}
      />
    </>
  );
}

/**
 * Fixing one dose (§5.8): its time, units, dose text, note, taken or skipped,
 * and Delete (soft, with Undo). An edit made against an older version, or of
 * a dose someone else removed, says so instead of saving.
 */
function DoseEdit(props: { open: boolean; dose: DoseEntry | null; plan: CarePlan; care: UseCare; onClose: () => void }) {
  const n = useOpenCount(props.open);
  const [last, setLast] = useState(props.dose);
  if (props.dose && props.dose !== last) setLast(props.dose);
  const dose = props.dose ?? last;
  if (!dose) return null;
  return <DoseEditForm key={`${n}-${dose.id}`} {...props} dose={dose} />;
}

function DoseEditForm({ open, dose, plan, care, onClose }: { open: boolean; dose: DoseEntry; plan: CarePlan; care: UseCare; onClose: () => void }) {
  const { state, memberLabel, toast } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [when, setWhen] = useState<Date | null>(new Date(dose.at));
  const [units, setUnits] = useState<string>(dose.data.units != null ? String(dose.data.units) : "");
  const [doseText, setDoseText] = useState(dose.data.dose ?? "");
  const [note, setNote] = useState(dose.note ?? "");
  const [skipped, setSkipped] = useState(!!dose.data.skipped);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const counted = !!plan.limit_unit && plan.limit_unit !== "doses";
  const options = parseUnits(plan.units_per_dose).options;
  const u = units.trim() === "" ? null : Number(units);
  const unitsBad = u != null && (!Number.isFinite(u) || u <= 0 || u > 1000);

  // Someone else's delete getting there first is said by useCare ("Matt removed this, so your change wasn't saved.").
  const failText = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409 && !/changed/.test(e.message)) {
      const b = e.body as { updated_by?: string | null } | null;
      return `${memberLabel(b?.updated_by) ?? "Someone"} changed this dose a moment ago, so your change wasn't saved.`;
    }
    return errorText(e);
  };

  // Both close first, so useCare's "Saved" / "Deleted" (with Undo) lands on the plan underneath.
  const save = async () => {
    if (busy || unitsBad) return;
    setBusy(true);
    setProblem(null);
    onClose();
    try {
      await care.act.editEntry(
        dose.id,
        {
          at: (when ?? new Date()).toISOString(),
          data: { ...dose.data, units: counted && !skipped ? u : null, unit: counted ? plan.limit_unit : null, dose: doseText.trim() || null, skipped },
          note: note.trim() || null,
        },
        dose.updated_at
      );
    } catch (e) {
      toast(failText(e), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const del = () => {
    onClose();
    void care.act.deleteEntry(dose.id).catch(() => {});
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={plan.name}
      subtitle="Fix this dose"
      footer={
        <div>
          <Problem className="mt-0 mb-2 text-center">{problem}</Problem>
          <SheetFooter onClose={onClose} onDelete={del} onPrimary={() => void save()} label="Save" busy={busy} disabled={unitsBad} />
        </div>
      }
    >
      <Segmented
        aria-label="Taken or skipped"
        value={skipped ? "skipped" : "taken"}
        onChange={(v) => setSkipped(v === "skipped")}
        options={[
          { value: "taken", label: "Taken" },
          { value: "skipped", label: "Skipped" },
        ]}
      />
      <WhenField value={when} onChange={setWhen} tz={tz} />
      {counted && !skipped && plan.limit_unit && (
        <div>
          <Label>How many {plan.limit_unit}</Label>
          {options?.length ? (
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <Chip key={o} selected={u === o} onClick={() => setUnits(String(o))} className="min-w-[56px] justify-center text-base">
                  {o}
                </Chip>
              ))}
            </div>
          ) : (
            <input
              inputMode="decimal"
              aria-label={`How many ${plan.limit_unit}`}
              value={units}
              onChange={(e) => setUnits(e.target.value.replace(",", ".").replace(/[^\d.]/g, ""))}
              className={cx(tone.input, "w-32! text-center text-xl font-semibold tabular-nums")}
            />
          )}
          {unitsBad && <Problem>Check this number.</Problem>}
        </div>
      )}
      <MoreDetails label="Note and dose" summary={[note.trim() && "Note", doseText.trim() && doseText.trim()].filter(Boolean).join(" · ")}>
        <NoteField value={note} onChange={setNote} />
        <div>
          <Label optional>Dose, if different</Label>
          <input value={doseText} maxLength={80} onChange={(e) => setDoseText(e.target.value)} aria-label="Dose, if different" className={tone.input} />
        </div>
      </MoreDetails>
    </Sheet>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { daysSinceBirth, listNotes } from "@/lib/maple/care";
import { MOM_DISCLAIMER } from "@/lib/maple/guidelines";
import { DEFAULT_TZ } from "@/lib/maple/time";
import { Icon } from "../icons";
import { Button, EmptyState, SectionTitle, Sheet, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import CareSettingsSheet from "./CareSettingsSheet";
import CareTeam from "./CareTeam";
import { useCareNav } from "./CareNav";
import { CheckInSection } from "./CheckIn";
import { CrisisStrip } from "./CrisisSheet";
import MedPlanSheet from "./MedPlanSheet";
import MedQuestionsSheet from "./MedQuestionsSheet";
import { TemperatureTile } from "./MomTempSheet";
import PlanCard from "./PlanCard";
import PlanDetail from "./PlanDetail";
import { QuestionsSection } from "./Questions";
import RemindersSheet, { remindersValue, usePhoneReminders } from "./Reminders";
import { SupportRow } from "./SupportScreen";
import { VisitSummaryRow } from "./VisitSummary";
import { WarningSignsCard } from "./WarningSigns";
import { GROUP, NavRow, NoteCard, useCareCtx } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * Her screen (§11.2): a full-height sheet opened through useCareNav().openCare(),
 * not a tab. Medicines first, then check-ins, temperature, questions, warning
 * signs, support, care team and settings. Everyone signed in sees all of it.
 * If access goes while it's open, it closes and says so.
 */
export type CareScreenProps = { open: boolean; onClose: () => void };

export default function CareScreen({ open, onClose }: CareScreenProps) {
  const care = useCare();
  const { toast } = useMaple();
  // Access lost while open (demoted to a viewer, deleted elsewhere) closes it with a word; deleting it here closes it quietly.
  const had = useRef(false);
  const deleted = useRef(false);
  useEffect(() => {
    if (!open) {
      had.current = false;
      return;
    }
    if (care) {
      had.current = true;
      return;
    }
    if (had.current && !deleted.current) toast("That page isn't available anymore.", { tone: "info" });
    had.current = false;
    deleted.current = false;
    onClose();
  }, [care, open, onClose, toast]);
  if (!care) return null;
  return <Screen care={care} open={open} onClose={onClose} onDeleted={() => (deleted.current = true)} />;
}

type Sub = { kind: "detail"; planId: number } | { kind: "add" } | { kind: "settings" } | { kind: "questions" } | { kind: "reminders" } | null;

function Screen({ care, open, onClose, onDeleted }: { care: UseCare; open: boolean; onClose: () => void; onDeleted: () => void }) {
  const { state } = useMaple();
  const nav = useCareNav();
  const now = useNow(60_000);
  const ctx = useCareCtx(care);
  const phone = usePhoneReminders();
  const [sub, setSub] = useState<Sub>(null);
  const [showFinished, setShowFinished] = useState(false);
  // Closing her screen closes whatever was open on top of it, so it doesn't come back with her screen next time.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setSub(null);
  }
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const baby = state?.baby;
  const write = care.access.write;

  const day = baby?.born_at ? daysSinceBirth(baby.born_at, now, tz) : null;
  const babyName = baby ? (baby.nickname || baby.name).split(" ")[0] : "";
  const notes = listNotes(
    care.plans.map((v) => v.plan),
    ctx
  );

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={care.name}
        display
        subtitle={day != null && babyName ? `Day ${day} after ${babyName}'s birth` : undefined}
        // Warning signs, always one tap from the top.
        actions={
          <Button variant="soft" size="sm" className="shrink-0" onClick={() => nav.openSigns()}>
            <Icon name="siren" size={16} />
            Warning signs
          </Button>
        }
      >
        <div className="min-h-[76dvh] space-y-6 pb-2">
          <div className="space-y-3 empty:hidden">
            <CrisisStrip />
          </div>

          <section>
            <SectionTitle
              action={
                write && care.plans.length > 0 ? (
                  <Button variant="ghost" size="sm" className="-mr-2" onClick={() => setSub({ kind: "add" })}>
                    <Icon name="plus" size={16} />
                    Add
                  </Button>
                ) : undefined
              }
            >
              Medicines
            </SectionTitle>
            <div className="space-y-3">
              {notes.map((n) => (
                <NoteCard key={n.key} note={n} care={care} />
              ))}
              {care.plans.map((v) => (
                <PlanCard key={v.plan.id} view={v} care={care} onOpen={(planId) => setSub({ kind: "detail", planId })} />
              ))}
              {!care.plans.length && (
                <div className={cx(tone.card, "pb-5")}>
                  <EmptyState icon="pill" title="No medicines yet">
                    Add each one from the label or discharge papers. Maple&apos;s Log keeps time against that schedule; it never suggests a dose.
                  </EmptyState>
                  {write && (
                    <div className="-mt-4 flex flex-col items-center gap-2 px-6">
                      <Button onClick={() => setSub({ kind: "add" })}>Add a medicine</Button>
                      <p className={cx(tone.faint, "text-center text-[13px]")}>Or photograph the discharge sheet and ask Claude to add them.</p>
                    </div>
                  )}
                </div>
              )}
              <div className={GROUP}>
                {write && <NavRow icon="plus" accent label="Something else" note="A one-time medicine" onClick={() => nav.openOneOff()} />}
                {care.finished.length > 0 && (
                  <div>
                    <button type="button" onClick={() => setShowFinished((s) => !s)} aria-expanded={showFinished} className={cx(tone.row, "min-h-[52px] py-2.5")}>
                      <Icon name="history" size={20} className="shrink-0 text-mp-ink-2" />
                      <span className={cx(tone.body, "min-w-0 flex-1 text-[15px]")}>Finished ({care.finished.length})</span>
                      <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", showFinished && "rotate-180")} />
                    </button>
                    {showFinished && (
                      <div className="space-y-3 px-3 pb-3">
                        {care.finished.map((v) => (
                          <PlanCard key={v.plan.id} view={v} care={care} finished onOpen={(planId) => setSub({ kind: "detail", planId })} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <NavRow icon="message-square" label="Medicine questions" note="Nursing, and who to call about a medicine" onClick={() => setSub({ kind: "questions" })} />
                {care.plans.length > 0 && (
                  <NavRow icon="bell" label="Reminders on this phone" value={remindersValue(phone.status)} onClick={() => setSub({ kind: "reminders" })} />
                )}
              </div>
            </div>
          </section>

          {care.access.mood && <CheckInSection />}
          <TemperatureTile />
          <QuestionsSection />
          <WarningSignsCard />
          <SupportRow />
          <CareTeam care={care} onEdit={() => setSub({ kind: "settings" })} />
          <VisitSummaryRow />

          {write && (
            <div className={GROUP}>
              <NavRow icon="pencil" label="Settings for this page" note="Care team, nursing, next OB visit" onClick={() => setSub({ kind: "settings" })} />
            </div>
          )}

          <p className={cx(tone.faint, "px-1 text-center text-[12px] leading-snug")}>{MOM_DISCLAIMER}</p>
        </div>
      </Sheet>

      <PlanDetail planId={open && sub?.kind === "detail" ? sub.planId : null} onClose={() => setSub(null)} care={care} />
      <MedPlanSheet open={open && sub?.kind === "add"} onClose={() => setSub(null)} care={care} />
      <MedQuestionsSheet open={open && sub?.kind === "questions"} onClose={() => setSub(null)} care={care} />
      <CareSettingsSheet
        open={open && sub?.kind === "settings"}
        onClose={() => setSub(null)}
        care={care}
        onDeleted={() => {
          onDeleted();
          setSub(null);
        }}
      />
      <RemindersSheet open={open && sub?.kind === "reminders"} onClose={() => setSub(null)} care={care} phone={phone} />
    </>
  );
}

"use client";

import { useState } from "react";
import { listNotes, planTitle, type PlanView } from "@/lib/maple/care";
import { MOM_DISCLAIMER } from "@/lib/maple/guidelines";
import type { DoseEntry } from "@/lib/maple/types";
import { Icon, KindBadge, type IconName } from "../icons";
import { NotificationsRow, useNotifications } from "../notify";
import { CARE_COLOR } from "../palette";
import { Button, EmptyState, SectionTitle, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import CareSettingsSheet from "./CareSettingsSheet";
import CareTeam from "./CareTeam";
import { useCareNav } from "./CareNav";
import { CheckInSection } from "./CheckIn";
import { CrisisStrip } from "./CrisisSheet";
import MedPlanSheet from "./MedPlanSheet";
import MedQuestionsSheet from "./MedQuestionsSheet";
import { TemperatureTile } from "./MomTempSheet";
import OverLimitList from "./OverLimitList";
import PlanDetail from "./PlanDetail";
import { QuestionsSection } from "./Questions";
import { VisitSummaryRow } from "./VisitSummary";
import { Footnote, GROUP, GlanceMark, NavRow, NoteCard, PlanName, TookIt, isOverLimit, useCareCtx, useDoseText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * Her tab (§11.2): her page as a place you go back to, not a pop-up. Short
 * and ordered by use: the header (her name, the same day count as Today's
 * hero, and Help), a row of actions (Took a medicine, Temperature, Question
 * for her OB, Notifications), her medicines as one row each (the glance and
 * Took it, in her list's fixed order; a row opens that medicine's detail),
 * then Something else, Add and Finished, one-time medicines, the check-in,
 * temperature, OB questions, one Help group, her care team and settings.
 * Sheets open from here at most one deep.
 *
 * Everyone signed in sees all of it; view-only guests never get the tab
 * (MapleApp hides it when useCare() is null, and sends anyone on it back to
 * Today with a word if access goes).
 */
export default function CareScreen() {
  const care = useCare();
  if (!care) return null;
  return <Page care={care} />;
}

type Sub = { kind: "detail"; planId: number } | { kind: "add" } | { kind: "settings" } | { kind: "questions" } | null;

function Page({ care }: { care: UseCare }) {
  const { state, summary } = useMaple();
  const nav = useCareNav();
  const notify = useNotifications();
  const ctx = useCareCtx(care);
  const [sub, setSub] = useState<Sub>(null);
  const [showFinished, setShowFinished] = useState(false);
  const write = care.access.write;
  const baby = state?.baby;
  const babyName = baby ? (baby.nickname || baby.name).split(" ")[0] : "";
  // The same fact as Today's hero ("Day 6" for her first two weeks), so the two never disagree.
  const age = summary?.age ?? null;
  const day = age ? (age.days < 14 ? `Day ${age.dayOfLife}` : `${babyName} is ${age.label}`) : null;
  const notes = listNotes(
    care.plans.map((v) => v.plan),
    ctx
  );
  const planNotes = care.rows.filter((v) => v.notes.length > 0);
  const openDetail = (planId: number) => setSub({ kind: "detail", planId });

  const actions: { id: string; icon: IconName; label: string; value?: string; onClick: () => void }[] = [
    ...(write
      ? [
          { id: "took", icon: "pill" as IconName, label: "Took a medicine", onClick: () => nav.openPicker() },
          { id: "temp", icon: "thermometer" as IconName, label: "Temperature", onClick: () => nav.openTemp() },
          { id: "ob", icon: "message-square" as IconName, label: care.self ? "Question for my OB" : "Question for her OB", onClick: () => nav.openQuestion() },
        ]
      : []),
    { id: "notify", icon: "bell", label: "Notifications", value: notify.value, onClick: () => notify.open() },
  ];

  return (
    <div className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-8">
      <header className="flex items-start gap-3 px-1">
        <div className="min-w-0 flex-1">
          <h1 className={cx(tone.display, "truncate text-[34px] leading-[1.05]")}>{care.name}</h1>
          {day && <p className={cx(tone.muted, "mt-1 text-[15px]")}>{day}</p>}
        </div>
        {/* Help, always one tap from the top: Maple's and her warning signs, numbers and help lines. */}
        <Button variant="soft" size="sm" className="mt-0.5 shrink-0" onClick={() => nav.openHelp()}>
          <Icon name="siren" size={16} />
          Help
        </Button>
      </header>

      <div className="space-y-3 empty:hidden">
        <CrisisStrip />
      </div>

      <div className={cx("grid gap-2", actions.length === 4 ? "grid-cols-4" : "grid-cols-1")} role="group" aria-label="Quick actions">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={a.onClick}
            aria-label={a.value ? `${a.label}: ${a.value}` : a.label}
            className={cx(
              tone.card,
              "flex min-h-[80px] min-w-0 flex-col items-center justify-start gap-1.5 px-1 pt-3 pb-2.5 text-center transition active:scale-[0.98] active:bg-mp-ink/[0.04]"
            )}
          >
            <Icon name={a.icon} size={22} className="mp-kind-ink shrink-0" style={{ color: CARE_COLOR }} />
            <span className="text-[12px] leading-tight font-medium text-mp-ink">{a.label}</span>
            {a.value && <span className="-mt-1 text-[11px] leading-tight text-mp-ink-2">{a.value}</span>}
          </button>
        ))}
      </div>

      <section aria-labelledby="her-meds">
        <SectionTitle
          action={
            write && care.rows.length > 0 ? (
              <Button variant="ghost" size="sm" className="-mr-2" onClick={() => setSub({ kind: "add" })}>
                <Icon name="plus" size={16} />
                Add
              </Button>
            ) : undefined
          }
        >
          <span id="her-meds">Medicines</span>
        </SectionTitle>
        <div className="space-y-3">
          {notes.map((n) => (
            <NoteCard key={n.key} note={n} care={care} />
          ))}
          {care.rows.length > 0 ? (
            <div className={GROUP}>
              {care.rows.map((v) => (
                <MedRow key={v.plan.id} view={v} care={care} onOpen={openDetail} />
              ))}
            </div>
          ) : (
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
          {/* What a medicine's own numbers say right now (over the limit, early), under the list rather than inside it. */}
          {planNotes.map((v) =>
            v.notes.map((n) => (
              <div key={`${v.plan.id}:${n.key}`}>
                <NoteCard note={n} care={care} />
                {isOverLimit(n) && <OverLimitList doses={v.status.window} plan={v.plan} care={care} className="mt-2" />}
              </div>
            ))
          )}
          <OneOffs care={care} write={write} />
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
                  <div className={cx(tone.divide, "border-t border-mp-line")}>
                    {care.finished.map((v) => (
                      <MedRow key={v.plan.id} view={v} care={care} onOpen={openDetail} finished />
                    ))}
                  </div>
                )}
              </div>
            )}
            <NavRow icon="message-square" label="Medicine questions" note="Nursing, and who to call about a medicine" onClick={() => setSub({ kind: "questions" })} />
          </div>
          {write && care.rows.length > 0 && <Footnote className="mt-0">Got the discharge sheet? Photograph it and ask Claude to add them.</Footnote>}
        </div>
      </section>

      {care.access.mood && <CheckInSection />}
      <TemperatureTile />
      <QuestionsSection />
      <VisitSummaryRow />

      {/* One Help group: warning signs once (the header's Help has them too), supporting her, and the help lines. */}
      <section aria-labelledby="her-help">
        <SectionTitle>
          <span id="her-help">Help</span>
        </SectionTitle>
        <div className={GROUP}>
          <NavRow icon="siren" danger label="Warning signs" note={`What needs 911, a call to ${care.self ? "your" : "her"} OB now, or today`} onClick={() => nav.openSigns()} />
          <NavRow
            icon="life-buoy"
            label={care.self ? "Support for you" : `Supporting ${care.name}`}
            note={care.self ? "Help lines, and what's common after a birth" : "Signs to watch for, how to help, help lines"}
            onClick={() => nav.openSupport()}
          />
          <NavRow icon="phone" label="Help lines and doctor numbers" note={`${babyName ? `${babyName}'s` : "The baby's"} and ${care.self ? "yours" : "hers"}, in one place`} onClick={() => nav.openHelp()} />
        </div>
      </section>

      <CareTeam care={care} onEdit={() => setSub({ kind: "settings" })} />

      <section aria-labelledby="her-settings">
        <SectionTitle>
          <span id="her-settings">Settings</span>
        </SectionTitle>
        <div className={GROUP}>
          <NotificationsRow />
          {write && <NavRow icon="pencil" label="Settings for this page" note="Care team, nursing, next OB visit" onClick={() => setSub({ kind: "settings" })} />}
        </div>
        <Footnote>
          A notification can&apos;t ring through Silent. For an alarm, the Mom meds shortcut can start a timer (Family → Shortcuts &amp; assistants).
        </Footnote>
      </section>

      <p className={cx(tone.faint, "px-1 text-center text-[12px] leading-snug")}>{MOM_DISCLAIMER}</p>

      <PlanDetail planId={sub?.kind === "detail" ? sub.planId : null} onClose={() => setSub(null)} care={care} />
      <MedPlanSheet open={sub?.kind === "add"} onClose={() => setSub(null)} care={care} />
      <MedQuestionsSheet open={sub?.kind === "questions"} onClose={() => setSub(null)} care={care} />
      <CareSettingsSheet open={sub?.kind === "settings"} onClose={() => setSub(null)} care={care} onDeleted={() => setSub(null)} />
    </div>
  );
}

/**
 * One medicine as a row: the pill badge, its name (with the Also called name
 * muted), the glance ("OK now · last 2:24 AM", or the timer mark and "OK
 * after 10:55 AM · last 4:55 AM", two lines when it needs them so the time is
 * never cut) and Took it. The row opens its detail (schedule, the last 7
 * days, Edit, Stop). A finished one has no Took it.
 */
function MedRow({ view, care, onOpen, finished }: { view: PlanView; care: UseCare; onOpen: (planId: number) => void; finished?: boolean }) {
  const nav = useCareNav();
  const g = view.glance;
  return (
    <div className="flex items-center gap-1 pr-3">
      <button
        type="button"
        onClick={() => onOpen(view.plan.id)}
        aria-label={`${planTitle(view.plan)}: ${finished ? view.summary : g.text}. Open it.`}
        className={cx(tone.row, "min-h-[60px] min-w-0 flex-1 py-2.5 pr-1")}
      >
        <KindBadge icon="pill" color={CARE_COLOR} size={28} />
        <span className="min-w-0 flex-1 leading-snug tabular-nums">
          <PlanName plan={view.plan} className={cx("text-[15px]", finished ? "text-mp-ink-2" : "text-mp-ink")} />
          <span className="mt-0.5 flex min-w-0 items-start gap-1 text-[13px] text-mp-ink-2">
            {!finished && <GlanceMark ready={g.ready} size={13} className="mt-[3px]" />}
            <span className="line-clamp-2">{finished ? view.summary : g.text}</span>
          </span>
        </span>
        {finished && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
      </button>
      {!finished && <TookIt view={view} care={care} onAsk={(ask) => nav.openDose(view.plan.id, ask)} />}
    </div>
  );
}

/**
 * One-time medicines from the last few days (the state's window): they
 * belong to no plan, so no row shows them. Each can be removed (with Undo).
 */
function OneOffs({ care, write }: { care: UseCare; write: boolean }) {
  const text = useDoseText();
  const doses = care.state.entries
    .filter((e): e is DoseEntry => e.kind === "dose" && e.med_id == null && !e.data.skipped)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 8);
  if (!doses.length) return null;
  return (
    <div>
      <p className={cx(tone.label, "mb-1.5 px-1")}>One-time medicines</p>
      <div className={GROUP}>
        {doses.map((d) => (
          <div key={d.id} className={cx(tone.row, "min-h-[48px] py-2")}>
            <span className={cx(tone.body, "min-w-0 flex-1 text-[15px] tabular-nums")}>
              {d.data.name}
              {d.data.dose ? ` ${d.data.dose}` : ""}
              <span className="text-mp-ink-2"> · {text(d, null)}</span>
              {d.pending && <span className={tone.faint}> · on this phone, not synced</span>}
            </span>
            {write && d.id > 0 && (
              <button
                type="button"
                aria-label={`Remove ${d.data.name}`}
                onClick={() => void care.act.deleteEntry(d.id).catch(() => {})}
                className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-mp-ink-3 active:bg-mp-sunken"
              >
                <Icon name="trash-2" size={18} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

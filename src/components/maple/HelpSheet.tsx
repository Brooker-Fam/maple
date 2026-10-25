"use client";

import { DISCLAIMER, EMERGENCY_SIGNS, MOM_HELP } from "@/lib/maple/guidelines";
import { EMERGENCY_FILL, usePhones } from "./AlertCard";
import { useAppNav } from "./AppNav";
import { useCareNav } from "./care/CareNav";
import { telHref } from "./care/CareTeam";
import { GROUP, NavRow } from "./care/parts";
import { HelpLines, TalkSection } from "./care/SupportScreen";
import { useCare } from "./care/useCare";
import { WarningSignsCard } from "./care/WarningSigns";
import { Icon } from "./icons";
import { SectionTitle, Sheet, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Help: the one sheet for "when do we call, and who", opened from Today's
 * footer, her tab's header and Family (view-only guests too). Two headed
 * parts: Maple (when to call 911, Call 911, her pediatrician and the
 * after-hours line) and Brittany (her warning signs grouped by who to call,
 * her OB's numbers, 911 and 988, the postpartum lines, and Supporting
 * Brittany). Every line of guidance is guidelines.ts's, word for word; the
 * crisis sheet and strip aren't part of it.
 *
 * Readers without her page (view-only guests) see "After the birth" and the
 * same signs for "mom", so it never shows that a page exists.
 */
export default function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, readOnly } = useMaple();
  const care = useCare();
  const nav = useCareNav();
  const app = useAppNav();
  const phones = usePhones();
  const baby = state ? (state.baby.nickname || state.baby.name).split(" ")[0] : "Maple";

  // A launcher: it closes before what it opens, so that sheet isn't under it.
  const then = (fn: () => void) => {
    onClose();
    window.setTimeout(fn, 120);
  };

  const numbers = [
    phones.pediatrician && { label: "Pediatrician", phone: phones.pediatrician },
    phones.afterHours && { label: "After hours", phone: phones.afterHours },
  ].filter((n): n is { label: string; phone: string } => !!n);
  const team = care?.state.settings.care_team ?? {};
  const has = (n?: string) => !!n && n.replace(/\D/g, "").length >= 3;
  const her = [
    has(team.ob) && { label: care?.self ? "Your OB or midwife" : "Her OB or midwife", phone: team.ob! },
    has(team.after_hours) && { label: "After-hours or labor and delivery line", phone: team.after_hours! },
  ].filter((n): n is { label: string; phone: string } => !!n);

  return (
    <Sheet open={open} onClose={onClose} title="Help">
      <section aria-labelledby="help-baby" className="space-y-3">
        <SectionTitle>
          <span id="help-baby">{baby}</span>
        </SectionTitle>
        <div className={cx(tone.card, "p-4")}>
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-danger">
            <Icon name="siren" size={16} strokeWidth={2} className="shrink-0" />
            When to call 911
          </p>
          <p className={cx(tone.body, "mt-1.5 text-[15px] leading-relaxed")}>{EMERGENCY_SIGNS}</p>
          <a
            href="tel:911"
            className={cx("mt-3.5 flex min-h-[52px] items-center justify-center gap-2 rounded-[14px] text-[17px] font-semibold active:scale-[0.98]", EMERGENCY_FILL)}
          >
            <Icon name="phone" size={20} />
            Call 911
          </a>
        </div>
        {numbers.length > 0 ? (
          <CallRows rows={numbers} />
        ) : (
          !readOnly && (
            <div className={GROUP}>
              <NavRow icon="phone" label="Add her doctor's numbers" note="In Family → Her doctor, for one-tap calling" onClick={() => then(() => app.go("family"))} />
            </div>
          )
        )}
        <p className={cx(tone.faint, "px-1 text-[13px] leading-snug")}>For anything else that worries you, call your pediatrician.</p>
      </section>

      <section aria-labelledby="help-mom" className="space-y-3">
        <SectionTitle>
          <span id="help-mom">{care ? care.name : "After the birth"}</span>
        </SectionTitle>
        <WarningSignsCard />
        {her.length > 0 && <CallRows rows={her} />}
        <div>
          <p className={cx(tone.label, "mb-1.5 px-1")}>If you need help now</p>
          <HelpLines lines={MOM_HELP.now} />
        </div>
        <TalkSection />
        <div className={GROUP}>
          <NavRow
            icon="life-buoy"
            label={care ? (care.self ? "Support for you" : `Supporting ${care.name}`) : "Supporting a new mom"}
            note={care?.self ? "Help lines, and what's common after a birth" : "Signs to watch for, how to help, help lines"}
            onClick={() => then(nav.openSupport)}
          />
        </div>
      </section>

      <p className={cx(tone.faint, "px-1 pb-1 text-center text-[12px] leading-snug")}>{DISCLAIMER}</p>
    </Sheet>
  );
}

function CallRows({ rows }: { rows: { label: string; phone: string }[] }) {
  return (
    <div className={GROUP}>
      {rows.map((n) => (
        <a key={n.label} href={telHref(n.phone)} className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className={cx(tone.body, "block text-[15px] leading-snug")}>{n.label}</span>
            <span className={cx(tone.muted, "block text-[13px] tabular-nums")}>{n.phone}</span>
          </span>
          <span className="shrink-0 text-[15px] font-medium text-mp-accent-fg">Call</span>
        </a>
      ))}
    </div>
  );
}

/** Today's footer: the one door to Help (911, her doctor, the warning signs after the birth), and the disclaimer. */
export function HelpFooter() {
  const nav = useCareNav();
  return (
    <div className="px-2 text-center">
      <button
        type="button"
        onClick={nav.openHelp}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[15px] font-semibold text-mp-danger"
      >
        <Icon name="siren" size={18} />
        Help and doctor numbers
      </button>
      <p className={cx(tone.faint, "mx-auto max-w-xs text-[12px] leading-snug")}>{DISCLAIMER}</p>
    </div>
  );
}

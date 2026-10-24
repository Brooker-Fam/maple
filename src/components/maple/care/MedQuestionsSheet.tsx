"use client";

import { MED_BABY_WATCH, MED_NURSING_NOTE, MOM_HELP, type HelpLine } from "@/lib/maple/guidelines";
import { Icon } from "../icons";
import { Sheet, cx, tone } from "../ui";
import { telHref } from "./CareTeam";
import { GROUP } from "./parts";
import type { UseCare } from "./useCare";

/**
 * "Medicine questions" (§5.7, step 1): "Can I take this while nursing?"
 * never gets a verdict here. It gets MED_NURSING_NOTE, the baby-watch note
 * and people to call: her pharmacy, Poison Help, MotherToBaby and InfantRisk
 * (from MOM_HELP, verified numbers only), and a link to LactMed. The nursing
 * pieces show unless Settings says she isn't nursing or pumping (S10).
 */
export default function MedQuestionsSheet({ open, onClose, care }: { open: boolean; onClose: () => void; care: UseCare }) {
  const nursing = care.state.settings.feeding !== "no";
  const pharmacy = care.state.settings.care_team?.pharmacy?.trim();
  // By name, not position: MotherToBaby and InfantRisk are the nursing ones.
  const NURSING_LINES = ["MotherToBaby", "InfantRisk Center"];
  const lines = MOM_HELP.medicine.filter((h) => nursing || !NURSING_LINES.includes(h.name));

  return (
    <Sheet open={open} onClose={onClose} title="Medicine questions">
      <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{MED_NURSING_NOTE}</p>
      {nursing && (
        <p className={cx(tone.inset, tone.body, "flex gap-2.5 px-3.5 py-3 text-[14px] leading-relaxed")}>
          <Icon name="baby" size={18} className="mt-0.5 shrink-0 text-mp-ink-2" />
          <span>{MED_BABY_WATCH}</span>
        </p>
      )}
      <div className={GROUP}>
        {pharmacy && (
          <div className="px-4 py-3">
            <p className={cx(tone.heading, "text-[15px]")}>{care.self ? "Your pharmacy" : "Her pharmacy"}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a href={telHref(pharmacy)} className={ACTION}>
                <Icon name="phone" size={16} />
                Call {pharmacy}
              </a>
            </div>
          </div>
        )}
        {lines.map((h) => (
          <HelpRow key={h.name} h={h} />
        ))}
      </div>
    </Sheet>
  );
}

const ACTION =
  "inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-mp-sunken px-3.5 text-sm font-semibold text-mp-ink transition active:scale-[0.97] tabular-nums";

/** One help line: its name, what it's for, and its call, text or link buttons, exactly as MOM_HELP has them. */
function HelpRow({ h }: { h: HelpLine }) {
  return (
    <div className="px-4 py-3">
      <p className={cx(tone.heading, "text-[15px]")}>{h.name}</p>
      <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{h.detail}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {h.tel && (
          <a href={`tel:${h.tel}`} className={ACTION}>
            <Icon name="phone" size={16} />
            {h.action}
          </a>
        )}
        {h.url && (
          <a href={h.url} target="_blank" rel="noopener noreferrer" className={ACTION}>
            <Icon name="link" size={16} />
            {h.action}
          </a>
        )}
        {h.extra?.map((x) => (
          <a key={x.action} href={x.tel ? `tel:${x.tel}` : `sms:${x.sms}`} className={ACTION}>
            <Icon name={x.tel ? "phone" : "message-square"} size={16} />
            {x.action}
          </a>
        ))}
      </div>
    </div>
  );
}

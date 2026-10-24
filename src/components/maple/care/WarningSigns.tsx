"use client";

import { useState } from "react";
import { forMom } from "@/lib/maple/care";
import {
  MOM_CANT_REACH,
  MOM_ONE_YEAR_NOTE,
  MOM_SIGNS,
  MOM_SIGN_INFO,
  MOM_TIER_LABEL,
  assessMomTemp,
  momWhatToSay,
  momWhatToSayOther,
  type AlertTier,
  type Assessment,
  type MomSign,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ, dayKey, parseDayKey } from "@/lib/maple/time";
import { cToF } from "@/lib/maple/units";
import { tierMark } from "../AlertCard";
import { Icon } from "../icons";
import { AssessmentCard } from "../sheets/parts";
import { Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import CareSettingsSheet from "./CareSettingsSheet";
import CrisisSheet, { CallButton, OnTop, telHref } from "./CrisisSheet";
import { type UseCare, useCare } from "./useCare";

/**
 * Warning signs after the birth (§8.1): the Call 911, Call your OB now and
 * Call your OB today groups from MOM_SIGN_INFO. Always available to every
 * signed-in member, viewers included; never gated and nothing is saved.
 *
 * A sign opens its own sheet: the tier, the body word for word, who to call
 * and what to say. Anyone who isn't her reads "For {Name}: " before the
 * title ("For mom: " without access to her page, so it never shows that one
 * exists), the family wording of a chip where there is one, and for the harm
 * chip the partner's crisis card instead of hers.
 */

export type WarningSignsSheetProps = { open: boolean; onClose: () => void };

const GROUPS: { tier: AlertTier; heading: string; signs: MomSign[]; fold?: number }[] = [
  { tier: "emergency", heading: "Call 911", signs: MOM_SIGNS.filter((s) => MOM_SIGN_INFO[s].tier === "emergency") },
  { tier: "now", heading: "Call your OB now", signs: MOM_SIGNS.filter((s) => MOM_SIGN_INFO[s].tier === "now"), fold: 4 },
  { tier: "today", heading: "Call your OB today", signs: MOM_SIGNS.filter((s) => MOM_SIGN_INFO[s].tier === "today") },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 20, 2026": her birth date in the family's zone, for "What to say". */
function birthDateText(bornAt: string, tz: string): string {
  const { year, month, day } = parseDayKey(dayKey(new Date(bornAt), tz));
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** At or over 100.4°F: the line the breast and peeing signs escalate on. */
const isFever = (c: number) => Math.round(cToF(c) * 10) / 10 >= 100.4 || c >= 38 - 1e-9;

/** Who's reading: her, someone she shares with (her name), or anyone without access ("mom"). */
function useReader(): { care: UseCare | null; self: boolean; name: string } {
  const care = useCare();
  return { care, self: !!care?.self, name: care?.name ?? "mom" };
}

/** The card on her screen and the Support page. */
export function WarningSignsCard() {
  return (
    <section className={cx(tone.card, "p-4")}>
      <h2 className={cx(tone.heading, "flex items-center gap-2 text-[17px]")}>
        <Icon name="siren" size={20} className="shrink-0 text-mp-danger" />
        Warning signs
      </h2>
      <p className={cx(tone.muted, "mt-1 text-[14px] leading-snug")}>{MOM_ONE_YEAR_NOTE}</p>
      <SignGroups className="mt-4" />
    </section>
  );
}

/** The same signs as a sheet (her screen's header button). */
export default function WarningSignsSheet({ open, onClose }: WarningSignsSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Warning signs">
      <p className={cx(tone.muted, "text-[15px] leading-snug")}>{MOM_ONE_YEAR_NOTE}</p>
      <SignGroups />
    </Sheet>
  );
}

/** The three groups of chips, and the sign (or crisis) sheet a chip opens. */
function SignGroups({ className }: { className?: string }) {
  const { self } = useReader();
  const [all, setAll] = useState(false);
  const [sign, setSign] = useState<MomSign | null>(null);
  const [crisis, setCrisis] = useState(false);
  const pick = (s: MomSign) => (s === "harm_thoughts" ? setCrisis(true) : setSign(s));

  return (
    <div className={cx("space-y-4", className)}>
      {GROUPS.map((g) => {
        const mark = tierMark(g.tier);
        const shown = g.fold && !all ? g.signs.slice(0, g.fold) : g.signs;
        return (
          <div key={g.tier} role="group" aria-label={g.heading}>
            <p className={cx("mb-2 flex items-center gap-1.5 text-[13px] font-semibold", mark.className)}>
              <Icon name={mark.icon} size={16} strokeWidth={2} className="shrink-0" />
              {g.heading}
            </p>
            <div className="flex flex-wrap gap-2">
              {shown.map((s) => {
                const info = MOM_SIGN_INFO[s];
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => pick(s)}
                    className="inline-flex min-h-[44px] items-center rounded-[12px] bg-mp-sunken px-3 py-2 text-left text-[15px] leading-snug font-medium text-mp-ink transition active:scale-[0.98] active:bg-mp-ink/10"
                  >
                    {self ? info.label : (info.labelOther ?? info.label)}
                  </button>
                );
              })}
            </div>
            {g.fold && g.signs.length > g.fold && (
              <button
                type="button"
                onClick={() => setAll((a) => !a)}
                aria-expanded={all}
                className="mt-1 inline-flex min-h-[44px] items-center gap-1 text-[15px] font-semibold text-mp-accent-fg"
              >
                {all ? "Show fewer" : `Show all ${g.signs.length}`}
                <Icon name="chevron-down" size={16} className={cx("transition", all && "rotate-180")} />
              </button>
            )}
          </div>
        );
      })}
      <OnTop>
        <SignSheet sign={sign} onClose={() => setSign(null)} />
        <CrisisSheet open={crisis} onClose={() => setCrisis(false)} audience={self ? "her" : "other"} from="sign" />
      </OnTop>
    </div>
  );
}

/**
 * One sign: its tier, its body, who to call. For "now", MOM_CANT_REACH; for
 * every sign, "What to say" with her birth date. Her OB's buttons only for
 * readers of her page who have the numbers (or "Add your OB's number" for
 * those who can set it); 911 for everyone.
 */
function SignSheet({ sign, onClose }: { sign: MomSign | null; onClose: () => void }) {
  const { state, now } = useMaple();
  const { care, self, name } = useReader();
  const [settings, setSettings] = useState(false);
  // Keep the last sign while the sheet slides away; a new sign starts without the settings sheet over it.
  const [shown, setShown] = useState<MomSign | null>(sign);
  if (sign && sign !== shown) {
    setShown(sign);
    setSettings(false);
  }
  const close = () => {
    setSettings(false);
    onClose();
  };
  const s = sign ?? shown;
  if (!s) return null;

  const info = MOM_SIGN_INFO[s];
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const bornAt = state?.baby.born_at ?? null;

  // The breast and peeing signs go up to "now" on a day she's had a fever logged (§7.1), with that reading's card.
  let fever: Assessment | null = null;
  if (s === "breast" || s === "peeing") {
    const today = dayKey(now(), tz);
    const hottest = (care?.state.entries ?? [])
      .flatMap((e) => (e.kind === "temp" && dayKey(new Date(e.at), tz) === today && isFever(e.data.temp_c) ? [e.data.temp_c] : []))
      .sort((a, b) => b - a)[0];
    const a = hottest != null ? assessMomTemp(hottest) : null;
    if (a) fever = forMom(a, name, self);
  }
  const tier: AlertTier = fever ? "now" : info.tier;
  const mark = tierMark(tier);
  const title = forMom({ tier, title: self ? info.label : (info.labelOther ?? info.label), body: info.body }, name, self).title;

  const team = care?.state.settings.care_team ?? {};
  const has = (n?: string) => !!n && n.replace(/\D/g, "").length >= 3;
  const callOb = tier !== "emergency" && care;

  return (
    <>
      <Sheet open={!!sign} onClose={close} title={title}>
        <div>
          <p className={cx("flex items-center gap-1.5 text-[13px] font-semibold", mark.className)}>
            <Icon name={mark.icon} size={16} strokeWidth={2} className="shrink-0" />
            {MOM_TIER_LABEL[tier]}
          </p>
          <p className={cx(tone.body, "mt-1.5 text-[17px] leading-relaxed")}>{info.body}</p>
        </div>
        {fever && <AssessmentCard a={fever} audience="mom" calls={false} />}
        {/* Most "now" bodies already end with it; say it once. */}
        {tier === "now" && !info.body.includes(MOM_CANT_REACH) && <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{MOM_CANT_REACH}</p>}
        {bornAt && (
          <div className={cx(tone.inset, "px-4 py-3")}>
            <p className={tone.label}>What to say</p>
            <p className={cx(tone.body, "mt-1 text-[15px] leading-relaxed")}>{(self ? momWhatToSay : momWhatToSayOther)(birthDateText(bornAt, tz))}</p>
          </div>
        )}
        <div className="space-y-2.5 pb-2">
          {tier === "emergency" && (
            <CallButton href="tel:911" look="emergency">
              Call 911
            </CallButton>
          )}
          {callOb && has(team.ob) && (
            <CallButton href={telHref(team.ob!)} look="primary">
              Call your OB
            </CallButton>
          )}
          {callOb && has(team.after_hours) && <CallButton href={telHref(team.after_hours!)}>Call the after-hours line</CallButton>}
          {callOb && !has(team.ob) && care.access.write && (
            <button
              type="button"
              onClick={() => setSettings(true)}
              className="flex min-h-[48px] w-full items-center justify-center gap-1.5 text-[15px] font-semibold text-mp-accent-fg"
            >
              {self ? "Add your OB's number" : "Add her OB's number"}
              <Icon name="chevron-right" size={16} />
            </button>
          )}
          {tier !== "emergency" && (
            <CallButton href="tel:911" look="danger">
              Call 911
            </CallButton>
          )}
        </div>
      </Sheet>
      {care && <CareSettingsSheet open={!!sign && settings} onClose={() => setSettings(false)} care={care} />}
    </>
  );
}

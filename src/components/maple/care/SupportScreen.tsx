"use client";

import { useState, type ReactNode } from "react";
import { HELP_VERIFIED_ON, MOM_HELP, PARTNER, SUPPORT, type HelpLine } from "@/lib/maple/guidelines";
import { parseDayKey } from "@/lib/maple/time";
import { EMERGENCY_FILL, NOW_WASH } from "../AlertCard";
import { Icon } from "../icons";
import { Button, SectionTitle, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import CareSettingsSheet from "./CareSettingsSheet";
import CareTeam from "./CareTeam";
import { useCareNav } from "./CareNav";
import { CallButton, OnTop, smsHref, telHref } from "./CrisisSheet";
import { GROUP, NavRow } from "./parts";
import { useCare } from "./useCare";
import { WarningSignsCard } from "./WarningSigns";

/**
 * Support (§8.2): help lines, warning signs and the partner section, as a
 * full-height sheet ("Supporting Brittany"), opened from her tab's Help group
 * and from Help. Every signed-in member can open it, viewers included.
 *
 * Her page leads with help now, people to talk to, and her care team. Anyone
 * else reads the partner guide first. Without access to her page it's
 * "Supporting a new mom", so the page never shows that one exists. It never
 * shows anything she logged: no check-ins, scores or "she seems low".
 */
export type SupportScreenProps = { open: boolean; onClose: () => void };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (key: string) => {
  const { year, month, day } = parseDayKey(key);
  return `${MONTHS[month - 1]} ${day}, ${year}`;
};

export default function SupportScreen({ open, onClose }: SupportScreenProps) {
  const care = useCare();
  const { memberName } = useMaple();
  const her = !!care?.self;
  // Her "For Matt and family" row shows her the partner page; closing Support goes back to her own next time.
  const [partner, setPartner] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setPartner(false);
  }
  const [settings, setSettings] = useState(false);

  const shared = care?.state.shared_with ?? [];
  const family = shared.length ? `For ${memberName(shared[0]).split(" ")[0]} and family` : "For your partner and family";
  const title = her ? (partner ? family : "Support for you") : care ? `Supporting ${care.name}` : "Supporting a new mom";

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={title}
        actions={
          her && partner ? (
            <Button variant="ghost" size="sm" onClick={() => setPartner(false)}>
              Back
            </Button>
          ) : undefined
        }
      >
        <div className="min-h-[76dvh] space-y-6 pb-2">
          {her && !partner ? (
            <>
              <section>
                <SectionTitle>If you need help now</SectionTitle>
                <HelpLines lines={MOM_HELP.now} />
              </section>
              <TalkSection />
              <WarningSignsCard />
              {care && (
                <div>
                  <CareTeam care={care} onEdit={() => setSettings(true)} />
                  <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug")}>{SUPPORT.wellVisit}</p>
                </div>
              )}
              <Common />
              <div className={GROUP}>
                <NavRow icon="users" label={family} note="What to watch for, how to help, and when to call" onClick={() => setPartner(true)} />
              </div>
              <p className={cx(tone.faint, "px-1 text-[13px] leading-snug")}>{SUPPORT.privacy}</p>
            </>
          ) : (
            <>
              <PartnerGuide />
              <section>
                <SectionTitle>If you need help now</SectionTitle>
                <HelpLines lines={MOM_HELP.now} />
              </section>
              <TalkSection />
              <WarningSignsCard />
              <PartnerYou />
              <Common />
            </>
          )}
          <p className={cx(tone.faint, "px-1 text-center text-[12px]")}>Help-line numbers checked {longDate(HELP_VERIFIED_ON)}.</p>
        </div>
      </Sheet>
      {care && (
        <OnTop>
          <CareSettingsSheet open={open && settings} onClose={() => setSettings(false)} care={care} />
        </OnTop>
      )}
    </>
  );
}

/** "Talk to someone who knows postpartum": the maternal hotline, PSI and New York's helpline (here and in Help). */
export function TalkSection() {
  return (
    <section>
      <SectionTitle>Talk to someone who knows postpartum</SectionTitle>
      <p className={cx(tone.body, "mb-3 px-1 text-[15px] leading-snug")}>{SUPPORT.intro}</p>
      <HelpLines lines={MOM_HELP.talk} />
    </section>
  );
}

/** A help line's buttons: its call (911 in its own red), then its texts and pages. */
function lineActions(line: HelpLine): { label: string; href: string; external?: boolean }[] {
  const first = line.tel ? telHref(line.tel) : line.sms ? smsHref(line.sms) : line.url ?? "";
  return [
    { label: line.action, href: first, external: !line.tel && !line.sms && !!line.url },
    ...(line.extra ?? []).map((x) => ({ label: x.action, href: x.tel ? telHref(x.tel) : smsHref(x.sms ?? "") })),
  ];
}

const PILL = "inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3.5 text-[15px] font-semibold transition active:scale-[0.97]";

/** Each help line with its call, text and page buttons (here and in Help). */
export function HelpLines({ lines }: { lines: readonly HelpLine[] }) {
  return (
    <div className={GROUP}>
      {lines.map((line) => (
        <div key={line.name} className="px-4 py-3.5">
          <p className={cx(tone.body, "text-[15px] font-semibold")}>{line.name}</p>
          <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{line.detail}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {lineActions(line).map((a, i) => (
              <a
                key={a.label}
                href={a.href}
                {...(a.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className={cx(
                  PILL,
                  line.tel === "911" ? EMERGENCY_FILL : i === 0 ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink"
                )}
              >
                <Icon name={a.href.startsWith("sms:") ? "message-square" : a.external ? "link" : "phone"} size={17} />
                {a.label}
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** "What's common, and what needs a call": each one's name, then its words as written. */
function Common() {
  return (
    <section>
      <SectionTitle>What&apos;s common, and what needs a call</SectionTitle>
      <div className={GROUP}>
        {Object.entries(SUPPORT.learn).map(([k, text]) => {
          // "Baby blues:" is a name to bold; a colon after a full sentence (the psychosis line) isn't.
          const colon = text.indexOf(": ");
          const at = colon > 0 && colon <= 40 && !text.slice(0, colon).includes(".") ? colon : -1;
          return (
            <p key={k} className={cx(tone.body, "px-4 py-3 text-[15px] leading-snug")}>
              <span className="font-semibold">{text.slice(0, at + 1)}</span>
              {text.slice(at + 1)}
            </p>
          );
        })}
      </div>
    </section>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-snug marker:text-mp-ink-3">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function GuideCard({ heading, children, className }: { heading: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx(tone.card, "p-4", className)}>
      <h3 className={cx(tone.heading, "text-[16px]")}>{heading}</h3>
      <div className={tone.body}>{children}</div>
    </div>
  );
}

const HOTLINE = MOM_HELP.talk.find((l) => l.tel === "+18338526262");
const PSI = MOM_HELP.talk.find((l) => l.tel === "+18009444773");
const PSI_GROUPS = MOM_HELP.talk.find((l) => l.url);

/** PARTNER, word for word: what to watch for, when it's 911, and how to help. */
function PartnerGuide() {
  return (
    <section className="space-y-3">
      <p className={cx(tone.body, "px-1 text-[17px] leading-relaxed")}>{PARTNER.intro}</p>
      <GuideCard heading={PARTNER.watch.heading}>
        <Bullets items={PARTNER.watch.items} />
        <p className={cx(tone.muted, "mt-3 text-[15px] leading-snug")}>{PARTNER.watch.action}</p>
      </GuideCard>
      <div className={cx("rounded-[20px] border p-4", NOW_WASH)}>
        <h3 className="flex items-center gap-1.5 text-[16px] font-semibold text-mp-danger">
          <Icon name="siren" size={18} strokeWidth={2} className="shrink-0" />
          {PARTNER.emergency.heading}
        </h3>
        <div className={tone.body}>
          <Bullets items={PARTNER.emergency.items} />
          <p className="mt-3 text-[15px] leading-snug font-medium">{PARTNER.emergency.note}</p>
        </div>
        <CallButton href="tel:911" look="emergency" className="mt-3.5">
          Call 911
        </CallButton>
      </div>
      <GuideCard heading={PARTNER.help.heading}>
        <Bullets items={PARTNER.help.items} />
        <p className="mt-3 text-[15px] leading-snug">{PARTNER.help.hotline}</p>
        {HOTLINE && (
          <div className="mt-3 flex flex-wrap gap-2">
            {lineActions(HOTLINE).map((a, i) => (
              <a key={a.label} href={a.href} className={cx(PILL, i === 0 ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink")}>
                <Icon name={a.href.startsWith("sms:") ? "message-square" : "phone"} size={17} />
                {a.label}
              </a>
            ))}
          </div>
        )}
      </GuideCard>
    </section>
  );
}

/** PARTNER.you: dads and partners struggle too, with PSI's numbers. */
function PartnerYou() {
  return (
    <GuideCard heading={PARTNER.you.heading}>
      <p className="mt-1.5 text-[15px] leading-relaxed">{PARTNER.you.body}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {PSI?.tel && (
          <a href={telHref(PSI.tel)} className={cx(PILL, "bg-mp-accent text-mp-on-accent")}>
            <Icon name="phone" size={17} />
            {PSI.action}
          </a>
        )}
        {PSI_GROUPS?.url && (
          <a href={PSI_GROUPS.url} target="_blank" rel="noopener noreferrer" className={cx(PILL, "bg-mp-sunken text-mp-ink")}>
            <Icon name="link" size={17} />
            {PSI_GROUPS.action}
          </a>
        )}
      </div>
    </GuideCard>
  );
}

/** The "Support for you" / "Supporting {Name}" row (her tab's Help group, and Help). */
export function SupportRow() {
  const care = useCare();
  const nav = useCareNav();
  if (!care) return null;
  return (
    <div className={GROUP}>
      <NavRow
        icon="life-buoy"
        label={care.self ? "Support for you" : `Supporting ${care.name}`}
        note={care.self ? "Help lines, and what's common after a birth" : "Signs to watch for, how to help, help lines"}
        onClick={() => nav.openSupport()}
      />
    </div>
  );
}

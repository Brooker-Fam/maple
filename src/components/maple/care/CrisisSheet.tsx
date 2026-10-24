"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CRISIS, CRISIS_LEAD, CRISIS_PARTNER, NO_AUTO_NOTIFY, TRUSTED_TEXT } from "@/lib/maple/guidelines";
import { EMERGENCY_FILL } from "../AlertCard";
import { Icon, type IconName } from "../icons";
import { Sheet, cx, tone, useSheetArmed } from "../ui";
import { useCare } from "./useCare";

/**
 * The one locked sheet for every self-harm path (§6.4): CRISIS for her,
 * CRISIS_PARTNER for anyone else, with the calls in the spec's order and
 * NO_AUTO_NOTIFY. The way out is a small header button: "Close", or from the
 * fuller check-in "Continue the check-in", "Stop here" and "Back".
 *
 * Also the bits mom's help pages share: tel: and sms: links, the big call
 * buttons, and OnTop for a sheet opened from inside another sheet.
 */
export type CrisisSheetProps = {
  open: boolean;
  onClose: () => void;
  audience: "her" | "other";
  from: "checkin" | "screen" | "sign";
  onContinue?: () => void;
  onStop?: () => void;
  onBack?: () => void;
};

// ── Links ────────────────────────────────────────────────────────────────

export const telHref = (n: string) => `tel:${n.replace(/[^\d+]/g, "")}`;

/** iOS's Messages takes a prefilled body after "&", everyone else after "?" (§6.4). */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** "sms:988"; with a body and no number she picks who it goes to. */
export function smsHref(to: string, body?: string): string {
  const n = to.replace(/[^\d+]/g, "");
  if (!body) return `sms:${n}`;
  return `sms:${n}${isIOS() ? "&" : "?"}body=${encodeURIComponent(body)}`;
}

// ── Buttons ──────────────────────────────────────────────────────────────

const BIG = "flex min-h-[56px] w-full items-center justify-center gap-2 rounded-[14px] px-4 text-[17px] font-semibold transition active:scale-[0.98]";

const LOOK = {
  /** 911: solid red in every look (AlertCard's), so it never reads like anything else on the page. */
  emergency: EMERGENCY_FILL,
  primary: "bg-mp-accent text-mp-on-accent",
  soft: "bg-mp-sunken text-mp-ink",
  /** 911 as the fallback under her OB's number: red ink, not the solid fill. */
  danger: "bg-mp-danger/10 text-mp-danger",
} as const;

/**
 * A full-width call or text link. Inside a locked sheet's first moments it
 * says it's not ready (aria-disabled); the sheet itself swallows the tap.
 */
export function CallButton({
  href,
  icon = "phone",
  look = "soft",
  children,
  className,
  external,
}: {
  href: string;
  icon?: IconName;
  look?: keyof typeof LOOK;
  children: ReactNode;
  className?: string;
  /** A web page, opened in a new tab (PSI, LactMed). */
  external?: boolean;
}) {
  const armed = useSheetArmed();
  return (
    <a
      href={href}
      aria-disabled={armed ? undefined : true}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cx(BIG, LOOK[look], className)}
    >
      <Icon name={icon} size={20} />
      {children}
    </a>
  );
}

/** A small text button for a sheet's header row (the locked sheet's way out). */
function HeaderButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const armed = useSheetArmed();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={armed ? undefined : true}
      className="min-h-[44px] rounded-[10px] px-2.5 text-[15px] font-semibold text-mp-accent-fg active:bg-mp-ink/5"
    >
      {children}
    </button>
  );
}

const noSubscribe = () => () => {};

/**
 * A sheet opened from inside another sheet (her screen, Support) goes to the
 * end of <body>, so it sits over that sheet instead of inside its scrolling
 * body. Client only: nothing about it is rendered on the server.
 */
export function OnTop({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
  return client ? createPortal(children, document.body) : null;
}

// ── The sheet ────────────────────────────────────────────────────────────

export default function CrisisSheet({ open, onClose, audience, from, onContinue, onStop, onBack }: CrisisSheetProps) {
  const her = audience === "her";
  // Readers who aren't her get the partner card as written, never forMom's "For {Name}: ".
  const a = her ? CRISIS : CRISIS_PARTNER;
  const screen = from === "screen" && her;
  const actions = screen ? (
    <>
      {onContinue && <HeaderButton onClick={onContinue}>Continue the check-in</HeaderButton>}
      {onStop && <HeaderButton onClick={onStop}>Stop here</HeaderButton>}
      {onBack && <HeaderButton onClick={onBack}>Back</HeaderButton>}
    </>
  ) : (
    <HeaderButton onClick={onClose}>Close</HeaderButton>
  );
  return (
    <Sheet open={open} onClose={onClose} title={a.title} locked actions={actions}>
      <div className="space-y-4 pb-2">
        {screen && <p className={cx(tone.body, "text-[17px] leading-relaxed font-medium")}>{CRISIS_LEAD}</p>}
        <div>
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-mp-danger">
            <Icon name="siren" size={16} strokeWidth={2} className="shrink-0" />
            {a.label}
          </p>
          <p className={cx(tone.body, "mt-1.5 text-[17px] leading-relaxed")}>{a.body}</p>
        </div>
        {/* 911 first, then 988; the maternal hotline and PSI aren't crisis lines, so they're not here. */}
        <div className="space-y-2.5">
          <CallButton href="tel:911" look="emergency">
            Call 911
          </CallButton>
          <CallButton href="tel:988" look="primary">
            Call 988
          </CallButton>
          <CallButton href={smsHref("988")} icon="message-square">
            Text 988
          </CallButton>
          {her && (
            <CallButton href={smsHref("", TRUSTED_TEXT)} icon="message-square">
              Text someone you trust
            </CallButton>
          )}
        </div>
        <p className={cx(tone.muted, "px-1 text-[13px] leading-snug")}>{NO_AUTO_NOTIFY}</p>
      </div>
    </Sheet>
  );
}

/**
 * "Call or text 988 · Call 911", pinned on her screen and her check-in card
 * for the rest of the local day after the crisis sheet closes (§6.4): when
 * today's check-ins include "Thoughts of hurting myself", or today's fuller
 * check-in had question 9 above "Not at all". Hers only, never a setting.
 */
export function CrisisStrip({ className }: { className?: string }) {
  const care = useCare();
  if (!care?.mood?.crisisToday) return null;
  const link = "inline-flex min-h-[44px] items-center font-semibold text-mp-danger underline decoration-mp-danger/40 underline-offset-4";
  return (
    <p role="note" className={cx(tone.card, "flex flex-wrap items-center gap-x-1.5 px-4 py-1 text-[15px] text-mp-ink", className)}>
      <Icon name="phone" size={18} className="mr-1 shrink-0 text-mp-danger" />
      <a href="tel:988" className={link}>
        Call
      </a>
      <span>or</span>
      <a href={smsHref("988")} className={link}>
        text 988
      </a>
      <span aria-hidden className="text-mp-ink-3">
        ·
      </span>
      <a href="tel:911" className={link}>
        Call 911
      </a>
    </p>
  );
}

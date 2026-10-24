"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState, type ReactNode } from "react";
import { DISCLAIMER, EMERGENCY_SIGNS, MOM_TIER_LABEL, TIER_LABEL, VITAMIN_D_DEFAULT, type AlertTier } from "@/lib/maple/guidelines";
import type { Alert } from "@/lib/maple/insights";
import { dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import { Icon, type IconName } from "./icons";
import type { TabId } from "./MapleApp";
import { useSheets } from "./sheets";
import { Sheet, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Pediatric alerts on Today. Plain and calm, always saying who to call. The
 * urgent tiers (911 / call now / call today) stay until someone taps "We
 * called", which marks it handled for the whole family and notes the call in
 * the log. Softer tiers can be dismissed. There is never an "all clear" card:
 * no alerts renders nothing.
 */

const URGENT: AlertTier[] = ["emergency", "now", "today"];
const NUDGE_KEY = "maple-nudges-dismissed";

/**
 * 911 red: solid in every look, night included (dimmed, never folded into
 * the amber), so an emergency never reads like anything else on the page.
 */
export const EMERGENCY_FILL = "bg-[#9B2419] text-white [.maple-night_&]:bg-[#6E1A12] [.maple-night_&]:text-[#F6CBBE]";

/**
 * Each tier looks unmistakably different, loudest first: 911 is a solid red
 * card, "call now" a red wash, "call today" an amber wash, and the two soft
 * tiers are plain cards with a colored mark. Tier colors are information, so
 * "today" carries its own amber for dark and night (no token for it).
 */
const STYLE: Record<
  AlertTier,
  {
    icon: IconName;
    card: string;
    /** The tier label and its icon. */
    mark: string;
    /** Title and body text. */
    ink: string;
    body: string;
    /** The main action (call, log). */
    solid: string;
    /** Everything else (after-hours, we called, got it). */
    soft: string;
  }
> = {
  emergency: {
    icon: "siren",
    card: cx("border-transparent", EMERGENCY_FILL),
    mark: "",
    ink: "",
    body: "opacity-90",
    solid: "bg-white text-[#8A1F15] [.maple-night_&]:bg-[#E9A898] [.maple-night_&]:text-[#4A0F0A]",
    soft: "bg-white/15 hover:bg-white/20 [.maple-night_&]:bg-[#F6CBBE]/15",
  },
  now: {
    icon: "phone",
    // Washes are mixed into the card surface (not see-through) so they stay clean on the paper.
    card: cx(
      "border-mp-danger/40 bg-[color-mix(in_srgb,var(--mp-danger)_9%,var(--mp-surface))] dark:bg-[color-mix(in_srgb,var(--mp-danger)_13%,var(--mp-surface))]",
      // At night the amber "today" sits close by, so "now" leans harder on its red.
      "[.maple-night_&]:border-mp-danger/55 [.maple-night_&]:bg-[color-mix(in_srgb,var(--mp-danger)_15%,var(--mp-surface))]"
    ),
    mark: "text-mp-danger",
    ink: "text-mp-ink",
    body: "text-mp-ink",
    solid: "bg-mp-danger text-mp-surface [.maple-night_&]:bg-mp-danger/20 [.maple-night_&]:text-mp-danger",
    soft: "bg-mp-ink/[0.06] text-mp-ink hover:bg-mp-ink/10",
  },
  today: {
    icon: "calendar-clock",
    card: cx(
      "border-[#D9822B]/45 bg-[color-mix(in_srgb,#D9822B_10%,var(--mp-surface))]",
      "dark:border-[#EBA35C]/35 dark:bg-[color-mix(in_srgb,#EBA35C_12%,var(--mp-surface))]",
      "[.maple-night_&]:border-[#E0A93B]/30 [.maple-night_&]:bg-[color-mix(in_srgb,#E0A93B_7%,var(--mp-surface))]"
    ),
    mark: "text-[#A35A0C] dark:text-[#EBA35C] [.maple-night_&]:text-[#E8A23F]",
    ink: "text-mp-ink",
    body: "text-mp-ink",
    solid: "bg-mp-accent text-mp-on-accent",
    soft: "bg-mp-ink/[0.06] text-mp-ink hover:bg-mp-ink/10",
  },
  mention: {
    icon: "stethoscope",
    card: "border-mp-line bg-mp-surface",
    mark: "text-mp-accent-fg",
    ink: "text-mp-ink",
    body: "text-mp-ink-2",
    solid: "bg-mp-accent text-mp-on-accent",
    soft: "bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
  },
  nudge: {
    icon: "bell",
    card: "border-mp-line bg-mp-surface",
    mark: "text-mp-ink-2",
    ink: "text-mp-ink",
    body: "text-mp-ink-2",
    solid: "bg-mp-accent text-mp-on-accent",
    soft: "bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
  },
};

/**
 * A tier's icon and colored ink on a plain card (a group heading, a label),
 * for the alert look outside an alert card. 911's own card is solid red, so
 * on a plain card its ink is the danger red.
 */
export function tierMark(tier: AlertTier): { icon: IconName; className: string } {
  return { icon: STYLE[tier].icon, className: tier === "emergency" ? "text-mp-danger" : STYLE[tier].mark };
}

/** The "call now" wash (border and tinted surface), for a card that sits beside the 911 path. */
export const NOW_WASH = STYLE.now.card;

const BTN =
  "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 text-[15px] font-semibold transition active:scale-[0.98]";

function readNudges(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(NUDGE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

/** The alert's kind without any episode suffix: "no-pee-8h:123" → "no-pee-8h". */
const alertKind = (id: string) => id.split(":")[0];

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

export function usePhones() {
  const { state } = useMaple();
  const s = (state?.baby.settings ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.replace(/\D/g, "").length >= 3 ? v.trim() : null);
  return { pediatrician: str(s.pediatrician_phone), afterHours: str(s.after_hours_phone) };
}

/**
 * The alerts in the given tiers. Nudges are dismissed per occurrence (a feed-gap
 * nudge comes back after the next feed), on this phone only.
 */
export default function AlertStack({ tiers, onNavigate }: { tiers: AlertTier[]; onNavigate: (t: TabId) => void }) {
  const { summary, state, now } = useMaple();
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [nudges, setNudges] = useState<Record<string, number>>({});
  useEffect(() => setNudges(readNudges()), []);
  if (!summary || !state) return null;

  const tz = state.baby.timezone ?? DEFAULT_TZ;
  // Episode alerts carry their own suffix ("feed-gap:123"); older plain ids get one here.
  const nudgeKey = (a: Alert) => {
    if (a.id.includes(":")) return a.id;
    const base = alertKind(a.id);
    if (base === "feed-gap" || base === "few-feeds") return `${a.id}:${summary.lastFeed?.id ?? 0}`;
    if (base === "vitamin-d") return `${a.id}:${dayKey(new Date(summary.now), tz)}`;
    return a.id;
  };
  const shown = summary.alerts.filter(
    (a) => tiers.includes(a.tier) && !handled.has(a.id) && !(a.tier === "nudge" && nudges[nudgeKey(a)])
  );

  const dismissNudge = (a: Alert) => {
    const t = now().getTime();
    const next = { ...readNudges(), [nudgeKey(a)]: t };
    for (const [k, v] of Object.entries(next)) if (v < t - 4 * 86_400_000) delete next[k];
    try {
      localStorage.setItem(NUDGE_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: dismissed until reload
    }
    setNudges(next);
  };

  if (!shown.length) return null;
  return (
    <div className="space-y-3">
      <AnimatePresence initial={false}>
        {shown.map((a) => (
          <AlertCard
            key={a.id}
            alert={a}
            onHandled={() => setHandled((h) => new Set(h).add(a.id))}
            onDismissNudge={() => dismissNudge(a)}
            onNavigate={onNavigate}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

function AlertCard({
  alert,
  onHandled,
  onDismissNudge,
  onNavigate,
  audience = "baby",
}: {
  alert: Alert;
  onHandled: () => void;
  onDismissNudge: () => void;
  onNavigate: (t: TabId) => void;
  /**
   * "mom": her own card. The label says her OB (MOM_TIER_LABEL), the call is
   * her OB from her care settings, and nothing is noted in Maple's log.
   */
  audience?: "baby" | "mom";
}) {
  const { api, log, now, refresh, toast, readOnly: viewer, state } = useMaple();
  const { open } = useSheets();
  const mom = audience === "mom";
  const babyPhones = usePhones();
  const team = state?.care?.settings.care_team;
  const momPhone = (v: string | undefined) => (v && v.replace(/\D/g, "").length >= 3 ? v.trim() : null);
  const phones = mom ? { pediatrician: momPhone(team?.ob), afterHours: momPhone(team?.after_hours) } : babyPhones;
  // "We called", "Got it" and Log Vitamin D all write to Maple's log or settings: never for one of her cards.
  const readOnly = viewer || mom;
  const st = STYLE[alert.tier];
  const urgent = URGENT.includes(alert.tier);
  const emergency = alert.tier === "emergency";
  const entry = !mom && alert.entryId ? state?.entries.find((e) => e.id === alert.entryId) : undefined;

  const ack = async (note: boolean) => {
    onHandled();
    try {
      await api("baby", { method: "PATCH", body: JSON.stringify({ settings: { acks: { [alert.id]: now().toISOString() } } }) });
      if (note) {
        await log(
          { kind: "note", data: { tag: "other" }, note: `${emergency ? "Called 911" : "Called the pediatrician"} about: ${alert.title}` },
          { silent: true }
        );
        toast("Marked as handled and noted in the log");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
    } finally {
      void refresh();
    }
  };

  // The call gets its own full-width row; the rest line up beneath it ("See the entry" sits up top).
  const call: { href: string; label: string } | null = emergency
    ? { href: "tel:911", label: "Call 911" }
    : urgent && phones.pediatrician
      ? { href: telHref(phones.pediatrician), label: mom ? "Call your OB" : "Call pediatrician" }
      : null;

  const rest: ReactNode[] = [];
  if (urgent && phones.afterHours) {
    rest.push(
      <a key="after" href={telHref(phones.afterHours)} className={cx(BTN, st.soft)}>
        <Icon name="phone" size={17} />
        After-hours line
      </a>
    );
  }
  if (urgent && !readOnly) {
    rest.push(
      <button key="called" type="button" onClick={() => void ack(true)} className={cx(BTN, st.soft)}>
        <Icon name="check" size={18} strokeWidth={2.25} />
        We called
      </button>
    );
  }
  if (alertKind(alert.id) === "vitamin-d" && !readOnly) {
    rest.push(
      <button
        key="vitd"
        type="button"
        onClick={() => void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops logged" })}
        className={cx(BTN, st.solid)}
      >
        Log Vitamin D
      </button>
    );
  }
  if (alert.tier === "mention" && !readOnly) {
    rest.push(
      <button key="ok" type="button" onClick={() => void ack(false)} className={cx(BTN, st.soft)}>
        Got it
      </button>
    );
  }
  if (alert.tier === "nudge") {
    rest.push(
      <button key="ok" type="button" onClick={onDismissNudge} className={cx(BTN, st.soft)}>
        Got it
      </button>
    );
  }

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      // The stack's gap is each card's bottom margin (Tailwind v4 space-y), so fold that and the padding away too.
      exit={{ opacity: 0, height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }}
      role={urgent ? "alert" : "status"}
      className={cx("overflow-hidden rounded-[20px] border p-4", st.card)}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cx("flex min-w-0 items-center gap-1.5 text-[13px] font-semibold", st.mark)}>
          <Icon name={st.icon} size={16} strokeWidth={2} className="shrink-0" />
          {(mom ? MOM_TIER_LABEL : TIER_LABEL)[alert.tier]}
        </p>
        {entry && !readOnly && (
          <button
            type="button"
            onClick={() => open({ kind: entry.kind, entry })}
            className={cx("-my-3 -mr-2 inline-flex min-h-[44px] shrink-0 items-center gap-0.5 px-2 text-[13px] font-semibold", emergency ? "opacity-90" : "text-mp-accent-fg")}
          >
            See the entry
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </div>
      <h3 className={cx("mt-1.5 text-[17px] leading-snug font-semibold", st.ink)}>{alert.title}</h3>
      <p className={cx("mt-1 text-[15px] leading-relaxed", st.body)}>{alert.body}</p>

      {(call || rest.length > 0) && (
        <div className="mt-3.5 space-y-2">
          {call && (
            <a href={call.href} className={cx(BTN, "min-h-[48px] w-full", st.solid)}>
              <Icon name="phone" size={18} />
              {call.label}
            </a>
          )}
          {rest.length > 0 && <div className="flex flex-wrap gap-2">{rest}</div>}
        </div>
      )}
      {urgent && !emergency && !mom && !phones.pediatrician && (
        <button
          type="button"
          onClick={() => onNavigate("family")}
          className="-mb-2 mt-1 min-h-[44px] py-2.5 text-left text-[13px] font-semibold text-mp-accent-fg"
        >
          Add your pediatrician&apos;s number for one-tap{" "}
          {/* The chevron stays with the last word rather than wrapping on its own. */}
          <span className="whitespace-nowrap">
            calling
            <Icon name="chevron-right" size={14} className="ml-0.5 inline align-[-2px]" />
          </span>
        </button>
      )}
    </motion.section>
  );
}

/** The always-there footer: "When to call 911" and the disclaimer. */
export function EmergencyHelp() {
  const [open, setOpen] = useState(false);
  const phones = usePhones();
  const numbers = [
    phones.pediatrician && { label: "Pediatrician", phone: phones.pediatrician },
    phones.afterHours && { label: "After hours", phone: phones.afterHours },
  ].filter((n): n is { label: string; phone: string } => !!n);

  // One wrapper, so the (fixed) sheet never picks up the page's space-y margins,
  // and the sheet outside the centered footer so its text stays left-aligned.
  return (
    <div>
      <div className="px-2 text-center">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[15px] font-semibold text-mp-danger"
        >
          <Icon name="siren" size={18} />
          When to call 911
        </button>
        <p className={cx(tone.faint, "mx-auto max-w-xs text-[12px] leading-snug")}>{DISCLAIMER}</p>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="When to call 911">
        <p className={cx(tone.body, "text-[17px] leading-relaxed")}>{EMERGENCY_SIGNS}</p>
        <a
          href="tel:911"
          className={cx("flex min-h-[56px] items-center justify-center gap-2 rounded-[14px] text-[17px] font-semibold active:scale-[0.98]", EMERGENCY_FILL)}
        >
          <Icon name="phone" size={20} />
          Call 911
        </a>
        {numbers.length > 0 && (
          <div className={cx(tone.card, tone.divide, "overflow-hidden")}>
            {numbers.map((n) => (
              <a key={n.label} href={telHref(n.phone)} className={cx(tone.row, "min-h-[56px] py-2.5")}>
                <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
                <span className={cx(tone.body, "flex-1 text-[15px] font-medium")}>{n.label}</span>
                <span className={cx(tone.muted, "text-[15px] tabular-nums")}>{n.phone}</span>
              </a>
            ))}
          </div>
        )}
        <p className={cx(tone.faint, "px-1 text-[13px] leading-snug")}>For anything else that worries you, call your pediatrician. {DISCLAIMER}</p>
      </Sheet>
    </div>
  );
}

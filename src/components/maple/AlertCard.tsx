"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { DISCLAIMER, EMERGENCY_SIGNS, TIER_LABEL, VITAMIN_D_DEFAULT, type AlertTier } from "@/lib/maple/guidelines";
import type { Alert } from "@/lib/maple/insights";
import { dayKey, DEFAULT_TZ } from "@/lib/maple/time";
import type { TabId } from "./MapleApp";
import { useSheets } from "./sheets";
import { Sheet, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Pediatric alerts on Today. Plain and calm, always saying who to call. The
 * urgent tiers (911 / call now / call today) stay until someone taps "We
 * called ✓", which marks it handled for the whole family and notes the call in
 * the log. Softer tiers can be dismissed. There is never an "all clear" card:
 * no alerts renders nothing.
 */

const URGENT: AlertTier[] = ["emergency", "now", "today"];
const NUDGE_KEY = "maple-nudges-dismissed";

const STYLE: Record<AlertTier, { card: string; pill: string; icon: string }> = {
  emergency: {
    card: "bg-[#7A1F1A] text-white border-[#7A1F1A] shadow-[0_6px_24px_rgba(122,31,26,0.35)]",
    pill: "bg-white text-[#7A1F1A]",
    icon: "🚨",
  },
  now: {
    card: "bg-[#FBEDE8] border-[#B5452B]/60 text-[#5A1E12] dark:bg-[#3A1A14] dark:border-[#E07A5F]/50 dark:text-[#F8DCD3]",
    pill: "bg-[#B5452B] text-white",
    icon: "📞",
  },
  today: {
    card: "bg-[#FCF1E4] border-[#D9772B]/50 text-[#5A3210] dark:bg-[#33240F] dark:border-[#D9772B]/45 dark:text-[#F5E2C8]",
    pill: "bg-[#D9772B] text-white",
    icon: "📞",
  },
  mention: {
    card: "bg-[#EEF3E8] border-[#5C7A4A]/35 text-[#24361C] dark:bg-[#18281A] dark:border-[#A9C08F]/30 dark:text-[#DDE8D0]",
    pill: "bg-[#5C7A4A]/15 text-[#2E4A22] dark:bg-[#A9C08F]/20 dark:text-[#CFE0BC]",
    icon: "🩺",
  },
  nudge: {
    card: "bg-[#FBF5E6] border-[#C49A3C]/35 text-[#4A3A12] dark:bg-[#2A2410] dark:border-[#C49A3C]/30 dark:text-[#F0E3C0]",
    pill: "bg-[#C49A3C]/20 text-[#6E5210] dark:bg-[#C49A3C]/25 dark:text-[#E9CF8C]",
    icon: "🍂",
  },
};

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
}: {
  alert: Alert;
  onHandled: () => void;
  onDismissNudge: () => void;
  onNavigate: (t: TabId) => void;
}) {
  const { api, log, now, refresh, toast, readOnly, state } = useMaple();
  const { open } = useSheets();
  const phones = usePhones();
  const st = STYLE[alert.tier];
  const urgent = URGENT.includes(alert.tier);
  const emergency = alert.tier === "emergency";
  const entry = alert.entryId ? state?.entries.find((e) => e.id === alert.entryId) : undefined;

  const ack = async (note: boolean) => {
    onHandled();
    try {
      await api("baby", { method: "PATCH", body: JSON.stringify({ settings: { acks: { [alert.id]: now().toISOString() } } }) });
      if (note) {
        await log(
          { kind: "note", data: { tag: "other" }, note: `${emergency ? "Called 911" : "Called the pediatrician"} about: ${alert.title}` },
          { silent: true }
        );
        toast("Marked as handled and noted in the log", { emoji: "✓" });
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
    } finally {
      void refresh();
    }
  };

  const btn = "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full px-4 text-[15px] font-semibold transition active:scale-[0.97]";
  const solid = emergency ? "bg-white text-[#7A1F1A]" : "bg-[#1D4420] text-[#FDF8F0] dark:bg-[#F5EDDF] dark:text-[#14210F]";
  const soft = emergency ? "bg-white/15 text-white" : "bg-black/[0.06] dark:bg-white/10";

  return (
    <motion.section
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      role={urgent ? "alert" : "status"}
      className={cx("overflow-hidden rounded-3xl border p-4", st.card)}
    >
      <span className={cx("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold tracking-wide uppercase", st.pill)}>
        <span aria-hidden>{st.icon}</span>
        {TIER_LABEL[alert.tier]}
      </span>
      <h3 className="mt-2 text-[17px] leading-snug font-bold">{alert.title}</h3>
      <p className="mt-1 text-[15px] leading-relaxed opacity-90">{alert.body}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {emergency && (
          <a href="tel:911" className={cx(btn, solid)}>
            📞 Call 911
          </a>
        )}
        {urgent && !emergency && phones.pediatrician && (
          <a href={telHref(phones.pediatrician)} className={cx(btn, solid)}>
            📞 Call pediatrician
          </a>
        )}
        {urgent && phones.afterHours && (
          <a href={telHref(phones.afterHours)} className={cx(btn, soft)}>
            After-hours line
          </a>
        )}
        {urgent && !readOnly && (
          <button type="button" onClick={() => void ack(true)} className={cx(btn, soft)}>
            We called ✓
          </button>
        )}
        {alertKind(alert.id) === "vitamin-d" && !readOnly && (
          <button
            type="button"
            onClick={() => void log({ kind: "med", data: { ...VITAMIN_D_DEFAULT } }, { toast: "Vitamin D drops ✓", emoji: "☀️" })}
            className={cx(btn, solid)}
          >
            Log Vitamin D
          </button>
        )}
        {alert.tier === "mention" && !readOnly && (
          <button type="button" onClick={() => void ack(false)} className={cx(btn, soft)}>
            Got it
          </button>
        )}
        {alert.tier === "nudge" && (
          <button type="button" onClick={onDismissNudge} className={cx(btn, soft)}>
            Got it
          </button>
        )}
        {entry && !readOnly && (
          <button type="button" onClick={() => open({ kind: entry.kind, entry })} className={cx(btn, "px-3 underline-offset-2 opacity-80 hover:underline")}>
            See the entry
          </button>
        )}
      </div>
      {urgent && !emergency && !phones.pediatrician && (
        <button type="button" onClick={() => onNavigate("family")} className="mt-2 text-[13px] font-semibold underline underline-offset-2 opacity-80">
          Add your pediatrician&apos;s number for one-tap calling
        </button>
      )}
    </motion.section>
  );
}

/** The always-there footer: "When to call 911" and the disclaimer. */
export function EmergencyHelp() {
  const [open, setOpen] = useState(false);
  const phones = usePhones();
  return (
    <div className="px-2 text-center">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-[#9A3A24] underline-offset-2 hover:underline dark:text-[#F4A68F]"
      >
        <span aria-hidden>🚑</span> When to call 911
      </button>
      <p className={cx(tone.muted, "mx-auto max-w-xs text-[12px] leading-snug")}>{DISCLAIMER}</p>
      <Sheet open={open} onClose={() => setOpen(false)} title="When to call 911" emoji="🚑">
        <p className={cx(tone.body, "text-[16px] leading-relaxed")}>{EMERGENCY_SIGNS}</p>
        <div className="flex flex-col gap-2">
          <a href="tel:911" className="flex min-h-[56px] items-center justify-center gap-2 rounded-full bg-[#7A1F1A] text-lg font-bold text-white active:scale-[0.98]">
            📞 Call 911
          </a>
          {phones.pediatrician && (
            <a
              href={telHref(phones.pediatrician)}
              className="flex min-h-[52px] items-center justify-center gap-2 rounded-full bg-[#1D4420]/[0.08] text-base font-semibold text-[#1D4420] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
            >
              📞 Pediatrician · {phones.pediatrician}
            </a>
          )}
          {phones.afterHours && (
            <a
              href={telHref(phones.afterHours)}
              className="flex min-h-[52px] items-center justify-center gap-2 rounded-full bg-[#1D4420]/[0.08] text-base font-semibold text-[#1D4420] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
            >
              📞 After hours · {phones.afterHours}
            </a>
          )}
        </div>
        <p className={cx(tone.muted, "text-sm")}>For anything else that worries you, call your pediatrician. {DISCLAIMER}</p>
      </Sheet>
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { type CareNote, type CareNoteCtx, type PlanTextCtx, careTime, loggedBy, unitCount, unitsOf, viaText } from "@/lib/maple/care";
import { overDailyMax, type Assessment } from "@/lib/maple/guidelines";
import { DEFAULT_TZ, formatTime } from "@/lib/maple/time";
import type { CarePlan, DoseEntry, LimitUnit } from "@/lib/maple/types";
import { Icon, type IconName } from "../icons";
import { AssessmentCard } from "../sheets/parts";
import { Button, Sheet, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import type { UseCare } from "./useCare";

/**
 * Small pieces shared by mom's medicine screens (B): list rows in the Family
 * tab's inset-grouped style, the switch, "Took it", unit words, who-logged
 * text, notes with their dismiss button, and a plain confirm sheet. Nothing
 * here decides a number: units and counts come from her plan through care.ts.
 */

/** A list card: rows separated by hairlines (as in Family). */
export const GROUP = cx(tone.card, tone.divide, "overflow-hidden");

export function Footnote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug", className)}>{children}</p>;
}

/** An iOS-style switch (Family's): a 44px target around the 51×31 track; at night on is filled and off is hollow. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="-my-1.5 flex h-11 shrink-0 items-center disabled:opacity-40"
    >
      <span
        className={cx(
          "relative block h-[31px] w-[51px] rounded-full transition-colors",
          checked ? "bg-mp-accent [.maple-night_&]:bg-[rgb(224_169_59/0.3)]" : "bg-mp-sunken ring-1 ring-mp-line ring-inset [.maple-night_&]:bg-transparent"
        )}
      >
        <span
          className={cx(
            "absolute top-[2px] left-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.18)] transition-transform",
            checked
              ? "translate-x-5 [.maple-night_&]:bg-mp-on-accent"
              : "[.maple-night_&]:bg-transparent [.maple-night_&]:shadow-[inset_0_0_0_2px_rgb(224_169_59/0.5)]"
          )}
        />
      </span>
    </button>
  );
}

/** A label (and optional note) with a switch on the right. */
export function SwitchRow({
  label,
  note,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  note?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className={cx(tone.body, "text-[15px]")}>{label}</div>
        {note && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{note}</p>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** A tappable row that goes somewhere: an icon, a label, an optional note and value, and a chevron. */
export function NavRow({
  icon,
  iconColor,
  label,
  note,
  value,
  onClick,
  accent,
  danger,
  chevron = true,
}: {
  icon?: IconName;
  /** A kind color for the icon (worn through mp-kind-ink, so it folds to amber at night). */
  iconColor?: string;
  label: ReactNode;
  note?: ReactNode;
  value?: ReactNode;
  onClick: () => void;
  /** Accent text: an action ("Something else"), not a place. */
  accent?: boolean;
  danger?: boolean;
  chevron?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} className={cx(tone.row, "min-h-[52px] py-2.5")}>
      {icon && (
        <Icon
          name={icon}
          size={20}
          className={cx("shrink-0", iconColor ? "mp-kind-ink" : danger ? "text-mp-danger" : accent ? "text-mp-accent-fg" : "text-mp-ink-2")}
          style={iconColor ? { color: iconColor } : undefined}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[15px]", danger ? "font-medium text-mp-danger" : accent ? "font-medium text-mp-accent-fg" : "text-mp-ink")}>{label}</span>
        {note && <span className={cx(tone.muted, "mt-0.5 block text-[13px] leading-snug")}>{note}</span>}
      </span>
      {value != null && <span className={cx(tone.muted, "shrink-0 text-[15px] tabular-nums")}>{value}</span>}
      {chevron && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
    </button>
  );
}

/**
 * The trailing "Took it": a 36px accent pill inside a 44px target, like
 * vitamin D's "Log" on Today. `busy` holds it while the tap is out.
 */
export function TookItButton({ onClick, busy, label = "Took it", className }: { onClick: () => void; busy?: boolean; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cx("-my-1 flex min-h-[44px] shrink-0 items-center disabled:opacity-50", className)}
    >
      <span className="inline-flex min-h-[36px] items-center gap-1.5 rounded-[10px] bg-mp-accent px-3.5 text-sm font-semibold whitespace-nowrap text-mp-on-accent active:scale-[0.97]">
        {label}
      </span>
    </button>
  );
}

// ── Words ────────────────────────────────────────────────────────────────

/** The unit chips' labels, in the plan sheet's order. The units themselves are plural words ("How many caplets this time?"). */
export const UNIT_LABEL: Record<LimitUnit, string> = { tablets: "Tablets", caplets: "Caplets", capsules: "Capsules", doses: "Doses", mL: "mL" };
export const LIMIT_UNITS: LimitUnit[] = ["tablets", "caplets", "capsules", "doses", "mL"];

/** "Matt", "Matt and Sam", "Matt, Sam and Jo". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * One dose as a row reads: "3:05 AM · 2 caplets · Matt", "8:00 PM · skipped".
 * The units are what it counts toward her limit (care.ts unitsOf, counted
 * high when unknown), shown only when the plan counts something.
 */
export function useDoseText() {
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const who = { members: state?.members ?? [], me: state?.me.email };
  /** `noDay`: under a day heading, the clock time alone. */
  return (d: DoseEntry, plan: CarePlan | null, opts: { noDay?: boolean } = {}) => {
    const parts = [opts.noDay ? formatTime(d.at, tz) : careTime(d.at, now(), tz)];
    if (d.data.skipped) parts.push("skipped");
    else if (plan?.limit_unit && plan.max_24h != null) parts.push(unitCount(unitsOf(d, plan), plan.limit_unit));
    else if (d.data.units != null && d.data.unit) parts.push(unitCount(d.data.units, d.data.unit));
    parts.push(loggedBy(d.created_by, who) + viaText(d.source));
    return parts.join(" · ");
  };
}

/** The over-limit card (overDailyMax) is the one that shows the 24-hour list under it. */
export const OVER_LIMIT_LABEL = overDailyMax("", "", "").label;
export const isOverLimit = (a: Assessment) => a.label === OVER_LIMIT_LABEL;

/** The engine contexts every care.ts text and note call needs, for this reader. */
export function useCareCtx(care: UseCare): PlanTextCtx & CareNoteCtx & { tz: string } {
  const { state, now } = useMaple();
  return {
    now: now(),
    tz: state?.baby.timezone ?? DEFAULT_TZ,
    self: care.self,
    members: state?.members ?? [],
    me: state?.me.email,
    name: care.name,
    settings: care.state.settings,
  };
}

/**
 * A guidelines.ts note in the alert card style (who to call is her OB), with
 * its dismiss button when it has one ("Got it", "It's part of my plan"),
 * which records the ack in her settings.
 */
export function NoteCard({ note, care, className }: { note: CareNote | Assessment; care: UseCare; className?: string }) {
  const [busy, setBusy] = useState(false);
  const n = note as CareNote;
  return (
    <div className={className}>
      <AssessmentCard a={note} audience="mom" />
      {n.dismiss && n.key && care.access.write && (
        <div className="mt-1.5 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await care.act.patchPerson({ settings: { acks: { ...(care.state.settings.acks ?? {}), [n.key]: new Date().toISOString() } } });
              } finally {
                setBusy(false);
              }
            }}
          >
            {n.dismiss}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A two-button confirm as a short sheet ("Stop Ibuprofen?", "Delete everything here for good?"). */
export function ConfirmSheet({
  open,
  onClose,
  title,
  body,
  confirm,
  onConfirm,
  danger,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: ReactNode;
  confirm: string;
  onConfirm: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex gap-3">
          <Button variant="soft" size="lg" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} size="lg" className="flex-1" onClick={onConfirm} disabled={busy}>
            {confirm}
          </Button>
        </div>
      }
    >
      <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{body}</p>
    </Sheet>
  );
}

/**
 * A failed care write, as a line for the sheet: the server's own words for a
 * 4xx (useCare rejects with them), else a plain retry line (network, 5xx).
 */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status < 500 && e.message && !/^Request failed/.test(e.message) ? e.message : RETRY;
  if (e instanceof Error && !(e instanceof TypeError) && e.message) return e.message;
  return RETRY;
}
const RETRY = "That didn't save. Check the connection and try again.";

/** An inline problem under a field or above a footer, in danger ink. */
export function Problem({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cx("mt-1.5 text-[13px] font-semibold text-mp-danger", className)}>
      {children}
    </p>
  );
}

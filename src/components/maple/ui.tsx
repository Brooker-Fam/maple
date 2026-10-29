"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Member } from "@/lib/maple/types";
export { Field, parseTypedNumber, useTypedNumber, NumberProblem, Stepper, WhenField, resolveWallTime, RepeatButton, TimeScrubber, TimeRange, TextArea } from "./uiFields";
export { Sheet, useSheetArmed } from "./Sheet";
import { subscribeSlots, topSlot, noSlot } from "./sheetSlots";
import { Icon, type IconName } from "./icons";
import { useNightActive } from "./nightLook";
import { useMaple, type Toast } from "./useMaple";

/**
 * Small UI kit for Maple's Log. Big tap targets (≥ 44px), quiet surfaces,
 * color only where it means something. Colors come from the mp-* tokens
 * (src/app/maple/maple.css), which also carry dark mode and the night look,
 * so nothing here needs a dark: variant. Icons come from ./icons, never
 * emoji. Other maple components should build from these so the app feels
 * like one thing.
 */

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Shared class strings. */
export const tone = {
  /** A white card on the paper background. No outline by day; a hairline in dark and at night, where surface on bg is too close to see (--mp-edge). */
  card: "rounded-[20px] border border-(--mp-edge) bg-mp-surface",
  /** A well inside a card or sheet (time scrubber, disclosure). */
  inset: "rounded-2xl bg-mp-sunken",
  /** Section and sheet titles: the UI sans, semibold. */
  heading: "font-semibold tracking-[-0.01em] text-mp-ink",
  /** Page titles and her name only: the display serif. */
  display: "font-[family-name:var(--font-display)] font-semibold tracking-[-0.01em] text-mp-ink",
  body: "text-mp-ink",
  muted: "text-mp-ink-2",
  faint: "text-mp-ink-3",
  /** Field labels: sentence case, not shouting. */
  label: "text-[13px] font-medium text-mp-ink-2",
  input:
    "w-full rounded-xl border border-mp-line bg-mp-surface px-3.5 py-3 text-base text-mp-ink outline-none transition placeholder:text-mp-ink-3 focus:border-mp-focus focus:ring-2 focus:ring-mp-focus/25",
  /** A tappable row inside a list card. */
  row: "flex w-full items-center gap-3 px-4 text-left transition active:bg-mp-ink/[0.04]",
  /** Hairline dividers between rows (use on the list container). */
  divide: "divide-y divide-mp-line",
};

// ── Buttons ──────────────────────────────────────────────────────────────

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "soft" | "ghost" | "danger" | "gold";
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "aria-controls"?: string;
};

export function Button({ children, onClick, variant = "primary", size = "md", type = "button", disabled, className, ...rest }: ButtonProps) {
  const v = {
    primary: "bg-mp-accent text-mp-on-accent hover:opacity-90",
    // "gold" was the celebratory variant; one primary color keeps the app calm.
    gold: "bg-mp-accent text-mp-on-accent hover:opacity-90",
    soft: "bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
    ghost: "text-mp-accent-fg hover:bg-mp-ink/5",
    danger: "bg-mp-danger/10 text-mp-danger hover:bg-mp-danger/15",
  }[variant];
  const s = {
    sm: "min-h-[44px] rounded-[10px] px-3 text-sm",
    md: "min-h-[44px] rounded-xl px-4 text-[15px]",
    lg: "min-h-[52px] rounded-[14px] px-5 text-base",
  }[size];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      aria-pressed={rest["aria-pressed"]}
      aria-expanded={rest["aria-expanded"]}
      aria-controls={rest["aria-controls"]}
      className={cx(
        "mp-control inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100",
        v,
        s,
        className
      )}
    >
      {children}
    </button>
  );
}

export function Chip({
  children,
  selected,
  onClick,
  color,
  raised,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  /** Accent hex for the selected state. */
  color?: string;
  /** Sitting on a sunken well (the time scrubber): give it a surface so it still reads as a chip. */
  raised?: boolean;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={ariaLabel}
      style={selected && color ? { backgroundColor: color, borderColor: color } : undefined}
      className={cx(
        "mp-control inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100",
        selected
          ? color
            ? "mp-kind-fill text-white"
            : "border-mp-accent bg-mp-accent text-mp-on-accent"
          : raised
            ? "border-mp-line bg-mp-raised text-mp-ink hover:bg-mp-ink/5"
            : "border-transparent bg-mp-sunken text-mp-ink hover:bg-mp-ink/10",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div className={cx("flex flex-wrap rounded-xl bg-mp-sunken p-[2px]", className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o, index) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value || (!options.some((option) => option.value === value) && index === 0) ? 0 : -1}
          onKeyDown={(event) => {
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
              : event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % options.length
              : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + options.length - 1) % options.length : null;
            if (next === null) return;
            event.preventDefault();
            onChange(options[next].value);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
          }}
          onClick={() => onChange(o.value)}
          className={cx(
            "mp-control min-h-[44px] flex-1 rounded-[10px] px-3 text-sm transition",
            value === o.value
              ? "bg-mp-raised font-semibold text-mp-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
              : "font-medium text-mp-ink-2"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(tone.card, "p-4", className)}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-[28px] items-center justify-between gap-3 px-1">
      <h2 className={cx(tone.heading, "text-[17px]")}>{children}</h2>
      {action}
    </div>
  );
}

/**
 * One color per person, for their initial disc and their share of the diaper
 * bar. Sage first (Matt's green suit); none of them is a kind's hue, so a
 * person never reads as a feed or a diaper.
 */
export const MEMBER_PALETTE = ["#5C7A4A", "#8C4A5E", "#4E6E7E", "#6E6A3A", "#5A5F78"];

/** A member's own color if they set one, otherwise their place in the family list picks one from MEMBER_PALETTE. */
export function memberColor(m: Pick<Member, "email" | "color"> | null, members: Member[]): string {
  if (m?.color) return m.color;
  // By the order people joined, leaving out the shared admin login (so the first family member is sage); someone no
  // longer in the list gets a neutral, never another person's colour.
  const i = members.filter((x) => x.email !== "admin").findIndex((x) => x.email === m?.email);
  return i < 0 ? "rgb(110 117 105)" : MEMBER_PALETTE[i % MEMBER_PALETTE.length];
}

/**
 * Who logged it: their initial on their color. At 24px and up a member's own
 * emoji shows instead if they picked one; smaller than that it's always the
 * initial (an emoji at 16px is a smudge, and a grey one at night).
 */
export function Avatar({ member, size = 28 }: { member: Member | null; size?: number }) {
  const { state } = useMaple();
  const name = member?.display_name ?? member?.email ?? "";
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const emoji = size >= 24 ? member?.emoji : null;
  return (
    <span
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        // Emoji keep their own colors, so they're dimmed at night like photos.
        emoji ? "bg-mp-sunken [.maple-night_&]:opacity-60 [.maple-night_&]:grayscale-[40%]" : "mp-kind-fill text-white"
      )}
      style={{
        width: size,
        height: size,
        fontSize: emoji ? size * 0.55 : size * 0.45,
        backgroundColor: emoji ? undefined : memberColor(member, state?.members ?? []),
      }}
      aria-hidden
    >
      {emoji || initial}
    </span>
  );
}

/** A chart's explanation, one tap away: "How to read this", closed by default. */
export function HowToRead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <details className={cx("group/how px-1", className)}>
      <summary className="-ml-1 inline-flex min-h-[44px] cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-mp-ink-2 outline-none focus-visible:ring-2 focus-visible:ring-mp-focus/60 [&::-webkit-details-marker]:hidden">
        <Icon name="info" size={15} className="text-mp-ink-3" />
        How to read this
        <Icon name="chevron-down" size={15} className="text-mp-ink-3 transition group-open/how:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className={cx(tone.muted, "space-y-2 pb-2 text-[13px] leading-snug")}>{children}</div>
    </details>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-6 py-10 text-center">
      {icon && (
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-3">
          <Icon name={icon} size={24} />
        </span>
      )}
      <p className={cx(tone.heading, "text-[17px]")}>{title}</p>
      {children && <div className={cx(tone.muted, "mx-auto mt-1 max-w-[20rem] text-sm")}>{children}</div>}
    </div>
  );
}

/**
 * Toasts pinned above the tab bar, and above Today's logging dock when it's
 * showing (the dock publishes its height as --maple-dock-h) so a toast never
 * covers a button you're about to tap. A toast with chips puts them and its
 * trailing button on one row under the text, so a timer toast stays two
 * lines tall at 375 px and doesn't climb over the card's live clock.
 *
 * While a sheet is open, toasts draw inside it, above its footer (sheetSlots):
 * the ones raised meanwhile, and any error. A confirmation already up when it
 * opened ("Saved", a diaper's color chips) is about something else, so it
 * waits outside and comes back above the dock if it hasn't timed out.
 */
export function ToastHost() {
  const { toasts, dismissToast } = useMaple();
  const night = useNightActive();
  const slot = useSyncExternalStore(subscribeSlots, topSlot, noSlot);
  // Which toasts were already up when this sheet opened (React's "adjust state while rendering" pattern).
  const [opened, setOpened] = useState<{ slot: HTMLElement | null; before: ReadonlySet<number> }>({ slot: null, before: new Set() });
  if (opened.slot !== slot) setOpened({ slot, before: new Set(toasts.map((t) => t.id)) });
  // A locked sheet (the crisis sheet) shows errors only: a "Saved" landing there is the wrong tone and takes its room.
  const inSheet = slot ? toasts.filter((t) => t.tone === "error" || (!opened.before.has(t.id) && slot.dataset.locked === undefined)) : [];
  return (
    <>
      <div
        data-maple-toasts
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--maple-dock-h,0px)+72px+env(safe-area-inset-bottom))] z-[90] flex flex-col items-center gap-2 px-4"
        aria-live="polite"
      >
        <AnimatePresence>
          {!slot &&
            toasts.map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, y: 16, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8 }}
                className={cx("pointer-events-auto w-full max-w-md shadow-[0_8px_30px_rgba(0,0,0,0.18)]", toastLook(t))}
              >
                <ToastBody t={t} dismiss={dismissToast} />
              </motion.div>
            ))}
        </AnimatePresence>
      </div>
      {slot &&
        createPortal(
          <AnimatePresence initial={false}>
            {inSheet.map((t) => (
              // It opens room for itself (at night it just fades in, nothing slides).
              <motion.div
                key={t.id}
                initial={night ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={night ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                exit={night ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="pb-3">
                  <div className={toastLook(t)}>
                    <ToastBody t={t} dismiss={dismissToast} />
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>,
          slot
        )}
    </>
  );
}

const toastLook = (t: Toast) =>
  cx(
    // The card edge token: no ring by day, a hairline in dark mode and at night, where the toast is a dark card over dark cards.
    "rounded-2xl px-4 py-3 text-[15px] ring-1 ring-(--mp-edge)",
    t.tone === "error" ? "bg-[#8A2F1C] text-white [.maple-night_&]:bg-[#2A140C] [.maple-night_&]:text-[#F0A07A]" : "bg-mp-toast text-mp-on-toast"
  );

/**
 * A toast that answers a chip tapped a moment ago (the question's [Left] then "On the Left from 2:17 · Earlier?",
 * a start's [Back and forth]) appears where that toast was, often with its own first chip right under the finger.
 * Its chips wait CHIP_ARM_MS once it shows, so a late second tap on "Left" never lands on "2 min earlier" (the
 * dock's cooldowns don't cover a chip-to-chip chain). Its Undo, and any toast not raised by a chip, answer at once.
 */
const CHIP_CHAIN_MS = 3000;
const CHIP_ARM_MS = 600;
let lastChipTap = -Infinity;

/** A toast's text, chips and trailing button (Undo, "Back to 4:25"). */
function ToastBody({ t, dismiss }: { t: Toast; dismiss: (id: number) => void }) {
  // When it showed, and whether a chip tap just raised it (performance clock: monotonic, like the dock's cooldowns).
  const shown = useRef<{ at: number; chained: boolean } | null>(null);
  useEffect(() => {
    const at = performance.now();
    shown.current = { at, chained: at - lastChipTap < CHIP_CHAIN_MS };
  }, []);
  const undo = t.undo && (
    <button
      type="button"
      onClick={() => {
        t.undo?.();
        dismiss(t.id);
      }}
      className={cx("mp-control min-h-[44px] shrink-0 rounded-full bg-current/15 px-3 text-sm font-semibold whitespace-nowrap", !!t.actions?.length && "ml-auto")}
    >
      {t.undoLabel ?? "Undo"}
    </button>
  );
  return (
    <>
      <div className="flex items-center gap-3">
        {/* A diaper's own mark (drop or pile) says what was saved; everything else gets the check. */}
        <Icon name={t.icon ?? (t.tone === "error" ? "triangle-alert" : t.tone === "info" ? "info" : "circle-check")} size={20} className="shrink-0 opacity-80" />
        <span className="flex-1">{t.text}</span>
        {!t.actions?.length && undo}
      </div>
      {t.actions?.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.actions.map((a) => (
            <button
              key={a.label}
              type="button"
              aria-label={a.ariaLabel ?? (a.sub ? `${a.label}, ${a.sub}` : a.label)}
              onClick={() => {
                const tapped = performance.now();
                const s = shown.current;
                if (s?.chained && tapped - s.at < CHIP_ARM_MS) return;
                lastChipTap = tapped;
                a.onClick();
                dismiss(t.id);
              }}
              className={cx(
                "mp-control inline-flex min-h-[44px] items-center gap-1.5 bg-current/15 font-semibold",
                // A chip with a second line (the time it produces) is a two-line tile.
                a.sub ? "min-w-[72px] flex-col items-start justify-center rounded-xl px-3 py-1 text-left" : "rounded-full px-3 text-xs"
              )}
            >
              {/* mp-swatch: the real colour, dimmed at night, never folded into amber (matching the diaper is the point). */}
              {a.color && <span className="mp-swatch h-4 w-4 rounded-full ring-1 ring-current/40" style={{ backgroundColor: a.color }} aria-hidden />}
              {a.sub ? (
                <>
                  <span className="text-[13px] leading-tight">{a.label}</span>
                  <span className="text-[12px] leading-tight font-medium tabular-nums opacity-80">{a.sub}</span>
                </>
              ) : (
                a.label
              )}
            </button>
          ))}
          {undo}
        </div>
      ) : null}
    </>
  );
}

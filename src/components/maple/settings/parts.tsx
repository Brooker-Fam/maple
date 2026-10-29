"use client";

import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { Button, SectionTitle, cx, tone } from "../ui";

const EMOJIS = ["🌲", "🌸", "🦊", "🍄", "🦉", "🐻", "🐿️", "🦔", "🌻", "🐝", "🦌", "🐞", "🌼", "🌙", "⭐", "🐸", "🪺", "🍂", "🌰", "🍁"];

/** A list card: rows separated by hairlines. */
export const GROUP = cx(tone.card, tone.divide, "overflow-hidden");

/** A borderless input that sits on the right of a row (iOS-style). 16px so iOS doesn't zoom on focus. */
const INLINE_INPUT =
  "min-h-[44px] bg-transparent py-2 text-right text-base text-mp-ink outline-none placeholder:text-mp-ink-3 [&::-webkit-date-and-time-value]:text-right [&::-webkit-datetime-edit]:text-right";

/**
 * Chromium's date-picker glyph ignores the theme (black in dark mode, white at
 * night), so it's redrawn as the calendar line icon in ink-3 via a mask. iOS
 * has no glyph; the picker opens from the field itself.
 */
const DATE_PICKER_ICON =
  "[&::-webkit-calendar-picker-indicator]:bg-none [&::-webkit-calendar-picker-indicator]:bg-mp-ink-3 [&::-webkit-calendar-picker-indicator]:[mask:url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.75%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%202v3M16%202v3M3%209h18%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%2218%22%20height%3D%2218%22%20rx%3D%222%22%2F%3E%3C%2Fsvg%3E)_center/18px_no-repeat]";

/** Quiet destructive text action at the end of a row (Revoke, Sign out, Delete). */
export const DANGER_TEXT =
  "-mr-2 min-h-[44px] shrink-0 rounded-[10px] px-2 text-[15px] font-medium text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.97] disabled:opacity-40";

export function Section({ title, footnote, children, action, id }: { title: string; footnote?: ReactNode; children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className={id ? "scroll-mt-5 outline-none" : undefined} aria-label={id ? title : undefined}>
      <SectionTitle action={action}>{title}</SectionTitle>
      {children}
      {footnote && <Footnote>{footnote}</Footnote>}
    </section>
  );
}

export function Footnote({ children }: { children: ReactNode }) {
  return <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug")}>{children}</p>;
}

/** One settings row: label (and an optional note) on the left, the control on the right. */
export function Row({ label, note, children, className }: { label: ReactNode; note?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-h-[52px] items-center gap-3 px-4 py-2.5", className)}>
      <div className="min-w-0 flex-1">
        <div className={cx(tone.body, "text-[15px]")}>{label}</div>
        {note && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{note}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * A text field as a row: the label on the left, the value typed on the right.
 * With a note, the label and note take the room and the field is short.
 * `after` sits outside the <label> (a link inside a label is invalid).
 */
export function InputRow({
  label,
  note,
  after,
  className,
  ...input
}: { label: string; note?: ReactNode; after?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex items-center gap-1 pr-4 transition focus-within:bg-mp-ink/[0.03]">
      <label className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-1 pl-4">
        <span className={cx("min-w-0", note ? "flex-1 py-1.5" : "shrink-0")}>
          <span className={cx(tone.body, "block text-[15px]")}>{label}</span>
          {note && <span className={cx(tone.muted, "mt-0.5 block text-[13px] leading-snug")}>{note}</span>}
        </span>
        <input
          {...input}
          // A date field sizes to its content and sits right (Chromium won't right-align inside it).
          className={cx(INLINE_INPUT, note ? "w-20 shrink-0" : input.type === "date" ? cx("ml-auto min-w-0", DATE_PICKER_ICON) : "w-full min-w-0 flex-1", className)}
        />
      </label>
      {after}
    </div>
  );
}

export function ActionRow({
  icon,
  label,
  note,
  value,
  chevron,
  onClick,
}: {
  icon: IconName;
  label: string;
  note?: string;
  value?: ReactNode;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={cx(tone.row, "min-h-[52px] py-2.5")}>
      <Icon name={icon} size={20} className={cx("shrink-0", chevron ? "text-mp-ink-2" : "text-mp-accent-fg")} />
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[15px]", chevron ? "text-mp-ink" : "font-medium text-mp-accent-fg")}>{label}</span>
        {note && <span className={cx(tone.muted, "block text-[13px] leading-snug")}>{note}</span>}
      </span>
      {value != null && <span className={cx(tone.muted, "max-w-[40%] truncate text-right text-[14px]")}>{value}</span>}
      {chevron && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
    </button>
  );
}

/** A row that opens and closes the content under it. */
export function Disclosure({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cx(tone.row, "min-h-[52px]")}>
        <span className={cx(tone.body, "shrink-0 text-[15px] font-medium")}>{label}</span>
        <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-right text-sm")}>{summary}</span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", open && "rotate-180")} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older iOS / insecure context: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  return (
    <Button
      variant="soft"
      size="sm"
      className={cx("shrink-0", className)}
      onClick={async () => {
        setState((await copy(text)) ? "done" : "fail");
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "done" ? (
        <>
          <Icon name="check" size={16} strokeWidth={2.25} />
          Copied
        </>
      ) : state === "fail" ? (
        "Press and hold to copy"
      ) : (
        label
      )}
    </Button>
  );
}

export function Code({ children }: { children: ReactNode }) {
  // Short tokens (`speak`, `pee`) stay whole; long URLs and keys may break anywhere.
  const long = typeof children === "string" ? children.length > 24 : true;
  return (
    <code className={cx("rounded-md bg-mp-sunken px-1.5 py-0.5 font-mono text-[13px] text-mp-ink", long ? "break-all" : "whitespace-nowrap")}>
      {children}
    </code>
  );
}

/** An iOS-style switch. The button is a 44px target around the 51×31 track. */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
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
        {/* White knob by day and in dark mode. At night on is filled (a bright knob on an amber track) and off is hollow, so off can't pass for on. */}
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

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <Row label={label} note={hint}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </Row>
  );
}

/** How someone shows on rows: their initial on their color (value "", the default), or an emoji they pick. */
export function EmojiPicker({ value, onChange, initial, color }: { value: string; onChange: (e: string) => void; initial: string; color: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Shown as">
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        aria-label="Initial"
        onClick={() => onChange("")}
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95",
          value === "" ? "bg-mp-accent/10 ring-2 ring-mp-accent-fg" : "bg-mp-sunken"
        )}
      >
        <span aria-hidden className="mp-kind-fill flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold text-white" style={{ backgroundColor: color }}>
          {/* Before a name is typed there's no initial yet: "Aa" says this is the letter option, not a blank swatch. */}
          {initial || "Aa"}
        </span>
      </button>
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          aria-label={e}
          onClick={() => onChange(e)}
          className={cx(
            "flex h-11 w-11 items-center justify-center rounded-full text-xl transition active:scale-95",
            value === e ? "bg-mp-accent/10 ring-2 ring-mp-accent-fg" : "bg-mp-sunken"
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** Save / Cancel under a card once something in it has changed. */
export function SaveBar({ busy, onSave, onCancel }: { busy: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="mt-3 flex gap-2">
      <Button className="flex-1" disabled={busy} onClick={onSave}>
        Save changes
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

"use client";

import { useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { LATE_BLACK_STOOL, PALE_STOOL, RED_STOOL, STOOL_COLOR_INFO, STOOL_TIMELINE } from "@/lib/maple/guidelines";
import { DIAPER_SIZES, STOOL_TEXTURES, type DiaperData, type DiaperSize, type StoolColor, type StoolTexture } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Chip, Segmented, Sheet, WhenField, cx, tone } from "../ui";
import type { SheetProps } from "./index";
import {
  AssessmentCard,
  ContextNote,
  Label,
  LoggedBy,
  MoreDetails,
  NoteField,
  SheetFooter,
  compact,
  pbool,
  presetStart,
  pstr,
  useOpenCount,
  useSheetBase,
  withNulls,
} from "./parts";

/**
 * Log or edit a diaper: Pee / Poop / Both / Dry, the stool color on a swatch
 * card (grouped like the infant stool color cards hospitals hand out, so pale
 * shades never sit next to yellow), and texture / size / rash tucked away.
 */

type Type = "pee" | "poop" | "both" | "dry";

const TYPE_LABEL: Record<Type, string> = { pee: "Pee", poop: "Poop", both: "Both", dry: "Dry" };
const TYPE_TOAST: Record<Type, string> = {
  pee: "Wet diaper",
  poop: "Dirty diaper",
  both: "Wet + dirty diaper",
  dry: "Dry diaper",
};

const GROUPS: { id: "normal" | "early" | "pale" | "red"; label: string }[] = [
  { id: "normal", label: "Usual" },
  { id: "early", label: "First days" },
  { id: "pale", label: "Pale" },
  { id: "red", label: "Red" },
];
const ORDER: StoolColor[] = ["mustard", "yellow", "green", "brown", "orange", "black", "pale_yellow", "gray", "white", "red"];

const TEXTURE_LABEL: Record<StoolTexture, string> = {
  seedy: "Seedy",
  runny: "Runny",
  pasty: "Pasty",
  sticky: "Sticky",
  mucousy: "Mucus-y",
  hard: "Hard",
};
/** Swatch captions (the full label shows once picked). */
const SHORT: Record<StoolColor, string> = {
  mustard: "Mustard",
  yellow: "Yellow",
  green: "Green",
  brown: "Tan",
  orange: "Orange",
  black: "Black",
  pale_yellow: "Pale yellow",
  gray: "Gray",
  white: "White",
  red: "Red",
};
const SIZE_LABEL: Record<DiaperSize, string> = { small: "Small", medium: "Medium", big: "Big", blowout: "Blowout" };

const typeOf = (d: { pee?: boolean; poop?: boolean }): Type => (d.pee && d.poop ? "both" : d.poop ? "poop" : d.pee ? "pee" : "dry");

export default function DiaperSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <DiaperForm key={n} {...props} />;
}

function DiaperForm({ open, onClose, entry, preset }: SheetProps) {
  const { tz, log, update, remove, clock, age, now } = useSheetBase();
  const e = entry?.kind === "diaper" ? entry : undefined;
  const d: Partial<DiaperData> = e?.data ?? {};

  const [type, setType] = useState<Type>(() => {
    if (e) return typeOf(e.data);
    const t = pstr(preset, "type");
    if (t === "pee" || t === "poop" || t === "both" || t === "dry") return t;
    const pee = pbool(preset, "pee");
    const poop = pbool(preset, "poop");
    return pee !== undefined || poop !== undefined ? typeOf({ pee, poop }) : "pee";
  });
  const [color, setColor] = useState<StoolColor | undefined>(() => d.color ?? (pstr(preset, "color") as StoolColor | undefined));
  const [texture, setTexture] = useState<StoolTexture | undefined>(d.texture);
  const [size, setSize] = useState<DiaperSize | undefined>(d.size);
  const [rash, setRash] = useState<boolean>(d.rash ?? false);
  const [when, setWhen] = useState<Date | null>(() => (e ? new Date(e.started_at) : presetStart(preset)));
  const [note, setNote] = useState(e?.note ?? pstr(preset, "note") ?? "");
  const [busy, setBusy] = useState(false);

  const poop = type === "poop" || type === "both";
  const pee = type === "pee" || type === "both";
  const info = color ? STOOL_COLOR_INFO[color] : null;
  // Black after Day 4 is worth a call (once stools should have turned yellow).
  const flag = !poop || !color ? null : info?.group === "pale" ? PALE_STOOL : info?.group === "red" ? RED_STOOL : color === "black" && age && age.dayOfLife >= 5 ? LATE_BLACK_STOOL : null;

  const details = [texture && TEXTURE_LABEL[texture], size && SIZE_LABEL[size], rash && "rash"].filter(Boolean).join(", ");

  const save = async () => {
    const data = {
      pee,
      poop,
      color: poop ? color : undefined,
      texture: poop ? texture : undefined,
      size,
      rash: rash || undefined,
    };
    if (e) {
      setBusy(true);
      const res = await update(
        e.id,
        {
          data: withNulls(data, ["color", "texture", "size", "rash"]),
          started_at: when && when.getTime() !== Date.parse(e.started_at) ? when.toISOString() : undefined,
          note: note.trim() || null,
        },
        { toast: `${TYPE_TOAST[type]} updated` }
      );
      setBusy(false);
      if (res) onClose();
      return;
    }
    onClose();
    void log(
      { kind: "diaper", started_at: when?.toISOString(), data: compact(data), note: note.trim() || null },
      { toast: `${TYPE_TOAST[type]} · ${clock(when ?? now())}` }
    );
  };

  const del = () => {
    if (!e) return;
    onClose();
    void remove(e.id, { toast: `${describeEntry(e).title} deleted` });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={e ? describeEntry(e).title : "Diaper"}
      footer={
        <SheetFooter
          onClose={onClose}
          onDelete={e ? del : undefined}
          onPrimary={() => void save()}
          label={e ? "Save" : "Log it"}
          busy={busy}
          disabled={e ? e.id < 0 : false}
          hint={e && e.id < 0 ? "Still syncing, so it can't be edited yet." : undefined}
        />
      }
    >
      {e && <LoggedBy entry={e} />}

      <Segmented<Type>
        value={type}
        onChange={setType}
        // Plain words, like any segmented control (Dry has no mark, so marks made the row ragged).
        options={(["pee", "poop", "both", "dry"] as Type[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
        className="[&>button]:min-h-[48px] [&>button]:text-[15px]"
      />

      {poop && (
        <section aria-label="Poop color">
          <Label optional>Color</Label>
          {/* Like a hospital stool card: the usual shades on top, the ones to watch below, each group apart. */}
          <div className={cx(tone.card, "divide-y divide-mp-line")}>
            {GROUPS.filter((g) => g.id === "normal").map((g) => (
              <SwatchGroup key={g.id} label={g.label} colors={ORDER.filter((c) => STOOL_COLOR_INFO[c].group === g.id)} value={color} onChange={setColor} className="px-3 pt-2.5 pb-2" />
            ))}
            <div className="flex divide-x divide-mp-line">
              {GROUPS.filter((g) => g.id !== "normal").map((g) => (
                <SwatchGroup key={g.id} label={g.label} colors={ORDER.filter((c) => STOOL_COLOR_INFO[c].group === g.id)} value={color} onChange={setColor} className="px-2 pt-2.5 pb-2 first:pl-3 last:pr-3" />
              ))}
            </div>
          </div>
          {flag ? (
            <AssessmentCard a={flag} className="mt-3" />
          ) : (
            info && (
              <p className={cx(tone.body, "mt-3 text-sm")}>
                <span className="font-semibold">{info.label}.</span> <span className={tone.muted}>{info.note}</span>
              </p>
            )
          )}
          <ContextNote className="mt-2">{STOOL_TIMELINE}</ContextNote>
        </section>
      )}

      <WhenField value={when} onChange={setWhen} tz={tz} />

      <MoreDetails summary={details || undefined}>
        {poop && (
          <div>
            <Label>Texture</Label>
            <div className="flex flex-wrap gap-2">
              {STOOL_TEXTURES.map((t) => (
                <Chip key={t} selected={texture === t} onClick={() => setTexture(texture === t ? undefined : t)}>
                  {TEXTURE_LABEL[t]}
                </Chip>
              ))}
            </div>
          </div>
        )}
        <div>
          <Label>Size</Label>
          <div className="flex flex-wrap gap-2">
            {DIAPER_SIZES.map((s) => (
              <Chip key={s} selected={size === s} onClick={() => setSize(size === s ? undefined : s)}>
                {SIZE_LABEL[s]}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <Label>Skin</Label>
          <Chip selected={rash} onClick={() => setRash((r) => !r)}>
            Diaper rash
          </Chip>
        </div>
      </MoreDetails>

      <NoteField value={note} onChange={setNote} />
    </Sheet>
  );
}

function SwatchGroup({
  label,
  colors,
  value,
  onChange,
  className,
}: {
  label: string;
  colors: StoolColor[];
  value: StoolColor | undefined;
  onChange: (c: StoolColor | undefined) => void;
  className?: string;
}) {
  return (
    // min-w-0: on a narrow phone the swatches shrink to fit instead of pushing Red out of the card.
    <div role="radiogroup" aria-label={label} className={cx("min-w-0", className)}>
      <p className={cx(tone.faint, "mb-1 px-0.5 text-xs font-medium")}>{label}</p>
      <div className="flex gap-0.5">
        {colors.map((c) => {
          const info = STOOL_COLOR_INFO[c];
          const on = value === c;
          const light = ["white", "pale_yellow", "gray", "yellow"].includes(c);
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={info.label}
              onClick={() => onChange(on ? undefined : c)}
              className="flex w-[54px] flex-col items-center gap-1 rounded-xl py-1 transition active:scale-95"
            >
              {/* The real shades, even at night (dimmed, not folded into amber): matching the diaper to them is the point. */}
              <span
                className={cx(
                  "mp-swatch flex h-10 w-10 items-center justify-center rounded-full ring-1 ring-mp-ink/15 ring-inset",
                  on && "outline-2 outline-offset-2 outline-mp-ink"
                )}
                style={{ backgroundColor: info.hex, color: light ? "#3A3020" : "#FFFFFF" }}
                aria-hidden
              >
                {on && <Icon name="check" size={18} strokeWidth={2.5} />}
              </span>
              <span className={cx("text-center text-[11px] leading-tight", on ? "font-semibold text-mp-ink" : "text-mp-ink-2")}>{SHORT[c]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

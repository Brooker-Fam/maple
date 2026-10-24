import type { Entry, EntryKind, Side } from "@/lib/maple/types";

/**
 * Colors for Maple's Log: the site's enchanted-forest palette plus autumn
 * maple accents. Each kind has a color used in the day dial, pattern
 * ribbons, chips and list icons, so they read the same everywhere.
 */
export const MAPLE = {
  forest: "#1D4420",
  sage: "#5C7A4A",
  gold: "#C49A3C",
  cream: "#FDF8F0",
  blush: "#E8C8B8",
  lavender: "#B8A9C9",
  plum: "#4A1A2A",
  rust: "#B5452B",
  ember: "#D9772B",
  honey: "#E0A93B",
  dew: "#6FA3B8",
  acorn: "#8A5A2B",
  moss: "#6B8448",
  night: "#0D1F0F",
} as const;

export const KIND_COLOR: Record<EntryKind, string> = {
  feed: MAPLE.ember,
  pump: "#D4A894",
  diaper: MAPLE.acorn,
  sleep: "#8E7CB0",
  growth: MAPLE.sage,
  temp: MAPLE.rust,
  vitals: "#9B4A6A",
  med: MAPLE.gold,
  tummy: MAPLE.moss,
  bath: MAPLE.dew,
  moment: "#9A88B0",
  note: "#7F8C6A",
};

/** Left and right, the same everywhere: dock, timer card, rows, sheets, dial. */
export const SIDE_COLOR: Record<Side, string> = { L: MAPLE.rust, R: MAPLE.honey };
/** Text on a filled side color that stays readable (rust takes white, honey takes ink). */
export const SIDE_INK: Record<Side, string> = { L: "#FFFFFF", R: "#2A1A08" };

/**
 * Finer-grained colors for the dial/ribbons. Pee and poop are a step stronger
 * than dew and acorn: they draw 1.75px line marks (the drop and the pile), and
 * the poop mark mustn't equal the "Tan / brown" stool swatch (acorn).
 */
export const DETAIL_COLOR = {
  nursing: MAPLE.ember,
  bottle: MAPLE.honey,
  pee: "#4F8FAE",
  poop: "#9A6638",
  sleep: "#8E7CB0",
  tummy: MAPLE.moss,
} as const;

/** A skin check (jaundice only): the gold of its eye icon everywhere, not the vitals plum. */
export const SKIN_COLOR = "#C9962A";

/**
 * Mom's own things (her medicines, the Today row, her More tile): a deep teal
 * no kind of Maple's uses. Worn through mp-kind / mp-kind-ink / mp-kind-fill
 * so it folds into the amber at night like every kind color.
 */
export const CARE_COLOR = "#3F7F7A";

/** One color per thing: a skin check and a doctor question wear the same color in lists as in More. */
export function entryColor(e: Entry): string {
  if (e.kind === "feed") return e.data.method === "bottle" ? DETAIL_COLOR.bottle : DETAIL_COLOR.nursing;
  if (e.kind === "diaper") return e.data.poop ? DETAIL_COLOR.poop : DETAIL_COLOR.pee;
  if (e.kind === "vitals" && e.data.jaundice && !e.data.heart_bpm && !e.data.resp_rate && !e.data.spo2) return SKIN_COLOR;
  if (e.kind === "note" && e.data.for_doctor) return KIND_COLOR.vitals;
  return KIND_COLOR[e.kind];
}

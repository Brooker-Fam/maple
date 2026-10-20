import type { Entry, EntryKind } from "@/lib/maple/types";

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

/** Finer-grained colors for the dial/ribbons. */
export const DETAIL_COLOR = {
  nursing: MAPLE.ember,
  bottle: MAPLE.honey,
  pee: MAPLE.dew,
  poop: MAPLE.acorn,
  sleep: "#8E7CB0",
  tummy: MAPLE.moss,
} as const;

export function entryColor(e: Entry): string {
  if (e.kind === "feed") return e.data.method === "bottle" ? DETAIL_COLOR.bottle : DETAIL_COLOR.nursing;
  if (e.kind === "diaper") return e.data.poop ? DETAIL_COLOR.poop : DETAIL_COLOR.pee;
  return KIND_COLOR[e.kind];
}

import { STOOL_COLOR_INFO } from "../guidelines";
import type { Entry } from "../types";
import type { ExtraMilk, ExtraTopic } from "./types";

/** Meconium (black) is expected for her first days (guidelines.ts STOOL_COLOR_INFO); after these, black is a color to call about. */
const MECONIUM_DAYS = 4;

/**
 * What a line after this entry may be about, most specific first, or null for
 * no line at all: a temperature, a reading or a medicine (the plain
 * confirmation only), a timer still running, a diaper with a color to call
 * about or a rash, and a sleep anywhere but the baby's own crib or bassinet
 * (or with no place said), so a line never sits beside something worrying, and
 * never seems to cheer a sleep space guidelines.ts doesn't.
 */
export function extraTopics(e: Entry, ageDays: number | null): ExtraTopic[] | null {
  if (e.active) return null;
  switch (e.kind) {
    case "diaper": {
      const d = e.data;
      if (d.rash) return null;
      if (d.poop && d.color) {
        const group = STOOL_COLOR_INFO[d.color]?.group;
        if (group !== "normal" && !(group === "early" && ageDays !== null && ageDays < MECONIUM_DAYS)) return null;
      }
      if (d.poop && d.pee) return ["poop", "pee", "diaper", "care"];
      if (d.poop) return ["poop", "diaper", "care"];
      if (d.pee) return ["pee", "diaper", "care"];
      return ["diaper", "care"];
    }
    case "feed":
      if (e.data.method === "breast") return ["nursing", "feed", "care"];
      // Milk at the breast (an SNS, a syringe) is part of nursing: a line about feeding, never about bottles.
      if (e.data.via === "sns" || e.data.via === "syringe") return ["feed", "care"];
      return ["bottle", "feed", "care"];
    case "pump":
      return ["pump", "care"];
    case "sleep":
      return !e.data.place || e.data.place === "bassinet" || e.data.place === "crib" ? ["sleep", "care"] : null;
    case "tummy":
      return ["tummy", "care"];
    case "bath":
      return ["bath", "care"];
    case "moment":
      return ["moment"];
    case "note":
      if (e.data.for_doctor) return ["doctor"];
      return e.data.tag === "hiccups" ? ["hiccups", "note"] : ["note"];
    case "growth":
      return ["growth"];
    default:
      return null;
  }
}

/** A bottle's milk, for lines only true of one (a Mixed bottle has both, so it takes the lines about any bottle). */
export function extraMilk(e: Entry): ExtraMilk | null {
  if (e.kind !== "feed" || e.data.method !== "bottle") return null;
  return e.data.milk === "breastmilk" || e.data.milk === "formula" ? e.data.milk : null;
}

/** Whole days since birth, or null before a birth time is saved (or for one in the future): lines with ages wait. */
export function extraAgeDays(bornAt: string | null | undefined, now: Date | number): number | null {
  const born = bornAt ? Date.parse(bornAt) : NaN;
  const at = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(born) || !Number.isFinite(at) || at < born) return null;
  return Math.floor((at - born) / 86_400_000);
}

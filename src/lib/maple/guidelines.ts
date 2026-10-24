/**
 * Newborn guidance behind Maple's Log targets and alerts, checked against
 * AAP / HealthyChildren.org, CDC, NIH, WHO, ABM protocols and children's
 * hospital triage guides (Seattle Children's, CHOP, Children's Mercy).
 *
 * These are general guidelines for healthy full-term babies, not medical
 * advice. Every alert says who to call; none suggests a medicine dose.
 * Copy here is what the app shows and what the MCP tools hand to Claude and
 * ChatGPT to repeat verbatim, so keep it calm, plain and specific.
 */
import { cToF } from "./units";
import type { JaundiceLevel, StoolColor, TempMethod } from "./types";

// ── Alert tiers ──────────────────────────────────────────────────────────

/** Most to least urgent. */
export const ALERT_TIERS = ["emergency", "now", "today", "mention", "nudge"] as const;
export type AlertTier = (typeof ALERT_TIERS)[number];

export const TIER_LABEL: Record<AlertTier, string> = {
  emergency: "Call 911 now",
  now: "Call your pediatrician now",
  today: "Call your pediatrician today",
  mention: "Mention it to your pediatrician",
  nudge: "Gentle nudge",
};

export type Assessment = { tier: AlertTier; title: string; body: string };

export const DISCLAIMER = "Maple's Log isn't medical advice. When in doubt, call your pediatrician.";

export const EMERGENCY_SIGNS =
  "Call 911 if she has blue or gray lips or face, stops breathing for 20 seconds or more, is struggling to breathe (grunting, flaring nostrils, skin pulling in around the ribs), can't be woken, or is limp.";

// ── Feeding ──────────────────────────────────────────────────────────────

/** Breastfed newborns: 8–12 feeds per 24 hours (10–12 is typical early on). */
export const FEEDS_PER_DAY = [8, 12] as const;

/**
 * Feed-gap nudges, measured start to start. Until she's two weeks old (or
 * while a recent weight is still under birth weight): a nudge at 3 hours and
 * a firmer one at 4, day or night.
 * After that: a daytime nudge at 4 hours only. A pediatrician's interval in
 * settings overrides both.
 */
export function feedGapRule(
  ageDays: number,
  backToBirthWeight: boolean | null,
  overrideHours?: number | null
): { nudgeMin: number; firmMin: number | null; nightsOff: boolean } {
  if (overrideHours && overrideHours > 0) return { nudgeMin: overrideHours * 60, firmMin: null, nightsOff: false };
  // Strict until two weeks, and after that only while a recent weight shows
  // she's still below birth weight (unknown after two weeks relaxes).
  if (ageDays < 14 || backToBirthWeight === false) return { nudgeMin: 180, firmMin: 240, nightsOff: false };
  return { nudgeMin: 240, firmMin: null, nightsOff: true };
}

/** Typical bottle sizes, shown as context next to the bottle form. Never a target. */
export function typicalBottle(ageDays: number): string {
  if (ageDays < 2) return "about ½ oz (15 ml) per feed";
  if (ageDays < 7) return "about 1–2 oz (30–60 ml) per feed";
  if (ageDays < 28) return "about 2–3 oz (60–90 ml) every 2–3 hours";
  if (ageDays < 60) return "about 3–4 oz (90–120 ml) every 3–4 hours";
  return "about 4–5 oz (120–150 ml) per feed";
}

export const BOTTLE_CUES =
  "Typical, not a target. Follow her hunger cues (rooting, hands to mouth) and fullness cues (turning away, relaxed hands).";

// ── Diapers ──────────────────────────────────────────────────────────────

/**
 * Minimum wet and dirty diapers per 24 hours of life (Day 1 = hours 0–24).
 * Wet: one per day of life up to 6. Stools: meconium days 1–2, 2+ transitional
 * on days 3–4, then 3+ yellow a day until about 6 weeks, when many breastfed
 * babies start going less often (no stool target after that).
 */
export function diaperTargets(dayOfLife: number): { wet: number; dirty: number | null } {
  const wet = Math.min(Math.max(dayOfLife, 1), 6);
  let dirty: number | null;
  if (dayOfLife <= 1) dirty = 1;
  else if (dayOfLife <= 4) dirty = 2;
  else if (dayOfLife <= 42) dirty = 3;
  else dirty = null;
  return { wet, dirty };
}

export const STOOL_TIMELINE =
  "Black and sticky (Days 1–2) → greenish-brown (Days 3–4) → mustard yellow and seedy (by Days 4–5). Green, tan and orange-ish shades are normal too.";

type StoolInfo = { label: string; hex: string; note: string; group: "normal" | "early" | "pale" | "red" };

export const STOOL_COLOR_INFO: Record<StoolColor, StoolInfo> = {
  black: { label: "Black / tarry", hex: "#2B2522", note: "Meconium: expected in the first 2–3 days.", group: "early" },
  green: { label: "Green", hex: "#5E7A2E", note: "Common in the transition days and normal now and then.", group: "normal" },
  yellow: { label: "Yellow", hex: "#E3B63B", note: "The classic breastfed poop.", group: "normal" },
  mustard: { label: "Mustard & seedy", hex: "#C9962A", note: "Textbook breastfed poop by days 4–5.", group: "normal" },
  brown: { label: "Tan / brown", hex: "#8A5A2B", note: "Normal, especially with formula.", group: "normal" },
  orange: { label: "Orange-ish", hex: "#D9772B", note: "Normal variation.", group: "normal" },
  pale_yellow: { label: "Pale yellow", hex: "#F1E4A6", note: "Very pale: call your pediatrician today.", group: "pale" },
  gray: { label: "Gray / clay", hex: "#B9B4A8", note: "Call your pediatrician today.", group: "pale" },
  white: { label: "Chalky white", hex: "#F3F0E8", note: "Call your pediatrician today.", group: "pale" },
  red: { label: "Red / blood", hex: "#B23A2E", note: "Call your pediatrician today.", group: "red" },
};

export const PALE_STOOL: Assessment = {
  tier: "today",
  title: "Pale poop: call your pediatrician today",
  body: "Very pale, chalky-white, gray or clay-colored poop can be a sign of a liver problem that's very treatable when it's caught early. Please call your pediatrician today (don't wait for the next checkup) and show them a photo of the diaper.",
};

export const RED_STOOL: Assessment = {
  tier: "today",
  title: "Red in the diaper: call your pediatrician today",
  body: "Often it's something small, like a tiny tear or swallowed blood from a cracked nipple, but blood in poop should always be checked. Call now instead if there's a lot of blood or mucus, or blood with fever, vomiting, a swollen belly or poor feeding.",
};

export const LATE_BLACK_STOOL: Assessment = {
  tier: "today",
  title: "Still black poop after Day 4",
  body: "Her poop should have turned yellow by now, which is a sign milk is flowing. Very dark green can look black: smear a little on a white wipe in bright light. If it's truly black or tarry, please check in with your pediatrician today.",
};

// ── Weight ───────────────────────────────────────────────────────────────

export const WEIGHT_LOSS_CHECK_PCT = 7;
export const WEIGHT_LOSS_CALL_PCT = 10;
/** Most babies are back to birth weight by 10–14 days. */
export const BIRTH_WEIGHT_REGAIN_DAY = 14;

export const WEIGHT_GAIN_NOTE =
  "Once back to birth weight, babies often gain about 5–7 oz (150–200 g) a week in the first months. Home scales wobble by about an ounce, so look at the trend over 5–7 days; your pediatrician watches the curve.";

// ── Temperature ──────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Temperature assessment by age and thermometer. Compared in °F to 0.1, the
 * way parents read the screen. `previous` is the reading before this one, used
 * to tell "running cool, re-check" from "still low after warming".
 */
export function assessTemperature(
  tempC: number,
  method: TempMethod | undefined,
  ageMonths: number,
  previous?: { tempC: number; minutesBefore: number } | null
): Assessment | null {
  const f = round1(cToF(tempC));
  const shown = `${f.toFixed(1)}°F`;
  // A threshold counts if it's met in either scale (38.3°C is 100.94°F, which
  // would round down to 100.9°F and miss "101°F").
  const atLeast = (fT: number, cT: number) => f >= fT || tempC >= cT - 1e-9;

  if (atLeast(104, 40)) {
    return {
      tier: "now",
      title: `${shown}: call your pediatrician now`,
      body: "A temperature of 104°F (40°C) or higher needs a call right away at any age. If she's hard to wake, limp, or struggling to breathe, call 911.",
    };
  }

  // Ear thermometers aren't accurate before 6 months: any ear reading gets a
  // recheck, and a high one is still treated as a fever.
  if (method === "ear" && ageMonths < 6) {
    if (ageMonths < 3 ? atLeast(100.4, 38) : atLeast(101, 38.3)) {
      return {
        tier: ageMonths < 3 ? "now" : "today",
        title: `${shown}: call your pediatrician${ageMonths < 3 ? " now" : ""}`,
        body: "Ear thermometers aren't reliable before 6 months, but a reading this high should be treated as a fever: call your pediatrician, and confirm with a rectal reading if you can.",
      };
    }
    return {
      tier: "nudge",
      title: "Recheck with another thermometer",
      body: "Ear thermometers aren't accurate before 6 months. Please recheck with a rectal (most accurate) or forehead reading.",
    };
  }

  if (ageMonths < 3) {
    if (atLeast(100.4, 38)) {
      return {
        tier: "now",
        title: "Fever: call your pediatrician now",
        body: "100.4°F (38.0°C) or higher counts as a fever at Maple's age. Call your pediatrician now, even if she seems fine; doctors want to check every fever in babies this young. Don't give fever medicine unless they tell you to. If you can't reach them, go to the ER.",
      };
    }
    if (atLeast(99, 37.2) && (method === "armpit" || method === undefined)) {
      return {
        tier: "nudge",
        title: "Recheck rectally",
        body:
          method === "armpit"
            ? "Armpit readings are a quick screen but can be off. Please recheck with a rectal reading, the most accurate at this age. If that's 100.4°F or higher, call your pediatrician now."
            : "A little warm. Please recheck with a rectal thermometer, the most accurate at this age. If it's 100.4°F (38.0°C) or higher, call your pediatrician now.",
      };
    }
  } else if (ageMonths < 6) {
    if (atLeast(101, 38.3)) {
      return {
        tier: "today",
        title: "Fever: call your pediatrician",
        body: "For a baby 3–6 months old, call your pediatrician for advice at 101°F (38.3°C) or higher, and sooner if she's hard to wake, won't feed, or is breathing hard.",
      };
    }
  } else if (atLeast(102, 38.9)) {
    return {
      tier: "mention",
      title: "Fever",
      body: "Call your pediatrician if a fever lasts more than 24 hours, or right away if she seems very sick, won't drink, or is hard to wake.",
    };
  }

  // Running cool. Sick newborns can run cold instead of hot.
  if (f < 97.7 && ageMonths < 3) {
    const stillLow = previous && previous.minutesBefore <= 180 && round1(cToF(previous.tempC)) < 97.7;
    if (f < 96.8 && method !== "armpit" && stillLow) {
      return {
        tier: "now",
        title: `Still low (${shown}): call your pediatrician now`,
        body: "Her temperature is still low after warming. Newborns sometimes run cold instead of hot when they're unwell. Please call your pediatrician now, sooner still if she's feeding poorly, unusually sleepy or floppy.",
      };
    }
    return {
      tier: "nudge",
      title: "Running a little cool",
      body:
        method === "armpit"
          ? "Armpit readings run low. Snuggle skin-to-skin or add a layer, then recheck rectally in 15–30 minutes. If it's under 96.8°F (36.0°C), call your pediatrician now."
          : "Snuggle skin-to-skin or add a layer, then recheck in 15–30 minutes. If it's still under 96.8°F (36.0°C), or she's feeding poorly or very sleepy, call your pediatrician now.",
    };
  }
  return null;
}

/** Ear thermometers aren't accurate before 6 months; hide them in the picker. */
export const earThermometerOk = (ageMonths: number) => ageMonths >= 6;

// ── Vitals ───────────────────────────────────────────────────────────────

export function heartRange(ageMonths: number): [number, number] {
  return ageMonths < 1 ? [70, 190] : ageMonths < 12 ? [80, 160] : [80, 140];
}

/**
 * Vitals parents might jot down (from a pediatrician visit, an oximeter sock,
 * or counting breaths). First odd reading → recount; confirmed → call.
 */
export function assessVitals(
  v: { heart_bpm?: number; resp_rate?: number; spo2?: number },
  ageMonths: number,
  previous?: { heart_bpm?: number; resp_rate?: number; spo2?: number; minutesBefore: number } | null
): Assessment[] {
  const out: Assessment[] = [];
  const recent = previous && previous.minutesBefore <= 60 ? previous : null;

  if (v.spo2 != null) {
    if (v.spo2 < 92) {
      out.push({
        tier: "emergency",
        title: `Oxygen ${v.spo2}%`,
        body: "If her lips or face look blue or gray, or she's working hard to breathe, call 911 now. Home oximeters often misread wiggly babies with cold feet: if she looks pink and comfortable, warm her foot and recheck with a steady signal, and call 911 if a calm reading stays under 92%.",
      });
    } else if (v.spo2 < 95) {
      out.push(
        recent?.spo2 != null && recent.spo2 < 95
          ? { tier: "now", title: `Oxygen ${v.spo2}% on recheck`, body: "A calm, warm baby with a good signal reading 92–94% should be checked: call your pediatrician now." }
          : { tier: "nudge", title: `Oxygen ${v.spo2}%: recheck`, body: "Healthy newborns usually read 95% or higher. Warm her foot, wait for a steady signal while she's calm, and recheck. If it stays at 92–94%, call your pediatrician now." }
      );
    }
  }
  if (v.resp_rate != null && v.resp_rate > 60) {
    out.push(
      recent?.resp_rate != null && recent.resp_rate > 60
        ? { tier: "now", title: `Breathing ${v.resp_rate}/min on recount`, body: `Fast breathing at rest (over 60 a minute) should be checked: call your pediatrician now. ${EMERGENCY_SIGNS}` }
        : { tier: "nudge", title: `Breathing ${v.resp_rate}/min: recount`, body: "Count breaths for a full 60 seconds while she's calm or asleep (not crying). Newborns breathe about 30–60 times a minute, with short pauses under 10 seconds that are normal. If it's still over 60 at rest, call your pediatrician now." }
    );
  }
  if (v.heart_bpm != null) {
    const [lo, hi] = heartRange(ageMonths);
    if (v.heart_bpm < lo || v.heart_bpm > hi) {
      out.push(
        recent?.heart_bpm != null && (recent.heart_bpm < lo || recent.heart_bpm > hi)
          ? { tier: "today", title: `Heart rate ${v.heart_bpm} on recheck`, body: `A resting heart rate outside about ${lo}–${hi} at her age is worth a call to your pediatrician. Call 911 if she looks pale, gray or limp.` }
          : { tier: "nudge", title: `Heart rate ${v.heart_bpm}: recheck when calm`, body: `At her age a resting heart rate is usually about ${lo}–${hi} (lower asleep, higher crying). Recheck while she's calm; if it's still outside that range, call your pediatrician.` }
      );
    }
  }
  return out;
}

// ── Jaundice ─────────────────────────────────────────────────────────────

export const JAUNDICE_LABEL: Record<JaundiceLevel, string> = {
  none: "No yellow",
  face: "Face",
  eyes: "Whites of eyes",
  chest: "Chest / belly",
  legs: "Legs",
  deep: "Deep yellow-orange",
};

const JAUNDICE_RANK: Record<JaundiceLevel, number> = { none: 0, face: 1, eyes: 2, chest: 2, legs: 3, deep: 4 };

export const JAUNDICE_HOWTO =
  "Check her skin and eyes in daylight. Gently press her forehead or nose: does the skin look yellow as it blanches? On darker skin, look at the whites of her eyes and her gums.";

export function assessJaundice(
  level: JaundiceLevel,
  ageHours: number,
  previous?: { level: JaundiceLevel; minutesBefore: number } | null
): Assessment | null {
  if (level === "none") return null;
  if (ageHours < 24) {
    return {
      tier: "now",
      title: "Yellow in the first day: call now",
      body: "Any yellow skin in the first 24 hours needs a bilirubin check right away. Call your pediatrician (or tell your nurse) now.",
    };
  }
  if (level === "legs" || level === "deep") {
    return {
      tier: "now",
      title: "Jaundice spreading: call your pediatrician now",
      body: "Yellow that has reached her legs, or skin that looks deep yellow-orange, should be checked now. Call 911 if she can't be woken, is limp, has a high-pitched cry, or arches her back or neck. Sunlight isn't a safe treatment for jaundice.",
    };
  }
  if (previous && previous.minutesBefore <= 48 * 60 && JAUNDICE_RANK[level] > JAUNDICE_RANK[previous.level]) {
    return {
      tier: "now",
      title: "Jaundice getting worse: call your pediatrician now",
      body: "The yellow has spread since the last check. Please call your pediatrician now, especially if she's sleepy, not feeding well, or has fewer wet or dirty diapers than expected.",
    };
  }
  if (level === "eyes" || level === "chest") {
    return {
      tier: "today",
      title: "Yellow eyes or belly: call within 24 hours",
      body: "Yellow in the whites of the eyes or spreading to the belly should be checked within a day. Call sooner if she's hard to wake or not feeding well, and today if her poop is pale or her pee is dark.",
    };
  }
  if (ageHours >= 14 * 24) {
    return {
      tier: "mention",
      title: "Still a little yellow after 2 weeks",
      body: "Breastfed babies can stay mildly yellow for up to about 4 weeks, but let your pediatrician know.",
    };
  }
  return null;
}

// ── Vitamin D, tummy time, sleep ─────────────────────────────────────────

export const VITAMIN_D_DEFAULT = { name: "Vitamin D", dose: "400 IU" };
export const VITAMIN_D_NOTE =
  "Sunshine drops: 400 IU of vitamin D once a day. Breast milk is naturally low in vitamin D, so pediatricians recommend a daily dose starting in her first few days. Drop strengths differ by brand, so follow the label.";

/** Daily tummy-time goal in minutes (WHO / NIH Safe to Sleep, ramped for newborns). */
export function tummyGoalMinutes(ageDays: number): number {
  if (ageDays < 14) return 10;
  if (ageDays < 56) return 20;
  return 30;
}
export const TUMMY_NOTE =
  "A few minutes, a few times a day, while she's awake and you're right there, on the floor on a blanket. It builds neck and shoulder strength and helps avoid flat spots. Stop when she's fussy.";

export const SLEEP_TOTAL_NOTE =
  "Newborns sleep about 14–17 hours a day in little bursts. Day and night get sorted out over the next couple of months.";

export const SAFE_SLEEP_TIPS: Partial<Record<string, string>> = {
  bed: "Pediatricians recommend her own firm, flat space (a bassinet or crib in your room) for at least the first 6 months. If she drifts off in your bed after a feed, move her back to her bassinet, on her back, when you can.",
  car: "If she falls asleep in the car seat, move her flat on her back in her bassinet when you can.",
  stroller: "If she falls asleep in the stroller, move her flat on her back in her bassinet when you can.",
  carrier: "If she falls asleep in the carrier, move her flat on her back in her bassinet when you can.",
  arms: "Contact naps are lovely. If you're getting sleepy too, move her to her bassinet, on her back.",
};

export const FIRST_CHECKUP_NOTE =
  "Her first checkup is usually at 3–5 days old (within 48 hours of leaving the hospital), with a weight check around 2 weeks.";

/** Healthy full-term defaults; preterm or small babies follow their pediatrician's plan. */
export function needsOwnPlan(gestationalWeeks: number | null | undefined, birthWeightG: number | null | undefined): boolean {
  return (gestationalWeeks != null && gestationalWeeks < 37) || (birthWeightG != null && birthWeightG < 2500);
}

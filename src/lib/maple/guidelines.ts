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

/** `label` overrides the tier label (mom's crisis and over-limit cards say exactly who to call). */
export type Assessment = { tier: AlertTier; title: string; body: string; label?: string };

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

// ════════════════════════════════════════════════════════════════════════
// FOR MOM: her own medicines, recovery and mood.
//
// Same rules as Maple's side: every alert says who to call, and nothing
// suggests, fills in or calculates a medicine dose. Her medicines are timed
// only against numbers the family typed from her label, discharge papers or
// clinician, in the label's own unit. Copy is written to her ("you"). When
// someone else reads it, the UI and MCP put "For {name}: " before the title
// (forMom in care.ts) and never reword the body, so assistants can repeat it
// verbatim. The one exception is the crisis card: readers who aren't her get
// CRISIS_PARTNER instead of CRISIS.
// Help-line numbers verified 2026-10-24 (HELP_VERIFIED_ON); recheck every 6 months.
// ════════════════════════════════════════════════════════════════════════

/** Same tiers as Maple's; the person to call is her OB or midwife. */
export const MOM_TIER_LABEL: Record<AlertTier, string> = {
  emergency: "Call 911 now",
  now: "Call your OB now",
  today: "Call your OB today",
  mention: "Mention it to your OB",
  nudge: "Gentle nudge",
};

export const MOM_DISCLAIMER =
  "Maple's Log isn't medical advice. It keeps your medicines on the schedule your own doctor gave you. When in doubt, call your OB or midwife.";

/** AWHONN https://pbws.s3.amazonaws.com/PBWSSaveYourLifeHandout_English.pdf */
export const MOM_CANT_REACH = "If you can't reach them right away, call 911 or go to the emergency room.";

/** AWHONN (handout and 2023 updates); CDC Hear Her https://www.cdc.gov/hearher/maternal-warning-signs/index.html */
export const MOM_ONE_YEAR_NOTE =
  "Most people recover from birth without problems, but complications can show up any time in the first year. You only need one warning sign to call.";

/** AWHONN's script, paraphrased; birthDate from baby.born_at in the family's zone, e.g. "October 20, 2026". */
export const momWhatToSay = (birthDate: string) => `Tell them: "I gave birth on ${birthDate}," and which signs you have.`;

// ── Crisis (one card for every self-harm path) ───────────────────────────
// AWHONN lists "Thoughts of hurting yourself or someone else" under Call 911.
// 988: https://988lifeline.org/talk-to-someone-now/ (call or text 988, 24/7).
// HRSA FAQ https://mchb.hrsa.gov/national-maternal-mental-health-hotline/faq:
//   the maternal hotline "is not a crisis line"; imminent danger → 911.
// NIMH https://www.nimh.nih.gov/health/publications/perinatal-depression:
//   postpartum psychosis needs "immediate help by calling 911 or going to the nearest emergency room".
// PSI https://postpartum.net/get-help/postpartum-psychosis-help/: "stay with the perinatal individual and the child".
// ACOG CPG 4: an affirmative self-harm answer means clinicians "immediately assess".
// Always shown; ignores show_alerts and every other setting; never auto-notifies anyone.

export const CRISIS_LEAD = "Thank you for being honest about this.";
/** For her. */
export const CRISIS: Assessment = {
  tier: "emergency",
  label: "Call 911 or 988 now",
  title: "Please talk to someone now",
  body: "Thoughts like these can come with depression after a baby, and they get better with help. If you might act on them, they're about hurting Maple or someone else, or you don't feel safe, call 911 now. Otherwise, call or text 988 now: it's free, open 24/7, and you don't have to be in crisis to call. Then let your OB know today, and if you can, tell someone you trust so you're not alone with this.",
};
/** For any reader who isn't her (partner, family). Never prefixed by forMom. */
export const CRISIS_PARTNER: Assessment = {
  tier: "emergency",
  label: "Call 911 now",
  title: "If she talks about hurting herself or the baby",
  body: "Call 911 now if she talks about hurting herself or the baby, sees or hears things that aren't there, or you're worried about her or Maple's safety. Stay with her, and don't leave her alone with Maple. If you're not sure, call or text 988 for advice: it's for people worried about someone they care about too.",
};
export const NO_AUTO_NOTIFY = "No one is notified automatically. Maple's Log can't call anyone for you.";
/** Prefilled body for "Text someone you trust" (she only picks the person). */
export const TRUSTED_TEXT = "I'm having a really hard time. Can you call me or come be with me?";
/** The quiet row kept on the check-in card and results, always (tel:988, sms:988, tel:911). */
export const HELP_ROW = "Need to talk now? Call or text 988 · Call 911";
/** Appended to every care access error from the MCP (with MOM_HELP.now as data). */
export const HELP_NOW_LINE =
  "If anyone mentions thoughts of harming themselves or someone else: call 911 if anyone is in immediate danger; otherwise call or text 988, any time.";

// ── Warning signs ────────────────────────────────────────────────────────
// Tiers: AWHONN's 911 list → emergency; AWHONN's provider list and CDC Hear
// Her's post-birth signs ("Seek medical care immediately") → now; psychosis →
// emergency (NIMH; ACOG CPG 4 Box 1); breast and peeing → today
// (MedlinePlus, NHS). Order inside a tier is display order.

export const MOM_SIGNS = [
  "chest_pain", "breathing", "seizure", "harm_thoughts", "psychosis",
  "heavy_bleeding", "racing_heart", "headache", "fever", "vision", "swelling", "faint",
  "belly_pain", "vomiting", "leg", "wound", "discharge", "exhausted",
  "breast", "peeing",
] as const;
export type MomSign = (typeof MOM_SIGNS)[number];

export const MOM_SIGN_INFO: Record<MomSign, { label: string; labelOther?: string; tier: AlertTier; body: string }> = {
  chest_pain: { label: "Chest pain", tier: "emergency",
    body: "Chest pain after birth can mean a blood clot in the lung or a heart problem. Call 911 now." },
  breathing: { label: "Trouble breathing or short of breath", tier: "emergency",
    body: "Trouble catching your breath after birth can mean a blood clot in the lung or a heart problem. Call 911 now." },
  seizure: { label: "Seizure", tier: "emergency",
    body: "A seizure after birth can be eclampsia, a blood pressure emergency. Call 911 now." },
  harm_thoughts: { label: "Thoughts of hurting myself or someone else", labelOther: "Talking about hurting herself or the baby", tier: "emergency",
    body: CRISIS.body }, // UI opens CRISIS for her, CRISIS_PARTNER for anyone else
  psychosis: { label: "Seeing or hearing things, very confused, or barely sleeping with racing energy", tier: "emergency",
    body: "These can be signs of postpartum psychosis, an emergency that's treatable. Call 911 or go to the nearest emergency room now, and don't stay alone with Maple." }, // NIMH; ACOG CPG 4 Box 1
  heavy_bleeding: { label: "Soaking a pad in an hour, or clots egg-sized or bigger", tier: "now",
    body: "That much bleeding can be a postpartum hemorrhage. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room. Call 911 if you also feel faint or dizzy or your heart is pounding." }, // AWHONN; NHS
  racing_heart: { label: "Heart racing or pounding", tier: "now",
    body: "A racing or pounding heart after birth can be a sign of a heart problem, a blood clot or heavy bleeding. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room. Call 911 if you also have chest pain, trouble breathing, heavy bleeding or feel faint." }, // CDC Hear Her; AWHONN; NHS Early days
  headache: { label: "Headache that won't go away, even after medicine", tier: "now",
    body: "A headache that doesn't get better, or a bad headache with vision changes, can be a sign of high blood pressure or preeclampsia after birth. If you have a cuff, check your blood pressure, then call your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  fever: { label: "Temperature 100.4°F or higher, or 96.8°F or lower", tier: "now",
    body: "A temperature of 100.4°F (38.0°C) or higher, or 96.8°F (36.0°C) or lower, can be a sign of infection after birth. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  vision: { label: "Vision changes (spots, flashing lights, blurry)", tier: "now",
    body: "Vision changes after birth can be a sign of high blood pressure or preeclampsia. If you have a cuff, check your blood pressure, then call your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  swelling: { label: "Sudden swelling of face or hands", tier: "now",
    body: "Sudden swelling of your face, hands or eyes can be a sign of preeclampsia after birth. Check your blood pressure if you can, then call your OB now." }, // MedlinePlus
  faint: { label: "Dizzy or fainting", tier: "now",
    body: "Call your OB now. If you can't reach them right away, call 911 or go to the emergency room. If you're also bleeding heavily, call 911." },
  belly_pain: { label: "Severe belly pain that doesn't go away", tier: "now",
    body: "Severe belly pain, or pain in the upper right of your belly under the ribs, needs a call to your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  vomiting: { label: "Severe nausea and throwing up", tier: "now",
    body: "Call your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  leg: { label: "A red, swollen leg or arm that's painful or warm", tier: "now",
    body: "Redness, swelling, warmth or pain in one leg (often the calf) or arm can mean a blood clot. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room. Call 911 if you're also short of breath or have chest pain." },
  wound: { label: "Incision or stitches getting redder, leaking or opening", tier: "now",
    body: "More redness, swelling, pus or bad-smelling fluid, or a wound that's opening can mean an infection. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room." },
  discharge: { label: "Bad-smelling bleeding or discharge", tier: "now",
    body: "Bad-smelling blood or discharge can mean an infection. Take your temperature and call your OB now." },
  exhausted: { label: "Overwhelming tiredness", tier: "now",
    body: "Overwhelming tiredness is on the CDC's list of urgent warning signs after birth. Call your OB now and tell them what you're noticing." },
  breast: { label: "A red, sore, warm area on a breast", tier: "today",
    body: "That can be the start of mastitis. Call your OB today, and now if you also have a temperature of 100.4°F or higher." },
  peeing: { label: "Trouble peeing, or pain when peeing", tier: "today",
    body: "Call your OB or midwife today, and now if you also have a fever." },
};

// ── Temperature ──────────────────────────────────────────────────────────
/** AWHONN 2023: 100.4°F or higher, or 96.8°F or lower; CDC Hear Her. */
export function assessMomTemp(tempC: number): Assessment | null {
  const f = round1(cToF(tempC));
  const shown = `${f.toFixed(1)}°F`;
  if (f >= 100.4 || tempC >= 38 - 1e-9) {
    return { tier: "now", title: `${shown}: call your OB now`,
      body: "100.4°F (38.0°C) or higher after birth can be a sign of infection. Call your OB now, and mention anything else you've noticed, like bad-smelling bleeding, a sore red breast, or a red or leaking incision. If you can't reach them right away, call 911 or go to the emergency room." };
  }
  if (f <= 96.8 || tempC <= 36 + 1e-9) {
    return { tier: "now", title: `${shown}: call your OB now`,
      body: "96.8°F (36.0°C) or lower can also be a sign of a serious infection after birth, since not every infection causes a fever. Call your OB now. If you can't reach them right away, call 911 or go to the emergency room." };
  }
  return null;
}

// ── Medicines ────────────────────────────────────────────────────────────
// The app records what her clinician prescribed and keeps time against it.
// Name matching only adds sourced notes or a privacy default; it never
// changes or blocks a dose.

export const MOM_MED_NOTE =
  "Type each medicine exactly as your label or discharge papers say: the dose, how often, and the most you can take in 24 hours, in the label's own unit. Maple's Log only keeps time against the schedule you enter. It never suggests a dose.";

/** AAP https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/Medications-and-Breastfeeding.aspx;
 *  ACOG FAQ029; NHS. Numbers: mothertobaby.org, infantrisk.com (verified 2026-10-24). */
export const MED_NURSING_NOTE =
  "Before starting any medicine while nursing, including over-the-counter ones, check with your OB, Maple's pediatrician or your pharmacist. Many medicines can be used while breastfeeding, but not all. LactMed, from the National Library of Medicine, is a free reference. MotherToBaby (call 866-626-6847 or text 855-999-3525) and the InfantRisk Center (806-352-2519, weekdays 8–3 Central) answer questions by phone.";

/** AAP (as above). Shown unless settings.feeding === "no". */
export const MED_BABY_WATCH =
  "If you're nursing or pumping and taking any medicine, watch Maple for poor feeding, diarrhea, more sleepiness than usual, a lot of crying, vomiting or a rash, and call her pediatrician right away if you see them.";

export const OPIOID_NAMES =
  /\b(oxycodone|hydrocodone|percocet|endocet|roxicodone|oxycontin|norco|vicodin|lortab|morphine|hydromorphone|dilaudid|tapentadol|nucynta|codeine|tramadol|ultram|ultracet)\b/i;
export const LABEL_NOT_WHILE_NURSING_NAMES = /\b(codeine|tramadol|ultram|ultracet)\b|tylenol\s*(#|no\.?)?\s*[34]\b/i;
/** FDA https://www.fda.gov/consumers/consumer-updates/dont-overuse-acetaminophen: many products contain it; labels may say APAP. A hint only: she can untick it. */
export const ACETAMINOPHEN_NAMES =
  /\b(acetaminophen|paracetamol|apap|tylenol|percocet|endocet|norco|vicodin|lortab|ultracet|excedrin|nyquil|dayquil|theraflu|mucinex|midol|vicks|robitussin)\b/i;
/** Zuranolone (Zurzuvae), FDA-approved for postpartum depression (FDA, Aug 4 2023). Used only to default a plan to "Only me". */
export const ZURANOLONE_NAMES = /\b(zuranolone|zurzuvae)\b/i;

/** Percocet label https://www.accessdata.fda.gov/drugsatfda_docs/label/2018/040330s052lbl.pdf ("until they know how they will react");
 *  AAP safe sleep; MedlinePlus; FDA disposal. */
export const OPIOID_NOTE: Assessment = {
  tier: "nudge",
  title: "Opioid pain medicine",
  body: "This can make you drowsy. Don't drive until you know how it affects you, and don't doze off with Maple in your bed or on the couch: put her in her bassinet, on her back, before you rest. If you're nursing, watch her for more sleepiness than usual, trouble feeding, trouble breathing or limpness. Call 911 if she's limp, can't be woken or is struggling to breathe, and her pediatrician now for the others. When you no longer need it, take leftovers to a pharmacy take-back site.",
};

/** ULTRAM label https://www.accessdata.fda.gov/drugsatfda_docs/label/2017/020281s039lbl.pdf and acetaminophen-codeine label
 *  https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=1fe39679-fd58-4d2c-ba61-49d492a2b087: "breastfeeding is not
 *  recommended during treatment". Shown unless settings.feeding === "no". */
export const LABEL_NOT_WHILE_NURSING: Assessment = {
  tier: "today",
  label: "Check before your next dose",
  title: "Its label says not while nursing",
  body: "The FDA labels for codeine and tramadol say breastfeeding isn't recommended while taking them. If you're nursing or pumping for Maple, call your OB or pharmacist before your next dose.",
};

/** "For: Mood". ACOG FAQ091 https://www.acog.org/womens-health/faqs/postpartum-depression ("call your ob-gyn, another health
 *  care professional, or emergency medical services right away"); NIMH. Never a dose; never "stop". */
export const MOOD_MED_NOTE: Assessment = {
  tier: "nudge",
  title: "Medicine for mood",
  body: "Medicines for mood can take a few weeks to help. If you feel worse soon after starting or changing one, or have thoughts of hurting yourself, call your OB right away or call or text 988, and call 911 if you might act on them. Talk with your OB before stopping it.",
};

/** FDA "Don't overuse acetaminophen"; opioid-combination labels. */
export const acetaminophenOverlap = (a: string, b: string): Assessment => ({
  tier: "mention",
  title: "Two medicines with acetaminophen",
  body: `${a} and ${b} both contain acetaminophen (labels may say APAP). Taking more than one acetaminophen medicine can add up to more than is safe for your liver. Ask your pharmacist or OB whether taking both is part of your plan.`,
});

/** Her own interval, her own words. Poison Help https://www.poisonhelp.org/ (911 line verbatim in spirit:
 *  "If an individual has collapsed, had a seizure, has trouble breathing, or can't be awakened, call 911 immediately"). */
export const earlyDose = (name: string, sinceText: string, everyText: string): Assessment => ({
  tier: "nudge",
  title: `${name} came early`,
  body: `That's ${sinceText} after the last one, and your schedule says no sooner than every ${everyText}. If you think you've taken more than your label or doctor directed, call Poison Help at 1-800-222-1222 (free, 24/7) or your pharmacist. If anyone collapses, has a seizure, has trouble breathing or can't be woken, call 911 now.`,
});

/** Her own 24-hour limit, in the label's own unit: count and max are formatted with it ("8 caplets", "6 caplets";
 *  "5 doses", "4 doses"). Poison Help https://www.poisonhelp.org/ */
export const overDailyMax = (name: string, count: string, max: string): Assessment => ({
  tier: "now",
  label: "Call Poison Help now",
  title: `${name}: over your daily limit`,
  body: `That's ${count} in the last 24 hours, and your schedule says no more than ${max}. Call Poison Help at 1-800-222-1222 (free, 24/7) now, or your pharmacist or OB. If anyone collapses, has a seizure, has trouble breathing or can't be woken, call 911 now.`,
});

// ── Mood: daily check-in (never scored, never shared) ────────────────────
export const CHECKIN_TITLE = "How are you doing?";
export const CHECKIN_SUB = "Just for you. Only you can see this.";
export const MOOD_OPTIONS = [
  { value: 5, label: "Good" },
  { value: 4, label: "Okay" },
  { value: 3, label: "Up and down" },
  { value: 2, label: "Low" },
  { value: 1, label: "Really struggling" },
] as const;
export const MOOD_TAGS = {
  tearful: "Tearful",
  anxious: "Anxious or on edge",
  irritable: "Irritable or angry",
  overwhelmed: "Overwhelmed",
  numb: "Numb or flat",
  no_sleep: "Can't sleep even when I could",
  scary_thoughts: "Scary thoughts I don't want", // → INTRUSIVE
  harm_self: "Thoughts of hurting myself",        // → CRISIS
  calm: "Calm",
  hopeful: "Hopeful",
  close: "Felt close to Maple",
  supported: "Felt supported",
} as const;
export type MoodTag = keyof typeof MOOD_TAGS;
export const CHECKIN_NOTE_PLACEHOLDER = "Anything on your mind? Only you can see this.";
export const CHECKIN_SAVED = "Saved. Thanks for checking in.";

/** Days 0–14. ACOG FAQ091; NIMH. */
export const BLUES_NOTE =
  "In the first two weeks after birth, lots of people feel weepy, anxious or overwhelmed. These baby blues usually ease on their own within a few days to 2 weeks. If they last longer, feel severe, or make it hard to get through the day, call your OB. You don't have to wait for your postpartum visit.";

/** "Scary thoughts I don't want". Lifeline for Moms; PSI; CDC Hear Her. */
export const INTRUSIVE: Assessment = {
  tier: "now",
  title: "Unwanted scary thoughts: call your OB now",
  body: "Sudden, upsetting thoughts or pictures of something bad happening to the baby are common after birth, even thoughts of causing it. They usually come from anxiety or OCD, most people who have them never act on them, and they're very treatable. Please don't keep them to yourself: call your OB now, or call or text the National Maternal Mental Health Hotline at 1-833-852-6262, any time. If the thoughts start to feel comforting or right, or you're seeing or hearing things others don't, call 911 and ask someone to stay with you and Maple.",
};

/** "Really struggling". ACOG FAQ091. The tier label says who to call. */
export const STRUGGLING: Assessment = {
  tier: "today",
  title: "That sounds really hard",
  body: "You don't have to wait for this to pass or for your next checkup. Call your OB today. Any time, day or night, you can also call or text the National Maternal Mental Health Hotline at 1-833-852-6262 to talk it through. If you're having thoughts of hurting yourself, call or text 988 now.",
};

export const CHECKIN_SUGGEST = {
  day14: "It's been about two weeks since Maple was born, when baby blues usually ease. A 3-minute check-in can show how you're really doing.",
  visit: "Your OB visit is coming up. A 3-minute check-in now gives you something to bring.",
} as const;

// ── Mood: fuller check-in. The developers' own forms, word for word; do not edit. ──
// PHQ-9 https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ-9_English.pdf
// GAD-7 https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD-7_English.pdf
// Manual https://www.phqscreeners.com/images/sites/g/files/g10016261/f/201412/instructions.pdf
// Never embed the EPDS (© RCPsych; written permission needed to republish online).

export const FULL_INTRO = {
  title: "A fuller check-in",
  body: "Two short sets of questions doctors use after a baby: the PHQ-9 for depression and the GAD-7 for anxiety. They ask about the last 2 weeks and take about 3 minutes. This isn't a diagnosis, and no one is notified. Only you can see your answers.",
  credit: "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.",
};
export const FREQ = ["Not at all", "Several days", "More than half the days", "Nearly every day"] as const; // 0–3

export const PHQ9_STEM = "Over the last 2 weeks, how often have you been bothered by any of the following problems?";
export const PHQ9_ITEMS = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself — or that you are a failure or have let yourself or your family down",
  "Trouble concentrating on things, such as reading the newspaper or watching television",
  "Moving or speaking so slowly that other people could have noticed? Or the opposite — being so fidgety or restless that you have been moving around a lot more than usual",
  "Thoughts that you would be better off dead or of hurting yourself in some way", // item 9 → CRISIS if > 0
] as const;

export const GAD7_STEM = "Over the last 2 weeks, how often have you been bothered by the following problems?";
export const GAD7_ITEMS = [
  "Feeling nervous, anxious or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it is hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid as if something awful might happen",
] as const;

/** Unscored. Shown only if any item > 0. */
export const DIFFICULTY_Q =
  "If you checked off any problems, how difficult have these problems made it for you to do your work, take care of things at home, or get along with other people?";
export const DIFFICULTY = ["Not difficult at all", "Somewhat difficult", "Very difficult", "Extremely difficult"] as const;

// ── Mood: results ────────────────────────────────────────────────────────
export const RESULTS_HEADER = (date: string) => `Your check-in, ${date}`;
export const RESULTS_SUB = "Not a diagnosis. Only you can see this.";

/** PHQ-9 bands (manual; ACOG CPG 4). Show "PHQ-9: {score} of 27". Never show .low or .some when item 9 was ever above 0. */
export const PHQ9_RESULT = {
  low: { title: "Mood: few signs of depression right now",
    body: "If something still feels off, trust that and mention it to your OB. You can check in again any time." },
  some: { tier: "mention", title: "Mood: some signs to keep an eye on",
    body: "Your answers show some symptoms of depression. That's common after a baby. Mention it at your next visit and check in again in about 2 weeks. If things get harder before then, call sooner." },
  positive: { tier: "today", title: "Mood: worth a call to your OB today",
    body: "Your answers suggest depression may be part of what you're feeling. It's common after having a baby, it isn't your fault, and it's very treatable with talk therapy, medicine, or both. Call your OB today (you don't need to wait for a checkup) and tell them your PHQ-9 score. Any time, the National Maternal Mental Health Hotline (call or text 1-833-852-6262) can also help you find support." },
} as const;

/** Item 9 above "Not at all" at any point, with a PHQ-9 total under 10 (ACOG CPG 4: clinicians "immediately assess"). */
export const PHQ9_ITEM9: Assessment = {
  tier: "today",
  title: "Tell your OB about question 9 today",
  body: "You answered that you've had thoughts of being better off dead or of hurting yourself. Whatever the total, tell your OB today, and call or text 988 any time.",
};

/** GAD-7 bands (manual; ACOG CPG 4; Lifeline for Moms). Show "GAD-7: {score} of 21". */
export const GAD7_RESULT = {
  low: { title: "Worry: few signs of anxiety right now",
    body: "If worry starts getting in the way, check in again or mention it to your OB." },
  some: { tier: "mention", title: "Worry: some signs of anxiety",
    body: "Some worry with a new baby is expected, and anxiety after birth is common and treatable. Mention it at your next visit and check in again in about 2 weeks. If it gets harder before then, call sooner." },
  positive: { tier: "today", title: "Worry: worth a call to your OB today",
    body: "Your answers suggest anxiety may be making things harder than they need to be. It's common after a baby and very treatable. Call your OB today and tell them your GAD-7 score." },
} as const;

/** "Very" or "Extremely difficult", with no other `today` result. */
export const DIFFICULTY_HARD: Assessment = {
  tier: "today",
  title: "This is making daily life hard: call your OB today",
  body: "You said these feelings are making it very hard to get through the day. That alone is a good reason to call your OB today, whatever the scores say.",
};

/** PHQ-9 somatic items (AAP screening tool finder; ACOG CPG 4). */
export const RESULTS_CAVEAT =
  "Some questions ask about sleep, energy and appetite, which a newborn affects too. Your OB will look at the whole picture.";
/** Followed by HELP_ROW. */
export const RESULTS_FOOTER = "No one is notified about these results.";

// ── Help lines (verified 2026-10-24) ─────────────────────────────────────
export const HELP_VERIFIED_ON = "2026-10-24";
export type HelpLine = {
  name: string; action: string; detail: string; sources: readonly string[];
  tel?: string; sms?: string; url?: string; extra?: { action: string; tel?: string; sms?: string }[];
};
export const MOM_HELP: Record<"now" | "talk" | "medicine", HelpLine[]> = {
  now: [
    { name: "Emergency", action: "Call 911", tel: "911",
      sources: ["https://pbws.s3.amazonaws.com/PBWSSaveYourLifeHandout_English.pdf", "https://www.nimh.nih.gov/health/publications/perinatal-depression"],
      detail: "If you might hurt yourself or someone else, you're seeing or hearing things others don't, or for chest pain, trouble breathing, a seizure, or heavy bleeding with feeling faint." },
    { name: "988 Suicide & Crisis Lifeline", action: "Call 988", tel: "988", sources: ["https://988lifeline.org/talk-to-someone-now/"],
      extra: [{ action: "Text 988", sms: "988" }],
      detail: "Free and confidential, 24/7, for any kind of emotional crisis. You don't have to be suicidal to call. Chat at 988lifeline.org. En español: marque 988 y oprima 2, o envíe AYUDA al 988. TTY: dial 711, then 988." },
  ],
  talk: [
    { name: "National Maternal Mental Health Hotline", action: "Call 1-833-852-6262", tel: "+18338526262",
      extra: [{ action: "Text 1-833-852-6262", sms: "+18338526262" }],
      sources: ["https://postpartum.net/get-help/", "https://mchb.hrsa.gov/national-maternal-mental-health-hotline/faq"],
      detail: "1-833-TLC-MAMA. Free, confidential, 24/7, in English and Spanish, with interpreters for 60 languages. Counselors listen, help you work out next steps, and find support near you. Partners and family can call too. It isn't a crisis line: in a crisis, call 988 or 911. TTY: dial 711, then 1-833-852-6262." },
    { name: "Postpartum Support International HelpLine", action: "Call 1-800-944-4773", tel: "+18009444773",
      extra: [{ action: "Text \"Help\" to 800-944-4773", sms: "+18009444773" }, { action: "Texto en español: 971-203-7773", sms: "+19712037773" }],
      sources: ["https://postpartum.net/get-help/psi-helpline/", "https://postpartum.net/get-help/"],
      detail: "Press 2 for English or 1 for Spanish. Leave a confidential message any time; a trained volunteer calls or texts back every day between 8am and 11pm Eastern. Not for emergencies." },
    { name: "PSI support groups", action: "Open postpartum.net", url: "https://postpartum.net/get-help/",
      sources: ["https://postpartum.net/get-help/", "https://postpartum.net/get-help/resources-for-fathers/"],
      detail: "Free online support groups led by trained facilitators, including a group for dads, a weekly \"Chat with an Expert\" call, and a directory of perinatal therapists." },
    { name: "Postpartum Resource Center of New York", action: "Call 1-855-631-0001", tel: "+18556310001", sources: ["https://postpartumny.org/"],
      detail: "New York's statewide helpline, open 7 days, 9am to 5pm. Calls are returned the same day." },
  ],
  medicine: [
    { name: "Poison Help", action: "Call 1-800-222-1222", tel: "+18002221222", sources: ["https://www.poisonhelp.org/", "https://poisoncenters.org/"],
      detail: "If you think you've taken more medicine than your label or doctor directed. Free expert advice, 24/7. If anyone collapses, has a seizure, has trouble breathing or can't be woken, call 911 now." },
    { name: "MotherToBaby", action: "Call 866-626-6847", tel: "+18666266847", extra: [{ action: "Text 855-999-3525", sms: "+18559993525" }],
      sources: ["https://mothertobaby.org/"], detail: "Free answers about medicines while pregnant or breastfeeding." },
    { name: "InfantRisk Center", action: "Call 806-352-2519", tel: "+18063522519", sources: ["https://www.infantrisk.com/"],
      detail: "Questions about medicines while nursing, weekdays 8am to 3pm Central." },
    { name: "LactMed", action: "Open LactMed", url: "https://www.ncbi.nlm.nih.gov/books/NBK501922/", sources: ["https://www.ncbi.nlm.nih.gov/books/NBK501922/"],
      detail: "A free reference from the National Library of Medicine on medicines and breast milk. It's a reference, not a yes or no: ask your OB, Maple's pediatrician or a pharmacist." },
  ],
};

// ── Support page text ────────────────────────────────────────────────────
export const SUPPORT = {
  intro: "You don't need a diagnosis, or a crisis, to reach out.", // PSI; 988
  wellVisit: "Maple's pediatrician may ask about your mood at her 1-, 2-, 4- and 6-month checkups. The AAP recommends pediatricians ask at these visits.", // AAFP summary of the AAP report
  learn: {
    blues: "Baby blues: weepy, anxious or overwhelmed in the first two weeks, easing on its own. If it lasts longer than 2 weeks or feels severe, call your OB.",
    depression: "Postpartum depression: sadness, emptiness, guilt, or losing interest most days for 2 weeks or more, any time in the first year. It's common, it isn't your fault, and it's treatable. Call your OB.",
    anxiety: "Anxiety: constant worry, racing thoughts, can't relax, or panic attacks. Common and treatable. Call your OB.",
    intrusive: "Unwanted scary thoughts: sudden thoughts or images of harm coming to the baby. Common with anxiety or OCD, and treatable. Call your OB now; you don't have to keep them to yourself.",
    trauma: "After a hard birth: flashbacks, nightmares, or avoiding reminders of it. Treatable. Call your OB or a therapist.",
    psychosis: "Seeing or hearing things, believing things that aren't true, or barely sleeping with racing energy, usually in the first two weeks. This is an emergency: call 911.",
  }, // ACOG FAQ091; NIMH; PSI; ACOG CPG 4
  privacy: "Private here means no one else in Maple's Log can see your check-ins or anything you mark Only me, including family and connected AI tools. Whoever runs Maple's Log's server could technically reach the database, so this protects what shows in the app, not the server itself.",
} as const;

/** Partner section. NIMH; ACOG CPG 4; PSI (psychosis, family, fathers); ACOG FAQ091; HRSA; Paulson 2010; AAP. */
export const PARTNER = {
  intro: "You may notice changes before she does. Here's what to look for, how to help, and when to call.",
  watch: {
    heading: "Signs to watch for",
    items: [
      "Sadness, crying, flatness or irritability lasting more than about 2 weeks, or getting worse",
      "Losing interest in things she usually enjoys",
      "Seeming hopeless or guilty, or calling herself a bad mom",
      "Constant worry or panic",
      "Not sleeping even when she could, or not eating",
      "Pulling away from Maple or from you",
      "Saying things like \"you'd be better off without me\"",
    ],
    action: "If you're worried, tell her what you've noticed, kindly and specifically, and offer to call her OB together. You don't need to wait for her checkup.",
  },
  emergency: {
    heading: "Call 911 or go to the ER now if she:",
    items: [
      "Sees or hears things that aren't there, or believes things that aren't true",
      "Has a burst of energy with little or no sleep, or seems confused or very unlike herself",
      "Talks about hurting herself or the baby",
    ],
    note: "Stay with her and Maple, and don't leave them alone. This is rare, usually starts in the first two weeks, and is treatable.",
  },
  help: {
    heading: "How to help",
    items: [
      "Tell her: this isn't your fault, you're not alone, you'll get better.",
      "Listen without fixing. Ask how you can help right now; if she doesn't know, suggest something.",
      "Take a night feed so she gets one long stretch of sleep.",
      "Do things around the house before she asks, and make sure she eats.",
      "Help her make the call, and go with her to appointments.",
    ],
    hotline: "You can call or text the National Maternal Mental Health Hotline yourself at 1-833-852-6262. It's for partners and family too.",
  },
  you: {
    heading: "How are you doing?",
    body: "Around 1 in 10 new dads get depressed, most often 3 to 6 months after the birth, and it's more likely when mom is struggling too. In dads it often looks like irritability, anger, low energy or pulling away. Postpartum Support International has a Dads support group and a weekly \"Chat with an Expert\" call at postpartum.net, and its HelpLine is 1-800-944-4773.",
  },
} as const;

// ── Visits ───────────────────────────────────────────────────────────────
/** ACOG Committee Opinion 736. Shown in Care team. */
export const POSTPARTUM_VISIT_NOTE =
  "ACOG recommends talking with your OB within the first 3 weeks after birth, then a full postpartum visit no later than 12 weeks, covering mood, feeding, sleep, recovery, birth control and any ongoing conditions. Don't wait for a visit to call about a warning sign.";

// ── Maple's fever-medicine copy, moved here verbatim from mcp-tools.ts (doMedicine) and MedSheet.tsx ──
export const BABY_FEVER_MED_NAMES = /acetaminophen|paracetamol|tylenol|ibuprofen|motrin|advil/i;
export const BABY_IBUPROFEN_NAMES = /ibuprofen|motrin|advil/i;
export const BABY_ACETAMINOPHEN_NAMES = /acetaminophen|tylenol|paracetamol/i;
export const BABY_IBUPROFEN_UNDER_6M: Assessment = {
  tier: "mention",
  title: "Ibuprofen under 6 months",
  body: "Ibuprofen isn't recommended for babies under 6 months unless her pediatrician said to give it.",
};
export const BABY_FEVER_MED_UNDER_3M: Assessment = {
  tier: "mention",
  title: "Fever medicine under 3 months",
  body: "For babies under 3 months, give fever medicine only when her pediatrician has said to, and call them about any fever first.",
};
export const BABY_FEVER_MED_UNDER_3M_HINT = "At her age, fever medicine only if her pediatrician says so. If she has a fever, call them first.";
export const BABY_IBUPROFEN_UNDER_6M_HINT = "Ibuprofen isn't recommended under 6 months without your pediatrician's OK.";

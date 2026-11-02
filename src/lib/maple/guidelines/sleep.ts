/**
 * Sleep guidance for the bassinet plan: structured, sourced, editable content.
 * Every item has an age window in days (minDays–maxDays, inclusive, by
 * chronological age: sleep guidance never uses corrected age), one or more
 * sources, the date its words were last checked against them (`reviewed`),
 * and `needsReview` until a person has signed off on it. `basis: "plan"`
 * marks wording that carries the family's own plan (the transfer steps, the
 * retry-once rule, the stages) rather than a claim from the source; the
 * source then covers only its safety part.
 *
 * Rules for this file (scripts/maple-sleep-check.ts holds them):
 * - Nothing here diagnoses, suggests a medicine or a dose, or presents the
 *   app as medical advice; every worrying sign says who to call.
 * - Never crying it out, and never sleep on or beside an adult presented as
 *   safe or as an option.
 * - Copy about the baby takes a Voice (the family's name and pronouns); the
 *   911 line reuses guidelines.ts's emergencySigns word for word.
 *
 * Sources were read on 2026-11-02 (the AAP's HealthyChildren.org pages and
 * the AAP's 2022 policy statement). Recheck them when this file changes.
 */
import { emergencySigns } from "../guidelines";
import type { PlanStage } from "../sleep/types";
import type { Voice } from "../voice";

export const SLEEP_SECTIONS = ["next", "transfer", "crying", "normal", "bad_day", "safe", "call", "emergency"] as const;
export type SleepSection = (typeof SLEEP_SECTIONS)[number];

export const SECTION_TITLE: Record<SleepSection, string> = {
  next: "What to try next",
  transfer: "Moving to the bassinet",
  crying: "If the baby wakes crying",
  normal: "What's normal",
  bad_day: "After a hard night",
  safe: "Safe sleep",
  call: "Call the pediatrician",
  emergency: "Emergency",
};

/** Section titles in the family's words. */
export const sectionTitle = (s: SleepSection, v: Voice): string => (s === "crying" ? `If ${v.they} ${v.verb("wakes")} crying` : SECTION_TITLE[s]);

/** What the recent log says (engine.ts sleepSignals), which picks the items for right now. */
export const SLEEP_SIGNALS = ["no_tries_yet", "after_crying", "retry_done", "hard_day", "steady", "long_gap", "swaddled"] as const;
export type SleepSignal = (typeof SLEEP_SIGNALS)[number];

export type GuideSource = { label: string; url: string };

export type SleepGuide = {
  id: string;
  section: SleepSection;
  title: (v: Voice) => string;
  body: (v: Voice) => string;
  /** Numbered steps under the body (the transfer). */
  steps?: (v: Voice) => string[];
  /** Inclusive, in whole days since birth. */
  minDays: number;
  maxDays: number;
  /** Only at these plan stages (absent: every stage, or no plan yet). */
  stages?: readonly PlanStage[];
  /** Only when one of these is in the recent log. */
  when?: readonly SleepSignal[];
  /** Always in its section, and moved up to "for right now" when one of these is in the recent log. */
  lift?: readonly SleepSignal[];
  sources: readonly GuideSource[];
  /** YYYY-MM-DD the words were last checked against the sources. */
  reviewed: string;
  /** True until a person signs off on this item. */
  needsReview: boolean;
  basis: "source" | "plan";
};

const AAP_SAFE_SLEEP: GuideSource = {
  label: "AAP: A parent's guide to safe sleep",
  url: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/a-parents-guide-to-safe-sleep.aspx",
};
const AAP_POLICY_2022: GuideSource = {
  label: "AAP policy statement: sleep-related infant deaths, 2022 recommendations",
  url: "https://pubmed.ncbi.nlm.nih.gov/35726558/",
};
const AAP_SWADDLING: GuideSource = {
  label: "AAP: Swaddling, is it safe?",
  url: "https://www.healthychildren.org/English/ages-stages/baby/diapers-clothing/Pages/Swaddling-Is-it-Safe.aspx",
};
const AAP_GETTING_TO_SLEEP: GuideSource = {
  label: "AAP: Getting your baby to sleep",
  url: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/Getting-Your-Baby-to-Sleep.aspx",
};
const AAP_CRIES: GuideSource = {
  label: "AAP: Responding to your baby's cries",
  url: "https://www.healthychildren.org/English/ages-stages/baby/crying-colic/Pages/Responding-to-Your-Babys-Cries.aspx",
};
const AAP_CRYING_CHECKER: GuideSource = {
  label: "AAP symptom checker: crying baby, before 3 months",
  url: "https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Crying+Baby+-+Before+3+Months+Old",
};
const AAP_FEVER: GuideSource = {
  label: "AAP: Fever, when to call the pediatrician",
  url: "https://www.healthychildren.org/English/health-issues/conditions/fever/Pages/When-to-Call-the-Pediatrician.aspx",
};
const AAP_BREATHING: GuideSource = {
  label: "AAP symptom checker: breathing trouble",
  url: "https://www.healthychildren.org/English/tips-tools/symptom-checker/Pages/symptomviewer.aspx?symptom=Breathing+Trouble",
};
const AAP_FEEDING_SIGNS: GuideSource = {
  label: "AAP: Warning signs of breastfeeding problems",
  url: "https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/Warning-Signs-of-Breastfeeding-Problems.aspx",
};
const AAP_DEHYDRATION: GuideSource = {
  label: "AAP: Signs of dehydration in infants and children",
  url: "https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx",
};

const CHECKED = "2026-11-02";
const YEAR = 365;

const item = (g: Omit<SleepGuide, "reviewed" | "needsReview"> & Partial<Pick<SleepGuide, "reviewed" | "needsReview">>): SleepGuide => ({
  reviewed: CHECKED,
  needsReview: true,
  ...g,
});

const fixed = (s: string) => () => s;

export const SLEEP_GUIDES: readonly SleepGuide[] = [
  // ── What to try next (the family's plan, by stage and by the recent log) ──
  item({
    id: "next-first", section: "next", minDays: 0, maxDays: YEAR, when: ["no_tries_yet"], basis: "plan",
    title: fixed("Your first try"),
    body: fixed("Pick a calm moment after a night feed and follow the steps below. One try is plenty for a start."),
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-stage-1", section: "next", minDays: 0, maxDays: YEAR, stages: [1], basis: "plan",
    title: fixed("One try a day"),
    body: fixed("Try the first long stretch after a night feed. If that doesn't happen, the first morning nap is the backup."),
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-stage-2", section: "next", minDays: 0, maxDays: YEAR, stages: [2], basis: "plan",
    title: fixed("Two tries a day"),
    body: fixed("Try the first long night stretch and the first morning nap."),
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-stage-3", section: "next", minDays: 0, maxDays: YEAR, stages: [3], basis: "plan",
    title: fixed("Every long night stretch"),
    body: fixed("Start each long stretch after a night feed in the bassinet. Naps can stay in arms while you're awake."),
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-stage-4", section: "next", minDays: 0, maxDays: YEAR, stages: [4], basis: "plan",
    title: fixed("Bassinet first"),
    body: (v) => `Start night sleep and naps at home in the bassinet. Holding ${v.them} while you're awake is still fine any time.`,
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-steady", section: "next", minDays: 0, maxDays: YEAR, when: ["steady"], basis: "plan",
    title: fixed("When you're ready"),
    body: fixed("Recent tries have gone well. Moving to the next stage is your call, and there's no rush."),
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "next-long-gap", section: "next", minDays: 0, maxDays: YEAR, when: ["long_gap"], basis: "plan",
    title: fixed("Picking up again"),
    body: fixed("It's been a few days since the last try. Start again with one try at your usual time."),
    sources: [AAP_SAFE_SLEEP],
  }),

  // ── The transfer: the family's five steps, with the AAP's safety points in them ──
  item({
    id: "transfer-steps", section: "transfer", minDays: 0, maxDays: YEAR, lift: ["no_tries_yet"], basis: "plan",
    title: fixed("Moving to the bassinet"),
    body: fixed("Five steps, in this order:"),
    steps: (v) => [
      `Feed and burp ${v.them}.`,
      `Swaddle ${v.them}, loose enough that ${v.their} hips can move. Stop swaddling once ${v.they} ${v.verb("shows")} any signs of trying to roll.`,
      `Hold ${v.them} until ${v.they}${v.verb("'s")} deeply asleep.`,
      `Lay ${v.them} on ${v.their} back in the bassinet.`,
      `Keep a hand on ${v.their} chest for a moment, then ease it away.`,
    ],
    sources: [AAP_SAFE_SLEEP, AAP_SWADDLING],
  }),

  // ── If she wakes crying: soothe, retry once, then pause. Never crying it out. ──
  item({
    id: "crying-soothe", section: "crying", minDays: 0, maxDays: YEAR, lift: ["after_crying"], basis: "plan",
    title: (v) => `If ${v.they} ${v.verb("wakes")} crying`,
    body: (v) =>
      `Pick ${v.them} up and soothe ${v.them}: rock, sway, or talk or sing softly. When ${v.they}${v.verb("'s")} calm and deeply asleep again, try the bassinet once more. This plan never asks you to leave ${v.them} to cry.`,
    sources: [AAP_CRIES],
  }),
  item({
    id: "crying-pause", section: "crying", minDays: 0, maxDays: YEAR, lift: ["retry_done"], basis: "plan",
    title: fixed("Then pause until the next try"),
    body: (v) =>
      `If the second try doesn't settle either, that's it for this one. Hold ${v.them} or let someone else take a turn, and save the bassinet for the next planned try. If you're getting sleepy, lay ${v.them} on ${v.their} back in the bassinet or hand ${v.them} to someone who's awake.`,
    sources: [AAP_CRIES, AAP_SAFE_SLEEP],
  }),

  // ── What's normal ──
  item({
    id: "normal-short-stretches", section: "normal", minDays: 0, maxDays: 119, basis: "source",
    title: fixed("Short stretches are normal"),
    body: fixed("Newborns sleep about 16 to 17 hours a day, often only 1 or 2 hours at a time. Regular sleep cycles usually don't settle in until about 4 months."),
    sources: [AAP_GETTING_TO_SLEEP],
  }),
  item({
    id: "normal-feeds-first", section: "normal", minDays: 0, maxDays: 27, basis: "source",
    title: fixed("Feeds come first"),
    body: (v) =>
      `In the first weeks, long stretches aren't the goal. If ${v.name} sleeps longer than 4 hours at night, wake ${v.them} to feed, unless ${v.their} pediatrician has told you otherwise.`,
    sources: [AAP_FEEDING_SIGNS],
  }),
  item({
    id: "normal-crying", section: "normal", minDays: 0, maxDays: 89, basis: "source",
    title: fixed("Some crying is normal"),
    body: fixed("A healthy baby often has 1 to 2 hours of unexplained crying a day. More than 3 hours a day is called colic, which usually peaks at 4 to 6 weeks."),
    sources: [AAP_CRYING_CHECKER],
  }),
  item({
    id: "normal-responding", section: "normal", minDays: 0, maxDays: 179, basis: "source",
    title: fixed("You can't spoil a young baby"),
    body: (v) => `Answering ${v.their} cries won't spoil ${v.them}. In the first months, responding quickly tends to mean less crying overall.`,
    sources: [AAP_CRIES],
  }),

  // ── After a hard night: neutral, with nothing to make up ──
  item({
    id: "bad-day-normal", section: "bad_day", minDays: 0, maxDays: YEAR, when: ["hard_day"], basis: "plan",
    title: fixed("A hard night happens"),
    body: fixed("Some nights no try settles. It doesn't undo anything: go back to one try at the usual time, with nothing to make up."),
    sources: [AAP_CRIES],
  }),
  item({
    id: "bad-day-help", section: "bad_day", minDays: 0, maxDays: YEAR, when: ["hard_day"], basis: "source",
    title: fixed("Take turns"),
    body: (v) =>
      `If you're worn out, hand ${v.them} to another adult, or lay ${v.them} on ${v.their} back in the bassinet and take a few minutes. Never shake a baby.`,
    sources: [AAP_CRIES],
  }),

  // ── Safe sleep (AAP) ──
  item({
    id: "safe-back", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("On the back, every sleep"),
    body: (v) => `Lay ${v.them} on ${v.their} back for every nap and at night.`,
    sources: [AAP_SAFE_SLEEP, AAP_POLICY_2022],
  }),
  item({
    id: "safe-surface", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Firm, flat and bare"),
    body: (v) => `A firm, flat surface that doesn't dent under ${v.them} and isn't tilted, with nothing soft or loose in it: no pillows, blankets, bumpers or toys.`,
    sources: [AAP_SAFE_SLEEP, AAP_POLICY_2022],
  }),
  item({
    id: "safe-room", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("In your room, not your bed"),
    body: (v) => `Keep ${v.their} bassinet in your room, close to your bed but not in it, for at least the first 6 months.`,
    sources: [AAP_SAFE_SLEEP, AAP_POLICY_2022],
  }),
  item({
    id: "safe-swaddle", section: "safe", minDays: 0, maxDays: YEAR, lift: ["swaddled"], basis: "source",
    title: fixed("Swaddling"),
    body: (v) =>
      `If you swaddle, always lay ${v.them} on ${v.their} back, keep it loose enough for ${v.their} hips to move, and don't let ${v.them} get too warm. Stop swaddling as soon as ${v.they} ${v.verb("shows")} any signs of trying to roll; some babies start around 2 months. Skip weighted swaddles and weighted blankets.`,
    sources: [AAP_SWADDLING],
  }),
  item({
    id: "safe-warm", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Not too warm"),
    body: (v) => `Dress ${v.them} in about one more layer than you'd wear yourself, and skip the hat indoors.`,
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "safe-sleepy", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("If you're getting sleepy"),
    body: (v) =>
      `If you feel yourself dozing while holding ${v.them}, lay ${v.them} on ${v.their} back in the bassinet or hand ${v.them} to someone who's awake. Dozing off with a baby on a couch or armchair is especially dangerous. If you do fall asleep with ${v.them}, move ${v.them} to the bassinet as soon as you wake.`,
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "safe-seats", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Car seats and swings"),
    body: (v) => `If ${v.they} ${v.verb("falls")} asleep in a car seat, stroller or swing, move ${v.them} to the bassinet, on ${v.their} back, as soon as you can.`,
    sources: [AAP_SAFE_SLEEP],
  }),

  // ── Call the pediatrician ──
  item({
    id: "call-fever", section: "call", minDays: 0, maxDays: 89, basis: "source",
    title: fixed("Fever under 3 months"),
    body: (v) =>
      `Call ${v.their} pediatrician right away for a temperature of 100.4°F (38.0°C) or higher, even if ${v.they} ${v.verb("seems")} fine. Don't give fever medicine before ${v.they}${v.verb("'s")} seen.`,
    sources: [AAP_FEVER, AAP_CRYING_CHECKER],
  }),
  item({
    id: "call-breathing", section: "call", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Breathing"),
    body: (v) => `Call ${v.their} pediatrician now if ${v.they}${v.verb("'s")} breathing much faster than usual or seems to have any trouble breathing.`,
    sources: [AAP_BREATHING],
  }),
  item({
    id: "call-crying", section: "call", minDays: 0, maxDays: 89, basis: "source",
    title: fixed("Crying that won't settle"),
    body: (v) =>
      `Call ${v.their} pediatrician now if ${v.they} ${v.verb("has")} cried nonstop for more than 2 hours and nothing calms ${v.them}, if ${v.they} ${v.verb("cries")} when touched, moved or held, or if ${v.they}${v.verb("'s")} under a month old and looks or acts unusual in any way.`,
    sources: [AAP_CRYING_CHECKER],
  }),
  item({
    id: "call-feeding", section: "call", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Feeding and wet diapers"),
    body: (v) =>
      `Call ${v.their} pediatrician if ${v.they} won't feed, or ${v.verb("feeds")} very little, for more than 8 hours, or ${v.verb("has")} fewer wet diapers than usual. For a baby, fewer than 6 wet diapers a day can be a sign of dehydration.`,
    sources: [AAP_CRYING_CHECKER, AAP_DEHYDRATION],
  }),
  item({
    id: "call-diapers-first-weeks", section: "call", minDays: 7, maxDays: 42, basis: "source",
    title: fixed("Diapers in the first weeks"),
    body: (v) => `After the first week, a breastfed baby with fewer than 6 wet diapers and 4 poops a day should be checked by ${v.their} pediatrician.`,
    sources: [AAP_FEEDING_SIGNS],
  }),
  item({
    id: "call-help", section: "call", minDays: 0, maxDays: YEAR, lift: ["hard_day"], basis: "source",
    title: (v) => `If someone might hurt ${v.them}`,
    body: (v) =>
      `If you're afraid you or someone else might shake or hurt ${v.them}, lay ${v.them} on ${v.their} back in the bassinet and call ${v.their} pediatrician now.`,
    sources: [AAP_CRYING_CHECKER, AAP_CRIES],
  }),

  // ── Emergency: the app's 911 line, word for word ──
  item({
    id: "emergency-911", section: "emergency", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Call 911"),
    body: (v) => emergencySigns(v),
    sources: [AAP_BREATHING, AAP_CRYING_CHECKER],
  }),
];

/** The safety line under "I'm getting sleepy" (the safe-sleepy item's words). */
export const sleepyLine = (v: Voice): string => SLEEP_GUIDES.find((g) => g.id === "safe-sleepy")!.body(v);

/** The transfer steps (the transfer-steps item's). */
export const transferSteps = (v: Voice): string[] => SLEEP_GUIDES.find((g) => g.id === "transfer-steps")!.steps!(v);

/** Who reviews: every item still waiting for a person's sign-off, for the docs and the check. */
export const pendingReview = (): readonly SleepGuide[] => SLEEP_GUIDES.filter((g) => g.needsReview);

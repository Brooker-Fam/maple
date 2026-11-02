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
 * - Never crying it out, and never sleep on an adult, or in a bed, couch or
 *   armchair with one, presented as safe or as an option.
 * - Copy about the baby takes a Voice (the family's name and pronouns); the
 *   911 line reuses guidelines.ts's emergencySigns word for word.
 *
 * Sources were read on 2026-11-02 (the AAP's HealthyChildren.org pages, the
 * AAP's 2022 policy statement and its technical report, and NICHD's Safe to
 * Sleep breastfeeding handout; for going back to work, the Office on Women's
 * Health, Texas HHS's Breastmilk Counts, a 2016 survey of new parents'
 * driving and CDC NIOSH's drowsy-driving training). Recheck them when this
 * file changes.
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
/** The app's crisis line (guidelines.ts): call or text 988, any time. */
const LIFELINE_988: GuideSource = {
  label: "988 Suicide & Crisis Lifeline",
  url: "https://988lifeline.org/talk-to-someone-now/",
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
/** The evidence behind the 2022 policy statement: sitting devices, and a sofa or armchair against an adult bed. */
const AAP_TECH_REPORT_2022: GuideSource = {
  label: "AAP technical report: evidence base for the 2022 safe sleep recommendations",
  url: "https://pubmed.ncbi.nlm.nih.gov/35921639/",
};
/** NICHD Safe to Sleep: tiredness during feeds, and asking someone to stay with you. */
const NICHD_BREASTFEEDING: GuideSource = {
  label: "NICHD Safe to Sleep: breastfeed your baby to reduce the risk of SIDS (2018)",
  url: "https://www.nichd.nih.gov/sites/default/files/2018-11/Breastfeed_Baby_SIDS_final.pdf",
};
const AAP_DEHYDRATION: GuideSource = {
  label: "AAP: Signs of dehydration in infants and children",
  url: "https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/dehydration.aspx",
};
/** The Office on Women's Health: nursing more at night once the nursing parent is back at work ("reverse-cycling"). */
const OWH_BACK_TO_WORK: GuideSource = {
  label: "Office on Women's Health: Breastfeeding and going back to work",
  url: "https://womenshealth.gov/breastfeeding/breastfeeding-home-work-and-public/breastfeeding-and-going-back-work",
};
/** Texas HHS (Breastmilk Counts, by Texas WIC): a bottle at 4 weeks old or two weeks before the return to work or school, whichever is sooner. */
const TEXAS_BOTTLES: GuideSource = {
  label: "Texas HHS, Breastmilk Counts (Texas WIC): Bottle feeding your baby",
  url: "https://breastmilkcounts.com/breastfeeding-basics/bottle-feeding-your-baby/",
};
/** A small, early survey of new parents' sleep and driving (72 parents): poor sleep quality and near misses. */
const NEW_PARENTS_DRIVING: GuideSource = {
  label: "Malish, Arastu and O'Brien: A preliminary study of new parents, sleep disruption, and driving (Maternal and Child Health Journal, 2016)",
  url: "https://pubmed.ncbi.nlm.nih.gov/26541593/",
};
/** CDC NIOSH: plan how to avoid driving drowsy (a ride from family or a friend, other transportation, a nap first). */
const NIOSH_DROWSY_DRIVING: GuideSource = {
  label: "CDC NIOSH: Training for nurses on shift work and long work hours, module 11 (driving)",
  url: "https://www.cdc.gov/niosh/work-hour-training-for-nurses/longhours/mod11/05.html",
};

const CHECKED = "2026-11-02";
const YEAR = 365;

const item = (g: Omit<SleepGuide, "reviewed" | "needsReview"> & Partial<Pick<SleepGuide, "reviewed" | "needsReview">>): SleepGuide => ({
  reviewed: CHECKED,
  needsReview: true,
  ...g,
});

const fixed = (s: string) => () => s;

/** "If you're getting sleepy": the two things to do (the holding sheet's line, sleepyLine). */
const sleepyActions = (v: Voice) =>
  `If you feel yourself dozing while holding ${v.them}, lay ${v.them} on ${v.their} back in the bassinet or hand ${v.them} to someone who's awake. Dozing off with a baby on a couch or armchair is especially dangerous. If you do fall asleep with ${v.them}, move ${v.them} to the bassinet as soon as you wake.`;
/** The AAP guide's warning about a tired adult's bed, after its "unable to recommend bed sharing under any circumstances". */
const tiredBedRisk = () =>
  "Sharing a bed with a baby isn't recommended, and the risk of a sleep-related death is more than 10 times higher when the adult is very tired, has taken medicine that makes it harder to wake, or has had alcohol or drugs.";

/**
 * Feeding while tired (NICHD's handout, the AAP's guide and its technical
 * report), sentence by sentence: the safe-feeding-sleepy item is all four,
 * and the goal cautions quote the one they need (goals.ts goalCautions).
 */
export const feedingSleepyWords = (v: Voice) => ({
  mindful: "Be mindful of how tired you are, and avoid couches and armchairs for feeds if you think you might fall asleep.",
  someone: `Ask someone to stay with you while you feed ${v.them}, to keep you awake or to lay ${v.them} in the bassinet if you fall asleep.`,
  bed: `If there's any chance you might fall asleep while ${v.they}${v.verb("'s")} in your bed, first take away pillows, blankets, sheets and anything else that could cover ${v.their} face, head or neck or make ${v.them} too warm, and if you do fall asleep, move ${v.them} back to ${v.their} own sleep space as soon as you wake.`,
  hazard: "If you might doze off, a cleared adult bed is less hazardous than a sofa or armchair, though still not recommended.",
});

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
    // The holding sheet shows the first part (sleepyLine); the tired adult's bed is the AAP guide's own warning.
    body: (v) => `${sleepyActions(v)} ${tiredBedRisk()}`,
    sources: [AAP_SAFE_SLEEP],
  }),
  item({
    id: "safe-feeding-sleepy", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Feeding when you're tired"),
    body: (v) => {
      const w = feedingSleepyWords(v);
      return `${w.mindful} ${w.someone} ${w.bed} ${w.hazard}`;
    },
    sources: [NICHD_BREASTFEEDING, AAP_SAFE_SLEEP, AAP_TECH_REPORT_2022],
  }),
  item({
    id: "safe-seats", section: "safe", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Car seats, swings and slings"),
    body: (v) =>
      `Car seats, strollers, swings, carriers and slings aren't for routine sleep, especially before 4 months. If ${v.they} ${v.verb("falls")} asleep in one, move ${v.them} to the bassinet, on ${v.their} back, as soon as you can.`,
    sources: [AAP_SAFE_SLEEP, AAP_TECH_REPORT_2022],
  }),

  // ── Call the pediatrician ──
  item({
    id: "call-fever", section: "call", minDays: 0, maxDays: 89, basis: "source",
    title: fixed("Fever under 3 months"),
    body: (v) =>
      `Call ${v.their} pediatrician right away for a temperature of 100.4°F (38.0°C) or higher, even if ${v.they} ${v.verb("seems")} fine. Don't give fever medicine unless the pediatrician tells you to.`,
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
    title: fixed("If it gets to be too much"),
    // The AAP's words (set the baby down somewhere safe, get help, never shake), then the app's one crisis rule (911, else 988).
    body: (v) =>
      `If you start to feel you can't handle it, lay ${v.them} on ${v.their} back in the bassinet, step away, and get help from family or a friend. Never shake or hit ${v.them}, however tired or angry you feel. If anyone might hurt ${v.them} or themselves, call 911 if it's an emergency; otherwise call or text 988, any time.`,
    sources: [AAP_CRIES, LIFELINE_988],
  }),

  // ── Emergency: the app's 911 line, word for word ──
  item({
    id: "emergency-911", section: "emergency", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Call 911"),
    body: (v) => emergencySigns(v),
    sources: [AAP_BREATHING, AAP_CRYING_CHECKER],
  }),
];

/** The safety line under "I'm getting sleepy": the safe-sleepy item's words about what to do (its body adds the tired adult's bed). */
export const sleepyLine = (v: Voice): string => sleepyActions(v);

/**
 * The feed card's quiet line during a nursing feed at night (10 PM to 6 AM in
 * the family's timezone): NICHD's two options, from the safe-feeding-sleepy
 * item ("ask someone to stay with you … or to place the baby into a safe
 * sleep area").
 */
export const nightFeedLine = (v: Voice): string => `Feeling sleepy? Wake someone to sit with you, or lay ${v.them} on ${v.their} back in the bassinet.`;

/** The transfer steps (the transfer-steps item's). */
export const transferSteps = (v: Voice): string[] => SLEEP_GUIDES.find((g) => g.id === "transfer-steps")!.steps!(v);

/** The ids the Back to work template and its coach notes cite (goals.ts): bottles before the day back, more night nursing after it, and a drowsy drive. */
export const WORK_BOTTLES = "work-bottles";
export const WORK_NIGHT_NURSING = "work-night-nursing";
export const WORK_DROWSY_DRIVING = "work-drowsy-driving";

/**
 * Going back to work: the sourced words behind what the Back to work
 * template and its coach notes say. Bottles before the day back follow Texas
 * HHS (the sooner of about 4 weeks old or two weeks before, and only after
 * their pediatrician's or lactation consultant's yes, as every feeding
 * change is here); more night nursing after it is OWH's "reverse-cycling";
 * the drowsy drive is a small, early survey of new parents, with NIOSH's
 * plans for not driving drowsy. Sourced, dated and waiting for review like
 * the rest, but not in the family's guidance list (sleepGuidance reads
 * SLEEP_GUIDES): goals.ts cites them by id (workGuide).
 */
export const WORK_GUIDES: readonly SleepGuide[] = [
  item({
    id: WORK_BOTTLES, section: "normal", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Bottles before going back to work"),
    body: (v) =>
      `If ${v.name} nurses, a bottle of expressed milk can start at about 4 weeks old or two weeks before the nursing parent goes back to work or school, whichever is sooner. Ask ${v.their} pediatrician or lactation consultant first.`,
    sources: [TEXAS_BOTTLES],
  }),
  item({
    id: WORK_NIGHT_NURSING, section: "normal", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("More night nursing after going back"),
    body: fixed("When the nursing parent goes back to work, some babies eat less during the day and nurse more often at night, which is called reverse cycling. Others eat well during the day and still nurse more at night, maybe for the closeness."),
    sources: [OWH_BACK_TO_WORK],
  }),
  item({
    id: WORK_DROWSY_DRIVING, section: "bad_day", minDays: 0, maxDays: YEAR, basis: "source",
    title: fixed("Driving after a short night"),
    body: fixed("In one small, early survey of 72 new parents, poor sleep quality went with a sixfold increase in near misses on the road. If you're very sleepy, plan how to avoid driving drowsy: a ride from family or a friend, other transportation, or a nap first."),
    sources: [NEW_PARENTS_DRIVING, NIOSH_DROWSY_DRIVING],
  }),
];

/** One of WORK_GUIDES by its id (WORK_BOTTLES, WORK_NIGHT_NURSING, WORK_DROWSY_DRIVING). */
export const workGuide = (id: string): SleepGuide | undefined => WORK_GUIDES.find((g) => g.id === id);

/** Who reviews: every item still waiting for a person's sign-off (the guidance list's and going back to work's), for the docs and the check. */
export const pendingReview = (): readonly SleepGuide[] => [...SLEEP_GUIDES, ...WORK_GUIDES].filter((g) => g.needsReview);

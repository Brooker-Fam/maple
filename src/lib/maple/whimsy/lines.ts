import type { Extra } from "./types";

/**
 * Every little extra (types.ts): what a line may follow, for which ages, and
 * for facts where they come from. The rules every line keeps are checked by
 * `pnpm check:maple-whimsy`; the short version: kind to every family (any
 * feeding, any family shape, any day), never advice or a number to measure the
 * baby against, never about sleep anywhere but the baby's own flat, bare
 * space, no emoji, and quiet at night.
 */
export const EXTRAS: readonly Extra[] = [
  // ── Any everyday log ────────────────────────────────────────────────────
  { id: "care-cheer-great-job", kind: "cheer", topics: ["care"], text: "You're doing a great job. Really." },
  { id: "care-cheer-small-things", kind: "cheer", topics: ["care"], text: "Small things, done with love. That's the whole job." },
  { id: "care-joke-professional", kind: "joke", topics: ["care"], text: "Logged. You're basically a professional now." },
  {
    id: "care-fact-grasp",
    kind: "fact",
    topics: ["care"],
    ages: [0, 120],
    text: "Fun fact: newborns are born with a grasp reflex. Offer a finger and {he} may hold on tight.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/Pages/Newborn-Reflexes.aspx",
  },
  {
    id: "care-fact-bones",
    kind: "fact",
    topics: ["care"],
    text: "Fun fact: babies have more bones than grown-ups. Many of them fuse together as children grow.",
    source: "https://kidshealth.org/en/kids/bones.html",
  },

  // ── At night: quiet cheers only ─────────────────────────────────────────
  { id: "night-cheer-hardest-shift", kind: "cheer", topics: ["care"], night: "only", text: "The night shift is the hardest shift. You're doing it." },
  { id: "night-cheer-steady", kind: "cheer", topics: ["care"], night: "only", text: "Quiet hours, steady hands. Well done." },
  { id: "night-cheer-rest", kind: "cheer", topics: ["care"], night: "also", text: "Done. Rest when you can." },

  // ── Diapers ─────────────────────────────────────────────────────────────
  { id: "diaper-joke-crowd", kind: "joke", topics: ["diaper"], text: "Diaper changed. The crowd goes mild." },
  { id: "pee-joke-fresh-start", kind: "joke", topics: ["pee"], text: "Fresh diaper, fresh start. For about an hour." },
  { id: "poop-joke-masterpiece", kind: "joke", topics: ["poop"], text: "Another masterpiece, signed by the artist." },
  {
    id: "poop-fact-meconium",
    kind: "fact",
    topics: ["poop"],
    ages: [0, 7],
    text: "Fun fact: a baby's first poop, meconium, is made of things swallowed in the womb.",
    source: "https://my.clevelandclinic.org/health/body/24082-meconium",
  },

  // ── Feeds ───────────────────────────────────────────────────────────────
  { id: "feed-joke-five-stars", kind: "joke", topics: ["feed"], text: "Fed, and hopefully burped. Five stars." },
  { id: "nursing-joke-chef", kind: "joke", topics: ["nursing"], text: "Feed done. {He} sends compliments to the chef." },
  { id: "bottle-joke-burp-loading", kind: "joke", topics: ["bottle"], text: "Bottle done. Somewhere, a burp is loading." },
  { id: "feed-cheer-every-feed", kind: "cheer", topics: ["feed"], text: "Every feed counts, and so do you." },

  // ── Pumping ─────────────────────────────────────────────────────────────
  { id: "pump-joke-restocked", kind: "joke", topics: ["pump"], text: "Pumping done. The milk bar is restocked." },
  { id: "pump-cheer-real-work", kind: "cheer", topics: ["pump"], text: "Pumping is real work. Sit for a minute if you can." },

  // ── Sleep ───────────────────────────────────────────────────────────────
  { id: "sleep-joke-recharged", kind: "joke", topics: ["sleep"], text: "Sleep logged. {He} is fully recharged. You, less so." },
  {
    id: "sleep-fact-rem",
    kind: "fact",
    topics: ["sleep"],
    ages: [0, 91],
    text: "Fun fact: newborns spend about half their sleep in active, dreamy REM sleep.",
    source: "https://www.sleepfoundation.org/baby-sleep",
  },

  // ── Tummy time and baths ────────────────────────────────────────────────
  { id: "tummy-joke-plank", kind: "joke", topics: ["tummy"], text: "Tummy time: the original plank challenge." },
  {
    id: "tummy-fact-muscles",
    kind: "fact",
    topics: ["tummy"],
    text: "Fun fact: tummy time builds the neck and shoulder muscles {he} will use to roll and sit.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/sleep/Pages/Back-to-Sleep-Tummy-to-Play.aspx",
  },
  { id: "bath-joke-while-it-lasts", kind: "joke", topics: ["bath"], text: "Squeaky clean. Enjoy it while it lasts." },

  // ── Moments, notes, the doctor, measurements ────────────────────────────
  { id: "moment-cheer-future-you", kind: "cheer", topics: ["moment"], text: "Saved. Future you says thank you." },
  { id: "doctor-cheer-no-small-questions", kind: "cheer", topics: ["doctor"], text: "Good thinking. No question is too small to ask." },
  { id: "note-cheer-you-know", kind: "cheer", topics: ["note"], text: "Noted. You know {him} best." },
  { id: "hiccups-joke-drums", kind: "joke", topics: ["hiccups"], text: "Hiccups again? {He} is practicing a drum solo." },
  { id: "growth-cheer-story", kind: "cheer", topics: ["growth"], text: "Saved. One more page of {his} story." },

  // ── The sleep plan's bassinet tries, and the care person's own food ─────
  { id: "try-cheer-every-try", kind: "cheer", topics: ["try"], text: "Every try counts, however it went." },
  { id: "try-cheer-picking-up", kind: "cheer", topics: ["try"], night: "also", text: "Picking {him} up is always allowed. Try again whenever you're ready." },
  { id: "self-cheer-you-count", kind: "cheer", topics: ["self"], text: "Taking care of you counts, too." },
];

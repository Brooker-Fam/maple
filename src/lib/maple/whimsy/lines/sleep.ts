import type { Extra } from "../types";

/**
 * Sleep, and the sleep plan's bassinet tries. A sleep only gets a line in the
 * baby's own crib or bassinet, or with no place said (topics.ts), so these
 * never name a place, a position, a way of being held or anything in the
 * sleep space, and never how long or how well anyone slept. Every one passes
 * unsafeSleep (sleep/goals.ts). A try is on the family's gentle plan: picking
 * the baby up is always fine, every try counts, and nothing judges how it went.
 */
export const SLEEP: readonly Extra[] = [
  // ── Sleep ───────────────────────────────────────────────────────────────
  {
    id: "sleep-fact-rem",
    kind: "fact",
    topics: ["sleep"],
    ages: [0, 61],
    text: "Fun fact: newborns spend about half their sleep in REM, the active stage. Adults spend about a fifth.",
    source: "https://www.sleepfoundation.org/baby-sleep/baby-sleep-cycle",
  },
  {
    id: "sleep-fact-smiles",
    kind: "fact",
    topics: ["sleep"],
    ages: [0, 91],
    text: "Fun fact: research suggests sleep smiles happen during REM sleep, as a reflex. Still adorable.",
    source: "https://www.sleepfoundation.org/baby-sleep",
  },
  {
    id: "sleep-fact-womb-rem",
    kind: "fact",
    topics: ["sleep"],
    text: "Fun fact: babies have REM sleep, the stage when dreams happen, even before they're born.",
    source: "https://kidshealth.org/en/parents/babyslideshow.html",
  },
  {
    id: "sleep-fact-day-night",
    kind: "fact",
    topics: ["sleep"],
    ages: [0, 61],
    text: "Fun fact: for the first couple of months, babies don't yet sort night from day.",
    source: "https://www.sleepfoundation.org/baby-sleep",
  },
  {
    id: "sleep-fact-cycles",
    kind: "fact",
    topics: ["sleep"],
    ages: [0, 365],
    text: "Fun fact: a baby's sleep cycles are shorter than an adult's, and they lengthen with age.",
    source: "https://www.sleepfoundation.org/baby-sleep/baby-sleep-cycle",
  },
  { id: "sleep-joke-recharged", kind: "joke", topics: ["sleep"], text: "Sleep logged. {He} is fully recharged. You, less so." },
  { id: "sleep-joke-dreamed", kind: "joke", topics: ["sleep"], text: "Sleep logged. Dreamed of milk, presumably." },
  { id: "sleep-joke-sleeper", kind: "joke", topics: ["sleep"], text: "Sleep logged. Excellent work by the sleeper." },
  { id: "sleep-joke-full-time", kind: "joke", topics: ["sleep"], text: "Sleep logged. Recharging is a full-time job." },
  { id: "sleep-joke-on-the-clock", kind: "joke", topics: ["sleep"], text: "Professional rester, back on the clock." },
  { id: "sleep-joke-eyelids", kind: "joke", topics: ["sleep"], text: "Sleep logged. The eyelids have reopened for business." },
  { id: "sleep-joke-snooze", kind: "joke", topics: ["sleep"], text: "Sleep logged. Snooze, achieved." },
  { id: "sleep-joke-yawns", kind: "joke", topics: ["sleep"], text: "Sleep logged. The yawns were just a preview." },
  { id: "sleep-joke-dreamland", kind: "joke", topics: ["sleep"], text: "Sleep logged. Back from dreamland, with no souvenirs." },
  { id: "sleep-cheer-breather", kind: "cheer", topics: ["sleep"], text: "Sleep logged. Rest for {him}, and maybe a breather for you." },
  { id: "sleep-cheer-rest-finds-you", kind: "cheer", topics: ["sleep"], text: "Sleep logged. Here's hoping some rest finds you, too." },
  { id: "sleep-cheer-quiet-time", kind: "cheer", topics: ["sleep"], text: "Logged. Quiet time counts for everyone." },
  { id: "sleep-cheer-tracking", kind: "cheer", topics: ["sleep"], text: "Sleep logged. Keeping track of rest is care, too." },
  { id: "sleep-cheer-peaceful", kind: "cheer", topics: ["sleep"], text: "Sleep logged. Peaceful work, nicely done." },
  { id: "sleep-cheer-whatever-next", kind: "cheer", topics: ["sleep"], text: "Sleep logged. Rested and ready for whatever's next." },

  // ── Bassinet tries (cheers only; the night's are in night.ts) ───────────
  { id: "try-cheer-every-try", kind: "cheer", topics: ["try"], text: "Every try counts, however it went." },
  { id: "try-cheer-practice", kind: "cheer", topics: ["try"], text: "Try logged. Each one is practice, for both of you." },
  { id: "try-cheer-gentle-plan", kind: "cheer", topics: ["try"], text: "Slow and gentle is the plan, and you're following it." },
  { id: "try-cheer-counts", kind: "cheer", topics: ["try"], text: "A try is a try, and it counts." },
  { id: "try-cheer-gentle-steps", kind: "cheer", topics: ["try"], text: "Logged. Gentle steps add up." },
  { id: "try-cheer-one-at-a-time", kind: "cheer", topics: ["try"], text: "Calm tries, one at a time. That's the whole idea." },
  { id: "try-cheer-patience", kind: "cheer", topics: ["try"], text: "Try logged. Patience looks good on you." },
  { id: "try-cheer-kindness", kind: "cheer", topics: ["try"], text: "Try logged. Kindness is the method here." },
  { id: "try-cheer-no-rush", kind: "cheer", topics: ["try"], text: "Try logged. There's no rush on any of this." },
  { id: "try-cheer-lead", kind: "cheer", topics: ["try"], text: "Try logged. Following {his} lead is the gentle way." },
];

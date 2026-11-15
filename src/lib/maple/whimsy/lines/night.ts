import type { Extra } from "../types";

/**
 * The night (8 PM–7 AM): quiet cheers only, short and calm, never an
 * exclamation mark, and at most one every NIGHT_GAP_MS (pick.ts). "only" is
 * for a line about the night itself, which never shows by day; "also" for a
 * calm one that's true any time. Every line written for the night is here,
 * the ones for any everyday log first, then a few for feeds, diapers,
 * pumping, the sleep plan's tries and the care person's own food.
 */
export const NIGHT: readonly Extra[] = [
  // ── Any everyday log ────────────────────────────────────────────────────
  { id: "night-cheer-hardest-shift", kind: "cheer", topics: ["care"], night: "only", text: "The night shift is the hardest shift. You're doing it." },
  { id: "night-cheer-steady", kind: "cheer", topics: ["care"], night: "only", text: "Quiet hours, steady hands. Well done." },
  { id: "night-cheer-rest", kind: "cheer", topics: ["care"], night: "also", text: "Done. Rest when you can." },
  { id: "night-cheer-house-quiet", kind: "cheer", topics: ["care"], night: "only", text: "Logged. The house is quiet, and you're on it." },
  { id: "night-cheer-quietly-done", kind: "cheer", topics: ["care"], night: "only", text: "Night work, quietly done." },
  { id: "night-cheer-small-hours", kind: "cheer", topics: ["care"], night: "only", text: "Small hours, big love." },
  { id: "night-cheer-calm", kind: "cheer", topics: ["care"], night: "only", text: "Logged. You're the calm in the night." },
  { id: "night-cheer-gently-done", kind: "cheer", topics: ["care"], night: "also", text: "Another quiet task, gently done." },
  { id: "night-cheer-back-to-rest", kind: "cheer", topics: ["care"], night: "only", text: "Logged softly. Back to rest." },
  { id: "night-cheer-moon", kind: "cheer", topics: ["care"], night: "only", text: "The moon's up, and so are you. Well done." },
  { id: "night-cheer-showed-up", kind: "cheer", topics: ["care"], night: "only", text: "In the quiet, you showed up." },
  { id: "night-cheer-breathe", kind: "cheer", topics: ["care"], night: "also", text: "One more thing done. Breathe easy." },
  { id: "night-cheer-slow-steady", kind: "cheer", topics: ["care"], night: "only", text: "Slow and steady wins the night." },
  { id: "night-cheer-keeping-watch", kind: "cheer", topics: ["care"], night: "only", text: "Logged. You're keeping watch, and it counts." },
  { id: "night-cheer-dark", kind: "cheer", topics: ["care"], night: "only", text: "Gently done, in the dark." },
  { id: "night-cheer-it-counts", kind: "cheer", topics: ["care"], night: "also", text: "Thank you for this one. It counts." },
  { id: "night-cheer-calm-careful", kind: "cheer", topics: ["care"], night: "also", text: "Calm and careful. That's the way." },
  { id: "night-cheer-gentle-hour", kind: "cheer", topics: ["care"], night: "only", text: "A gentle hour, gently handled." },
  { id: "night-cheer-soft-light", kind: "cheer", topics: ["care"], night: "only", text: "Logged by the soft light. Well done." },
  { id: "night-cheer-one-small-thing", kind: "cheer", topics: ["care"], night: "only", text: "One small thing at a time. That's how nights go." },
  { id: "night-cheer-owls", kind: "cheer", topics: ["care"], night: "only", text: "Logged. The night owls salute you." },
  { id: "night-cheer-whisper", kind: "cheer", topics: ["care"], night: "only", text: "Logged in a whisper." },
  { id: "night-cheer-stars", kind: "cheer", topics: ["care"], night: "only", text: "Logged. Even the stars are keeping you company." },
  { id: "night-cheer-gentler", kind: "cheer", topics: ["care"], night: "only", text: "Logged. You make the night a little gentler." },
  { id: "night-cheer-done-quietly", kind: "cheer", topics: ["care"], night: "only", text: "Done, and done quietly." },
  { id: "night-cheer-good-company", kind: "cheer", topics: ["care"], night: "only", text: "Logged. Good company in the quiet hours." },
  { id: "night-cheer-calm-kind", kind: "cheer", topics: ["care"], night: "also", text: "Calm, kind and logged." },
  { id: "night-cheer-gentle-pace", kind: "cheer", topics: ["care"], night: "also", text: "Logged. A gentle pace is the right pace." },

  // ── Feeds ───────────────────────────────────────────────────────────────
  { id: "night-cheer-feed-small-hours", kind: "cheer", topics: ["feed"], night: "only", text: "A quiet feed in the small hours. Well done." },
  { id: "night-cheer-feed-doing-it", kind: "cheer", topics: ["feed"], night: "only", text: "Night feed, logged. You're doing it." },
  { id: "night-cheer-feed-calm-kind", kind: "cheer", topics: ["feed"], night: "also", text: "Feed logged. Calm and kind, as always." },
  { id: "night-cheer-feed-quiet-hours", kind: "cheer", topics: ["feed"], night: "only", text: "Fed in the quiet hours. Nicely done." },
  { id: "night-cheer-feed-gently", kind: "cheer", topics: ["feed"], night: "only", text: "A gentle feed, gently logged." },
  { id: "night-cheer-nursing", kind: "cheer", topics: ["nursing"], night: "only", text: "Nursing in the quiet hours. Steady and kind." },
  { id: "night-cheer-bottle", kind: "cheer", topics: ["bottle"], night: "only", text: "A night bottle, calmly given." },

  // ── Diapers ─────────────────────────────────────────────────────────────
  { id: "night-cheer-diaper-quiet", kind: "cheer", topics: ["diaper"], night: "only", text: "A quiet change in the night. Well done." },
  { id: "night-cheer-diaper-dark", kind: "cheer", topics: ["diaper"], night: "only", text: "Diaper changed in the dark. Smooth." },
  { id: "night-cheer-diaper-calm", kind: "cheer", topics: ["diaper"], night: "also", text: "Changed, and back to calm." },
  { id: "night-cheer-diaper-handled", kind: "cheer", topics: ["diaper"], night: "only", text: "Night change, handled." },
  { id: "night-cheer-diaper-back-to-quiet", kind: "cheer", topics: ["diaper"], night: "only", text: "A fresh diaper in the night. Back to quiet." },
  { id: "night-cheer-diaper-carries-on", kind: "cheer", topics: ["diaper"], night: "only", text: "Diaper done. The night carries on, nice and quiet." },

  // ── Pumping ─────────────────────────────────────────────────────────────
  { id: "night-cheer-pump-devotion", kind: "cheer", topics: ["pump"], night: "only", text: "Pumping in the quiet hours. That's devotion." },
  { id: "night-cheer-pump-rest", kind: "cheer", topics: ["pump"], night: "only", text: "Night pumping, logged. Rest soon, if you can." },
  { id: "night-cheer-pump-steady", kind: "cheer", topics: ["pump"], night: "also", text: "Pumping logged. Steady work, quietly done." },

  // ── The sleep plan's bassinet tries ─────────────────────────────────────
  { id: "try-cheer-picking-up", kind: "cheer", topics: ["try"], night: "also", text: "Picking {him} up is always allowed. Try again whenever you're ready." },
  { id: "try-cheer-showed-up", kind: "cheer", topics: ["try"], night: "also", text: "However it went, you showed up for it." },
  { id: "night-cheer-try-counts", kind: "cheer", topics: ["try"], night: "only", text: "A quiet try in the night. It counts." },
  { id: "night-cheer-try-gentle", kind: "cheer", topics: ["try"], night: "only", text: "Gentle tries, even at this hour. Well done." },

  // ── The care person's own food or drink ─────────────────────────────────
  { id: "night-cheer-self-fuel", kind: "cheer", topics: ["self"], night: "only", text: "A little fuel for the night shift. Good thinking." },
  { id: "night-cheer-self-small-hours", kind: "cheer", topics: ["self"], night: "only", text: "Fuel for the small hours, logged." },
  { id: "night-cheer-self-refill", kind: "cheer", topics: ["self"], night: "only", text: "A night refill for the grown-ups. Nicely done." },
];

import type { Extra } from "../types";

/**
 * Notes, questions for the doctor, hiccups and measurements. A note (spit-up,
 * fussy, nails…) and a question for the doctor only ever get a cheer, since
 * either may be about something worrying; so do measurements, and never a
 * word about the numbers. A hiccups note is "hiccups" and "note", so its
 * lines are these for "hiccups" (a fact or a joke too) and the cheers for any
 * note; a line listing "note" follows every note, so it never says hiccups.
 */
export const NOTES: readonly Extra[] = [
  // ── Questions for the doctor ────────────────────────────────────────────
  { id: "doctor-cheer-no-small-questions", kind: "cheer", topics: ["doctor"], text: "Good thinking. No question is too small to ask." },
  { id: "doctor-cheer-ask-away", kind: "cheer", topics: ["doctor"], text: "Saved for the visit. Ask away." },
  { id: "doctor-cheer-written-down", kind: "cheer", topics: ["doctor"], text: "Written down, so it won't slip away." },
  { id: "doctor-cheer-easier", kind: "cheer", topics: ["doctor"], text: "Good call. A written question is easier to remember." },
  { id: "doctor-cheer-part-of-caring", kind: "cheer", topics: ["doctor"], text: "Saved. Asking is part of caring." },
  { id: "doctor-cheer-matters", kind: "cheer", topics: ["doctor"], text: "Your question matters. It's saved." },
  { id: "doctor-cheer-good-visits", kind: "cheer", topics: ["doctor"], text: "Noted for the doctor. Good questions make good visits." },
  { id: "doctor-cheer-on-the-list", kind: "cheer", topics: ["doctor"], text: "On the list, ready for the visit." },
  { id: "doctor-cheer-part-of-job", kind: "cheer", topics: ["doctor"], text: "Asking questions is part of the job, and you're doing it." },

  // ── Notes ───────────────────────────────────────────────────────────────
  { id: "note-cheer-you-know", kind: "cheer", topics: ["note"], text: "Noted. You know {him} best." },
  { id: "note-cheer-big-picture", kind: "cheer", topics: ["note"], text: "Noted. The details add up to the big picture." },
  { id: "note-cheer-attention", kind: "cheer", topics: ["note"], text: "Logged. Paying attention is a kind of love." },
  { id: "note-cheer-observations", kind: "cheer", topics: ["note"], text: "Noted. Little observations, big help." },
  { id: "note-cheer-nobody-notices", kind: "cheer", topics: ["note"], text: "Noted. Nobody notices like you do." },
  { id: "note-cheer-story", kind: "cheer", topics: ["note"], text: "Got it. Every note fills in the story." },
  { id: "note-cheer-superpower", kind: "cheer", topics: ["note"], text: "Noted. Keeping notes is a quiet superpower." },
  { id: "note-cheer-written-down", kind: "cheer", topics: ["note"], text: "Noted. Good to have it written down." },
  { id: "note-cheer-thanks", kind: "cheer", topics: ["note"], text: "Noted. Thanks for keeping track." },

  // ── Hiccups ─────────────────────────────────────────────────────────────
  { id: "hiccups-joke-drums", kind: "joke", topics: ["hiccups"], text: "Hiccups again? {He} is practicing a drum solo." },
  { id: "hiccups-joke-hic", kind: "joke", topics: ["hiccups"], text: "Hic. Hic. Logged." },
  { id: "hiccups-joke-percussion", kind: "joke", topics: ["hiccups"], text: "Hiccups: tiny percussion, no rehearsal needed." },
  {
    id: "hiccups-fact-womb",
    kind: "fact",
    topics: ["hiccups"],
    text: "Fun fact: babies can hiccup even before they're born.",
    source: "https://my.clevelandclinic.org/health/articles/7247-fetal-development-stages-of-growth",
  },
  {
    id: "hiccups-fact-hic",
    kind: "fact",
    topics: ["hiccups"],
    text: "Fun fact: the 'hic' is the sound of the vocal cords closing quickly, just after a spasm of the diaphragm.",
    source: "https://medlineplus.gov/ency/article/003068.htm",
  },
  {
    id: "hiccups-fact-singultus",
    kind: "fact",
    topics: ["hiccups"],
    text: "Fun fact: another name for hiccups is singultus.",
    source: "https://my.clevelandclinic.org/health/diseases/17672-hiccups",
  },
  {
    id: "hiccups-fact-grown-ups",
    kind: "fact",
    topics: ["hiccups"],
    text: "Fun fact: hiccups usually bother grown-ups more than they bother babies.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/feeding-nutrition/Pages/baby-burping-hiccups-and-spit-up.aspx",
  },
  { id: "hiccups-cheer-good-team", kind: "cheer", topics: ["hiccups"], text: "Noted. Hiccups and all, {hes} got a good team." },
  { id: "hiccups-cheer-watch", kind: "cheer", topics: ["hiccups"], text: "Logged. The hiccup watch is in good hands." },

  // ── Measurements: never a word about the numbers ────────────────────────
  { id: "growth-cheer-story", kind: "cheer", topics: ["growth"], text: "Saved. One more page of {his} story." },
  { id: "growth-cheer-chapter", kind: "cheer", topics: ["growth"], text: "Measurements saved. Another chapter on the record." },
  { id: "growth-cheer-snapshot", kind: "cheer", topics: ["growth"], text: "Saved. A snapshot of right now." },
  { id: "growth-cheer-look-back", kind: "cheer", topics: ["growth"], text: "Saved. Someday these will be fun to look back on." },
  { id: "growth-cheer-neatly-kept", kind: "cheer", topics: ["growth"], text: "On the record, neatly kept." },
  { id: "growth-cheer-history", kind: "cheer", topics: ["growth"], text: "Saved. You're keeping a careful history." },
  { id: "growth-cheer-kind-of-care", kind: "cheer", topics: ["growth"], text: "Saved. Keeping track is a kind of care." },
  { id: "growth-cheer-dated", kind: "cheer", topics: ["growth"], text: "Noted, dated and saved." },
  { id: "growth-cheer-taking-time", kind: "cheer", topics: ["growth"], text: "Saved. Thanks for taking the time." },
];

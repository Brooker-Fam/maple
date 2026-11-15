import type { Extra } from "../types";

/**
 * Diaper changes: any change ("diaper"), a wet one ("pee") and a dirty one
 * ("poop"). A diaper with a color to call about or a rash gets no line at all
 * (topics.ts), so these stay light. Never a count, a color or anything about
 * how much: those are health signals, and they belong in guidelines.ts.
 */
export const DIAPERS: readonly Extra[] = [
  // ── Any change ──────────────────────────────────────────────────────────
  { id: "diaper-joke-crowd", kind: "joke", topics: ["diaper"], text: "Diaper changed. The crowd goes mild." },
  { id: "diaper-joke-pit-crew", kind: "joke", topics: ["diaper"], text: "Diaper changed. A pit crew would be impressed." },
  { id: "diaper-joke-wrap", kind: "joke", topics: ["diaper"], text: "That's a wrap. Literally." },
  { id: "diaper-joke-medal", kind: "joke", topics: ["diaper"], text: "Diaper duty, complete. Your medal is in the mail." },
  { id: "diaper-joke-operator", kind: "joke", topics: ["diaper"], text: "Diaper: changed. Operator: smooth." },
  { id: "diaper-joke-audience", kind: "joke", topics: ["diaper"], text: "Diaper changed, to an audience of one." },
  { id: "diaper-joke-clean-slate", kind: "joke", topics: ["diaper"], text: "Diaper changed. Clean slate, fresh tabs." },
  { id: "diaper-joke-wiggles", kind: "joke", topics: ["diaper"], text: "Diaper changed, despite the wiggles." },
  { id: "diaper-joke-speed-record", kind: "joke", topics: ["diaper"], text: "New diaper speed record, probably." },
  { id: "diaper-joke-client", kind: "joke", topics: ["diaper"], text: "Changed, with only minor kicking from the client." },
  { id: "diaper-joke-runway", kind: "joke", topics: ["diaper"], text: "Fresh diaper, ready for the runway." },
  { id: "diaper-cheer-comfy", kind: "cheer", topics: ["diaper"], text: "Diaper changed. Thanks for keeping {him} comfy." },
  { id: "diaper-cheer-small-kindness", kind: "cheer", topics: ["diaper"], text: "A clean diaper is a small kindness. Well done." },
  { id: "diaper-cheer-got-this", kind: "cheer", topics: ["diaper"], text: "Diaper logged. You've got this down." },
  { id: "diaper-cheer-fresh-comfy", kind: "cheer", topics: ["diaper"], text: "Fresh and comfy. Nicely done." },
  { id: "diaper-cheer-gentle-quick", kind: "cheer", topics: ["diaper"], text: "Gentle and quick: the best kind of change." },
  { id: "diaper-cheer-unglamorous", kind: "cheer", topics: ["diaper"], text: "Thanks for doing the unglamorous stuff." },
  {
    id: "diaper-fact-smells",
    kind: "fact",
    topics: ["diaper"],
    ages: [0, 91],
    text: "Fun fact: newborns turn away from smells they don't like. Diaper changers can relate.",
    source: "https://kidshealth.org/en/parents/sensenewborn.html",
  },

  // ── Wet ─────────────────────────────────────────────────────────────────
  { id: "pee-joke-fresh-start", kind: "joke", topics: ["pee"], text: "Fresh diaper, fresh start. For now." },
  { id: "pee-joke-waterworks", kind: "joke", topics: ["pee"], text: "Pee logged. The waterworks department reports in." },
  { id: "pee-joke-swift", kind: "joke", topics: ["pee"], text: "A wet one, swiftly handled." },
  { id: "pee-joke-textbook", kind: "joke", topics: ["pee"], text: "Wet diaper out, dry diaper in. Textbook." },
  { id: "pee-joke-comfort", kind: "joke", topics: ["pee"], text: "Pee logged. Comfort restored." },
  { id: "pee-joke-damp", kind: "joke", topics: ["pee"], text: "Damp diaper, dealt with." },
  { id: "pee-joke-dry-spell", kind: "joke", topics: ["pee"], text: "Pee logged. The dry spell begins now." },
  { id: "pee-cheer-calm", kind: "cheer", topics: ["pee"], text: "Wet diaper, changed. Calm under pressure." },
  { id: "pee-cheer-pro", kind: "cheer", topics: ["pee"], text: "Pee logged. Keeping track like a pro." },
  {
    id: "pee-fact-early-start",
    kind: "fact",
    topics: ["pee"],
    text: "Fun fact: babies start making urine long before birth, by about 9 to 12 weeks of pregnancy.",
    source: "https://medlineplus.gov/ency/article/002395.htm",
  },
  {
    id: "pee-fact-amniotic",
    kind: "fact",
    topics: ["pee"],
    text: "Fun fact: babies pee before birth, and by about 25 weeks most of the fluid around them is pee.",
    source: "https://www.nhs.uk/best-start-in-life/pregnancy/week-by-week-guide-to-pregnancy/2nd-trimester/week-25/",
  },

  // ── Dirty ───────────────────────────────────────────────────────────────
  { id: "poop-joke-masterpiece", kind: "joke", topics: ["poop"], text: "Another masterpiece, signed by the artist." },
  { id: "poop-joke-next-piece", kind: "joke", topics: ["poop"], text: "Poop logged. The artist is already planning the next piece." },
  { id: "poop-joke-plot-thickens", kind: "joke", topics: ["poop"], text: "Poop logged. The plot thickens." },
  { id: "poop-joke-special-delivery", kind: "joke", topics: ["poop"], text: "Poop logged. Special delivery, signed for." },
  { id: "poop-joke-air-quality", kind: "joke", topics: ["poop"], text: "Poop logged. Air quality improving." },
  { id: "poop-joke-brave", kind: "joke", topics: ["poop"], text: "Poop logged. You were brave in there." },
  { id: "poop-joke-code-brown", kind: "joke", topics: ["poop"], text: "Code brown, resolved." },
  { id: "poop-joke-wipes", kind: "joke", topics: ["poop"], text: "Poop logged. The wipes earned their keep." },
  { id: "poop-joke-filed", kind: "joke", topics: ["poop"], text: "The poop report is in, filed with honors." },
  { id: "poop-joke-happens", kind: "joke", topics: ["poop"], text: "Poop happens. You handled it." },
  { id: "poop-cheer-unflappable", kind: "cheer", topics: ["poop"], text: "Poop handled. You're unflappable." },
  { id: "poop-cheer-love", kind: "cheer", topics: ["poop"], text: "Logging poop: love, in its least glamorous form." },
  { id: "poop-cheer-grace", kind: "cheer", topics: ["poop"], text: "Poop logged and handled with grace." },
  {
    id: "poop-fact-meconium",
    kind: "fact",
    topics: ["poop"],
    // Only while meconium is expected: from day 4 a black poop is one to call about (topics.ts, insights.ts).
    ages: [0, 4],
    text: "Fun fact: a baby's first poop, meconium, is made before birth, from amniotic fluid, mucus and more.",
    source: "https://medlineplus.gov/ency/article/002395.htm",
  },
];

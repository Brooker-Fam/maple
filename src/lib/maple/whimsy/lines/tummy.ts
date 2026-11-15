import type { Extra } from "../types";

/**
 * Tummy time: the workout jokes, cheers for whoever's on the floor with the
 * baby, and what the time on the tummy builds. Never how much of it there
 * should be: a little tummy time is still tummy time.
 */
export const TUMMY: readonly Extra[] = [
  {
    id: "tummy-fact-muscles",
    kind: "fact",
    topics: ["tummy"],
    ages: [0, 214],
    text: "Fun fact: tummy time builds the neck and shoulder muscles {he} will use to roll over, sit up and crawl.",
    source: "https://kidshealth.org/en/parents/tummy-time.html",
  },
  {
    id: "tummy-fact-crawling",
    kind: "fact",
    topics: ["tummy"],
    ages: [0, 365],
    text: "Fun fact: tummy time lays the foundation for crawling.",
    source: "https://www.healthychildren.org/English/ages-stages/baby/Pages/Crawling-Styles.aspx",
  },
  {
    id: "tummy-fact-push-ups",
    kind: "fact",
    topics: ["tummy"],
    ages: [120, 214],
    text: "Fun fact: pushing up on straight arms during tummy time works the arm, chest and back muscles.",
    source: "https://kidshealth.org/en/parents/tummy-time.html",
  },
  {
    id: "tummy-fact-head-first",
    kind: "fact",
    topics: ["tummy"],
    text: "Fun fact: babies develop from the head down: sucking comes before sitting, and sitting before walking.",
    source: "https://medlineplus.gov/ency/article/002004.htm",
  },
  { id: "tummy-joke-plank", kind: "joke", topics: ["tummy"], text: "Tummy time: the original plank challenge." },
  { id: "tummy-joke-core", kind: "joke", topics: ["tummy"], text: "Tummy time done. Core workout complete." },
  { id: "tummy-joke-heavy-lifting", kind: "joke", topics: ["tummy"], text: "Tummy time logged. {He} did all the heavy lifting." },
  { id: "tummy-joke-gym", kind: "joke", topics: ["tummy"], text: "Floor workout, complete. No gym membership needed." },
  { id: "tummy-joke-inspection", kind: "joke", topics: ["tummy"], text: "Tummy time logged. The floor has been thoroughly inspected." },
  { id: "tummy-joke-neck-day", kind: "joke", topics: ["tummy"], text: "Neck day: done." },
  { id: "tummy-joke-commentary", kind: "joke", topics: ["tummy"], text: "Tummy time: a close-up view of the floor, with commentary." },
  { id: "tummy-joke-trainer", kind: "joke", topics: ["tummy"], text: "Tummy time logged. Trainer: you. Client: mostly cooperative." },
  { id: "tummy-joke-push-ups", kind: "joke", topics: ["tummy"], text: "Tummy time: tiny push-ups, big ambitions." },
  { id: "tummy-cheer-still-counts", kind: "cheer", topics: ["tummy"], text: "A little tummy time is still tummy time." },
  { id: "tummy-cheer-coached", kind: "cheer", topics: ["tummy"], text: "Tummy time logged. Nicely coached." },
  { id: "tummy-cheer-together", kind: "cheer", topics: ["tummy"], text: "Floor time, done together. Well played." },
  { id: "tummy-cheer-sidelines", kind: "cheer", topics: ["tummy"], text: "Tummy time done. Cheering from the sidelines counts." },
  { id: "tummy-cheer-progress", kind: "cheer", topics: ["tummy"], text: "Tummy time logged. Practice makes progress." },
];

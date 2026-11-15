import type { Extra } from "../types";

/** Baths: splashes, towels and steady hands. Never how often or how warm: that's advice. */
export const BATH: readonly Extra[] = [
  {
    id: "bath-fact-vernix",
    kind: "fact",
    topics: ["bath"],
    ages: [0, 91],
    text: "Fun fact: some babies are born with vernix, a white coating that protected their skin in the womb.",
    source: "https://kidshealth.org/en/parents/first-day.html",
  },
  {
    id: "bath-fact-lanugo",
    kind: "fact",
    topics: ["bath"],
    ages: [0, 91],
    text: "Fun fact: lanugo, the fine hair some babies are born with, helped vernix stick to their skin.",
    source: "https://my.clevelandclinic.org/health/body/22487-lanugo",
  },
  { id: "bath-joke-while-it-lasts", kind: "joke", topics: ["bath"], text: "Squeaky clean. Enjoy it while it lasts." },
  { id: "bath-joke-spa", kind: "joke", topics: ["bath"], text: "Bath done. Fresh out of the spa." },
  { id: "bath-joke-damp", kind: "joke", topics: ["bath"], text: "Clean baby, damp grown-up. Classic." },
  { id: "bath-joke-splash-zone", kind: "joke", topics: ["bath"], text: "Bath logged. The splash zone has been cleared." },
  { id: "bath-joke-rub-a-dub", kind: "joke", topics: ["bath"], text: "Rub-a-dub, done." },
  { id: "bath-joke-burrito", kind: "joke", topics: ["bath"], text: "Bath done. Towel burrito achieved." },
  { id: "bath-joke-duck", kind: "joke", topics: ["bath"], text: "Bath logged. The rubber duck approves." },
  { id: "bath-joke-wrinkly", kind: "joke", topics: ["bath"], text: "Bath logged. Wrinkly fingers, smooth operation." },
  { id: "bath-joke-soap-opera", kind: "joke", topics: ["bath"], text: "Bath time: the original soap opera." },
  { id: "bath-joke-rinse-repeat", kind: "joke", topics: ["bath"], text: "Bath done. Rinse, repeat, towel." },
  { id: "bath-joke-polished", kind: "joke", topics: ["bath"], text: "Bath logged. Bubbles: popped. Baby: polished." },
  { id: "bath-cheer-gentle", kind: "cheer", topics: ["bath"], text: "Warm water, gentle hands. Nicely done." },
  { id: "bath-cheer-calm", kind: "cheer", topics: ["bath"], text: "Clean and calm. Good work." },
  { id: "bath-cheer-easy", kind: "cheer", topics: ["bath"], text: "Bath logged. You make it look easy, even when it isn't." },
  { id: "bath-cheer-cozy", kind: "cheer", topics: ["bath"], text: "Clean and cozy. Mission accomplished." },
  { id: "bath-cheer-steady", kind: "cheer", topics: ["bath"], text: "Bath done. Steady hands, all the way through." },
  { id: "bath-cheer-slippery", kind: "cheer", topics: ["bath"], text: "Bath logged. Wet, slippery and handled beautifully." },
];

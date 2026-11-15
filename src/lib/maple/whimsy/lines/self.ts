import type { Extra } from "../types";

/**
 * The care person's own food or drink, on her page. Anyone who can log there
 * may have logged it, so a line never says "you" (it could be her, or someone
 * looking after her) and never names the baby: it cheers the grown-ups.
 */
export const SELF: readonly Extra[] = [
  { id: "self-cheer-grown-ups-count", kind: "cheer", topics: ["self"], text: "Looking after the grown-ups counts, too." },
  { id: "self-cheer-fuel", kind: "cheer", topics: ["self"], text: "Logged. Caregivers need fuel, too." },
  { id: "self-cheer-self-care", kind: "cheer", topics: ["self"], text: "Logged. Food and drink: the original self-care." },
  { id: "self-cheer-refueling", kind: "cheer", topics: ["self"], text: "Logged. Refueling the grown-ups, one bite or sip at a time." },
  { id: "self-cheer-keeps-everyone", kind: "cheer", topics: ["self"], text: "Logged. Keeping the caregiver going keeps everyone going." },
  { id: "self-cheer-deserves", kind: "cheer", topics: ["self"], text: "The one doing the caring deserves some, too." },
  { id: "self-cheer-big-job", kind: "cheer", topics: ["self"], text: "Good fuel for a big job." },
  { id: "self-cheer-looking-out", kind: "cheer", topics: ["self"], text: "Logged. Somebody's looking out for the grown-ups." },
  { id: "self-cheer-grown-up-edition", kind: "cheer", topics: ["self"], text: "Fed and watered: the grown-up edition." },
];

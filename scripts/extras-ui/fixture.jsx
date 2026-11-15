import { createRoot } from "react-dom/client";
import MapleApp from "../../src/components/maple/MapleApp";
import { EXTRAS_KEY, EXTRAS_SEEN_KEY } from "../../src/components/maple/extras";
import { EXTRAS, extraMilk, extraTopics, fits } from "../../src/lib/maple/whimsy";

// The real app, with every request answered by the check's synthetic route. What the check reads back about the
// little extras comes from their own module (the lines as they are now, and which of them fit an entry), never from
// a copy of their words, so it keeps working while the lines are rewritten.
window.__extras = {
  switchKey: EXTRAS_KEY,
  seenKey: EXTRAS_SEEN_KEY,
  lines: EXTRAS.map(({ id, kind, text }) => ({ id, kind, text })),
  /** The ids of the lines that may follow this entry, at this age, by day or at night. */
  pool: (entry, ageDays, night) => {
    const topics = extraTopics(entry, ageDays);
    return EXTRAS.filter((line) => fits(line, { topics, ageDays, night, milk: extraMilk(entry) })).map((line) => line.id);
  },
};

createRoot(document.getElementById("root")).render(<MapleApp />);

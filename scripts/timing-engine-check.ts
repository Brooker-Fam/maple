import { deepStrictEqual as eq } from "node:assert";
import { startBreast, switchTo } from "../src/lib/maple/feed";

const at = (time: string) => new Date(`2026-10-20T${time}.000Z`);
const original = switchTo(startBreast("L", at("10:00:00")), "R", at("10:15:00"), { by: "synthetic-parent" }).data;
const earlier = switchTo(original, "L", at("10:15:10"), { explicit: true, now: at("10:30:00"), by: "synthetic-parent" });
eq(earlier.data.segments, [
  { side: "L", start: at("10:00:00").toISOString(), end: at("10:15:00").toISOString() },
  { side: "R", start: at("10:15:00").toISOString(), end: at("10:15:10").toISOString() },
  { side: "L", start: at("10:15:10").toISOString(), end: null },
]);
eq(earlier.reverted, undefined);
const accidental = switchTo(original, "L", at("10:15:10"), { by: "synthetic-parent" });
eq(accidental.data.segments, [{ side: "L", start: at("10:00:00").toISOString(), end: null }]);
eq(accidental.reverted, true);
console.log("PASS explicit switch preserves a short side while an immediate un-timed tap still undoes it");

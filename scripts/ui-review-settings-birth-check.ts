import assert from "node:assert/strict";
import { birthInstant, birthProblem } from "../src/lib/maple/onboarding/steps";
import { dayKey } from "../src/lib/maple/time";

for (const [timezone, morning] of [
  ["America/New_York", "2026-10-28T13:00:00Z"],
  ["America/Los_Angeles", "2026-10-28T16:00:00Z"],
  ["Pacific/Honolulu", "2026-10-28T19:00:00Z"],
]) {
  const now = new Date(morning);
  const birth = { born: true as const, date: "2026-10-28", time: null };
  assert.equal(birthProblem(birth, timezone, now), null, `A birth today with an unknown time is accepted in ${timezone}`);
  assert(birthInstant(birth, timezone).getTime() <= now.getTime(), "An unknown birth time does not put a newborn in the future");
  assert.equal(dayKey(birthInstant(birth, timezone), timezone), birth.date, "The date is preserved in the family's timezone");
  assert(birthProblem({ ...birth, date: "2026-10-29" }, timezone, now), "An unknown time does not allow a future date");
  assert(birthProblem({ ...birth, time: "10:00" }, timezone, now), "A specified future birth time is still rejected");
}

console.log("PASS unknown birth time: setup before noon, family timezone, and future-date validation");

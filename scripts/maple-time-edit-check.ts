import assert from "node:assert/strict";
import { parseRecordedTime } from "../src/lib/maple/time-edit";

const tz = "America/New_York";
const now = new Date("2026-10-28T13:30:00Z");
const parse = (day: string, clock: string, reference = now, bounds: { min?: Date; max?: Date } = {}) => parseRecordedTime(day, clock, tz, reference, bounds);
const iso = (result: ReturnType<typeof parse>) => {
  if (!result.valid) throw new Error(result.message);
  return result.date.toISOString();
};

assert.equal(iso(parse("2026-10-27", "23:50")), "2026-10-28T03:50:00.000Z", "Yesterday stays yesterday in the family timezone");
assert.equal(iso(parse("2026-10-28", "08:10")), "2026-10-28T12:10:00.000Z", "Clock input uses the family timezone, not the runner timezone");
assert.equal(parse("2026-10-28", "10:00", now, { max: now }).valid, false, "A future clock is rejected instead of becoming yesterday");
assert.equal(parse("2026-10-28", "08:10", now, { min: new Date("2026-10-28T12:15:00Z") }).valid, false, "A moment cannot move before its neighbouring boundary");
assert.equal(parse("2026-02-30", "08:00").valid, false, "Invalid calendar dates do not roll into another month");
assert.equal(parse("", "08:00").valid, false, "An incomplete date cannot save the old value");
assert.equal(parse("2026-10-28", "").valid, false, "An incomplete clock cannot save the old value");
assert.equal(parse("2026-03-08", "02:30").valid, false, "The spring-forward missing hour is not silently shifted");
assert.equal(iso(parse("2026-11-01", "01:30", new Date("2026-11-01T05:45:00Z"))), "2026-11-01T05:30:00.000Z", "Editing the first repeated hour stays in that occurrence");
assert.equal(iso(parse("2026-11-01", "01:30", new Date("2026-11-01T06:45:00Z"))), "2026-11-01T06:30:00.000Z", "Editing the second repeated hour stays in that occurrence");
const repeated = parse("2026-11-01", "01:30");
assert(repeated.valid && repeated.alternatives.length === 2, "Both repeated occurrences are available to choose explicitly");
assert.equal(iso(parse("2026-10-28", "08:10", new Date("2026-10-28T12:10:42Z"))), "2026-10-28T12:10:42.000Z", "Opening an editor does not round the saved seconds");
console.log("PASS explicit time editing: timezone, overnight, future, boundaries, invalid input, DST, and unchanged seconds");

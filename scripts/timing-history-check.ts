import assert from "node:assert/strict";
import { dstNote } from "../src/components/maple/LogTab";

const cases = [
  ["2026-04-05", "24.5-hour day (clocks fell back)"],
  ["2026-10-04", "23.5-hour day (clocks sprang forward)"],
] as const;
let failures = 0;
for (const [day, expected] of cases) {
  try {
    assert.equal(dstNote(day, "Australia/Lord_Howe"), expected);
    console.log(`PASS history labels the ${expected}`);
  } catch (error) {
    failures++;
    console.error(`FAIL history clock change on ${day}: ${error instanceof Error ? error.message : error}`);
  }
}
assert.equal(failures, 0, "History must retain fractional hours in clock-change day labels");

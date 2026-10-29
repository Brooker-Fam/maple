import assert from "node:assert/strict";
import { applicableMilestones, dailyDiscovery, developmentAge } from "../src/lib/maple/development";
import { DEVELOPMENT_TOPICS, DISCOVERIES } from "../src/lib/maple/guidelines/development";
import type { Baby } from "../src/lib/maple/types";

const baby = (overrides: Partial<Baby> = {}): Baby => ({
  id: 17, name: "Example", nickname: null, sex: null,
  born_at: "2026-10-20T12:00:00Z", due_date: null,
  birth_weight_g: null, birth_length_cm: null, birth_head_cm: null,
  timezone: "America/New_York", settings: {}, ...overrides,
});
const now = new Date("2026-10-29T12:00:00Z");
let passed = 0;
let failed = 0;

function check(name: string, run: () => void) {
  if (process.argv[2] && process.argv[2] !== name) return;
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check("invalid-and-future-profiles", () => {
  for (const profile of [
    baby({ born_at: null }), baby({ born_at: "not-a-date" }),
    baby({ born_at: "2026-02-30T12:00:00Z" }), baby({ born_at: "2026-11-01T12:00:00Z" }),
    baby({ timezone: "Not/A_Timezone" }),
  ]) {
    assert.equal(developmentAge(profile, now), null);
    assert.equal(dailyDiscovery(profile, now, []), null);
    assert.deepEqual(applicableMilestones(profile, now), []);
  }
  assert.equal(developmentAge(baby(), new Date("invalid")), null);
});

check("prematurity-corrects-development", () => {
  const profile = baby({ born_at: "2026-07-01T12:00:00Z", settings: { gestational_age_weeks: 32 } });
  assert.deepEqual(developmentAge(profile, new Date("2026-09-01T12:00:00Z")), {
    days: 6, months: 0, corrected: true, label: "6 days corrected age",
  });
  for (const gestation of [37, 40, null, "32", 2, Infinity]) {
    assert.equal(developmentAge(baby({ settings: { gestational_age_weeks: gestation } }), now)?.corrected, false);
  }
});

check("calendar-month-end", () => {
  const profile = baby({ born_at: "2026-01-31T17:00:00Z" });
  assert.equal(developmentAge(profile, new Date("2026-02-28T05:01:00Z"))?.months, 1);
  assert.equal(developmentAge(profile, new Date("2026-02-27T23:00:00Z"))?.months, 0);
  assert.equal(developmentAge(profile, new Date("2026-03-31T04:01:00Z"))?.months, 2);
});

check("second-birthday-boundary", () => {
  const profile = baby({ born_at: "2024-03-01T12:00:00Z" });
  assert.equal(developmentAge(profile, new Date("2026-03-01T17:00:00Z"))?.months, 24);
  assert.equal(developmentAge(profile, new Date("2026-03-02T05:00:00Z")), null);
  assert.equal(dailyDiscovery(profile, new Date("2026-03-02T05:00:00Z"), []), null);
});

check("family-local-daily-rotation", () => {
  const profile = baby({ timezone: "America/Los_Angeles" });
  const beforeUtcMidnight = dailyDiscovery(profile, new Date("2026-10-29T23:59:00Z"), ["movement"]);
  const afterUtcMidnight = dailyDiscovery(profile, new Date("2026-10-30T00:01:00Z"), ["movement"]);
  const nextLocalDay = dailyDiscovery(profile, new Date("2026-10-30T07:01:00Z"), ["movement"]);
  assert.ok(beforeUtcMidnight);
  assert.equal(beforeUtcMidnight.id, afterUtcMidnight?.id);
  assert.notEqual(afterUtcMidnight?.id, nextLocalDay?.id);
  assert.equal(
    dailyDiscovery(profile, new Date("2026-11-01T07:01:00Z"), ["movement"])?.id,
    dailyDiscovery(profile, new Date("2026-11-02T07:59:00Z"), ["movement"])?.id,
  );
});

check("interests-filter-and-order", () => {
  assert.equal(dailyDiscovery(baby(), now, ["feeding"])?.topic, "feeding");
  assert.equal(dailyDiscovery(baby(), now, ["sleep"])?.topic, "sleep");
  assert.equal(dailyDiscovery(baby(), now, ["sleep", "feeding"])?.id, dailyDiscovery(baby(), now, ["feeding", "sleep"])?.id);
  assert.equal(dailyDiscovery(baby(), now, ["unknown"])?.id, dailyDiscovery(baby(), now, [])?.id);
});

check("feeding-keeps-chronological-age", () => {
  const profile = baby({ born_at: "2026-03-29T12:00:00Z", settings: { gestational_age_weeks: 32 } });
  const card = dailyDiscovery(profile, new Date("2026-09-30T12:00:00Z"), ["feeding"]);
  assert.ok(card);
  assert.equal(card.ageBasis, "chronological");
  assert.ok(card.minMonths >= 6);
});

check("before-corrected-due-date", () => {
  const profile = baby({ settings: { gestational_age_weeks: 32 } });
  assert.equal(developmentAge(profile, now), null);
  assert.deepEqual(applicableMilestones(profile, now), []);
  assert.equal(dailyDiscovery(profile, now, ["movement"]), null);
  assert.equal(dailyDiscovery(profile, now, ["feeding"])?.topic, "feeding");
});

check("milestones-use-corrected-calendar-bands", () => {
  const profile = baby({ born_at: "2026-01-01T12:00:00Z" });
  const expected = new Map([[0, 2], [1, 2], [2, 2], [3, 4], [4, 4], [5, 6], [6, 6], [7, 9], [9, 9], [10, 12], [12, 12], [13, 18], [18, 18], [19, 24], [24, 24]]);
  for (const [months, band] of expected) {
    const date = new Date(Date.UTC(2026, months, 1, 17));
    const milestones = applicableMilestones(profile, date);
    assert.equal(milestones.length, 3);
    assert.ok(milestones.every((milestone) => milestone.byMonths === band));
  }
  const preterm = baby({ born_at: "2026-01-01T12:00:00Z", settings: { gestational_age_weeks: 32 } });
  assert.ok(applicableMilestones(preterm, new Date("2026-04-01T12:00:00Z")).every((item) => item.byMonths === 2));
});

check("every-interest-has-age-appropriate-content", () => {
  const profile = baby({ born_at: "2024-01-01T12:00:00Z" });
  for (let days = 0; days <= 731; days += 1) {
    const date = new Date(Date.UTC(2024, 0, 1 + days, 17));
    const months = developmentAge(profile, date)!.months;
    for (const topic of DEVELOPMENT_TOPICS) {
      const card = dailyDiscovery(profile, date, [topic.id]);
      assert.ok(card, `${topic.id} at ${months} months`);
      assert.equal(card.topic, topic.id);
      assert.ok(card.minMonths <= months && card.maxMonths > months);
      assert.ok(card.source.url.startsWith("https://"));
      const eligible = DISCOVERIES.filter((item) => item.topic === topic.id && item.minMonths <= months && item.maxMonths > months);
      assert.ok(eligible.length >= (months <= 12 ? 3 : 2), `${topic.id} has only ${eligible.length} cards at ${months} months`);
    }
  }
});

check("single-interest-changes-next-day", () => {
  const profile = baby({ born_at: "2024-01-01T12:00:00Z" });
  for (let months = 0; months < 24; months += 1) {
    for (const topic of DEVELOPMENT_TOPICS) {
      const first = dailyDiscovery(profile, new Date(Date.UTC(2024, months, 15, 17)), [topic.id]);
      const next = dailyDiscovery(profile, new Date(Date.UTC(2024, months, 16, 17)), [topic.id]);
      assert.ok(first && next);
      assert.notEqual(first.id, next.id, `${topic.id} at ${months} months`);
    }
  }
});

check("tummy-action-is-explicit", () => {
  const tummy = dailyDiscovery(baby(), now, ["movement"]);
  assert.equal(tummy?.id, "little-tummy-time");
  assert.equal(tummy.action, "tummy");
  const feeding = dailyDiscovery(baby({ born_at: "2026-10-21T12:00:00Z" }), now, ["feeding"]);
  assert.equal(feeding?.id, "tiny-growing-tummy");
  assert.equal(feeding.action, undefined);
});

if (!passed && !failed) throw new Error("No matching development check");
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

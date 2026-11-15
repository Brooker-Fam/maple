import assert from "node:assert/strict";
import { lifetimeNumbers, dutyWords, NUMBERS_FROM_DIAPERS } from "../src/components/maple/ByTheNumbers";
import { babyWords } from "../src/components/maple/familyWords";
import { EXTRA_MAX_CHARS } from "../src/lib/maple/whimsy";
import { celebrationQuip, handoffThanks } from "../src/lib/maple/whimsy/quips";

/**
 * Quips (lib/maple/whimsy/quips.ts): every celebration milestonesReached can
 * make gets a line (or a deliberate none), in the whimsy voice, with the
 * baby's own words; the hand-off's thank-you names only whoever logged; and
 * By the numbers counts only what it should. Synthetic names only.
 */

const words = {
  she: babyWords({ name: "Sam Example", nickname: null, sex: "female" }),
  he: babyWords({ name: "Sam", nickname: null, sex: "male" }),
  none: babyWords({ name: "Sam", nickname: null, sex: null }),
  unnamed: babyWords({ name: "", nickname: null, sex: null }),
  long: babyWords({ name: "Maximiliana", nickname: null, sex: null }),
};

// Every id insights.ts milestonesReached makes: born, week-1…4, month-1…24, day-100, the firsts, back to birth weight
// (regained-<entry id>), and the diaper and feed counts.
const IDS = [
  "born",
  ...[1, 2, 3, 4].map((n) => `week-${n}`),
  ...Array.from({ length: 24 }, (_, i) => `month-${i + 1}`),
  "day-100",
  "first-poop",
  "first-bath",
  "first-tummy",
  "regained-7",
  "regained-4120",
  "regained-98765",
  ...[100, 250, 500, 1000, 2000].map((n) => `diaper-${n}`),
  ...[100, 500, 1000].map((n) => `feed-${n}`),
  // Marks a later insights.ts might add still get a line.
  "diaper-5000",
  "feed-2000",
];
// Ids it never makes: no line, on purpose.
const UNKNOWN = ["", "nope", "week-5", "week-0", "month-0", "month-x", "day-101", "diaper-0", "feed-", "regained-", "regained-abc", "first-steps", "born-2"];

const EMOJI = /\p{Extended_Pictographic}/u;
const DASHES = /[\u2013\u2014]/;
// Kind to every family: no word about how the baby is fed, or who's a mom or a dad.
const FEEDING = /\b(breast|bottle|formula|nurs|pump|milk|latch)/i;
const ROLES = /\b(mom|mum|mommy|mama|mother|dad|daddy|papa|father|husband|wife)\b/i;
// Never advice, a target or a comparison.
const ADVICE = /\b(should|make sure|try to|remember to|don't forget|normal|average|most babies|other babies|goal|streak|score|record)\b/i;
// Back to birth weight is a gentle cheer: no numbers, no size.
const SIZE = /\d|\b(big|bigger|chunky|chubby|heavy|weigh|weight|gain|gram|pound|ounce|kilo|lb|oz|kg)/i;

let exclaimed = 0;
for (const id of IDS) {
  const lines = Object.entries(words).map(([key, w]) => [key, celebrationQuip(id, w)] as const);
  for (const [key, line] of lines) {
    assert(line, `${id} has a line (${key})`);
    assert.equal(line, celebrationQuip(id, words[key as keyof typeof words]), `${id}'s line is the same every time`);
    assert(!/[{}]/.test(line), `${id} (${key}) fills every token: ${line}`);
    assert(!EMOJI.test(line), `${id} has no emoji: ${line}`);
    assert(!DASHES.test(line), `${id} has no em or en dash: ${line}`);
    assert(line.length <= EXTRA_MAX_CHARS, `${id} (${key}) is at most ${EXTRA_MAX_CHARS} characters: ${line.length}`);
    assert(/^[A-Z]/.test(line) && /[.?!]$/.test(line), `${id} is a sentence: ${line}`);
    assert(!FEEDING.test(line), `${id} says nothing about how the baby is fed: ${line}`);
    assert(!ROLES.test(line), `${id} assumes no family roles: ${line}`);
    assert(!ADVICE.test(line), `${id} is never advice, a target or a comparison: ${line}`);
    assert(!/\s{2}|\s[.,?!]/.test(line), `${id} is spaced cleanly: ${line}`);
  }
  // With no sex saved the name stands in for every pronoun: never more than twice in a line.
  const none = celebrationQuip(id, words.none)!;
  assert((none.match(/\bSam\b/g) ?? []).length <= 2, `${id} says the name at most twice: ${none}`);
  assert(!/\b(she|her|hers|he|him|his)\b/i.test(none), `${id} guesses no pronoun with no sex saved: ${none}`);
  assert(!/\b(she|her)\b/i.test(celebrationQuip(id, words.he)!), `${id} keeps to his words`);
  assert(!/\b(he|him|his)\b/i.test(celebrationQuip(id, words.she)!), `${id} keeps to her words`);
  assert(!/\bSam's\b|\bSam\b/.test(celebrationQuip(id, words.unnamed)!), `${id} has no name before there is one`);
  if (/!/.test(none)) exclaimed++;
  if (id.startsWith("regained-")) assert(!SIZE.test(none), `Back to birth weight is a gentle cheer, no numbers or size: ${none}`);
}
assert(exclaimed <= 2, `Exclamation marks stay rare (${exclaimed})`);
console.log(`PASS every celebration has a short line in the whimsy voice, filled with she, he and no-sex words (${IDS.length} ids)`);

for (const id of UNKNOWN) assert.equal(celebrationQuip(id, words.she), null, `${JSON.stringify(id)} has no line`);
console.log("PASS an id milestonesReached never makes has no line");

// The month-days that share lines never repeat the month before; the named ones keep their own.
for (let m = 2; m <= 24; m++) assert.notEqual(celebrationQuip(`month-${m}`, words.none), celebrationQuip(`month-${m - 1}`, words.none), `month-${m} differs from the month before`);
assert.match(celebrationQuip("month-12", words.she)!, /first birthday, Sam\./);
assert.match(celebrationQuip("first-bath", words.unnamed)!, /^First bath done\. Who got wetter, the baby or you\?$/);
assert.equal(celebrationQuip("diaper-100", words.she), "You could do this blindfolded now. Please don't.");
assert.equal(new Set(IDS.map((id) => celebrationQuip(id, words.none))).size >= 25, true, "Enough different lines that a family rarely sees one twice");
console.log("PASS months take turns, and the named milestones keep their own lines");

// ── While you slept's thank-you ──────────────────────────────────────────
const KEYS = ["2026-10-28T05:00:00.000Z", "2026-10-28T09:30:00.000Z", "2026-10-29T04:12:00.000Z", "2026-11-02T06:45:10.000Z", "x"];
assert.equal(handoffThanks([], KEYS[0]), null, "Nobody else logged: no line");
assert.equal(handoffThanks(["", "  "], KEYS[0]), null, "Blank names are nobody");
for (const key of KEYS) {
  const one = handoffThanks(["Alex"], key)!;
  const two = handoffThanks(["Alex", "Jo"], key)!;
  const team = handoffThanks(["Alex", "Jo", "Kim"], key)!;
  assert.equal(one, handoffThanks(["Alex"], key), "The same recap keeps its line");
  assert.match(one, /^Alex (had it covered|kept things running)\./);
  assert.match(two, /^Alex and Jo had it covered\./);
  assert.match(team, /^(The team had it covered\.|A real team effort\.)/);
  assert(!/Alex|Jo|Kim/.test(team), "Three or more are the team, nobody singled out");
  for (const line of [one, two, team]) {
    assert(!EMOJI.test(line) && !DASHES.test(line) && !/!/.test(line), `The thank-you is calm: ${line}`);
    assert(line.length <= EXTRA_MAX_CHARS, `The thank-you is short: ${line}`);
    assert(!ROLES.test(line), `The thank-you assumes no family roles: ${line}`);
  }
}
assert.equal(handoffThanks(["Alex"], KEYS[0]), handoffThanks(["Alex"], KEYS[0]));
assert(new Set(KEYS.map((k) => handoffThanks(["Alex"], k))).size > 1, "Different mornings can get different lines");
assert.match(handoffThanks(["alex"], "x")!, /^Alex /, "A lowercase name still starts the sentence with a capital");
assert.match(handoffThanks(["$&"], "x")!, /^\$& /, "A name goes in exactly as written");
console.log("PASS the hand-off's thank-you names only whoever logged, one or two by name and more as the team");

// ── By the numbers ───────────────────────────────────────────────────────
const tz = "America/New_York";
const bornAt = "2026-10-01T16:00:00.000Z";
const at = new Date("2026-10-29T16:00:00.000Z");
assert.deepEqual(lifetimeNumbers({ bornAt, now: at, tz, diapers: 342, feeds: 410 }), { days: 28, hours: 672, diapers: 342, feeds: 410, dutyMinutes: 684 });
assert.equal(lifetimeNumbers({ bornAt, now: at, tz, diapers: NUMBERS_FROM_DIAPERS - 1, feeds: 400 }), null, "Too few diapers to be fun");
assert.notEqual(lifetimeNumbers({ bornAt, now: at, tz, diapers: NUMBERS_FROM_DIAPERS, feeds: 0 }), null);
assert.equal(lifetimeNumbers({ bornAt: null, now: at, tz, diapers: 342, feeds: 410 }), null, "No birth time, no card");
assert.equal(lifetimeNumbers({ bornAt: "2026-11-20T12:00:00.000Z", now: at, tz, diapers: 342, feeds: 410 }), null, "Never before birth");
assert.equal(lifetimeNumbers({ bornAt: "not a date", now: at, tz, diapers: 342, feeds: 410 }), null);
assert.deepEqual(["40 minutes", "an hour", "an hour", "2 hours", "11 hours", "67 hours", "1,333 hours"], [40, 60, 89, 90, 684, 4000, 80_000].map(dutyWords));
console.log("PASS By the numbers waits for a birth and 20 diapers, and says diaper duty in plain words");

import assert from "node:assert/strict";
import { careNutritionSummary } from "../src/lib/maple/care-nutrition";
import { predictGroups } from "../src/lib/maple/chat/tool-groups";
import { chatAddendum } from "../src/lib/maple/chat/prompt";
import { fortyDay, fortyDaysNote, fortyDaysStage } from "../src/lib/maple/forty-days";
import { MOM_NUTRITION_SUGGESTIONS } from "../src/lib/maple/guidelines";
import {
  FORTY_DAYS,
  FORTY_DAYS_ABOUT,
  FORTY_DAYS_BOOK,
  FORTY_DAY_NOTES,
  FORTY_DAY_STAGES,
  fortyDaysHelp,
  fortyDaysPendingReview,
  visitorNote,
} from "../src/lib/maple/guidelines/forty-days";
import { summarize } from "../src/lib/maple/insights";
import { milestoneLabel } from "../src/lib/maple/milestones";
import { babyAge } from "../src/lib/maple/time";
import type { Baby, Entry, EntryOf } from "../src/lib/maple/types";
import { FAMILY_ONE_VOICE, makeVoice, type Voice } from "../src/lib/maple/voice";

/**
 * The first forty days (guidelines/forty-days.ts): which day it is, one note a
 * day through day 40 and none after, and the rules every note keeps: its
 * sources, a version for her and one for whoever helps her, the book's ideas
 * as comfort rather than rules, and nothing that suggests an herb, a
 * supplement, alcohol, a medicine or a dose, holds a hot drink near the baby,
 * keeps her in bed or off any food.
 */

let passed = 0;
let failed = 0;
function check(name: string, run: () => void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try {
    run();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const TZ = "America/New_York";
const BORN = "2026-10-20T16:30:00Z"; // 12:30 PM in New York
const H = 3600_000;
const D = 24 * H;
const at = (ms: number) => new Date(Date.parse(BORN) + ms);
const ROBIN: Voice = makeVoice({ name: "June", pronoun: "she", mom: "Robin" });
const NO_PAGE: Voice = makeVoice({ name: "the baby", pronoun: "they" });
const VOICES = [ROBIN, NO_PAGE, FAMILY_ONE_VOICE];
const baby = (born_at: string | null = BORN): Baby => ({
  id: 7, name: "June", nickname: null, sex: "female", born_at, due_date: null,
  birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, timezone: TZ, settings: {},
});

/** Every word a reader can see for a note, in every voice. */
const noteTexts = (n: (typeof FORTY_DAY_NOTES)[number]) => [n.title, n.you, ...VOICES.flatMap((v) => [n.othersTitle(v), n.others(v)])];
const helpTexts = () => VOICES.flatMap((v) => { const h = fortyDaysHelp(v); return [h.heading, h.intro, ...h.you, ...h.others]; });
const ALL_TEXT = () => [...FORTY_DAY_NOTES.flatMap(noteTexts), ...helpTexts(), ...VOICES.map(visitorNote), ...FORTY_DAYS_ABOUT,
  MOM_NUTRITION_SUGGESTIONS.forty_general.title, MOM_NUTRITION_SUGGESTIONS.forty_general.body,
  MOM_NUTRITION_SUGGESTIONS.forty_prepared.title, MOM_NUTRITION_SUGGESTIONS.forty_prepared.body];

// ── which day ─────────────────────────────────────────────────────────────

check("day 1 is the birth day and day 40 the last, by Today's own clock", () => {
  eq(fortyDay(BORN, at(0), TZ), 1);
  eq(fortyDay(BORN, at(D - 60_000), TZ), 1);
  eq(fortyDay(BORN, at(D), TZ), 2);
  eq(fortyDay(BORN, at(39 * D), TZ), 40);
  eq(fortyDay(BORN, at(40 * D - 60_000), TZ), 40);
  eq(fortyDay(BORN, at(40 * D), TZ), null, "day 41 is past the forty");
  for (const ms of [0, 5 * H, 3 * D + 2 * H, 13 * D, 21 * D + 23 * H, 39 * D + 1]) {
    eq(fortyDay(BORN, at(ms), TZ), babyAge(BORN, at(ms), TZ).dayOfLife, `the same day as Today's hero at +${ms / H} h`);
  }
});

check("no day without a birth, before it, or from a broken date", () => {
  eq(fortyDay(null, at(D), TZ), null);
  eq(fortyDay(undefined, at(D), TZ), null);
  eq(fortyDay("not a date", at(D), TZ), null);
  eq(fortyDay(BORN, at(-H), TZ), null, "before the birth");
  eq(fortyDay(BORN, new Date("invalid"), TZ), null);
});

// ── the notes ─────────────────────────────────────────────────────────────

check("the stretches cover days 1 to 40 in order, each with notes", () => {
  let next = 1;
  for (const s of FORTY_DAY_STAGES) {
    eq(s.from, next, `${s.id} starts where the last ended`);
    ok(s.to >= s.from, `${s.id} runs forward`);
    ok(FORTY_DAY_NOTES.some((n) => n.stage === s.id), `${s.id} has a note`);
    next = s.to + 1;
  }
  eq(next - 1, FORTY_DAYS, "ends on day 40");
  eq(FORTY_DAYS, 40);
  for (const n of FORTY_DAY_NOTES) ok(FORTY_DAY_STAGES.some((s) => s.id === n.stage), `${n.id}'s stretch exists`);
  eq(new Set(FORTY_DAY_NOTES.map((n) => n.id)).size, FORTY_DAY_NOTES.length, "ids are unique");
});

check("one note every day through day 40, none outside, and tomorrow's is a different one", () => {
  eq(fortyDaysNote(0), null);
  eq(fortyDaysNote(41), null);
  eq(fortyDaysStage(41), null);
  for (let d = 1; d <= FORTY_DAYS; d++) {
    const n = fortyDaysNote(d);
    ok(n, `day ${d} has a note`);
    eq(n!.stage, fortyDaysStage(d)!.id, `day ${d}'s note is from its own stretch`);
    eq(fortyDaysNote(d), n, `day ${d} reads the same note every time`);
    const tomorrow = fortyDaysNote(d + 1);
    if (tomorrow && tomorrow.stage === n!.stage && FORTY_DAY_NOTES.filter((x) => x.stage === n!.stage).length > 1) {
      ok(tomorrow.id !== n!.id, `day ${d + 1} isn't day ${d}'s note again`);
    }
  }
  const seen = new Set(Array.from({ length: FORTY_DAYS }, (_, i) => fortyDaysNote(i + 1)!.id));
  eq(seen.size, FORTY_DAY_NOTES.length, "every note gets a day");
  eq(fortyDaysNote(1)!.id, "forty-days", "day 1 says what the forty days are");
  eq(fortyDaysNote(40)!.id, "fortieth", "day 40 closes them");
});

check("every note has words for her and for whoever helps her, in every family's names", () => {
  for (const n of FORTY_DAY_NOTES) {
    for (const t of noteTexts(n)) ok(t.trim().length > 0, `${n.id}: no empty words`);
    ok(n.title.length <= 40, `${n.id}: a short title (${n.title.length})`);
    ok(n.you.length <= 320 && n.others(ROBIN).length <= 320, `${n.id}: short enough to read one-handed`);
    ok(!/\bRobin\b/.test(n.you), `${n.id}: hers speaks to her, not about her`);
    ok(!n.others(NO_PAGE).includes("undefined") && !n.othersTitle(NO_PAGE).includes("undefined"), `${n.id}: no missing name`);
  }
});

check("every note is sourced: the book for its traditions, a health body for anything about her health", () => {
  for (const n of FORTY_DAY_NOTES) {
    ok(n.sources.length > 0, `${n.id}: has a source`);
    for (const s of n.sources) ok(/^https:\/\//.test(s.url) && s.label.trim().length > 0, `${n.id}: ${s.label} is a labelled https link`);
    const book = n.sources.includes(FORTY_DAYS_BOOK);
    const health = n.sources.some((s) => s !== FORTY_DAYS_BOOK);
    if (n.basis === "book") ok(book, `${n.id}: a tradition credits the book`);
    if (n.basis === "source") ok(health, `${n.id}: health guidance names its source`);
    if (n.basis === "both") ok(book && health, `${n.id}: both`);
    ok(/^\d{4}-\d{2}-\d{2}$/.test(n.reviewed), `${n.id}: reviewed date`);
  }
  eq(fortyDaysPendingReview().length, FORTY_DAY_NOTES.filter((n) => n.needsReview).length, "the sign-off list");
  ok(/^https:\/\//.test(FORTY_DAYS_BOOK.url) && FORTY_DAYS_BOOK.label.includes("The First Forty Days"), "the book link");
});

check("comfort, not rules: no should or must, no dashes, nothing kept off the menu, no bed rest", () => {
  for (const t of ALL_TEXT()) {
    ok(!/\b(should|must|have to|need to)\b/i.test(t.replace(/\b(don't|do not|doesn't|never) (have|need) to\b/gi, "")), `invitation, not a rule: "${t}"`);
    ok(!/[–—]/.test(t), `no em or en dash: "${t}"`);
    ok(!/\b(avoid|don't eat|do not eat|never eat|stay away from|off limits|forbidden)\b/i.test(t), `no food is ruled out: "${t}"`);
    ok(!/\b(bed rest|stay in bed|don't (shower|bathe|wash)|no (showers?|baths?))\b/i.test(t), `no bed rest, no skipped showers: "${t}"`);
  }
});

check("nothing suggests an herb, a supplement, alcohol, a medicine or a dose", () => {
  const RISKY = /\b(herbs?|herbal|tinctures?|supplements?|tonics?|dang gui|dong quai|angelica|ginseng|fenugreek|astragalus|motherwort|galactagogues?|lactation (cookies|tea)|rice wine|wine|alcohol|liquor|beer|brewer'?s yeast|medicines?|medications?|pills?|doses?|mg|milligrams?)\b/i;
  const caution = FORTY_DAYS_ABOUT.filter((p) => RISKY.test(p));
  eq(caution.length, 1, "only the one caution paragraph names them");
  ok(/\b(ask|check with)\b/i.test(caution[0]) && /\bpharmacist\b/i.test(caution[0]), "and it says who to ask");
  for (const t of ALL_TEXT().filter((x) => !caution.includes(x))) ok(!RISKY.test(t), `nothing risky: "${t}"`);
});

/** CAPT: a hot drink can scald a baby even 15 minutes after it's made, so it waits for someone else to hold the baby, or out of reach. */
const SCALD_SAFE = /out of (the baby's|their) reach|where the baby can't reach|someone else (holds|is holding|has) the baby|(isn't|is not) holding the baby|while (you|someone else) holds? the baby/i;

check("a hot drink or bowl is only for when someone else holds the baby, and the baby is never kept warm", () => {
  for (const t of ALL_TEXT()) {
    if (/\b(hot|warm) (drinks?|tea|water|milk|broth|cup|mugs?|bowls?)\b|\btea\b|\bsomething warm (to drink|and simple)\b/i.test(t)) ok(SCALD_SAFE.test(t), `scald-safe: "${t}"`);
    ok(!/\bwarm (room|house|home)\b|\b(keep|make) the (room|house) warm\b|\bbundle (her|him|them|the baby)\b/i.test(t), `never overheating the baby: "${t}"`);
  }
});

check("no family's names or private details in the words", () => {
  const text = ALL_TEXT().join("\n");
  ok(!/\b(Maple|Brittany|Matt|Brooker)\b/.test(text.replace(/Maple's Log/g, "")), "no names from the original family");
  for (const n of FORTY_DAY_NOTES) ok(n.others(ROBIN).includes("Robin") || /\bher\b/.test(n.others(ROBIN)), `${n.id}: helpers read about her`);
});

check("the visitor note asks for clean hands, staying away when sick, and food over gifts, with no names", () => {
  for (const v of VOICES) {
    const t = visitorNote(v);
    ok(/wash (your )?hands/i.test(t), "hands");
    ok(/(unwell|sick|ill)\b/i.test(t), "sick visitors");
    ok(/\bmeal\b/i.test(t), "food");
    ok(t.length <= 480, `short enough for a text (${t.length})`);
    ok(!t.includes("June") && !t.includes("Robin"), "no names: whoever sends it adds them");
  }
});

// ── her food and drink ideas ──────────────────────────────────────────────

const feed = (start: string, end: string): EntryOf<"feed"> => ({
  id: 1, kind: "feed", started_at: start, ended_at: end, active: false,
  data: { method: "breast", segments: [{ side: "L", start, end }] },
  note: null, created_by: "synthetic", updated_by: null, source: "web", created_at: start, updated_at: start,
});

check("in the forty days the general and between-feeds ideas are the warm ones; after them, the usual", () => {
  const day10 = at(9 * D + 6 * H);
  const day41 = at(40 * D + 6 * H);
  const lastFeed = (now: Date): Entry[] => [feed(new Date(now.getTime() - 2 * H).toISOString(), new Date(now.getTime() - 100 * 60_000).toISOString())];
  const s = (now: Date, entries: Entry[], bornAt: string | null | undefined = BORN) => careNutritionSummary([], entries, { now, tz: TZ, bornAt }).suggestion.title;
  eq(s(day10, []), MOM_NUTRITION_SUGGESTIONS.forty_general.title, "general, day 10");
  eq(s(day10, lastFeed(day10)), MOM_NUTRITION_SUGGESTIONS.forty_prepared.title, "between feeds, day 10");
  eq(s(day41, []), MOM_NUTRITION_SUGGESTIONS.general.title, "general, day 41");
  eq(s(day41, lastFeed(day41)), MOM_NUTRITION_SUGGESTIONS.prepared.title, "between feeds, day 41");
  eq(s(day10, [], null), MOM_NUTRITION_SUGGESTIONS.general.title, "no birth, no forty days");
  eq(careNutritionSummary([], [], { now: day10, tz: TZ }).suggestion.title, MOM_NUTRITION_SUGGESTIONS.general.title, "older callers without a birth");
  const running = careNutritionSummary([], [{ ...feed(new Date(day10.getTime() - 5 * 60_000).toISOString(), ""), ended_at: null, active: true, data: { method: "breast", segments: [{ side: "L", start: new Date(day10.getTime() - 5 * 60_000).toISOString(), end: null }] } }], { now: day10, tz: TZ, bornAt: BORN });
  eq(running.suggestion.title, MOM_NUTRITION_SUGGESTIONS.drink.title, "a feed going now keeps its own idea");
  eq(careNutritionSummary([], [], { now: day10, tz: TZ, bornAt: BORN, feeding: "no" }).suggestion.title, MOM_NUTRITION_SUGGESTIONS.forty_general.title, "not nursing: still warm and simple");
});

check("the warm ideas keep the NHS's no-special-diet line and their sources", () => {
  const { forty_general: g, forty_prepared: p, general, prepared } = MOM_NUTRITION_SUGGESTIONS;
  eq(g.sourceUrl, FORTY_DAYS_BOOK.url, "the general one is the book's");
  eq(p.sourceUrl, prepared.sourceUrl, "between feeds keeps the NHS's breastfeeding page");
  ok(/special diet/i.test(p.body), "you don't need a special diet");
  ok((g.title as string) !== general.title && (p.title as string) !== prepared.title, "they read as their own");
});

// ── Today and the chat ────────────────────────────────────────────────────

check("Today celebrates forty days once they've passed, and a kept moment says so", () => {
  const titles = (now: Date) => summarize({ entries: [], baby: baby(), now, vo: ROBIN }).celebrations.map((c) => `${c.id}:${c.title}`);
  ok(!titles(at(40 * D - H)).some((t) => t.startsWith("day-40")), "not before");
  ok(titles(at(40 * D + H)).includes("day-40:Forty days of June"), "the day after day 40");
  ok(!titles(at(44 * D)).some((t) => t.startsWith("day-40")), "for a few days, then gone");
  eq(milestoneLabel("day-40", { familyOne: false, name: "June" }), "Forty days of June");
  eq(milestoneLabel("day-40", { familyOne: false, name: "the baby" }), "Forty days old");
  eq(milestoneLabel("day-10", { familyOne: false, name: "June" }), "10 days of June", "other days as before");
});

check("the chat brings her food tools for soups, teas and the forty days, and knows the book is comfort, not medicine", () => {
  for (const said of ["is chicken soup good after birth", "can you log a bowl of congee", "I had ginger tea", "what does the first forty days say about visitors", "we're doing la cuarentena", "zuo yuezi foods", "bone broth for lunch"]) {
    ok(predictGroups({ said }).includes("mom"), `loads her tools: "${said}"`);
  }
  for (const said of ["she had 2 oz of formula", "wet diaper", "she's asleep"]) ok(!predictGroups({ said }).includes("mom"), `not for: "${said}"`);
  const text = chatAddendum(ROBIN);
  ok(text.includes("The First Forty Days"), "names the book");
  ok(/never as medical advice/i.test(text), "as comfort, not medicine");
  ok(/herbs/i.test(text) && /pharmacist/i.test(text), "herbs and remedies go to her OB or a pharmacist");
});

function eq<T>(actual: T, expected: T, message?: string) {
  assert.deepEqual(actual, expected, message);
}
function ok(value: unknown, message?: string): asserts value {
  assert.ok(value, message);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

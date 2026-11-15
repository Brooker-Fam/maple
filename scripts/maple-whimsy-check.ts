/**
 * `pnpm check:maple-whimsy`: the little extras (lib/maple/whimsy). Every
 * line's rules (ids, kinds, topics, sources, length, words, tokens in each
 * family's words, the night, milk, ages, sleep), the pools by age and time of
 * day, the picker, and which entries get a line at all.
 * `pnpm check:maple-whimsy <name>` runs one check; `pnpm check:maple-whimsy
 * pool-table` prints how many lines fit each entry, by age, by day and at night.
 */
import assert from "node:assert/strict";
import { unsafeSleep } from "../src/lib/maple/sleep/goals";
import { SLEEP_PLACES, STOOL_COLORS, TIMER_KINDS, type Entry, type EntryDataByKind, type EntryKind, type StoolColor } from "../src/lib/maple/types";
import { makeVoice, type Pronoun } from "../src/lib/maple/voice";
import {
  CHEERS_ONLY,
  EMPTY_MEMORY,
  EXTRAS,
  EXTRA_MAX_CHARS,
  EXTRA_TOKENS,
  KINDS,
  MAX_SEEN,
  NIGHT_GAP_MS,
  extraAgeDays,
  extraMilk,
  extraTokens,
  extraTopics,
  fillExtra,
  fits,
  pickExtra,
  type Extra,
  type ExtraKind,
  type ExtraMemory,
  type ExtraMilk,
  type ExtraTopic,
  type ExtraWords,
} from "../src/lib/maple/whimsy";

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

// ── Fixtures ──────────────────────────────────────────────────────────────

const ALL_TOPICS = [
  "care",
  "diaper",
  "pee",
  "poop",
  "feed",
  "nursing",
  "bottle",
  "pump",
  "sleep",
  "tummy",
  "bath",
  "moment",
  "doctor",
  "note",
  "hiccups",
  "growth",
  "try",
  "self",
] as const satisfies readonly ExtraTopic[];
// A topic added to types.ts fails the typecheck here until it's listed (and so checked).
const everyTopicListed: [Exclude<ExtraTopic, (typeof ALL_TOPICS)[number]>] extends [never] ? true : never = true;
const TOPICS = new Set<string>(ALL_TOPICS);

/** Where a fact may come from: the AAP, the CDC, the NHS, the WHO, the NIH and its institutes, and the big children's hospitals' and clinics' patient pages. */
const SOURCE_SITES = [
  "healthychildren.org",
  "cdc.gov",
  "nhs.uk",
  "who.int",
  "nichd.nih.gov",
  "safetosleep.nichd.nih.gov",
  "medlineplus.gov",
  "nih.gov",
  "my.clevelandclinic.org",
  "mayoclinic.org",
  "kidshealth.org",
  "hopkinsmedicine.org",
  "stanfordchildrens.org",
  "sleepfoundation.org",
];

/** The baby's words as familyWords.babyWords makes them: with no sex saved the name stands in for each pronoun, and "the baby" for a missing name. */
function words(name: string, pronoun: Pronoun): ExtraWords {
  const f =
    pronoun === "she"
      ? { he: "she", him: "her", his: "her", hes: "she's" }
      : pronoun === "he"
        ? { he: "he", him: "him", his: "his", hes: "he's" }
        : { he: name, him: name, his: `${name}'s`, hes: `${name}'s` };
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { name, Name: cap(name), ...f, He: cap(f.he), His: cap(f.his), Hes: cap(f.hes) };
}

const FORMS: { label: string; name: string; pronoun: Pronoun }[] = [
  { label: "she", name: "Sam", pronoun: "she" },
  { label: "he", name: "Sam", pronoun: "he" },
  { label: "no sex saved", name: "Sam", pronoun: "they" },
  { label: "no name or sex", name: "the baby", pronoun: "they" },
  { label: "she, no name", name: "the baby", pronoun: "she" },
  { label: "he, no name", name: "the baby", pronoun: "he" },
];
const RENDERS = FORMS.map((f) => ({ ...f, w: words(f.name, f.pronoun), v: makeVoice({ name: f.name, pronoun: f.pronoun }) }));
const SHE = RENDERS[0].w;

/** A line as each family reads it. */
const rendered = (l: Extra) => RENDERS.map((r) => ({ label: r.label, text: fillExtra(l.text, r.w), v: r.v }));

/** mulberry32: the same picks every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1;
const AT = "2026-11-01T15:00:00.000Z";
function entry<K extends EntryKind>(kind: K, data: EntryDataByKind[K], active = false): Entry {
  return {
    id: nextId++,
    kind,
    started_at: AT,
    ended_at: active ? null : AT,
    active,
    data,
    note: null,
    created_by: null,
    updated_by: null,
    source: "web",
    created_at: AT,
    updated_at: AT,
  } as unknown as Entry;
}

const wet = () => entry("diaper", { pee: true, poop: false });
const dirty = (color: StoolColor = "yellow") => entry("diaper", { pee: false, poop: true, color });
const nursing = () => entry("feed", { method: "breast", left_sec: 600 });
const bottle = (milk?: "breastmilk" | "formula" | "mixed") => entry("feed", { method: "bottle", amount_ml: 60, ...(milk ? { milk } : {}) });

/** Everyday entries and the specific topics their lines are about (the rest of their pool is lines for any log). */
const EVERYDAY: { label: string; e: () => Entry; specific: ExtraTopic[] }[] = [
  { label: "wet diaper", e: wet, specific: ["pee", "diaper"] },
  { label: "dirty diaper", e: () => dirty(), specific: ["poop", "diaper"] },
  { label: "wet and dirty diaper", e: () => entry("diaper", { pee: true, poop: true, color: "mustard" }), specific: ["poop", "pee", "diaper"] },
  { label: "dry diaper", e: () => entry("diaper", { pee: false, poop: false }), specific: ["diaper"] },
  { label: "nursing", e: nursing, specific: ["nursing", "feed"] },
  { label: "bottle", e: () => bottle(), specific: ["bottle", "feed"] },
  { label: "breast milk bottle", e: () => bottle("breastmilk"), specific: ["bottle", "feed"] },
  { label: "formula bottle", e: () => bottle("formula"), specific: ["bottle", "feed"] },
  { label: "mixed bottle", e: () => bottle("mixed"), specific: ["bottle", "feed"] },
  { label: "SNS at the breast", e: () => entry("feed", { method: "bottle", via: "sns", amount_ml: 20, milk: "formula" }), specific: ["feed"] },
  { label: "pumping", e: () => entry("pump", { total_ml: 90 }), specific: ["pump"] },
  { label: "sleep", e: () => entry("sleep", { place: "bassinet" }), specific: ["sleep"] },
  { label: "tummy time", e: () => entry("tummy", {}), specific: ["tummy"] },
  { label: "bath", e: () => entry("bath", {}), specific: ["bath"] },
];
const DIAPERS_AND_FEEDS = EVERYDAY.filter((x) => x.specific.some((t) => t === "diaper" || t === "feed"));

const AGES = [0, 10, 45, 120, 270, 400];

const pool = (topics: ExtraTopic[] | null, ageDays: number | null, night: boolean, milk: ExtraMilk | null = null) =>
  EXTRAS.filter((l) => fits(l, { topics, ageDays, night, milk }));

// ── Content: every line's rules ───────────────────────────────────────────

check("ids-kinds-and-topics", () => {
  assert.equal(everyTopicListed, true);
  const FIELDS = new Set(["id", "kind", "topics", "text", "ages", "night", "milk", "source"]);
  const ids = new Set<string>();
  for (const l of EXTRAS) {
    assert.ok(!ids.has(l.id), `${l.id} is listed twice`);
    ids.add(l.id);
    for (const key of Object.keys(l)) assert.ok(FIELDS.has(key), `${l.id}: unknown field ${key}`);
    assert.match(l.id, /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/, `${l.id}: ids are kebab-case, "<topic>-<kind>-<name>"`);
    const [prefix, kind] = l.id.split("-");
    assert.ok((KINDS as readonly string[]).includes(l.kind), `${l.id}: unknown kind ${l.kind}`);
    assert.equal(kind, l.kind, `${l.id}: the id names its kind`);
    assert.ok(l.topics.length > 0, `${l.id} has no topics`);
    assert.equal(new Set(l.topics).size, l.topics.length, `${l.id} lists a topic twice`);
    for (const t of l.topics) assert.ok(TOPICS.has(t), `${l.id}: unknown topic ${t}`);
    assert.ok(prefix === l.topics[0] || (l.night !== undefined && prefix === "night"), `${l.id}: the id starts with its first topic, or "night"`);
    if (l.topics.some((t) => CHEERS_ONLY.has(t))) assert.equal(l.kind, "cheer", `${l.id}: ${l.topics.join(", ")} only ever get a cheer`);
  }
  for (const t of ALL_TOPICS) assert.ok(EXTRAS.some((l) => l.topics.includes(t)), `no line for ${t}`);
});

check("facts-and-sources", () => {
  for (const l of EXTRAS) {
    if (l.kind !== "fact") {
      assert.equal(l.source, undefined, `${l.id}: only facts carry a source`);
      assert.doesNotMatch(l.text, /^fun fact\b/i, `${l.id}: only a fact starts "Fun fact"`);
      continue;
    }
    assert.ok(l.text.startsWith("Fun fact: "), `${l.id}: a fact starts "Fun fact: "`);
    assert.ok(l.source, `${l.id}: every fact has a source`);
    const url = new URL(l.source);
    assert.equal(url.protocol, "https:", `${l.id}: its source is https`);
    assert.ok(!url.username && !url.password && !url.hash, `${l.id}: a plain link to the page`);
    assert.ok(
      SOURCE_SITES.some((site) => url.hostname === site || url.hostname.endsWith(`.${site}`)),
      `${l.id}: ${url.hostname} isn't one of the sites a fact may cite`
    );
  }
  assert.ok(EXTRAS.filter((l) => l.kind === "fact").length >= 60, "the library has its facts");
});

check("lengths-and-characters", () => {
  let short = 0;
  for (const l of EXTRAS) {
    // Plain letters, digits and punctuation only: no emoji, no curly quotes, no em or en dashes.
    assert.match(l.text, /^[A-Za-z0-9 .,;:'"?!(){}-]+$/, `${l.id}: a character outside plain letters and punctuation: "${l.text}"`);
    assert.doesNotMatch(l.text, /\p{Extended_Pictographic}/u, `${l.id}: no emoji`);
    assert.doesNotMatch(l.text, / - |--/, `${l.id}: a hyphen standing in for a dash; use a colon, comma or period`);
    assert.doesNotMatch(l.text, /\s{2}|^\s|\s$/, `${l.id}: stray spaces`);
    const longest = Math.max(l.text.length, ...rendered(l).map((r) => r.text.length));
    assert.ok(longest <= EXTRA_MAX_CHARS, `${l.id} is ${longest} characters, over ${EXTRA_MAX_CHARS}`);
    if (fillExtra(l.text, SHE).length <= 90) short += 1;
  }
  assert.ok(short >= EXTRAS.length * 0.7, `only ${short} of ${EXTRAS.length} lines are 90 characters or less`);
  const loud = EXTRAS.filter((l) => l.text.includes("!"));
  assert.ok(loud.length <= EXTRAS.length * 0.05, `${loud.length} lines with an exclamation mark: keep them rare`);
  for (const l of loud) assert.equal(l.text.split("!").length, 2, `${l.id}: one exclamation mark at most`);
});

check("tokens-in-every-familys-words", () => {
  for (const l of EXTRAS) {
    const tokens = extraTokens(l.text);
    for (const t of tokens) assert.ok((EXTRA_TOKENS as readonly string[]).includes(t), `${l.id}: unknown token {${t}}`);
    assert.ok(tokens.length <= 2, `${l.id}: at most two of the baby's words in a line`);
    // With no sex saved both are the name, so two in one sentence read "Offer Sam a finger and Sam may…".
    for (const part of l.text.split(/[.?!:]\s+/)) assert.ok(extraTokens(part).length <= 1, `${l.id}: two of the baby's words in one sentence`);
    for (const r of rendered(l)) {
      assert.doesNotMatch(r.text, /[{}]/, `${l.id} (${r.label}): a token left in: "${r.text}"`);
      assert.match(r.text, /^[A-Z]/, `${l.id} (${r.label}) starts with a capital: "${r.text}"`);
      assert.match(r.text, /[.?!]$/, `${l.id} (${r.label}) ends its sentence: "${r.text}"`);
      assert.doesNotMatch(r.text, /[.?!]\s+[a-z]/, `${l.id} (${r.label}): a sentence starts in lowercase: "${r.text}"`);
    }
  }
  const unique = new Set(EXTRAS.map((l) => fillExtra(l.text, SHE).toLowerCase()));
  assert.equal(unique.size, EXTRAS.length, "two lines say the same thing word for word");
});

check("the-night", () => {
  const night = EXTRAS.filter((l) => l.night);
  assert.ok(night.length >= 15, "the night has its own lines");
  for (const l of night) {
    assert.ok(l.night === "also" || l.night === "only", `${l.id}: night is "also" or "only"`);
    assert.equal(l.kind, "cheer", `${l.id}: the night gets quiet cheers only`);
    assert.ok(!l.text.includes("!"), `${l.id}: no exclamation marks at night`);
    const longest = Math.max(...rendered(l).map((r) => r.text.length));
    assert.ok(longest <= 80, `${l.id}: a night line stays short (${longest})`);
    assert.equal(l.ages, undefined, `${l.id}: the night is the same at any age`);
  }
});

check("milk-and-ages", () => {
  for (const l of EXTRAS) {
    if (l.milk !== undefined) {
      assert.ok(l.milk === "breastmilk" || l.milk === "formula", `${l.id}: milk is "breastmilk" or "formula"`);
      assert.ok(l.topics.includes("bottle"), `${l.id}: only a bottle line names its milk`);
    }
    const formula = /\bformula\b/i.test(l.text);
    const breastMilk = /\bbreast ?milk\b/i.test(l.text);
    assert.ok(!(formula && breastMilk), `${l.id}: never both milks in one line`);
    if (formula) assert.equal(l.milk, "formula", `${l.id}: a line about formula is only for formula`);
    if (breastMilk) assert.equal(l.milk, "breastmilk", `${l.id}: a line about breast milk is only for breast milk`);
    if (l.ages) {
      const [from, to] = l.ages;
      assert.ok(l.ages.length === 2 && Number.isInteger(from) && Number.isInteger(to), `${l.id}: ages are two whole days`);
      assert.ok(from >= 0 && from < to && to <= 731, `${l.id}: ages [${from}, ${to}] are a window within [0, 731]`);
    }
  }
});

check("words-fit-the-age", () => {
  for (const l of EXTRAS) {
    if (/\bnewborns?\b/i.test(l.text)) assert.ok(l.ages && l.ages[1] <= 92, `${l.id}: a line about newborns stops by about 3 months`);
    if (/\btoddlers?\b/i.test(l.text)) assert.ok(l.ages && l.ages[0] >= 365, `${l.id}: a line about toddlers starts at a year`);
  }
});

check("words-fit-the-topic", () => {
  for (const l of EXTRAS) {
    const t = l.text;
    const has = (topic: ExtraTopic) => l.topics.includes(topic);
    // After any everyday log, so it never names what was just logged.
    if (has("care")) assert.doesNotMatch(t, /\b(diapers?|poops?|pee|wet|nurs\w*|breast\w*|bottles?|formula|pump\w*|bath\w*|tummy|naps?|feeds?|fed|feeding|burp\w*)\b/i, `${l.id}: a line for any log names one: "${t}"`);
    if (has("feed")) {
      // Any feed: nursing, a bottle, or milk at the breast by an SNS or a syringe.
      const breast = /\b(breast|nurs\w*|latch\w*)\b/i.test(t);
      const bottles = /\bbottles?\b/i.test(t);
      assert.equal(breast, bottles, `${l.id}: a line for any feed names the breast and the bottle together, or neither`);
      assert.doesNotMatch(t, /\b(formula|pump\w*|sides?|left|right)\b/i, `${l.id}: a line for any feed`);
    }
    // Any change (a dry one too), a wet one that may also be dirty, a dirty one that may also be wet; any note at all.
    if (has("diaper")) assert.doesNotMatch(t, /\b(wet|pee|poops?|dirty|mess\w*)\b/i, `${l.id}: a line for any change says what kind`);
    if (has("pee")) assert.doesNotMatch(t, /\b(poops?|dirty)\b/i, `${l.id}: a wet diaper's line mentions poop`);
    if (has("poop")) assert.doesNotMatch(t, /\b(pee|wet)\b/i, `${l.id}: a dirty diaper's line mentions pee`);
    if (has("note")) assert.doesNotMatch(t, /\b(hiccups?|spit\w*|fuss\w*|gas|nails?|cord)\b/i, `${l.id}: a line for any note says what it's about`);
    if (has("nursing")) assert.doesNotMatch(t, /\b(bottles?|formula|pump\w*|syringe|sns|your body)\b/i, `${l.id}: a nursing line is about nursing`);
    if (has("bottle")) assert.doesNotMatch(t, /\b(nurs\w*|latch\w*|breastfe\w*|sides?)\b/i, `${l.id}: a bottle line is about the bottle`);
    if (has("pump")) assert.doesNotMatch(t, /\b(amounts?|output|full|empty|drops?|liquid gold|stash)\b/i, `${l.id}: never how much a session brought`);
    if (has("self")) {
      assert.doesNotMatch(t, /\b(you|your|yours|yourself)\b/i, `${l.id}: anyone may log her food, so a line never says "you"`);
      assert.equal(extraTokens(t).length, 0, `${l.id}: her own food never names the baby`);
    }
    if (has("growth"))
      assert.doesNotMatch(
        t,
        /\b(big\w*|small\w*|little|tiny|grow\w*|fast\w*|size\w*|inch\w*|cm|heav\w*|light\w*|tall\w*|long\w*|short\w*|chart\w*|numbers?|gain\w*|huge|chunk\w*)\b/i,
        `${l.id}: never a word about the numbers: "${t}"`
      );
    if (has("try")) assert.doesNotMatch(t, /\b(fail\w*|success\w*|win|won|lose|lost|bad|worse|better|perfect\w*|almost|nearly|finally|good job|great job)\b/i, `${l.id}: a try is never judged`);
  }
});

/** Words no line uses, and why. */
const BANNED: [RegExp, string][] = [
  [/\b(doses?|dosing|mg|ml|oz|ounces?|cc|amounts?)\b/i, "an amount or a dose"],
  [/\b(should|must|make sure|need to|needs to|have to|has to|be sure|remember to|don't forget)\b/i, "an instruction"],
  [/\b(normal\w*|abnormal|healthy|unhealthy|safe|safely|safety|unsafe|risks?|danger\w*)\b/i, "a judgement about health or safety"],
  [/\b(weight|weigh\w*|pounds?|lbs?|kilos?|kg|grams?|percentiles?|growth charts?)\b/i, "a measurement"],
  [/\b(sids|suffocat\w*|cry(ing)? it out|cio|ferber\w*|sleep[- ]?train\w*|co-?sleep\w*|bed-?shar\w*|swaddl\w*)\b/i, "unsafe sleep or sleep training"],
  [/\b(medicines?|medications?|meds|vaccines?|vaccinat\w*|shots?|fevers?|sick|illness|infections?|jaundice|dehydrat\w*|diagnos\w*|symptoms?|reflux|colic)\b/i, "health"],
  [/\b(worr\w*|wrong|mistakes?|fail\w*|enough|supply|oversupply|let-?down|engorg\w*|overtired)\b/i, "worry or judgement"],
  [/\b(moms?|mommy|mum|mummy|mama|mother\w*|dads?|daddy|dada|father\w*|husband|wife)\b/i, "a family role"],
  [/\b(drunk|tipsy|wine|beer|booze|cocktails?|happy hour|bottoms up|cheers|hangover|vodka|whiskey|liquor|alcohol)\b/i, "alcohol"],
  [/\b(exhaust\w*|zombies?|dead|dying|surviv\w*|barely|nightmare|torture)\b/i, "bleak tiredness"],
  [/\b(pampers|huggies|luvs|similac|enfamil|medela|spectra|haakaa|boppy|dockatot|snoo|owlet|nanit|diaper genie|desitin|aquaphor|vaseline|tylenol|motrin|advil)\b/i, "a brand"],
];

check("banned-words", () => {
  for (const l of EXTRAS) for (const r of rendered(l)) for (const [re, why] of BANNED) assert.doesNotMatch(r.text, re, `${l.id} (${r.label}): ${why}: "${r.text}"`);
});

/** A sleep's or try's line never mentions where or how a baby sleeps, or anything in the sleep space (unsafeSleep is the backstop). */
const SLEEP_WORDS = /\b(arms?|held|hold\w*|swings?|seats?|chest|beds?|couch|sofa|chairs?|carriers?|strollers?|slings?|blankets?|pillows?|bumpers?|tummy|stomach|sides?|cry|crying|cried|tears?)\b/i;
/** A sleep logged with no place may have been anywhere: its lines name none. */
const PLACE_WORDS = /\b(bassinets?|cribs?|cots?|nursery|naps?|bedtime)\b/i;
/** Never how long or how well anyone slept (a fact may compare sleep cycles). */
const AMOUNT_WORDS = /\b(long\w*|short\w*|hours?|minutes?|stretch\w*|all night|through the night|well rested|good sleeper)\b/i;
/** A line for any log can follow a sleep: never soft things or adult surfaces. */
const SOFT_THINGS = /\b(blankets?|pillows?|bumpers?|couch|sofa|swings?|car seats?|beds?|chest)\b/i;

check("safe-sleep", () => {
  for (const l of EXTRAS) {
    const afterSleep = l.topics.some((t) => t === "sleep" || t === "try" || t === "care");
    if (!afterSleep) continue;
    for (const r of rendered(l)) {
      const found = unsafeSleep(r.text, { v: r.v });
      assert.equal(found, null, `${l.id} (${r.label}): unsafeSleep finds "${found?.phrase}" in "${r.text}"`);
    }
    const plain = unsafeSleep(fillExtra(l.text, RENDERS[3].w));
    assert.equal(plain, null, `${l.id}: unsafeSleep without a voice finds "${plain?.phrase}"`);
    if (l.topics.includes("sleep") || l.topics.includes("try")) assert.doesNotMatch(l.text, SLEEP_WORDS, `${l.id}: a sleep line mentions where or how a baby sleeps`);
    if (l.topics.includes("sleep")) {
      assert.doesNotMatch(l.text, PLACE_WORDS, `${l.id}: a sleep line names no place`);
      if (l.kind !== "fact") assert.doesNotMatch(l.text, AMOUNT_WORDS, `${l.id}: never how long or how well anyone slept`);
    }
    if (l.topics.includes("care")) assert.doesNotMatch(l.text, SOFT_THINGS, `${l.id}: a line for any log may follow a sleep`);
  }
  // So a pass means something: the filter still refuses what these rules keep out.
  for (const text of ["Let her cry it out", "She naps in the swing", "She sleeps on my chest"]) assert.ok(unsafeSleep(text, { v: RENDERS[0].v }), `unsafeSleep refuses "${text}"`);
});

check("library-size", () => {
  assert.ok(EXTRAS.length >= 280, `${EXTRAS.length} lines`);
  assert.ok(EXTRAS.length < MAX_SEEN, `${EXTRAS.length} lines, but a phone remembers only ${MAX_SEEN}: a round of every pool must fit`);
});

// ── Pools: by age, by day and at night ────────────────────────────────────

check("pools-by-day", () => {
  for (const age of AGES) {
    for (const x of DIAPERS_AND_FEEDS) {
      const e = x.e();
      const n = pool(extraTopics(e, age), age, false, extraMilk(e)).length;
      assert.ok(n >= 40, `day ${age}, ${x.label}: ${n} lines fit (40 or more)`);
    }
    for (const x of EVERYDAY.filter((y) => !DIAPERS_AND_FEEDS.includes(y))) {
      const e = x.e();
      const n = pool(extraTopics(e, age), age, false).filter((l) => l.topics.some((t) => x.specific.includes(t))).length;
      assert.ok(n >= 15, `day ${age}, ${x.label}: ${n} lines of its own (15 or more)`);
    }
    for (const [label, e] of [
      ["moment", entry("moment", { title: "First smile" })],
      ["question for the doctor", entry("note", { for_doctor: true })],
      ["note", entry("note", { tag: "spitup" })],
      ["hiccups", entry("note", { tag: "hiccups" })],
      ["measurements", entry("growth", { length_cm: 52 })],
    ] as const) {
      const n = pool(extraTopics(e, age), age, false).length;
      assert.ok(n >= (label === "moment" ? 15 : 8), `day ${age}, ${label}: ${n} lines fit`);
    }
    for (const topic of ["try", "self"] as const) {
      const n = pool([topic], age, false).length;
      assert.ok(n >= 8, `day ${age}, ${topic}: ${n} lines fit (8 or more)`);
    }
  }
  // Before a birth time is saved, only lines without ages: still plenty.
  for (const x of DIAPERS_AND_FEEDS) {
    const e = x.e();
    const n = pool(extraTopics(e, 30), null, false, extraMilk(e)).length;
    assert.ok(n >= 40, `no birth time, ${x.label}: ${n} lines fit`);
  }
});

check("pools-at-night", () => {
  for (const age of AGES) {
    for (const x of EVERYDAY) {
      const e = x.e();
      const lines = pool(extraTopics(e, age), age, true, extraMilk(e));
      assert.ok(lines.length >= 15, `night, day ${age}, ${x.label}: ${lines.length} quiet lines fit (15 or more)`);
      assert.ok(lines.every((l) => l.night && l.kind === "cheer"), `night, ${x.label}: only quiet cheers`);
      if (x.specific.some((t) => t === "diaper" || t === "feed" || t === "pump")) {
        const own = lines.filter((l) => l.topics.some((t) => x.specific.includes(t))).length;
        assert.ok(own >= 3, `night, day ${age}, ${x.label}: ${own} lines of its own (3 or more)`);
      }
    }
    const tries = pool(["try"], age, true).length;
    assert.ok(tries >= 3, `night, day ${age}: ${tries} lines for a bassinet try`);
  }
});

check("a-week-of-logs", () => {
  // A family logging 10 diapers and 10 feeds a day, round the clock, for a week: by day, a line almost never repeats.
  for (const age of [3, 10, 45, 120, 270, 400]) {
    const random = seeded(age + 11);
    let memory: ExtraMemory = EMPTY_MEMORY;
    const shown = new Set<string>();
    let day = 0;
    let repeats = 0;
    const start = Date.UTC(2026, 0, 5);
    for (let i = 0; i < 7 * 20; i++) {
      const minutes = i * 72 + Math.floor(random() * 40);
      const hour = Math.floor((minutes % 1440) / 60);
      const night = hour >= 20 || hour < 7;
      const roll = random();
      const e =
        i % 2 === 0
          ? roll < 0.5
            ? wet()
            : roll < 0.7
              ? dirty()
              : roll < 0.9
                ? entry("diaper", { pee: true, poop: true, color: "yellow" })
                : entry("diaper", { pee: false, poop: false })
          : roll < 0.5
            ? nursing()
            : roll < 0.7
              ? bottle("formula")
              : roll < 0.85
                ? bottle("breastmilk")
                : roll < 0.9
                  ? bottle("mixed")
                  : entry("feed", { method: "bottle", via: "syringe", amount_ml: 10, milk: "breastmilk" });
      const picked = pickExtra({ topics: extraTopics(e, age), ageDays: age, night, milk: extraMilk(e), memory, now: start + minutes * 60_000, random });
      if (!picked) continue;
      memory = picked.memory;
      if (night) continue;
      day += 1;
      if (shown.has(picked.extra.id)) repeats += 1;
      shown.add(picked.extra.id);
    }
    assert.ok(day >= 60, `day ${age}: ${day} lines by day in a week`);
    assert.ok(repeats <= day * 0.02, `day ${age}: ${repeats} repeats among ${day} lines by day in a week`);
  }
});

if (process.argv[2] === "pool-table") {
  // Not a check: how many lines fit each entry, by age (no birth time, then days old), by day and at night.
  const ages: (number | null)[] = [null, ...AGES];
  console.log(["entry", ...ages.map((a) => (a === null ? "none" : `day ${a}`))].join("\t"));
  const rows: [string, ExtraTopic[] | null, ExtraMilk | null][] = [
    ...EVERYDAY.map((x): [string, ExtraTopic[] | null, ExtraMilk | null] => [x.label, extraTopics(x.e(), 10), extraMilk(x.e())]),
    ["moment", ["moment"], null],
    ["doctor", ["doctor"], null],
    ["note", ["note"], null],
    ["hiccups note", ["hiccups", "note"], null],
    ["growth", ["growth"], null],
    ["try", ["try"], null],
    ["self", ["self"], null],
  ];
  for (const night of [false, true]) {
    console.log(night ? "-- at night" : "-- by day");
    for (const [label, topics, milk] of rows) console.log([label, ...ages.map((a) => pool(topics, a, night, milk).length)].join("\t"));
  }
}

// ── The picker ────────────────────────────────────────────────────────────

/** Picks after picks, as a phone makes them. */
function run(topics: ExtraTopic[], ageDays: number | null, count: number, o: { seed?: number; lines?: readonly Extra[]; memory?: ExtraMemory; night?: boolean; step?: number } = {}) {
  const random = seeded(o.seed ?? 1);
  let memory = o.memory ?? EMPTY_MEMORY;
  const shown: Extra[] = [];
  for (let i = 0; i < count; i++) {
    const picked = pickExtra({ topics, ageDays, night: o.night ?? false, memory, now: 1_800_000_000_000 + i * (o.step ?? 60_000), random, lines: o.lines });
    assert.ok(picked, `a line for ${topics.join(", ")} at pick ${i}`);
    memory = picked.memory;
    shown.push(picked.extra);
  }
  return { shown, memory };
}

const line = (id: string, kind: ExtraKind, extra: Partial<Extra> = {}): Extra => ({ id, kind, topics: ["care"], text: "Logged.", ...extra });

check("a-round-before-any-repeat", () => {
  const cases: [string, ExtraTopic[] | null, number][] = [
    ["wet diaper", extraTopics(wet(), 10), 10],
    ["nursing", extraTopics(nursing(), 45), 45],
    ["pumping", ["pump", "care"], 120],
    ["moment", ["moment"], 400],
    ["try", ["try"], 30],
  ];
  for (const [label, topics, age] of cases) {
    assert.ok(topics);
    const ids = pool(topics, age, false).map((l) => l.id);
    const { shown } = run(topics, age, ids.length * 3, { seed: age + 3 });
    const round = shown.slice(0, ids.length).map((l) => l.id);
    assert.deepEqual([...round].sort(), [...ids].sort(), `${label}: the first ${ids.length} lines are every fitting line, once`);
    for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i].id, shown[i - 1].id, `${label}: the same line twice in a row at pick ${i}`);
  }
});

check("the-newest-never-first", () => {
  const lines = ["a", "b", "c", "d"].map((x) => line(`care-cheer-${x}`, "cheer"));
  for (let seed = 1; seed <= 300; seed++) {
    const { shown } = run(["care"], 0, 13, { seed, lines });
    // Round one is all four; each round after leaves out the one shown last.
    assert.equal(new Set(shown.slice(0, 4).map((l) => l.id)).size, 4, `seed ${seed}: round one shows each line once`);
    for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i].id, shown[i - 1].id, `seed ${seed}: the newest of a round came first in the next`);
  }
  // A pool of one still shows its line.
  assert.equal(run(["care"], 0, 3, { lines: [lines[0]] }).shown.length, 3);
});

check("kinds-take-turns", () => {
  const lines = [
    ...["a", "b", "c"].map((x) => line(`care-fact-${x}`, "fact", { text: "Fun fact: test.", source: "https://medlineplus.gov/" })),
    ...["a", "b", "c"].map((x) => line(`care-joke-${x}`, "joke")),
    ...["a", "b", "c"].map((x) => line(`care-cheer-${x}`, "cheer")),
  ];
  for (let seed = 1; seed <= 300; seed++) {
    const after = { seen: [], at: null, kind: "fact" } satisfies ExtraMemory;
    const picked = pickExtra({ topics: ["care"], ageDays: 0, night: false, memory: after, now: 0, random: seeded(seed), lines });
    assert.notEqual(picked?.extra.kind, "fact", `seed ${seed}: after a fact, a joke or a cheer`);
  }
  // When the last kind is all that's left in the round, it still shows.
  const onlyFacts = { seen: lines.filter((l) => l.kind !== "fact").map((l) => l.id), at: null, kind: "fact" } satisfies ExtraMemory;
  assert.equal(pickExtra({ topics: ["care"], ageDays: 0, night: false, memory: onlyFacts, now: 0, random: seeded(1), lines })?.extra.kind, "fact");
  // In the library, by day, kinds take turns while the round still has others.
  for (const [topics, age] of [[extraTopics(wet(), 45), 45], [extraTopics(bottle("formula"), 270), 270]] as const) {
    assert.ok(topics);
    const { shown } = run([...topics], age, 40, { seed: age });
    for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i].kind, shown[i - 1].kind, `day ${age}: two ${shown[i].kind}s in a row at pick ${i}`);
  }
});

check("the-night-is-quiet", () => {
  const topics = extraTopics(wet(), 10);
  assert.ok(topics);
  const t0 = Date.UTC(2026, 0, 6, 3);
  const first = pickExtra({ topics, ageDays: 10, night: true, memory: EMPTY_MEMORY, now: t0, random: seeded(2) });
  assert.ok(first && first.extra.night && first.extra.kind === "cheer", "at night, a quiet cheer");
  assert.equal(first.memory.at, t0);
  assert.equal(pickExtra({ topics, ageDays: 10, night: true, memory: first.memory, now: t0 + NIGHT_GAP_MS - 1, random: seeded(3) }), null, "then none for NIGHT_GAP_MS");
  assert.ok(pickExtra({ topics, ageDays: 10, night: true, memory: first.memory, now: t0 + NIGHT_GAP_MS, random: seeded(3) }), "and one again after it");
  assert.ok(pickExtra({ topics, ageDays: 10, night: false, memory: first.memory, now: t0 + 1000, random: seeded(3) }), "by day, no wait");
  const nights = run([...topics], 10, 60, { night: true, step: NIGHT_GAP_MS }).shown;
  assert.ok(nights.every((l) => l.night && l.kind === "cheer"), "every line at night is one for the night");
  const days = run([...topics], 10, 200).shown;
  assert.ok(days.every((l) => l.night !== "only"), "a line only for the night never shows by day");
  assert.ok(days.some((l) => l.night === "also"), "a calm line for any time shows by day too");
});

check("ages-and-milk-filters", () => {
  const newborn = line("care-fact-test", "fact", { ages: [0, 91], text: "Fun fact: test.", source: "https://medlineplus.gov/" });
  const care = { topics: ["care"] as ExtraTopic[], night: false };
  assert.ok(fits(newborn, { ...care, ageDays: 0 }) && fits(newborn, { ...care, ageDays: 90 }), "inside its window");
  assert.ok(!fits(newborn, { ...care, ageDays: 91 }), "its window ends before `to`");
  assert.ok(!fits(newborn, { ...care, ageDays: null }), "a line with ages waits for a birth time");
  const formula = line("bottle-joke-test", "joke", { topics: ["bottle"], milk: "formula" });
  assert.ok(fits(formula, { topics: ["bottle"], ageDays: 10, night: false, milk: "formula" }));
  for (const milk of [null, undefined, "breastmilk"] as const) assert.ok(!fits(formula, { topics: ["bottle"], ageDays: 10, night: false, milk }), `a formula line after a ${milk ?? "plain"} bottle`);
  // The library, through the picker: no line with ages before a birth time, and each milk's lines only after that milk.
  for (let seed = 1; seed <= 40; seed++) {
    assert.ok(run([...(extraTopics(nursing(), 0) ?? [])], null, 30, { seed }).shown.every((l) => !l.ages), "no birth time: no line with ages");
    for (const milk of ["breastmilk", "formula"] as const) {
      const e = bottle(milk);
      const random = seeded(seed);
      let memory: ExtraMemory = EMPTY_MEMORY;
      for (let i = 0; i < 30; i++) {
        const picked = pickExtra({ topics: extraTopics(e, 30), ageDays: 30, night: false, milk: extraMilk(e), memory, now: i * 60_000, random });
        assert.ok(picked);
        assert.ok(!picked.extra.milk || picked.extra.milk === milk, `${picked.extra.id} after a ${milk} bottle`);
        memory = picked.memory;
      }
    }
  }
  const mixed = bottle("mixed");
  assert.ok(pool(extraTopics(mixed, 30), 30, false, extraMilk(mixed)).every((l) => !l.milk), "a Mixed bottle takes the lines about any bottle");
});

check("specific-topics-weigh-more", () => {
  const cases: [string, ExtraTopic[] | null, number][] = [
    ["dirty diaper", extraTopics(dirty(), 45), 45],
    ["nursing", extraTopics(nursing(), 120), 120],
    ["pumping", ["pump", "care"], 400],
  ];
  for (const [label, topics, age] of cases) {
    assert.ok(topics);
    const lines = pool(topics, age, false);
    const weight = (l: Extra) => topics.length - Math.min(...l.topics.map((t) => topics.indexOf(t)).filter((i) => i >= 0));
    const own = lines.filter((l) => l.topics.includes(topics[0]));
    const expected = own.reduce((a, l) => a + weight(l), 0) / lines.reduce((a, l) => a + weight(l), 0);
    const plain = own.length / lines.length;
    const n = 4000;
    let hits = 0;
    for (let seed = 1; seed <= n; seed++) {
      const picked = pickExtra({ topics, ageDays: age, night: false, memory: EMPTY_MEMORY, now: 0, random: seeded(seed) });
      if (picked?.extra.topics.includes(topics[0])) hits += 1;
    }
    const seen = hits / n;
    assert.ok(Math.abs(seen - expected) < 0.03, `${label}: ${topics[0]} lines came first ${(seen * 100).toFixed(1)}% of the time, expected ${(expected * 100).toFixed(1)}%`);
    assert.ok(seen > plain + 0.05, `${label}: ${topics[0]} lines (${(seen * 100).toFixed(1)}%) beat their share of the pool (${(plain * 100).toFixed(1)}%)`);
  }
});

check("no-topics-no-line", () => {
  for (const topics of [null, []]) assert.equal(pickExtra({ topics, ageDays: 10, night: false, memory: EMPTY_MEMORY, now: 0 }), null);
  assert.equal(pickExtra({ topics: ["care"], ageDays: 10, night: false, memory: EMPTY_MEMORY, now: 0, lines: [] }), null, "nothing fits: none");
  const { memory } = run(["care"], 10, 500);
  assert.ok(memory.seen.length <= MAX_SEEN, "a phone remembers at most MAX_SEEN lines");
});

check("words-filled-in", () => {
  assert.equal(fillExtra("{Name} and {his} toes. {Hes} here.", words("Sam", "she")), "Sam and her toes. She's here.");
  assert.equal(fillExtra("{He} and {him}.", words("Sam", "he")), "He and him.");
  assert.equal(fillExtra("{Name} and {his} toes.", words("the baby", "they")), "The baby and the baby's toes.");
  assert.deepEqual(extraTokens("Hi {name}, {foo}."), ["name", "foo"]);
  assert.equal(fillExtra("{foo}", words("Sam", "he")), "{foo}", "an unknown token stays in braces, and the content checks catch it");
});

// ── Which entries get a line ──────────────────────────────────────────────

check("no-line-beside-a-reading-a-medicine-or-a-timer", () => {
  assert.equal(extraTopics(entry("temp", { temp_c: 37.1 }), 10), null);
  assert.equal(extraTopics(entry("vitals", { heart_bpm: 140 }), 10), null);
  assert.equal(extraTopics(entry("med", { name: "Example drops" }), 10), null);
  const running: Record<(typeof TIMER_KINDS)[number], Entry> = {
    feed: entry("feed", { method: "breast" }, true),
    sleep: entry("sleep", { place: "bassinet" }, true),
    tummy: entry("tummy", {}, true),
    pump: entry("pump", {}, true),
  };
  for (const kind of TIMER_KINDS) assert.equal(extraTopics(running[kind], 10), null, `a ${kind} timer still running`);
});

check("no-line-beside-a-diaper-to-call-about", () => {
  assert.equal(extraTopics(entry("diaper", { pee: true, poop: false, rash: true }), 10), null, "a rash");
  assert.equal(extraTopics(entry("diaper", { pee: false, poop: true, color: "yellow", rash: true }), 10), null, "a rash with a poop");
  for (const color of ["pale_yellow", "gray", "white", "red"] as const) {
    for (const age of [2, 10, null]) assert.equal(extraTopics(dirty(color), age), null, `${color} poop at day ${age}`);
  }
  assert.deepEqual(extraTopics(dirty("black"), 2), ["poop", "diaper", "care"], "black at day 2 is meconium");
  assert.deepEqual(extraTopics(dirty("black"), 3), ["poop", "diaper", "care"]);
  for (const age of [4, 10, null]) assert.equal(extraTopics(dirty("black"), age), null, `black poop at day ${age}`);
  for (const color of STOOL_COLORS.filter((c) => !["pale_yellow", "gray", "white", "red", "black"].includes(c))) {
    assert.deepEqual(extraTopics(dirty(color), 10), ["poop", "diaper", "care"], `${color} poop`);
  }
  assert.deepEqual(extraTopics(entry("diaper", { pee: true, poop: true, color: "mustard" }), 10), ["poop", "pee", "diaper", "care"]);
  assert.deepEqual(extraTopics(entry("diaper", { pee: false, poop: true }), 10), ["poop", "diaper", "care"], "a poop with no color said");
  assert.deepEqual(extraTopics(wet(), 10), ["pee", "diaper", "care"]);
  assert.deepEqual(extraTopics(entry("diaper", { pee: false, poop: false }), 10), ["diaper", "care"]);
});

check("sleep-only-in-the-babys-own-space", () => {
  const unsafe = ["arms", "bed", "car", "carrier", "stroller"] as const;
  const own = ["bassinet", "crib"] as const;
  assert.deepEqual([...unsafe, ...own].sort(), [...SLEEP_PLACES].sort(), "every sleep place is decided here");
  for (const place of unsafe) assert.equal(extraTopics(entry("sleep", { place }), 30), null, `a sleep in the ${place}`);
  for (const place of own) assert.deepEqual(extraTopics(entry("sleep", { place }), 30), ["sleep", "care"], `a sleep in the ${place}`);
  assert.deepEqual(extraTopics(entry("sleep", {}), 30), ["sleep", "care"], "a sleep with no place said");
});

check("feeds-notes-and-the-rest", () => {
  assert.deepEqual(extraTopics(nursing(), 10), ["nursing", "feed", "care"]);
  assert.deepEqual(extraTopics(bottle("formula"), 10), ["bottle", "feed", "care"]);
  assert.deepEqual(extraTopics(entry("feed", { method: "bottle", via: "paced", amount_ml: 60 }), 10), ["bottle", "feed", "care"]);
  for (const via of ["sns", "syringe"] as const) {
    assert.deepEqual(extraTopics(entry("feed", { method: "bottle", via, amount_ml: 10 }), 10), ["feed", "care"], `milk at the breast by ${via} is never a bottle`);
  }
  assert.deepEqual(extraTopics(entry("pump", { total_ml: 80 }), 10), ["pump", "care"]);
  assert.deepEqual(extraTopics(entry("tummy", {}), 10), ["tummy", "care"]);
  assert.deepEqual(extraTopics(entry("bath", {}), 10), ["bath", "care"]);
  assert.deepEqual(extraTopics(entry("moment", { title: "First bath" }), 10), ["moment"]);
  assert.deepEqual(extraTopics(entry("growth", { length_cm: 50 }), 10), ["growth"]);
  assert.deepEqual(extraTopics(entry("note", { for_doctor: true }), 10), ["doctor"]);
  assert.deepEqual(extraTopics(entry("note", { for_doctor: true, tag: "hiccups" }), 10), ["doctor"], "a question for the doctor stays one");
  assert.deepEqual(extraTopics(entry("note", { tag: "hiccups" }), 10), ["hiccups", "note"]);
  assert.deepEqual(extraTopics(entry("note", { tag: "spitup", amount: "lots" }), 10), ["note"]);
  assert.deepEqual(extraTopics(entry("note", {}), 10), ["note"]);
});

check("milk-and-age-helpers", () => {
  assert.equal(extraMilk(bottle("formula")), "formula");
  assert.equal(extraMilk(bottle("breastmilk")), "breastmilk");
  assert.equal(extraMilk(bottle("mixed")), null, "Mixed has both");
  assert.equal(extraMilk(bottle()), null);
  assert.equal(extraMilk(nursing()), null);
  assert.equal(extraMilk(wet()), null);
  const born = "2026-11-01T12:00:00.000Z";
  assert.equal(extraAgeDays(null, Date.parse(born)), null);
  assert.equal(extraAgeDays("not a date", Date.parse(born)), null);
  assert.equal(extraAgeDays(born, Date.parse(born) - 1), null, "not born yet");
  assert.equal(extraAgeDays(born, Date.parse(born)), 0);
  assert.equal(extraAgeDays(born, new Date(Date.parse(born) + 36 * 3_600_000)), 1);
});

if (process.argv[2] !== "pool-table") {
  if (!passed && !failed) throw new Error("No matching whimsy check");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

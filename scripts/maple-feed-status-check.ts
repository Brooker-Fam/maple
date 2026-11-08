import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { feedClusters, lastFedAnchor, lastFedRule, minutesShort, nursingRuns, sameFeedBottleIds, spanText, topUpMl, typicalFeedGapMin, type LastFed } from "../src/lib/maple/feed";
import { bottleFeedWords, feedPartsList, planUnitsOf } from "../src/lib/maple/describe";
import { formatDuration, formatRelative, formatTime } from "../src/lib/maple/time";
import { feedTargetOf, formatVolume, formatVolumeRange, setVolumesBoth } from "../src/lib/maple/units";
import { makeVoice } from "../src/lib/maple/voice";
import type { EntryOf, FeedData, Segment } from "../src/lib/maple/types";

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
const source = ts.createSourceFile("StatusCard.tsx", readFileSync("src/components/maple/StatusCard.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const noop = () => {};
const at = (clock: string) => `2026-01-02T${clock}:00.000Z`;
const iso = (ms: number) => new Date(ms).toISOString();
const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join("");
  if (node && typeof node === "object" && "children" in node) return text((node as Element).children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
};
const elements = (node: unknown): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("children" in node)) return [];
  return [node as Element, ...(node as Element).children.flatMap(elements)];
};
const classes = (node: Element) => String(node.props.className ?? "");
/** What a short screen (under 720px tall) hides while another timer runs. */
const FOLDS = /\[@media\(max-height:719px\)\]:hidden/;
const voice = makeVoice({ name: "the baby", pronoun: "she" });

function fn<T>(name: string, context: Record<string, unknown>): T {
  let found: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(found, `Missing ${name}`);
  const js = ts.transpileModule(`(${found.getText(source).replace(/^export (default )?/, "")})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "h", jsxFragmentFactory: "Fragment" },
  }).outputText;
  return runInNewContext(js, { h, Fragment: "fragment", ...context }) as T;
}

function feed(id: number, segments: Segment[]): EntryOf<"feed"> {
  return {
    id, kind: "feed", started_at: segments[0].start, ended_at: segments.at(-1)!.end, active: false,
    data: { method: "breast", segments, first_side: "L" }, note: null, source: "web",
    created_by: null, updated_by: null, created_at: segments[0].start, updated_at: segments.at(-1)!.end!,
  };
}
const part = (start: string, end: string, side: Segment["side"] = "L"): Segment => ({ start: at(start), end: at(end), side });
function bottle(id: number, start: string, end: string, ml: number, extra: Partial<FeedData> = {}): EntryOf<"feed"> {
  return {
    id, kind: "feed", started_at: at(start), ended_at: at(end), active: false,
    data: { method: "bottle", amount_ml: ml, ...extra }, note: null, source: "web",
    created_by: null, updated_by: null, created_at: at(start), updated_at: at(end),
  };
}
/** Nine 15-minute feeds 3 hours apart before 10:00, the first over a day back, so the usual gap is known: 3 hours. */
const history = () => Array.from({ length: 9 }, (_, i) => {
  const start = Date.parse(at("10:00")) - (9 - i) * 3 * 3600_000;
  return feed(10 + i, [{ start: iso(start), end: iso(start + 15 * 60_000), side: "L" }]);
});

type RenderOptions = {
  info?: boolean;
  settings?: Record<string, unknown>;
  /** A bottle feed's later bottles, as feed.ts's LastFed carries them (a feeding plan's formula to finish). */
  more?: EntryOf<"feed">[];
  /** What the block's tap opens. */
  open?: (sheet: unknown) => void;
};

function render(entries: EntryOf<"feed">[], clock: string, sleeping = false, { info = false, settings = {}, more, open = noop }: RenderOptions = {}) {
  const now = new Date(at(clock));
  const runs = nursingRuns(entries, now);
  const anchor = lastFedAnchor(entries, now, runs);
  const lastFed: (LastFed & { more?: EntryOf<"feed">[] }) | null = anchor && more ? { ...anchor, more } : anchor;
  const summary = {
    lastFed, lastFeed: entries.at(-1), next: null, cluster: feedClusters(runs).at(-1), born: false,
    active: sleeping ? [{ kind: "sleep", started_at: at(clock) }] : [],
  };
  const helpers = { isSide: (side: unknown) => side === "L" || side === "R", SIDE_NAME: { L: "Left", R: "Right" } };
  const card = fn<() => Element>("StatusCard", {
    useMaple: () => ({ state: { entries, baby: { timezone: "UTC", settings }, me: { email: "synthetic@example.test" } }, summary, log: noop, memberLabel: noop, readOnly: false, units: "metric", isNight: () => false }),
    // The info button's state: open for this one render when `info`. No feeding plan saved: no plan side.
    useVoice: () => voice, useSheets: () => ({ open }), useNow: () => now, useState: () => [info, noop], useClusterInfo: () => ({ open: noop, sheet: null }), usePlanNow: () => null,
    DEFAULT_TZ: "UTC", typicalFeedGapMin, topUpMl, feedPartsList, bottleFeedWords, planUnitsOf, feedTargetOf, formatVolumeRange, formatRelative, formatTime, formatDuration, formatVolume, minutesShort, spanText, lastFedRule,
    ts: (entry: { started_at: string }) => Date.parse(entry.started_at), since: String, sidesLabel: fn("sidesLabel", helpers),
    cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "), tone: {}, DETAIL_COLOR: {}, KIND_COLOR: {},
    Icon: "Icon", NextSide: "NextSide", Since: "Since", AnimatePresence: "AnimatePresence", motion: { p: "p" },
  });
  const rendered = card();
  return { rendered, text: text(rendered), summary };
}

/** The one line under the big number: the finish, then what the feed was. */
function detailsLine(rendered: Element): Element {
  const line = elements(rendered).find((node) => node.type === "p" && elements(node).some((x) => x.props["aria-label"] === "How this is counted"));
  assert.ok(line, "The details line carries the info button");
  return line;
}
/** What the info button opens. */
const expansion = (rendered: Element) => elements(rendered).find((node) => node.type === "p" && /overflow-hidden/.test(classes(node)));

test("a feed finished now distinguishes its start from its finish, including on a short screen with a sleep timer", () => {
  const result = render([feed(1, [part("10:00", "10:17")])], "10:17", true);
  assert.match(result.text, /Last feed started17m ago/);
  assert.match(result.text, /Finished just now/);
  // One line, led by the finish. On a short screen with a sleep timer the finish stays, and the rest of its line (with
  // the info button) folds away.
  const line = detailsLine(result.rendered);
  assert.equal(text(line), "Finished just now\u00a0· 17m\u00a0· Left only");
  assert.doesNotMatch(classes(line), /hidden/);
  const finished = elements(line).find((node) => text(node) === "Finished just now");
  assert.ok(finished, "The finish has an element of its own");
  assert.doesNotMatch(classes(finished), /hidden/);
  const folds = elements(line).filter((node) => FOLDS.test(classes(node)));
  assert.equal(folds.length, 1);
  assert.equal(text(folds[0]), "\u00a0· 17m\u00a0· Left only");
  assert.ok(elements(folds[0]).some((node) => node.props["aria-label"] === "How this is counted"), "The info button folds with the details");
  assert.equal(result.summary.lastFed?.at, at("10:00"));
  const older = render([feed(1, [part("10:00", "10:17")])], "10:22");
  assert.match(older.text, /Finished 5m ago/);
  assert.equal(elements(older.rendered).filter((node) => FOLDS.test(classes(node))).length, 0, "Nothing folds without another timer");
});

test("the finish leads the details line; the start and the usual gap are under the info button", () => {
  const entries = [...history(), feed(1, [part("10:00", "10:12"), part("10:12", "10:30", "R")])];
  assert.equal(typicalFeedGapMin(entries, new Date(at("11:10"))), 180);
  const result = render(entries, "11:10");
  const line = text(detailsLine(result.rendered));
  assert.equal(line, "Finished 40m ago\u00a0· 30m\u00a0· Left then Right");
  assert.doesNotMatch(line, /started|usually every/i);
  assert.doesNotMatch(result.text, /usually every|Started/);
  assert.equal(expansion(result.rendered), undefined);
  // Opened: the feed's clock times first, then how Last fed counts and the usual gap.
  const open = render(entries, "11:10", false, { info: true });
  const said = text(expansion(open.rendered));
  assert.ok(said.startsWith(`Started ${formatTime(at("10:00"), "UTC")}, finished ${formatTime(at("10:30"), "UTC")}. ${lastFedRule(voice)}`), said);
  assert.match(said, /Feeds lately: about every 3h 00m \(start to start\)\.$/);
  // The block's own button still says when it started.
  const block = elements(open.rendered).find((node) => /^Last feed started/.test(String(node.props["aria-label"] ?? "")));
  assert.equal(block?.props["aria-label"], `Last feed started 1h 10m ago, started ${formatTime(at("10:00"), "UTC")}. Finished 40m ago. Open that feed to fix it.`);
  // No finish: the line is just the details, and the clock says only when it started.
  const unended = [...history(), { ...bottle(1, "10:00", "10:15", 90), ended_at: null }];
  const bottleOnly = render(unended, "10:40", false, { info: true });
  assert.equal(text(detailsLine(bottleOnly.rendered)), "90 ml bottle");
  assert.ok(text(expansion(bottleOnly.rendered)).startsWith(`Started ${formatTime(at("10:00"), "UTC")}. Counted from`));
});

test("a bottle and a cluster keep their own details after the finish", () => {
  const bottled = render([...history(), bottle(1, "10:00", "10:15", 90)], "10:40");
  assert.equal(text(detailsLine(bottled.rendered)), "Finished 25m ago\u00a0· 90 ml bottle");
  // A bottle on its own is the whole feed: the care team's target, when the family typed one, sits beside it.
  const targeted = render([...history(), bottle(1, "10:00", "10:15", 50)], "10:40", false, { settings: { feed_target_ml: { min: 45, max: 60 } } });
  assert.equal(text(detailsLine(targeted.rendered)), "Finished 25m ago\u00a0· 50 ml bottle\u00a0· target 45–60 ml");
  const cluster = render([feed(1, [part("09:00", "09:15")]), feed(2, [part("09:30", "09:45", "R")]), feed(3, [part("10:00", "10:17")])], "10:17");
  const line = detailsLine(cluster.rendered);
  assert.equal(text(line), `Finished just now\u00a0· Cluster ${spanText(at("09:00"), at("10:17"), "UTC")}\u00a0· 3 feeds\u00a0· nursed ${minutesShort(47)}`);
  assert.ok(elements(line).some((node) => node.type === "button" && node.props["aria-label"] === "Cluster feeding: what it is"), "Cluster opens what cluster feeding is");
});

test("separate entries joined by a short break explain why the earlier start remains", () => {
  const result = render([feed(1, [part("10:00", "10:05")]), feed(2, [part("10:09", "10:17", "R")])], "10:17");
  assert.match(result.text, /Short breaks under 10m count as one feed\./);
  assert.match(result.text, /Last feed started17m ago/);
  assert.match(result.text, /Finished just now/);
  const separate = render([feed(1, [part("10:00", "10:05")]), feed(2, [part("10:15", "10:17", "R")])], "10:17");
  assert.doesNotMatch(separate.text, /Short breaks/);
  assert.equal(separate.summary.lastFed?.at, at("10:15"));
});

test("adjusted long-feed anchors remain Last fed while their finish is explicit", () => {
  const long = render([feed(1, [part("08:00", "08:05"), part("08:05", "10:17", "B")])], "10:17");
  assert.equal(long.summary.lastFed?.rule, "long");
  assert.match(long.text, /Last fed40m ago/);
  assert.match(long.text, /Finished just now/);
  assert.doesNotMatch(long.text, /Last feed started/);
  const side = render([feed(1, [part("08:00", "08:05"), part("08:05", "08:10", "R"), part("08:10", "10:17")])], "10:17");
  assert.equal(side.summary.lastFed?.rule, "side");
  assert.match(side.text, /Finished just now/);
  assert.doesNotMatch(side.text, /Last feed started/);
});

test("Last fed on a bottle feed with later bottles adds them up and says each, and opens its first bottle", () => {
  // The invented plan's night feed, Pump + bottle (plan feed p1f3): 30 ml of pumped milk, then 20 ml of formula to
  // finish, each logged from the card with no end; a target of 50–70 ml. feed.ts counts one feed: the second is more of it.
  const first = { ...bottle(1, "10:22", "10:22", 30, { milk: "breastmilk", plan: "p1f3" }), ended_at: null };
  const finish = { ...bottle(2, "10:35", "10:35", 20, { milk: "formula", plan: "p1f3" }), ended_at: null };
  const entries = [first, finish];
  assert.deepEqual([...sameFeedBottleIds(entries, new Date(at("10:40")))], [2]);
  const settings = { feed_target_ml: { min: 50, max: 70 } };
  const opened: unknown[] = [];
  const result = render(entries, "10:40", false, { settings, more: [finish], open: (sheet) => opened.push(sheet) });
  const line = detailsLine(result.rendered);
  assert.equal(text(line), "50 ml bottle (30 ml breast milk + 20 ml formula) · target 50–70 ml");
  assert.match(result.text, /Last feed started18m ago/);
  // A narrow line breaks between the bottles, never between an amount and its unit.
  const unbroken = elements(line).filter((node) => /whitespace-nowrap/.test(classes(node))).map(text);
  for (const piece of ["50 ml bottle", "(30 ml breast milk", "+ 20 ml formula)"]) assert.ok(unbroken.some((t) => t.startsWith(piece)), `"${piece}" stays on one line`);
  // The whole block opens the feed's first bottle.
  const block = elements(result.rendered).find((node) => node.type === "button" && /^Last feed started/.test(String(node.props["aria-label"] ?? "")));
  (block?.props.onClick as () => void)();
  // (Made inside the card's context, so compared field by field.)
  assert.equal(opened.length, 1);
  const sheet = opened[0] as { kind: string; entry: EntryOf<"feed"> };
  assert.equal(sheet.kind, "feed");
  assert.equal(sheet.entry, first);
  // A bottle on its own reads as before; with an amount not said, no total that would read short.
  assert.equal(text(detailsLine(render([first], "10:40", false, { settings }).rendered)), "30 ml bottle · target 50–70 ml");
  const unsaid = { ...finish, data: { method: "bottle" as const, milk: "formula" as const, plan: "p1f3" } };
  const unsaidLine = detailsLine(render([first, unsaid], "10:40", false, { more: [unsaid] }).rendered);
  assert.equal(text(unsaidLine), "bottle (30 ml breast milk + formula)");
  // The info button keeps to the last bottle's words, so a wrap never leaves it alone on a line.
  const keeper = elements(unsaidLine)
    .filter((x) => /whitespace-nowrap/.test(classes(x)) && elements(x).some((n) => n.props["aria-label"] === "How this is counted"))
    .at(-1);
  assert.equal(keeper && text(keeper), "+ formula)");
  assert.deepEqual(bottleFeedWords([first, finish], "us"), ["1.69 oz bottle", "(1.01 oz breast milk", "+ 0.68 oz formula)"]);
});

test("with this phone's amounts both ways, Last fed says a bottle and its target in ml and oz, the phone's units first", () => {
  setVolumesBoth(true);
  try {
    // The fixture's phone reads metric: ml first, oz in brackets.
    const targeted = render([...history(), bottle(1, "10:00", "10:15", 60)], "10:40", false, { settings: { feed_target_ml: { min: 50, max: 70 } } });
    assert.equal(text(detailsLine(targeted.rendered)), "Finished 25m ago · 60 ml (2.03 oz) bottle · target 50–70 ml (1.69–2.37 oz)");
  } finally {
    setVolumesBoth(false);
  }
  // Off again, exactly as before.
  const plain = render([...history(), bottle(1, "10:00", "10:15", 60)], "10:40", false, { settings: { feed_target_ml: { min: 50, max: 70 } } });
  assert.equal(text(detailsLine(plain.rendered)), "Finished 25m ago · 60 ml bottle · target 50–70 ml");
});

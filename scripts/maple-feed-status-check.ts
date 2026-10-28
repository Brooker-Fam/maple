import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { feedClusters, lastFedAnchor, minutesShort, nursingRuns, spanText, typicalFeedGapMin } from "../src/lib/maple/feed";
import { formatRelative, formatTime } from "../src/lib/maple/time";
import type { EntryOf, Segment } from "../src/lib/maple/types";

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
const source = ts.createSourceFile("StatusCard.tsx", readFileSync("src/components/maple/StatusCard.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const noop = () => {};
const at = (clock: string) => `2026-01-02T${clock}:00.000Z`;
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

function render(entries: EntryOf<"feed">[], clock: string, sleeping = false) {
  const now = new Date(at(clock));
  const runs = nursingRuns(entries, now);
  const lastFed = lastFedAnchor(entries, now, runs);
  const summary = {
    lastFed, lastFeed: entries.at(-1), next: null, cluster: feedClusters(runs).at(-1), born: false,
    active: sleeping ? [{ kind: "sleep", started_at: at(clock) }] : [],
  };
  const helpers = { isSide: (side: unknown) => side === "L" || side === "R", SIDE_NAME: { L: "Left", R: "Right" } };
  const card = fn<() => Element>("StatusCard", {
    useMaple: () => ({ state: { entries, baby: { timezone: "UTC" }, me: { email: "synthetic@example.test" } }, summary, log: noop, memberLabel: noop, readOnly: false, units: "metric", isNight: () => false }),
    useVoice: () => ({}), useSheets: () => ({ open: noop }), useNow: () => now, useState: () => [false, noop], useClusterInfo: () => ({ open: noop, sheet: null }),
    DEFAULT_TZ: "UTC", typicalFeedGapMin, formatRelative, formatTime, minutesShort, spanText, ts: (entry: { started_at: string }) => Date.parse(entry.started_at), since: String,
    sidesLabel: fn("sidesLabel", helpers), roughGap: fn("roughGap", {}),
    cx: (...classes: unknown[]) => classes.filter(Boolean).join(" "), tone: {}, DETAIL_COLOR: {}, KIND_COLOR: {},
    Icon: "Icon", NextSide: "NextSide", Since: "Since", AnimatePresence: "AnimatePresence", motion: { p: "p" },
  });
  const rendered = card();
  return { rendered, text: text(rendered), summary };
}

test("a feed finished now distinguishes its start from its finish, including on a short screen with a sleep timer", () => {
  const result = render([feed(1, [part("10:00", "10:17")])], "10:17", true);
  assert.match(result.text, /Last feed started17m ago/);
  assert.match(result.text, /Finished just now/);
  const finished = elements(result.rendered).find((node) => node.type === "p" && text(node) === "Finished just now");
  assert.ok(finished);
  assert.doesNotMatch(String(finished.props.className), /hidden/);
  assert.equal(result.summary.lastFed?.at, at("10:00"));
  const older = render([feed(1, [part("10:00", "10:17")])], "10:22");
  assert.match(older.text, /Finished 5m ago/);
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

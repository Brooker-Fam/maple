import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { checkLogSwitches } from "../../src/lib/maple/validate";

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
const noop = () => {};
const source = (file: string) => ts.createSourceFile(file, readFileSync(`src/components/maple/${file}.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(file: string, predicate: (node: ts.Node) => boolean) {
  const src = source(file);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (predicate(node)) found = node; else ts.forEachChild(node, visit); };
  visit(src);
  assert.ok(found, `Missing executable fragment in ${file}`);
  return found.getText(src);
}
function evaluate<T>(code: string, context: Record<string, unknown> = {}): T {
  const js = ts.transpileModule(`(${code.replace(/^export (default )?/, "")})`, { compilerOptions: { target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React, jsxFactory: "h", jsxFragmentFactory: "Fragment" } }).outputText;
  return runInNewContext(js, { h, Fragment: "fragment", ...context }) as T;
}
function fn<T>(file: string, name: string, context: Record<string, unknown> = {}) {
  return evaluate<T>(find(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name), context);
}
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("children" in node)) return [];
  const el = node as Element;
  return [el, ...el.children.flatMap(elements)];
}
const switches = fn<(baby: { settings: Record<string, unknown> }) => { nursing: boolean; bottles: boolean; pumping: boolean }>("MoreSheet", "logSwitches");
const formula = { feeding_methods: { nursing: false, pumping: false, formula: true }, feeds_bottle: true, track_pump: false };

test("feeding display follows onboarding intent and a validated Family override, retaining legacy defaults", () => {
  assert.equal(switches({ settings: formula }).nursing, false);
  assert.equal(switches({ settings: {} }).nursing, true);
  assert.equal(switches({ settings: { ...formula, track_nursing: true } }).nursing, true);
  assert.equal(switches({ settings: { track_nursing: false } }).nursing, false);
  checkLogSwitches({ track_nursing: true });
  checkLogSwitches({ track_nursing: null });
  assert.throws(() => checkLogSwitches({ track_nursing: "false" }));
});

function dock(settings: Record<string, unknown>, active: boolean) {
  const feed = { id: 9, kind: "feed", data: { method: "breast" } };
  const render = fn<() => Element>("Dock", "Dock", {
    useMaple: () => ({ state: { baby: { settings, timezone: "UTC" }, entries: [], me: { email: "test@example.invalid" } }, summary: { active: active ? [feed] : [], age: { dayOfLife: 5 } }, now: () => new Date(), units: "metric" }),
    useBabyWords: () => ({ she: "they" }), useSheets: () => ({ open: noop }), useTimerActions: () => ({}), useNow: () => new Date(), useNightActive: () => false,
    useState: (value: unknown) => [value === null ? {} : value, noop], useRef: (value: unknown) => ({ current: value }), useEffect: noop, useHoldTimerToasts: noop,
    useCooldowns: () => [{}, noop], useStillGoing: () => ({}), timerNumbers: () => ({ parts: [{}], side: "L", paused: false }), isTracked: () => true,
    logSwitches: switches, createPortal: (children: Element) => children, other: () => "R", SIDE_NAME: { L: "Left", R: "Right" }, SIDE_COLOR: {}, SWITCH_STYLE: { R: {} }, TILE: {},
    Tile: "Tile", CareStrip: "CareStrip", MoreSheet: "MoreSheet", AnimatePresence: "AnimatePresence", motion: { div: "div", button: "button" }, Icon: "Icon", cx: (...x: unknown[]) => x.join(" "),
  });
  return elements(render()).filter((node) => node.type === "Tile");
}

test("the rendered dock hides idle nursing for formula-only but keeps active controls and legacy tiles", () => {
  const formulaTiles = dock(formula, false);
  assert.equal(formulaTiles.some((node) => node.props.id === "L" || node.props.id === "R"), false);
  assert.equal(formulaTiles.find((node) => node.props.id === "bottle")?.props.span, 6);
  const running = dock(formula, true).map((node) => node.props.id);
  assert.ok(running.includes("pause") && running.includes("done"));
  const legacy = dock({}, false).map((node) => node.props.id);
  assert.ok(legacy.includes("L") && legacy.includes("R") && legacy.includes("bottle"));
});

function legend(arcs: { lane: string }[], settings = formula) {
  const call = find("DayDial", (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "Legend");
  const props = evaluate<Element>(call, { Legend: "Legend", pal: {}, night: false, state: { baby: { settings } }, logSwitches: switches, arcs, brackets: [] }).props;
  const render = fn<(props: Record<string, unknown>) => Element>("DayDial", "Legend", { cx: (...x: unknown[]) => x.join(" "), DROPLET_PATH: "", Icon: "Icon", LEGEND_STOOLS: [], tone: {} });
  return JSON.stringify(render(props));
}

test("the rendered dial omits unused nursing labels but retains the key for historical nursing", () => {
  assert.doesNotMatch(legend([]), /"Left"|"Right"/);
  assert.match(legend([{ lane: "feed" }]), /"Left"/);
  assert.match(legend([{ lane: "feed" }]), /"Right"/);
  assert.match(legend([], {} as typeof formula), /"Left"/);
});

test("the Family nursing toggle saves the override used by Today", async () => {
  const requests: { path: string; body: string }[] = [];
  const setter = find("FamilyTab", (node) => ts.isVariableDeclaration(node) && node.name.getText() === "setSetting");
  const setSetting = evaluate<(key: string, value: boolean) => Promise<void>>(setter.slice(setter.indexOf("=") + 1), { setToggles: noop, api: async (path: string, init: { body: string }) => { requests.push({ path, body: init.body }); }, refresh: async () => {}, toast: noop });
  const toggle = find("FamilyTab", (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "Toggle" && node.attributes.properties.some((prop) => ts.isJsxAttribute(prop) && prop.name.getText() === "label" && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === "Nursing"));
  const rendered = evaluate<Element>(toggle, { Toggle: "Toggle", toggles: {}, baby: { settings: formula }, logSwitches: switches, setSetting });
  assert.equal(rendered.props.checked, false);
  (rendered.props.onChange as (value: boolean) => void)(true);
  await Promise.resolve();
  assert.equal(requests[0]?.path, "/api/maple/baby");
  const settings = JSON.parse(requests[0].body).settings;
  assert.deepEqual(settings, { track_nursing: true });
  assert.equal(switches({ settings: { ...formula, ...settings } }).nursing, true);
});

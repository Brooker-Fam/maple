import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { build } = require("esbuild");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = ts.createSourceFile("mcp-tools.ts", await readFile(path.join(root, "src/lib/maple/mcp-tools.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["targetsJson", "talliesJson", "todayLine", "tallyLines", "dailySummaryResult", "gapStats"];
const declarations = names.map((name) => source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
const pumpImports = source.statements.filter((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "./pump-summary").map((node) => node.getText(source));
const compiled = await build({
  stdin: { loader: "ts", resolveDir: path.join(root, "src/lib/maple"), contents: `
    import { statsFor, dailyStats, isVitaminD } from "./insights";
    import { nursingRuns } from "./feed";
    import { addDays, babyAge, dayBounds, dayKey, startOfDay, formatDayLabel, formatDuration } from "./time";
    import { formatVolumeBoth } from "./units";
    import { voiceFor } from "./voice";
    ${pumpImports.join("\n")}
    const HOUR = 3600000, MIN = 60000;
    const ts = (entry) => Date.parse(entry.started_at);
    const durText = (sec) => sec < 60 ? "0m" : formatDuration(sec);
    const plural = (n, word, many = word + "s") => n + " " + (n === 1 ? word : many);
    const round1 = (n) => Math.round(n * 10) / 10;
    const voiceOf = (ctx) => voiceFor(99, ctx.baby);
    const lastNightWindow = (ctx) => ({ from: new Date(ctx.now.getTime() - 12 * HOUR) });
    const lastNight = () => ({ line: "", json: {} });
    const doctorQuestions = async () => [];
    const momSummary = async () => null;
    const ok = (text, json) => ({ text, json });
    let records = [];
    const listEntries = async (_family, options) => options.kinds ? [] : records;
    ${declarations.join("\n")}
    module.exports = { talliesJson, todayLine, tallyLines, dailySummaryResult, statsFor, setRecords: (value) => { records = value; } };
  ` },
  bundle: true, write: false, platform: "node", format: "cjs", tsconfig: path.join(root, "tsconfig.json"),
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const api = module.exports;
const now = new Date("2026-10-28T13:30:00.000Z");
const ctx = { now, tz: "America/New_York", fam: { familyId: 99 }, baby: { id: 99, name: "River", sex: null, born_at: null, settings: {} } };
let failures = 0;
for (const [name, data, duration, extra] of [
  ["unknown", {}, true, false], ["zero", { total_ml: 0 }, true, false],
  ["positive", { total_ml: 3 }, false, false], ["partial", { total_ml: 60 }, true, true],
]) {
  const entries = [{ id: 901, kind: "pump", data, started_at: "2026-10-28T12:00:00.000Z", ended_at: duration ? "2026-10-28T12:20:00.000Z" : null, active: false }];
  if (extra) entries.push({ id: 902, kind: "pump", data: {}, started_at: "2026-10-28T11:00:00.000Z", ended_at: null, active: false });
  const today = api.statsFor(entries, new Date("2026-10-28T04:00:00Z"), new Date("2026-10-29T04:00:00Z"), "2026-10-28", now);
  const summary = { today, last24h: today, targets: null, age: null };
  const expectedVolume = name === "unknown" ? null : name === "zero" ? "0 oz (0 ml)" : name === "positive" ? "0.1 oz (3 ml)" : "2.03 oz (60 ml)";
  const textCheck = (text) => {
    assert.match(text, extra ? /2 sessions · 20m/ : duration ? /1 session · 20m/ : /1 session/);
    assert.match(text, name === "unknown" ? /Amount not logged/ : new RegExp(expectedVolume.replace(/[().]/g, "\\$&")));
    if (extra) assert.match(text, /1 without amount/);
    if (!duration) assert.doesNotMatch(text, /0m|0s/);
  };
  const jsonCheck = (json) => {
    assert.equal(json.pump_sessions, extra ? 2 : 1);
    assert.equal(json.pump_measured_sessions, name === "unknown" ? 0 : 1);
    assert.equal(json.pump_duration_logged, duration ? "20m" : null);
    assert.equal(json.pumped, expectedVolume);
  };
  api.setRecords(entries);
  for (const [surface, run] of [
    ["status JSON", () => jsonCheck(api.talliesJson(summary).today)],
    ["today text", () => textCheck(api.todayLine(summary))],
    ["pump write text", () => textCheck(api.tallyLines(summary, new Set(["pump"]), {}, false).join("\n"))],
    ["daily summary", async () => { const result = await api.dailySummaryResult(ctx, 1); jsonCheck(result.json.per_day[0]); textCheck(result.json.paragraph); }],
  ]) {
    try { await run(); console.log(`PASS ${name} pumping in ${surface}`); }
    catch (error) { failures++; console.error(`FAIL ${name} pumping in ${surface}: ${error.message}`); }
  }
}
if (failures) process.exit(1);

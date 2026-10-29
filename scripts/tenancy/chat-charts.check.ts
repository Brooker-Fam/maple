/** Real chat tool reads against isolated, synthetic in-memory Postgres only. */
import { chatTools } from "../../src/lib/maple/chat/tools";
import type { ChatToolOutput } from "../../src/lib/maple/chat/types";
import { toolCopy } from "../../src/lib/maple/mcp-tools";
import { dayKey } from "../../src/lib/maple/time";
import type { Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

const now = new Date();
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();

async function entry(family: FamilySeed, kind: string, data: Record<string, unknown>, at: string, deleted = false) {
  await sql(
    `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [family.familyId, family.babyId, kind, at, data, family.owner, deleted ? now.toISOString() : null],
  );
}

function toolsFor(family: FamilySeed, role: Exclude<Role, "photos"> = "member", care = false, email = family[role]) {
  return chatTools({ email, role }, {
    fam: family.familyId, born: true, care,
    copy: toolCopy(family.familyId, { name: family.babyName, nickname: null, sex: null }, family.care?.person ?? null, family.tz),
  });
}

async function show(family: FamilySeed, kind: "activity" | "growth", role: Exclude<Role, "photos"> = "member", care = false) {
  const tool = toolsFor(family, role, care).show_chart;
  if (!tool?.execute) throw new Error("show_chart must execute for this member");
  const result = await tool.execute({ kind, days: 14, metric: "diapers" }, { toolCallId: "synthetic-chart", messages: [], context: undefined }) as ChatToolOutput;
  ok(result.ok, "chart read succeeded");
  eq(result.write, false, "chart is read only");
  if (!result.chart || result.chart.kind !== kind) throw new Error(`Expected ${kind} chart`);
  return result;
}

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  // Keep only this check's activity; the harness's unrelated moments/care remain.
  await sql("DELETE FROM maple_entries WHERE kind IN ('feed', 'diaper', 'sleep', 'growth')");
  await sql("UPDATE maple_babies SET birth_weight_g = $2 WHERE id = $1 AND family_id = $3", [alpha.babyId, 3100, alpha.familyId]);
  await sql("UPDATE maple_babies SET birth_weight_g = $2 WHERE id = $1 AND family_id = $3", [beta.babyId, 4200, beta.familyId]);
  await entry(alpha, "growth", { weight_g: 3300 }, ago(80));
  await entry(alpha, "growth", { weight_g: 3350 }, ago(79));
  // More than the chart's query limit, all newer than the true weigh-ins.
  for (let i = 0; i < 65; i++) await entry(alpha, "growth", { length_cm: 52 + i / 100 }, ago(70 - i));
  await entry(alpha, "growth", { weight_g: 7777 }, ago(1), true);
  await entry(alpha, "growth", { weight_g: 8888 }, ago(-24));
  await entry(beta, "growth", { weight_g: 4500 }, ago(2));
  const diaperAt = ago(2);
  await entry(alpha, "diaper", { pee: true, poop: false }, diaperAt);
  await entry(beta, "diaper", { pee: false, poop: true, color: "mustard" }, diaperAt);
  await entry(beta, "diaper", { pee: false, poop: true, color: "mustard" }, diaperAt);
  // A recent care row deliberately carries distinctive content; chart data never copies it.
  await sql("UPDATE maple_care_entries SET at = $1, data = $2 WHERE family_id = $3", [ago(0.1), { name: "CareOnlySentinel" }, alpha.familyId]);

  await test("growth reads actual scoped weights despite newer length-only measurements", async () => {
    const result = await show(alpha, "growth");
    const chart = result.chart!;
    if (chart.kind !== "growth") throw new Error("Expected growth");
    eq(chart.points.map((point) => point.weightG), [3100, 3300, 3350]);
    eq(chart.truncated, false);
    ok(chart.points.every((point) => typeof point.weightG === "number"), "stored grams stay numeric");
    ok(!JSON.stringify(chart).includes("4500"), "other family's weight excluded");
    ok(!JSON.stringify(chart).includes("7777"), "deleted weight excluded");
    ok(!JSON.stringify(chart).includes("8888"), "future weight excluded");
  });

  await test("the other family's growth chart contains only its own measurements", async () => {
    const chart = (await show(beta, "growth")).chart!;
    if (chart.kind !== "growth") throw new Error("Expected growth");
    eq(chart.points.map((point) => point.weightG), [4200, 4500]);
  });

  await test("activity uses each family's numeric daily summary and omits care fields", async () => {
    for (const family of [alpha, beta]) {
      const result = await show(family, "activity", "member", true);
      const chart = result.chart!;
      if (chart.kind !== "activity") throw new Error("Expected activity");
      const loggedDay = chart.days.find((day) => day.date === dayKey(new Date(diaperAt), family.tz));
      eq([loggedDay?.wet, loggedDay?.dirty], family === alpha ? [1, 0] : [0, 2]);
      eq(chart.days.length, 14);
      eq(chart.timezone, family.tz);
      const stored = JSON.stringify(result);
      ok(!stored.includes("CareOnlySentinel") && !stored.includes("Ibuprofen") && !stored.includes('"mom"'), "only baby chart fields returned even when care is open");
    }
  });

  await test("viewers can read baby charts in either family without gaining care or writes", async () => {
    for (const family of [alpha, beta]) {
      const tools = toolsFor(family, "viewer", true);
      ok(!tools.log_feed && !tools.log_mom_medicine, "viewer still has no write or mom tools");
      const growth = await show(family, "growth", "viewer", true);
      const activity = await show(family, "activity", "viewer", true);
      ok(!JSON.stringify([growth, activity]).includes("CareOnlySentinel"), "viewer charts omit care");
    }
  });

  await test("chart execution rechecks current family membership", async () => {
    const tool = toolsFor(alpha).show_chart;
    if (!tool?.execute) throw new Error("Missing chart tool");
    await sql("DELETE FROM maple_members WHERE family_id = $1 AND email = $2", [alpha.familyId, alpha.member]);
    let refused = false;
    try { await tool.execute({ kind: "growth" }, { toolCallId: "synthetic-removed-member", messages: [], context: undefined }); } catch { refused = true; }
    ok(refused, "a removed member cannot execute a retained chart tool");
  });

  done("chat-charts.check.ts");
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });

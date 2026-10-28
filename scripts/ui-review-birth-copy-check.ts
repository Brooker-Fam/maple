import assert from "node:assert/strict";
import { contextLine } from "../src/lib/maple/chat/prompt";
import { registrations } from "../src/lib/maple/chat/tools";
import type { Extra } from "../src/lib/maple/mcp-tools";
import { statusBlock } from "../src/lib/maple/onboarding/prompt";
import type { OnboardingView } from "../src/lib/maple/onboarding/steps";
import { getBaby } from "../src/lib/maple/store";
import { done, freshDb, seedFamilies, sql, test } from "./tenancy/harness";

const cases = [
  { label: "birth day", tz: "America/New_York", born: "2026-10-28T04:00:00Z", now: "2026-10-28T13:00:00Z", day: 1, date: "2026-10-28" },
  { label: "legacy noon after local midnight", tz: "America/New_York", born: "2026-10-27T16:00:00Z", now: "2026-10-28T04:30:00Z", day: 1, date: "2026-10-27" },
  { label: "short daylight-saving day", tz: "America/New_York", born: "2026-03-08T05:00:00Z", now: "2026-03-09T04:30:00Z", day: 1, date: "2026-03-08" },
  { label: "family date differs from UTC", tz: "Pacific/Honolulu", born: "2026-10-27T10:00:00Z", now: "2026-10-28T09:30:00Z", day: 1, date: "2026-10-27" },
  { label: "second estimated day", tz: "America/New_York", born: "2026-10-27T04:00:00Z", now: "2026-10-28T13:00:00Z", day: 2, date: "2026-10-27" },
];
let now = Date.parse(cases[0].now);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length) super(...(args as [string]));
    else super(now);
  }
  static now() { return now; }
}

function birthView(born: string, timezone: string, known: boolean): OnboardingView {
  return {
    familyId: 2, status: "onboarding", owner: true, done: { birth: "answered" }, next: "sex", canFinish: false, missing: [], modelSteps: 0,
    values: {
      you: { name: "Morgan", role_word: null }, timezone: { timezone, units: "us" },
      baby: { name: "River", nickname: null, sex: null, born_at: born, due_date: null, birth_time_known: known },
      feeding: null, invites: 0, care: null, pediatrician: null, notifications: null,
    },
  };
}

async function main() {
  await freshDb();
  const { beta } = await seedFamilies();
  globalThis.Date = FrozenDate as DateConstructor;
  const extra = {
    signal: new AbortController().signal, requestId: "synthetic-birth-copy",
    authInfo: { token: "synthetic", clientId: "synthetic", scopes: ["maple"], extra: { sub: `maple:${beta.owner}`, fam: beta.familyId, via: "chat", care: false } },
    sendNotification: async () => {}, sendRequest: async () => { throw new Error("No external requests in this check"); },
  } as unknown as Extra;
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const registration = registrations().all.find((r) => r.name === name);
    assert(registration);
    return registration.handler(args, extra);
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await callTool(name, args);
    assert(!result.isError, JSON.stringify(result));
    return result.structuredContent as Record<string, unknown>;
  };
  const setBirth = async (c: typeof cases[number], approximate: boolean) => {
    now = Date.parse(c.now);
    await sql("UPDATE maple_babies SET name = 'River', nickname = NULL, born_at = $2, timezone = $3, settings = $4 WHERE id = $1", [beta.babyId, c.born, c.tz, { birth_time_approx: approximate, show_alerts: true }]);
    return getBaby({ familyId: beta.familyId });
  };

  await test("chat context labels unknown birth age as an estimate across local day boundaries", async () => {
    for (const c of cases) {
      const baby = await setBirth(c, true);
      const line = contextLine({ now: new Date(), baby, name: "Morgan", role: "owner", familyId: beta.familyId });
      assert(line.includes(`Estimated Day ${c.day}`) && line.includes("time not recorded"), `${c.label}: ${line}`);
      assert(!/\d+ (?:minute|hour)s? old/.test(line), line);
    }
    const baby = await setBirth(cases[0], false);
    assert(contextLine({ now: new Date(), baby, name: "Morgan", role: "owner", familyId: beta.familyId }).includes("River is 9 hours old."));
  });

  await test("onboarding status omits the unknown birth clock and retains exact birth times", () => {
    const c = cases[0];
    const unknown = statusBlock(birthView(c.born, c.tz, false), new Date(c.now)).split("Already set: ")[1].split("\n")[0];
    assert(unknown.includes("born on Oct 28, 2026 (time not recorded)"), unknown);
    assert(!/\d+:\d+\s*[AP]M/.test(unknown), unknown);
    const exact = statusBlock(birthView(c.born, c.tz, true), new Date(c.now));
    assert.match(exact, /born 12:00\s*AM on Oct 28, 2026/);
  });

  await test("MCP status reports estimated age and a date-only birth when time is unknown", async () => {
    for (const c of cases) {
      await setBirth(c, true);
      const result = await tool("maple_status");
      const line = String(result.summary).split("\n")[0];
      assert(line.includes(`Estimated Day ${c.day}`) && line.includes("time not recorded"), `${c.label}: ${line}`);
      assert(!/\d+ (?:minute|hour)s? old/.test(line), line);
      assert.equal(result.born_local, c.date);
      assert.equal((result.age as { day_of_life: number }).day_of_life, c.day);
      assert(!/hour|minute/.test(JSON.stringify(result.age)), JSON.stringify(result.age));
    }
    await setBirth(cases[0], false);
    const exact = await tool("maple_status");
    assert(String(exact.summary).includes("River is 9 hours old (Day 1)."));
    assert.match(String(exact.born_local), /12:00\s*AM/);
  });

  await test("MCP doctor summary does not invent birth clocks or hourly ages", async () => {
    for (const c of cases) {
      await setBirth(c, true);
      const result = await tool("daily_summary");
      const first = String(result.paragraph).split(". ")[0];
      assert(first.includes(`Estimated Day ${c.day}`) && first.includes("time not recorded"), `${c.label}: ${first}`);
      assert(!/\d+ (?:minute|hour)s? old|born at \d/.test(first), first);
    }
    await setBirth(cases[0], false);
    assert.match(String((await tool("daily_summary")).paragraph), /River is 9 hours old \(born at 12:00\s*AM today/);
  });

  await test("unknown-time status age and aim share the existing estimated target day", async () => {
    for (const c of [cases[1], cases[0], ...cases.slice(2)]) {
      await setBirth(c, true);
      const estimated = await tool("maple_status");
      const age = estimated.age as { day_of_life: number };
      const targets = estimated.targets_24h as { day_of_life: number };
      assert.equal(age.day_of_life, targets.day_of_life, `${c.label}: status age and target day disagree`);
      assert(String(estimated.summary).includes(`Estimated Day ${targets.day_of_life} aim`), String(estimated.summary));
      await setBirth(c, false);
      const exact = await tool("maple_status");
      assert.deepEqual(estimated.targets_24h, exact.targets_24h, "Unknown-time wording does not change clinical targets");
      assert(String(exact.summary).includes(`(Day ${targets.day_of_life} aim:`), String(exact.summary));
      assert(!String(exact.summary).includes("Estimated Day"), String(exact.summary));
    }
  });

  await test("unknown-time write confirmations qualify the same unchanged target day", async () => {
    await setBirth(cases[1], true);
    const estimated = await tool("log_diaper", { diaper: "wet", allow_duplicate: true });
    assert(String(estimated.summary).includes("Estimated Day 1 aim"), String(estimated.summary));
    await setBirth(cases[1], false);
    const exact = await tool("log_diaper", { diaper: "wet", allow_duplicate: true });
    assert.deepEqual(estimated.targets_24h, exact.targets_24h);
    assert(String(exact.summary).includes("(Day 1 aim:"), String(exact.summary));
  });

  await test("MCP duplicate-birth feedback preserves the unknown time", async () => {
    await setBirth(cases[0], true);
    const result = await callTool("record_birth", { grams: 3300 });
    assert(result.isError);
    const text = result.content.flatMap((c) => c.type === "text" ? [c.text] : []).join("\n");
    assert(text.includes("time not recorded"), text);
    assert(!/12:00|T00:00/.test(text), text);
    assert.equal((await getBaby({ familyId: beta.familyId })).settings.birth_time_approx, true);
  });

  await test("MCP measurement-only birth correction keeps uncertainty in storage and confirmation", async () => {
    await setBirth(cases[0], true);
    const result = await tool("record_birth", { grams: 3300, replace_existing: true });
    const baby = await getBaby({ familyId: beta.familyId });
    assert(String(result.summary).includes("time not recorded"), String(result.summary));
    assert.equal(result.born_local, cases[0].date);
    assert.equal(result.born_iso, null);
    assert.equal(result.birth_time_known, false);
    assert.equal(baby.birth_weight_g, 3300);
    assert.equal(baby.born_at, new Date(cases[0].born).toISOString());
    assert.equal(baby.settings.birth_time_approx, true);
  });

  await test("MCP explicit birth-time correction clears uncertainty and restores exact-time copy", async () => {
    await setBirth(cases[0], true);
    const result = await tool("record_birth", { at: "2026-10-28T07:00:00-04:00", replace_existing: true });
    const baby = await getBaby({ familyId: beta.familyId });
    assert(!baby.settings.birth_time_approx, "An explicitly supplied birth clock must clear the unknown-time marker");
    assert.equal(baby.born_at, "2026-10-28T11:00:00.000Z");
    assert.match(String(result.summary), /born at 7:00\s*AM today/);
    assert.equal(result.born_iso, "2026-10-28T07:00:00-04:00");
    assert(String((await tool("maple_status")).summary).includes("River is 2 hours old (Day 1)."));
  });
  globalThis.Date = RealDate;
  done("ui-review-birth-copy");
}

main().catch((error) => { globalThis.Date = RealDate; console.error(error); process.exit(1); });

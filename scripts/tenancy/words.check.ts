import { NextRequest } from "next/server";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";

/**
 * What another family's assistants are told: the MCP endpoint's initialize
 * and tools/list, and the in-app chat's whole prompt (instructions and tool
 * text, through the same wiring the chat route uses), for a made-up family 2
 * token. None of it may carry family 1's names, people, pets or clock, and it
 * must carry family 2's own. Family 1's instructions stay word for word. The
 * model is a stand-in; nothing leaves the process.
 */

process.env.MCP_SECRET = "made-up-words-check-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-words-check-session";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const FAMILY_ONE_WORDS = [/Brooker/i, /Brittany/i, /Maple Jane/i, /\bzoe\b/i, /\bemmett\b/i, /\bbruce\b/i, /\bsapphire\b/i, /\bMatt\b/, /America\/New_York/];

function familyOneWordsIn(text: string): string[] {
  return FAMILY_ONE_WORDS.filter((re) => re.test(text)).map(String);
}

async function main() {
  const mcpRoute = await import("../../src/app/api/maple/[transport]/route");
  const { mintAccessToken } = await import("../../src/lib/mcp/auth");
  const { MAPLE_INSTRUCTIONS } = await import("../../src/lib/maple/mcp-tools");
  const { answerPost } = await import("../../src/lib/maple/chat/post");
  const { familyPostDeps } = await import("../../src/lib/maple/chat/family-deps");
  const { resolveFamily } = await import("../../src/lib/maple/family");
  const { memberFor } = await import("../../src/lib/maple/auth");
  const { percentileFor } = await import("../../src/lib/maple/growth");
  const { WHO_BOYS } = await import("../../src/lib/maple/who-boys");

  const mcp = async (sub: string, fam: number | undefined, body: unknown) => {
    const token = mintAccessToken({ sub, ...(fam === undefined ? {} : { fam }), scope: "maple", client_id: "made-up-client" });
    const res = await mcpRoute.POST(
      new NextRequest("http://localhost/api/maple/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      })
    );
    return { status: res.status, text: await res.text() };
  };
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "made-up", version: "1" } } };
  const toolsList = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const instructionsOf = (text: string) => {
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    return String((JSON.parse(line.replace(/^data: /, "")) as { result?: { instructions?: string } }).result?.instructions ?? "");
  };

  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const seed = await seedFamilies();
    const { alpha, beta } = seed;

    await test(`${shape}: a family-2 token's initialize names family 2's baby and clock, and none of family 1's words`, async () => {
      const r = await mcp(`maple:${beta.owner}`, 2, initialize);
      eq(r.status, 200);
      const text = instructionsOf(r.text);
      eq(familyOneWordsIn(text), [], "family 1's words");
      ok(/\bRo\b/.test(text) && text.includes("America/Los_Angeles"), `family 2's own: ${text.slice(0, 160)}`);
    });

    await test(`${shape}: a family-2 token's tools/list carries none of family 1's words`, async () => {
      const r = await mcp(`maple:${beta.owner}`, 2, toolsList);
      eq(r.status, 200);
      eq(familyOneWordsIn(r.text), [], "family 1's words");
      ok(r.text.includes("America/Los_Angeles") && /\bRo\b/.test(r.text), "family 2's baby and clock");
    });

    await test(`${shape}: family 1's token still gets the instructions word for word`, async () => {
      const r = await mcp(`maple:${alpha.owner}`, undefined, initialize);
      eq(instructionsOf(r.text), MAPLE_INSTRUCTIONS);
    });

    await test(`${shape}: a family-2 chat turn's prompt and tools carry none of family 1's words`, async () => {
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Made-up answer." },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } } },
            ] as never[],
          }),
        }),
      });
      const ctx = await resolveFamily(beta.owner, 2);
      const me = await memberFor({ familyId: 2 }, beta.owner);
      ok(ctx && me, "Beta's owner signs in");
      const waits: Promise<unknown>[] = [];
      const res = await answerPost(
        { threadId: "thread_words_made_up", message: { id: "x", role: "user", parts: [{ type: "text", text: "How many made-up diapers today?" }] } },
        me!,
        familyPostDeps(ctx!, me!, { model, modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: () => {}, waitUntil: (p) => void waits.push(p) })
      );
      await res.text();
      await Promise.all(waits);
      const call = model.doStreamCalls[0];
      ok(call, `the model ran (status ${res.status})`);
      const prompt = JSON.stringify(call.prompt);
      const tools = JSON.stringify(call.tools);
      eq(familyOneWordsIn(prompt), [], "the prompt");
      eq(familyOneWordsIn(tools), [], "the tools");
      ok(prompt.includes("America/Los_Angeles") && /\bRo\b/.test(prompt), "family 2's baby and clock in the prompt");
    });

    await test(`${shape}: a boy's weight reads against the WHO boys' standard over MCP, and no sex set reads none`, async () => {
      const born = Date.parse("2026-10-14T19:30:00Z");
      const age = (Date.now() - born) / 86_400_000;
      const grams = Math.round(WHO_BOYS.weight.rows[Math.round(age)][2] * 1000);
      const boys = percentileFor("weight", grams, age, "boys")!.label;
      ok(boys !== percentileFor("weight", grams, age, "girls")!.label, "the two standards differ here");
      const r = await mcp(`maple:${beta.owner}`, 2, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "log_growth", arguments: { grams, where: "home" } } });
      const label = /\\"weight\\":\{\\"percentile\\":[\d.]+,\\"label\\":\\"([^\\]+)\\"/.exec(r.text)?.[1];
      eq(label, boys, "the boys' percentile");
      await sql(`UPDATE maple_babies SET sex = NULL WHERE family_id = 2`);
      const none = await mcp(`maple:${beta.owner}`, 2, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "log_growth", arguments: { grams: grams + 10, where: "home", allow_duplicate: true } } });
      ok(!/\\"percentile\\":/.test(none.text), "no percentile with no sex set");
      await sql(`UPDATE maple_babies SET sex = 'male' WHERE family_id = 2`);
    });

    await test(`${shape}: family 2's moments keep none of family 1's presets`, async () => {
      const r = await mcp(`maple:${beta.owner}`, 2, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "log_moment", arguments: { milestone: "met-zoe", title: "Made-up moment" } } });
      eq(r.status, 200);
      const row = await sql(`SELECT data->>'milestone' AS m FROM maple_entries WHERE family_id = 2 AND kind = 'moment' ORDER BY id DESC LIMIT 1`);
      eq(row[0]?.m, "met-zoe", "saved as the family's own words");
      eq(familyOneWordsIn(r.text), [], "the reply");
    });
  }
  done("words.check.ts");
  // The chat turn's stream timers outlive the check; everything it awaited has settled.
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

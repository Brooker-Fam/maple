/** Family memories against synthetic Postgres: the store, the MCP tools, the Settings route and a chat turn, two families kept apart. */
import { NextRequest } from "next/server";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GET, POST } from "../../src/app/api/maple/memories/route";
import { sealSession, SESSION_COOKIE } from "../../src/lib/maple/auth";
import { familyPostDeps } from "../../src/lib/maple/chat/family-deps";
import { answerPost } from "../../src/lib/maple/chat/post";
import { registrations } from "../../src/lib/maple/chat/tools";
import { resolveFamily } from "../../src/lib/maple/family";
import { chatMemories } from "../../src/lib/maple/memory/chat";
import { FAMILY_ONE_COPY, type Extra } from "../../src/lib/maple/mcp-tools";
import {
  correctMemory,
  endMemory,
  forgetChatWords,
  forgetMemories,
  forgottenMessageIds,
  getMemory,
  listMemories,
  memoryContext,
  memoryState,
  MemoryRefused,
  saveMemory,
  setMemorySwitches,
  type MemoryActor,
} from "../../src/lib/maple/memory/store";
import { readMemoryInput, type MemoryList } from "../../src/lib/maple/memory/types";
import type { Member, Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

process.env.MCP_SECRET = "made-up-memories-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "made-up-memories-session-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

const { all } = registrations(FAMILY_ONE_COPY);
const handler = (name: string) => {
  const r = all.find((x) => x.name === name);
  if (!r) throw new Error(`no tool ${name}`);
  return r.handler;
};

type Who = Exclude<Role, "photos">;
type Call = { text: string; isError: boolean; sc: Record<string, unknown> };

function extraFor(family: FamilySeed, role: Who, opts: { via?: string; memoryEpoch?: number | null } = {}): Extra {
  return {
    signal: new AbortController().signal,
    requestId: "memory-check",
    authInfo: {
      token: "memory-check",
      clientId: "memory-check",
      scopes: ["maple"],
      extra: { sub: `maple:${family[role]}`, fam: family.familyId, via: opts.via ?? "claude", ...("memoryEpoch" in opts ? { memoryEpoch: opts.memoryEpoch } : {}) },
    },
    sendNotification: async () => {},
    sendRequest: async () => {
      throw new Error("unsupported");
    },
  } as unknown as Extra;
}

async function call(name: string, args: Record<string, unknown>, family: FamilySeed, role: Who = "member", opts: { via?: string; memoryEpoch?: number | null } = {}): Promise<Call> {
  const res: CallToolResult = await handler(name)(args, extraFor(family, role, opts));
  return { text: res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n"), isError: !!res.isError, sc: (res.structuredContent ?? {}) as Record<string, unknown> };
}

const settings = (family: FamilySeed): MemoryActor => ({ member: family.owner, via: "web", assistant: false, epoch: null });

/** The Settings page's request, signed in as `email` in `familyId`. */
async function route(method: "GET" | "POST", email: string, familyId: number, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new NextRequest("http://localhost:3000/api/maple/memories", {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(email, familyId))}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (method === "GET" ? GET(request) : POST(request));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const input = (fact: string, more: Record<string, unknown> = {}) => readMemoryInput({ kind: "feeding", fact, ...more }, { assistant: false });
const changeOf = (c: Call) => c.sc.memory_change as { status: string; id: string; revision: number; fact: string; previous_fact?: string };

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();

  await test("save_memory saves for the family, says so, and the same words again only confirm it", async () => {
    const first = await call("save_memory", { kind: "feeding", fact: "June takes Similac Pro-Sensitive formula.", reason: "Regular formula upset her stomach", source: "she does better on the sensitive one" }, alpha);
    ok(!first.isError, first.text);
    ok(/^Remembered m\d+ for the family: "June takes Similac Pro-Sensitive formula\."/.test(first.text), first.text);
    eq(changeOf(first).status, "saved");
    const again = await call("save_memory", { kind: "feeding", fact: "  june takes similac   pro-sensitive formula " }, alpha, "owner");
    ok(/^Already remembered as m\d+/.test(again.text), again.text);
    eq(changeOf(again).id, changeOf(first).id, "the same memory");
    const rows = await listMemories(alpha);
    eq(rows.length, 1, "one memory");
    eq([rows[0].said_by, rows[0].via, rows[0].source_words, rows[0].reason], [alpha.member, "claude", false, "Regular formula upset her stomach"]);
    eq(await listMemories(beta), [], "nothing in the other family");
  });

  await test("an assistant's placeholder or single-word memory is refused, and nothing is saved", async () => {
    for (const fact of ["null", "Yes", "None"]) {
      const r = await call("save_memory", { kind: "routine", fact }, alpha);
      ok(r.isError && /Nothing was saved/.test(r.text), `${fact}: ${r.text}`);
    }
    const bad = await call("save_memory", { kind: "routine", fact: "Avery does the 2am feed.", valid_from: "2026-11-10", valid_to: "2026-11-01" }, alpha);
    ok(bad.isError && /valid_to must be on or after valid_from/.test(bad.text), bad.text);
    eq((await listMemories(alpha)).length, 1);
  });

  await test("another family's memory reads as missing to every tool and to the store", async () => {
    const [mine] = await listMemories(alpha);
    const other = await call("correct_memory", { id: `m${mine.id}`, revision: mine.revision, fact: "Rowan takes regular formula." }, beta);
    ok(other.isError && /no such memory/.test(other.text), other.text);
    const archive = await call("archive_memory", { id: `m${mine.id}`, revision: mine.revision }, beta, "owner");
    ok(archive.isError && /no such memory/.test(archive.text), archive.text);
    const recall = await call("recall_memories", { id: `m${mine.id}` }, beta);
    ok(!recall.isError && /no memory/.test(recall.text) && !recall.text.includes("Similac"), recall.text);
    eq(await getMemory(beta, mine.id), null);
    eq((await getMemory(alpha, mine.id))?.status, "active", "untouched");
  });

  await test("correct_memory checks the revision, keeps what it leaves out, and keeps the old version as history", async () => {
    const [m] = await listMemories(alpha);
    const stale = await call("correct_memory", { id: `m${m.id}`, revision: m.revision + 5, fact: "June takes Similac 360 formula." }, alpha);
    ok(stale.isError && stale.text.includes(`now reads "June takes Similac Pro-Sensitive formula."`) && stale.text.includes(`revision ${m.revision}`), stale.text);
    const fixed = await call("correct_memory", { id: `m${m.id}`, revision: m.revision, fact: "June takes Similac 360 Total Care Sensitive formula." }, alpha);
    ok(!fixed.isError, fixed.text);
    eq(changeOf(fixed).previous_fact, "June takes Similac Pro-Sensitive formula.");
    const now = await listMemories(alpha);
    eq(now.length, 1, "one current");
    eq([now[0].fact, now[0].reason, now[0].predecessor_id], ["June takes Similac 360 Total Care Sensitive formula.", "Regular formula upset her stomach", m.id], "reason kept, old one linked");
    const old = await getMemory(alpha, m.id);
    eq([old?.status, old?.ended_by, old?.ended_via], ["superseded", alpha.member, "claude"]);
    const again = await call("correct_memory", { id: `m${m.id}`, revision: m.revision, fact: "June takes regular formula." }, alpha);
    ok(again.isError && /isn't current anymore \(it was corrected\)/.test(again.text), again.text);
  });

  await test("a correction that only changes dates keeps the same words as the new current version", async () => {
    const [m] = await listMemories(alpha);
    const dated = await call("correct_memory", { id: `m${m.id}`, revision: m.revision, fact: m.fact, review_on: "2026-12-01" }, alpha);
    ok(!dated.isError, dated.text);
    const [cur] = await listMemories(alpha);
    eq([cur.fact, cur.review_on, cur.reason], [m.fact, "2026-12-01", m.reason]);
    const cleared = await call("correct_memory", { id: `m${cur.id}`, revision: cur.revision, fact: cur.fact, clear: ["review_on", "reason"] }, alpha);
    ok(!cleared.isError, cleared.text);
    const [last] = await listMemories(alpha);
    eq([last.review_on, last.reason], [null, null], "cleared");
  });

  await test("a correction can't make two current memories say the same thing", async () => {
    const extra = await saveMemory(alpha, input("We use paced bottle feeding."), settings(alpha), { text: null, words: true });
    const [formula] = (await listMemories(alpha)).filter((m) => m.id !== extra.memory.id);
    const clash = await call("correct_memory", { id: `m${extra.memory.id}`, revision: extra.memory.revision, fact: formula.fact }, alpha);
    ok(clash.isError && clash.text.includes(`Another current memory already says that: m${formula.id}`), clash.text);
    eq((await getMemory(alpha, extra.memory.id))?.status, "active", "the one asked about is unchanged");
  });

  await test("resolve and archive end a memory, which recall shows only with history", async () => {
    const paced = (await listMemories(alpha)).find((m) => m.fact.startsWith("We use paced"))!;
    const done1 = await call("resolve_memory", { id: `m${paced.id}`, revision: paced.revision }, alpha, "owner");
    ok(!done1.isError && /^Marked m\d+ resolved/.test(done1.text), done1.text);
    eq((await getMemory(alpha, paced.id))?.status, "resolved");
    const current = await call("recall_memories", { query: "bottle" }, alpha);
    ok(!current.text.includes("paced"), current.text);
    const history = await call("recall_memories", { query: "bottle", include_history: true }, alpha);
    ok(history.text.includes("paced") && history.text.includes('"status":"resolved"'), history.text);
    const twice = await call("archive_memory", { id: `m${paced.id}`, revision: paced.revision + 1 }, alpha);
    ok(twice.isError && /isn't current anymore \(resolved\)/.test(twice.text), twice.text);
  });

  await test("recall finds a memory by a word with the same meaning, and reads one with its earlier versions", async () => {
    const found = await call("recall_memories", { query: "what did we say about her bottles?" }, alpha);
    ok(found.text.includes("Similac 360"), found.text);
    const [cur] = await listMemories(alpha);
    const one = await call("recall_memories", { id: `m${cur.id}` }, alpha, "viewer");
    ok(!one.isError && (one.sc.earlier_versions as unknown[]).length === 3, one.text);
  });

  await test("viewers read memories but every write is refused", async () => {
    const r = await call("save_memory", { kind: "sleep", fact: "June sleeps in the bassinet in her parents' room." }, alpha, "viewer");
    ok(r.isError && /viewer/.test(r.text), r.text);
    const [cur] = await listMemories(alpha);
    const a = await call("archive_memory", { id: `m${cur.id}`, revision: cur.revision }, alpha, "viewer");
    ok(a.isError && /viewer/.test(a.text), a.text);
    const read = await call("recall_memories", {}, alpha, "viewer");
    ok(!read.isError && read.text.includes("1 memory"), read.text);
  });

  await test("the chat's writes need the epoch their turn started with", async () => {
    const { epoch } = await memoryState(alpha);
    const none = await call("save_memory", { kind: "sleep", fact: "June sleeps swaddled with her arms out." }, alpha, "member", { via: "chat" });
    ok(none.isError && /couldn't be read for this message/.test(none.text), none.text);
    const stale = await call("save_memory", { kind: "sleep", fact: "June sleeps swaddled with her arms out." }, alpha, "member", { via: "chat", memoryEpoch: epoch - 1 });
    ok(stale.isError && /changed since this message arrived/.test(stale.text), stale.text);
    const fine = await call("save_memory", { kind: "sleep", fact: "June sleeps swaddled with her arms out." }, alpha, "member", { via: "chat", memoryEpoch: epoch });
    ok(!fine.isError, fine.text);
    const saved = (await listMemories(alpha)).find((m) => m.kind === "sleep")!;
    eq([saved.via, saved.said_by], ["chat", alpha.member]);
  });

  await test("with saving from chats off, assistants can't change memories but Settings can", async () => {
    await setMemorySwitches(alpha, { capture: false });
    const r = await call("save_memory", { kind: "routine", fact: "Blake does the 2am feed on weeknights." }, alpha);
    ok(r.isError && /turned off in Settings → Memories/.test(r.text), r.text);
    const [cur] = await listMemories(alpha);
    const a = await call("archive_memory", { id: `m${cur.id}`, revision: cur.revision }, alpha);
    ok(a.isError && /turned off/.test(a.text), a.text);
    const direct = await saveMemory(alpha, input("Blake does the 2am feed on weeknights.", { kind: "routine" }), settings(alpha), { text: "Blake does the 2am feed on weeknights.", words: true });
    eq(direct.status, "saved");
    const status = await call("maple_status", {}, alpha);
    ok(JSON.stringify(status.sc.family_memories).includes("Saving memories from chats is turned off"), JSON.stringify(status.sc.family_memories));
    await setMemorySwitches(alpha, { capture: true });
  });

  await test("connected apps get the current memories with maple_status; Maple's own chat doesn't", async () => {
    const forApp = await call("maple_status", {}, alpha);
    const mem = forApp.sc.family_memories as { memories: { fact: string; from: string }[] };
    ok(mem.memories.some((m) => m.fact.startsWith("June takes Similac 360")), JSON.stringify(mem));
    ok(mem.memories.some((m) => m.from === "Avery in Settings"), JSON.stringify(mem));
    ok(!JSON.stringify(mem).includes("paced"), "a resolved memory stays out");
    const forChat = await call("maple_status", {}, alpha, "member", { via: "chat", memoryEpoch: 0 });
    eq(forChat.sc.family_memories, undefined, "the chat has them with its instructions");
    const other = await call("maple_status", {}, beta);
    eq((other.sc.family_memories as { memories: unknown[] }).memories, [], "the other family has none");
  });

  await test("Muse and Grok are credited by name, and an older connection as an AI assistant", async () => {
    for (const [via, label] of [["muse", "Muse"], ["grok", "Grok"], ["mcp", "an AI assistant"]] as const) {
      const r = await call("save_memory", { kind: "routine", fact: `Saved through ${via}, a made-up routine.` }, beta, "member", { via });
      ok(!r.isError, r.text);
      const saved = (await listMemories(beta)).find((m) => m.fact === `Saved through ${via}, a made-up routine.`)!;
      eq(saved.via, via);
      ok(JSON.stringify((await call("recall_memories", { id: `m${saved.id}` }, beta)).sc).includes(`"from":"Finley in ${label}"`), label);
    }
  });

  await test("a memory whose last day passed stays listed but leaves the prompt, and recall says it ended", async () => {
    const past = await saveMemory(alpha, input("Wake June every 3 hours to eat until her weight check.", { valid_to: "2026-10-01" }), settings(alpha), { text: null, words: false });
    const ctx = await memoryContext(alpha, { now: new Date("2026-10-21T15:00:00Z"), tz: alpha.tz });
    ok(ctx.records.some((m) => m.id === past.memory.id), "still listed as current");
    const block = (await chatMemories(alpha, { threadId: alpha.threadId, viewer: false, members: [], now: new Date("2026-10-21T15:00:00Z"), tz: alpha.tz })).block;
    ok(!block.includes("Wake June") && block.includes("Similac 360"), block);
    const recall = await call("recall_memories", { query: "wake eat weight", include_history: true }, alpha);
    ok(recall.text.includes('"status":"ended"'), recall.text);
  });

  await test("with memory use off, nothing reads them, and saving still works", async () => {
    await setMemorySwitches(alpha, { use: false });
    const r = await call("recall_memories", {}, alpha);
    ok(r.isError && /turned off/.test(r.text), r.text);
    const status = await call("maple_status", {}, alpha);
    eq((status.sc.family_memories as { off?: boolean }).off, true);
    const chat = await chatMemories(alpha, { threadId: alpha.threadId, viewer: false, members: [], now: new Date(), tz: alpha.tz });
    ok(chat.block.startsWith("Family memories are turned off") && !chat.block.includes("Similac"), chat.block);
    const saved = await call("save_memory", { kind: "care_team", fact: "June's lactation consultant visits on Thursdays." }, alpha);
    ok(!saved.isError, saved.text);
    await setMemorySwitches(alpha, { use: true });
  });

  await test("deleting a member's chat history removes their quoted words, not the memory", async () => {
    await sql(`UPDATE maple_memories SET source_text = 'she sleeps swaddled with arms out', source_words = TRUE WHERE family_id = 1 AND kind = 'sleep'`);
    const before = await memoryState(alpha);
    await forgetChatWords(alpha, alpha.member);
    const sleep = (await listMemories(alpha)).find((m) => m.kind === "sleep")!;
    eq([sleep.fact, sleep.source_text, sleep.source_words], ["June sleeps swaddled with her arms out.", null, false]);
    const settingsRow = (await listMemories(alpha)).find((m) => m.via === "web" && m.kind === "routine")!;
    ok(settingsRow.source_text, "words typed in Settings stay");
    eq((await memoryState(alpha)).revision, before.revision + 1);
  });

  await test("Forget deletes a memory with every version of it, moves the epoch and the floor, and leaves the rest", async () => {
    const formula = (await listMemories(alpha)).find((m) => m.fact.includes("Similac 360"))!;
    const chainBefore = await sql(`SELECT COUNT(*)::int AS n FROM maple_memories WHERE family_id = 1 AND (fact ILIKE '%similac%')`);
    ok(chainBefore[0].n >= 4, `versions: ${chainBefore[0].n}`);
    const before = await memoryState(alpha);
    eq(await forgottenMessageIds(alpha, alpha.threadId), [], "no floor yet");
    const n = await forgetMemories(alpha, { id: formula.id });
    eq(n, chainBefore[0].n);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_memories WHERE family_id = 1 AND fact ILIKE '%similac%'`))[0].n, 0, "every version gone");
    const after = await memoryState(alpha);
    eq([after.epoch, after.revision], [before.epoch + 1, before.revision + 1]);
    eq(await forgottenMessageIds(alpha, alpha.threadId), [alpha.messageId], "the older chat message stays out of the model's window");
    eq(await forgottenMessageIds(beta, beta.threadId), [], "another family's chat is untouched");
    ok((await listMemories(alpha)).some((m) => m.kind === "sleep"), "the rest stays");
    eq(await forgetMemories(alpha, { id: formula.id }), 0, "forgetting it again changes nothing");
    eq((await memoryState(alpha)).epoch, after.epoch);
  });

  await test("a chat turn that started before a Forget can't save what it read", async () => {
    const { epoch } = await memoryState(alpha);
    await saveMemory(alpha, input("June's pediatrician is Dr. Example at Made-up Pediatrics.", { kind: "care_team" }), settings(alpha), { text: null, words: false });
    await forgetMemories(alpha, { all: true });
    const late = await call("save_memory", { kind: "care_team", fact: "June's pediatrician is Dr. Example at Made-up Pediatrics." }, alpha, "member", { via: "chat", memoryEpoch: epoch });
    ok(late.isError && /changed since this message arrived/.test(late.text), late.text);
    eq(await listMemories(alpha, { history: true }), [], "Forget all left nothing");
  });

  await test("store refusals carry the memory as it is now", async () => {
    const m = await saveMemory(beta, readMemoryInput({ kind: "routine", fact: "Finley gives Rowan his bath on Sundays." }, { assistant: false }), { member: beta.owner, via: "web", assistant: false, epoch: null }, { text: null, words: true });
    try {
      await endMemory(beta, { id: m.memory.id, revision: 9 }, "archived", { member: beta.owner, via: "web", assistant: false, epoch: null });
      throw new Error("no refusal");
    } catch (error) {
      ok(error instanceof MemoryRefused && error.code === "changed" && error.current?.fact === m.memory.fact, String(error));
    }
    try {
      await correctMemory(alpha, { id: m.memory.id, revision: m.memory.revision }, readMemoryInput({ kind: "routine", fact: "Someone else's change." }, { assistant: false }), settings(alpha), { text: null, words: true });
      throw new Error("no refusal");
    } catch (error) {
      ok(error instanceof MemoryRefused && error.code === "missing" && error.current === null, String(error));
    }
    eq((await getMemory(beta, m.memory.id))?.status, "active");
  });

  await test("Settings: anyone in the family reads, owners and members change, photos-only guests see nothing", async () => {
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, 'photos.alpha@example.com', 'photos', 'Pat', 'self', NOW())`);
    const added = await route("POST", alpha.member, 1, { action: "save", memory: { kind: "routine", fact: "Blake does the 2am feed on weeknights.", valid_to: "2026-12-31" } });
    eq(added.status, 200, JSON.stringify(added.json));
    const list = added.json as unknown as MemoryList;
    const m = list.records.find((r) => r.fact.startsWith("Blake does"))!;
    eq([m.via, m.said_by, m.source_words, list.canEdit], ["web", alpha.member, true, true]);
    const viewer = await route("GET", alpha.viewer, 1);
    eq([viewer.status, (viewer.json as unknown as MemoryList).canEdit, (viewer.json as unknown as MemoryList).records.length], [200, false, 1]);
    eq((await route("POST", alpha.viewer, 1, { action: "archive", id: m.id, revision: m.revision })).status, 403, "a viewer can't change one");
    eq((await route("GET", "photos.alpha@example.com", 1)).status, 403, "photos-only");
    ok(!((await route("GET", beta.owner, 2)).json as unknown as MemoryList).records.some((r) => r.id === m.id), "not on the other family's page");
    eq((await route("POST", beta.owner, 2, { action: "forget", id: m.id })).status, 200, "forgetting another family's id is a no-op");
    eq((await getMemory(alpha, m.id))?.fact, m.fact, "and changes nothing");
  });

  await test("Settings: an edit from an old revision gets 409 with the memory as it is now; bad input gets 400", async () => {
    const [m] = await listMemories(alpha);
    const ok1 = await route("POST", alpha.owner, 1, { action: "correct", id: m.id, revision: m.revision, memory: { kind: "routine", fact: "Blake does the 2am feed on weeknights and Saturdays." } });
    eq(ok1.status, 200);
    const stale = await route("POST", alpha.member, 1, { action: "correct", id: m.id, revision: m.revision, memory: { kind: "routine", fact: "Avery does the 2am feed." } });
    eq([stale.status, stale.json.code], [409, "changed"]);
    ok((stale.json.list as MemoryList).records.some((r) => r.fact.endsWith("and Saturdays.") && r.status === "active"), "the current list comes back");
    eq((await route("POST", alpha.owner, 1, { action: "save", memory: { kind: "nonsense", fact: "x y" } })).status, 400);
    eq((await route("POST", alpha.owner, 1, { action: "save", memory: { kind: "routine", fact: "Late.", valid_from: "2026-02-30" } })).status, 400, "not a real day");
    const off = await route("POST", alpha.owner, 1, { action: "switches", capture: false });
    eq((off.json as unknown as MemoryList).state.capture, false);
    await route("POST", alpha.owner, 1, { action: "switches", capture: true });
  });

  await test("a chat turn reads the memories on its newest message, not in its instructions, and its save lands as the member, via Maple chat", async () => {
    const prompts: string[] = [];
    let calls = 0;
    const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
    const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        if (calls === 0) {
          const system = options.prompt.filter((m) => m.role === "system");
          const users = options.prompt.filter((m) => m.role === "user");
          ok(!JSON.stringify(system).includes("<family_memories>"), "no family text in the instructions");
          ok(JSON.stringify(users[users.length - 1]).includes("[App] <family_memories>"), "the newest message carries them as [App] lines");
        }
        const chunks = calls++ === 0
          ? [{ type: "tool-call", toolCallId: "call_memory_1", toolName: "save_memory", input: JSON.stringify({ kind: "sleep", fact: "June naps best in the stroller in the afternoon.", source: "she only naps in the stroller after lunch" }) }, finish("tool-calls")]
          : [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Saved that for the family." }, { type: "text-end", id: "t" }, finish("stop")];
        return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] as never[] }) };
      },
    });
    const fam = await resolveFamily(alpha.owner, 1);
    const me: Member = { email: alpha.owner, role: "owner", display_name: "Avery", emoji: null, color: null };
    const waits: Promise<unknown>[] = [];
    const errors: Error[] = [];
    const deps = familyPostDeps(fam!, me, { model, modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: (e) => errors.push(e), waitUntil: (p) => waits.push(p) });
    const res = await answerPost({ threadId: "thread_memory_turn", message: { role: "user", parts: [{ type: "text", text: "She only naps in the stroller after lunch, remember that" }] } }, me, deps);
    await res.text();
    await Promise.all(waits);
    eq([res.status, errors.map((e) => e.message)], [200, []]);
    eq(calls, 2, "a tool step and a reply");
    ok(prompts[0].includes("<family_memories>") && prompts[0].includes("Blake does the 2am feed on weeknights and Saturdays."), "the memory block reached the model");
    ok(prompts[0].includes("The newest message's [App] lines list the current ones as family_memories"), "with the chat's own memory rules");
    const stored = await sql(`SELECT parts FROM maple_chat_messages WHERE family_id = 1 AND thread_id = 'thread_memory_turn' AND role = 'user'`);
    ok(!JSON.stringify(stored).includes("family_memories"), "the stored message doesn't keep them");
    const saved = (await listMemories(alpha)).find((m) => m.kind === "sleep" && m.fact.startsWith("June naps"))!;
    eq([saved.via, saved.said_by, saved.source_text, saved.source_words], ["chat", alpha.owner, "she only naps in the stroller after lunch", false]);
    const replies = await sql(`SELECT parts FROM maple_chat_messages WHERE family_id = 1 AND thread_id = 'thread_memory_turn' AND role = 'assistant'`);
    const part = (replies[0].parts as { type: string; output?: { memory?: { status: string; fact: string } } }[]).find((p) => p.type === "tool-save_memory");
    const card = part?.output?.memory as Record<string, unknown> | undefined;
    eq([card?.status, card?.kind, card?.fact, Object.keys(card ?? {}).sort()], ["saved", "sleep", "June naps best in the stroller in the afternoon.", ["fact", "kind", "status"]], "the chat card's data, no id");
  });

  await test("after a Forget, the chat no longer reads the messages from before it", async () => {
    const prompts: string[] = [];
    const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Okay." }, { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }] as never[] }) };
      },
    });
    const stroller = (await listMemories(alpha)).find((m) => m.fact.startsWith("June naps"))!;
    await forgetMemories(alpha, { id: stroller.id });
    await new Promise((r) => setTimeout(r, 5));
    const fam = await resolveFamily(alpha.owner, 1);
    const me: Member = { email: alpha.owner, role: "owner", display_name: "Avery", emoji: null, color: null };
    const waits: Promise<unknown>[] = [];
    const deps = familyPostDeps(fam!, me, { model, modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: () => {}, waitUntil: (p) => waits.push(p) });
    const res = await answerPost({ threadId: "thread_memory_turn", message: { role: "user", parts: [{ type: "text", text: "What do you know about her naps?" }] } }, me, deps);
    await res.text();
    await Promise.all(waits);
    ok(!prompts[0].includes("stroller"), "neither the memory nor the message it came from reaches the model");
    ok(prompts[0].includes("What do you know about her naps?"), "the new message does");
    const visible = await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_messages WHERE family_id = 1 AND thread_id = 'thread_memory_turn'`);
    eq(visible[0].n, 4, "the phone still shows every message");
  });

  done("memories.check.ts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

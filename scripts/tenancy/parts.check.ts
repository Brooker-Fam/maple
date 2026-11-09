import { z } from "zod";
import type { NextRequest } from "next/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { done, eq, freshDb, ok, seedFamilies, sha256, sql, test, type Seed, type Shape } from "./harness";

/**
 * The parts an owner can turn down for one person below their role
 * (access.ts PARTS: the questions for the doctor, moments, the chat): the
 * rules, then each part end to end on both schema shapes: People settings'
 * routes, the app's state, entries, export and photos, Siri's reads, the MCP
 * and the chat's tools, the chat's threads, invites, and family Beta (2)
 * never reaching family Alpha's (1) people. Made-up people only; nothing
 * leaves this process.
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.MAPLE_ALLOWED_EMAILS;
delete process.env.MAPLE_ADMIN_FAMILY_ID;
delete process.env.MAPLE_BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.MCP_SECRET = "made-up-parts-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-parts-session-secret";

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (args: unknown, extra: unknown) => Promise<Result>;

const QUESTION = "Is the made-up rash on her cheek okay?";
const NOTE = "Made-up hiccups after a feed";

async function main() {
  const { NextRequest } = await import("next/server");
  const access = await import("../../src/lib/maple/access");
  const auth = await import("../../src/lib/maple/auth");
  const { registerMapleTools } = await import("../../src/lib/maple/mcp-tools");
  const { chatTools } = await import("../../src/lib/maple/chat/tools");
  const { chatStream, threadAccess } = await import("../../src/lib/maple/chat/history");
  const { lockThread, releaseThread } = await import("../../src/lib/maple/chat/store");
  const { toolCopy } = await import("../../src/lib/maple/mcp-tools");
  const { joinByInvite } = await import("../../src/lib/maple/family/create");
  const routes = {
    members: await import("../../src/app/api/maple/members/route"),
    invites: await import("../../src/app/api/maple/invites/route"),
    state: await import("../../src/app/api/maple/state/route"),
    entries: await import("../../src/app/api/maple/entries/route"),
    restore: await import("../../src/app/api/maple/entries/restore/route"),
    exportCsv: await import("../../src/app/api/maple/export/route"),
    photo: await import("../../src/app/api/maple/photo/route"),
    upload: await import("../../src/app/api/maple/upload/route"),
    chat: await import("../../src/app/api/maple/chat/route"),
    quick: await import("../../src/app/api/maple/quick/route"),
  };

  const handlers = new Map<string, { parse: (a: unknown) => unknown; run: Handler }>();
  registerMapleTools({
    registerTool: (name: string, cfg: { inputSchema: z.ZodRawShape }, run: Handler) => void handlers.set(name, { parse: (a) => z.object(cfg.inputSchema).parse(a), run }),
  } as unknown as McpServer);
  /** One MCP tool call as `who` in family `fam` (via a connector unless `via` says the chat). */
  const tool = async (who: string, fam: number, name: string, args: unknown = {}, via = "claude") => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no tool ${name}`);
    const res = await h.run(h.parse(args), { authInfo: { token: "t", clientId: "c", scopes: ["maple"], extra: { sub: `maple:${who}`, fam, via } } });
    const text = res.content.map((c) => c.text ?? "").join("\n");
    const json = text.includes("\n{") ? (JSON.parse(text.slice(text.indexOf("\n{") + 1)) as Record<string, unknown>) : {};
    return { error: res.isError === true, text, json };
  };

  const cookie = (id: string, fam: number) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, fam))}` });
  const call = async (handler: (r: NextRequest) => Promise<Response>, path: string, as: { id: string; fam: number }, init: { method?: string; body?: unknown } = {}) => {
    const res = await handler(new NextRequest(new URL(path, "http://localhost:3000"), {
      method: init.method ?? "GET",
      headers: { ...cookie(as.id, as.fam), "content-type": "application/json", "x-real-ip": "203.0.113.11" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body, text };
  };
  // JSONB keeps its own key order, so compare parts as sorted objects.
  const sorted = (v: unknown) => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v ?? null);
  const partsOf = async (email: string, fam = 1) => sorted((await sql(`SELECT parts FROM maple_members WHERE family_id = $1 AND email = $2`, [fam, email]))[0]?.parts ?? null);

  // ── the rules (access.ts) ──

  await test("a role is the most each part opens: owners everything, photos-only guests their moments and nothing more", () => {
    const lv = (role: "owner" | "member" | "viewer" | "photos", parts?: Record<string, string>) =>
      access.PARTS.map((p) => access.partLevelOf({ role, parts: parts as never }, p));
    eq(lv("owner", { doctor: "none", chat: "none" }), ["log", "log", "log"], "owners keep every part whatever a row says");
    eq(lv("member"), ["log", "log", "log"], "members: everything by default");
    eq(lv("viewer"), ["view", "view", "view"], "viewers: read only");
    eq(lv("photos"), ["none", "view", "none"], "photos-only: shared moments only");
    eq(lv("member", { doctor: "none", moments: "view", chat: "view" }), ["none", "view", "view"], "turned down");
    eq(lv("viewer", { doctor: "log" }), ["view", "view", "view"], "never above the role");
    eq(lv("photos", { moments: "none" }), ["none", "view", "none"], "photos-only guests keep their moments");
    eq(access.partChoices("member", "doctor"), ["none", "view", "log"]);
    eq(access.partChoices("viewer", "chat"), ["none", "view"]);
    eq([access.partChoices("photos", "moments"), access.partChoices("owner", "doctor")], [["view"], ["log"]], "nothing to choose");
  });

  await test("only levels below the role are stored, a part left out stays, and bad input reads as nothing", () => {
    eq(access.applyPartsChange("member", null, { doctor: "none", chat: "log" }), { doctor: "none" }, "the role's own stores as nothing");
    eq(access.applyPartsChange("member", { doctor: "none", chat: "view" }, { doctor: "log" }), { chat: "view" }, "back to the role's own; the other part stays");
    eq(access.applyPartsChange("member", { doctor: "none" }, { doctor: null }), null, "null puts the role's own back");
    eq(access.applyPartsChange("viewer", { chat: "view" }, { doctor: "none" }), { chat: "view", doctor: "none" }, "a level kept from before a role change stays");
    eq(access.applyPartsChange("owner", { doctor: "none" }, {}), null, "owners store nothing");
    eq(access.parsePartsChange({ doctor: "none", moments: null }), { doctor: "none", moments: null });
    eq([access.parsePartsChange({ medicines: "none" }), access.parsePartsChange({ doctor: "hidden" }), access.parsePartsChange([])], [null, null, null], "unknown parts and levels");
    eq(access.parseParts('{"doctor":"none","x":"y","chat":"nope"}'), { doctor: "none" }, "a row keeps known parts and levels only");
    ok(access.partLevelProblem("viewer", "doctor", "log"), "a viewer can't add questions");
    ok(access.partLevelProblem("photos", "moments", "none"), "photos-only guests always see the shared moments");
    eq(access.partLevelProblem("member", "chat", "view"), null);
    eq(access.partLines({ role: "member", parts: { doctor: "none", chat: "view" } }), ["Questions for the doctor: hidden", "Chat: reads only"]);
    eq(access.accessLine({ role: "member", parts: { moments: "view" } }, null), "Can log · Moments and photos: can view");
  });

  await test("an entry's part: a note marked for the doctor, or a moment; everything else is the baby's log", () => {
    eq([access.entryPart({ kind: "note", data: { for_doctor: true } }), access.entryPart({ kind: "note", data: { tag: "gas" } }), access.entryPart({ kind: "moment", data: {} }), access.entryPart({ kind: "feed", data: {} })], ["doctor", null, "moments", null]);
    const m = { role: "member" as const, parts: { doctor: "view" as const, moments: "none" as const } };
    eq([access.seesEntry(m, { kind: "note", data: { for_doctor: true } }), access.writesEntry(m, { kind: "note", data: { for_doctor: true } })], [true, false], "view: sees, can't change");
    eq([access.seesEntry(m, { kind: "moment" }), access.seesEntry(m, { kind: "diaper" }), access.writesEntry(m, { kind: "diaper" })], [false, true, true]);
  });

  for (const shape of ["production", "final"] as Shape[]) {
    await freshDb({ shape });
    const s: Seed = await seedFamilies();
    const { alpha, beta } = s;
    const A = alpha.familyId;
    const B = beta.familyId;
    const owner = { id: alpha.owner, fam: A };
    const member = { id: alpha.member, fam: A };
    const set = (email: string, parts: unknown, as = owner) => call(routes.members.PATCH, "/api/maple/members", as, { method: "PATCH", body: { email, parts } });
    const addNote = (data: Record<string, unknown>, note: string, as = owner) =>
      call(routes.entries.POST, "/api/maple/entries", as, { method: "POST", body: { kind: "note", data, note, client_id: `parts-${shape}-${sha256(note + JSON.stringify(data) + as.id).slice(0, 16)}` } });
    const question = Number(((await addNote({ for_doctor: true }, QUESTION)).body.entry as { id: number }).id);
    const note = Number(((await addNote({ tag: "hiccups" }, NOTE)).body.entry as { id: number }).id);
    const momentId = alpha.entries.moment;
    // A photo key the photo route accepts for Alpha, so a reader it isn't hidden from gets as far as the storage (not set up here).
    await sql(`UPDATE maple_entries SET data = $2 WHERE id = $1`, [momentId, { title: "Made-up first bath", photos: [{ key: "https://madeupstore.private.blob.vercel-storage.com/maple/moments/made-up.jpg", access: "private" }] }]);
    const stateOf = async (as: { id: string; fam: number }) => (await call(routes.state.GET, "/api/maple/state", as)).body as { entries: { id: number; kind: string }[]; rev: string; me: { parts?: unknown } };

    await test(`${shape}: only owners turn parts down, in their own family, never their own or an owner's, never above the role`, async () => {
      eq((await set(alpha.viewer, { doctor: "none" }, member)).status, 403, "a member can't");
      eq((await set(alpha.owner, { doctor: "none" })).status, 400, "not your own");
      const above = await set(alpha.viewer, { doctor: "log" });
      eq([above.status, /at most see the questions for the doctor/.test(String(above.body.error))], [400, true], "a viewer can't add questions");
      eq((await set(alpha.member, { medicines: "none" })).status, 400, "only known parts");
      eq((await set(alpha.member, { doctor: "hidden" })).status, 400, "only none, view, log or null");
      eq((await set(alpha.member, { doctor: "none" }, { id: beta.owner, fam: B })).status, 400, "another family's owner: not a member there");
      eq(await partsOf(alpha.member), null, "nothing changed for Alpha's member");
    });

    await test(`${shape}: questions for the doctor hidden: gone from the state, the log, the export, the change token and every id`, async () => {
      const before = await stateOf(member);
      ok(before.entries.some((e) => e.id === question), "the member sees the question first");
      eq((await set(alpha.member, { doctor: "none" })).status, 200, "hidden");
      eq(await partsOf(alpha.member), { doctor: "none" }, "stored as the one part turned down");
      const state = await stateOf(member);
      eq(state.me.parts, { doctor: "none" }, "the app knows its own levels");
      ok(!state.entries.some((e) => e.id === question) && state.entries.some((e) => e.id === note), "the question is gone, the everyday note stays");
      const notes = await call(routes.entries.GET, "/api/maple/entries?kind=note", member);
      ok(!notes.text.includes(QUESTION) && notes.text.includes(NOTE), "History's notes");
      const csv = await call(routes.exportCsv.GET, "/api/maple/export", member);
      ok(!csv.text.includes(QUESTION) && csv.text.includes(NOTE), "the CSV export");
      eq((await call(routes.entries.PATCH, `/api/maple/entries?id=${question}`, member, { method: "PATCH", body: { note: "Changed" } })).status, 404, "an edit by id reads as not there");
      eq((await call(routes.entries.DELETE, `/api/maple/entries?id=${question}`, member, { method: "DELETE" })).status, 404, "a delete by id too");
      const made = await addNote({ for_doctor: true }, "Made-up question they can't add", member);
      eq([made.status, made.body.code], [403, "part"], "adding one is refused in its own words");
      const flip = await call(routes.entries.PATCH, `/api/maple/entries?id=${note}`, member, { method: "PATCH", body: { data: { for_doctor: true } } });
      eq(flip.status, 403, "nor can a note become one");
      // An owner adding another question moves nobody else's view: not the member's token.
      const unchanged = await call(routes.state.GET, `/api/maple/state?rev=${encodeURIComponent(state.rev)}`, member);
      eq(unchanged.body.unchanged, true, "the token holds while nothing they can see moved");
      await addNote({ for_doctor: true }, "Made-up second question");
      eq((await call(routes.state.GET, `/api/maple/state?rev=${encodeURIComponent(state.rev)}`, member)).body.unchanged, true, "a new question doesn't move it");
      ok((await stateOf(owner)).entries.some((e) => e.id === question), "the owner still sees it");
    });

    await test(`${shape}: questions hidden: the MCP and the chat's tools leave them out and refuse to add one`, async () => {
      const listed = await tool(alpha.member, A, "list_doctor_questions");
      ok(listed.error && /aren't shared with you/.test(listed.text), "list_doctor_questions refused");
      ok((await tool(alpha.member, A, "add_doctor_question", { question: "Made-up?" })).error, "add_doctor_question refused");
      ok((await tool(alpha.member, A, "log_note", { note: "Made-up", for_doctor: true })).error, "log_note for the doctor refused");
      const entries = await tool(alpha.member, A, "list_entries", { kind: "note", hours: 744 });
      ok(!entries.text.includes(QUESTION), "list_entries leaves it out");
      const summary = await tool(alpha.member, A, "daily_summary", { days: 14 });
      ok(!summary.text.includes(QUESTION), "daily_summary leaves it out");
      ok((await tool(alpha.owner, A, "list_doctor_questions")).text.includes(QUESTION), "the owner's tools still list it");
      const copy = toolCopy(A, { name: alpha.babyName, nickname: null, sex: null }, null, alpha.tz);
      const tools = chatTools({ email: alpha.member, role: "member", parts: { doctor: "none" } }, { fam: A, born: true, care: false, copy });
      eq(["list_doctor_questions" in tools, "add_doctor_question" in tools, "log_note" in tools], [false, false, true], "the chat isn't sent the question tools");
    });

    await test(`${shape}: questions read only: seen everywhere, changed nowhere`, async () => {
      eq((await set(alpha.member, { doctor: "view" })).status, 200);
      ok((await stateOf(member)).entries.some((e) => e.id === question), "back in the state");
      ok((await tool(alpha.member, A, "list_doctor_questions")).text.includes(QUESTION), "list_doctor_questions reads it");
      const edit = await call(routes.entries.PATCH, `/api/maple/entries?id=${question}`, member, { method: "PATCH", body: { data: { done: true } } });
      eq([edit.status, /can see the questions for the doctor but not add or change them/.test(String(edit.body.error))], [403, true], "no ticking off");
      eq((await call(routes.entries.DELETE, `/api/maple/entries?id=${question}`, member, { method: "DELETE" })).status, 403, "no deleting");
      const add = await tool(alpha.member, A, "add_doctor_question", { question: "Made-up?" });
      ok(add.error && /can see the questions for the doctor but not add/.test(add.text), "add_doctor_question says why");
      const upd = await tool(alpha.member, A, "update_entry", { id: question, details: { done: true } });
      ok(upd.error && /Nothing was saved/.test(upd.text), "update_entry refused");
      eq((await addNote({ tag: "gas" }, "Made-up gas", member)).status, 201, "everyday notes still log");
      // Deleted by the owner: the member can't put it back either.
      eq((await call(routes.entries.DELETE, `/api/maple/entries?id=${question}`, owner, { method: "DELETE" })).status, 200);
      eq((await call(routes.restore.POST, `/api/maple/entries/restore?id=${question}`, member, { method: "POST" })).status, 403, "no restoring");
      eq((await call(routes.restore.POST, `/api/maple/entries/restore?id=${question}`, owner, { method: "POST" })).status, 200, "the owner puts it back");
      const copy = toolCopy(A, { name: alpha.babyName, nickname: null, sex: null }, null, alpha.tz);
      const tools = chatTools({ email: alpha.member, role: "member", parts: { doctor: "view" } }, { fam: A, born: true, care: false, copy });
      eq(["list_doctor_questions" in tools, "add_doctor_question" in tools], [true, false], "the chat reads them only");
      eq((await set(alpha.member, { doctor: null })).status, 200, "back to the role's own");
      eq(await partsOf(alpha.member), null);
    });

    await test(`${shape}: moments hidden or read only: the state, the album, photos, uploads and the tools follow`, async () => {
      eq((await set(alpha.member, { moments: "none" })).status, 200);
      const album = async (as: { id: string; fam: number }) => ((await call(routes.entries.GET, "/api/maple/entries?kind=moment", as)).body.entries as { id: number }[]).map((e) => e.id);
      ok((await album(owner)).includes(momentId), "the owner's album has it");
      eq(await album(member), [], "theirs is empty");
      eq(((await call(routes.entries.GET, "/api/maple/entries?kind=moment&highlights=1", member)).body.entries as unknown[]).length, 0, "and so are the highlights");
      eq((await call(routes.photo.GET, `/api/maple/photo?entry=${momentId}&i=0`, member)).status, 404, "its photo reads as not there");
      eq((await call(routes.photo.GET, `/api/maple/photo?entry=${momentId}&i=0`, owner)).status, 503, "the owner's reaches the storage");
      ok((await tool(alpha.member, A, "get_moments")).error, "get_moments refused");
      eq((await call(routes.upload.GET, "/api/maple/upload", member)).status, 403, "no uploads");

      eq((await set(alpha.member, { moments: "view" })).status, 200);
      ok((await album(member)).includes(momentId), "back, read only");
      ok(!(await tool(alpha.member, A, "get_moments")).error, "get_moments reads");
      const saved = await call(routes.entries.POST, "/api/maple/entries", member, { method: "POST", body: { kind: "moment", data: { title: "Made-up" }, client_id: `parts-${shape}-moment` } });
      eq([saved.status, saved.body.code], [403, "part"], "no new moment");
      eq((await call(routes.entries.PATCH, `/api/maple/entries?id=${momentId}`, member, { method: "PATCH", body: { note: "Made-up" } })).status, 403, "no edit");
      const logged = await tool(alpha.member, A, "log_moment", { title: "Made-up" });
      ok(logged.error && /can see moments but not add/.test(logged.text), "log_moment says why");
      eq((await call(routes.upload.GET, "/api/maple/upload", member)).status, 403, "still no uploads");
      eq((await set(alpha.member, { moments: null })).status, 200);
    });

    await test(`${shape}: the chat off or read only, on the server: its routes, its tools, and every write it could reach`, async () => {
      eq((await set(alpha.member, { chat: "none" })).status, 200);
      const off = await call(routes.chat.GET, "/api/maple/chat", member);
      eq([off.status, off.body.code], [403, "part"], "the chat's routes turn it away");
      const viaChat = await tool(alpha.member, A, "maple_status", {}, "chat");
      ok(viaChat.error && /chat is off for you/.test(viaChat.text), "a chat tool call reads nothing");
      ok(!(await tool(alpha.member, A, "maple_status")).error, "a connected assistant still works");

      eq((await set(alpha.member, { chat: "view" })).status, 200);
      eq((await call(routes.chat.GET, "/api/maple/chat", member)).status, 200, "it opens");
      ok(!(await tool(alpha.member, A, "maple_status", {}, "chat")).error, "it reads");
      const write = await tool(alpha.member, A, "log_diaper", { diaper: "wet" }, "chat");
      ok(write.error && /only reads the log for you/.test(write.text), "a write through the chat is refused");
      ok((await tool(alpha.member, A, "save_memory", { kind: "routine", fact: "The made-up family walks after the evening feed." }, "chat")).error, "and a memory save");
      ok(!(await tool(alpha.member, A, "log_diaper", { diaper: "wet", minutes_ago: 5 })).error, "the same write from a connected assistant saves");
      const copy = toolCopy(A, { name: alpha.babyName, nickname: null, sex: null }, null, alpha.tz);
      const tools = chatTools({ email: alpha.member, role: "member", parts: { chat: "view" } }, { fam: A, born: true, care: false, copy });
      ok("maple_status" in tools && !("log_diaper" in tools) && !("log_feed" in tools), "the chat is sent the reads alone");
      eq((await set(alpha.member, { chat: null })).status, 200);
    });

    await test(`${shape}: a chat that could read the questions or moments stays where it is once they're hidden`, async () => {
      const m = { role: "member" as const, email: alpha.member, parts: { doctor: "none" as const } };
      // A thread from before the parts existed reads as having had them open.
      await sql(`INSERT INTO maple_chat_threads (family_id, id, member, title, model) VALUES ($1, $2, $3, 'Made-up older thread', 'zai/glm-5.3-flash')`, [A, `thread_parts_${shape}_old`, alpha.member]);
      eq((await chatStream({ familyId: A }, alpha.member, threadAccess({ role: "member" }), null)).current?.id, `thread_parts_${shape}_old`, "open with every part");
      eq((await chatStream({ familyId: A }, alpha.member, threadAccess(m), null)).current, null, "hidden questions: a new chat starts");
      const locked = await lockThread({ familyId: A }, `thread_parts_${shape}_new`, alpha.member, "zai/glm-5.3-flash", false, true, { doctor: false, moments: true });
      ok(typeof locked === "object" && locked.doctorOpen === false && locked.momentsOpen === true, "a new thread records what was open");
      if (typeof locked === "object") await releaseThread({ familyId: A }, locked.id, locked.leaseId);
      eq((await chatStream({ familyId: A }, alpha.member, threadAccess(m), null)).current?.id, `thread_parts_${shape}_new`, "the new one opens");
      eq((await chatStream({ familyId: A }, alpha.member, threadAccess({ role: "member", parts: { moments: "none" } }), null)).current, null, "the new one could read moments, so hiding those closes it too");
      const lockedAgain = await lockThread({ familyId: A }, `thread_parts_${shape}_new`, alpha.member, "zai/glm-5.3-flash", false, true, { doctor: true, moments: true });
      ok(typeof lockedAgain === "object" && lockedAgain.doctorOpen === true, "once it reads them, it says so for good");
      if (typeof lockedAgain === "object") await releaseThread({ familyId: A }, lockedAgain.id, lockedAgain.leaseId);
      eq((await chatStream({ familyId: A }, alpha.member, threadAccess(m), null)).current, null, "and closes again to someone they're hidden from");
    });

    await test(`${shape}: a role change keeps the parts (the role caps them); making someone an owner clears them`, async () => {
      eq((await set(alpha.member, { doctor: "none", chat: "view" })).status, 200);
      eq((await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, role: "viewer" } })).status, 200, "to a viewer");
      eq(await partsOf(alpha.member), { chat: "view", doctor: "none" }, "kept as stored");
      ok(!(await stateOf(member)).entries.some((e) => e.id === question), "still hidden as a viewer");
      eq((await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, role: "member" } })).status, 200, "back to log");
      eq(await partsOf(alpha.member), { chat: "view", doctor: "none" }, "still there");
      eq((await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, role: "owner" } })).status, 200, "made an owner");
      eq(await partsOf(alpha.member), null, "owners have every part");
      ok((await stateOf(member)).entries.some((e) => e.id === question), "and see the questions");
      // Put Alpha's member back as it was for the checks after this one.
      await sql(`UPDATE maple_members SET role = 'member' WHERE family_id = $1 AND email = $2`, [A, alpha.member]);
    });

    await test(`${shape}: list_people says each person's parts, and change_access reads a part back before changing it`, async () => {
      const people = (await tool(alpha.owner, A, "list_people")).json.people as Record<string, unknown>[];
      const viewer = people.find((p) => p.id === alpha.viewer)!;
      eq([viewer.doctor_questions, viewer.moments, viewer.chat], ["view", "view", "view"], "a viewer, as the role gives");
      const ask = await tool(alpha.owner, A, "change_access", { person: alpha.viewer, part: "doctor_questions", level: "none" });
      ok(!ask.error && ask.json.confirm_needed === true && /questions for the doctor: hidden/.test(ask.text), "read back first");
      eq(await partsOf(alpha.viewer), null, "nothing changed yet");
      ok((await tool(alpha.owner, A, "change_access", { person: alpha.viewer, part: "doctor_questions" })).error, "a part needs its level");
      ok((await tool(alpha.owner, A, "change_access", { person: alpha.viewer, part: "chat", level: "log", confirmed: true })).error, "never above the role");
      const done1 = await tool(alpha.owner, A, "change_access", { person: alpha.viewer, part: "doctor_questions", level: "none", confirmed: true });
      ok(!done1.error && done1.json.doctor_questions === "none", "changed");
      eq(await partsOf(alpha.viewer), { doctor: "none" });
      ok((await tool(alpha.member, A, "change_access", { person: alpha.viewer, part: "moments", level: "none", confirmed: true })).error, "members can't");
      ok((await tool(beta.owner, B, "change_access", { person: alpha.viewer, part: "moments", level: "none", confirmed: true })).error, "nor another family's owner");
      eq(await partsOf(alpha.viewer), { doctor: "none" }, "unchanged by either");
    });

    await test(`${shape}: invites carry the parts to whoever takes them up: a link, an address in family 1, and an addressed invite elsewhere`, async () => {
      const link = await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Made-up Sitter", role: "member", parts: { doctor: "none", chat: "view" } } });
      eq(link.status, 201, "a link with parts");
      eq(sorted((link.body.invite as { parts?: unknown }).parts), { chat: "view", doctor: "none" }, "shown on the invite");
      const token = String(link.body.url).split("#")[1];
      const redeemed = await auth.redeemInvite(token);
      ok(redeemed && typeof redeemed === "object", "redeemed");
      if (redeemed && typeof redeemed === "object") eq(await partsOf(redeemed.id, A), { chat: "view", doctor: "none" }, "the link's member has them");
      eq((await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Made-up", role: "viewer", parts: { moments: "log" } } })).status, 400, "never above the role");
      eq((await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Made-up", role: "photos", parts: { moments: "none" } } })).status, 400, "photos-only keep their moments");

      eq((await call(routes.members.POST, "/api/maple/members", owner, { method: "POST", body: { email: "made-up.nanny@example.com", role: "member", parts: { moments: "none" } } })).status, 200, "family 1 adds the address at once");
      eq(await partsOf("made-up.nanny@example.com", A), { moments: "none" });

      const betaOwner = { id: beta.owner, fam: B };
      const invited = await call(routes.members.POST, "/api/maple/members", betaOwner, { method: "POST", body: { email: "made-up.helper@example.com", role: "member", parts: { doctor: "view" } } });
      eq(invited.status, 201, "a pending invite in Beta");
      const joined = await joinByInvite({ email: "made-up.helper@example.com", name: null }, String(invited.body.url).split("#join=")[1]);
      ok(joined, "taken up by that address");
      eq(await partsOf("made-up.helper@example.com", B), { doctor: "view" }, "the member it makes has them");
      eq(await partsOf("made-up.helper@example.com", A), null, "and nothing in Alpha");
    });

    await test(`${shape}: Siri reads as the person: no hidden question in their status`, async () => {
      const token = `maple_partsSiriToken${shape}MadeUp0123456789`;
      await sql(`INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES ($1, $2, $3, 'Made-up phone')`, [A, alpha.viewer, sha256(token)]);
      const res = await routes.quick.POST(new NextRequest(new URL("/api/maple/quick", "http://localhost:3000"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "recap" }),
      }));
      const text = await res.text();
      eq(res.status, 200, "recap answers");
      ok(!text.includes(QUESTION), "and leaves the question out");
    });
  }

  done("parts.check.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

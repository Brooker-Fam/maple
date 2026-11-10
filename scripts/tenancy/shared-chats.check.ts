import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { NextRequest } from "next/server";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type Seed } from "./harness";

/**
 * Shared chats (chat/shared.ts): chats several people of one family read and
 * post in. Who can be in one and see it; that it's never part of anyone's
 * own chat; that a turn in it reads only what everyone in it can see (the
 * questions for the doctor, her page), with a stand-in model; who answers a
 * card; adding people; leaving; and family Beta (2) never reaching family
 * Alpha's (1). Made-up people only; nothing leaves this process.
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_CHAT_MODEL;
process.env.MCP_SECRET = "made-up-shared-chats-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-shared-chats-session-secret";

const QUESTION = "Is the made-up rash on her cheek okay?";

async function main() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../../src/lib/maple/auth");
  const shared = await import("../../src/lib/maple/chat/shared");
  const { chatStream, deleteChats, threadAccess } = await import("../../src/lib/maple/chat/history");
  const { lockThread, releaseThread } = await import("../../src/lib/maple/chat/store");
  const { familyPostDeps } = await import("../../src/lib/maple/chat/family-deps");
  const { answerPost, SHARED_NO_PHOTOS } = await import("../../src/lib/maple/chat/post");
  const { resolveFamily } = await import("../../src/lib/maple/family");
  const routes = {
    chat: await import("../../src/app/api/maple/chat/route"),
    shared: await import("../../src/app/api/maple/chat/shared/route"),
    members: await import("../../src/app/api/maple/members/route"),
  };

  const cookie = (id: string, fam: number) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, fam))}` });
  const call = async (handler: (r: NextRequest) => Promise<Response>, path: string, as: { id: string; fam: number }, init: { method?: string; body?: unknown } = {}) => {
    const res = await handler(new NextRequest(new URL(path, "http://localhost:3000"), {
      method: init.method ?? "GET",
      headers: { ...cookie(as.id, as.fam), "content-type": "application/json", "x-real-ip": "203.0.113.21" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }));
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
    return { status: res.status, body };
  };

  // ── the rules ──
  await test("a turn reads only what everyone in it can see: hidden for anyone is hidden here, and her page needs all of them", () => {
    const m = (email: string, role: "owner" | "member" | "viewer", extra: Record<string, unknown> = {}) => ({ email, role, display_name: null, emoji: null, color: null, ...extra });
    const owner = m("o@example.com", "owner");
    const member = m("m@example.com", "member");
    const hidden = m("h@example.com", "member", { parts: { doctor: "none" } });
    const viewer = m("v@example.com", "viewer");
    const none = { careOpen: false, doctorOpen: false, momentsOpen: false };
    const consent = { herConsent: true, carePerson: null };
    eq(shared.sharedAccess(owner, [owner, member], none, consent), { narrow: {}, care: true, people: [owner, member] }, "both can see all of it");
    eq(shared.sharedAccess(owner, [owner, hidden], none, consent).narrow, { doctor: "none" }, "the questions are hidden from someone, so from the chat, the owner's turn too");
    eq(shared.sharedAccess(owner, [owner, viewer], none, consent).care, false, "her page never reaches a viewer's chat");
    eq(shared.sharedAccess(owner, [owner, member], none, { herConsent: false, carePerson: null }).care, false, "nor anyone's before she lets the chat see it");
    // Someone who can't open it anymore (its questions were open, and now they're hidden from them) no longer counts.
    const opened = { careOpen: false, doctorOpen: true, momentsOpen: false };
    eq(shared.sharedAccess(owner, [owner, hidden, member], opened, consent).people.map((p) => p.email), [owner.email, member.email], "they're out, and the chat reads on");
    eq([shared.opensShared(viewer, { ...none, careOpen: true }), shared.opensShared(member, { ...none, careOpen: true })], [false, true], "a thread that had her page open never reaches a viewer");
    const off = m("off@example.com", "member", { parts: { chat: "none", doctor: "none" } });
    eq(shared.sharedAccess(owner, [owner, off, member], none, consent).people.map((p) => p.email), [owner.email, member.email], "someone the chat is off for reads none of it, so doesn't count");
    eq([shared.canShareChat(viewer), shared.canShareChat(m("p@example.com", "member", { parts: { chat: "none" } })), shared.canShareChat({ ...viewer, role: "photos" as const })], [true, false, false], "who can be in one");
  });

  await freshDb();
  const s: Seed = await seedFamilies();
  const { alpha, beta } = s;
  const A = alpha.familyId;
  const owner = { id: alpha.owner, fam: A };
  const member = { id: alpha.member, fam: A };
  const viewer = { id: alpha.viewer, fam: A };
  // Everyone here has accepted the chat's terms (the seed gives the owners theirs), and a photos-only guest and a person the chat is off for exist too.
  for (const who of [alpha.member, alpha.viewer, beta.member]) {
    await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES ($1, $2, 'chat', 3)`, [who === beta.member ? 2 : 1, who]);
  }
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES (1, 'pat.alpha@example.com', 'photos', 'Pat', 'self', NOW())`);
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at, parts) VALUES (1, 'quinn.alpha@example.com', 'member', 'Quinn', 'self', NOW(), '{"chat":"none"}')`);
  await sql(`INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, note, created_by) VALUES (1, $1, 'note', NOW() - INTERVAL '1 hour', '{"for_doctor":true}', $2, $3)`, [alpha.babyId, QUESTION, alpha.owner]);

  const create = (as: { id: string; fam: number }, body: Record<string, unknown>) => call(routes.shared.POST, "/api/maple/chat/shared", as, { method: "POST", body: { action: "create", ...body } });
  const list = async (as: { id: string; fam: number }) => ((await call(routes.shared.GET, "/api/maple/chat/shared", as)).body.chats ?? []) as { id: string; name: string | null; people: string[] }[];

  let chatId = "";
  await test("a shared chat starts with the people picked, and only they see it", async () => {
    const made = await create(owner, { people: [alpha.member], name: "  Night   shift  " });
    eq(made.status, 201, "made");
    const chat = made.body.chat as { id: string; name: string; people: string[]; createdBy: string };
    chatId = chat.id;
    eq([chat.name, chat.people, chat.createdBy], ["Night shift", [alpha.owner, alpha.member], alpha.owner], "named, its maker first");
    eq((await list(member)).map((c) => c.id), [chatId], "the member has it");
    eq((await list(viewer)).length, 0, "the viewer isn't in it");
    eq((await list({ id: beta.owner, fam: beta.familyId })).length, 0, "nor is another family");
    eq((await call(routes.chat.GET, `/api/maple/chat?thread=${chatId}`, viewer)).status, 404, "nor can anyone not in it read it");
    eq((await call(routes.chat.GET, `/api/maple/chat?thread=${chatId}`, { id: beta.owner, fam: beta.familyId })).status, 404, "or another family");
  });

  await test("only people the chat is on for can be in one, from this family, and nobody twice", async () => {
    const refused = async (people: unknown, label: string) => {
      const r = await create(owner, { people });
      eq(r.status, 400, label);
      return String(r.body.error);
    };
    await refused([], "nobody picked");
    await refused([alpha.owner], "only yourself");
    ok(/can't use the chat/.test(await refused(["pat.alpha@example.com"], "a photos-only guest")), "says why");
    ok(/can't use the chat/.test(await refused(["quinn.alpha@example.com"], "someone the chat is off for")), "says why");
    ok(/isn't in this family's log/.test(await refused([beta.member], "another family's member")), "says why");
    eq((await call(routes.shared.POST, "/api/maple/chat/shared", { id: "pat.alpha@example.com", fam: A }, { method: "POST", body: { action: "create", people: [alpha.owner] } })).status, 403, "a photos-only guest can't start one");
    const twice = await create(owner, { people: [alpha.member, alpha.member, alpha.viewer] });
    eq((twice.body.chat as { people: string[] }).people, [alpha.owner, alpha.member, alpha.viewer], "each person once");
    await call(routes.shared.POST, "/api/maple/chat/shared", owner, { method: "POST", body: { action: "leave", id: (twice.body.chat as { id: string }).id } });
  });

  const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
  const finish = (reason: string) => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
  /** A stand-in model: each step's tools and prompt are kept, and it answers with `steps` in turn (text by default). */
  const turn = async (who: { id: string; fam: number }, threadId: string, text: string, steps: unknown[][] = [], extraParts: unknown[] = []) => {
    const seen: { tools: string[]; prompt: string }[] = [];
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        seen.push({ tools: (options.tools ?? []).map((t) => (t as { name: string }).name), prompt: JSON.stringify(options.prompt) });
        const chunks = steps[calls++] ?? [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Okay." }, { type: "text-end", id: "t" }, finish("stop")];
        return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...chunks] as never[] }) };
      },
    });
    const fam = await resolveFamily(who.id, who.fam);
    const me = (await auth.memberFor({ familyId: who.fam }, who.id))!;
    const waits: Promise<unknown>[] = [];
    const errors: Error[] = [];
    const deps = familyPostDeps({ ...fam!, ...(me.parts ? { parts: me.parts } : {}) }, me, { model, modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: (e) => errors.push(e), waitUntil: (p) => waits.push(p) });
    const res = await answerPost({ threadId, message: { role: "user", parts: [{ type: "text", text }, ...extraParts] } }, me, deps);
    const body = await res.text();
    await Promise.all(waits);
    return { status: res.status, body, seen, errors };
  };

  await test("everyone in it reads every message, with who sent it, and it's never part of anyone's own chat", async () => {
    const r = await turn(member, chatId, "How did the night go?");
    eq([r.status, r.errors.map((e) => e.message)], [200, []], "the member's turn ran");
    ok(r.seen[0].prompt.includes("This is a shared chat") && r.seen[0].prompt.includes('\\"Avery\\"') && r.seen[0].prompt.includes('\\"Blake\\"'), "the prompt says who's in it");
    const read = await call(routes.chat.GET, `/api/maple/chat?thread=${chatId}`, owner);
    const items = read.body.items as { by: string; message: { role: string } }[];
    eq(items.map((i) => [i.message.role, i.by]), [["user", alpha.member], ["assistant", alpha.member]], "the owner reads both, with who sent them");
    const mine = await chatStream({ familyId: A }, alpha.owner, threadAccess({ role: "owner" }), null);
    ok(!mine.items.some((i) => i.thread === chatId), "never in the maker's own chat");
    await deleteChats({ familyId: A }, alpha.owner, threadAccess({ role: "owner" }));
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_messages WHERE thread_id = $1`, [chatId]))[0].n, 2, "deleting your own chat leaves it");
    eq((await turn(viewer, chatId, "Hello?")).status, 404, "someone not in it can't post");
    eq(await lockThread({ familyId: A }, chatId, alpha.viewer, "zai/glm-5.3-flash", true, false), "missing", "nor take its turn");
    const locked = await lockThread({ familyId: A }, chatId, alpha.owner, "zai/glm-5.3-flash", false, false);
    ok(typeof locked === "object", "its people can");
    if (typeof locked === "object") await releaseThread({ familyId: A }, locked.id, locked.leaseId);
  });

  await test("a turn leaves out the questions for the doctor while anyone in it can't see them, the owner's own turn too", async () => {
    const listNotes = [{ type: "tool-call", toolCallId: "call_notes", toolName: "list_entries", input: JSON.stringify({ kind: "note", hours: 48 }) }, finish("tool-calls")];
    const open = await turn(owner, chatId, "Any notes?", [listNotes]);
    eq(open.status, 200);
    ok(open.seen[1].prompt.includes(QUESTION), "everyone here can see it, so the result has it");
    await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, parts: { doctor: "view" } } });
    ok((await turn(owner, chatId, "Any notes?", [listNotes])).seen[1].prompt.includes(QUESTION), "read only for someone is still shared");
    // Hidden from the member: they can't open this chat anymore (it had the questions open), and a new one leaves them out.
    eq((await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, parts: { doctor: "none" } } })).status, 200);
    ok(!(await list(member)).some((c) => c.id === chatId), "the chat that had them open closes to the member");
    eq((await call(routes.chat.GET, `/api/maple/chat?thread=${chatId}`, member)).status, 404, "and reads as not there");
    const fresh = (await create(owner, { people: [alpha.member] })).body.chat as { id: string };
    const hidden = await turn(owner, fresh.id, "Any notes?", [listNotes]);
    eq(hidden.status, 200);
    ok(!hidden.seen[1].prompt.includes(QUESTION), "left out of the owner's turn here");
    ok(!hidden.seen[0].tools.includes("list_doctor_questions") && !hidden.seen[0].tools.includes("add_doctor_question"), "and the question tools aren't sent");
    eq((await sql(`SELECT doctor_open FROM maple_chat_threads WHERE id = $1`, [fresh.id]))[0].doctor_open, false, "it never had them open");
    ok((await list(member)).some((c) => c.id === fresh.id), "so the member opens it");
    await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, parts: { doctor: null } } });
  });

  await test("her page opens in a shared chat only when she let the chat see it and everyone in it could read it", async () => {
    await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES (1, 'Dana', 'chat_care', 2)`);
    const both = (await create(owner, { people: [alpha.member] })).body.chat as { id: string };
    const withViewer = (await create(owner, { people: [alpha.member, alpha.viewer] })).body.chat as { id: string };
    const open = await turn(owner, both.id, "How is Dana doing?");
    ok(open.seen[0].tools.includes("mom_status"), "the owner and the member can both read it: open");
    const closed = await turn(owner, withViewer.id, "How is Dana doing?");
    ok(!closed.seen[0].tools.includes("mom_status"), "a viewer is in this one: closed");
    ok(closed.seen[0].prompt.includes("isn't open in this chat, because not everyone here can see it"), "and the prompt says why");
    eq((await sql(`SELECT care_open FROM maple_chat_threads WHERE id = $1`, [withViewer.id]))[0].care_open, false, "it never had it open");
    // Adding the viewer to the one that had her page open is refused: they'd read what it already said.
    const add = await call(routes.shared.POST, "/api/maple/chat/shared", owner, { method: "POST", body: { action: "add", id: both.id, people: [alpha.viewer] } });
    eq([add.status, /can't see, so they can't join it/.test(String(add.body.error))], [409, true], "refused, saying why");
    const added = await call(routes.shared.POST, "/api/maple/chat/shared", member, { method: "POST", body: { action: "add", id: withViewer.id, people: [alpha.owner] } });
    eq(added.status, 400, "someone already in it isn't added twice");
  });

  await test("no photos in a shared chat, and its cards wait for whoever's turn made them", async () => {
    const photo = { type: "file", mediaType: "image/jpeg", url: "/api/maple/chat/images?id=0d2c6a4e-1111-4222-8333-444455556666" };
    const r = await turn(owner, chatId, "Look at this", [], [photo]);
    eq([r.status, JSON.parse(r.body).error], [400, SHARED_NO_PHOTOS], "refused before anything runs");
    const fam = await resolveFamily(alpha.member, A);
    const me = (await auth.memberFor({ familyId: A }, alpha.member))!;
    const res = await answerPost({ threadId: chatId, message: { id: "msg_someone_elses", role: "assistant", parts: [] } }, me, familyPostDeps(fam!, me, { model: new MockLanguageModelV4({}), modelKey: "zai/glm-5.3-flash", device: null, now: new Date(), report: () => {}, waitUntil: () => {} }));
    const body = JSON.parse(await res.text());
    eq([res.status, body.code, /Only Avery can answer that/.test(body.error)], [409, "not_yours", true], "the owner's turn was last, so the member can't answer its card");
  });

  await test("before a rollback, the docs' SQL hands shared chats to nobody: an older release never reads one as its maker's, and this one still opens it for its people", async () => {
    const chat = (await create(owner, { people: [alpha.member] })).body.chat as { id: string };
    eq((await turn(member, chat.id, "Anything new?")).status, 200, "a turn in it");
    // Releases from before shared chats take a person's own chat to be every thread with them as its member
    // (history.ts chatStream and Delete chat history, auth.ts leaveFamily).
    const theirs = async (who: string) => (await sql(`SELECT id FROM maple_chat_threads WHERE family_id = $1 AND member = $2`, [A, who])).map((r) => String(r.id));
    ok((await theirs(alpha.owner)).includes(chat.id), "without it, an older release reads it as the owner's own");
    // docs/maple.md → Shared chats, Rollback.
    await sql(`UPDATE maple_chat_threads SET member = 'shared:' || id WHERE shared`);
    ok(!(await theirs(alpha.owner)).includes(chat.id), "with it, not the owner's");
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_threads t JOIN maple_members m ON m.family_id = t.family_id AND m.email = t.member WHERE t.shared`))[0].n, 0, "nor anyone's");
    ok((await list(owner)).some((c) => c.id === chat.id) && (await list(member)).some((c) => c.id === chat.id), "this release still lists it for both");
    eq((await turn(owner, chat.id, "Still here?")).status, 200, "and its turns go on");
    eq(((await call(routes.chat.GET, `/api/maple/chat?thread=${chat.id}`, member)).body.items as unknown[]).length, 4, "with every message");
  });

  await test("leaving: gone for them, kept for the others; the last one out deletes it, and removal and leaving the family take people out", async () => {
    const chat = (await create(owner, { people: [alpha.member, alpha.viewer] })).body.chat as { id: string };
    await turn(viewer, chat.id, "Morning!");
    eq((await call(routes.shared.POST, "/api/maple/chat/shared", viewer, { method: "POST", body: { action: "leave", id: chat.id } })).status, 200, "the viewer leaves");
    ok(!(await list(viewer)).some((c) => c.id === chat.id), "it's gone for them");
    eq((await call(routes.chat.GET, `/api/maple/chat?thread=${chat.id}`, owner)).body.items instanceof Array, true, "the others keep it");
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_messages WHERE thread_id = $1 AND member = $2`, [chat.id, alpha.viewer]))[0].n, 2, "what they wrote stays");
    // Removing the member takes them out of it, and never deletes it for the owner.
    await auth.removeMember({ familyId: A }, alpha.member, alpha.owner);
    eq((await list(owner)).find((c) => c.id === chat.id)?.people, [alpha.owner], "only the owner is left");
    eq((await call(routes.shared.POST, "/api/maple/chat/shared", owner, { method: "POST", body: { action: "leave", id: chat.id } })).status, 200);
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_threads WHERE id = $1`, [chat.id]))[0].n, 0, "the last one out deletes it");
    eq((await sql(`SELECT COUNT(*)::int AS n FROM maple_chat_messages WHERE thread_id = $1`, [chat.id]))[0].n, 0, "and its messages");
    // Beta's member leaving Beta takes them out of Beta's shared chats only.
    const betaOwner = { id: beta.owner, fam: beta.familyId };
    const betaChat = (await create(betaOwner, { people: [beta.member] })).body.chat as { id: string };
    await auth.leaveFamily({ familyId: beta.familyId }, beta.member);
    eq((await list(betaOwner)).find((c) => c.id === betaChat.id)?.people, [beta.owner], "Beta's chat keeps its owner");
    ok((await list(owner)).length > 0, "Alpha's chats are untouched");
  });

  done("shared-chats.check.ts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

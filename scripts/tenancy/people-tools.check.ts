import { z } from "zod";
import type { NextRequest } from "next/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { done, eq, freshDb, ok, seedFamilies, sha256, sql, test, type Seed, type Shape } from "./harness";

/**
 * Who's in the family and what each person reaches (access.ts, people.ts,
 * people-mcp.ts): her page per person (none, view or log) in the app, the
 * MCP, Siri and the chat, and the people tools owners use from Claude and
 * Maple's chat. Runs on both schema shapes with the two made-up families;
 * family Beta (2) never reaches family Alpha's (1) people. Made-up people
 * only; nothing leaves this process (email isn't configured, so invites
 * aren't sent).
 */

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.MAPLE_ALLOWED_EMAILS;
delete process.env.MAPLE_ADMIN_FAMILY_ID;
process.env.MCP_SECRET = "made-up-people-tools-mcp-secret";
process.env.GOOGLE_CLIENT_SECRET = "made-up-people-tools-session-secret";

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (args: unknown, extra: unknown) => Promise<Result>;

async function main() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../../src/lib/maple/auth");
  const { registerMapleTools } = await import("../../src/lib/maple/mcp-tools");
  const { careAccess } = await import("../../src/lib/maple/care");
  const { joinByInvite } = await import("../../src/lib/maple/family/create");
  const { chatStream, deleteChats, threadAccess } = await import("../../src/lib/maple/chat/history");
  const people = await import("../../src/lib/maple/people");
  const routes = {
    members: await import("../../src/app/api/maple/members/route"),
    invites: await import("../../src/app/api/maple/invites/route"),
    state: await import("../../src/app/api/maple/state/route"),
    care: await import("../../src/app/api/maple/care/entries/route"),
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
    return { error: res.isError === true, text, json, structured: res.structuredContent ?? {} };
  };

  const cookie = (id: string, fam: number) => ({ cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(id, fam))}` });
  const call = async (handler: (r: NextRequest) => Promise<Response>, path: string, as: { id: string; fam: number }, init: { method?: string; body?: unknown } = {}) => {
    const res = await handler(new NextRequest(new URL(path, "http://localhost:3000"), {
      method: init.method ?? "GET",
      headers: { ...cookie(as.id, as.fam), "content-type": "application/json", "x-real-ip": "203.0.113.9" },
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
  const siri = async (token: string, body: unknown) => {
    const res = await routes.quick.POST(new NextRequest(new URL("/api/maple/quick", "http://localhost:3000"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const careOf = async (email: string, fam = 1) => (await sql(`SELECT care_access FROM maple_members WHERE family_id = $1 AND email = $2`, [fam, email]))[0]?.care_access ?? null;

  await test("careAccess: her page follows each person's level, owners and her own account always have it", () => {
    const person = { member: "dana@example.com", shared_with: [], settings: {}, created_by: null, created_at: "", updated_at: "" };
    const members = [
      { email: "owner@example.com", role: "owner" as const, display_name: null, emoji: null, color: null, care: "none" as const },
      { email: "full@example.com", role: "member" as const, display_name: null, emoji: null, color: null },
      { email: "view@example.com", role: "member" as const, display_name: null, emoji: null, color: null, care: "view" as const },
      { email: "none@example.com", role: "member" as const, display_name: null, emoji: null, color: null, care: "none" as const },
      { email: "guest@example.com", role: "viewer" as const, display_name: null, emoji: null, color: null },
      { email: "seer@example.com", role: "viewer" as const, display_name: null, emoji: null, color: null, care: "log" as const },
      { email: "photo@example.com", role: "photos" as const, display_name: null, emoji: null, color: null, care: "view" as const },
      { email: "dana@example.com", role: "member" as const, display_name: null, emoji: null, color: null, care: "none" as const },
    ];
    const as = (id: string, viaAdmin = false) => careAccess({ id, role: "member", viaAdmin, channel: "app" }, person, members);
    eq([as("owner@example.com").write, as("full@example.com").write, as("admin").write], [true, true, true], "owners, members by default, the admin login");
    eq(as("view@example.com"), { self: false, read: true, write: false, private: false, mood: false, therapist: false, manage: false }, "view: reads, never her check-ins or settings");
    eq([as("none@example.com").read, as("guest@example.com").read, as("photo@example.com").read], [false, false, false], "none, a viewer by default, photos-only");
    eq([as("seer@example.com").read, as("seer@example.com").write], [true, false], "a viewer never logs on her page");
    eq([as("dana@example.com").self, as("dana@example.com").write], [true, true], "her own account");
    eq(as("dana@example.com", true).read, false, "the admin login acting as her reads her level, not hers");
  });

  for (const shape of ["production", "final"] as Shape[]) {
    await freshDb({ shape });
    const s: Seed = await seedFamilies();
    const { alpha, beta } = s;
    const A = alpha.familyId;
    const B = beta.familyId;
    const owner = { id: alpha.owner, fam: A };

    await test(`${shape}: owners set someone's level on her page, and it holds at once in the app and the MCP`, async () => {
      const set = (email: string, care: unknown, as = owner) => call(routes.members.PATCH, "/api/maple/members", as, { method: "PATCH", body: { email, care } });
      eq((await set(alpha.member, "none")).status, 200, "hidden");
      eq(await careOf(alpha.member), "none");
      eq("care" in (await call(routes.state.GET, "/api/maple/state", { id: alpha.member, fam: A })).body, false, "no care state");
      eq((await call(routes.care.GET, "/api/maple/care/entries", { id: alpha.member, fam: A })).status, 404, "her routes read as nothing there");
      eq((await tool(alpha.member, A, "mom_status")).error, true, "mom_status refused");
      ok(!(await tool(alpha.member, A, "maple_status")).text.includes("Dana"), "maple_status leaves her out");

      eq((await set(alpha.member, "view")).status, 200, "read only");
      const state = (await call(routes.state.GET, "/api/maple/state", { id: alpha.member, fam: A })).body as { care?: { access: Record<string, boolean> } };
      eq(state.care?.access, { self: false, read: true, write: false, private: false, mood: false, therapist: false, manage: false }, "the app reads it, read only");
      eq((await call(routes.care.POST, "/api/maple/care/entries", { id: alpha.member, fam: A }, { method: "POST", body: { kind: "question", note: "Made-up question", client_id: "people-check-q1" } })).status, 403, "no adding");
      eq((await tool(alpha.member, A, "mom_status")).error, false, "mom_status reads");
      const write = await tool(alpha.member, A, "log_mom_medicine", { medicine: "Ibuprofen" });
      ok(write.error && /can see her mom's page but not change it/.test(write.text), "log_mom_medicine refused, saying why");

      eq((await set(alpha.member, "log")).status, 200, "back to everything");
      eq(await careOf(alpha.member), null, "the role's own default stores as nothing");
    });

    await test(`${shape}: only owners set it, never for themselves, and never more than the role allows`, async () => {
      const patch = (as: { id: string; fam: number }, body: unknown) => call(routes.members.PATCH, "/api/maple/members", as, { method: "PATCH", body });
      eq((await patch({ id: alpha.member, fam: A }, { email: alpha.viewer, care: "view" })).status, 403, "a member");
      const viewerLog = await patch(owner, { email: alpha.viewer, care: "log" });
      eq([viewerLog.status, /at most see mom's page/.test(String(viewerLog.body.error))], [400, true], "a viewer can't log on her page");
      eq((await patch(owner, { email: alpha.owner, care: "none" })).status, 400, "not your own");
      eq((await patch(owner, { email: alpha.member, care: "everything" })).status, 400, "only none, view or log");
      eq((await patch({ id: beta.owner, fam: B }, { email: alpha.member, care: "none" })).status, 400, "another family's member");
      eq(await careOf(alpha.member), null, "nothing changed for Alpha's member");
      // Her page's own account, as a member (the seed's page is under a plain name): nobody can narrow it.
      const her = alpha.care!.person;
      await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES ($1, $2, 'member', 'Dana', NOW())`, [A, her]);
      try {
        const hers = await tool(alpha.owner, A, "change_access", { person: her, mom_page: "view", confirmed: true });
        ok(hers.error && /her own page/.test(hers.text), "never her own page, from a connector");
        const fam = { familyId: A, babyId: alpha.babyId, tz: alpha.tz, member: alpha.owner, role: "owner" as const, status: "active" as const };
        let refused = "";
        try {
          await people.changeAccess(fam, { email: alpha.owner, role: "owner", display_name: "Avery" }, her, { care: "none" });
        } catch (error) {
          refused = (error as Error).message;
        }
        eq(refused, "It's her own page, so she always has it", "nor from People settings");
        eq(await careOf(her), null);
      } finally {
        await sql(`DELETE FROM maple_members WHERE family_id = $1 AND email = $2`, [A, her]);
      }
    });

    await test(`${shape}: a viewer an owner lets see her page reads it in the app, the MCP and Siri, and logs nothing there`, async () => {
      eq((await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.viewer, care: "view" } })).status, 200);
      const state = (await call(routes.state.GET, "/api/maple/state", { id: alpha.viewer, fam: A })).body as { care?: { access: { read: boolean; write: boolean } } };
      eq([state.care?.access.read, state.care?.access.write], [true, false], "the app");
      eq((await tool(alpha.viewer, A, "mom_status")).error, false, "the MCP");
      const token = "maple_peopleCheckViewerTokenMadeUp0123";
      await sql(`INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES ($1, $2, $3, 'Made-up')`, [A, alpha.viewer, sha256(token)]);
      eq((await siri(token, { action: "mom_status" })).status, 200, "Siri reads her status");
      eq((await siri(token, { action: "mom_dose", med: "p10000001" })).status, 403, "and never logs a dose");
      eq((await siri(token, { action: "pee" })).status, 403, "nor the baby's log");
      await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.viewer, care: null } });
      const hidden = await siri(token, { action: "mom_status" });
      eq([hidden.status, hidden.body.speak], [403, "You have view-only access to Maple's log."], "back to the default: as before");
    });

    await test(`${shape}: list_people shows owners ids and waiting invites, and everyone else names and access only`, async () => {
      const mine = await tool(alpha.owner, A, "list_people");
      const people = mine.json.people as { id?: string; access: string; mom_page?: string }[];
      eq(people.map((p) => [p.id, p.access, p.mom_page]), [[alpha.owner, "owner", "log"], [alpha.member, "log", "log"], [alpha.viewer, "view", "none"]], "owner's view");
      eq((mine.json.invites as { id: string }[]).map((i) => i.id), [`i${alpha.inviteId}`], "Alpha's own invite only");
      const theirs = await tool(alpha.viewer, A, "list_people");
      ok(!theirs.text.includes("@") && !("invites" in theirs.json), "no emails or invites for a viewer");
      ok(!("mom_page" in (((await tool(beta.owner, B, "list_people")).json.people as Record<string, unknown>[])[0])), "no page, no level");
    });

    await test(`${shape}: invite_person: owners only, read back before anything is sent, and the level rides with the invite`, async () => {
      const refused = await tool(alpha.member, A, "invite_person", { email: "aunt.alpha@example.com", access: "log", confirmed: true });
      ok(refused.error && /Only an owner/.test(refused.text), "a member");
      const preview = await tool(alpha.owner, A, "invite_person", { email: "Aunt.Alpha@Example.com", access: "log", mom_page: "none", name: "Aunt" });
      eq([preview.error, preview.json.confirm_needed, /Read this back/.test(preview.text)], [false, true, true], "a preview first");
      eq((await sql(`SELECT 1 FROM maple_members WHERE email = 'aunt.alpha@example.com'`)).length, 0, "nothing added yet");
      const added = await tool(alpha.owner, A, "invite_person", { email: "aunt.alpha@example.com", access: "log", mom_page: "none", name: "Aunt", confirmed: true });
      eq([added.error, added.json.added], [false, true], "family 1 adds the address at once");
      eq((await sql(`SELECT role, care_access, display_name FROM maple_members WHERE family_id = $1 AND email = 'aunt.alpha@example.com'`, [A]))[0], { role: "member", care_access: "none", display_name: "Aunt" });
      eq((await tool(alpha.owner, A, "invite_person", { email: "aunt.alpha@example.com", access: "view", confirmed: true })).json.already, true, "someone already here: nothing changes");
      eq((await tool(alpha.owner, A, "invite_person", { email: "x.alpha@example.com", access: "view", mom_page: "log", confirmed: true })).error, true, "a viewer can't be given more than view");

      const chat = await tool(beta.owner, B, "invite_person", { email: "aunt.beta@example.com", access: "view", mom_page: "view" }, "chat");
      eq([chat.error, chat.json.invited, chat.json.emailed, "link" in chat.json], [false, true, false, false], "in the chat its card was the yes, and the link stays off the model's text");
      const card = chat.structured.invite_link as { url: string } | undefined;
      ok(card && card.url.includes("#join="), "the link rides on the card");
      eq((await sql(`SELECT role, email, care_access FROM maple_invites WHERE family_id = $1 AND email = 'aunt.beta@example.com'`, [B]))[0], { role: "viewer", email: "aunt.beta@example.com", care_access: "view" }, "Beta's invite");
      eq((await sql(`SELECT 1 FROM maple_members WHERE family_id = $1 AND email = 'aunt.beta@example.com'`, [B])).length, 0, "no member until they take it up");
      const joined = await joinByInvite({ email: "aunt.beta@example.com", name: "Aunt Beta" }, card!.url.split("#join=")[1]);
      eq(joined.familyId, B, "taken up by that address");
      eq((await sql(`SELECT role, care_access FROM maple_members WHERE family_id = $1 AND email = 'aunt.beta@example.com'`, [B]))[0], { role: "viewer", care_access: "view" }, "the level came with them");

      const connector = await tool(beta.owner, B, "invite_person", { email: "uncle.beta@example.com", access: "photos", confirmed: true });
      ok(typeof connector.json.link === "string" && String(connector.json.link).includes("#join="), "over a connector, with email off, the link is in the result to send");
    });

    await test(`${shape}: change_access and remove_person read back first, stay in their own family, and never touch owners`, async () => {
      const preview = await tool(alpha.owner, A, "change_access", { person: "Blake", mom_page: "view" });
      eq([preview.json.confirm_needed, await careOf(alpha.member)], [true, null], "a preview changes nothing");
      const changed = await tool(alpha.owner, A, "change_access", { person: "Blake", mom_page: "view", confirmed: true });
      eq([changed.error, changed.json.mom_page, await careOf(alpha.member)], [false, "view", "view"], "changed");
      const promoted = await tool(alpha.owner, A, "change_access", { person: alpha.viewer, access: "log", confirmed: true });
      eq([promoted.json.access, promoted.json.mom_page], ["log", "log"], "a viewer made a member gets the member's default");
      await tool(alpha.owner, A, "change_access", { person: alpha.viewer, access: "view", confirmed: true });
      eq((await tool(beta.owner, B, "change_access", { person: "Blake", mom_page: "none", confirmed: true })).error, true, "Beta's owner can't find Alpha's member");
      eq((await tool(alpha.owner, A, "change_access", { person: alpha.owner, access: "view", confirmed: true })).error, true, "not yourself");
      eq((await tool(alpha.owner, A, "change_access", { person: "Blake", confirmed: true })).error, true, "something to change");
      eq((await tool(alpha.member, A, "remove_person", { person: alpha.viewer, confirmed: true })).error, true, "a member can't remove anyone");
      const removePreview = await tool(alpha.owner, A, "remove_person", { person: "aunt.alpha@example.com" });
      eq([removePreview.json.confirm_needed, (await sql(`SELECT 1 FROM maple_members WHERE email = 'aunt.alpha@example.com'`)).length], [true, 1], "a preview removes nobody");
      eq((await tool(alpha.owner, A, "remove_person", { person: "aunt.alpha@example.com" }, "chat")).json.removed, true, "removed (the chat's tap)");
      eq((await sql(`SELECT 1 FROM maple_removed WHERE family_id = $1 AND email = 'aunt.alpha@example.com'`, [A])).length, 1, "with a tombstone");
      eq((await tool(alpha.owner, A, "remove_person", { person: alpha.owner, confirmed: true })).error, true, "not yourself");
      await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES ($1, 'co.owner.alpha@example.com', 'owner', 'Co Owner', NOW())`, [A]);
      eq((await tool(alpha.owner, A, "remove_person", { person: "co.owner.alpha@example.com", confirmed: true })).error, true, "never another owner");
      eq((await tool(alpha.owner, A, "change_access", { person: "co.owner.alpha@example.com", mom_page: "none", confirmed: true })).error, true, "owners always have everything");
    });

    await test(`${shape}: cancel_invite takes an id or an address, in its own family only`, async () => {
      eq((await tool(beta.owner, B, "cancel_invite", { invite: `i${alpha.inviteId}` })).error, true, "Alpha's invite from Beta");
      eq((await sql(`SELECT 1 FROM maple_invites WHERE id = $1`, [alpha.inviteId])).length, 1, "still there");
      eq((await tool(alpha.owner, A, "cancel_invite", { invite: `i${alpha.inviteId}` })).json.cancelled, `i${alpha.inviteId}`, "by id");
      eq((await tool(beta.owner, B, "cancel_invite", { invite: "uncle.beta@example.com" })).error, false, "by address");
      eq((await sql(`SELECT 1 FROM maple_invites WHERE family_id = $1 AND email = 'uncle.beta@example.com'`, [B])).length, 0);
      eq((await tool(beta.member, B, "cancel_invite", { invite: `i${beta.inviteId}` })).error, true, "owners only");
    });

    await test(`${shape}: the members and invites routes take her page's level too`, async () => {
      const post = await call(routes.members.POST, "/api/maple/members", { id: beta.owner, fam: B }, { method: "POST", body: { email: "sitter.beta@example.com", role: "member", care: "none" } });
      eq(post.status, 201, "an invite by address");
      eq((await sql(`SELECT care_access FROM maple_invites WHERE family_id = $1 AND email = 'sitter.beta@example.com'`, [B]))[0], { care_access: "none" });
      eq((await call(routes.members.POST, "/api/maple/members", { id: beta.owner, fam: B }, { method: "POST", body: { email: "sitter2.beta@example.com", role: "photos", care: "view" } })).status, 400, "photos-only never sees her page");
      const link = await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Neighbor", role: "viewer", care: "view" } });
      eq(link.status, 201, "a one-time link");
      eq((link.body.invite as { care?: string }).care, "view", "listed with its level");
      eq((await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Neighbor", role: "viewer", care: "log" } })).status, 400);
      eq((await call(routes.invites.POST, "/api/maple/invites", owner, { method: "POST", body: { display_name: "Neighbor", role: "member", care: "log" } })).status, 201, "a member's link at the member's default");
      eq((await sql(`SELECT care_access FROM maple_invites WHERE family_id = $1 AND display_name = 'Neighbor' AND role = 'member'`, [A]))[0], { care_access: null }, "the role's own default stores as nothing");
    });

    await test(`${shape}: chats that ran with her page open close to someone it's hidden from, and stay`, async () => {
      for (const [id, open] of [["thread_people_open", true], ["thread_people_closed", false]] as const) {
        await sql(`INSERT INTO maple_chat_threads (family_id, id, member, title, model, care_open) VALUES ($1, $2, $3, 'Made-up', 'zai/glm-5.3-flash', $4)`, [A, id, alpha.member, open]);
        await sql(`INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts) VALUES ($1, $2, $3, $4, 1, 'user', '[{"type":"text","text":"Made-up"}]')`, [A, `msg_${id}`, id, alpha.member]);
      }
      const ids = async (care?: "none" | "view") => (await chatStream({ familyId: A }, alpha.member, threadAccess({ role: "member", ...(care ? { care } : {}) }), null)).items.map((i) => i.message.id).sort();
      eq(await ids(), ["msg_thread_people_closed", "msg_thread_people_open"], "everything while it's open to them");
      eq(await ids("view"), ["msg_thread_people_closed", "msg_thread_people_open"], "and while they can see it");
      eq(await ids("none"), ["msg_thread_people_closed"], "hidden: only chats that never had it");
      eq(await deleteChats({ familyId: A }, alpha.member, threadAccess({ role: "member", care: "none" })), 1, "deleting takes only what they can open");
      eq(await ids(), ["msg_thread_people_open"], "the rest waits, unread, in case an owner opens her page again");
      // A viewer's own chats never had her page (the chat never opens it to a viewer), though older rows read care_open by default.
      await sql(`INSERT INTO maple_chat_threads (family_id, id, member, title, model, viewer_only) VALUES ($1, 'thread_people_viewer', $2, 'Made-up', 'zai/glm-5.3-flash', TRUE)`, [A, alpha.viewer]);
      await sql(`INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts) VALUES ($1, 'msg_people_viewer', 'thread_people_viewer', $2, 1, 'user', '[{"type":"text","text":"Made-up"}]')`, [A, alpha.viewer]);
      eq((await chatStream({ familyId: A }, alpha.viewer, threadAccess({ role: "viewer" }), null)).items.map((i) => i.message.id), ["msg_people_viewer"], "a viewer keeps their chats");
    });

    await test(`${shape}: undo_last leaves her entries alone once someone can't change her page`, async () => {
      await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, care: null } });
      const logged = await tool(alpha.member, A, "log_mom_medicine", { medicine: "Ibuprofen" });
      eq(logged.error, false, "logged while they could");
      const before = await sql(`SELECT id FROM maple_care_entries WHERE family_id = $1 AND created_by = $2 AND deleted_at IS NULL`, [A, alpha.member]);
      eq(before.length, 1);
      await call(routes.members.PATCH, "/api/maple/members", owner, { method: "PATCH", body: { email: alpha.member, care: "view" } });
      const undo = await tool(alpha.member, A, "undo_last");
      ok(!/Removed c/.test(undo.text), "nothing of hers removed");
      eq((await sql(`SELECT deleted_at FROM maple_care_entries WHERE id = $1`, [before[0].id]))[0].deleted_at, null, "her dose stays");
    });
  }

  done("people-tools.check.ts");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

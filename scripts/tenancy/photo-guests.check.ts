import { NextRequest } from "next/server";
import { done, eq, freshDb, ok, seedFamilies, sql, test } from "./harness";
import { createInvite, listMembers, redeemInvite, sealSession, SESSION_COOKIE, updateMember } from "../../src/lib/maple/auth";
import { familyForAuth, familyForRow, resolveFamily } from "../../src/lib/maple/family";
import { deliver, liveSubs, TEST_NOTICE } from "../../src/lib/maple/push";
import { mintAccessToken, mintRefreshToken } from "../../src/lib/mcp/auth";
import { POST as oauthToken } from "../../src/app/oauth/token/route";
import { POST as mcp } from "../../src/app/api/maple/[transport]/route";
import { context } from "../../src/lib/maple/mcp-tools";
import { familyChoices } from "../../src/lib/maple/family/switch";
import { joinByInvite } from "../../src/lib/maple/family/create";
import { GET as state } from "../../src/app/api/maple/state/route";
import * as entries from "../../src/app/api/maple/entries/route";
import * as members from "../../src/app/api/maple/members/route";
import * as invites from "../../src/app/api/maple/invites/route";
import { POST as quick } from "../../src/app/api/maple/quick/route";
import { GET as care } from "../../src/app/api/maple/care/entries/route";
import { GET as chat } from "../../src/app/api/maple/chat/route";
import { GET as exportCsv } from "../../src/app/api/maple/export/route";
import { GET as consent } from "../../src/app/api/maple/chat/consent/route";
import { GET as tokens } from "../../src/app/api/maple/tokens/route";
import { GET as chatImage } from "../../src/app/api/maple/chat/images/route";
import { POST as timer } from "../../src/app/api/maple/timer/route";
import { GET as push } from "../../src/app/api/maple/push/route";
import type { MapleState } from "../../src/lib/maple/types";

process.env.MCP_SECRET = "synthetic-photo-guest-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "synthetic-photo-guest-session-secret";
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.QSTASH_TOKEN;

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  const guest = "photo.guest@example.com";
  await sql(`INSERT INTO maple_members (family_id, email, role, display_name, accepted_at) VALUES (2, $1, 'photos', 'Guest', NOW())`, [guest]);
  await sql(`UPDATE maple_babies SET settings = '{"private_setting":"private-value"}', birth_weight_g = 3200 WHERE id = $1`, [beta.babyId]);
  const req = (path: string, member = guest, family = 2, method = "GET", body?: unknown) => new NextRequest(`http://localhost:3000/api/maple/${path}`, {
    method, headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealSession(member, family))}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = async (handler: (request: NextRequest) => Promise<Response>, path: string, member = guest, family = 2, method = "GET", body?: unknown) => {
    const response = await handler(req(path, member, family, method, body));
    return { response, status: response.status, body: await response.json() };
  };

  await test("photo guests receive only a sanitized album state, with no health changes in its revision", async () => {
    const first = await call(state, "state");
    const s = first.body as MapleState;
    eq([first.status, s.me.role, s.entries, s.growth, s.lifetime, s.care], [200, "photos", [], [], { diapers: 0, feeds: 0 }, undefined]);
    eq([s.baby.birth_weight_g, s.baby.birth_length_cm, s.baby.birth_head_cm, s.baby.due_date, s.baby.settings], [null, null, null, null, {}]);
    ok(!JSON.stringify(s).includes(beta.owner), "another member's address is private");
    await sql(`UPDATE maple_entries SET updated_at = NOW(), note = 'Synthetic private health note' WHERE id = $1`, [beta.entries.diaper]);
    const unchanged = await call(state, `state?rev=${encodeURIComponent(s.rev)}`);
    eq(unchanged.body.unchanged, true);
  });

  await test("album entry queries cannot widen to health logs, removed entries, or other families", async () => {
    const result = await call(entries.GET, "entries?kind=moment");
    eq(result.status, 200);
    eq(result.body.entries.map((e: { id: number }) => e.id), [beta.entries.moment]);
    ok(!JSON.stringify(result.body).includes(beta.owner), "photo attribution hides member addresses");
    const s = (await call(state, "state")).body as MapleState;
    ok(s.members.some((m) => m.email === result.body.entries[0].created_by && m.display_name === "Emery"), "album attribution matches display metadata");
    for (const path of ["entries", "entries?kind=diaper", "entries?kind=moment,diaper", "entries?kind=moment&deleted=1"]) {
      eq((await call(entries.GET, path)).status, 403, path);
    }
    eq((await call(entries.GET, "entries?kind=moment", guest, 1)).status, 401);
  });

  await test("photo guests cannot use health, chat, export, token, push, or write endpoints", async () => {
    for (const [handler, path, method, body] of [
      [chat, "chat", "GET"], [exportCsv, "export", "GET"], [consent, "chat/consent", "GET"],
      [tokens, "tokens", "GET"], [chatImage, "chat/images?id=synthetic", "GET"], [push, "push", "GET"],
      [entries.POST, "entries", "POST", { kind: "moment", data: { title: "Synthetic moment" } }],
      [entries.PATCH, `entries?id=${beta.entries.moment}`, "PATCH", { note: "Changed" }],
      [entries.DELETE, `entries?id=${beta.entries.moment}`, "DELETE"], [timer, "timer", "POST", { action: "start", kind: "sleep" }],
    ] as const) eq((await handler(req(path, guest, 2, method, body))).status, 403, path);
  });

  await test("downgrading a member replaces the broad snapshot even with its previous revision", async () => {
    const before = await call(state, "state", beta.member);
    await updateMember({ familyId: 2 }, beta.member, { role: "photos" });
    const after = await call(state, `state?rev=${encodeURIComponent(before.body.rev)}`, beta.member);
    eq([after.body.me?.role, after.body.unchanged, after.body.entries], ["photos", undefined, []]);
    await sql(`UPDATE maple_members SET role = 'member' WHERE family_id = 2 AND email = $1`, [beta.member]);
  });

  await test("photo guests keep their own profile and family switcher without exposing other addresses", async () => {
    const result = await call(members.PATCH, "members", guest, 2, "PATCH", { display_name: "Guest New" });
    eq(result.status, 200);
    eq(result.body.members.find((m: { email: string }) => m.email === guest)?.display_name, "Guest New");
    ok(!JSON.stringify(result.body).includes(beta.owner), "profile response keeps other addresses private");
    eq((await familyChoices(guest, 2))?.[0]?.role, "photos");
    eq((await call(members.PATCH, "members", guest, 2, "PATCH", { email: beta.owner, display_name: "No" })).status, 403);
    eq((await call(members.PATCH, "members", guest, 2, "PATCH", { role: "member" })).status, 403);
  });

  await test("one-time and addressed invitations preserve photos-only access", async () => {
    const created = await call(invites.POST, "invites", beta.owner, 2, "POST", { display_name: "Photo Relative", role: "photos" });
    eq(created.body.invite.role, "photos");
    const redeemed = await redeemInvite(created.body.url.split("#")[1]);
    ok(redeemed && typeof redeemed === "object", "link redeemed");
    eq((await resolveFamily((redeemed as { id: string }).id, 2))?.role, "photos");
    const addressed = await createInvite({ familyId: 2 }, { role: "photos", displayName: "Photo Friend", emoji: null, createdBy: beta.owner, email: "photo.friend@example.com" });
    const joined = await joinByInvite({ email: "photo.friend@example.com", name: "Photo Friend" }, addressed.token);
    eq("familyId" in joined ? joined.familyId : null, 2);
    eq((await resolveFamily("photo.friend@example.com", 2))?.role, "photos");
  });

  await test("existing assistant and Siri grants stop immediately after a photos-only downgrade", async () => {
    await sql(`UPDATE maple_members SET role = 'photos' WHERE family_id = 2 AND email = $1`, [beta.owner]);
    eq(await familyForAuth({ sub: `maple:${beta.owner}`, fam: 2 }), null);
    const grant = { sub: `maple:${beta.owner}`, fam: 2, scope: "maple", client_id: "synthetic-client", resource: "http://localhost:3000/api/maple/mcp" };
    const refreshed = await oauthToken(new NextRequest("http://localhost:3000/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: mintRefreshToken(grant) }) }));
    eq([refreshed.status, (await refreshed.json()).error], [400, "invalid_grant"]);
    const connection = await mcp(new Request(grant.resource, { method: "POST", headers: { authorization: `Bearer ${mintAccessToken(grant)}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }));
    eq(connection.status, 401);
    eq(await familyForRow({ member: beta.owner, family_id: 2 }), null);
    let blocked = false;
    try { await context({ authInfo: { extra: { sub: `maple:${beta.owner}`, fam: 2 } } } as unknown as Parameters<typeof context>[0]); } catch { blocked = true; }
    ok(blocked, "tools recheck role");
    const response = await quick(new NextRequest("http://localhost:3000/api/maple/quick", { method: "POST", headers: { authorization: `Bearer ${beta.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "status" }) }));
    eq(response.status, 401);
    await sql(`UPDATE maple_members SET role = 'owner' WHERE family_id = 2 AND email = $1`, [beta.owner]);
  });

  await test("a downgraded member cannot receive saved health notifications or read the care page", async () => {
    const savedPhone = (await liveSubs({ familyId: 1 }))[0];
    await sql(`UPDATE maple_members SET role = 'photos' WHERE family_id = 1 AND email = $1`, [alpha.owner]);
    eq(await deliver(savedPhone, TEST_NOTICE, { key: "synthetic-downgrade", ttlS: 60 }), "stopped");
    eq((await liveSubs({ familyId: 1 })).length, 0);
    eq((await call(care, "care/entries", alpha.owner, 1)).status, 404);
    eq((await listMembers({ familyId: 1 })).find((m) => m.email === alpha.owner)?.role, "photos");
  });
  done("photo guests");
}
main().catch((error) => { console.error(error); process.exit(1); });

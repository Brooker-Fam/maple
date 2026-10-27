import {
  carrierFamily,
  effectiveSignupMode,
  familiesOf,
  familyForAuth,
  familyForRow,
  familyForSession,
  familyScope,
  familyScopes,
  memberIdFromSub,
  olderCopyActive,
  resolveFamily,
  sameFamily,
  secretBlockers,
  signupBlockers,
  signupMode,
} from "../../src/lib/maple/family";
import { done, eq, freshDb, ok, seedFamilies, sha256, sql, test } from "./harness";

/**
 * How a request finds its family (src/lib/maple/family.ts): every carrier,
 * the old ones without `fam` included, on both schema shapes; the jobs'
 * per-family scopes; and the sign-up switch.
 */

const pick = (ctx: Awaited<ReturnType<typeof resolveFamily>>) => ctx && [ctx.familyId, ctx.member, ctx.role, ctx.tz, ctx.status];

async function pure() {
  await test("carrierFamily: no fam means family 1; a malformed one opens nothing", () => {
    eq([undefined, null, 1, 2, "2"].map(carrierFamily), [1, 1, 1, 2, 2]);
    eq([0, -1, 1.5, "2x", "02", "", {}, [2], true, Number.MAX_VALUE].map(carrierFamily), Array(10).fill(null));
  });

  await test("memberIdFromSub: maple:<email> and admin only", () => {
    eq(["maple:a@example.com", "admin", "maple:", "a@example.com", "", 7, undefined].map(memberIdFromSub), ["a@example.com", "admin", null, null, null, null, null]);
  });

  await test("MAPLE_SIGNUP: invite or open, everything else (unset included) is off", () => {
    eq([undefined, "", "off", "closed", "yes", "true", "invite", " OPEN ", "Invite"].map(signupMode), ["off", "off", "off", "off", "off", "off", "invite", "open", "invite"]);
  });

  await test("sameFamily: another family's row, a row without family_id and no row all read as missing", () => {
    eq([sameFamily({ family_id: "2" }, { familyId: 2 }, "t"), sameFamily({ family_id: "2" }, { familyId: 1 }, "t"), sameFamily({}, { familyId: 1 }, "t"), sameFamily(null, { familyId: 1 }, "t")], [true, false, false, false]);
  });
}

async function carriers() {
  for (const shape of ["production", "final"] as const) {
    await freshDb({ shape });
    const { alpha, beta } = await seedFamilies();

    await test(`${shape}: a carrier from before families (no fam) opens family 1 for a family-1 member`, async () => {
      eq(pick(await familyForSession({ id: alpha.owner })), [1, alpha.owner, "owner", "America/Chicago", "active"]);
      eq(pick(await familyForAuth({ sub: `maple:${alpha.viewer}` })), [1, alpha.viewer, "viewer", "America/Chicago", "active"]);
    });

    await test(`${shape}: a carrier from before families never opens another family, even the person's only one`, async () => {
      eq(await familyForSession({ id: beta.owner }), null);
      eq(await familyForAuth({ sub: `maple:${beta.member}` }), null);
    });

    await test(`${shape}: fam names the family; a member of another family gets nothing`, async () => {
      eq(pick(await familyForSession({ id: beta.owner, fam: 2 })), [2, beta.owner, "owner", "America/Los_Angeles", "active"]);
      eq(pick(await familyForAuth({ sub: `maple:${beta.member}`, fam: "2" })), [2, beta.member, "member", "America/Los_Angeles", "active"]);
      eq(await familyForSession({ id: alpha.owner, fam: 2 }), null);
      eq(await familyForSession({ id: beta.owner, fam: 1 }), null);
      eq(await familyForSession({ id: beta.owner, fam: 999 }), null);
      eq(await familyForSession({ id: beta.owner, fam: "two" }), null);
    });

    await test(`${shape}: the context carries the family's active baby`, async () => {
      eq((await familyForSession({ id: alpha.owner }))?.babyId, alpha.babyId);
      eq((await familyForSession({ id: beta.owner, fam: 2 }))?.babyId, beta.babyId);
    });

    await test(`${shape}: a Siri token and an invite resolve through their own row's family`, async () => {
      const row = async (token: string) => (await sql(`SELECT member, family_id FROM maple_tokens WHERE token_hash = $1`, [sha256(token)]))[0];
      eq(pick(await familyForRow(await row(alpha.token))), [1, alpha.owner, "owner", "America/Chicago", "active"]);
      eq(pick(await familyForRow(await row(beta.token))), [2, beta.owner, "owner", "America/Los_Angeles", "active"]);
      eq(await familyForRow({ member: beta.owner, family_id: 1 }), null);
      eq(await familyForRow({ member: alpha.owner, family_id: null }), null);
      const [invite] = await sql(`SELECT family_id FROM maple_invites WHERE id = $1`, [beta.inviteId]);
      eq(invite.family_id, "2");
    });

    await test(`${shape}: jobs get one family at a time, never a family being deleted`, async () => {
      eq(await familyScopes(), [
        { familyId: 1, babyId: alpha.babyId, tz: "America/Chicago" },
        { familyId: 2, babyId: beta.babyId, tz: "America/Los_Angeles" },
      ]);
      eq(await familyScope("2"), { familyId: 2, babyId: beta.babyId, tz: "America/Los_Angeles" });
      await sql(`UPDATE maple_families SET status = 'deleting' WHERE id = 2`);
      eq(await familyScope(2), null);
      eq((await familyScopes()).map((s) => s.familyId), [1]);
      eq(await familyForSession({ id: beta.owner, fam: 2 }), null);
      await sql(`UPDATE maple_families SET status = 'active' WHERE id = 2`);
    });

    await test(`${shape}: the admin login opens only its own family`, async () => {
      await sql(`INSERT INTO maple_members (family_id, email, role, display_name) VALUES (1, 'admin', 'owner', 'Admin')`);
      eq((await familyForAuth({ sub: "admin" }))?.familyId, 1);
      eq(await familyForAuth({ sub: "admin", fam: 2 }), null);
      process.env.MAPLE_ADMIN_FAMILY_ID = "2";
      try {
        eq(await familyForAuth({ sub: "admin" }), null);
      } finally {
        delete process.env.MAPLE_ADMIN_FAMILY_ID;
      }
    });
  }

  await test("final: someone in two families opens each by its fam, and lists both", async () => {
    await freshDb({ shape: "final" });
    const { alpha } = await seedFamilies();
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES (2, $1, 'viewer', NOW())`, [alpha.owner]);
    eq((await familyForSession({ id: alpha.owner }))?.role, "owner");
    eq((await familyForSession({ id: alpha.owner, fam: 2 }))?.role, "viewer");
    eq((await familiesOf(alpha.owner)).map((f) => [f.familyId, f.role]), [[1, "owner"], [2, "viewer"]]);
  });

  await test("a family still onboarding resolves (its routes decide what it may do); an archived baby is skipped", async () => {
    await freshDb({ shape: "final" });
    const { alpha, beta } = await seedFamilies();
    await sql(`UPDATE maple_families SET status = 'onboarding' WHERE id = 2`);
    eq((await familyForSession({ id: beta.owner, fam: 2 }))?.status, "onboarding");
    const [younger] = await sql(`INSERT INTO maple_babies (family_id, name, timezone) VALUES (1, 'Second Test', 'America/Chicago') RETURNING id`);
    await sql(`UPDATE maple_babies SET archived_at = NOW() WHERE id = $1`, [alpha.babyId]);
    eq((await familyForSession({ id: alpha.owner }))?.babyId, Number(younger.id));
  });

  await test("a family with no baby yet reads its own timezone", async () => {
    await freshDb({ shape: "final" });
    await seedFamilies();
    const [fam] = await sql(`INSERT INTO maple_families (timezone, status) VALUES ('America/Phoenix', 'onboarding') RETURNING id`);
    await sql(`INSERT INTO maple_members (family_id, email, role, accepted_at) VALUES ($1, 'new.owner@example.com', 'owner', NOW())`, [fam.id]);
    const ctx = await familyForSession({ id: "new.owner@example.com", fam: Number(fam.id) });
    eq([ctx?.babyId, ctx?.tz], [null, "America/Phoenix"]);
  });

  await test("no database: nobody resolves and jobs see no families", async () => {
    process.env.DATABASE_URL = "";
    eq([await resolveFamily("a@example.com", 1), await familyScopes(), await familyScope(1)], [null, [], null]);
  });
}

async function signup() {
  await test("sign-up stays off on the production shape whatever MAPLE_SIGNUP says (a forgotten family_id would land in family 1)", async () => {
    await freshDb();
    const blockers = await signupBlockers();
    eq(blockers?.length, 15);
    ok(blockers?.every((b) => b.endsWith("has a default")), "every blocker is a default");
    process.env.MAPLE_SIGNUP = "open";
    try {
      eq(await effectiveSignupMode(), "off");
    } finally {
      delete process.env.MAPLE_SIGNUP;
    }
  });

  const MAPLE_ONLY = { MCP_SECRET: "made-up-maple-mcp-secret", MAPLE_SESSION_SECRET: "made-up-maple-session-secret", GOOGLE_CLIENT_SECRET: "made-up-google-secret", ADMIN_PASS: "made-up-pass" };
  const withEnv = async <T,>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
    const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    const set = (vals: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(vals)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    set(env);
    try {
      return await fn();
    } finally {
      set(before);
    }
  };

  await test("signing keys someone outside Maple holds keep sign-up off", () => {
    eq(secretBlockers(MAPLE_ONLY), []);
    eq(secretBlockers({ ...MAPLE_ONLY, MCP_SECRET: undefined }), ["MCP_SECRET: not set"]);
    eq(secretBlockers({ ...MAPLE_ONLY, MCP_SECRET: "brooker-mcp:made-up-pass" }), ["MCP_SECRET: derived from ADMIN_PASS"]);
    eq(secretBlockers({ ...MAPLE_ONLY, MAPLE_SESSION_SECRET: " " }), ["MAPLE_SESSION_SECRET: not set"]);
    eq(secretBlockers({ ...MAPLE_ONLY, MAPLE_SESSION_SECRET: "made-up-google-secret" }), ["MAPLE_SESSION_SECRET: same as GOOGLE_CLIENT_SECRET"]);
  });

  await test("on the final shape with shared keys, MAPLE_SIGNUP=open stays off", async () => {
    await freshDb({ shape: "final" });
    for (const missing of ["MCP_SECRET", "MAPLE_SESSION_SECRET"]) {
      eq(await withEnv({ ...MAPLE_ONLY, [missing]: undefined, MAPLE_SIGNUP: "open" }, effectiveSignupMode), "off", `without ${missing}`);
    }
  });

  await test("an older copy of Maple sending notices in the last week keeps sign-up off", async () => {
    await freshDb({ shape: "final" });
    const open = () => withEnv({ ...MAPLE_ONLY, MAPLE_SIGNUP: "open" }, effectiveSignupMode);
    eq([await olderCopyActive(), await open()], [false, "open"], "quiet");
    for (const key of ["s9|ok:1:2", "wake:4102444800"]) {
      await sql(`INSERT INTO maple_push_sent (key, sent_at) VALUES ($1, NOW() - INTERVAL '6 days')`, [key]);
      eq([await olderCopyActive(), await open()], [true, "off"], `a claim without a family: ${key}`);
      await sql(`UPDATE maple_push_sent SET family_id = 1 WHERE key = $1`, [key]);
      eq(await open(), "open", `the same claim filed under family 1: ${key}`);
      await sql(`UPDATE maple_push_sent SET family_id = NULL, sent_at = NOW() - INTERVAL '8 days' WHERE key = $1`, [key]);
      eq(await open(), "open", `a week old: ${key}`);
    }
  });

  await test("on the final shape with Maple's own keys the switch decides: unset is off, invite and open pass through", async () => {
    await freshDb({ shape: "final" });
    eq(await signupBlockers(), []);
    Object.assign(process.env, MAPLE_ONLY);
    const modes = [];
    for (const v of [undefined, "invite", "open"]) {
      if (v) process.env.MAPLE_SIGNUP = v;
      else delete process.env.MAPLE_SIGNUP;
      modes.push(await effectiveSignupMode());
    }
    delete process.env.MAPLE_SIGNUP;
    for (const k of Object.keys(MAPLE_ONLY)) delete process.env[k];
    eq(modes, ["off", "invite", "open"]);
  });

  await test("a family table that allows a null family_id blocks sign-up", async () => {
    await freshDb({ shape: "final" });
    await sql(`ALTER TABLE maple_tokens ALTER COLUMN family_id DROP NOT NULL`);
    eq(await signupBlockers(), ["maple_tokens: family_id allows null"]);
  });
}

async function keys() {
  const { openSession, sealSession } = await import("../../src/lib/maple/auth");
  const { mintNativeTicket, nativeChallengeFor, openNativeTicket } = await import("../../src/lib/maple/native-auth");
  const { openIntent, sealIntent } = await import("../../src/lib/maple/family/signup");
  const mcp = await import("../../src/lib/mcp/auth");
  const keep = ["GOOGLE_CLIENT_SECRET", "MAPLE_SESSION_SECRET", "MAPLE_SESSION_SECRET_PREV", "MCP_SECRET", "MCP_SECRET_PREV", "ADMIN_PASS"].map((k) => [k, process.env[k]] as const);
  const restore = () => {
    for (const [k, v] of keep) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const challenge = nativeChallengeFor("made-up-verifier-made-up-verifier-made-up-verifier");

  await test("after the switch to Maple's own session key, what the shared key sealed opens family 1 only, and only while _PREV is set", () => {
    try {
      process.env.GOOGLE_CLIENT_SECRET = "made-up-shared-google-secret";
      delete process.env.MAPLE_SESSION_SECRET;
      const old = { one: sealSession("a@example.com", 1), two: sealSession("b@example.com", 2), ticket2: mintNativeTicket("b@example.com", 2, "/maple", challenge) };
      const oldTicket1 = mintNativeTicket("a@example.com", 1, "/maple", challenge);
      const oldIntent = sealIntent({ kind: "join", invite: "made-up-invite-token-0123456789" });
      process.env.MAPLE_SESSION_SECRET = "made-up-maple-session-secret";
      process.env.MAPLE_SESSION_SECRET_PREV = "made-up-shared-google-secret";
      eq([openSession(old.one), openSession(old.two)], [{ id: "a@example.com", fam: 1 }, null], "old cookies");
      eq([openNativeTicket(oldTicket1)?.fam, openNativeTicket(old.ticket2)], [1, null], "old native tickets");
      eq(openIntent(oldIntent), null, "an old sign-up intent");
      const fresh = sealSession("b@example.com", 2);
      eq(openSession(fresh), { id: "b@example.com", fam: 2 }, "sealed with the new key");
      delete process.env.MAPLE_SESSION_SECRET;
      eq(openSession(fresh), null, "the shared key can't open it");
      process.env.MAPLE_SESSION_SECRET = "made-up-maple-session-secret";
      delete process.env.MAPLE_SESSION_SECRET_PREV;
      eq(openSession(old.one), null, "without _PREV");
    } finally {
      restore();
    }
  });

  await test("MCP tokens: the old key verifies family 1's only once MCP_SECRET is set, and with no key nothing mints or verifies", () => {
    try {
      delete process.env.MCP_SECRET;
      process.env.ADMIN_PASS = "made-up-admin-pass";
      const token = (fam?: number) => mcp.mintAccessToken({ sub: "maple:a@example.com", ...(fam === undefined ? {} : { fam }), scope: "maple", client_id: "made-up" });
      const old = { none: token(), one: token(1), two: token(2) };
      eq(mcp.verifyAccessToken(old.two)?.fam, 2, "before the switch the derived key still signs");
      process.env.MCP_SECRET = "made-up-maple-mcp-secret";
      process.env.MCP_SECRET_PREV = "brooker-mcp:made-up-admin-pass";
      eq([mcp.verifyAccessToken(old.none)?.sub, mcp.verifyAccessToken(old.one)?.fam, mcp.verifyAccessToken(old.two)], ["maple:a@example.com", 1, null], "old tokens");
      eq(mcp.verifyAccessToken(token(2))?.fam, 2, "a new one");
      delete process.env.MCP_SECRET_PREV;
      eq(mcp.verifyAccessToken(old.one), null, "without _PREV");
      delete process.env.MCP_SECRET;
      delete process.env.ADMIN_PASS;
      let threw = "";
      try {
        token(1);
      } catch (err) {
        threw = (err as Error).message;
      }
      eq([threw, mcp.verifyAccessToken(old.one)], ["mcp_secret_missing", null], "no key at all");
    } finally {
      restore();
    }
  });
}

pure()
  .then(carriers)
  .then(signup)
  .then(keys)
  .then(() => done("context.check.ts"));

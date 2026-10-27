import type { NextRequest } from "next/server";
import { done, eq, freshDb, ok, quietly, seedFamilies, sql, test, type Seed, type Shape } from "./harness";

delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.MAPLE_ALLOWED_EMAILS;
delete process.env.MAPLE_ADMIN_FAMILY_ID;
delete process.env.MAPLE_SIGNUP;
delete process.env.NEXT_PUBLIC_BASE_URL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;
process.env.MCP_SECRET = "email-check-maple-mcp-secret";
process.env.MAPLE_SESSION_SECRET = "email-check-maple-session-secret";
process.env.GOOGLE_CLIENT_ID = "made-up-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "email-check-secret-not-real";
process.env.ADMIN_USER = "made-up-admin";
process.env.ADMIN_PASS = "made-up-admin-pass";
process.env.MAPLE_SIGNUP_DAILY_MAX = "50";

const RESEND = { RESEND_API_KEY: "re_tenancy_check_not_a_key", RESEND_EMAIL_DOMAIN: "maplebaby.app" };
const BASE = "http://localhost:3000";

type Sent = { to: string; subject: string; text: string; html: string; key: string | null };
type Mode = "ok" | "refuse" | "throw";

const resend = { mode: "ok" as Mode, sent: [] as Sent[], seq: 0 };

function resendOn(): void {
  Object.assign(process.env, RESEND);
}
function resendOff(): void {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_EMAIL_DOMAIN;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch to ${url}`);
  if (resend.mode === "throw") throw new TypeError("fetch failed");
  if (resend.mode === "refuse") return new Response(JSON.stringify({ name: "internal_server_error", statusCode: 500, message: "made-up outage" }), { status: 500 });
  const body = JSON.parse(String(init?.body)) as { to: string; subject: string; text: string; html: string };
  resend.sent.push({ to: body.to, subject: body.subject, text: body.text, html: body.html, key: new Headers(init?.headers).get("idempotency-key") });
  return new Response(JSON.stringify({ id: `em_check_${++resend.seq}` }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../../src/lib/maple/auth");
  const { senderKey, INVITE_EMAILS_PER_DAY } = await import("../../src/lib/email/limit");
  const { setLaterRunner } = await import("../../src/lib/maple/push-hooks");
  setLaterRunner(() => {});
  const routes = {
    members: await import("../../src/app/api/maple/members/route"),
    invites: await import("../../src/app/api/maple/invites/route"),
  };

  type As = { id: string; fam?: number };
  const req = (path: string, as: As, init: { method?: string; body?: unknown } = {}): NextRequest =>
    new NextRequest(new URL(path, BASE), {
      method: init.method ?? "GET",
      headers: {
        cookie: `${auth.SESSION_COOKIE}=${encodeURIComponent(auth.sealSession(as.id, as.fam ?? 1))}`,
        "content-type": "application/json",
        "x-real-ip": "203.0.113.9",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const call = async (handler: (r: NextRequest) => Promise<Response>, path: string, as: As, init: { method?: string; body?: unknown } = {}) => {
    const res = await handler(req(path, as, init));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const addByEmail = (as: As, email: string, role = "member") => call(routes.members.POST, "/api/maple/members", as, { method: "POST", body: { email, role } });
  const reset = () => {
    resend.mode = "ok";
    resend.sent = [];
  };
  const owner = (s: Seed, f: "alpha" | "beta"): As => ({ id: s[f].owner, fam: s[f].familyId });

  for (const shape of ["production", "final"] as Shape[]) {
    await freshDb({ shape });
    const s = await seedFamilies();
    const { alpha, beta } = s;
    resendOn();

    await test(`${shape}: only addressed invites outside family 1 email their link, keyed by the invite`, async () => {
      reset();
      const direct = await addByEmail(owner(s, "alpha"), "new.alpha@example.com");
      eq([direct.status, direct.body.url, direct.body.emailed], [200, undefined, undefined], "the answer it always gave");
      eq(resend.sent.length, 0, "nothing sent");
      await sql(`DELETE FROM maple_members WHERE email = 'new.alpha@example.com'`);
      reset();
      for (const as of [owner(s, "alpha"), owner(s, "beta")]) {
        const made = await call(routes.invites.POST, "/api/maple/invites", as, { method: "POST", body: { display_name: "Night nurse", role: "viewer" } });
        eq([made.status, made.body.emailed], [201, undefined], `family ${as.fam}`);
      }
      eq(resend.sent.length, 0, "nothing sent");
      reset();
      const added = await addByEmail(owner(s, "beta"), "New.Beta@Example.com", "viewer");
      eq([added.status, added.body.emailed], [201, true], "emailed");
      const id = (added.body.invite as { id: number }).id;
      eq(resend.sent.length, 1, "one email");
      const [e] = resend.sent;
      eq([e.to, e.key], ["new.beta@example.com", `invite/${id}`], "to the address, keyed by the invite");
      eq(e.subject, "Emery invited you to Ro’s log on Maple", "Beta's own names");
      ok(e.text.includes(String(added.body.url)), "the same link the owner sees");
      ok(/until \w+day, \w+ \d{1,2} at \d{1,2}:\d\d [AP]M P[SD]T\./.test(e.text), `the expiry in Beta's zone: ${e.text}`);
      for (const name of [alpha.babyName, "June", "Avery", "Blake", "Dana", "Maple Jane", "Brittany"]) ok(!(e.subject + e.text + e.html).includes(name), `names ${name}`);
    });

    await test(`${shape}: asking again sends the new link under the new invite's key`, async () => {
      reset();
      const again = await addByEmail(owner(s, "beta"), "new.beta@example.com");
      const id = (again.body.invite as { id: number }).id;
      eq([again.status, again.body.emailed, resend.sent.map((e) => e.key)], [201, true, [`invite/${id}`]]);
      ok(resend.sent[0].text.includes(String(again.body.url)), "the new link");
      await sql(`DELETE FROM maple_invites WHERE email = 'new.beta@example.com'`);
    });

    await test(`${shape}: the cap is counted under the sender's hash, never an address`, async () => {
      const rows = await sql(`SELECT ip_hash, count FROM upload_rate_limit WHERE ip_hash = $1`, [senderKey(beta.owner)]);
      eq(rows.map((r) => Number(r.count)), [2], "two emails counted for Beta's owner");
      eq((await sql(`SELECT 1 FROM upload_rate_limit WHERE ip_hash LIKE '%@%'`)).length, 0, "no address stored");
    });

    await test(`${shape}: a sender at the day's cap gets the link to copy, and the invite is still made`, async () => {
      reset();
      await sql(`UPDATE upload_rate_limit SET count = $2 WHERE ip_hash = $1`, [senderKey(beta.owner), INVITE_EMAILS_PER_DAY]);
      const added = await addByEmail(owner(s, "beta"), "capped.beta@example.com");
      eq([added.status, added.body.emailed, resend.sent.length], [201, false, 0], "not emailed");
      ok(/\/signup#join=[A-Za-z0-9_-]{20,64}$/.test(String(added.body.url)), "the link to copy");
      eq((await sql(`SELECT family_id FROM maple_invites WHERE email = 'capped.beta@example.com'`)).map((r) => r.family_id), ["2"], "the invite");
      await sql(`DELETE FROM upload_rate_limit WHERE ip_hash = $1`, [senderKey(beta.owner)]);
      await sql(`DELETE FROM maple_invites WHERE email = 'capped.beta@example.com'`);
    });

    await test(`${shape}: without Resend set up, or when it fails, the invite answers with its link`, async () => {
      for (const mode of ["off", "refuse", "throw"] as const) {
        reset();
        if (mode === "off") resendOff();
        else resend.mode = mode;
        const address = `fallback.${mode}@example.com`;
        const added = await quietly(() => addByEmail(owner(s, "beta"), address));
        eq([added.status, added.body.emailed, resend.sent.length], [201, false, 0], mode);
        ok(/\/signup#join=/.test(String(added.body.url)), `${mode}: the link`);
        resendOn();
        await sql(`DELETE FROM maple_invites WHERE email = $1`, [address]);
      }
      const spent = await sql(`SELECT count FROM upload_rate_limit WHERE ip_hash = $1`, [senderKey(beta.owner)]);
      eq(spent.map((r) => Number(r.count)), [2], "the failed sends counted; with Resend off, none was");
      await sql(`DELETE FROM upload_rate_limit WHERE ip_hash = $1`, [senderKey(beta.owner)]);
    });
  }

  await welcome();
  setLaterRunner(null);
}

async function welcome() {
  const { NextRequest } = await import("next/server");
  const auth = await import("../../src/lib/maple/auth");
  const { setLaterRunner } = await import("../../src/lib/maple/push-hooks");
  const { handleMapleGoogleCallback } = await import("../../src/lib/maple/google-callback");
  const { migrateSignup } = await import("../../src/lib/maple/family/schema");
  const start = await import("../../src/app/api/maple/signup/start/route");

  let ipSeq = 0;
  const setCookie = (res: Response, name: string) => {
    const raw = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`));
    return raw ? /^[^=]+=([^;]*)/.exec(raw)![1] : null;
  };
  const signUp = async (email: string, fields: Record<string, string> = { terms: "yes" }) => {
    const ip = `198.51.100.${++ipSeq}`;
    const began = await start.POST(
      new NextRequest(new URL("/api/maple/signup/start", BASE), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": ip },
        body: new URLSearchParams({ site: BASE, tz: "America/Denver", ...fields }).toString(),
      })
    );
    const cookie = setCookie(began, auth.STATE_COOKIE);
    const state = cookie ? (JSON.parse(decodeURIComponent(cookie)) as { state: string }).state : "missing";
    const url = new URL("/api/maple/auth/callback", BASE);
    url.searchParams.set("state", state);
    url.searchParams.set("code", "made-up-google-code");
    const res = await handleMapleGoogleCallback(new NextRequest(url, { headers: { cookie: cookie ? `${auth.STATE_COOKIE}=${cookie}` : "", "x-real-ip": ip } }), {
      identify: async () => ({ email, name: "Made-Up Person" }),
    });
    const sealed = setCookie(res, auth.SESSION_COOKIE);
    const signedIn = sealed ? await auth.signedInAs(auth.openSession(decodeURIComponent(sealed))) : null;
    return { familyId: signedIn?.ctx.familyId ?? null, error: new URL(res.headers.get("location") ?? "", BASE).searchParams.get("error") };
  };

  await freshDb({ shape: "final" });
  await quietly(migrateSignup);
  const s = await seedFamilies();
  process.env.MAPLE_SIGNUP = "open";
  resendOn();
  const queued: (() => Promise<void>)[] = [];
  setLaterRunner((task) => {
    queued.push(task);
  });
  const runQueued = async () => {
    for (const task of queued.splice(0)) await task();
  };
  const reset = () => {
    resend.mode = "ok";
    resend.sent = [];
    queued.length = 0;
  };

  await test("sign-up: a new family's owner gets one welcome, sent after the response", async () => {
    reset();
    const cb = await signUp("new.owner@example.com");
    ok(cb.familyId !== null && cb.familyId > s.beta.familyId, `a new family: ${JSON.stringify(cb)}`);
    eq([resend.sent.length, queued.length], [0, 1], "queued, not sent, when the redirect goes out");
    await runQueued();
    eq(resend.sent.length, 1, "one email");
    const [e] = resend.sent;
    eq([e.to, e.key, e.subject], ["new.owner@example.com", `welcome/${cb.familyId}`, "Your family’s log on Maple is ready"]);
    ok(e.text.startsWith("Hi Made-Up,\n\nYour family’s log is ready."), `the greeting: ${e.text.slice(0, 60)}`);
    ok(e.text.includes(`${BASE}/maple\n`), "links this deployment's app");
    reset();
    eq((await signUp("new.owner@example.com")).error, null, "signs in to the family it made");
    eq((await signUp("joiner@example.com", { invite: s.beta.inviteToken })).familyId, s.beta.familyId, "joins Beta");
    process.env.MAPLE_ALLOWED_EMAILS = "allowed.one@example.com";
    try {
      eq((await signUp("allowed.one@example.com")).familyId, 1, "joins family 1");
    } finally {
      delete process.env.MAPLE_ALLOWED_EMAILS;
    }
    eq(queued.length, 0, "nothing queued");
    eq(resend.sent.length, 0, "nothing sent");
  });

  await test("sign-up: a failed welcome, or none without Resend, leaves the family made and signed in", async () => {
    for (const mode of ["refuse", "off"] as const) {
      reset();
      if (mode === "off") resendOff();
      else resend.mode = mode;
      const cb = await signUp(`welcome.${mode}@example.com`);
      ok(cb.familyId !== null && cb.familyId > s.beta.familyId && cb.error === null, `${mode}: signed in to a new family`);
      eq(queued.length, 1, `${mode}: welcome queued`);
      await quietly(runQueued);
      eq(resend.sent.length, 0, `${mode}: nothing sent`);
      resendOn();
    }
  });
  delete process.env.MAPLE_SIGNUP;
}

void main()
  .then(() => done("email.check.ts"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

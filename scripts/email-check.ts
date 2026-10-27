/**
 * Assertions for outgoing email (src/lib/email/): the invite and welcome
 * templates (copy rules, escaping, the expiry in the family's zone, nothing
 * about one family baked in), sendEmail (the no-key fallback, what reaches
 * Resend, and that no address, subject or body reaches a log or an error
 * report), and the per-sender daily cap on invite emails.
 *
 *   npx tsx scripts/email-check.ts      (or pnpm check:email)
 *
 * No database, no network: Resend is a stand-in transport or a stubbed fetch,
 * and the cap runs against an in-memory counter. Made-up people only, on
 * example domains. One PASS/FAIL line per case, exit 1 on any failure.
 */
import { readFileSync } from "fs";
import { join } from "path";

delete process.env.DATABASE_URL;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_EMAIL_DOMAIN;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(actual: unknown, expected: unknown, what = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

const RECIPIENT = "June.Parent@Example.com";
const ENV = { RESEND_API_KEY: "re_check_not_a_key", RESEND_EMAIL_DOMAIN: "maplebaby.app" };
const LINK = "https://maplebaby.app/maple/join#tok_check_123";
const EXPIRES = new Date("2026-11-03T21:05:00Z");
const ROOT = join(__dirname, "..");

function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  Object.assign(console, { log: capture, info: capture, warn: capture, error: capture, debug: capture });
  return fn()
    .then((result) => ({ result, logged: lines.join("\n") }))
    .finally(() => Object.assign(console, saved));
}

async function main() {
  const t = await import("../src/lib/email/templates");
  const s = await import("../src/lib/email/send");
  const l = await import("../src/lib/email/limit");

  const invite = (over: Partial<Parameters<typeof t.inviteEmail>[0]> = {}) =>
    t.inviteEmail({ inviter: "Alex", baby: "Robin", link: LINK, expiresAt: EXPIRES, timeZone: "America/New_York", origin: "https://maplebaby.app", ...over });
  const welcome = (over: Partial<Parameters<typeof t.welcomeEmail>[0]> = {}) =>
    t.welcomeEmail({ name: "Alex", baby: "Robin", origin: "https://maplebaby.app", ...over });

  // ── templates ─────────────────────────────────────────────────────────
  await check("the invite names who invited, the baby, the link and when it expires", () => {
    const e = invite();
    eq(e.subject, "Alex invited you to Robin’s log on Maple", "subject");
    for (const part of ["Alex invited you to Robin’s log on Maple.", LINK, "until Tuesday, November 3 at 4:05 PM EST", "ask Alex for a new one"]) {
      ok(e.text.includes(part), `text has ${JSON.stringify(part)}`);
    }
    ok(e.html.includes(`href="${LINK}"`), "html links the invite");
    ok(e.html.includes("Join Robin’s log"), "html button");
  });
  await check("the expiry is told in the family's zone", () => {
    ok(invite({ timeZone: "America/Los_Angeles" }).text.includes("until Tuesday, November 3 at 1:05 PM PST"), "Los Angeles");
    ok(invite({ timeZone: "Europe/London" }).text.includes("until Tuesday, November 3 at 9:05 PM GMT"), "London");
    ok(invite({ timeZone: "Not/AZone" }).text.includes("at 9:05 PM UTC"), "an unknown zone falls back to UTC");
  });
  await check("the invite reads without a baby's name or an inviter's", () => {
    const e = invite({ inviter: null, baby: "  " });
    eq(e.subject, "Someone invited you to their family’s log on Maple", "subject");
    ok(e.text.includes("ask whoever invited you for a new one"), "fallback ask");
  });
  await check("the welcome points to the app, and greets only by a known name", () => {
    const e = welcome();
    eq(e.subject, "Robin’s log on Maple is ready", "subject");
    ok(e.text.startsWith("Hi Alex,\n\nRobin’s log is ready."), "opening");
    ok(e.text.includes("https://maplebaby.app/maple\n"), "app link");
    ok(e.html.includes('href="https://maplebaby.app/maple"'), "html link");
    const bare = welcome({ name: null, baby: null });
    eq(bare.subject, "Your family’s log on Maple is ready", "subject without a baby");
    ok(bare.text.startsWith("Your family’s log is ready."), "no greeting without a name");
  });
  await check("names can't inject HTML into either email", () => {
    const evil = `<script>alert("x")</script>`;
    const breakout = `"><img src=x onerror=alert(1)>`;
    for (const e of [invite({ inviter: evil, baby: breakout }), welcome({ name: evil, baby: breakout })]) {
      ok(!/<script/i.test(e.html), "no <script> tag");
      ok(!/<img/i.test(e.html), "no <img> tag");
      ok(e.html.includes("&lt;script&gt;"), "the name shows, escaped");
      ok(e.html.includes("&quot;&gt;&lt;img"), "the quote is escaped too");
    }
  });
  await check("names can't add lines or bidi tricks to the subject or the text", () => {
    const e = invite({ inviter: "Alex\r\nBcc: x@example.com‮gnp.exe", baby: `Ro\nbin${"n".repeat(80)}` });
    ok(!/[\r\n]/.test(e.subject), "one-line subject");
    ok(!e.text.includes("\nBcc:"), "no injected line");
    ok(!/[‪-‮⁦-⁩]/.test(e.subject + e.text + e.html), "no bidi controls");
    ok(!e.subject.includes("n".repeat(41)), "names are capped");
  });
  await check("only an http(s) link goes into an invite", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      let threw = false;
      try {
        invite({ link: bad });
      } catch {
        threw = true;
      }
      ok(threw, `refused ${bad}`);
    }
  });
  await check("the copy keeps the site's voice: no em dashes, exclamation marks or \"we\"", () => {
    for (const e of [invite(), invite({ inviter: null, baby: null }), welcome(), welcome({ name: null, baby: null })]) {
      const words = `${e.subject}\n${e.text}`;
      ok(!/[—–]/.test(words), "no em or en dash");
      ok(!words.includes("!"), "no exclamation mark");
      ok(!/\bwe\b|\bwe['’]|\bour\b|\bus\b/i.test(words), "no we, our or us");
    }
  });
  await check("nothing about one family is baked into the templates", () => {
    const src = readFileSync(join(ROOT, "src/lib/email/templates.ts"), "utf8");
    for (const name of ["Maple Jane", "Brittany", "Matt", "Brooker"]) ok(!src.includes(name), `templates.ts names ${name}`);
    const all = [invite(), welcome()].map((e) => e.subject + e.text + e.html).join("");
    for (const name of ["Maple Jane", "Brittany", "Matt", "Brooker"]) ok(!all.includes(name), `output names ${name}`);
  });

  // ── sendEmail ─────────────────────────────────────────────────────────
  type Call = { payload: Parameters<import("../src/lib/email/send").Transport>[0]; options: { idempotencyKey?: string } };
  function harness(reply: Awaited<ReturnType<import("../src/lib/email/send").Transport>> | Error = { data: { id: "em_1" }, error: null }) {
    const calls: Call[] = [];
    const reports: { error: Error; props: Record<string, unknown> }[] = [];
    let made = 0;
    const deps = {
      env: ENV as Record<string, string | undefined>,
      transport: () => {
        made++;
        return async (payload: Call["payload"], options: Call["options"]) => {
          calls.push({ payload, options });
          if (reply instanceof Error) throw reply;
          return reply;
        };
      },
      report: (error: Error, props: Record<string, unknown>) => {
        reports.push({ error, props });
      },
    };
    return { deps, calls, reports, made: () => made };
  }
  const message = () => ({ ...invite(), to: RECIPIENT, kind: "invite", idempotencyKey: "invite/42" });

  await check("without a Resend key nothing is sent, nothing throws, and the caller is told it's off", async () => {
    for (const env of [{}, { RESEND_API_KEY: "  ", RESEND_EMAIL_DOMAIN: "maplebaby.app" }, { RESEND_API_KEY: "re_x" }, { RESEND_API_KEY: "re_x", RESEND_EMAIL_DOMAIN: "not a domain" }]) {
      const h = harness();
      const r = await s.sendEmail(message(), { ...h.deps, env });
      eq(r, { sent: false, reason: "off" }, JSON.stringify(env));
      eq(h.made(), 0, "no client made");
      eq(h.reports.length, 0, "nothing reported");
    }
  });
  await check("the default env has no key here, so the real client is never made", async () => {
    const { result, logged } = await quiet(() => s.sendEmail(message()));
    eq(result, { sent: false, reason: "off" });
    eq(logged, "", "nothing logged");
  });
  await check("a send goes from Maple at the domain, replies to the contact inbox, and carries its key", async () => {
    const h = harness();
    const r = await s.sendEmail(message(), h.deps);
    eq(r, { sent: true, id: "em_1" });
    eq(h.calls.length, 1, "one send");
    const { payload, options } = h.calls[0];
    eq(payload.from, "Maple <hello@maplebaby.app>", "from");
    eq(payload.replyTo, "hello@maplebaby.app", "reply-to");
    eq(payload.to, "june.parent@example.com", "to, normalized");
    eq(payload.subject, invite().subject, "subject");
    ok(payload.text === invite().text && payload.html === invite().html, "text and html");
    eq(options, { idempotencyKey: "invite/42" }, "idempotency key");
  });
  await check("the reply-to is the inbox the legal pages name", () => {
    const legal = readFileSync(join(ROOT, "src/components/site/legal.tsx"), "utf8");
    const m = legal.match(/export const CONTACT_EMAIL = "([^"]+)"/);
    ok(m, "CONTACT_EMAIL found");
    eq(s.REPLY_TO, m![1], "REPLY_TO");
  });
  await check("a bad address, subject or key is refused before Resend is asked", async () => {
    const bad = [
      { to: "june@" },
      { to: "june@example.com\nbcc@example.com" },
      { subject: "Hi\r\nBcc: x@example.com" },
      { subject: "" },
      { idempotencyKey: "has spaces" },
      { idempotencyKey: "k".repeat(257) },
    ];
    for (const over of bad) {
      const h = harness();
      eq(await s.sendEmail({ ...message(), ...over }, h.deps), { sent: false, reason: "invalid" }, JSON.stringify(over));
      eq(h.calls.length, 0, "not sent");
    }
  });
  await check("a Resend error is reported as its kind only, and nothing is logged", async () => {
    const h = harness({ data: null, error: { name: "validation_error", statusCode: 422, message: `Invalid \`to\` field: ${RECIPIENT}` } });
    const { result, logged } = await quiet(() => s.sendEmail(message(), h.deps));
    eq(result, { sent: false, reason: "failed" });
    eq(h.reports.length, 1, "one report");
    eq(h.reports[0].error.message, "validation_error 422", "report message");
    eq(h.reports[0].props, { where: "email", kind: "invite" }, "report properties");
    const leaked = JSON.stringify({ m: h.reports[0].error.message, s: h.reports[0].error.stack, p: h.reports[0].props }) + logged;
    for (const secret of ["june.parent", "June.Parent", "Robin", "Alex", "tok_check"]) ok(!leaked.includes(secret), `leaked ${secret}`);
  });
  await check("a thrown transport error is caught and scrubbed", async () => {
    const h = harness(Object.assign(new Error(`connect failed for ${RECIPIENT}`), { name: "FetchError" }));
    const { result, logged } = await quiet(() => s.sendEmail(message(), h.deps));
    eq(result, { sent: false, reason: "failed" });
    eq(h.reports[0].error.message, "FetchError", "report message");
    ok(!(h.reports[0].error.stack ?? "").includes("june") && !logged.includes("june"), "no address");
  });
  await check("a report that throws still leaves a not-sent answer", async () => {
    const h = harness({ data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow down" } });
    const r = await s.sendEmail(message(), {
      ...h.deps,
      report: () => {
        throw new Error("posthog down");
      },
    });
    eq(r, { sent: false, reason: "failed" });
  });

  await check("through the real SDK: the wire request, and no console output on an error", async () => {
    const saved = { fetch: globalThis.fetch, env: process.env.NODE_ENV };
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    let status = 200;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return status === 200
        ? new Response(JSON.stringify({ id: "em_wire" }), { status, headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ name: "validation_error", statusCode: status, message: `Invalid \`to\` field: ${RECIPIENT}` }), { status });
    }) as typeof fetch;
    Object.assign(process.env, { NODE_ENV: "development" });
    try {
      const sent = await quiet(() => s.sendEmail(message(), { env: ENV }));
      eq(sent.result, { sent: true, id: "em_wire" });
      eq(seen[0].url, "https://api.resend.com/emails", "endpoint");
      eq(seen[0].headers.get("idempotency-key"), "invite/42", "Idempotency-Key header");
      eq(seen[0].headers.get("authorization"), `Bearer ${ENV.RESEND_API_KEY}`, "key header");
      eq([seen[0].body.from, seen[0].body.reply_to, seen[0].body.to], ["Maple <hello@maplebaby.app>", "hello@maplebaby.app", "june.parent@example.com"], "from, reply_to, to");
      ok(seen[0].body.text === invite().text && seen[0].body.html === invite().html, "text and html");
      status = 422;
      const refused = await quiet(() => s.sendEmail(message(), { env: ENV, report: () => {} }));
      eq(refused.result, { sent: false, reason: "failed" });
      eq(refused.logged, "", "nothing on the console");
    } finally {
      globalThis.fetch = saved.fetch;
      Object.assign(process.env, { NODE_ENV: saved.env });
    }
  });

  // ── the cap ───────────────────────────────────────────────────────────
  function counter() {
    const hits = new Map<string, number>();
    const run = async (sql: string, params: unknown[]) => {
      eq(sql, l.INVITE_EMAIL_HIT, "the cap's statement");
      const [key, max] = params as [string, number];
      const n = hits.get(key) ?? 0;
      if (n < max) hits.set(key, n + 1);
      return [{ n }];
    };
    return { hits, run };
  }

  await check(`a sender gets ${l.INVITE_EMAILS_PER_DAY} invite emails a day, then no`, async () => {
    const c = counter();
    const answers: boolean[] = [];
    for (let i = 0; i < l.INVITE_EMAILS_PER_DAY + 3; i++) answers.push(await l.allowInviteEmail("alex@example.com", c.run));
    eq(answers.filter(Boolean).length, l.INVITE_EMAILS_PER_DAY, "allowed");
    eq(answers.indexOf(false), l.INVITE_EMAILS_PER_DAY, "first refusal");
    ok(await l.allowInviteEmail("vi@example.com", c.run), "another sender has their own count");
  });
  await check("the count is keyed by a hash, not the sender's address", async () => {
    const c = counter();
    await l.allowInviteEmail("Alex@Example.com ", c.run);
    const [key] = [...c.hits.keys()];
    ok(/^[0-9a-f]{64}$/.test(key), "an HMAC");
    eq(key, l.senderKey("alex@example.com"), "case and spacing don't make a new count");
    ok(key !== l.senderKey("vi@example.com"), "senders differ");
  });
  await check("the cap fails closed with no database or an error", async () => {
    eq(await l.allowInviteEmail("alex@example.com"), false, "no DATABASE_URL");
    eq(await l.allowInviteEmail("alex@example.com", async () => null), false, "offline");
    eq(await l.allowInviteEmail("alex@example.com", async () => []), false, "no row");
    eq(
      await l.allowInviteEmail("alex@example.com", async () => {
        throw new Error("db down");
      }),
      false,
      "throws"
    );
  });

  const n = await import("../src/lib/email/notices");
  const notice = (over: Partial<Parameters<typeof n.emailInvite>[0]> = {}) => ({
    inviteId: 42,
    to: RECIPIENT,
    sender: "alex@example.com",
    inviter: "Alex",
    baby: "Robin",
    link: LINK,
    expiresAt: EXPIRES.toISOString(),
    timeZone: "America/New_York",
    origin: "https://maplebaby.app",
    ...over,
  });
  const allowing = (answer: boolean) => {
    const asked: string[] = [];
    return { asked, allow: async (sender: string) => (asked.push(sender), answer) };
  };

  await check("an invite email goes once per invite, after the sender's cap says yes", async () => {
    const h = harness();
    const cap = allowing(true);
    eq(await n.emailInvite(notice(), { ...h.deps, allow: cap.allow }), true, "emailed");
    eq(cap.asked, ["alex@example.com"], "the cap is asked for the sender");
    eq(h.calls.length, 1, "one send");
    eq(h.calls[0].options, { idempotencyKey: "invite/42" }, "keyed by the invite's id");
    eq(h.calls[0].payload.to, "june.parent@example.com", "to the invited address");
    eq(h.calls[0].payload.subject, invite().subject, "the invite template");
    ok(h.calls[0].payload.text === invite().text, "the same text the template makes");
  });
  await check("without a Resend key an invite isn't emailed, and the cap isn't spent", async () => {
    const h = harness();
    const cap = allowing(true);
    eq(await n.emailInvite(notice(), { ...h.deps, env: {}, allow: cap.allow }), false);
    eq([cap.asked.length, h.made()], [0, 0], "no cap, no client");
  });
  await check("a sender over the cap gets the link to copy instead", async () => {
    const h = harness();
    eq(await n.emailInvite(notice(), { ...h.deps, allow: allowing(false).allow }), false);
    eq(h.calls.length, 0, "not sent");
  });
  await check("a failed, thrown or slow send answers false and never throws", async () => {
    const refused = harness({ data: null, error: { name: "validation_error", statusCode: 422, message: "no" } });
    eq(await n.emailInvite(notice(), { ...refused.deps, allow: allowing(true).allow }), false, "refused");
    const thrown = harness(new Error("socket hang up"));
    eq(await n.emailInvite(notice(), { ...thrown.deps, allow: allowing(true).allow }), false, "thrown");
    const slow = harness();
    const started = Date.now();
    const hung = await n.emailInvite(notice(), {
      ...slow.deps,
      transport: () => () => new Promise(() => {}),
      allow: allowing(true).allow,
      waitMs: 30,
    });
    eq(hung, false, "a send that never answers");
    ok(Date.now() - started < 1000, "answered at the wait, not later");
  });
  await check("a link that isn't http(s) sends nothing, spends no cap, and reports no link", async () => {
    const h = harness();
    const cap = allowing(true);
    eq(await n.emailInvite(notice({ link: "javascript:alert(1)" }), { ...h.deps, allow: cap.allow }), false);
    eq([cap.asked.length, h.calls.length], [0, 0], "nothing spent or sent");
    eq(h.reports.length, 1, "reported");
    eq(h.reports[0].props, { where: "email", kind: "invite" }, "as an invite email");
    ok(!JSON.stringify([h.reports[0].error.message, h.reports[0].error.stack]).includes("alert"), "the link stays out");
  });
  await check("the welcome greets by first name, links the app and is keyed by the family", async () => {
    const h = harness();
    const r = await n.emailWelcome({ familyId: 7, to: RECIPIENT, name: "  Alex   Rivera ", origin: "https://maplebaby.app" }, h.deps);
    eq(r, { sent: true, id: "em_1" });
    eq(h.calls[0].options, { idempotencyKey: "welcome/7" }, "key");
    eq(h.calls[0].payload.subject, "Your family’s log on Maple is ready", "subject");
    ok(h.calls[0].payload.text.startsWith("Hi Alex,\n\nYour family’s log is ready."), "first name only");
    ok(h.calls[0].payload.text.includes("https://maplebaby.app/maple\n"), "the app's link");
    const nameless = harness();
    await n.emailWelcome({ familyId: 8, to: RECIPIENT, name: null, origin: "https://maplebaby.app" }, nameless.deps);
    ok(nameless.calls[0].payload.text.startsWith("Your family’s log is ready."), "no greeting without a name");
  });
  await check("the welcome is off without a key and never throws on a bad origin", async () => {
    const h = harness();
    eq(await n.emailWelcome({ familyId: 7, to: RECIPIENT, name: "Alex", origin: "https://maplebaby.app" }, { ...h.deps, env: {} }), { sent: false, reason: "off" });
    eq(await n.emailWelcome({ familyId: 7, to: RECIPIENT, name: "Alex", origin: "not a url" }, h.deps), { sent: false, reason: "failed" });
    eq(h.calls.length, 0, "nothing sent");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.log(`FAIL (crashed): ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});

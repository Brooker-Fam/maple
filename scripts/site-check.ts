/**
 * Assertions for the public site's waitlist (src/lib/waitlist.ts and
 * POST /api/waitlist): email validation, the honeypot, the 204/303/400/403/
 * 429/503/500 answers, the daily cap, that a second sign-up with the same
 * address (in any case or spacing) adds nothing, and that nothing sent ever
 * reaches a log or an error report (scrubError included). Also the sign-up
 * entry points: the header's and footer's Sign in and Get started, and the
 * home page's Get started buttons, which reach the waitlist on /signup while
 * sign-up is off.
 *
 *   npx tsx scripts/site-check.ts      (or pnpm check:site)
 *
 * No database, no network: the store is an in-memory stand-in with the
 * table's unique email, and every address is made up on example domains.
 * One PASS/FAIL line per case, exit 1 on any failure.
 */
import { readFileSync } from "fs";
import { join } from "path";

delete process.env.DATABASE_URL;
delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

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

const PERSON = "June.Parent@Example.com";

async function main() {
  const w = await import("../src/lib/waitlist");

  // ── email ─────────────────────────────────────────────────────────────
  await check("a plain address passes, trimmed and lowercased", () => {
    eq(w.normalizeEmail("  June.Parent@Example.COM "), "june.parent@example.com");
    eq(w.normalizeEmail("a+maple@sub.example.co.uk"), "a+maple@sub.example.co.uk");
    eq(w.normalizeEmail("x@xn--80ak6aa92e.com"), "x@xn--80ak6aa92e.com");
  });
  await check("malformed addresses are refused", () => {
    const bad = [
      "",
      "june",
      "june@",
      "@example.com",
      "june@example",
      "june@@example.com",
      "june parent@example.com",
      "june@exa mple.com",
      "june@example.c",
      "june@example.123",
      "june@-example.com",
      "june@example-.com",
      "june@example..com",
      ".june@example.com",
      "june.@example.com",
      "ju..ne@example.com",
      "june@example.com\nbcc@example.com",
      `${"a".repeat(65)}@example.com`,
      `june@${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.com`,
    ];
    for (const b of bad) eq(w.normalizeEmail(b), null, JSON.stringify(b));
  });
  await check("a non-string email is refused", () => {
    for (const b of [undefined, null, 42, ["june@example.com"], { email: "june@example.com" }]) eq(w.normalizeEmail(b), null, JSON.stringify(b));
  });

  // ── the POST ──────────────────────────────────────────────────────────
  type Row = { email: string; at: number };
  function harness(opts: { allowed?: boolean; offline?: boolean; full?: boolean; throws?: boolean } = {}) {
    const table = new Map<string, Row>();
    const reports: Error[] = [];
    let limited = 0;
    let saves = 0;
    let clock = 0;
    const deps = {
      limit: async () => {
        limited++;
        return { allowed: opts.allowed ?? true };
      },
      save: async (entry: { email: string }) => {
        saves++;
        if (opts.throws) throw Object.assign(new Error(`duplicate key value (email)=(${entry.email})`), { name: "NeonDbError" });
        if (opts.offline) return "offline" as const;
        if (opts.full) return "full" as const;
        if (!table.has(entry.email)) table.set(entry.email, { ...entry, at: ++clock });
        return "saved" as const;
      },
      report: (e: Error) => {
        reports.push(e);
      },
    };
    const post = (body: unknown, type = "application/json", headers: Record<string, string> = {}) =>
      w.handleWaitlist(
        new Request("https://site.invalid/api/waitlist", {
          method: "POST",
          headers: { "content-type": type, ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        deps
      );
    return { table, reports, post, counts: () => ({ limited, saves }) };
  }

  await check("a sign-up is 204 with no body, and saves only the normalized address", async () => {
    const h = harness();
    const res = await h.post({ email: ` ${PERSON} `, baby_month: "2026-12" });
    eq(res.status, 204, "status");
    eq(await res.text(), "", "body");
    eq([...h.table.values()].map(({ email, ...rest }) => ({ email, keys: Object.keys(rest) })), [{ email: "june.parent@example.com", keys: ["at"] }]);
  });
  await check("signing up again, in another case, adds nothing and still says 204", async () => {
    const h = harness();
    eq((await h.post({ email: PERSON })).status, 204, "first");
    eq((await h.post({ email: PERSON.toUpperCase() })).status, 204, "second");
    eq((await h.post({ email: PERSON.toLowerCase() })).status, 204, "third");
    eq(h.table.size, 1, "rows");
    eq(h.table.get("june.parent@example.com")?.at, 1, "first row kept");
  });
  const FORM = "application/x-www-form-urlencoded";
  await check("a form posted before the script loaded is saved and sent on to /waitlist", async () => {
    const h = harness();
    const res = await h.post("email=june%40example.org&website=", FORM);
    eq(res.status, 303);
    eq(res.headers.get("location"), "/waitlist?r=joined");
    ok(h.table.has("june@example.org"), "saved");
  });
  await check("a form post that fails says why on /waitlist, by a known word only", async () => {
    eq((await harness().post("email=nope", FORM)).headers.get("location"), "/waitlist?r=email");
    eq((await harness({ allowed: false }).post("email=june%40example.org", FORM)).headers.get("location"), "/waitlist?r=limit");
    eq((await harness({ full: true }).post("email=june%40example.org", FORM)).headers.get("location"), "/waitlist?r=full");
    eq((await harness({ throws: true }).post("email=june%40example.org", FORM)).headers.get("location"), "/waitlist?r=failed");
    for (const r of ["email", "limit", "full", "failed", "offline", "body", "cross"]) ok(r in w.WAITLIST_ERRORS, `${r} has no words`);
  });
  await check("a cross-site post is 403 and isn't counted or saved", async () => {
    const h = harness();
    const res = await h.post({ email: PERSON }, "application/json", { "sec-fetch-site": "cross-site" });
    eq(res.status, 403);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.cross });
    eq(h.counts(), { limited: 0, saves: 0 });
    for (const site of ["same-origin", "same-site", "none"]) eq((await harness().post({ email: PERSON }, "application/json", { "sec-fetch-site": site })).status, 204, site);
  });
  await check("a full day is 503 with its own words, not a false success", async () => {
    const res = await harness({ full: true }).post({ email: PERSON });
    eq(res.status, 503);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.full });
  });
  await check("a filled honeypot gets 204 and saves nothing", async () => {
    const h = harness();
    const res = await h.post({ email: PERSON, website: "https://spam.example.net" });
    eq(res.status, 204);
    eq(h.counts().saves, 0, "saves");
  });
  await check("a bad email is 400 with the form's words, and nothing saved", async () => {
    const h = harness();
    const res = await h.post({ email: "june@example" });
    eq(res.status, 400);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.email });
    eq(h.counts().saves, 0, "saves");
  });
  await check("a body that isn't an object is 400", async () => {
    for (const body of ["not json", "[]", "null", '"june@example.com"', "", "x".repeat(2001)]) {
      const h = harness();
      eq((await h.post(body)).status, 400, JSON.stringify(body.slice(0, 20)));
      eq(h.counts().saves, 0, "saves");
    }
  });
  await check("over the rate limit is 429 before the body is read", async () => {
    const h = harness({ allowed: false });
    const res = await h.post({ email: PERSON });
    eq(res.status, 429);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.limit });
    eq(h.counts(), { limited: 1, saves: 0 });
  });
  await check("every request is counted against the limit, bots and bad ones included", async () => {
    const h = harness();
    await h.post({ email: PERSON, website: "x" });
    await h.post({ email: "nope" });
    await h.post("garbage");
    eq(h.counts().limited, 3);
  });
  await check("no database is 503, not a false success", async () => {
    const h = harness({ offline: true });
    const res = await h.post({ email: PERSON });
    eq(res.status, 503);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.offline });
  });
  await check("a store error is 500 and reported by its class only", async () => {
    const h = harness({ throws: true });
    const res = await h.post({ email: PERSON });
    eq(res.status, 500);
    eq(h.reports.map((e) => e.message), ["NeonDbError"]);
  });
  await check("nothing sent reaches the console", async () => {
    const seen: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      for (const opts of [{}, { offline: true }, { throws: true }, { allowed: false }]) {
        const h = harness(opts);
        await h.post({ email: PERSON });
        await h.post({ email: "june@example" });
        await h.post({ email: PERSON, website: "bot" });
      }
    } finally {
      Object.assign(console, orig);
    }
    ok(!seen.some((s) => /june|example/i.test(s)), `logged: ${seen.join(" | ")}`);
  });

  // ── the store ─────────────────────────────────────────────────────────
  await check("the insert is one statement: the address as a parameter, the daily cap checked, a repeat adding nothing", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const run = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [{ n: 3 }];
    };
    eq(await w.addToWaitlist({ email: "june@example.com" }, run), "saved");
    eq(calls.length, 1, "statements");
    ok(/ON CONFLICT \(email\) DO NOTHING/.test(calls[0].sql), "no ON CONFLICT DO NOTHING");
    ok(/WHERE n < \$2/.test(calls[0].sql), "no cap in the insert");
    ok(/INSERT INTO maple_waitlist \(email\)/.test(calls[0].sql), "inserts more than the address");
    ok(!calls[0].sql.includes("june"), "address inlined in SQL");
    eq(calls[0].params, ["june@example.com", w.WAITLIST_DAILY_MAX]);
  });
  await check("at the daily cap the store says full", async () => {
    eq(await w.addToWaitlist({ email: "june@example.com" }, async () => [{ n: w.WAITLIST_DAILY_MAX }]), "full");
    eq(await w.addToWaitlist({ email: "june@example.com" }, async () => [{ n: String(w.WAITLIST_DAILY_MAX - 1) }]), "saved");
  });
  await check("no database: the store says offline", async () => {
    eq(await w.addToWaitlist({ email: "june@example.com" }, async () => null), "offline");
  });
  await check("the migration creates the table with a unique email, additively, and keeps no baby month", () => {
    const sql = readFileSync(join(__dirname, "../src/lib/migrate.ts"), "utf8");
    const m = /CREATE TABLE IF NOT EXISTS maple_waitlist \(([\s\S]*?)\n\s*\)/.exec(sql);
    ok(m, "no CREATE TABLE IF NOT EXISTS maple_waitlist");
    ok(/email TEXT NOT NULL UNIQUE/.test(m![1]), "email isn't unique");
    ok(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/.test(m![1]), "created_at has no default");
    ok(/UPDATE maple_waitlist SET baby_month = NULL/.test(sql), "old baby months aren't cleared");
  });

  // ── sign-up entry points ──────────────────────────────────────────────
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: SiteHeader } = await import("../src/components/site/SiteHeader");
  const { default: SiteFooter } = await import("../src/components/site/SiteFooter");
  const { default: Home } = await import("../src/app/(site)/page");
  const { default: Signup } = await import("../src/app/(site)/signup/page");

  type Anchor = { href: string; rel: string | null; text: string };
  const anchors = (html: string): Anchor[] =>
    [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({
      href: /\bhref="([^"]*)"/.exec(attrs)?.[1] ?? "",
      rel: /\brel="([^"]*)"/.exec(attrs)?.[1] ?? null,
      text: inner.replace(/<[^>]+>/g, "").trim(),
    }));
  const named = (html: string, text: string) => anchors(html).filter((a) => a.text === text);
  const header = renderToStaticMarkup(createElement(SiteHeader));
  const footer = renderToStaticMarkup(createElement(SiteFooter));
  const home = renderToStaticMarkup(createElement(Home));

  await check("the header has Sign in to the app and Get started to /signup", () => {
    eq(named(header, "Sign in"), [{ href: "/maple", rel: "nofollow", text: "Sign in" }], "Sign in");
    eq(named(header, "Get started").map((a) => a.href), ["/signup"], "Get started");
    ok(!/Family sign-in/.test(header), "still says Family sign-in");
  });
  await check("the footer has the same two, Sign in kept out of search", () => {
    eq(named(footer, "Sign in"), [{ href: "/maple", rel: "nofollow", text: "Sign in" }], "Sign in");
    eq(named(footer, "Get started").map((a) => a.href), ["/signup"], "Get started");
    ok(!/Family sign-in/.test(footer), "still says Family sign-in");
  });
  await check("the home page has no waitlist form, and its Get started buttons go to /signup", () => {
    ok(!/<form\b/.test(home), "a form on the home page");
    ok(!/type="email"/.test(home), "an email field on the home page");
    ok(!/waitlist/i.test(home), "the home page mentions the waitlist");
    eq(named(home, "Get started").map((a) => a.href), ["/signup", "/signup", "/signup", "/signup"], "header, hero, join, footer");
  });
  await check("with sign-up off, Get started lands on the waitlist", async () => {
    const before = process.env.MAPLE_SIGNUP;
    delete process.env.MAPLE_SIGNUP;
    try {
      ok(named(home, "Get started").length && named(home, "Get started").every((a) => a.href === "/signup"), "Get started doesn't go to /signup");
      const page = renderToStaticMarkup(await Signup({ searchParams: Promise.resolve({}) }));
      const forms = page.match(/<form\b[^>]*>/g) ?? [];
      ok(forms.some((f) => f.includes('action="/api/waitlist"') && f.includes('method="post"')), "no waitlist form on /signup");
      ok(/Sign-up isn’t open yet/.test(page), "doesn't say sign-up isn't open");
      ok(!/signup\/start/.test(page), "offers Google sign-up while it's off");
    } finally {
      if (before === undefined) delete process.env.MAPLE_SIGNUP;
      else process.env.MAPLE_SIGNUP = before;
    }
  });

  // ── error reports ─────────────────────────────────────────────────────
  await check("scrubError keeps the class, code and frames, never the message", async () => {
    const { scrubError } = await import("../src/lib/posthog-server");
    const pg = Object.assign(new Error('new row violates check constraint\nFailing row contains (12, june@example.com, "3350 g")'), { name: "NeonDbError", code: "23514" });
    const out = scrubError(pg);
    eq(out.message, "NeonDbError 23514");
    ok(!/june|3350|Failing/.test(out.stack ?? ""), `stack leaks: ${out.stack}`);
    ok(/\n\s+at /.test(out.stack ?? ""), "no frames kept");
    eq(scrubError(new SyntaxError('Unexpected token \'j\', "june@example.com" is not valid JSON')).message, "SyntaxError");
    eq(scrubError(new Error("care_error")).message, "care_error");
    eq(scrubError("june@example.com").message, "Error");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Assertions for the public site's waitlist (src/lib/waitlist.ts and
 * POST /api/waitlist): email and month validation, the honeypot, the
 * 204/400/429/503/500 answers, that a second sign-up with the same address
 * (in any case or spacing) adds nothing, and that nothing sent ever reaches
 * a log or an error report.
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

const NOW = new Date("2026-10-26T15:00:00Z");
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

  // ── month ─────────────────────────────────────────────────────────────
  await check("a month inside the window is stored as its first day", () => {
    eq(w.babyMonthFrom("2026-11", NOW), "2026-11-01");
    eq(w.babyMonthFrom("2024-10", NOW), "2024-10-01", "24 months back");
    eq(w.babyMonthFrom("2027-10", NOW), "2027-10-01", "12 months ahead");
  });
  await check("no month is fine", () => {
    eq(w.babyMonthFrom(undefined, NOW), null);
    eq(w.babyMonthFrom(null, NOW), null);
    eq(w.babyMonthFrom("", NOW), null);
  });
  await check("a bad or far-off month is refused", () => {
    for (const b of ["2026-13", "2026-00", "2026-1", "26-11", "2026-11-05", "November", "2024-09", "2027-11", 202611, {}]) {
      eq(w.babyMonthFrom(b, NOW), "invalid", JSON.stringify(b));
    }
  });
  await check("every month the form offers is one the server takes", () => {
    const { expecting, born } = w.babyMonthOptions(NOW);
    eq(expecting.length, 10, "expecting");
    eq(born.length, 12, "born");
    eq(expecting[0], { value: "2026-10", label: "October 2026" }, "first expecting");
    eq(born[0].value, "2026-09", "first born");
    eq(born[11].value, "2025-10", "last born");
    for (const o of [...expecting, ...born]) ok(w.babyMonthFrom(o.value, NOW) !== "invalid", `${o.value} refused`);
    eq(new Set([...expecting, ...born].map((o) => o.value)).size, 22, "no month twice");
  });
  await check("the options roll over the year end", () => {
    const { expecting, born } = w.babyMonthOptions(new Date("2026-12-31T23:30:00Z"));
    eq(expecting.slice(0, 2).map((o) => o.value), ["2026-12", "2027-01"]);
    eq(born[0].value, "2026-11");
  });

  // ── the POST ──────────────────────────────────────────────────────────
  type Row = { email: string; babyMonth: string | null; at: number };
  function harness(opts: { allowed?: boolean; offline?: boolean; throws?: boolean } = {}) {
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
      save: async (entry: { email: string; babyMonth: string | null }) => {
        saves++;
        if (opts.throws) throw Object.assign(new Error(`duplicate key value (email)=(${entry.email})`), { name: "NeonDbError" });
        if (opts.offline) return "offline" as const;
        if (!table.has(entry.email)) table.set(entry.email, { ...entry, at: ++clock });
        return "saved" as const;
      },
      report: (e: Error) => {
        reports.push(e);
      },
      now: () => NOW,
    };
    const post = (body: unknown, type = "application/json") =>
      w.handleWaitlist(
        new Request("https://site.invalid/api/waitlist", {
          method: "POST",
          headers: { "content-type": type },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        deps
      );
    return { table, reports, post, counts: () => ({ limited, saves }) };
  }

  await check("a sign-up is 204 with no body, and saves the normalized address and month", async () => {
    const h = harness();
    const res = await h.post({ email: ` ${PERSON} `, baby_month: "2026-12" });
    eq(res.status, 204, "status");
    eq(await res.text(), "", "body");
    eq([...h.table.values()].map(({ email, babyMonth }) => ({ email, babyMonth })), [{ email: "june.parent@example.com", babyMonth: "2026-12-01" }]);
  });
  await check("signing up again, in another case, adds nothing and still says 204", async () => {
    const h = harness();
    eq((await h.post({ email: PERSON })).status, 204, "first");
    eq((await h.post({ email: PERSON.toUpperCase(), baby_month: "2027-01" })).status, 204, "second");
    eq((await h.post({ email: PERSON.toLowerCase() })).status, 204, "third");
    eq(h.table.size, 1, "rows");
    eq(h.table.get("june.parent@example.com")?.at, 1, "first row kept");
    eq(h.table.get("june.parent@example.com")?.babyMonth, null, "first answer kept");
  });
  await check("a form-encoded sign-up works too", async () => {
    const h = harness();
    const res = await h.post("email=june%40example.org&baby_month=2026-10&website=", "application/x-www-form-urlencoded");
    eq(res.status, 204);
    ok(h.table.has("june@example.org"), "saved");
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
  await check("a bad month is 400", async () => {
    const h = harness();
    const res = await h.post({ email: PERSON, baby_month: "2031-01" });
    eq(res.status, 400);
    eq(await res.json(), { error: w.WAITLIST_ERRORS.month });
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
        await h.post({ email: PERSON, baby_month: "2026-12" });
        await h.post({ email: "june@example" });
        await h.post({ email: PERSON, website: "bot" });
      }
    } finally {
      Object.assign(console, orig);
    }
    ok(!seen.some((s) => /june|example/i.test(s)), `logged: ${seen.join(" | ")}`);
  });

  // ── the store ─────────────────────────────────────────────────────────
  await check("the insert is one idempotent statement with the address and month as parameters", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const run = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return [];
    };
    eq(await w.addToWaitlist({ email: "june@example.com", babyMonth: "2026-12-01" }, run), "saved");
    eq(calls.length, 1, "statements");
    ok(/ON CONFLICT \(email\) DO NOTHING/.test(calls[0].sql), "no ON CONFLICT DO NOTHING");
    ok(!calls[0].sql.includes("june"), "address inlined in SQL");
    eq(calls[0].params, ["june@example.com", "2026-12-01"]);
  });
  await check("no database: the store says offline", async () => {
    eq(await w.addToWaitlist({ email: "june@example.com", babyMonth: null }, async () => null), "offline");
  });
  await check("the migration creates the table with a unique email, additively", () => {
    const sql = readFileSync(join(__dirname, "../src/lib/migrate.ts"), "utf8");
    const m = /CREATE TABLE IF NOT EXISTS maple_waitlist \(([\s\S]*?)\n\s*\)/.exec(sql);
    ok(m, "no CREATE TABLE IF NOT EXISTS maple_waitlist");
    ok(/email TEXT NOT NULL UNIQUE/.test(m![1]), "email isn't unique");
    ok(/baby_month DATE,/.test(m![1]), "baby_month isn't an optional DATE");
    ok(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/.test(m![1]), "created_at has no default");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

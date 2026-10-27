/**
 * The public site's waitlist (POST /api/waitlist): an email address and
 * nothing else. Nothing here logs what was sent.
 */

export type WaitlistEntry = { email: string };

export type WaitlistSave = "saved" | "full" | "offline";

type Run = (sql: string, params: unknown[]) => Promise<unknown[] | null>;

export type WaitlistDeps = {
  limit: (req: Request) => Promise<{ allowed: boolean }>;
  save: (entry: WaitlistEntry) => Promise<WaitlistSave>;
  report: (error: Error) => unknown;
};

/** New addresses per day across everyone, so a script rotating IPs can't grow the family's database without bound. */
export const WAITLIST_DAILY_MAX = 200;

const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const BODY_MAX = 2000;
const LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const EMAIL_RE = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@${LABEL}(?:\\.${LABEL})+$`);
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export const WAITLIST_ERRORS = {
  email: "Enter an email address like name@example.com.",
  body: "Send an email address to join.",
  cross: "Join from Maple’s own page at maplebaby.app.",
  limit: "Too many tries from this connection. Try again in an hour.",
  full: "The waitlist is full for today. Try again tomorrow.",
  offline: "The waitlist is offline right now. Try again later.",
  failed: "Couldn’t add you. Try again in a minute.",
} as const;

export type WaitlistError = keyof typeof WAITLIST_ERRORS;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return null;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  if (local.length > LOCAL_MAX || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!TLD_RE.test(email.slice(email.lastIndexOf(".") + 1))) return null;
  return email;
}

export type WaitlistParse = { kind: "entry"; entry: WaitlistEntry } | { kind: "bot" } | { kind: "invalid" };

export function parseWaitlist(body: Record<string, unknown>): WaitlistParse {
  if (typeof body.website === "string" && body.website.trim() !== "") return { kind: "bot" };
  const email = normalizeEmail(body.email);
  return email ? { kind: "entry", entry: { email } } : { kind: "invalid" };
}

const isForm = (req: Request) => (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => null);
  if (text == null || text.length > BODY_MAX) return null;
  if (isForm(req)) return Object.fromEntries(new URLSearchParams(text));
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An error's class only: a database error can quote the row it was writing. */
function scrubbed(error: unknown): Error {
  const name = (error as { name?: unknown } | null)?.name;
  return new Error(typeof name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "waitlist_error");
}

type Outcome = { kind: "joined" } | { kind: WaitlistError; status: number };

async function decide(req: Request, deps: WaitlistDeps): Promise<Outcome> {
  try {
    if (req.headers.get("sec-fetch-site") === "cross-site") return { kind: "cross", status: 403 };
    const { allowed } = await deps.limit(req);
    if (!allowed) return { kind: "limit", status: 429 };
    const body = await readBody(req);
    if (!body) return { kind: "body", status: 400 };
    const parsed = parseWaitlist(body);
    if (parsed.kind === "invalid") return { kind: "email", status: 400 };
    if (parsed.kind === "bot") return { kind: "joined" };
    const saved = await deps.save(parsed.entry);
    if (saved !== "saved") return { kind: saved, status: 503 };
    return { kind: "joined" };
  } catch (error) {
    await deps.report(scrubbed(error));
    return { kind: "failed", status: 500 };
  }
}

/**
 * 204 whether the address is new or already on the list (and for a filled honeypot), so the answer never says
 * who signed up. A plain form post (no script yet) is sent on to /waitlist, which says how it went.
 */
export async function handleWaitlist(req: Request, deps: WaitlistDeps): Promise<Response> {
  const outcome = await decide(req, deps);
  if (isForm(req)) return new Response(null, { status: 303, headers: { Location: `/waitlist?r=${outcome.kind}` } });
  if (outcome.kind === "joined") return new Response(null, { status: 204 });
  return Response.json({ error: WAITLIST_ERRORS[outcome.kind] }, { status: outcome.status });
}

export const WAITLIST_INSERT = `WITH today AS (SELECT count(*)::int AS n FROM maple_waitlist WHERE created_at > NOW() - INTERVAL '1 day'),
  added AS (INSERT INTO maple_waitlist (email) SELECT $1::text FROM today WHERE n < $2 ON CONFLICT (email) DO NOTHING)
SELECT n FROM today`;

export async function addToWaitlist(entry: WaitlistEntry, run: Run): Promise<WaitlistSave> {
  const rows = await run(WAITLIST_INSERT, [entry.email, WAITLIST_DAILY_MAX]);
  if (!rows) return "offline";
  const before = Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
  return before < WAITLIST_DAILY_MAX ? "saved" : "full";
}

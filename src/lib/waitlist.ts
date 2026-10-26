/**
 * The public site's waitlist (POST /api/waitlist): an email and, if given,
 * the month a baby is due or was born. Nothing here logs what was sent.
 */

export type WaitlistEntry = { email: string; babyMonth: string | null };

type Run = (sql: string, params: unknown[]) => Promise<unknown[] | null>;

export type WaitlistDeps = {
  limit: (req: Request) => Promise<{ allowed: boolean }>;
  save: (entry: WaitlistEntry) => Promise<"saved" | "offline">;
  report: (error: Error) => unknown;
  now: () => Date;
};

const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const BODY_MAX = 2000;
const LABEL = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)";
const EMAIL_RE = new RegExp(`^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]+@${LABEL}(?:\\.${LABEL})+$`);
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Months a waitlist answer may name, counted from this month: a baby born up to two years ago, or due within a year. */
const MONTHS_BACK = 24;
const MONTHS_AHEAD = 12;

export const WAITLIST_ERRORS = {
  email: "Enter an email address like name@example.com.",
  month: "Pick a month from the list, or leave it blank.",
  body: "Send an email address and, if you like, a month.",
  limit: "Too many tries from this connection. Try again in an hour.",
  offline: "The waitlist is offline right now. Try again later.",
  failed: "Couldn't add you just now. Try again in a minute.",
} as const;

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

const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/** "2026-11" → "2026-11-01" (stored as a DATE); blank → null; anything else, or a month outside the window, → "invalid". */
export function babyMonthFrom(raw: unknown, now: Date): string | null | "invalid" {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(raw.trim());
  if (!m) return "invalid";
  const offset = Number(m[1]) * 12 + Number(m[2]) - 1 - monthIndex(now);
  if (offset < -MONTHS_BACK || offset > MONTHS_AHEAD) return "invalid";
  return `${m[1]}-${m[2]}-01`;
}

export type MonthOption = { value: string; label: string };

/** The form's choices: this month and the next nine for "Expecting", the twelve before it for "Already here". */
export function babyMonthOptions(now: Date): { expecting: MonthOption[]; born: MonthOption[] } {
  const at = (offset: number): MonthOption => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return {
      value: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    };
  };
  return {
    expecting: Array.from({ length: 10 }, (_, i) => at(i)),
    born: Array.from({ length: 12 }, (_, i) => at(-1 - i)),
  };
}

export type WaitlistParse =
  | { kind: "entry"; entry: WaitlistEntry }
  | { kind: "bot" }
  | { kind: "invalid"; error: string };

export function parseWaitlist(body: Record<string, unknown>, now: Date): WaitlistParse {
  if (typeof body.website === "string" && body.website.trim() !== "") return { kind: "bot" };
  const email = normalizeEmail(body.email);
  if (!email) return { kind: "invalid", error: WAITLIST_ERRORS.email };
  const babyMonth = babyMonthFrom(body.baby_month, now);
  if (babyMonth === "invalid") return { kind: "invalid", error: WAITLIST_ERRORS.month };
  return { kind: "entry", entry: { email, babyMonth } };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => null);
  if (text == null || text.length > BODY_MAX) return null;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
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

const fail = (error: string, status: number) => Response.json({ error }, { status });

/** 204 whether the address is new or already on the list (and for a filled honeypot), so the answer never says who signed up. */
export async function handleWaitlist(req: Request, deps: WaitlistDeps): Promise<Response> {
  try {
    const { allowed } = await deps.limit(req);
    if (!allowed) return fail(WAITLIST_ERRORS.limit, 429);
    const body = await readBody(req);
    if (!body) return fail(WAITLIST_ERRORS.body, 400);
    const parsed = parseWaitlist(body, deps.now());
    if (parsed.kind === "invalid") return fail(parsed.error, 400);
    if (parsed.kind === "entry" && (await deps.save(parsed.entry)) === "offline") return fail(WAITLIST_ERRORS.offline, 503);
    return new Response(null, { status: 204 });
  } catch (error) {
    await deps.report(scrubbed(error));
    return fail(WAITLIST_ERRORS.failed, 500);
  }
}

export const WAITLIST_INSERT = `INSERT INTO maple_waitlist (email, baby_month) VALUES ($1, $2::date) ON CONFLICT (email) DO NOTHING`;

export async function addToWaitlist(entry: WaitlistEntry, run: Run): Promise<"saved" | "offline"> {
  const rows = await run(WAITLIST_INSERT, [entry.email, entry.babyMonth]);
  return rows ? "saved" : "offline";
}

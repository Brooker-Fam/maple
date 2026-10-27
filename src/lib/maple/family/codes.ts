import { createHash, randomInt } from "crypto";
import { query } from "@/lib/db";

/**
 * Invite codes for MAPLE_SIGNUP=invite: each one makes `max_uses` families
 * (one by default). Only a hash is stored, so the code is shown once, when
 * it's made (make-code.ts).
 */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUPS = 3;
const GROUP_LEN = 5;
const BODY = new RegExp(`^[${ALPHABET}]{${GROUPS * GROUP_LEN}}$`);

/** The code's letters only, uppercased, without the MAPLE- prefix or separators; null when it can't be one. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const body = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^MAPLE/, "");
  return BODY.test(body) ? body : null;
}

export function codeHash(normalized: string): string {
  return createHash("sha256").update(`maple-signup-code:${normalized}`).digest("hex");
}

export function formatCode(normalized: string): string {
  const groups = normalized.match(new RegExp(`.{${GROUP_LEN}}`, "g")) ?? [];
  return ["MAPLE", ...groups].join("-");
}

export function newCode(): string {
  let body = "";
  for (let i = 0; i < GROUPS * GROUP_LEN; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return body;
}

/** Stores a new code's hash and returns the code, formatted, for the one time it's shown. */
export async function createSignupCode(opts: { label?: string | null; maxUses?: number; days?: number | null } = {}): Promise<string> {
  const code = newCode();
  const rows = await query(
    `INSERT INTO maple_signup_codes (code_hash, label, max_uses, expires_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() + make_interval(days => $4::int) END)
     RETURNING code_hash`,
    [codeHash(code), opts.label ?? null, opts.maxUses ?? 1, opts.days ?? null]
  );
  if (!rows?.length) throw new Error("No database: set DATABASE_URL to make a code");
  return formatCode(code);
}

/** True while a code can still make a family. Null when the database can't be read. */
export async function codeUsable(normalized: string): Promise<boolean | null> {
  const rows = await query(
    `SELECT 1 FROM maple_signup_codes
     WHERE code_hash = $1 AND uses < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [codeHash(normalized)]
  ).catch(() => null);
  return rows ? rows.length > 0 : null;
}

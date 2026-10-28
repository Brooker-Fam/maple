import { encryptSecret, openSecret } from "@/lib/secret-box";
import { normalizeEmail } from "@/lib/waitlist";

export type AdminRef = { kind: "person"; email: string } | { kind: "family"; id: number } | { kind: "waitlist"; id: number };
export const ADMIN_REF_TTL_MS = 15 * 60_000;
const PURPOSE = "maple-admin-contact-ref";

/** Masks the domain and all but the first local character. */
export function maskAdminEmail(email: string): string {
  const normalized = normalizeEmail(email);
  return normalized ? `${normalized[0]}•••@•••` : "•••@•••";
}

function validRef(value: unknown): value is AdminRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === "person") return typeof ref.email === "string" && normalizeEmail(ref.email) === ref.email;
  return (ref.kind === "family" || ref.kind === "waitlist") && Number.isSafeInteger(ref.id) && Number(ref.id) > 0;
}

/** Opaque, short-lived handles keep account addresses out of URLs and initial payloads. */
export function sealAdminRef(ref: AdminRef, now = Date.now()): string {
  if (!validRef(ref)) throw new Error("Invalid admin reference");
  return encryptSecret(JSON.stringify({ purpose: PURPOSE, issuedAt: now, expiresAt: now + ADMIN_REF_TTL_MS, ref }));
}

export function openAdminRef(raw: unknown, now = Date.now()): AdminRef | null {
  if (typeof raw !== "string" || !raw || raw.length > 4096) return null;
  try {
    const opened = openSecret(raw);
    if (opened.prev) return null;
    const value = JSON.parse(opened.text);
    if (value?.purpose !== PURPOSE || !Number.isSafeInteger(value.issuedAt) || value.issuedAt > now
      || value.expiresAt !== value.issuedAt + ADMIN_REF_TTL_MS || value.expiresAt <= now || !validRef(value.ref)) return null;
    // Return just the allowlisted keys, never arbitrary data from a token.
    return value.ref.kind === "person" ? { kind: "person", email: value.ref.email } : { kind: value.ref.kind, id: value.ref.id };
  } catch {
    return null;
  }
}

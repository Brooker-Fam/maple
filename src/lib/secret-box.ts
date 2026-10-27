import * as crypto from "node:crypto";
import { MAPLE_ORIGIN } from "@/lib/maple/origin";

const keyOf = (secret: string) => crypto.createHash("sha256").update(secret).digest();
const envSecret = (name: string) => process.env[name]?.trim() || null;

/**
 * AES-256-GCM, sealed with MAPLE_SESSION_SECRET once it's set (Maple's own),
 * else GOOGLE_CLIENT_SECRET, the derivation brooker-wedding uses, so a
 * session sealed by either deployment opens in the other while they share
 * the database. After the switch, MAPLE_SESSION_SECRET_PREV (the old
 * GOOGLE_CLIENT_SECRET) still opens what was sealed before it.
 */
function sealKey(): Buffer {
  const secret = envSecret("MAPLE_SESSION_SECRET") ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET not set");
  return keyOf(secret);
}

function openKeys(): { key: Buffer; prev: boolean }[] {
  const own = envSecret("MAPLE_SESSION_SECRET");
  if (!own) return [{ key: sealKey(), prev: false }];
  const prev = envSecret("MAPLE_SESSION_SECRET_PREV");
  return [{ key: keyOf(own), prev: false }, ...(prev ? [{ key: keyOf(prev), prev: true }] : [])];
}

export function encryptSecret(plaintext: string): string {
  const key = sealKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * The plaintext, and whether only MAPLE_SESSION_SECRET_PREV opened it.
 * Everything that key sealed predates other families (sign-up stays off
 * until MAPLE_SESSION_SECRET is set), so callers let it open family 1 only.
 */
export function openSecret(ciphertext: string): { text: string; prev: boolean } {
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Invalid encrypted value");
  let failure: unknown = null;
  for (const { key, prev } of openKeys()) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      return { text: decipher.update(Buffer.from(encB64, "base64")) + decipher.final("utf8"), prev };
    } catch (error) {
      failure = error;
    }
  }
  throw failure ?? new Error("Invalid encrypted value");
}

export function decryptSecret(ciphertext: string): string {
  return openSecret(ciphertext).text;
}

// Production always answers on MAPLE_ORIGIN, so Google's redirect URI stays the registered one
// whichever alias (a *.vercel.app URL) the request came in on.
export function getAppBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  if (process.env.VERCEL_ENV === "production") return MAPLE_ORIGIN;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

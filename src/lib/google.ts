import * as crypto from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { google, Auth } from "googleapis";

type OAuth2Client = Auth.OAuth2Client;

// ── Encryption (AES-256-GCM) — mirrors spotify.ts ─────────────────────

function getEncryptionKey(): Buffer {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET not set");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, encB64] = ciphertext.split(":");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Invalid encrypted value");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

// ── Config store ──────────────────────────────────────────────────────

function getGoogleDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return neon(url);
}

async function googleQuery(sql: string, params: unknown[] = []) {
  const db = getGoogleDb();
  if (!db) return null;
  return db.query(sql, params);
}

async function getConfig(key: string): Promise<string | null> {
  const result = await googleQuery(
    "SELECT value FROM google_config WHERE key = $1",
    [key]
  );
  if (!result || result.length === 0) return null;
  try {
    return decrypt(result[0].value);
  } catch {
    return result[0].value;
  }
}

async function setConfig(
  key: string,
  value: string,
  shouldEncrypt = true
): Promise<void> {
  const stored = shouldEncrypt ? encrypt(value) : value;
  await googleQuery(
    `INSERT INTO google_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, stored]
  );
}

async function deleteConfig(key: string): Promise<void> {
  await googleQuery("DELETE FROM google_config WHERE key = $1", [key]);
}

// ── OAuth helpers ─────────────────────────────────────────────────────

const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

function getCredentials() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google credentials not configured");
  }
  return { clientId, clientSecret };
}

function getRedirectUri(): string {
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    "http://localhost:3000";
  return `${base}/api/calendar/google/callback`;
}

export function getAuthorizeUrl(state: string): string {
  const { clientId, clientSecret } = getCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string): Promise<void> {
  const { clientId, clientSecret } = getCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret, getRedirectUri());
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and try again."
    );
  }
  if (!tokens.access_token) {
    throw new Error("No access_token returned from Google.");
  }

  await setConfig("access_token", tokens.access_token);
  await setConfig("refresh_token", tokens.refresh_token);
  if (tokens.expiry_date) {
    await setConfig("token_expires_at", String(tokens.expiry_date), false);
  }
  if (tokens.scope) {
    await setConfig("scope", tokens.scope, false);
  }
}

/**
 * Returns an OAuth2Client with the stored tokens loaded. The client auto-refreshes
 * via the `tokens` event — when googleapis refreshes, persist the new access token.
 */
export async function getOAuthClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = getCredentials();
  const client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    getRedirectUri()
  );

  const accessToken = await getConfig("access_token");
  const refreshToken = await getConfig("refresh_token");
  const expiresAt = await getConfig("token_expires_at");
  if (!refreshToken) {
    throw new Error("Google Calendar not connected. Visit /calendar/admin to connect.");
  }

  client.setCredentials({
    access_token: accessToken ?? undefined,
    refresh_token: refreshToken,
    expiry_date: expiresAt ? Number(expiresAt) : undefined,
  });

  client.on("tokens", (tokens) => {
    if (tokens.access_token) {
      setConfig("access_token", tokens.access_token).catch((err) => {
        console.error("Failed to persist refreshed Google access token:", err);
      });
    }
    if (tokens.expiry_date) {
      setConfig("token_expires_at", String(tokens.expiry_date), false).catch(
        (err) => {
          console.error("Failed to persist refreshed Google expiry:", err);
        }
      );
    }
  });

  return client;
}

export async function isConnected(): Promise<boolean> {
  const refreshToken = await getConfig("refresh_token");
  return !!refreshToken;
}

export async function disconnect(): Promise<void> {
  // Attempt to revoke the token upstream (best-effort), then clear local state.
  try {
    const client = await getOAuthClient();
    await client.revokeCredentials();
  } catch (err) {
    console.warn("Google revokeCredentials failed (continuing):", err);
  }
  await deleteConfig("access_token");
  await deleteConfig("refresh_token");
  await deleteConfig("token_expires_at");
  await deleteConfig("scope");
}

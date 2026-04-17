import crypto from "node:crypto";

/**
 * Self-contained HMAC-signed tokens for the MCP OAuth shim. No storage —
 * the token IS the payload, signed so we can trust it on the way back in.
 *
 * Secret derivation: MCP_SECRET env var, or falls back to a value derived
 * from ADMIN_PASS. Rotating ADMIN_PASS therefore invalidates all tokens,
 * which is a feature, not a bug.
 */
function getSecret(): string {
  const explicit = process.env.MCP_SECRET;
  if (explicit && explicit.length > 0) return explicit;
  const pass = process.env.ADMIN_PASS;
  if (!pass) return "brooker-mcp-dev-secret-change-me";
  return `brooker-mcp:${pass}`;
}

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function sign(payload: string): string {
  return base64urlEncode(
    crypto.createHmac("sha256", getSecret()).update(payload).digest()
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface SignedEnvelope<T> {
  p: T;
  iat: number;
  exp: number;
}

function pack<T>(payload: T, ttlSeconds: number, prefix: string): string {
  const env: SignedEnvelope<T> = {
    p: payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64urlEncode(Buffer.from(JSON.stringify(env)));
  const sig = sign(`${prefix}.${body}`);
  return `${prefix}.${body}.${sig}`;
}

function unpack<T>(token: string, prefix: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [gotPrefix, body, sig] = parts;
  if (gotPrefix !== prefix) return null;
  const expected = sign(`${prefix}.${body}`);
  if (!timingSafeEqual(sig, expected)) return null;
  let env: SignedEnvelope<T>;
  try {
    env = JSON.parse(base64urlDecode(body).toString("utf8")) as SignedEnvelope<T>;
  } catch {
    return null;
  }
  if (typeof env.exp !== "number" || env.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  return env.p;
}

// ---------- Authorization codes ----------

export interface AuthCodePayload {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  scope: string;
  sub: string;
}

export function mintAuthCode(payload: AuthCodePayload): string {
  return pack(payload, 60 * 10, "mcpcode");
}

export function verifyAuthCode(code: string): AuthCodePayload | null {
  return unpack<AuthCodePayload>(code, "mcpcode");
}

// ---------- Access tokens ----------

export interface AccessTokenPayload {
  sub: string;
  scope: string;
  client_id: string;
}

export const ACCESS_TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days

export function mintAccessToken(payload: AccessTokenPayload): string {
  return pack(payload, ACCESS_TOKEN_TTL, "mcpat");
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  return unpack<AccessTokenPayload>(token, "mcpat");
}

// ---------- PKCE ----------

export function verifyPkce(
  verifier: string,
  challenge: string,
  method: "S256" | "plain"
): boolean {
  if (method === "plain") return timingSafeEqual(verifier, challenge);
  const hash = base64urlEncode(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return timingSafeEqual(hash, challenge);
}

// ---------- Basic Auth verification (for /authorize login form) ----------

export function verifyAdminCreds(user: string, pass: string): boolean {
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_USER || !ADMIN_PASS) return false;
  if (user.length !== ADMIN_USER.length || pass.length !== ADMIN_PASS.length) {
    return false;
  }
  return (
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(ADMIN_USER)) &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASS))
  );
}

export function verifyBasicAuthHeader(header: string | null): boolean {
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  return verifyAdminCreds(decoded.slice(0, idx), decoded.slice(idx + 1));
}

// ---------- Public origin detection (for issuer/resource URLs) ----------

export function publicOrigin(req: Request): string {
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto");
  if (fwdHost) {
    return `${fwdProto ?? "https"}://${fwdHost}`;
  }
  const url = new URL(req.url);
  return url.origin;
}

import { createPrivateKey, createPublicKey, sign, timingSafeEqual, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { normalizeEmail } from "@/lib/waitlist";

/** Apple handles identity only. Never retain its access/refresh tokens or trust the callback's `user` JSON. */
const ISSUER = "https://appleid.apple.com";
export const APPLE_CALLBACK_PATH = "/api/maple/auth/apple/callback";
const MAX_TOKEN = 16_384;
const MAX_RESPONSE = 131_072;
const KEY_TTL_MS = 60 * 60_000;
const REFRESH_INTERVAL_MS = 60_000;

type Env = Record<string, string | undefined>;
type AppleConfig = { clientId: string; teamId: string; keyId: string; key: KeyObject };
export type AppleIdentity = { subject: string; email: string | null; name: null };
export type AppleSigningKey = JsonWebKey & { kid?: string; alg?: string; use?: string };
export type AppleDeps = { env: Env; fetch: typeof fetch; now: () => number };

function config(env: Env): AppleConfig | null {
  const clientId = env.APPLE_CLIENT_ID?.trim();
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const pem = env.APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!clientId || !/^[A-Za-z0-9.-]{1,255}$/.test(clientId) || !teamId || !/^[A-Z0-9]{10}$/.test(teamId) || !keyId || !/^[A-Z0-9]{10}$/.test(keyId) || !pem) return null;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { clientId, teamId, keyId, key };
  } catch {
    return null;
  }
}

export function isAppleConfigured(): boolean {
  return config(process.env) !== null;
}

function callback(site: string): string {
  const url = new URL(site);
  // The caller supplies a trusted origin, never an arbitrary return URL.
  if (url.origin !== site || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("apple_origin");
  return `${site}${APPLE_CALLBACK_PATH}`;
}

export function appleAuthorizeUrl(state: string, nonce: string, site: string): string {
  const c = config(process.env);
  if (!c) throw new Error("apple_not_configured");
  if (!state || state.length > 4096 || !nonce || nonce.length > 256) throw new Error("apple_state");
  const url = new URL(`${ISSUER}/auth/authorize`);
  url.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: callback(site),
    response_type: "code",
    response_mode: "form_post",
    scope: "name email",
    state,
    nonce,
  }).toString();
  return url.toString();
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function clientSecret(c: AppleConfig, now: number): string {
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: "ES256", kid: c.keyId })}.${encode({ iss: c.teamId, iat, exp: iat + 300, aud: ISSUER, sub: c.clientId })}`;
  // JWT uses the fixed-width R || S signature, not ASN.1 DER.
  return `${body}.${sign("sha256", Buffer.from(body), { key: c.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decode(raw: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw) return null;
  return object(JSON.parse(bytes.toString("utf8")));
}

/** Signature and claims are checked before any identity field leaves this function. `now` is Unix milliseconds. */
export function verifyAppleIdToken(
  token: string,
  opts: { audience: string; nonce: string; keys: AppleSigningKey[]; now?: number }
): AppleIdentity | null {
  try {
    if (!token || token.length > MAX_TOKEN || !opts.audience || !opts.nonce || opts.nonce.length > 256) return null;
    const parts = token.split(".");
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return null;
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 128 || header.crit !== undefined) return null;
    const matching = opts.keys.filter((k) => k.kid === header.kid && k.kty === "RSA" && k.alg === "RS256" && k.use === "sig");
    if (matching.length !== 1) return null;
    const key = createPublicKey({ key: matching[0], format: "jwk" });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.toString("base64url") !== parts[2] || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) return null;
    const now = Math.floor((opts.now ?? Date.now()) / 1000);
    if (claims.iss !== ISSUER || claims.aud !== opts.audience || !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= now || !Number.isSafeInteger(claims.iat) || Number(claims.iat) > now + 60 || Number(claims.iat) >= Number(claims.exp)) return null;
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > now + 60)) return null;
    if (typeof claims.sub !== "string" || !/^[A-Za-z0-9._-]{1,255}$/.test(claims.sub) || typeof claims.nonce !== "string") return null;
    const got = Buffer.from(claims.nonce);
    const want = Buffer.from(opts.nonce);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    let email: string | null = null;
    if (claims.email !== undefined) {
      if (claims.email_verified !== true && claims.email_verified !== "true") return null;
      email = normalizeEmail(claims.email);
      if (!email) return null;
    }
    return { subject: claims.sub, email, name: null };
  } catch {
    return null;
  }
}

/** Bound even chunked responses; provider failures must never log a token or an address. */
async function json(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    reader.releaseLock();
  }
}

let cached: { keys: AppleSigningKey[]; fetchedAt: number } | undefined;
let pending: Promise<AppleSigningKey[]> | undefined;

async function loadKeys(fetcher: typeof fetch, now: number, kid: string): Promise<AppleSigningKey[]> {
  // Only production calls share a cache; injected transports cannot poison later calls.
  const shared = fetcher === globalThis.fetch;
  if (shared && cached && now - cached.fetchedAt < KEY_TTL_MS) {
    if (cached.keys.some((k) => k.kid === kid) || now - cached.fetchedAt < REFRESH_INTERVAL_MS) return cached.keys;
  }
  if (shared && pending) return pending;
  const work = async () => {
    const data = await json(await fetcher(`${ISSUER}/auth/keys`, { signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store" }));
    if (!data || !Array.isArray(data.keys) || data.keys.length > 20 || data.keys.some((k) => !object(k))) return [];
    const keys = data.keys as AppleSigningKey[];
    if (shared) cached = { keys, fetchedAt: now };
    return keys;
  };
  if (!shared) return work();
  pending = work();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

/** Exchanges a single-use Apple authorization code, then verifies the signed ID token. */
export async function appleIdentityFromCode(code: string, nonce: string, site: string, deps: Partial<AppleDeps> = {}): Promise<AppleIdentity | null> {
  try {
    const c = config(deps.env ?? process.env);
    if (!c || !code || code.length > 2048 || !nonce || nonce.length > 256) return null;
    const fetcher = deps.fetch ?? globalThis.fetch;
    const now = (deps.now ?? Date.now)();
    const data = await json(await fetcher(`${ISSUER}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: c.clientId, client_secret: clientSecret(c, now), redirect_uri: callback(site) }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      cache: "no-store",
    }));
    if (typeof data?.id_token !== "string" || data.id_token.length > MAX_TOKEN) return null;
    const header = decode(data.id_token.split(".")[0]);
    if (!header || typeof header.kid !== "string" || header.kid.length > 128) return null;
    const keys = await loadKeys(fetcher, now, header.kid);
    return verifyAppleIdToken(data.id_token, { audience: c.clientId, nonce, keys, now: (deps.now ?? Date.now)() });
  } catch {
    return null;
  }
}

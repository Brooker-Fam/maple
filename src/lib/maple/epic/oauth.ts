import { EPIC_SCOPES, type EpicConfig } from "./config";
import { pkceChallenge } from "./crypto";

export class EpicOAuthError extends Error {
  constructor() { super("epic_authorization_failed"); }
}

export function authorizationUrl(config: EpicConfig, state: string, verifier: string): string {
  const url = new URL(config.provider.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri,
    aud: config.provider.baseUrl, scope: EPIC_SCOPES, state,
    code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** No refresh tokens, credentials in URLs, token logging, or redirects carrying credentials. */
export async function exchangeCode(config: EpicConfig, code: string, verifier: string): Promise<{ accessToken: string; patientId: string; expiresIn: number }> {
  try {
    const response = await fetch(config.provider.tokenUrl, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: config.clientId, redirect_uri: config.redirectUri, code_verifier: verifier }),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 64_000 || !response.body) throw new EpicOAuthError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64_000) { await reader.cancel(); throw new EpicOAuthError(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof body.access_token !== "string" || !body.access_token || body.access_token.length > 16_000 || /[\r\n]/.test(body.access_token) ||
        typeof body.patient !== "string" || !/^[A-Za-z0-9.-]{1,64}$/.test(body.patient) ||
        typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer" ||
        !Number.isFinite(body.expires_in) || body.expires_in < 1) throw new EpicOAuthError();
    return { accessToken: body.access_token, patientId: body.patient, expiresIn: Math.min(body.expires_in, 900) };
  } catch { throw new EpicOAuthError(); }
}

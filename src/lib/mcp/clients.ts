import { trustedRedirect } from "./auth";

const METADATA_URLS = new Set([
  "https://claude.ai/oauth/mcp-oauth-client-metadata",
  "https://claude.ai/oauth/claude-code-client-metadata",
  "https://chatgpt.com/oauth/client.json",
]);
const MAX_METADATA_BYTES = 5 * 1024;
const MAX_CACHE_SECONDS = 300;
const LOOPBACK_URI = /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?(\/[^#]*)?$/;

export class OAuthClientError extends Error {
  constructor(public readonly code: "invalid_client" | "invalid_redirect" | "unavailable") {
    super(code);
    this.name = "OAuthClientError";
  }
}

export type OAuthClientInfo = { name: string; host: string; metadataUrl?: string };

type ClientMetadata = { info: OAuthClientInfo; redirects: string[] };
type ResolverOptions = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };

function isUrlClientId(clientId: string): boolean {
  const cleaned = clientId.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(cleaned) || cleaned.startsWith("//")) return true;
  try {
    new URL(clientId);
    return true;
  } catch {
    return false;
  }
}

function legacyClient(redirectUri: string): OAuthClientInfo {
  if (!trustedRedirect(redirectUri)) throw new OAuthClientError("invalid_redirect");
  const uri = new URL(redirectUri);
  if (["claude.ai", "claude.com"].includes(uri.hostname)) return { name: "Claude", host: uri.host };
  if (["chatgpt.com", "chat.openai.com"].includes(uri.hostname)) return { name: "ChatGPT", host: uri.host };
  return { name: "this app", host: uri.host };
}

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.includes("#")) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) return false;
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_URI.test(uri));
  } catch {
    return false;
  }
}

function matchesRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const allowed = registered.match(LOOPBACK_URI);
  const actual = requested.match(LOOPBACK_URI);
  return !!allowed && !!actual && allowed[1] === actual[1] && allowed[2] === actual[2];
}

function includesCapability(value: unknown, required: string): boolean {
  return value === undefined || (Array.isArray(value) && value.includes(required) && value.every(item => typeof item === "string" && item.trim().length > 0));
}

function supportsPublicAuthentication(data: Record<string, unknown>): boolean {
  const methods = data.token_endpoint_auth_methods_supported;
  if (methods === undefined) return data.token_endpoint_auth_method === undefined || data.token_endpoint_auth_method === "none";
  return Array.isArray(methods) && methods.includes("none") && methods.every(method => typeof method === "string" && method.trim().length > 0);
}

function validateMetadata(value: unknown, clientId: string): ClientMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthClientError("invalid_client");
  const data = value as Record<string, unknown>;
  if (data.client_id !== clientId || !Array.isArray(data.redirect_uris) || !data.redirect_uris.length || !data.redirect_uris.every(validRedirect)) {
    throw new OAuthClientError("invalid_client");
  }
  if (!supportsPublicAuthentication(data)) throw new OAuthClientError("invalid_client");
  if (!includesCapability(data.grant_types, "authorization_code") || !includesCapability(data.response_types, "code")) {
    throw new OAuthClientError("invalid_client");
  }
  const host = new URL(clientId).host;
  const name = data.client_name === undefined ? host : data.client_name;
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw new OAuthClientError("invalid_client");
  return { info: { name: name.trim(), host, metadataUrl: clientId }, redirects: data.redirect_uris };
}

function cacheSeconds(headers: Headers): number {
  const control = headers.get("cache-control") ?? "";
  const directives = control.toLowerCase().split(",").map(value => value.trim());
  if (directives.some(value => /^(no-store|no-cache)(?:\s*=|$)/.test(value))) return 0;
  const ages = directives.filter(value => /^max-age\s*=/.test(value));
  if (ages.length > 1) return 0;
  const maxAge = ages[0];
  const match = maxAge?.match(/^max-age\s*=\s*(?:"(\d+)"|(\d+))$/);
  const seconds = match?.[1] ?? match?.[2];
  if (maxAge && seconds === undefined) return 0;
  const age = Number(headers.get("age") ?? 0);
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, Math.min(Number(seconds ?? MAX_CACHE_SECONDS), MAX_CACHE_SECONDS) - age);
}

async function readDocument(response: Response): Promise<unknown> {
  const isJson = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
  if (!isJson || Number(response.headers.get("content-length")) > MAX_METADATA_BYTES || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new OAuthClientError("invalid_client");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_METADATA_BYTES);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_METADATA_BYTES) throw new OAuthClientError("invalid_client");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    throw new OAuthClientError("invalid_client");
  }
}

async function fetchMetadata(clientId: string, fetcher: typeof fetch, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OAuthClientError("unavailable"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetcher(clientId, { headers: { accept: "application/json" }, credentials: "omit", redirect: "error", cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new OAuthClientError("unavailable");
        }
        const metadata = validateMetadata(await readDocument(response), clientId);
        return { metadata, seconds: cacheSeconds(response.headers) };
      })(),
    ]);
  } catch (error) {
    if (error instanceof OAuthClientError) throw error;
    throw new OAuthClientError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}

export function createOAuthClientResolver(options: ResolverOptions = {}) {
  const cache = new Map<string, { metadata: ClientMetadata; expiresAt: number }>();
  const now = options.now ?? Date.now;
  const fetcher: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  return async function resolveOAuthClient(clientId: string, redirectUri: string): Promise<OAuthClientInfo> {
    if (!clientId.trim()) throw new OAuthClientError("invalid_client");
    if (!METADATA_URLS.has(clientId)) {
      if (isUrlClientId(clientId)) throw new OAuthClientError("invalid_client");
      return legacyClient(redirectUri);
    }
    let cached = cache.get(clientId);
    if (!cached || cached.expiresAt <= now()) {
      cache.delete(clientId);
      const { metadata, seconds } = await fetchMetadata(clientId, fetcher, options.timeoutMs ?? 5_000);
      cached = { metadata, expiresAt: now() + seconds * 1000 };
      if (seconds > 0) cache.set(clientId, cached);
    }
    if (!validRedirect(redirectUri) || !cached.metadata.redirects.some(registered => matchesRedirect(registered, redirectUri))) {
      throw new OAuthClientError("invalid_redirect");
    }
    return { ...cached.metadata.info };
  };
}

export const resolveOAuthClient = createOAuthClientResolver();

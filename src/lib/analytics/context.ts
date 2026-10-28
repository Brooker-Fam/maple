import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { NextResponse } from "next/server";
import { analyticsConfig } from "./config";
import { analyticsSessionId, validAnalyticsSession } from "./session";
import { ATTRIBUTION_SCHEMA, initialAttribution, UUID, type AnalyticsAttribution } from "./policy";

export const ANALYTICS_COOKIE = "maple_analytics";
export const ANALYTICS_GENERATION_COOKIE = "maple_analytics_generation";
export const VISITOR_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
const schema = z.object({
  version: z.literal(1), visitorId: z.string().regex(UUID), sessionId: z.string().regex(UUID),
  issuedAt: z.number().int().nonnegative(), lastSeenAt: z.number().int().nonnegative(), initial: ATTRIBUTION_SCHEMA,
  session: ATTRIBUTION_SCHEMA.optional(),
}).strict();
export type AnalyticsContext = z.infer<typeof schema>;

function signingKey(): string | undefined {
  return process.env.MAPLE_ANALYTICS_SECRET?.trim() || process.env.MAPLE_SESSION_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET?.trim();
}

export function parseAnalyticsContext(value: unknown, now = Date.now()): AnalyticsContext | undefined {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return;
  const ctx = parsed.data;
  if (ctx.issuedAt > now || ctx.lastSeenAt > now || ctx.lastSeenAt < ctx.issuedAt || now - ctx.issuedAt >= VISITOR_LIFETIME_MS) return;
  return JSON.parse(JSON.stringify(ctx)) as AnalyticsContext;
}

function cookieValue(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function authBinding(request: Request, key: string): string {
  return createHmac("sha256", key).update(`maple-analytics:auth:${cookieValue(request, "maple_session") ?? ""}`).digest("hex");
}

function generationBinding(request: Request, key: string): string {
  return createHmac("sha256", key).update(`maple-analytics:generation:${cookieValue(request, ANALYTICS_GENERATION_COOKIE) ?? "initial"}`).digest("hex");
}

function carriesAuthCookie(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return path === "/api/maple" || path.startsWith("/api/maple/") || path === "/oauth/authorize" || path.startsWith("/oauth/authorize/");
}

export function readAnalyticsContext(request: Request): AnalyticsContext | undefined {
  const key = signingKey();
  if (!key || !analyticsConfig()) return;
  const token = cookieValue(request, ANALYTICS_COOKIE);
  if (!token || token.length > 2048) return;
  try {
    const [payload, sig, extra] = token.split(".");
    if (extra || !payload || !sig) return;
    const expected = createHmac("sha256", key).update(`maple-analytics:v1:${payload}`).digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
    const envelope = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!envelope || envelope.generationBinding !== generationBinding(request, key)) return;
    if (carriesAuthCookie(request) && envelope.authBinding !== authBinding(request, key)) return;
    return parseAnalyticsContext(envelope.context);
  } catch { return; }
}

export function ensureAnalyticsContext(request: Request, response: Response, initial?: AnalyticsAttribution): AnalyticsContext | undefined {
  const key = signingKey();
  if (!key || !analyticsConfig()) return;
  const now = Date.now();
  const previous = readAnalyticsContext(request);
  const attribution = ATTRIBUTION_SCHEMA.safeParse(initial).data ?? initialAttribution(request.url);
  const renewSession = !previous || now - previous.lastSeenAt >= SESSION_IDLE_MS || !validAnalyticsSession(previous.sessionId, now);
  const context: AnalyticsContext = previous ? {
    ...previous, lastSeenAt: now,
    sessionId: renewSession ? analyticsSessionId(now) : previous.sessionId,
    session: renewSession ? attribution : previous.session ?? previous.initial,
  } : {
    version: 1, visitorId: randomUUID(), sessionId: analyticsSessionId(now), issuedAt: now, lastSeenAt: now,
    initial: attribution, session: attribution,
  };
  const payload = Buffer.from(JSON.stringify({ context, authBinding: authBinding(request, key), generationBinding: generationBinding(request, key) })).toString("base64url");
  const sig = createHmac("sha256", key).update(`maple-analytics:v1:${payload}`).digest("base64url");
  const maxAge = Math.max(0, Math.floor((context.issuedAt + VISITOR_LIFETIME_MS - now) / 1000));
  const secure = new URL(request.url).protocol === "https:";
  if (response instanceof NextResponse) {
    response.cookies.set(ANALYTICS_COOKIE, `${payload}.${sig}`, { path: "/", httpOnly: true, sameSite: "lax", maxAge, secure });
  } else {
    response.headers.append("Set-Cookie", `${ANALYTICS_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
  }
  return context;
}

export function clearAnalyticsContext(response: Response): void {
  response.headers.append("Set-Cookie", `${ANALYTICS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  response.headers.append("Set-Cookie", `${ANALYTICS_GENERATION_COOKIE}=${randomUUID()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_LIFETIME_MS / 1000}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}

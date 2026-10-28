import { createHash } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { encryptSecret, openSecret } from "@/lib/secret-box";

// This module is server-side only. The digest identifies the one operator
// account without publishing its address in this public repository. It is not
// a password: callers must first verify the signed session and live membership.
const METRICS_ADMIN_SHA256 = "9b944f5169f2eb3c16ee3f695a525b52480dd36cca2f65f8bfd7007cf91ae337";
export const METRICS_ACCESS_COOKIE = "maple_metrics_access";
export const METRICS_ACCESS_TTL_MS = 12 * 60 * 60_000;
const KIND = "maple-metrics-access";

/** Only the designated account; family-owner roles and the shared admin login do not qualify. */
export function isMetricsAdmin(memberId: string): boolean {
  return createHash("sha256").update(memberId.trim().toLowerCase()).digest("hex") === METRICS_ADMIN_SHA256;
}

function hasOwnSessionKey(): boolean {
  const current = process.env.MAPLE_SESSION_SECRET?.trim();
  return !!current && current !== process.env.GOOGLE_CLIENT_SECRET?.trim() && current !== process.env.MAPLE_SESSION_SECRET_PREV?.trim();
}

function cookieHeader(value: string, maxAge: number): string {
  const parts = [`${METRICS_ACCESS_COOKIE}=${encodeURIComponent(value)}`, "Path=/api/maple", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Strict"];
  if (maxAge === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

/** Append raw headers so the primary session's cookies on two paths survive. */
export function clearMetricsAccess(response: NextResponse): void {
  response.headers.append("Set-Cookie", cookieHeader("", 0));
}

/**
 * Called only after a provider or email-code challenge verifies this exact
 * address. Session renewals, family switching and native-ticket exchanges do
 * not grant access; an alias linked to the operator is not sufficient either.
 */
export function grantMetricsAccess(response: NextResponse, verifiedEmail: string, canonicalMemberId: string): void {
  if (!hasOwnSessionKey() || !isMetricsAdmin(verifiedEmail) || !isMetricsAdmin(canonicalMemberId)) {
    clearMetricsAccess(response);
    return;
  }
  const issuedAt = Date.now();
  const proof = encryptSecret(JSON.stringify({ kind: KIND, member: METRICS_ADMIN_SHA256, issuedAt, expiresAt: issuedAt + METRICS_ACCESS_TTL_MS }));
  response.headers.append("Set-Cookie", cookieHeader(proof, METRICS_ACCESS_TTL_MS / 1000));
}

/** Call after sessionContext verifies the primary cookie and current membership. */
export function isMetricsAdminSession(request: NextRequest, memberId: string): boolean {
  if (!isMetricsAdmin(memberId) || !hasOwnSessionKey()) return false;
  const cookie = request.cookies.get(METRICS_ACCESS_COOKIE)?.value;
  if (!cookie) return false;
  try {
    const opened = openSecret(cookie);
    if (opened.prev) return false;
    const proof = JSON.parse(opened.text);
    const now = Date.now();
    return proof?.kind === KIND && proof.member === METRICS_ADMIN_SHA256
      && Number.isSafeInteger(proof.issuedAt) && proof.issuedAt <= now
      && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt === proof.issuedAt + METRICS_ACCESS_TTL_MS
      && proof.expiresAt > now;
  } catch {
    return false;
  }
}

import { NextRequest, NextResponse } from "next/server";
import {
  checkAdminPassword,
  ensureAdminMember,
  isPasswordConfigured,
  setSessionCookies,
} from "@/lib/maple/auth";
import { checkUploadRateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/**
 * Fallback sign-in with the site admin login, so the log works before
 * Google sign-in is set up. Signs in as the "admin" owner pseudo-member.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isPasswordConfigured()) {
      return NextResponse.json({ error: "Password sign-in isn't set up" }, { status: 400 });
    }
    // The per-IP hourly upload counter doubles as a coarse brake on scripted guessing.
    const { allowed } = await checkUploadRateLimit(request);
    if (!allowed) return NextResponse.json({ error: "Too many tries. Take a break and try later." }, { status: 429 });

    const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const user = typeof body.username === "string" ? body.username : "";
    const pass = typeof body.password === "string" ? body.password : "";
    if (!checkAdminPassword(user, pass)) {
      return NextResponse.json({ error: "That username and password didn't match" }, { status: 401 });
    }
    const member = await ensureAdminMember();
    if (member === "removed") {
      return NextResponse.json({ error: "The admin login was turned off for Maple's Log. Sign in with Google." }, { status: 403 });
    }
    if (!member) return NextResponse.json({ error: "Maple's log is offline right now" }, { status: 503 });

    const res = NextResponse.json({ ok: true, member });
    setSessionCookies(res, member.email);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "POST /api/maple/auth/password" });
    return NextResponse.json({ error: "Sign-in failed" }, { status: 500 });
  }
}

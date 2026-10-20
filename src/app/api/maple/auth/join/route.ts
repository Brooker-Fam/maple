import { NextRequest, NextResponse } from "next/server";
import { memberFor, setSessionCookies } from "@/lib/maple/auth";
import { redeemInvite } from "@/lib/maple/store";
import { checkUploadRateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/**
 * POST { token } — redeem a one-time invite link and sign in. The token rides
 * in the link's #fragment (never sent to servers or logs by the browser) and
 * the /maple/join page posts it here.
 */
export async function POST(request: NextRequest) {
  try {
    const { allowed } = await checkUploadRateLimit(request);
    if (!allowed) return NextResponse.json({ error: "Too many tries. Take a break and try later." }, { status: 429 });
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    const id = typeof body.token === "string" ? await redeemInvite(body.token.trim()) : null;
    if (!id) {
      return NextResponse.json(
        { error: "This invite link has already been used or has expired. Ask Matt or Brittany for a fresh one." },
        { status: 400 }
      );
    }
    const member = await memberFor(id);
    const res = NextResponse.json({ ok: true, member });
    setSessionCookies(res, id);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "POST /api/maple/auth/join" });
    return NextResponse.json({ error: "Couldn't join right now" }, { status: 500 });
  }
}

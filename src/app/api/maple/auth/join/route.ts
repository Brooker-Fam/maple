import { clearAnalyticsContext, readAnalyticsContext } from "@/lib/analytics/context";
import { identifyAnalyticsSoon, captureAppEventSoon } from "@/lib/analytics/server";
import { NextRequest, NextResponse } from "next/server";
import { memberFor, redeemInvite, setSessionCookies } from "@/lib/maple/auth";
import { checkUploadRateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";


/**
 * POST { token } — redeem a one-time invite link and sign in to the family it
 * was made in. The token rides
 * in the link's #fragment (never sent to servers or logs by the browser) and
 * the /maple/join page posts it here.
 */
export async function POST(request: NextRequest) {
  try {
    const { allowed } = await checkUploadRateLimit(request);
    if (!allowed) return NextResponse.json({ error: "Too many tries. Take a break and try later." }, { status: 429 });
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    const joined = typeof body.token === "string" ? await redeemInvite(body.token.trim()) : null;
    if (joined === "google") {
      return NextResponse.json({ error: "This invite is for a Google account. Join with Google, as the address it was sent to.", google: true }, { status: 400 });
    }
    if (!joined) return NextResponse.json({ error: "This invite link has already been used or has expired. Ask whoever sent it for a fresh one." }, { status: 400 });
    const member = await memberFor({ familyId: joined.familyId }, joined.id);
    const res = NextResponse.json({ ok: true, member });
    const actor = { familyId: joined.familyId, member: joined.id, role: member?.role };
    const analytics = readAnalyticsContext(request);
    captureAppEventSoon(actor, "invite_accepted", undefined, analytics);
    identifyAnalyticsSoon(actor, analytics);
    setSessionCookies(res, joined.id, joined.familyId);
    clearAnalyticsContext(res);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "POST /api/maple/auth/join" });
    return NextResponse.json({ error: "Couldn't join right now" }, { status: 500 });
  }
}

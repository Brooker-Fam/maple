import { NextRequest, NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/secret-box";
import { memberFor, setSessionCookies } from "@/lib/maple/auth";
import { NATIVE_VERIFIER_HEADER, nativeVerifierMatches, openNativeTicket } from "@/lib/maple/native-auth";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/**
 * GET ?ticket= with X-Maple-Verifier — the apps' web view trades the ticket
 * from maple://auth (src/lib/maple/native-auth.ts) for the usual session
 * cookies, then lands on the app. Anything wrong lands on /maple?auth=failed.
 */
export async function GET(request: NextRequest) {
  const base = getAppBaseUrl();
  const redirect = (path: string) => {
    const res = NextResponse.redirect(new URL(path, base));
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  };
  try {
    const ticket = openNativeTicket(new URL(request.url).searchParams.get("ticket"));
    if (!ticket || !nativeVerifierMatches(request.headers.get(NATIVE_VERIFIER_HEADER), ticket.challenge)) {
      return redirect("/maple?auth=failed");
    }
    const member = await memberFor(ticket.id);
    if (!member) return redirect("/maple?auth=failed");
    const res = redirect(ticket.back);
    setSessionCookies(res, member.email);
    return res;
  } catch (error) {
    await captureServerException(error, { route: "GET /api/maple/auth/native" });
    return redirect("/maple?auth=failed");
  }
}

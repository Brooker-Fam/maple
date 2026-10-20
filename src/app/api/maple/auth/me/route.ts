import { NextRequest, NextResponse } from "next/server";
import { isGoogleConfigured, isPasswordConfigured, sessionMember } from "@/lib/maple/auth";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

/** Who am I, and which sign-in buttons should the app offer? */
export async function GET(request: NextRequest) {
  const base = { google: isGoogleConfigured(), password: isPasswordConfigured() };
  try {
    const member = await sessionMember(request);
    return NextResponse.json(
      member ? { ...base, signedIn: true, member } : { ...base, signedIn: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await captureServerException(error, { route: "GET /api/maple/auth/me" });
    return NextResponse.json({ ...base, signedIn: false }, { headers: { "Cache-Control": "no-store" } });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { isGoogleConfigured, isPasswordConfigured, sessionContext } from "@/lib/maple/auth";
import { signupMode } from "@/lib/maple/family";
import { captureServerException } from "@/lib/posthog-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const base = { google: isGoogleConfigured(), password: isPasswordConfigured(), signup: signupMode() };
  try {
    const signedIn = await sessionContext(request);
    return NextResponse.json(
      signedIn ? { ...base, signedIn: true, member: signedIn.member } : { ...base, signedIn: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    await captureServerException(error, { route: "GET /api/maple/auth/me" });
    return NextResponse.json({ ...base, signedIn: false }, { headers: { "Cache-Control": "no-store" } });
  }
}

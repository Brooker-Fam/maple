import { NextRequest, NextResponse } from "next/server";
import { isGoogleConfigured, isPasswordConfigured, sessionContext } from "@/lib/maple/auth";
import { signupMode } from "@/lib/maple/family";
import { captureServerException } from "@/lib/posthog-server";
import { isAppleConfigured } from "@/lib/maple/apple";
import { isEmailConfigured } from "@/lib/maple/email-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const base = { google: isGoogleConfigured(), apple: isAppleConfigured(), email: isEmailConfigured(), password: isPasswordConfigured(), signup: signupMode() };
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

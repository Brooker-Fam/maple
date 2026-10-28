import { NextRequest, NextResponse } from "next/server";
import { sessionContext } from "@/lib/maple/auth";
import { isAppleConfigured } from "@/lib/maple/apple";
import { isEmailConfigured } from "@/lib/maple/email-auth";
import { linkedIdentities } from "@/lib/maple/auth-identities";
import { normalizeEmail } from "@/lib/waitlist";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(req: NextRequest) {
  try {
    const who = await sessionContext(req);
    if (!who || !normalizeEmail(who.member.email)) return NextResponse.json({ error: "Sign in to an account first." }, { status: 401, headers });
    return NextResponse.json({ apple: isAppleConfigured(), email: isEmailConfigured(), methods: await linkedIdentities(who.member.email) }, { headers });
  } catch {
    return NextResponse.json({ error: "Sign-in methods are unavailable for a moment." }, { status: 503, headers });
  }
}

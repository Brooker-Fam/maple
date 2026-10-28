import { NextRequest } from "next/server";
import { getAppBaseUrl } from "@/lib/secret-box";
import { safeReturnPath, signInSite } from "@/lib/maple/auth";
import { appleFailure, beginApple } from "@/lib/maple/apple-flow";
import { allowAttempt } from "@/lib/maple/family/limits";
import { parseNativeChallenge, parseNativeFlag } from "@/lib/maple/native-auth";
import { signInContext, signInErrorCode, type SignInContext } from "@/lib/maple/signin-flow";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const native = parseNativeFlag(params.get("native"));
  const challenge = parseNativeChallenge(params.get("challenge"));
  const ctx: SignInContext = { mode: "signin", site: native ? getAppBaseUrl() : signInSite(params.get("site")), back: safeReturnPath(params.get("return")), ...(native ? { native, challenge: challenge ?? undefined } : {}) };
  if (params.get("mode") === "link" || (native && !challenge)) return appleFailure(ctx, "bad_state");
  if (!(await allowAttempt(req))) return appleFailure(ctx, "busy");
  return beginApple(req, ctx);
}

export async function POST(req: NextRequest) {
  try {
    if (!req.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return appleFailure(null, "bad_state");
    const text = await req.text();
    if (text.length > 4000) return appleFailure(null, "bad_state");
    const data = Object.fromEntries(new URLSearchParams(text));
    if (data.mode !== "link") return appleFailure(null, "bad_state");
    const ctx = await signInContext(req, data);
    if (!(await allowAttempt(req))) return appleFailure(ctx, "busy");
    return beginApple(req, ctx);
  } catch (error) {
    return appleFailure({ mode: "link", site: getAppBaseUrl(), back: "/maple" }, signInErrorCode(error));
  }
}

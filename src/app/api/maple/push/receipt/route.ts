import { NextRequest } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { errCode, recordReceipt } from "@/lib/maple/push";

export const dynamic = "force-dynamic";

/**
 * POST { r, k } from Maple's service worker, right after it shows a
 * notification: r is this phone's receipt token (128 random bits, only ever
 * inside the encrypted push), k the notice's key. No session: the token is
 * the proof, and all it does is set "last reached this phone". Always 204.
 */
export async function POST(request: NextRequest): Promise<Response> {
  try {
    const text = (await request.text()).slice(0, 2000);
    const body = JSON.parse(text || "{}") as { r?: unknown; k?: unknown };
    await recordReceipt(body.r, body.k);
  } catch (err) {
    if (!(err instanceof SyntaxError)) void captureServerException(new Error(errCode(err)), { route: "/api/maple/push/receipt" });
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

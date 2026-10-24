import { NextResponse } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { errCode, runPushTick } from "@/lib/maple/push";

/**
 * Send whatever pill reminders are due (src/lib/maple/push.ts). Called every
 * few minutes by the scheduled GitHub Action (.github/workflows/maple-reminders.yml)
 * or any cron. Safe to call by anyone: it only sends reminders that are due,
 * each once, at most one run per 20 seconds, and answers only a count.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(): Promise<Response> {
  try {
    return NextResponse.json(await runPushTick(), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    void captureServerException(new Error(errCode(err)), { route: "/api/maple/push/tick" });
    return NextResponse.json({ error: "tick failed" }, { status: 500 });
  }
}

export { handle as GET, handle as POST };

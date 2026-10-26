import { query } from "@/lib/db";
import { captureServerException } from "@/lib/posthog-server";
import { checkWaitlistRateLimit } from "@/lib/rate-limit";
import { addToWaitlist, handleWaitlist } from "@/lib/waitlist";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleWaitlist(request, {
    limit: checkWaitlistRateLimit,
    save: (entry) => addToWaitlist(entry, query),
    report: (error) => captureServerException(error, { route: "POST /api/waitlist" }),
  });
}

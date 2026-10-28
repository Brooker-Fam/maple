import { json } from "@/lib/maple/api";
import { readAdminBody, withMetricsAdmin } from "@/lib/maple/admin/api";
import { previewWaitlistEmail, WaitlistEmailError } from "@/lib/maple/admin/waitlist-email";

export const dynamic = "force-dynamic";

export const POST = withMetricsAdmin("POST /api/maple/admin/waitlist/preview", async (request) => {
  const body = await readAdminBody(request);
  try { return json(await previewWaitlistEmail(body.ref)); }
  catch (error) {
    if (error instanceof WaitlistEmailError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

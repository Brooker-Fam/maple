import { json } from "@/lib/maple/api";
import { readAdminBody, withMetricsAdmin } from "@/lib/maple/admin/api";
import { sendWaitlistEmail, WaitlistEmailError } from "@/lib/maple/admin/waitlist-email";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = withMetricsAdmin("POST /api/maple/admin/waitlist/send", async (request) => {
  const body = await readAdminBody(request);
  try { return json(await sendWaitlistEmail(body.sendToken)); }
  catch (error) {
    if (error instanceof WaitlistEmailError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});

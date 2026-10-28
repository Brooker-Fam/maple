import { BadRequest, json } from "@/lib/maple/api";
import { readAdminBody, withMetricsAdmin } from "@/lib/maple/admin/api";
import { revealAdminEmail } from "@/lib/maple/admin/details";
import { openAdminRef } from "@/lib/maple/admin/refs";

export const dynamic = "force-dynamic";

export const POST = withMetricsAdmin("POST /api/maple/admin/reveal", async (request) => {
  const body = await readAdminBody(request);
  const ref = openAdminRef(body.ref);
  if (!ref) throw new BadRequest("This contact link expired. Refresh the list and try again.");
  return json({ email: await revealAdminEmail(ref) });
}, { write: true });

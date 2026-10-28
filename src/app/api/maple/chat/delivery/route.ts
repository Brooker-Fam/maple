import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { parseDelivery } from "@/lib/maple/chat/delivery";
import { cancelDelivery } from "@/lib/maple/chat/delivery-store";

/** A cancellation receipt closes the gap between a missing history read and a delayed original POST. */
export const POST = withMember("POST /api/maple/chat/delivery", async (request, member, fam) => {
  const body = await readJson<{ action?: unknown; requestId?: unknown; submittedAt?: unknown }>(request);
  if (body.action !== "cancel") throw new BadRequest("Choose a delivery action.");
  let delivery;
  try { delivery = parseDelivery(body); } catch (error) { throw new BadRequest((error as Error).message); }
  if (!delivery) throw new BadRequest("Choose a message to cancel.");
  // Even an expired draft can be discarded. A tombstone cannot perform a log write.
  const status = await cancelDelivery(fam, member.email, member.role === "viewer", delivery);
  if (!status) return json({ error: "Too many messages were cancelled today. Check this message again later." }, 429);
  return json({ delivery: status });
});

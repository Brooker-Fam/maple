import { BadRequest, idParam, json, withMember } from "@/lib/maple/api";
import { chatEntryStatus } from "@/lib/maple/chat/entry-status";

export const dynamic = "force-dynamic";

/** Read the current state of a card's entry, including a soft deletion. */
export const GET = withMember("GET /api/maple/chat/entry", async (request, member, fam) => {
  const target = new URL(request.url).searchParams.get("target");
  if (target !== "baby" && target !== "care") throw new BadRequest("Choose a baby or care entry.");
  return json(await chatEntryStatus(fam, member, target, idParam(request)));
});

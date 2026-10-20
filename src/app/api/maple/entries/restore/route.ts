import { idParam, json, withMember } from "@/lib/maple/api";
import { restoreEntryDetailed, toClientEntry } from "@/lib/maple/store";

export const dynamic = "force-dynamic";

/** POST /api/maple/entries/restore?id= — undo a delete. */
export const POST = withMember("POST /api/maple/entries/restore", async (request, me) => {
  const { entry, stoppedAt } = await restoreEntryDetailed(idParam(request), me.email);
  // stopped_at: a running timer came back stopped (another one started meanwhile).
  return json({ entry: toClientEntry(entry), stopped_at: stoppedAt });
}, { write: true });

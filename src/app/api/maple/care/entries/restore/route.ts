import { idParam, json, withCare } from "@/lib/maple/api";
import { restoreCareEntry } from "@/lib/maple/care-store";

export const dynamic = "force-dynamic";

/** POST ?id= — undo a delete of a dose, temperature or question. */
export const POST = withCare("POST /api/maple/care/entries/restore", async (request, _me, s) => {
  return json({ entry: await restoreCareEntry(s, idParam(request)) });
}, { write: true });

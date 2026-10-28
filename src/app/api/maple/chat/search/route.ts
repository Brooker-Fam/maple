import { BadRequest, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import { chatConsent } from "@/lib/maple/consent";
import { getBaby } from "@/lib/maple/store";
import { ChatSearchError, searchEntries } from "@/lib/maple/chat/search-tools";
import { searchInputSchema } from "@/lib/maple/chat/search";

/** Read-only pagination, with the current membership and current baby resolved on every request. */
export const POST = withMember("POST /api/maple/chat/search", async (request, member, fam) => {
  if (!(await chatConsent(fam, member)).terms) throw new Forbidden("Accept the chat terms before opening these results.");
  const body = searchInputSchema.safeParse(await readJson(request));
  if (!body.success || !body.data.cursor || Object.keys(body.data).length !== 1) throw new BadRequest("A search cursor is required.");
  const baby = await getBaby(fam);
  try {
    return json(await searchEntries({ fam, baby, tz: baby.timezone, now: new Date() }, body.data));
  } catch (error) {
    if (error instanceof ChatSearchError) throw new BadRequest(error.message);
    throw error;
  }
});

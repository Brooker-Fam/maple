import { idParam, json, readJson, withMember } from "@/lib/maple/api";
import { createPersonalToken, listPersonalTokens, revokePersonalToken } from "@/lib/maple/store";

export const dynamic = "force-dynamic";

const MAX_TOKENS = 10;

/**
 * Personal tokens for hands-free logging from iOS Shortcuts ("Hey Siri,
 * Maple pee") via POST /api/maple/quick. Each member manages their own, in
 * the family they're signed in to (a token opens only that family); the
 * token is shown once.
 */

export const GET = withMember("GET /api/maple/tokens", async (_request, me, fam) =>
  json({ tokens: await listPersonalTokens(fam, me.email) })
);

export const POST = withMember(
  "POST /api/maple/tokens",
  async (request, me, fam) => {
    const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
    if ((await listPersonalTokens(fam, me.email)).length >= MAX_TOKENS) {
      return json({ error: "That's plenty of tokens. Revoke an old one first." }, 400);
    }
    const label = String(body.label ?? "").trim().slice(0, 40) || "iPhone Shortcuts";
    const { token, record } = await createPersonalToken(fam, me.email, label);
    return json({ token, record }, 201);
  },
  { write: true }
);

export const DELETE = withMember("DELETE /api/maple/tokens", async (request, me, fam) => {
  await revokePersonalToken(fam, me.email, idParam(request));
  return json({ tokens: await listPersonalTokens(fam, me.email) });
});

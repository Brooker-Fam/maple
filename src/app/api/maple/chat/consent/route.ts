import type { NextRequest } from "next/server";
import { BadRequest, Forbidden, json, readJson, withMember } from "@/lib/maple/api";
import { acceptConsent, chatConsent, withdrawConsent } from "@/lib/maple/consent";
import type { FamilyCtx } from "@/lib/maple/family";
import type { Member } from "@/lib/maple/types";

/**
 * The chat's consents for the signed-in member in their session's family (ChatConsent). POST
 * `{ terms: true }` accepts the chat's terms; `{ care: true | false }` turns
 * the chat's view of her page (chat_care) on or off, and only she
 * can send it. Both can come in one POST (the terms card's Accept).
 */

export const GET = withMember("GET /api/maple/chat/consent", async (_request, member, ctx) => json(await chatConsent(ctx, member)), { setup: true });

export const POST = withMember("POST /api/maple/chat/consent", async (request: NextRequest, member: Member, ctx: FamilyCtx) => {
  const body = await readJson<{ terms?: unknown; care?: unknown }>(request);
  const terms = body.terms === true;
  const care = typeof body.care === "boolean" ? body.care : null;
  if (!terms && care === null) throw new BadRequest("Nothing to save");
  if (care !== null && !(await chatConsent(ctx, member)).self) throw new Forbidden("Only she can change this, from her own account.");
  if (terms) await acceptConsent(ctx, member.email, "chat");
  if (care === true) await acceptConsent(ctx, member.email, "chat_care");
  if (care === false) await withdrawConsent(ctx, member.email, "chat_care");
  return json(await chatConsent(ctx, member));
}, { setup: true });

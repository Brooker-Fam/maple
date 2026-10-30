import type { NextRequest } from "next/server";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import type { FamilyCtx } from "@/lib/maple/family";
import { feedbackAsk, FeedbackRefused, parseFeedback, sendFeedback, snoozeFeedbackAsk } from "@/lib/maple/feedback/store";
import type { Member } from "@/lib/maple/types";

/**
 * Feedback for the person who makes Maple, from the signed-in member in
 * their session's family (feedback/store.ts). GET: whether Today asks its
 * question now (FeedbackAsk). POST `{ via: "app" | "prompt", message?,
 * topic?, rating? }` saves it, then emails it; `{ later: true }` is the
 * question's "Not now". Anyone signed in can send it, guests included.
 */

export const dynamic = "force-dynamic";

export const GET = withMember("GET /api/maple/feedback", async (_request, member, ctx) => json(await feedbackAsk(ctx, member)), { photos: true });

export const POST = withMember("POST /api/maple/feedback", async (request: NextRequest, member: Member, ctx: FamilyCtx) => {
  const body = await readJson<{ via?: unknown; message?: unknown; topic?: unknown; rating?: unknown; later?: unknown }>(request);
  if (body.later === true) {
    await snoozeFeedbackAsk(ctx, member.email);
    return json({ ok: true });
  }
  if (body.via !== "app" && body.via !== "prompt") throw new BadRequest("via is app or prompt");
  try {
    const { emailed } = await sendFeedback(ctx, member, parseFeedback(body, body.via));
    return json({ ok: true, emailed });
  } catch (error) {
    if (error instanceof FeedbackRefused) return json({ error: error.message, code: error.code }, error.code === "limit" ? 429 : 400);
    throw error;
  }
}, { photos: true });

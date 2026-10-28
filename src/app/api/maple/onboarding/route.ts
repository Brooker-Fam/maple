import type { NextRequest } from "next/server";
import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import type { FamilyCtx } from "@/lib/maple/family";
import { SETUP_DONE } from "@/lib/maple/onboarding/chat";
import { AnswerError, isStep } from "@/lib/maple/onboarding/steps";
import { answerStep, finishOnboarding, OnboardingClosed, readView, skipStep, trackOnboarding } from "@/lib/maple/onboarding/store";
import type { Member } from "@/lib/maple/types";
import { publicOrigin } from "@/lib/mcp/auth";

export const dynamic = "force-dynamic";

/**
 * A new family's setup (docs/multi-family-plan.md 4.2). GET says whether
 * /maple should open onboarding for this session's family, and where it
 * stands; a family that finished (family 1 among them) answers
 * `{ needed: false }`. POST, an owner of a family
 * still setting up only: `{ step, value }` saves one answer to its rows,
 * `{ skip: step }` skips one that doesn't block logging, `{ finish: true }`
 * is "Start logging". The chat's proposals are saved only through here, by a tap.
 */

export const GET = withMember("GET /api/maple/onboarding", async (_request, _member, ctx) => {
  if (ctx.status !== "onboarding") {
    trackOnboarding(ctx);
    return json({ needed: false });
  }
  return json({ needed: true, view: await readView(ctx) });
}, { setup: true });

export const POST = withMember("POST /api/maple/onboarding", async (request: NextRequest, member: Member, ctx: FamilyCtx) => {
  const body = await readJson<{ step?: unknown; value?: unknown; skip?: unknown; finish?: unknown }>(request);
  try {
    if (body.finish === true) return json({ view: await finishOnboarding(ctx, member) });
    if (body.skip !== undefined) {
      if (!isStep(body.skip)) throw new BadRequest("That isn't one of the questions.");
      return json({ view: await skipStep(ctx, member, body.skip) });
    }
    if (!isStep(body.step)) throw new BadRequest("That isn't one of the questions.");
    const { view, invites } = await answerStep(ctx, member, body.step, body.value);
    const origin = invites?.length ? publicOrigin(request) : "";
    // The token rides in the #fragment, which browsers never send to servers or logs.
    return json({ view, ...(invites ? { invites: invites.map((i) => ({ name: i.name, role: i.role, url: `${origin}/maple/join#${i.token}` })) } : {}) });
  } catch (e) {
    if (e instanceof AnswerError) return json({ error: e.message }, 400);
    if (e instanceof OnboardingClosed) return json({ error: SETUP_DONE, code: "done" }, 409);
    throw e;
  }
}, { setup: true });

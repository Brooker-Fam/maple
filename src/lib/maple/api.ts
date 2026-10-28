import { NextRequest, NextResponse } from "next/server";
import { captureServerException, scrubError } from "@/lib/posthog-server";
import { listMembers, sessionContext } from "./auth";
import { CareConflict, CareForbidden, careSession, viewerFor, type CareSession } from "./care-store";
import { FeedEditError, feedEditCopy } from "./feed";
import { FAMILY_ONE, parseFamilyId, type FamilyCtx } from "./family";
import { Conflict, NotFound, StoreUnavailable, getBaby, toClientEntry } from "./store";
import { DEFAULT_TZ } from "./time";
import { OnlyHers } from "./validate";
import { voiceFor } from "./voice";
import { AnswerError, parseName } from "./onboarding/steps";
import { logSyncDiagnostic, syncRequestFor } from "./diagnostics";
import type { Member } from "./types";

/**
 * Shared plumbing for /api/maple/* routes: resolve the signed-in member and
 * the family they're acting in, map store errors to status codes, and keep
 * every response uncached.
 */

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class BadRequest extends Error {}
export class Forbidden extends Error {}

type Handler = (request: NextRequest, member: Member, ctx: FamilyCtx) => Promise<Response>;

/**
 * A write the phone queued offline names the family it was made in
 * (X-Maple-Family). Sent under a session for another family (a switch, a
 * join, another person signing in on that phone), it's turned away with 409
 * `family_mismatch`, and the phone keeps it until it's back in that family.
 */
export function familyMismatch(request: NextRequest, ctx: Pick<FamilyCtx, "familyId">): Response | null {
  const raw = request.headers.get("x-maple-family");
  if (raw == null || parseFamilyId(raw) === ctx.familyId) return null;
  return json({ error: "That was saved in another family's log, so it waits on this phone until you're back there.", code: "family_mismatch" }, 409);
}

/**
 * Wrap a route handler so it only runs for a signed-in member, with the
 * family their session names (`write: true` also turns away read-only
 * viewers; a family still setting up gets STILL_SETTING_UP unless `setup`). Every store call the handler makes takes that `ctx`. Errors
 * thrown inside become 400 (BadRequest / validation), 403, 404, 409 (lost a
 * race with the other parent; body carries the current entry), 503 (no
 * database), or 500 (reported to PostHog).
 */
export function withMember(route: string, handler: Handler, opts: { write?: boolean; setup?: boolean } = {}) {
  return async function (request: NextRequest): Promise<Response> {
    let fam: FamilyCtx | undefined;
    const requestId = syncRequestFor(route, request);
    const started = performance.now();
    const finish = async (response: Response, reported = false) => {
      if (requestId) {
        logSyncDiagnostic({ event: "api_response", requestId, status: response.status, elapsedMs: performance.now() - started });
        if (response.status >= 400 && !reported) {
          await captureServerException(new Error("sync_request_failed"), { status: response.status, requestId }).catch(() => {});
        }
      }
      return response;
    };
    try {
      const signedIn = await sessionContext(request);
      if (!signedIn) return finish(json({ error: "Not signed in" }, 401));
      const { member, ctx } = signedIn;
      fam = ctx;
      if (ctx.status === "onboarding" && !opts.setup) return finish(json(STILL_SETTING_UP, 403));
      const mismatch = familyMismatch(request, ctx);
      if (mismatch) return finish(mismatch);
      if (opts.write && member.role === "viewer") return finish(json({ error: viewOnlyCopy(ctx) }, 403));
      return finish(await handler(request, member, ctx));
    } catch (error) {
      const response = await errorResponse(route, error, fam);
      return finish(response, response.status === 500);
    }
  };
}

/**
 * A family still in onboarding reaches only its setup (`setup: true`: the
 * onboarding routes, the chat's terms, notifications): no log, uploads,
 * chat, people, tokens or exports until it's set up.
 */
export const STILL_SETTING_UP = { error: "Finish setting up this log first.", code: "onboarding" } as const;

/**
 * A name typed for this family (the baby's, a nickname, a member's), or null
 * when blank. Family 1 keeps the rule it has always had (trimmed, cut to
 * `max`). Any other family's goes by onboarding's rule, so a name reaching
 * Claude's instructions or the switcher can only be a name.
 */
export function familyName(ctx: Pick<FamilyCtx, "familyId">, raw: unknown, max: number, label: string): string | null {
  if (ctx.familyId === FAMILY_ONE) {
    const v = String(raw ?? "").trim();
    return v ? v.slice(0, max) : null;
  }
  try {
    return parseName(raw ?? null, max, label);
  } catch (error) {
    if (error instanceof AnswerError) throw new BadRequest(error.message);
    throw error;
  }
}

/** Family 1's copy names its owners; another family must never read the Brookers' names. */
export function viewOnlyCopy(ctx: Pick<FamilyCtx, "familyId">): string {
  return ctx.familyId === FAMILY_ONE
    ? "You have view-only access. Ask Matt or Brittany if you'd like to help log."
    : "You have view-only access. Ask an owner of this log if you'd like to help log.";
}

/** `fam`: the caller's family, so a feed-time error reads in its clock and words. */
export async function errorResponse(route: string, error: unknown, fam?: FamilyCtx): Promise<Response> {
  if (error instanceof StoreUnavailable) return json({ error: "Maple's log is offline right now" }, 503);
  if (error instanceof NotFound) return json({ error: error.message || "Not found" }, 404);
  if (error instanceof Conflict) {
    return json({ error: error.message, reason: error.reason, entry: toClientEntry(error.entry) }, 409);
  }
  if (error instanceof Forbidden) return json({ error: error.message || "Not allowed" }, 403);
  if (error instanceof BadRequest) return json({ error: error.message }, 400);
  // A time fix that doesn't fit the feed: the sheet shows the copy, code says which bound.
  if (error instanceof FeedEditError) {
    const baby = fam ? await getBaby(fam).catch(() => null) : null;
    return json({ error: feedEditCopy(error, "ui", fam?.tz ?? DEFAULT_TZ, voiceFor(fam?.familyId ?? 0, baby)), code: error.code }, 400);
  }
  // Validation errors from cleanData / store checks are plain Errors with a
  // readable message; anything else (pg, network) is a real 500.
  if (error instanceof Error && !("code" in error) && isUserFacing(error)) {
    return json({ error: error.message }, 400);
  }
  console.error(`${route} error:`, scrubError(error));
  await captureServerException(error, { route });
  return json({ error: "Something went wrong" }, 500);
}

function isUserFacing(error: Error): boolean {
  return error.constructor === Error && error.message.length < 200 && !/database|neon|fetch|ECONN|timeout/i.test(error.message);
}

/** Parse a JSON body or throw BadRequest. */
export async function readJson<T = Record<string, unknown>>(request: NextRequest): Promise<T> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as T;
  } catch {
    throw new BadRequest("Expected a JSON object");
  }
}

/** A positive integer query param or throw BadRequest. */
export function idParam(request: NextRequest, name = "id"): number {
  const raw = new URL(request.url).searchParams.get(name);
  const n = Number(raw);
  if (!raw || !Number.isSafeInteger(n) || n <= 0) throw new BadRequest(`${name} is required`);
  return n;
}

// ── For mom (/api/maple/care/*) ───────────────────────────────────────

/** What a care route gets: the session member, plus her area as this reader may see it. */
export type CareHandler = (request: NextRequest, member: Member, s: CareSession, ctx: FamilyCtx) => Promise<Response>;

/**
 * Wrap a care route: resolves the viewer (the admin login reads as its
 * admin_as member, or as nobody), the person and the viewer's access, read
 * fresh on every request. No area, or nothing the viewer can read, answers
 * 404 so the app never confirms there's anything there; `write` and
 * `manage` she can read but not change answer 403; `mood` (her session
 * only) answers 404 to everyone else.
 *
 * Errors are scrubbed: Postgres puts row data in its messages ("Failing row
 * contains (…)"), so an unexpected error is reported as `new Error(code)`
 * with `{ route }` only, and never forwarded.
 */
export function withCare(route: string, handler: CareHandler, opts: { write?: boolean; manage?: boolean; mood?: boolean } = {}) {
  return async function (request: NextRequest): Promise<Response> {
    try {
      const signedIn = await sessionContext(request);
      if (!signedIn) return json({ error: "Not signed in" }, 401);
      const { member, ctx } = signedIn;
      if (ctx.status === "onboarding") return json(STILL_SETTING_UP, 403);
      const mismatch = familyMismatch(request, ctx);
      if (mismatch) return mismatch;
      const s = await sessionCare(member, ctx);
      if (!s.person || !s.access.read || (opts.mood && !s.access.mood)) return json({ error: "Not found" }, 404);
      if (opts.write && !s.access.write) return json({ error: `You can't change ${s.name}'s medicines from this account.` }, 403);
      if (opts.manage && !s.access.manage) return json({ error: `Only ${s.name} can change that.` }, 403);
      return await handler(request, member, s, ctx);
    } catch (error) {
      return careErrorResponse(route, error);
    }
  };
}

/** The care session for a member signed in to the app, in their session's family. */
export async function sessionCare(member: Member, ctx: Pick<FamilyCtx, "familyId">): Promise<CareSession> {
  const [baby, members] = await Promise.all([getBaby(ctx), listMembers(ctx)]);
  return careSession(viewerFor(member, baby, members), { familyId: ctx.familyId, members, baby });
}

export async function careErrorResponse(route: string, error: unknown): Promise<Response> {
  if (error instanceof StoreUnavailable) return json({ error: "Maple's log is offline right now" }, 503);
  if (error instanceof NotFound) return json({ error: error.message || "Not found" }, 404);
  if (error instanceof CareConflict) {
    if (error.reason === "exists") return json({ error: error.message, reason: "exists" }, 409);
    return json({ error: error.message, reason: error.reason, ...error.current }, 409);
  }
  if (error instanceof CareForbidden || error instanceof OnlyHers || error instanceof Forbidden) return json({ error: error.message || "Not allowed" }, 403);
  if (error instanceof BadRequest) return json({ error: error.message }, 400);
  if (error instanceof Error && !("code" in error) && isUserFacing(error) && error.message !== "id_exhausted") {
    return json({ error: error.message }, 400);
  }
  const code = (error as { code?: unknown } | null)?.code;
  const scrubbed = new Error(typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : error instanceof Error && error.message === "id_exhausted" ? "id_exhausted" : "care_error");
  console.error(`${route} error: ${scrubbed.message}`);
  await captureServerException(scrubbed, { route });
  return json({ error: "Something went wrong" }, 500);
}

import { NextRequest, NextResponse } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { listMembers, sessionMember } from "./auth";
import { CareConflict, CareForbidden, careSession, viewerFor, type CareSession } from "./care-store";
import { FeedEditError, feedEditCopy } from "./feed";
import { Conflict, NotFound, StoreUnavailable, getBaby, toClientEntry } from "./store";
import { OnlyHers } from "./validate";
import type { Member } from "./types";

/**
 * Shared plumbing for /api/maple/* routes: resolve the signed-in member,
 * map store errors to status codes, and keep every response uncached.
 */

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class BadRequest extends Error {}
export class Forbidden extends Error {}

type Handler = (request: NextRequest, member: Member) => Promise<Response>;

/**
 * Wrap a route handler so it only runs for a signed-in member (`write: true`
 * also turns away read-only viewers). Errors thrown inside become 400
 * (BadRequest / validation), 403, 404, 409 (lost a race with the other
 * parent; body carries the current entry), 503 (no database), or 500
 * (reported to PostHog).
 */
export function withMember(route: string, handler: Handler, opts: { write?: boolean } = {}) {
  return async function (request: NextRequest): Promise<Response> {
    try {
      const member = await sessionMember(request);
      if (!member) return json({ error: "Not signed in" }, 401);
      if (opts.write && member.role === "viewer") {
        return json({ error: "You have view-only access. Ask Matt or Brittany if you'd like to help log." }, 403);
      }
      return await handler(request, member);
    } catch (error) {
      return errorResponse(route, error);
    }
  };
}

export async function errorResponse(route: string, error: unknown): Promise<Response> {
  if (error instanceof StoreUnavailable) return json({ error: "Maple's log is offline right now" }, 503);
  if (error instanceof NotFound) return json({ error: error.message || "Not found" }, 404);
  if (error instanceof Conflict) {
    return json({ error: error.message, reason: error.reason, entry: toClientEntry(error.entry) }, 409);
  }
  if (error instanceof Forbidden) return json({ error: error.message || "Not allowed" }, 403);
  if (error instanceof BadRequest) return json({ error: error.message }, 400);
  // A time fix that doesn't fit the feed: the sheet shows the copy, code says which bound.
  if (error instanceof FeedEditError) return json({ error: feedEditCopy(error, "ui"), code: error.code }, 400);
  // Validation errors from cleanData / store checks are plain Errors with a
  // readable message; anything else (pg, network) is a real 500.
  if (error instanceof Error && !("code" in error) && isUserFacing(error)) {
    return json({ error: error.message }, 400);
  }
  console.error(`${route} error:`, error);
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
export type CareHandler = (request: NextRequest, member: Member, s: CareSession) => Promise<Response>;

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
      const member = await sessionMember(request);
      if (!member) return json({ error: "Not signed in" }, 401);
      const s = await sessionCare(member);
      if (!s.person || !s.access.read || (opts.mood && !s.access.mood)) return json({ error: "Not found" }, 404);
      if (opts.write && !s.access.write) return json({ error: `You can't change ${s.name}'s medicines from this account.` }, 403);
      if (opts.manage && !s.access.manage) return json({ error: `Only ${s.name} can change that.` }, 403);
      return await handler(request, member, s);
    } catch (error) {
      return careErrorResponse(route, error);
    }
  };
}

/** The care session for a member signed in to the app. */
export async function sessionCare(member: Member): Promise<CareSession> {
  const [baby, members] = await Promise.all([getBaby(), listMembers()]);
  return careSession(viewerFor(member, baby, members), { members, baby });
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

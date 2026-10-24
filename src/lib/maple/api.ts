import { NextRequest, NextResponse } from "next/server";
import { captureServerException } from "@/lib/posthog-server";
import { sessionMember } from "./auth";
import { FeedEditError, feedEditCopy } from "./feed";
import { Conflict, NotFound, StoreUnavailable, toClientEntry } from "./store";
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

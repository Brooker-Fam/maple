import type { NextRequest } from "next/server";
import { BadRequest, json, withMember } from "../api";
import { sameOriginRequest } from "../auth-request";
import type { FamilyCtx } from "../family";
import type { Member } from "../types";
import { isMetricsAdmin, isMetricsAdminSession } from "./auth";

type Handler = (request: NextRequest, member: Member, ctx: FamilyCtx) => Promise<Response>;

/** Every operator route shares the same identity, proof and origin boundaries. */
export function withMetricsAdmin(route: string, handler: Handler, opts: { write?: boolean } = {}) {
  return withMember(route, async (request, member, ctx) => {
    if (!isMetricsAdmin(member.email)) return json({ error: "Not allowed" }, 403);
    if (!isMetricsAdminSession(request, member.email)) return json({ error: "Sign in again to view site metrics.", code: "metrics_reauth" }, 403);
    if ((opts.write || !["GET", "HEAD", "OPTIONS"].includes(request.method)) && !sameOriginRequest(request)) {
      return json({ error: "Start from Maple's own admin page." }, 403);
    }
    return handler(request, member, ctx);
  }, { setup: true });
}

/** Bounded JSON for a reference or explicit operator action; never parse arbitrary uploads. */
export async function readAdminBody(request: NextRequest): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new BadRequest("Expected a JSON object");
  const text = await request.text();
  if (text.length > 8192) throw new BadRequest("Request is too large");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new BadRequest("Expected a JSON object");
  }
}

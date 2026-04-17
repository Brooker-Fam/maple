import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

/**
 * RFC 7591 — Dynamic Client Registration.
 *
 * We don't actually track clients (there's only one admin), but MCP spec
 * requires this endpoint for ChatGPT-style clients to register themselves.
 * We accept any registration and hand back a fresh client_id. Clients are
 * public (no secret) — they authenticate their code redemption via PKCE.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const clientId = `mcp-${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);

  const redirectUris =
    Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
      ? (body.redirect_uris as string[])
      : [];

  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: now,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: (body.client_name as string) ?? "MCP Client",
      scope: "calendar",
    },
    {
      status: 201,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    },
  });
}

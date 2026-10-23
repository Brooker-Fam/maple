import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/mcp/auth";

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 * Advertises our /oauth endpoints so MCP clients (ChatGPT especially) can
 * complete the authorization-code + PKCE flow without human configuration.
 */
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  return NextResponse.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none"],
      // No offline_access: Claude only asks for it when it's advertised.
      // Refresh tokens go to Claude, ChatGPT and local apps (admin ones lapse after 90 idle days).
      scopes_supported: ["calendar", "rsvp", "maple"],
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization",
    },
  });
}

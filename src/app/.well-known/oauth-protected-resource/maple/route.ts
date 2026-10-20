import { NextResponse } from "next/server";
import { mapleResourceMetadata, publicOrigin } from "@/lib/mcp/auth";

/**
 * RFC 9728 — Protected Resource Metadata for Maple's Log (/api/maple/mcp).
 * Same JSON at /.well-known/oauth-protected-resource/api/maple/mcp (the
 * path-insertion URL Claude probes and the MCP 401 points at) and at the
 * short alias /.well-known/oauth-protected-resource/maple.
 */
export async function GET(req: Request) {
  return NextResponse.json(mapleResourceMetadata(publicOrigin(req)), {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=300",
    },
  });
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

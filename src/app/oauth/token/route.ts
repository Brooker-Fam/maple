import { NextRequest, NextResponse } from "next/server";
import {
  mintAccessToken,
  verifyAuthCode,
  verifyPkce,
  ACCESS_TOKEN_TTL,
} from "@/lib/mcp/auth";

/**
 * OAuth 2.1 token endpoint. authorization_code + PKCE only.
 *
 * No client secret (public client). The code itself is HMAC-signed and
 * carries the expected redirect_uri + code_challenge, so we verify both
 * at redemption time against what the client re-sends.
 */

function err(code: string, description: string, status = 400) {
  return NextResponse.json(
    { error: code, error_description: description },
    {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  let params: URLSearchParams;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    params = new URLSearchParams(await request.text());
  } else if (contentType.includes("application/json")) {
    const body = (await request.json()) as Record<string, string>;
    params = new URLSearchParams(body);
  } else {
    // Best-effort: try form first, then query string.
    try {
      params = new URLSearchParams(await request.text());
    } catch {
      params = new URL(request.url).searchParams;
    }
  }

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return err("unsupported_grant_type", `grant_type=${grantType} not supported`);
  }

  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return err(
      "invalid_request",
      "code, redirect_uri, client_id, code_verifier required"
    );
  }

  const payload = verifyAuthCode(code);
  if (!payload) return err("invalid_grant", "code is invalid or expired");
  if (payload.client_id !== clientId) {
    return err("invalid_grant", "client_id mismatch");
  }
  if (payload.redirect_uri !== redirectUri) {
    return err("invalid_grant", "redirect_uri mismatch");
  }
  if (
    !verifyPkce(codeVerifier, payload.code_challenge, payload.code_challenge_method)
  ) {
    return err("invalid_grant", "PKCE verification failed");
  }

  const accessToken = mintAccessToken({
    sub: payload.sub,
    scope: payload.scope,
    client_id: payload.client_id,
  });

  return NextResponse.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      scope: payload.scope,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
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
      "Access-Control-Allow-Headers": "content-type, authorization",
    },
  });
}

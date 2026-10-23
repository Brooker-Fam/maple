import { NextRequest, NextResponse } from "next/server";
import { mintAuthCode, publicOrigin, trustedRedirect, verifyAdminCreds } from "@/lib/mcp/auth";
import {
  ADMIN_ID,
  isGoogleConfigured,
  isRemoved,
  memberFor,
  openSession,
  SESSION_COOKIE,
} from "@/lib/maple/auth";
import type { Member } from "@/lib/maple/types";
import { checkUploadRateLimit } from "@/lib/rate-limit";

/**
 * OAuth 2.1 Authorization endpoint with PKCE.
 *
 * GET  — renders an HTML login form. Hidden inputs preserve all OAuth
 *        params (client_id, redirect_uri, code_challenge, etc.).
 * POST — validates admin creds, mints a short-lived authorization code
 *        (HMAC-signed; binds redirect_uri + code_challenge), and redirects
 *        back to the client with ?code=...&state=....
 *
 * There is no persistent user/client store — the admin Basic-Auth creds are
 * the single source of identity, wrapped in a standard OAuth shape so
 * ChatGPT and other strict clients can talk to us.
 *
 * Maple's Log (resource …/api/maple/mcp or scope "maple") takes its own
 * branch below: family members sign in with Google (the maple_session cookie
 * from /api/maple/auth/*), see a consent card naming the app and their
 * account, and get a code for sub "maple:<email>", scope "maple", bound to
 * the resource. The admin login stays as a fallback. Calendar and RSVP
 * requests keep the original admin-only form.
 */

function readParams(url: URL, form?: FormData) {
  const get = (k: string) =>
    form?.get(k)?.toString() ?? url.searchParams.get(k) ?? "";
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    response_type: get("response_type") || "code",
    scope: get("scope") || "calendar",
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: (get("code_challenge_method") || "S256") as
      | "S256"
      | "plain",
  };
}

function isAllowedRedirect(uri: string): boolean {
  if (!uri) return false;
  try {
    const u = new URL(uri);
    if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      return false;
    }
    return ["https:", "http:"].includes(u.protocol);
  } catch {
    return false;
  }
}

function renderForm(params: ReturnType<typeof readParams>, error?: string) {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("\n");
  const errorHtml = error
    ? `<p style="color:#b00;margin-top:12px;">${esc(error)}</p>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Brooker MCP Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#FDF8F0;color:#1D4420;margin:0;
    min-height:100vh;display:grid;place-items:center;padding:24px;}
  .card{background:white;border:1px solid #5C7A4A33;border-radius:12px;
    padding:32px;max-width:380px;width:100%;box-shadow:0 4px 24px #1D442014;}
  h1{margin:0 0 4px;font-size:20px;}
  p.sub{margin:0 0 20px;color:#5C7A4A;font-size:14px;}
  label{display:block;font-size:13px;margin:12px 0 4px;font-weight:600;}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;
    border:1px solid #5C7A4A55;border-radius:8px;font-size:15px;box-sizing:border-box;}
  button{margin-top:20px;width:100%;padding:11px;background:#1D4420;color:#FDF8F0;
    border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;}
  button:hover{background:#2a5c2e;}
</style>
</head><body>
<form class="card" method="post">
  <h1>Brooker MCP</h1>
  <p class="sub">Sign in to connect your AI assistant to the family calendar.</p>
  <label>Username</label>
  <input type="text" name="username" autocomplete="username" autofocus required>
  <label>Password</label>
  <input type="password" name="password" autocomplete="current-password" required>
  ${hidden}
  <button type="submit">Authorize</button>
  ${errorHtml}
</form>
</body></html>`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  if (isMapleRequest(url)) return mapleAuthorize(request, url);
  const params = readParams(url);

  if (!params.client_id || !params.redirect_uri) {
    return new NextResponse("Missing client_id or redirect_uri", { status: 400 });
  }
  if (!isAllowedRedirect(params.redirect_uri)) {
    return new NextResponse("Invalid redirect_uri", { status: 400 });
  }
  if (params.response_type !== "code") {
    return new NextResponse("Only response_type=code supported", { status: 400 });
  }

  return new NextResponse(renderForm(params), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const form = await request.formData();
  if (isMapleRequest(url, form)) return mapleAuthorize(request, url, form);
  const params = readParams(url, form);
  const username = form.get("username")?.toString() ?? "";
  const password = form.get("password")?.toString() ?? "";

  if (!params.client_id || !params.redirect_uri || !isAllowedRedirect(params.redirect_uri)) {
    return new NextResponse("Invalid request", { status: 400 });
  }
  if (!verifyAdminCreds(username, password)) {
    return new NextResponse(renderForm(params, "Invalid credentials."), {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const code = mintAuthCode({
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: params.code_challenge_method,
    scope: params.scope,
    sub: "admin",
  });

  const redirect = new URL(params.redirect_uri);
  redirect.searchParams.set("code", code);
  if (params.state) redirect.searchParams.set("state", params.state);
  return NextResponse.redirect(redirect.toString(), 302);
}

// ── Maple's Log ─────────────────────────────────────────────────────────

const MAPLE_PATH = "/api/maple/mcp";

function formOrQuery(url: URL, form: FormData | undefined, key: string): string {
  return form?.get(key)?.toString() ?? url.searchParams.get(key) ?? "";
}

/** Maple asks are recognized by the RFC 8707 resource, or by scope "maple". */
function isMapleRequest(url: URL, form?: FormData): boolean {
  const resource = formOrQuery(url, form, "resource");
  if (resource) {
    try {
      if (new URL(resource).pathname === MAPLE_PATH) return true;
    } catch {
      // not a URL; fall through to scope
    }
  }
  return formOrQuery(url, form, "scope").split(/\s+/).includes("maple");
}

type MapleParams = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
};

function readMapleParams(url: URL, form?: FormData): MapleParams {
  const get = (k: string) => formOrQuery(url, form, k);
  return {
    client_id: get("client_id"),
    redirect_uri: get("redirect_uri"),
    response_type: get("response_type") || "code",
    scope: get("scope") || "maple",
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    resource: get("resource"),
  };
}


/** "Claude" / "ChatGPT" / "this app", plus the host shown on the consent card. */
function mapleClient(uri: string): { name: string; host: string } {
  const u = new URL(uri);
  const host = u.hostname.toLowerCase();
  if (host === "claude.ai" || host === "claude.com") return { name: "Claude", host: u.host };
  if (host === "chatgpt.com" || host === "chat.openai.com") return { name: "ChatGPT", host: u.host };
  return { name: "this app", host: u.host };
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function redirectWithError(p: MapleParams, error: string, description: string) {
  const to = new URL(p.redirect_uri);
  to.searchParams.set("error", error);
  to.searchParams.set("error_description", description);
  if (p.state) to.searchParams.set("state", p.state);
  return NextResponse.redirect(to.toString(), 302);
}

async function signedInMember(request: NextRequest): Promise<{ member: Member | null; offline: boolean }> {
  const id = openSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!id) return { member: null, offline: false };
  try {
    return { member: await memberFor(id), offline: false };
  } catch (error) {
    console.error("Maple authorize: membership lookup failed:", error);
    return { member: null, offline: true };
  }
}

async function mapleAuthorize(request: NextRequest, url: URL, form?: FormData) {
  const p = readMapleParams(url, form);

  // Without a trustworthy redirect_uri, errors can only be shown here.
  if (!p.client_id || !p.redirect_uri) {
    return maplePage(400, "Something's missing", `<p>This sign-in link is missing its app details. Start again from Claude or ChatGPT.</p>`);
  }
  if (!trustedRedirect(p.redirect_uri)) {
    return maplePage(
      400,
      "Unknown app",
      `<p>Maple's Log only connects to Claude, ChatGPT, or an app on this computer. This request wanted to send you to <strong>${esc(safeHost(p.redirect_uri))}</strong>, so it was stopped.</p>`
    );
  }
  if (p.response_type !== "code") {
    return redirectWithError(p, "unsupported_response_type", "Only response_type=code is supported");
  }
  if (p.code_challenge_method !== "S256" || !PKCE_CHALLENGE_RE.test(p.code_challenge)) {
    return redirectWithError(p, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  const origin = publicOrigin(request);
  // The token is only good for this server's Maple endpoint: a resource on
  // any other host (or path) is refused, so no other MCP server can obtain a
  // parent's token through this consent screen.
  const resource = `${origin}${MAPLE_PATH}`;
  if (p.resource && canonResource(p.resource) !== canonResource(resource)) {
    return redirectWithError(p, "invalid_target", `resource must be ${resource}`);
  }

  const client = mapleClient(p.redirect_uri);
  const mint = (sub: string) => {
    const code = mintAuthCode({
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      code_challenge_method: "S256",
      scope: "maple",
      sub,
      resource,
    });
    const to = new URL(p.redirect_uri);
    to.searchParams.set("code", code);
    if (p.state) to.searchParams.set("state", p.state);
    return NextResponse.redirect(to.toString(), 302);
  };

  if (request.method === "POST" && form) {
    // Approve: same-origin form only (the SameSite=Lax session cookie already
    // keeps cross-site posts signed out; this is belt and braces).
    if (form.get("maple_consent")?.toString() === "1") {
      const from = request.headers.get("origin");
      if (from && from !== origin && from !== url.origin) {
        return maplePage(403, "That didn't come from here", `<p>For safety, approve the connection from this page.</p>`);
      }
      const { member, offline } = await signedInMember(request);
      if (offline) return offlinePage();
      if (!member) return signInPage(p, client, "Please sign in again to approve.");
      return mint(member.email === ADMIN_ID ? ADMIN_ID : `maple:${member.email}`);
    }

    // Admin login fallback (before Google is set up, or for the site admin).
    if (form.has("username") || form.has("password")) {
      const { allowed } = await checkUploadRateLimit(request);
      if (!allowed) return signInPage(p, client, "Too many tries. Take a break and try again later.", 429);
      const user = form.get("username")?.toString() ?? "";
      const pass = form.get("password")?.toString() ?? "";
      if (!verifyAdminCreds(user, pass)) return signInPage(p, client, "That username and password didn't match.", 401);
      if (await isRemoved(ADMIN_ID).catch(() => false)) {
        return signInPage(p, client, "The admin login was turned off for Maple's Log. Continue with Google instead.", 403);
      }
      return mint(ADMIN_ID);
    }
  }

  const { member, offline } = await signedInMember(request);
  if (offline) return offlinePage();
  if (!member) return signInPage(p, client);
  return consentPage(p, client, member, cancelUrl(p));
}

/** Same resource whatever the host's case or a trailing slash. */
function canonResource(r: string): string {
  try {
    const u = new URL(r);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return r.replace(/\/+$/, "");
  }
}

function cancelUrl(p: MapleParams): string {
  const to = new URL(p.redirect_uri);
  to.searchParams.set("error", "access_denied");
  if (p.state) to.searchParams.set("state", p.state);
  return to.toString();
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host || uri.slice(0, 80);
  } catch {
    return uri.slice(0, 80);
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hiddenInputs(p: MapleParams): string {
  return Object.entries(p)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("\n    ");
}

/** The full authorize URL path, so Google sign-in can come straight back here. */
function returnPath(p: MapleParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) qs.set(k, v);
  return `/oauth/authorize?${qs.toString()}`;
}

function googleHref(p: MapleParams): string {
  return `/api/maple/auth/start?return=${encodeURIComponent(returnPath(p))}`;
}

function signInPage(p: MapleParams, client: { name: string; host: string }, error?: string, status = 200) {
  const google = isGoogleConfigured()
    ? `<a class="btn primary" href="${esc(googleHref(p))}">Continue with Google</a>
  <p class="or"><span>or use the admin login</span></p>`
    : "";
  const body = `
  <p class="lead">Sign in to connect <strong>${esc(client.name)}</strong> <span class="host">(${esc(client.host)})</span> to Maple's Log.</p>
  ${google}
  <form method="post" class="admin">
    <label for="u">Username</label>
    <input id="u" type="text" name="username" autocomplete="username" required>
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" required>
    ${hiddenInputs(p)}
    <button type="submit" class="btn ${google ? "quiet" : "primary"}">Sign in</button>
  </form>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <p class="fine">Only family members invited to Maple's Log can connect. Use the Google account you use for the app.</p>`;
  return maplePage(status, "Connect to Maple's Log", body);
}

function consentPage(p: MapleParams, client: { name: string; host: string }, member: Member, cancel: string) {
  const name = member.display_name || (member.email === ADMIN_ID ? "Admin" : member.email.split("@")[0]);
  const who = member.email === ADMIN_ID ? esc(name) : `${esc(name)} <span class="host">(${esc(member.email)})</span>`;
  const readOnly = member.role === "viewer";
  const body = `
  <p class="lead">Connect <strong>${esc(client.name)}</strong> <span class="host">(${esc(client.host)})</span> to Maple's Log as ${who}?</p>
  <ul class="perks">
    <li>${readOnly ? "Read Maple's log: feeds, diapers, sleep, growth and moments (you're a viewer, so it can't add anything)." : "Read and add to Maple's log: feeds, diapers, sleep, growth, temperatures and moments."}</li>
    <li>Anything it logs shows your name and &ldquo;via ${esc(client.name === "this app" ? "AI" : client.name)}&rdquo;.</li>
    <li>Disconnect anytime by removing the connector${member.role === "owner" ? "" : ", or ask an owner to remove you in Family"}.</li>
  </ul>
  <form method="post">
    ${hiddenInputs(p)}
    <input type="hidden" name="maple_consent" value="1">
    <button type="submit" class="btn primary">Approve</button>
  </form>
  <a class="btn quiet" href="${esc(cancel)}">Cancel</a>
  <p class="fine">Not ${esc(name)}? <a href="${esc(googleHref(p))}">Use a different Google account</a>.</p>`;
  return maplePage(200, "Connect to Maple's Log", body);
}

function offlinePage() {
  return maplePage(503, "Maple's Log is napping", `<p>We couldn't reach Maple's Log just now. Try connecting again in a minute.</p>`);
}

function maplePage(status: number, title: string, body: string) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Maple's Log</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  :root{color-scheme:light dark;}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#FDF8F0;color:#1D4420;margin:0;
    min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;}
  .card{background:#fff;border:1px solid #5C7A4A33;border-radius:16px;padding:28px 26px;
    max-width:400px;width:100%;box-shadow:0 6px 28px #1D442016;box-sizing:border-box;}
  .leaf{font-size:34px;line-height:1;margin-bottom:6px;}
  h1{margin:0 0 14px;font-size:22px;letter-spacing:-.01em;}
  .lead{margin:0 0 16px;font-size:16px;line-height:1.45;}
  .host{color:#5C7A4A;font-weight:400;}
  .perks{margin:0 0 18px;padding-left:18px;color:#1D4420cc;font-size:14px;line-height:1.5;}
  .perks li{margin:4px 0;}
  label{display:block;font-size:13px;margin:12px 0 4px;font-weight:600;}
  input[type=text],input[type=password]{width:100%;padding:11px 12px;border:1px solid #5C7A4A55;
    border-radius:10px;font-size:16px;box-sizing:border-box;background:#fff;color:inherit;}
  .btn{display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:13px;border-radius:12px;
    font-size:16px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer;border:0;font-family:inherit;}
  .primary{background:#1D4420;color:#FDF8F0;}
  .primary:hover{background:#2a5c2e;}
  .quiet{background:transparent;color:#1D4420;border:1px solid #5C7A4A55;}
  .quiet:hover{background:#5C7A4A14;}
  form{margin:0;}
  .or{display:flex;align-items:center;gap:10px;color:#5C7A4A;font-size:12px;margin:18px 0 2px;}
  .or::before,.or::after{content:"";flex:1;border-top:1px solid #5C7A4A33;}
  .error{color:#B5452B;margin:14px 0 0;font-size:14px;}
  .fine{color:#5C7A4A;font-size:12.5px;line-height:1.5;margin:18px 0 0;}
  .fine a{color:inherit;}
  @media (prefers-color-scheme: dark){
    body{background:#0F1B11;color:#FDF8F0;}
    .card{background:#162618;border-color:#FDF8F01f;box-shadow:none;}
    .host,.or,.fine{color:#B5C9A3;}
    .perks{color:#FDF8F0cc;}
    input[type=text],input[type=password]{background:#0F1B11;border-color:#FDF8F033;}
    .primary{background:#C49A3C;color:#1D2A14;}
    .primary:hover{background:#d4aa4c;}
    .quiet{color:#FDF8F0;border-color:#FDF8F033;}
    .error{color:#E8A08A;}
  }
</style>
</head><body>
<main class="card">
  <div class="leaf" aria-hidden="true">🍁</div>
  <h1>${esc(title)}</h1>
  ${body}
</main>
</body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

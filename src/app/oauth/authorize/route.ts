import { NextRequest, NextResponse } from "next/server";
import { mintAuthCode, publicOrigin, verifyAdminCreds } from "@/lib/mcp/auth";
import { OAuthClientError, resolveOAuthClient, type OAuthClientInfo } from "@/lib/mcp/clients";
import { ADMIN_ID, isGoogleConfigured, isRemoved, openSession, SESSION_COOKIE, signedInAs, type SignedIn } from "@/lib/maple/auth";
import { adminFamilyId, familiesOf, parseFamilyId } from "@/lib/maple/family";
import type { Member } from "@/lib/maple/types";
import { checkUploadRateLimit } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/posthog-server";

/**
 * OAuth 2.1 Authorization endpoint with PKCE, for connecting Claude, ChatGPT or
 * a local app to the MCP server at /api/maple/mcp.
 *
 * Family members sign in with Google (the maple_session cookie from
 * /api/maple/auth/*), see a consent card naming the app and their account, and
 * get a code for sub "maple:<email>" and `fam` (the family it opens: the
 * session's, or the one they pick when they belong to several), scope "maple",
 * bound to the resource. The admin login stays as a fallback, in its own family only.
 */

export async function GET(request: NextRequest) {
  return mapleAuthorize(request, new URL(request.url));
}

export async function POST(request: NextRequest) {
  return mapleAuthorize(request, new URL(request.url), await request.formData());
}

// ── Maple's Log ─────────────────────────────────────────────────────────

const MAPLE_PATH = "/api/maple/mcp";

function formOrQuery(url: URL, form: FormData | undefined, key: string): string {
  return form?.get(key)?.toString() ?? url.searchParams.get(key) ?? "";
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

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function callbackUrl(p: MapleParams, issuer: string, values: Record<string, string>) {
  const to = new URL(p.redirect_uri);
  if (p.state) to.searchParams.set("state", p.state);
  for (const [key, value] of Object.entries(values)) to.searchParams.set(key, value);
  to.searchParams.set("iss", issuer);
  return to.toString();
}

function redirectWithError(p: MapleParams, issuer: string, error: string, description: string) {
  return NextResponse.redirect(callbackUrl(p, issuer, { error, error_description: description }), { status: 302, headers: { "Referrer-Policy": "no-referrer" } });
}

function approveConnection(p: MapleParams, issuer: string, sub: string, fam: number) {
  const code = mintAuthCode({
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    code_challenge: p.code_challenge,
    code_challenge_method: "S256",
    scope: "maple",
    sub,
    fam,
    resource: `${issuer}${MAPLE_PATH}`,
  });
  return NextResponse.redirect(callbackUrl(p, issuer, { code }), { status: 302, headers: { "Referrer-Policy": "no-referrer" } });
}

type Families = { familyId: number; name: string | null }[];

/**
 * Who's signed in, in the family the session names or, on Approve, the one
 * they picked (`pick`): membership there is read fresh, so a family they
 * aren't in opens nothing. `families`: every family they're in, for the picker.
 */
async function signedInMember(request: NextRequest, pick?: number | null): Promise<{ who: SignedIn | null; families: Families; offline: boolean }> {
  const body = openSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!body) return { who: null, families: [], offline: false };
  try {
    const who = await signedInAs(pick ? { id: body.id, fam: pick } : body);
    const families = who && who.member.email !== ADMIN_ID ? await familiesOf(who.member.email) : [];
    return { who, families, offline: false };
  } catch {
    return { who: null, families: [], offline: true };
  }
}

async function mapleAuthorize(request: NextRequest, url: URL, form?: FormData) {
  const p = readMapleParams(url, form);
  const origin = publicOrigin(request);

  // Without a trustworthy redirect_uri, errors can only be shown here.
  if (!p.client_id || !p.redirect_uri) {
    return maplePage(400, "Something's missing", `<p>This sign-in link is missing its app details. Start again from Claude or ChatGPT.</p>`);
  }
  let client: OAuthClientInfo;
  try {
    client = await resolveOAuthClient(p.client_id, p.redirect_uri);
  } catch (error) {
    if (!(error instanceof OAuthClientError) || error.code === "unavailable") {
      return maplePage(503, "Couldn't verify the app", `<p>The app's connection details couldn't be loaded. Try connecting again in a minute.</p>`);
    }
    return maplePage(
      400,
      "Couldn't verify the connection",
      `<p>The app's identity or return address doesn't match. Start a new connection from Claude or ChatGPT.</p>`
    );
  }
  if (p.response_type !== "code") {
    return redirectWithError(p, origin, "unsupported_response_type", "Only response_type=code is supported");
  }
  if (p.code_challenge_method !== "S256" || !PKCE_CHALLENGE_RE.test(p.code_challenge)) {
    return redirectWithError(p, origin, "invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  // The token is only good for this server's Maple endpoint: a resource on
  // any other host (or path) is refused, so no other MCP server can obtain a
  // parent's token through this consent screen.
  const resource = `${origin}${MAPLE_PATH}`;
  if (p.resource && canonResource(p.resource) !== canonResource(resource)) {
    return redirectWithError(p, origin, "invalid_target", `resource must be ${resource}`);
  }

  if (request.method === "POST" && form) {
    // Approve: same-origin form only (the SameSite=Lax session cookie already
    // keeps cross-site posts signed out; this is belt and braces).
    if (form.get("maple_consent")?.toString() === "1") {
      const from = request.headers.get("origin");
      if (from && from !== origin && from !== url.origin) {
        return maplePage(403, "That didn't come from here", `<p>For safety, approve the connection from this page.</p>`);
      }
      const { who, offline } = await signedInMember(request, parseFamilyId(form.get("maple_family")?.toString()));
      if (offline) return offlinePage();
      if (!who) return signInPage(p, client, "Please sign in again to approve.");
      if (who.member.role === "photos") return photoGuestPage();
      return approveConnection(p, origin, who.member.email === ADMIN_ID ? ADMIN_ID : `maple:${who.member.email}`, who.ctx.familyId);
    }

    // Admin login fallback (before Google is set up, or for the site admin).
    if (form.has("username") || form.has("password")) {
      const { allowed } = await checkUploadRateLimit(request);
      if (!allowed) return signInPage(p, client, "Too many tries. Take a break and try again later.", 429);
      const user = form.get("username")?.toString() ?? "";
      const pass = form.get("password")?.toString() ?? "";
      if (!verifyAdminCreds(user, pass)) return signInPage(p, client, "That username and password didn't match.", 401);
      if (await isRemoved({ familyId: adminFamilyId() }, ADMIN_ID).catch(() => false)) {
        return signInPage(p, client, "The admin login was turned off for Maple's Log. Continue with Google instead.", 403);
      }
      return approveConnection(p, origin, ADMIN_ID, adminFamilyId());
    }
  }

  const { who, families, offline } = await signedInMember(request);
  if (offline) return offlinePage();
  if (!who) return signInPage(p, client);
  if (who.member.role === "photos") return photoGuestPage();
  return consentPage(p, client, who.member, callbackUrl(p, origin, { error: "access_denied" }), { current: who.ctx.familyId, families });
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
  <p><a href="${esc(`/maple?return=${encodeURIComponent(returnPath(p))}`)}">More sign-in options</a></p>
  <form method="post" class="admin">
    <label for="u">Username</label>
    <input id="u" type="text" name="username" autocomplete="username" required>
    <label for="pw">Password</label>
    <input id="pw" type="password" name="password" autocomplete="current-password" required>
    ${hiddenInputs(p)}
    <button type="submit" class="btn ${google ? "quiet" : "primary"}">Sign in</button>
  </form>
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <p class="fine">Only family members invited to Maple's Log can connect. Use the same account you use for the app.</p>`;
  return maplePage(status, "Connect to Maple's Log", body);
}

/** Only for someone in two or more families: which one the connection opens, the session's picked to start. */
function familyPicker(choice: { current: number; families: Families }): string {
  if (choice.families.length < 2) return "";
  const rows = choice.families
    .map((f, i) => {
      const label = f.name?.trim() || `Family ${i + 1}`;
      const checked = f.familyId === choice.current ? " checked" : "";
      return `<label class="pick"><input type="radio" name="maple_family" value="${f.familyId}"${checked}> ${esc(label)}</label>`;
    })
    .join("\n    ");
  return `<fieldset class="families"><legend>Which family?</legend>
    ${rows}
  </fieldset>`;
}

function consentPage(p: MapleParams, client: OAuthClientInfo, member: Member, cancel: string, choice: { current: number; families: Families }) {
  const name = member.display_name || (member.email === ADMIN_ID ? "Admin" : member.email.split("@")[0]);
  const who = member.email === ADMIN_ID ? esc(name) : `${esc(name)} <span class="host">(${esc(member.email)})</span>`;
  const readOnly = member.role === "viewer";
  const body = `
  <p class="lead">Connect <strong>${esc(client.name)}</strong> <span class="host">(${esc(client.host)})</span> to Maple's Log as ${who}?</p>
  ${client.metadataUrl ? `<p class="fine">App identity: ${esc(client.host)}. After approval, return to ${esc(safeHost(p.redirect_uri))}.</p>` : ""}
  <ul class="perks">
    <li>${readOnly ? "Read Maple's log: feeds, diapers, sleep, growth and moments (you're a viewer, so it can't add anything)." : "Read and add to Maple's log: feeds, diapers, sleep, growth, temperatures and moments."}</li>
    <li>Anything it logs is credited to your Maple account.</li>
    <li>Disconnect anytime by removing the connector${member.role === "owner" ? "" : ", or ask an owner to remove you in Family"}.</li>
  </ul>
  <form method="post">
    ${familyPicker(choice)}
    ${hiddenInputs(p)}
    <input type="hidden" name="maple_consent" value="1">
    <button type="submit" class="btn primary">Approve</button>
  </form>
  <a class="btn quiet" href="${esc(cancel)}" referrerpolicy="no-referrer">Cancel</a>
  <p class="fine">Not ${esc(name)}? <a href="${esc(googleHref(p))}">Use a different Google account</a>.</p>`;
  return maplePage(200, "Connect to Maple's Log", body);
}

function photoGuestPage() {
  return maplePage(403, "Photos-only access", `<p>Your access is limited to shared moments. Assistants cannot connect to this family’s log from your account.</p><a class="btn quiet" href="/maple">Open shared moments</a>`);
}

function offlinePage() {
  return maplePage(503, "Maple's Log is napping", `<p>We couldn't reach Maple's Log just now. Try connecting again in a minute.</p>`);
}

async function maplePage(status: number, title: string, body: string) {
  if (status >= 400) await captureServerException(Object.assign(new Error("OAuth request failed"), { code: String(status) }), { route: "/oauth/authorize", status });
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
  .families{border:1px solid #5C7A4A33;border-radius:12px;margin:0 0 6px;padding:8px 14px 10px;}
  .families legend{font-size:13px;font-weight:600;padding:0 4px;}
  .pick{display:flex;align-items:center;gap:8px;font-size:15px;margin:6px 0;font-weight:400;}
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
      "Referrer-Policy": "same-origin",
    },
  });
}

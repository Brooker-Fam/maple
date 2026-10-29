import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { publicOrigin, verifyAccessToken, verifyBasicAuthHeader } from "@/lib/mcp/auth";
import { isRemoved } from "@/lib/maple/auth";
import { ADMIN_MEMBER_ID, adminFamilyId, carrierFamily, familyForAuth, FAMILY_ONE, memberIdFromSub } from "@/lib/maple/family";
import { copyForFamily, mapleInstructions, registerMapleTools, unknownFamilyCopy, type ToolCopy } from "@/lib/maple/mcp-tools";
import { captureServerException } from "@/lib/posthog-server";

/**
 * MCP server for Maple's Log, the family newborn tracker, so a parent can say
 * "she just nursed 12 min left, 8 right" to Claude or ChatGPT. Tools live in
 * src/lib/maple/mcp-tools.ts.
 *
 * Transport: Streamable HTTP only, at /api/maple/mcp. SSE is off (it needs
 * Redis). Every POST gets a fresh stateless server, so tool registration must
 * stay free of DB calls: the family's words are read before it (copyFor). The static /api/maple/* routes (state, entries,
 * timer, auth…) win over this [transport] segment, so it only ever sees mcp.
 *
 * Auth (withMcpAuth → 401 + resource_metadata, which starts OAuth in clients):
 *   - Bearer from the /oauth shim: sub "maple:<email>" for a current member
 *     of the family its `fam` names (none: family 1), scope "maple" /
 *     resource …/api/maple/mcp; or sub "admin", in the admin login's family only.
 *   - HTTP Basic with the admin login, for Claude Code / Inspector.
 */

export const maxDuration = 60;

type Handler = (req: Request) => Promise<Response>;

function buildHandler(copy: ToolCopy): Handler {
  return createMcpHandler(
    (server) => {
      registerMapleTools(server, copy);
    },
    {
      serverInfo: { name: "maples-log", version: "1.0.0" },
      instructions: mapleInstructions(copy),
    },
    {
      basePath: "/api/maple",
      disableSse: true,
      maxDuration: 60,
      verboseLogs: false,
      onEvent: (event) => {
        if (event.type === "ERROR") {
          void captureServerException(event.error, {
            route: "/api/maple/mcp",
            context: event.context,
            source: event.source,
          });
        }
      },
    }
  );
}

/**
 * The tool text and instructions speak in the caller's own family's words
 * (copyForFamily: its baby, its mom, its clock), so one family's names never
 * reach another's assistant. One handler per family's words, kept while
 * they're in use. Every family's copy comes from its own saved profile.
 */
const handlers = new Map<string, Handler>();
const HANDLERS_KEPT = 64;

function handlerFor(familyId: number, copy: ToolCopy): Handler {
  const key = JSON.stringify([familyId, copy.opening, copy.tz, copy.exampleBy, copy.v.name, copy.v.pronoun, copy.v.mom, copy.v.hasMom]);
  let h = handlers.get(key);
  if (h) {
    handlers.delete(key);
  } else {
    h = buildHandler(copy);
    if (handlers.size >= HANDLERS_KEPT) handlers.delete(handlers.keys().next().value!);
  }
  handlers.set(key, h);
  return h;
}

async function copyFor(extra: { sub?: unknown; fam?: unknown } | undefined): Promise<{ familyId: number; copy: ToolCopy }> {
  const familyId = carrierFamily(extra?.fam) ?? FAMILY_ONE;
  try {
    const ctx = await familyForAuth({ sub: extra?.sub, fam: familyId });
    if (ctx) return { familyId, copy: await copyForFamily(ctx) };
  } catch (error) {
    void captureServerException(error, { route: "/api/maple/mcp (copy)" });
  }
  return { familyId, copy: unknownFamilyCopy(familyId) };
}

const baseHandler: Handler = async (req) => {
  const { familyId, copy } = await copyFor((req as Request & { auth?: AuthInfo }).auth?.extra as { sub?: unknown; fam?: unknown } | undefined);
  return handlerFor(familyId, copy)(req);
};

const VIAS = new Set(["claude", "chatgpt", "mcp"]);

/** An owner can turn off the admin login for Maple (Family → remove "Admin"). */
async function adminRemoved(): Promise<boolean> {
  try {
    return await isRemoved({ familyId: adminFamilyId() }, ADMIN_MEMBER_ID);
  } catch {
    return false;
  }
}

/**
 * Who's calling, and in which family. Returning undefined makes withMcpAuth
 * answer 401, which is what sends Claude/ChatGPT back through sign-in.
 * Anything thrown here would also become a 401, so a database blip during
 * the membership check is swallowed rather than disconnecting a parent
 * mid-night (every tool call checks membership in that family again).
 */
async function verifyToken(req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (bearer) {
    const payload = verifyAccessToken(bearer);
    if (!payload) return undefined;
    const scopes = payload.scope ? payload.scope.split(" ") : [];
    const via = payload.via && VIAS.has(payload.via) ? payload.via : "mcp";
    // A token minted before families has no fam: family 1, and only for its members there.
    const fam = carrierFamily(payload.fam);
    if (fam === null) return undefined;
    const info = (sub: string): AuthInfo => ({
      token: bearer,
      clientId: payload.client_id,
      scopes,
      extra: { sub, fam, via },
    });

    // RFC 8707 audience: a token bound to a resource must be bound to this
    // exact endpoint (not another host's /api/maple/mcp, not the calendar).
    const expected = `${publicOrigin(req)}/api/maple/mcp`;
    const bound = payload.resource?.replace(/\/+$/, "");
    if (bound && bound !== expected) return undefined;
    if (payload.sub === ADMIN_MEMBER_ID) return fam !== adminFamilyId() || (await adminRemoved()) ? undefined : info(ADMIN_MEMBER_ID);
    if (!memberIdFromSub(payload.sub)) return undefined;
    if (!bound && !scopes.includes("maple")) return undefined;
    try {
      if (!(await familyForAuth({ sub: payload.sub, fam }))) return undefined;
    } catch (error) {
      console.error("Maple MCP membership check failed:", error);
    }
    return info(payload.sub);
  }

  if (verifyBasicAuthHeader(req.headers.get("authorization")) && !(await adminRemoved())) {
    return {
      token: "basic-auth",
      clientId: "admin-basic",
      scopes: ["maple"],
      extra: { sub: ADMIN_MEMBER_ID, fam: adminFamilyId(), via: "mcp" },
    };
  }
  return undefined;
}

const authedHandler = withMcpAuth(baseHandler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/maple/mcp",
});

async function handleRequest(req: Request): Promise<Response> {
  // mcp-handler never answers a body that isn't JSON (the request hangs until
  // the function times out), so turn it away here with a JSON-RPC parse error.
  if (req.method === "POST") {
    try {
      JSON.parse(await req.clone().text());
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
  }
  const res = await authedHandler(req);
  // Tell clients which scope to ask for (mcp-handler's challenge omits it).
  if (res.status === 401) {
    const headers = new Headers(res.headers);
    const challenge = headers.get("www-authenticate");
    if (challenge && !/scope=/.test(challenge)) {
      headers.set("www-authenticate", `${challenge}, scope="maple"`);
    }
    return new Response(res.body, { status: 401, headers });
  }
  return res;
}

export { handleRequest as GET, handleRequest as POST, handleRequest as DELETE };

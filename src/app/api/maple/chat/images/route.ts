import type { NextRequest } from "next/server";
import { json, withMember } from "@/lib/maple/api";
import { chatConsent } from "@/lib/maple/consent";
import { CHAT_TERMS_NEEDED } from "@/lib/maple/chat/types";
import { ChatImageError, readChatImage, receiveChatImage } from "@/lib/maple/chat/image-store";
import type { FamilyCtx } from "@/lib/maple/family";
import { StoreUnavailable } from "@/lib/maple/store";
import type { Member } from "@/lib/maple/types";
import { captureServerException } from "@/lib/posthog-server";

export const runtime = "nodejs";
export const maxDuration = 30;
const ROUTE = "/api/maple/chat/images";
class ChatImageRequestFailed extends Error {}

type Handler = (request: NextRequest, member: Member, fam: FamilyCtx) => Promise<Response>;

function imageRoute(method: string, handler: Handler) {
  const authorized = withMember(`${method} ${ROUTE}`, async (request, member, fam) => {
    try {
      return await handler(request, member, fam);
    } catch (error) {
      if (error instanceof ChatImageError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      if (error instanceof StoreUnavailable) throw error;
      throw new ChatImageRequestFailed("chat_image_request_failed");
    }
  });
  return async (request: NextRequest) => {
    const response = await authorized(request);
    if (response.status >= 400 && response.status < 500) await captureServerException(new Error("chat_image_request_failed"), { route: ROUTE, status: response.status }).catch(() => {});
    return response;
  };
}

export const POST = imageRoute("POST", async (request, member, fam) => {
  if (!(await chatConsent(fam, member)).terms) return json({ error: CHAT_TERMS_NEEDED, code: "terms" }, 403);
  const image = await receiveChatImage(fam, member, request);
  return json({ image }, 201);
});

export const GET = imageRoute("GET", async (request, member, fam) => {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const bytes = await readChatImage(fam, member, id);
  return new Response(new Uint8Array(bytes), { headers: {
    "Content-Type": "image/jpeg",
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": "inline; filename=chat-photo.jpg",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  } });
});

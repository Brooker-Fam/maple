import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { query } from "@/lib/db";
import { sessionMember } from "@/lib/maple/auth";
import {
  blobToken,
  MAPLE_PHOTO_MAX_BYTES,
  MAPLE_PHOTO_TYPES,
  MAPLE_UPLOAD_PATH_RE,
  uploadStore,
} from "@/lib/maple/blob";
import { MAPLE_BLOB_RE } from "@/lib/maple/validate";
import { captureServerException } from "@/lib/posthog-server";
import { checkUploadRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Client uploads for Maple's moments: phones send re-encoded JPEGs straight to
 * Vercel Blob (no 4.5 MB function body limit); this route only signs short-lived
 * client tokens for signed-in family members. The resulting blob URLs go into
 * maple_entries.data.photos via POST /api/maple/entries and are only ever read
 * back through /api/maple/photo.
 *
 * Access handshake: the store decides public vs private (fixed at creation), and
 * the client must call upload() with the matching `access`. So:
 *   1. GET  → { ready, access } tells the client which mode to use.
 *   2. POST → the client echoes it as clientPayload {"access": ...}; a mismatch
 *      (the private store was added between GET and POST) is rejected up front
 *      instead of failing later at Blob with a vaguer error.
 *
 * No onUploadCompleted: nothing needs the callback (the entry is saved by the
 * client) and leaving it out means Vercel never calls back here without cookies.
 */

function noStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const denied = await writerCheck(request);
  if (denied) return denied;
  const store = uploadStore();
  return noStore({
    ready: !!store,
    access: store?.access ?? null,
    maxBytes: MAPLE_PHOTO_MAX_BYTES,
    types: MAPLE_PHOTO_TYPES,
  });
}

export async function POST(request: NextRequest) {
  const { allowed } = await checkUploadRateLimit(request);
  if (!allowed) return noStore({ error: "That's a lot of uploads at once. Try again in a little while." }, 429);

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return noStore({ error: "Expected a JSON body" }, 400);
  }

  // Token requests are the only event: no callback URL is ever registered, so
  // a "blob.upload-completed" here is noise (no cookies, nothing to do).
  if (body?.type !== "blob.generate-client-token") return noStore({ error: "Unexpected event" }, 400);
  const denied = await writerCheck(request);
  if (denied) return denied;

  const store = uploadStore();
  if (!store) return noStore({ error: "Photo storage isn't set up yet" }, 503);

  try {
    const result = await handleUpload({
      token: store.token,
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!MAPLE_UPLOAD_PATH_RE.test(pathname)) throw new UploadRejected("Unexpected upload path");
        let wanted: unknown = null;
        try {
          wanted = clientPayload ? (JSON.parse(clientPayload) as { access?: unknown }).access : null;
        } catch {
          // fall through to the mismatch error
        }
        if (wanted !== store.access) {
          throw new UploadRejected("Photo storage changed. Close the sheet and try again.");
        }
        return {
          allowedContentTypes: [...MAPLE_PHOTO_TYPES],
          maximumSizeInBytes: MAPLE_PHOTO_MAX_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60_000,
        };
      },
    });
    return noStore(result);
  } catch (error) {
    if (error instanceof UploadRejected) return noStore({ error: error.message }, 400);
    console.error("POST /api/maple/upload error:", error);
    await captureServerException(error, { route: "POST /api/maple/upload" });
    return noStore({ error: "Couldn't start the upload" }, 400);
  }
}

class UploadRejected extends Error {}

/** Uploading (and tidying up) is for members who can log: viewers are read-only. */
async function writerCheck(request: NextRequest): Promise<NextResponse | null> {
  const me = await sessionMember(request);
  if (!me) return noStore({ error: "Sign in first" }, 401);
  if (me.role === "viewer") return noStore({ error: "You have view-only access" }, 403);
  return null;
}

/**
 * DELETE { urls } — tidy up photos uploaded for a moment that was never saved
 * (removed from the sheet, or the sheet was closed). Only Maple paths, and
 * never a blob any moment (deleted ones included, for undo) still points at.
 */
export async function DELETE(request: NextRequest) {
  const denied = await writerCheck(request);
  if (denied) return denied;
  let urls: string[] = [];
  try {
    const body = (await request.json()) as { urls?: unknown };
    if (Array.isArray(body.urls)) urls = body.urls.filter((u): u is string => typeof u === "string");
  } catch {
    return noStore({ error: "Expected a JSON body" }, 400);
  }
  urls = [...new Set(urls.filter((u) => MAPLE_BLOB_RE.test(u)))].slice(0, 48);
  if (!urls.length) return noStore({ deleted: 0 });

  try {
    const rows = await query(
      `SELECT p->>'key' AS k, p->>'thumb_key' AS t
       FROM maple_entries, jsonb_array_elements(COALESCE(data->'photos', '[]'::jsonb)) AS p
       WHERE kind = 'moment' AND (p->>'key' = ANY($1::text[]) OR p->>'thumb_key' = ANY($1::text[]))`,
      [urls]
    );
    if (rows === null) return noStore({ deleted: 0 });
    const inUse = new Set(rows.flatMap((r) => [r.k, r.t]).filter(Boolean));
    const orphans = urls.filter((u) => !inUse.has(u));
    let deleted = 0;
    for (const access of ["private", "public"] as const) {
      const mine = orphans.filter((u) => u.includes(`.${access}.blob.`));
      const token = blobToken(access);
      if (!mine.length || !token) continue;
      await del(mine, { token });
      deleted += mine.length;
    }
    return noStore({ deleted });
  } catch (error) {
    console.error("DELETE /api/maple/upload error:", error);
    await captureServerException(error, { route: "DELETE /api/maple/upload" });
    return noStore({ error: "Couldn't tidy up those photos" }, 500);
  }
}

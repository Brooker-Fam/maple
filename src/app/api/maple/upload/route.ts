import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { query } from "@/lib/db";
import { errorResponse, withMember } from "@/lib/maple/api";
import { StoreUnavailable } from "@/lib/maple/store";
import {
  blobBelongsTo,
  blobToken,
  familyBlobPrefix,
  MAPLE_PHOTO_MAX_BYTES,
  MAPLE_PHOTO_TYPES,
  MAPLE_UPLOAD_PATH_RE,
  uploadStore,
} from "@/lib/maple/blob";
import type { FamilyCtx } from "@/lib/maple/family";
import { claimUpload, QUOTA_MESSAGE, UploadQuotaUnavailable } from "@/lib/maple/upload-quota";
import { MAPLE_BLOB_RE } from "@/lib/maple/validate";
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
 *   1. GET  → { ready, access, prefix } tells the client which mode to use, and
 *      the family's path prefix (maple/f<id>/) to upload under.
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

export const GET = withMember("GET /api/maple/upload", async (_request, _member, writer) => {
  const store = uploadStore();
  if (!store) return unavailable("GET /api/maple/upload", writer);
  return noStore({
    ready: true,
    access: store.access,
    maxBytes: MAPLE_PHOTO_MAX_BYTES,
    types: MAPLE_PHOTO_TYPES,
    prefix: familyBlobPrefix(writer.familyId),
  });
}, { write: true });

export async function POST(request: NextRequest) {
  const { allowed } = await checkUploadRateLimit(request);
  if (!allowed) return noStore({ error: "That's a lot of uploads at once. Try again in a little while." }, 429);
  return startUpload(request);
}

const startUpload = withMember("POST /api/maple/upload", async (request, _member, writer) => {
  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return noStore({ error: "Expected a JSON body" }, 400);
  }

  // Token requests are the only event: no callback URL is ever registered, so
  // a "blob.upload-completed" here is noise (no cookies, nothing to do).
  if (body?.type !== "blob.generate-client-token") return noStore({ error: "Unexpected event" }, 400);
  const payload = body.payload;
  if (!payload || typeof payload.pathname !== "string" || (payload.clientPayload != null && typeof payload.clientPayload !== "string") || (payload.multipart !== undefined && typeof payload.multipart !== "boolean")) {
    return noStore({ error: "Invalid upload request" }, 400);
  }
  const store = uploadStore();
  if (!store) return unavailable("POST /api/maple/upload", writer);

  try {
    const result = await handleUpload({
      token: store.token,
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!MAPLE_UPLOAD_PATH_RE.test(pathname) || !blobBelongsTo(pathname, writer.familyId)) throw new UploadRejected("Unexpected upload path");
        let wanted: unknown = null;
        try {
          wanted = clientPayload ? (JSON.parse(clientPayload) as { access?: unknown }).access : null;
        } catch {
          // fall through to the mismatch error
        }
        if (wanted !== store.access) {
          throw new UploadRejected("Photo storage changed. Close the sheet and try again.");
        }
        if (!(await claimUpload(writer.familyId))) throw new UploadRejected(QUOTA_MESSAGE, 429);
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
    if (error instanceof UploadRejected) return noStore({ error: error.message }, error.status);
    if (error instanceof UploadQuotaUnavailable) throw new StoreUnavailable();
    throw error;
  }
}, { write: true });

class PhotoStorageUnavailable extends Error {}

async function unavailable(route: string, family: FamilyCtx) {
  await errorResponse(route, new PhotoStorageUnavailable("photo_storage_unavailable"), family);
  return noStore({ error: "Photo storage isn't set up yet" }, 503);
}

class UploadRejected extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/**
 * DELETE { urls } — tidy up photos uploaded for a moment that was never saved
 * (removed from the sheet, or the sheet was closed). Only this family's Maple
 * paths, and never a blob one of its moments (deleted ones included, for
 * undo) still points at.
 */
export const DELETE = withMember("DELETE /api/maple/upload", async (request, _member, writer) => {
  let urls: string[] = [];
  try {
    const body = (await request.json()) as { urls?: unknown };
    if (Array.isArray(body.urls)) urls = body.urls.filter((u): u is string => typeof u === "string");
  } catch {
    return noStore({ error: "Expected a JSON body" }, 400);
  }
  urls = [...new Set(urls.filter((u) => MAPLE_BLOB_RE.test(u) && blobBelongsTo(u, writer.familyId)))].slice(0, 48);
  if (!urls.length) return noStore({ deleted: 0 });

  const rows = await query(
    `SELECT p->>'key' AS k, p->>'thumb_key' AS t
     FROM maple_entries, jsonb_array_elements(COALESCE(data->'photos', '[]'::jsonb)) AS p
     WHERE family_id = $2 AND kind = 'moment' AND (p->>'key' = ANY($1::text[]) OR p->>'thumb_key' = ANY($1::text[]))`,
    [urls, writer.familyId]
  );
  if (rows === null) throw new StoreUnavailable();
  const inUse = new Set(rows.flatMap((r) => [r.k, r.t]).filter(Boolean));
  const orphans = urls.filter((u) => !inUse.has(u));
  let deleted = 0;
  for (const access of ["private", "public"] as const) {
    const mine = orphans.filter((u) => u.includes(`.${access}.blob.`));
    const token = blobToken(access);
    if (!mine.length) continue;
    if (!token) return unavailable("DELETE /api/maple/upload", writer);
    await del(mine, { token });
    deleted += mine.length;
  }
  return noStore({ deleted });
}, { write: true });

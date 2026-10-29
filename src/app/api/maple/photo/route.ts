import { NextRequest } from "next/server";
import { get } from "@vercel/blob";
import { BadRequest, errorResponse, idParam, json, withMember } from "@/lib/maple/api";
import { blobBelongsTo, blobToken } from "@/lib/maple/blob";
import { getEntry, NotFound } from "@/lib/maple/store";
import { momentPhotoId } from "@/lib/maple/moment-photos";
import { MAPLE_BLOB_RE } from "@/lib/maple/validate";

export const dynamic = "force-dynamic";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const GET = withMember("GET /api/maple/photo", async (request: NextRequest, _me, ctx) => {
  const sp = new URL(request.url).searchParams;
  const entryId = idParam(request, "entry");
  const index = Number(sp.get("i") ?? "0");
  if (!Number.isInteger(index) || index < 0 || index > 50) throw new BadRequest("i must be a photo index");
  const size = sp.get("size") ?? "thumb";
  if (size !== "thumb" && size !== "full") throw new BadRequest("size must be thumb or full");

  const entry = await getEntry(ctx, entryId);
  if (!entry || entry.kind !== "moment") return notFound();
  const photo = sp.get("photo");
  const ref = photo ? entry.data.photos?.find(item => momentPhotoId(item) === photo) : entry.data.photos?.[index];
  // Thumbs are best-effort at upload time; fall back to the full image.
  const key = size === "thumb" ? ref?.thumb_key || ref?.key : ref?.key;
  if (!ref || !key || !MAPLE_BLOB_RE.test(key) || !blobBelongsTo(key, ctx.familyId)) return notFound();

  const access = ref.access ?? (key.includes(".private.blob.") ? "private" : "public");
  const token = blobToken(access);
  if (!token) {
    await errorResponse("GET /api/maple/photo", new PhotoStorageUnavailable("photo_storage_unavailable"), ctx);
    return json({ error: "Photo storage isn't set up" }, 503);
  }

  const ifNoneMatch = request.headers.get("if-none-match") ?? undefined;
  const result = await get(key, { access, token, ifNoneMatch });
  if (!result) return notFound();

  const headers: Record<string, string> = {
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    // Opened directly as a document, it can't run anything.
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
  };
  if (result.blob.etag) headers.ETag = result.blob.etag;
  if (result.statusCode === 304) return new Response(null, { status: 304, headers });

  const type = (result.blob.contentType || "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    await result.stream.cancel().catch(() => {});
    return notFound();
  }
  headers["Content-Type"] = type;
  if (result.blob.size != null) headers["Content-Length"] = String(result.blob.size);
  headers["Content-Disposition"] = `inline; filename="maple-${entryId}-${index + 1}${size === "thumb" ? "-thumb" : ""}.${type.split("/")[1].replace("jpeg", "jpg")}"`;
  return new Response(result.stream, { status: 200, headers });
}, { photos: true });

class PhotoStorageUnavailable extends Error {}

function notFound(message = "Photo not found"): never {
  throw new NotFound(message);
}

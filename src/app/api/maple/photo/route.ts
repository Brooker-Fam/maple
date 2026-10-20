import { NextRequest } from "next/server";
import { get } from "@vercel/blob";
import { BadRequest, idParam, withMember } from "@/lib/maple/api";
import { blobToken } from "@/lib/maple/blob";
import { getEntry, NotFound } from "@/lib/maple/store";
import { MAPLE_BLOB_RE } from "@/lib/maple/validate";

export const dynamic = "force-dynamic";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * GET /api/maple/photo?entry=<id>&i=<index>&size=thumb|full
 *
 * The only way a moment's photo reaches a browser. Checks the family session
 * here (not in middleware), looks the blob up by position on the entry, and
 * streams it back. Never redirects to the blob URL, which stays server-side.
 *
 * Caching: `private, max-age=1y, immutable` + ETag. What a URL points at can't
 * change: blob paths are random and never overwritten, entry ids are never
 * reused, and a moment's photos are fixed once it's saved (updateEntry ignores
 * `photos`). `private` keeps it out of any shared/CDN cache, so the scrapbook
 * opens instantly on hospital wifi without an auth + Blob round trip per
 * thumbnail. Trade-off: a photo already viewed on a device stays in that
 * browser's cache after sign-out (see the signout note in the report). If
 * photos ever become removable from a moment, switch this to `private,
 * no-cache` (the ETag/304 path below already handles revalidation).
 */
export const GET = withMember("GET /api/maple/photo", async (request: NextRequest) => {
  const sp = new URL(request.url).searchParams;
  const entryId = idParam(request, "entry");
  const index = Number(sp.get("i") ?? "0");
  if (!Number.isInteger(index) || index < 0 || index > 50) throw new BadRequest("i must be a photo index");
  const size = sp.get("size") ?? "thumb";
  if (size !== "thumb" && size !== "full") throw new BadRequest("size must be thumb or full");

  const entry = await getEntry(entryId);
  if (!entry || entry.kind !== "moment") return notFound();
  const ref = entry.data.photos?.[index];
  // Thumbs are best-effort at upload time; fall back to the full image.
  const key = size === "thumb" ? ref?.thumb_key || ref?.key : ref?.key;
  if (!ref || !key || !MAPLE_BLOB_RE.test(key)) return notFound();

  const access = ref.access ?? (key.includes(".private.blob.") ? "private" : "public");
  const token = blobToken(access);
  if (!token) return notFound("Photo storage isn't set up");

  const ifNoneMatch = request.headers.get("if-none-match") ?? undefined;
  const result = await get(key, { access, token, ifNoneMatch });
  if (!result) return notFound();

  const headers: Record<string, string> = {
    "Cache-Control": "private, max-age=31536000, immutable",
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
});

function notFound(message = "Photo not found"): never {
  throw new NotFound(message);
}

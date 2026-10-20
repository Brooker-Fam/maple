/**
 * Where Maple's photos live in Vercel Blob.
 *
 * Preferred: a PRIVATE store whose read-write token is MAPLE_BLOB_READ_WRITE_TOKEN.
 * A store's access mode is fixed when it's created, so this has to be a second
 * store next to the public one the guest gallery (/photos) uses.
 *
 * Fallback (no private token yet): the existing public store via
 * BLOB_READ_WRITE_TOKEN, with random-suffixed paths. Those blobs are still only
 * ever served through the authenticated proxy (/api/maple/photo); their URLs
 * never leave the server. Each PhotoRef records its `access`, so photos keep
 * loading from the right store after the private one is added.
 *
 * Every Maple blob call passes `token` explicitly so the second store can't
 * leak into the guest gallery's calls (or the other way round).
 *
 * The constants are safe to import from the browser; the functions read
 * server-only env vars and return null there.
 */

export type BlobAccess = "public" | "private";

/** JPEG/PNG/WebP only: never SVG (stored XSS) or HEIC (re-encoded on the phone). */
export const MAPLE_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAPLE_PHOTO_MAX_BYTES = 15 * 1024 * 1024;

/** Upload pathnames the token route will sign (before the random suffix). */
export const MAPLE_UPLOAD_PATH_RE = /^maple\/(moments|thumbs)\/[A-Za-z0-9_-]{8,64}\.(jpe?g|png|webp)$/;

/** The token for one store, or undefined when that store isn't configured. */
export function blobToken(access: BlobAccess): string | undefined {
  const raw = access === "private" ? process.env.MAPLE_BLOB_READ_WRITE_TOKEN : process.env.BLOB_READ_WRITE_TOKEN;
  return raw?.trim() || undefined;
}

/** The store new Maple uploads go to, or null when no Blob store is configured. */
export function uploadStore(): { access: BlobAccess; token: string } | null {
  const priv = blobToken("private");
  if (priv) return { access: "private", token: priv };
  const pub = blobToken("public");
  if (pub) return { access: "public", token: pub };
  return null;
}

import { upload } from "@vercel/blob/client";
import { MAPLE_PHOTO_MAX_BYTES, MAPLE_PHOTO_TYPES, type BlobAccess } from "./blob";
import type { PhotoRef } from "./types";

/**
 * Browser-side photo pipeline for Maple's moments, modeled on the guest
 * gallery (/photos): decode once on the phone (EXIF orientation applied),
 * re-encode a JPEG for keeping plus a small thumbnail for the scrapbook grid,
 * then upload both straight to Vercel Blob with a token from /api/maple/upload.
 *
 * Re-encoding also drops EXIF (GPS included) and turns iPhone HEIC into JPEG
 * where the browser can read it, since the store only accepts JPEG/PNG/WebP.
 *
 * The blob URLs that come back go to the server once, inside
 * POST /api/maple/entries data.photos, and are never shown to anyone.
 */

const FULL_DIM = 2560;
const FULL_QUALITY = 0.85;
const THUMB_DIM = 512;
const THUMB_QUALITY = 0.75;

/** A readable reason a photo couldn't be added (shown as-is). */
export class PhotoError extends Error {}

export type EncodedPhoto = {
  full: Blob;
  /** Null when the browser couldn't decode it and the original went up as-is. */
  thumb: Blob | null;
  contentType: (typeof MAPLE_PHOTO_TYPES)[number];
  w?: number;
  h?: number;
  /** When the camera says it was taken (EXIF), as local wall-clock parts. */
  takenAt?: { year: number; month: number; day: number; hour: number; minute: number };
};

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

const isHeic = (f: File) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

async function decode(file: File): Promise<Decoded | null> {
  // Fast path: honors EXIF orientation explicitly.
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  } catch {
    // Older Safari can't take options (or HEIC) here; an <img> can, and
    // browsers apply EXIF orientation to images and drawImage by default.
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("empty image");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

async function render(
  src: CanvasImageSource,
  width: number,
  height: number,
  maxDim: number,
  quality: number
): Promise<{ blob: Blob; w: number; h: number }> {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PhotoError("This browser can't prepare photos");
  // Transparent PNGs would turn black as JPEG.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  // Free the canvas backing store right away (iOS caps total canvas memory).
  canvas.width = canvas.height = 0;
  if (!blob) throw new PhotoError("Couldn't prepare that photo");
  return { blob, w, h };
}

/**
 * One decode → a ~2560px JPEG to keep and a 512px thumbnail. If the browser
 * can't decode the file (HEIC on desktop Chrome, a corrupt file), an original
 * JPEG/PNG/WebP goes up as-is without a thumb; anything else gets a friendly
 * explanation instead.
 */
export async function encodeForUpload(file: File): Promise<EncodedPhoto> {
  if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) throw new PhotoError("SVG drawings can't be added, only photos");
  if (!file.type.startsWith("image/") && !isHeic(file) && file.type !== "") throw new PhotoError("That isn't a photo");

  const takenAt = await readExifTakenAt(file).catch(() => undefined);
  const decoded = await decode(file);
  if (!decoded) {
    if ((MAPLE_PHOTO_TYPES as readonly string[]).includes(file.type) && file.size <= MAPLE_PHOTO_MAX_BYTES) {
      return { full: file, thumb: null, contentType: file.type as EncodedPhoto["contentType"], takenAt };
    }
    if (isHeic(file)) {
      throw new PhotoError("This browser can't open HEIC photos. Add it from your phone, or save it as a JPEG first.");
    }
    throw new PhotoError("Couldn't open that photo");
  }

  try {
    const full = await render(decoded.source, decoded.width, decoded.height, FULL_DIM, FULL_QUALITY);
    let fullBlob = full.blob;
    if (fullBlob.size > MAPLE_PHOTO_MAX_BYTES) {
      fullBlob = (await render(decoded.source, decoded.width, decoded.height, FULL_DIM, 0.7)).blob;
    }
    // Downscale the thumb from the full render: smoother than one big jump.
    const thumb = await renderFromBlob(fullBlob, full.w, full.h).catch(() => null);
    return { full: fullBlob, thumb, contentType: "image/jpeg", w: full.w, h: full.h, takenAt };
  } finally {
    decoded.release();
  }
}

async function renderFromBlob(blob: Blob, w: number, h: number): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    return (await render(bitmap, w, h, THUMB_DIM, THUMB_QUALITY)).blob;
  } finally {
    bitmap.close();
  }
}

// ── EXIF "taken at" (JPEG only; best effort) ─────────────────────────────

/** DateTimeOriginal from a JPEG's EXIF, as wall-clock parts (no zone). */
async function readExifTakenAt(file: File): Promise<EncodedPhoto["takenAt"]> {
  if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return undefined;
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return undefined;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    if ((marker & 0xff00) !== 0xff00 || len < 2) return undefined;
    off += 2 + len;
  }
  return undefined;
}

function parseTiff(v: DataView, tiff: number): EncodedPhoto["takenAt"] {
  const little = v.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => v.getUint16(tiff + o, little);
  const u32 = (o: number) => v.getUint32(tiff + o, little);
  const findTag = (ifd: number, tag: number): number | null => {
    if (tiff + ifd + 2 > v.byteLength) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (tiff + e + 12 > v.byteLength) return null;
      if (u16(e) === tag) return e;
    }
    return null;
  };
  const exifPtr = findTag(u32(4), 0x8769);
  if (exifPtr == null) return undefined;
  const dto = findTag(u32(exifPtr + 8), 0x9003);
  if (dto == null) return undefined;
  const at = u32(dto + 8);
  if (tiff + at + 19 > v.byteLength) return undefined;
  let s = "";
  for (let i = 0; i < 19; i++) s += String.fromCharCode(v.getUint8(tiff + at + i));
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(s);
  if (!m || m[1] === "0000") return undefined;
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
}

// ── upload ───────────────────────────────────────────────────────────────

export type UploadMode = { ready: boolean; access: BlobAccess | null; maxBytes: number };

let modePromise: Promise<UploadMode> | null = null;

/** Which store uploads go to (asked once per page load; see /api/maple/upload). */
export function getUploadMode(fresh = false): Promise<UploadMode> {
  if (!modePromise || fresh) {
    modePromise = fetch("/api/maple/upload", { cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Partial<UploadMode> & { error?: string };
        if (!res.ok) throw new PhotoError(body.error || "Couldn't reach photo storage");
        return { ready: !!body.ready, access: body.access ?? null, maxBytes: body.maxBytes ?? MAPLE_PHOTO_MAX_BYTES };
      })
      .catch((e) => {
        modePromise = null;
        throw e;
      });
  }
  return modePromise;
}

function randomName(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NO_RETRY = /content type|too large|aborted|access denied|suspended|store does not exist/i;

/** Retries flaky-signal failures (3 tries, backing off); gives up at once on bad files or aborts. */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, tries = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (signal?.aborted) throw new PhotoError("Upload canceled");
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? `${e.name} ${e.message}` : "";
      if (signal?.aborted || NO_RETRY.test(msg)) break;
      if (attempt < tries - 1) await sleep(800 * 2.5 ** attempt);
    }
  }
  if (signal?.aborted) throw new PhotoError("Upload canceled");
  const msg = last instanceof Error ? last.message : "";
  if (/too large|file size/i.test(msg)) throw new PhotoError("That photo is too big to upload");
  if (/content type/i.test(msg)) throw new PhotoError("Only JPEG, PNG or WebP photos can be added");
  if (/access denied/i.test(msg)) {
    modePromise = null; // the store changed under us; ask again next time
    throw new PhotoError("Photo storage changed. Close the sheet and try again.");
  }
  throw new PhotoError("Couldn't upload. Check the signal and try again.");
}

const EXT: Record<EncodedPhoto["contentType"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Upload one encoded photo (full, then its thumb) and return the PhotoRef to
 * save on the moment. The thumb is best-effort: the photo proxy falls back to
 * the full image without one.
 */
export async function uploadPhoto(
  photo: EncodedPhoto,
  opts: { signal?: AbortSignal; onProgress?: (pct: number) => void } = {}
): Promise<PhotoRef> {
  const mode = await getUploadMode();
  if (!mode.ready || !mode.access) throw new PhotoError("Photo storage isn't set up yet");
  const access = mode.access;
  const name = randomName();
  const common = {
    access,
    handleUploadUrl: "/api/maple/upload",
    clientPayload: JSON.stringify({ access }),
    abortSignal: opts.signal,
  } as const;

  const full = await withRetry(
    () =>
      upload(`maple/moments/${name}.${EXT[photo.contentType]}`, photo.full, {
        ...common,
        contentType: photo.contentType,
        onUploadProgress: (e) => opts.onProgress?.(Math.min(92, Math.round(e.percentage * 0.92))),
      }),
    opts.signal
  );

  let thumbUrl: string | undefined;
  if (photo.thumb) {
    try {
      const t = await withRetry(
        () => upload(`maple/thumbs/${name}.jpg`, photo.thumb!, { ...common, contentType: "image/jpeg" }),
        opts.signal,
        2
      );
      thumbUrl = t.url;
    } catch {
      // Grid falls back to the full image.
    }
  }
  opts.onProgress?.(100);
  return { key: full.url, thumb_key: thumbUrl, w: photo.w, h: photo.h, access };
}

/**
 * Convenience for callers without per-photo UI: encode and upload every file,
 * returning PhotoRefs for POST /api/maple/entries { kind: "moment", data: { photos } }.
 */
export async function uploadMoment(
  files: File[],
  opts: { signal?: AbortSignal; onProgress?: (index: number, pct: number) => void } = {}
): Promise<PhotoRef[]> {
  const refs: PhotoRef[] = [];
  for (let i = 0; i < files.length; i++) {
    const encoded = await encodeForUpload(files[i]);
    refs.push(await uploadPhoto(encoded, { signal: opts.signal, onProgress: (p) => opts.onProgress?.(i, p) }));
  }
  return refs;
}

/** Tidy up photos uploaded for a moment that was never saved (best effort). */
export function discardUploads(refs: PhotoRef[]): void {
  const urls = refs.flatMap((r) => [r.key, r.thumb_key]).filter((u): u is string => !!u);
  if (!urls.length) return;
  void fetch("/api/maple/upload", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
    keepalive: true,
  }).catch(() => {});
}

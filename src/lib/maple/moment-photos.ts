import { createHash } from "node:crypto";
import { transaction, type Statement } from "@/lib/db";
import { blobBelongsTo } from "./blob";
import type { PhotoRef } from "./types";
import { FAMILY_UPLOAD_LIMITS } from "./upload-quota";
import { cleanData } from "./validate";

export function momentPhotoId(photo: PhotoRef): string | undefined {
  return photo.key ? createHash("sha256").update(photo.key).digest("hex").slice(0, 32) : undefined;
}

export function clientMomentPhoto(photo: PhotoRef): PhotoRef {
  return { id: momentPhotoId(photo), w: photo.w, h: photo.h };
}

export function prepareMomentPhotos(familyId: number, input: unknown, previous: PhotoRef[] = []): PhotoRef[] {
  if (!Array.isArray(input) || input.length > 12) throw new Error("Choose up to 12 photos for a moment");
  const existing = new Map(previous.map(photo => [momentPhotoId(photo), photo]));
  const keys = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Choose a valid photo");
    let photo: PhotoRef;
    if ("id" in raw) {
      const kept = typeof raw.id === "string" ? existing.get(raw.id) : undefined;
      if (!kept || raw.key !== undefined || raw.thumb_key !== undefined) throw new Error("That photo is no longer on this moment. Refresh and try again.");
      photo = kept;
    } else {
      photo = cleanData("moment", { photos: [raw] }).photos![0];
      if (photo.access === "public" || !photo.key?.includes(".private.blob.")) throw new Error("New photos must use Maple's private storage");
    }
    if (!photo.key || !blobBelongsTo(photo.key, familyId) || (photo.thumb_key !== undefined && !blobBelongsTo(photo.thumb_key, familyId))) {
      throw new Error("photo must be a Maple upload");
    }
    if (keys.has(photo.key)) throw new Error("Choose each photo only once");
    keys.add(photo.key);
    return photo;
  });
}

export async function writeMomentPhotos(statement: Statement, familyId: number, count: number, entryId = 0, previousCount = 0) {
  const base = statement.params?.length ?? 0;
  const params = [...(statement.params ?? []), familyId, count, entryId, previousCount, FAMILY_UPLOAD_LIMITS.photos];
  const permission = (offset: number) => {
    const [family, next, entry, previous, limit] = Array.from({ length: 5 }, (_, index) => `$${offset + index + 1}`);
    return `SELECT ${family}::bigint = 1 OR ${next}::integer <= ${previous}::integer OR
      COALESCE(SUM(jsonb_array_length(CASE WHEN jsonb_typeof(data->'photos') = 'array' THEN data->'photos' ELSE '[]'::jsonb END)), 0) + ${next}::integer <= ${limit}::integer AS allowed
      FROM maple_entries WHERE family_id = ${family}::bigint AND kind = 'moment' AND id <> ${entry}::integer`;
  };
  const result = await transaction([
    { sql: "SELECT pg_advisory_xact_lock(72620262)" },
    { sql: permission(0), params: params.slice(base) },
    { sql: `WITH photo_permission AS (${permission(base)}) ${statement.sql}`, params },
  ]);
  return result ? { allowed: result[1][0]?.allowed === true, rows: result[2] } : null;
}

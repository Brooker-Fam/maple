import { CONTACT_EMAIL } from "@/components/site/legal";
import { query } from "@/lib/db";
import { MAPLE_PHOTO_MAX_BYTES } from "./blob";
import { FAMILY_ONE } from "./family";

/**
 * Every family but the Brookers has a photo quota, checked each time an
 * upload is signed (a photo and its thumbnail are one token each). The bytes
 * are bounded by the tokens: no upload can be bigger than
 * MAPLE_PHOTO_MAX_BYTES, so lifetime tokens times that is the most Blob can
 * hold for a family.
 */
export const FAMILY_UPLOAD_LIMITS = {
  tokensPerDay: 120,
  tokensTotal: 2700,
  photos: 1500,
} as const;

export const FAMILY_UPLOAD_MAX_BYTES = BigInt(FAMILY_UPLOAD_LIMITS.tokensTotal) * BigInt(MAPLE_PHOTO_MAX_BYTES);

export const QUOTA_MESSAGE = `That's as many photos as this log can take for now. Write to ${CONTACT_EMAIL} if you need more room.`;

const CLAIM = `
WITH used AS (
  SELECT COALESCE(SUM(tokens), 0) AS total, COALESCE(SUM(tokens) FILTER (WHERE day = CURRENT_DATE), 0) AS today
  FROM maple_upload_counts WHERE family_id = $1
), photos AS (
  SELECT COALESCE(SUM(jsonb_array_length(CASE WHEN jsonb_typeof(data->'photos') = 'array' THEN data->'photos' ELSE '[]'::jsonb END)), 0) AS n
  FROM maple_entries WHERE family_id = $1 AND kind = 'moment'
)
INSERT INTO maple_upload_counts (family_id, day, tokens)
SELECT $1, CURRENT_DATE, 1 FROM used, photos
WHERE used.total < $2 AND used.today < $3 AND photos.n < $4
ON CONFLICT (family_id, day) DO UPDATE SET tokens = maple_upload_counts.tokens + 1
RETURNING tokens`;

/** True when this family may sign one more upload (and counts it). Family 1 always may; anyone else fails closed. */
export async function claimUpload(familyId: number): Promise<boolean> {
  if (familyId === FAMILY_ONE) return true;
  try {
    const rows = await query(CLAIM, [familyId, FAMILY_UPLOAD_LIMITS.tokensTotal, FAMILY_UPLOAD_LIMITS.tokensPerDay, FAMILY_UPLOAD_LIMITS.photos]);
    return !!rows?.length;
  } catch {
    return false;
  }
}

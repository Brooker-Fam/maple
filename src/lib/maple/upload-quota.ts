import { CONTACT_EMAIL } from "@/components/site/legal";
import { transaction } from "@/lib/db";
import { MAPLE_PHOTO_MAX_BYTES } from "./blob";
import { FAMILY_ONE } from "./family";

export const FAMILY_UPLOAD_LIMITS = {
  tokensPerDay: 120,
  tokensTotal: 2700,
  photos: 1500,
} as const;

export const FAMILY_UPLOAD_MAX_BYTES = BigInt(FAMILY_UPLOAD_LIMITS.tokensTotal) * BigInt(MAPLE_PHOTO_MAX_BYTES);

export const QUOTA_MESSAGE = `That's as many photos as this log can take for now. Write to ${CONTACT_EMAIL} if you need more room.`;

const UPLOAD_LOCK = 72_620_262;

const CLAIM = `
WITH used AS (
  SELECT COALESCE(SUM(tokens), 0) AS total, COALESCE(SUM(tokens) FILTER (WHERE day = CURRENT_DATE), 0) AS today
  FROM maple_upload_counts WHERE family_id <> ${FAMILY_ONE}
), photos AS (
  SELECT COALESCE(SUM(jsonb_array_length(CASE WHEN jsonb_typeof(data->'photos') = 'array' THEN data->'photos' ELSE '[]'::jsonb END)), 0) AS n
  FROM maple_entries WHERE family_id = $1 AND kind = 'moment'
)
INSERT INTO maple_upload_counts (family_id, day, tokens)
SELECT $1, CURRENT_DATE, 1 FROM used, photos
WHERE used.total < $2 AND used.today < $3 AND photos.n < $4
ON CONFLICT (family_id, day) DO UPDATE SET tokens = maple_upload_counts.tokens + 1
RETURNING tokens`;

export class UploadQuotaUnavailable extends Error {
  constructor(cause?: unknown) {
    super("Photo upload quota is unavailable", { cause });
  }
}
export async function claimUpload(familyId: number): Promise<boolean> {
  if (familyId === FAMILY_ONE) return true;
  try {
    const result = await transaction([
      { sql: `SELECT pg_advisory_xact_lock(${UPLOAD_LOCK})` },
      { sql: CLAIM, params: [familyId, FAMILY_UPLOAD_LIMITS.tokensTotal, FAMILY_UPLOAD_LIMITS.tokensPerDay, FAMILY_UPLOAD_LIMITS.photos] },
    ]);
    if (result === null) throw new UploadQuotaUnavailable();
    return !!result[1]?.length;
  } catch (error) {
    throw error instanceof UploadQuotaUnavailable ? error : new UploadQuotaUnavailable(error);
  }
}

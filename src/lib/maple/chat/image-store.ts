import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { query } from "@/lib/db";
import type { FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import type { Member } from "../types";
import { CHAT_IMAGE_ACCEPT, CHAT_IMAGE_ID_RE, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_DIMENSION, CHAT_IMAGE_SOURCE_MAX_BYTES, CHAT_MAX_IMAGES, parseChatImage, type ChatImage } from "./images";
import type { ChatMessage } from "./types";

type Fam = Pick<FamilyScope, "familyId">;
type ImageMember = Pick<Member, "email" | "role">;
const MAX_BODY_BYTES = CHAT_IMAGE_SOURCE_MAX_BYTES + 64 * 1024;
const MAX_DAILY_UPLOADS = 40;
const MAX_FAMILY_DAILY_UPLOADS = 100;
const IMAGE_PREFIX = "/api/maple/chat/images?id=";
const REFERENCED = `EXISTS (SELECT 1 FROM maple_chat_messages m WHERE m.family_id = i.family_id AND m.member = i.member AND m.role = 'user' AND m.parts @> jsonb_build_array(jsonb_build_object('type', 'file', 'url', '${IMAGE_PREFIX}' || i.id)))`;
const AVAILABLE = `(i.created_at > NOW() - INTERVAL '7 days' OR ${REFERENCED})`;

export class ChatImageError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: "limit") {
    super(message);
    this.name = "ChatImageError";
  }
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await query(sql, params);
  if (result === null) throw new StoreUnavailable();
  return result as Record<string, unknown>[];
}

export async function readChatImageUpload(request: Request): Promise<{ bytes: Buffer; mediaType: string }> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;") || !request.body) throw new ChatImageError("Choose a photo to upload.");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new ChatImageError("Choose a photo smaller than 4 MB.", 413);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ChatImageError("Choose a photo smaller than 4 MB.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), { headers: { "content-type": type } }).formData();
  } catch {
    throw new ChatImageError("The photo could not be read. Choose it again.");
  }
  const file = form.get("file");
  if (Array.from(form.keys()).length !== 1 || !file || typeof file === "string") throw new ChatImageError("Choose one photo at a time.");
  if (!CHAT_IMAGE_ACCEPT.split(",").includes(file.type)) throw new ChatImageError("Choose a JPEG, PNG or WebP photo.", 415);
  if (!file.size || file.size > CHAT_IMAGE_SOURCE_MAX_BYTES) throw new ChatImageError("Choose a photo smaller than 4 MB.", 413);
  return { bytes: Buffer.from(await file.arrayBuffer()), mediaType: file.type };
}

export async function normalizeChatImage(bytes: Uint8Array, mediaType: string): Promise<Buffer> {
  if (!bytes.byteLength || bytes.byteLength > CHAT_IMAGE_SOURCE_MAX_BYTES) throw new ChatImageError("Choose a photo smaller than 4 MB.", 413);
  if (!CHAT_IMAGE_ACCEPT.split(",").includes(mediaType)) throw new ChatImageError("Choose a JPEG, PNG or WebP photo.", 415);
  try {
    const input = sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error" });
    const metadata = await input.metadata();
    if (`image/${metadata.format}` !== mediaType || (metadata.pages ?? 1) !== 1) throw new ChatImageError("Choose a still JPEG, PNG or WebP photo.", 415);
    for (const quality of [82, 66, 48]) {
      const output = await input.clone().rotate().resize(CHAT_IMAGE_MAX_DIMENSION, CHAT_IMAGE_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (output.byteLength <= CHAT_IMAGE_MAX_BYTES) return output;
    }
    const output = await input.clone().rotate().resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 48, mozjpeg: true }).toBuffer();
    if (output.byteLength <= CHAT_IMAGE_MAX_BYTES) return output;
    throw new ChatImageError("This photo is too detailed to upload. Crop it and try again.", 413);
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError("The photo could not be read. Choose a different JPEG, PNG or WebP photo.", 415);
  }
}

async function claimUpload(fam: Fam, member: ImageMember): Promise<string> {
  const [epoch] = await rows(`INSERT INTO maple_chat_image_generations (family_id, member) VALUES ($1, $2)
    ON CONFLICT (family_id, member) DO UPDATE SET generation = maple_chat_image_generations.generation
    RETURNING generation`, [fam.familyId, member.email]);
  for (const [key, limit] of [[member.email, MAX_DAILY_UPLOADS], ["", MAX_FAMILY_DAILY_UPLOADS]] as const) {
    const claimed = await rows(`INSERT INTO maple_chat_image_uploads (family_id, member, day, uploads)
      VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, 1)
      ON CONFLICT (family_id, member, day) DO UPDATE SET uploads = maple_chat_image_uploads.uploads + 1
      WHERE maple_chat_image_uploads.uploads < $3 RETURNING uploads`, [fam.familyId, key, limit]);
    if (!claimed.length) throw new ChatImageError("The photo upload limit has been reached for today. Try again tomorrow.", 429, "limit");
  }
  return String(epoch.generation);
}

export async function uploadChatImage(fam: Fam, member: ImageMember, bytes: Uint8Array, mediaType: string): Promise<ChatImage> {
  const generation = await claimUpload(fam, member);
  return saveChatImage(fam, member, bytes, mediaType, generation);
}

export async function receiveChatImage(fam: Fam, member: ImageMember, request: Request): Promise<ChatImage> {
  const generation = await claimUpload(fam, member);
  const { bytes, mediaType } = await readChatImageUpload(request);
  return saveChatImage(fam, member, bytes, mediaType, generation);
}

async function saveChatImage(fam: Fam, member: ImageMember, bytes: Uint8Array, mediaType: string, generation: string): Promise<ChatImage> {
  const normalized = await normalizeChatImage(bytes, mediaType);
  await pruneDraftChatImages();
  const id = randomUUID();
  const saved = await rows(`WITH locked AS (
    UPDATE maple_chat_image_generations SET generation = generation WHERE family_id = $2 AND member = $3 AND generation = $7 RETURNING family_id
  ) INSERT INTO maple_chat_images (id, family_id, member, viewer_only, data_base64, byte_length)
    SELECT $1, $2, $3, $4, $5, $6 FROM locked RETURNING id`, [id, fam.familyId, member.email, member.role === "viewer", normalized.toString("base64"), normalized.byteLength, generation]);
  if (!saved.length) throw new ChatImageError("The chat was deleted while this photo uploaded. Choose the photo again.", 409);
  return { type: "file", mediaType: "image/jpeg", url: `${IMAGE_PREFIX}${id}` };
}

export async function pruneDraftChatImages(): Promise<void> {
  await rows(`DELETE FROM maple_chat_images WHERE id IN (
    SELECT i.id FROM maple_chat_images i WHERE i.created_at <= NOW() - INTERVAL '7 days'
    AND (i.reserved_until IS NULL OR i.reserved_until <= NOW()) AND NOT ${REFERENCED}
    ORDER BY i.created_at LIMIT 100
  )`);
  await rows(`DELETE FROM maple_chat_image_uploads WHERE day < (NOW() AT TIME ZONE 'UTC')::date - 7`);
}

function imageIds(images: readonly ChatImage[]): string[] {
  return images.map((image) => {
    const parsed = parseChatImage(image);
    if (!parsed) throw new ChatImageError("This photo is unavailable. Choose it again.");
    return parsed.url.slice(IMAGE_PREFIX.length);
  });
}

async function availableImages(fam: Fam, member: ImageMember, ids: string[], data = false): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const found = await rows(`SELECT i.id${data ? ", i.data_base64" : ""} FROM maple_chat_images i
    WHERE i.family_id = $1 AND i.member = $2 AND (i.viewer_only OR NOT $3)
    AND i.id = ANY($4::text[]) AND ${AVAILABLE}`, [fam.familyId, member.email, member.role === "viewer", ids]);
  if (found.length !== new Set(ids).size) throw new ChatImageError("This photo is unavailable. Choose it again.", 404);
  return found;
}

export async function readChatImage(fam: Fam, member: ImageMember, id: string): Promise<Buffer> {
  if (!CHAT_IMAGE_ID_RE.test(id)) throw new ChatImageError("Photo not found.", 404);
  const [row] = await availableImages(fam, member, [id], true);
  return Buffer.from(String(row.data_base64), "base64");
}

export async function validateChatImages(fam: Fam, member: ImageMember, images: readonly ChatImage[]): Promise<void> {
  if (images.length > CHAT_MAX_IMAGES) throw new ChatImageError(`Attach up to ${CHAT_MAX_IMAGES} photos to one message.`);
  const ids = imageIds(images);
  if (!ids.length) return;
  const found = await rows(`UPDATE maple_chat_images i SET reserved_until = NOW() + INTERVAL '2 minutes'
    WHERE i.family_id = $1 AND i.member = $2 AND (i.viewer_only OR NOT $3)
    AND i.id = ANY($4::text[]) AND ${AVAILABLE} RETURNING i.id`, [fam.familyId, member.email, member.role === "viewer", ids]);
  if (found.length !== new Set(ids).size) throw new ChatImageError("This photo is unavailable. Choose it again.", 404);
}

export async function resolveChatImages(fam: Fam, member: ImageMember, messages: ChatMessage[]): Promise<ChatMessage[]> {
  const images = messages.flatMap((message) => {
    const parts = message.parts.filter((part) => part.type === "file");
    if (parts.length > CHAT_MAX_IMAGES) throw new ChatImageError(`Attach up to ${CHAT_MAX_IMAGES} photos to one message.`);
    return parts.map((part) => {
      const parsed = parseChatImage(part);
      if (!parsed || message.role !== "user") throw new ChatImageError("This photo is unavailable. Choose it again.");
      return parsed;
    });
  });
  const ids = imageIds(images);
  await availableImages(fam, member, ids);
  const selected = ids.slice(-CHAT_MAX_IMAGES);
  const loaded = await availableImages(fam, member, selected, true);
  const data = new Map(loaded.map((row) => [String(row.id), `data:image/jpeg;base64,${row.data_base64}`]));
  let imageNumber = 0;
  return messages.map((message) => ({ ...message, parts: message.parts.map((part) => {
    if (part.type !== "file") return part;
    const index = imageNumber++;
    if (index < ids.length - CHAT_MAX_IMAGES) return { type: "text" as const, text: "[An earlier photo is omitted from this turn. Ask the person to attach it again if needed.]" };
    return { ...part, url: data.get(ids[index])! };
  }) }));
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { encryptionKey } from "./config";
import type { FamilyCtx } from "../family";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
type Binding = Pick<FamilyCtx, "familyId" | "member">;
const aad = (ctx: Binding) => Buffer.from(JSON.stringify(["maple-epic-v1", ctx.familyId, ctx.member]));

export function seal(ctx: Binding, value: unknown): string {
  const key = encryptionKey();
  if (!key) throw new Error("epic_unconfigured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(ctx));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(ctx: Binding, value: string): T | null {
  try {
    const key = encryptionKey();
    if (!key || value.length > 2_000_000) return null;
    const buffer = Buffer.from(value, "base64url");
    if (buffer.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString("utf8")) as T;
  } catch { return null; }
}

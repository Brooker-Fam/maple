import { createHash, timingSafeEqual } from "node:crypto";

export function authorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

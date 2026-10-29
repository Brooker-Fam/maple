import type { PhotoRef } from "@/lib/maple/types";

export function photoUrl(entryId: number, index: number | string, size: "thumb" | "full" = "thumb") {
  const query = new URLSearchParams({ entry: String(entryId), size });
  if (typeof index === "string") query.set("photo", index);
  else query.set("i", String(index));
  return `/api/maple/photo?${query}`;
}

export function momentPhotoUrl(entryId: number, photo: PhotoRef, index: number, size: "thumb" | "full" = "thumb") {
  return photoUrl(entryId, photo.id ?? index, size);
}

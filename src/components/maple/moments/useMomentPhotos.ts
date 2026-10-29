"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { discardUploads, encodeForUpload, getUploadMode, PhotoError, uploadPhoto, type EncodedPhoto } from "@/lib/maple/image";
import type { EntryOf, PhotoRef } from "@/lib/maple/types";
import { momentPhotoUrl } from "./photo";

export const MAX_MOMENT_PHOTOS = 12;
export type PhotoItem = {
  id: string;
  file?: File;
  existing?: boolean;
  preview: string | null;
  status: "preparing" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  retryable?: boolean;
  encoded?: EncodedPhoto;
  ref?: PhotoRef;
  ctrl: AbortController;
};
type Storage = "checking" | "ready" | "off" | "error";
type AdoptTime = (taken: EncodedPhoto["takenAt"]) => void;
let nextId = 0;

function usePhotoStorage(open: boolean, readOnly: boolean, familyId?: number) {
  const [storage, setStorage] = useState<Storage>("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open || readOnly) return;
    let live = true;
    getUploadMode(attempt > 0, familyId)
      .then((mode) => { if (live) setStorage(mode.ready ? "ready" : "off"); })
      .catch(() => { if (live) setStorage("error"); });
    return () => { live = false; };
  }, [familyId, open, readOnly, attempt]);
  return { storage, retryStorage: () => { setStorage("checking"); setAttempt((value) => value + 1); } };
}

function tidyUploads(items: PhotoItem[], saved: boolean, discarded: Set<string>, retained: Set<string>) {
  if (saved) return;
  const refs: PhotoRef[] = [];
  for (const item of items) {
    if (item.existing || discarded.has(item.id)) continue;
    discarded.add(item.id);
    item.ctrl.abort();
    if (item.ref && !retained.has(item.id)) refs.push(item.ref);
  }
  discardUploads(refs);
}

function usePhotoCleanup(items: RefObject<PhotoItem[]>, saved: RefObject<boolean>, discarded: RefObject<Set<string>>, retained: RefObject<Set<string>>, open: boolean, uploading: boolean) {
  useEffect(() => { if (!open) tidyUploads(items.current, saved.current, discarded.current, retained.current); }, [items, saved, discarded, retained, open]);
  useEffect(() => () => {
    tidyUploads(items.current, saved.current, discarded.current, retained.current);
    for (const item of items.current) if (item.preview && !item.existing) URL.revokeObjectURL(item.preview);
  }, [items, saved, discarded, retained]);
  useEffect(() => {
    if (!uploading) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [uploading]);
}

async function processPhoto(item: PhotoItem, patch: (value: Partial<PhotoItem>) => void, adoptTime: AdoptTime, familyId?: number) {
  let encoded = item.encoded;
  if (!encoded) {
    try { encoded = await encodeForUpload(item.file!); }
    catch (error) {
      if (!item.ctrl.signal.aborted) patch({ status: "error", retryable: false, error: error instanceof PhotoError ? error.message : "Couldn't open that photo" });
      return;
    }
    const preview = URL.createObjectURL(encoded.thumb ?? encoded.full);
    if (item.ctrl.signal.aborted) { URL.revokeObjectURL(preview); return; }
    patch({ encoded, preview });
    adoptTime(encoded.takenAt);
  }
  try {
    patch({ status: "uploading", progress: 3, error: undefined });
    const ref = await uploadPhoto(encoded, { familyId, signal: item.ctrl.signal, onProgress: (progress) => patch({ progress: Math.max(3, progress) }) });
    if (item.ctrl.signal.aborted) { discardUploads([ref]); return; }
    patch({ status: "done", progress: 100, ref });
  } catch (error) {
    if (item.ctrl.signal.aborted) return;
    const message = error instanceof PhotoError ? error.message : "Couldn't upload that photo";
    patch({ status: "error", retryable: !/too big|only jpeg/i.test(message), error: message });
  }
}

export function useMomentPhotos({ moment, open, readOnly, familyId, toast, adoptPhotoTime }: {
  moment?: EntryOf<"moment">; open: boolean; readOnly: boolean; familyId?: number;
  toast: (text: string, options: { tone: "info" }) => void; adoptPhotoTime: AdoptTime;
}) {
  const [items, setItems] = useState<PhotoItem[]>(() => (moment?.data.photos ?? []).map((ref, index) => ({
    id: ref.id ?? `saved-${index}`, existing: true, preview: momentPhotoUrl(moment!.id, ref, index),
    status: "done", progress: 100, ref, ctrl: new AbortController(),
  })));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saved = useRef(false);
  const discarded = useRef(new Set<string>());
  const retained = useRef(new Set<string>());
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const storage = usePhotoStorage(open, readOnly, familyId);
  const uploading = items.some((item) => item.status === "preparing" || item.status === "uploading");
  usePhotoCleanup(itemsRef, saved, discarded, retained, open, uploading);
  const enqueue = (id: string) => {
    queue.current = queue.current.then(async () => {
      const item = itemsRef.current.find((value) => value.id === id);
      if (item && !item.ctrl.signal.aborted) await processPhoto(item, (patch) => setItems((list) => list.map((value) => value.id === id ? { ...value, ...patch } : value)), adoptPhotoTime, familyId);
    }).catch(() => {});
  };
  const addFiles = (files: FileList | null) => {
    const room = MAX_MOMENT_PHOTOS - itemsRef.current.length;
    const list = Array.from(files ?? []);
    if (list.length > room) toast(`Up to ${MAX_MOMENT_PHOTOS} photos per moment`, { tone: "info" });
    const fresh: PhotoItem[] = list.slice(0, Math.max(0, room)).map((file) => ({ id: `p${nextId++}`, file, preview: null, status: "preparing", progress: 0, ctrl: new AbortController() }));
    if (!fresh.length) return;
    itemsRef.current = [...itemsRef.current, ...fresh];
    setItems(itemsRef.current);
    fresh.forEach((item) => enqueue(item.id));
    if (cameraRef.current) cameraRef.current.value = "";
    if (libraryRef.current) libraryRef.current.value = "";
  };
  const removeItem = (id: string) => {
    const item = itemsRef.current.find((value) => value.id === id);
    if (!item) return;
    item.ctrl.abort();
    discarded.current.add(id);
    if (item.ref && !item.existing && !retained.current.has(item.id)) discardUploads([item.ref]);
    if (item.preview && !item.existing) URL.revokeObjectURL(item.preview);
    itemsRef.current = itemsRef.current.filter((value) => value.id !== id);
    setItems(itemsRef.current);
  };
  const retryItem = (id: string) => {
    itemsRef.current = itemsRef.current.map((item) => item.id === id ? { ...item, status: "preparing", progress: 0, error: undefined, ctrl: new AbortController() } : item);
    setItems(itemsRef.current);
    enqueue(id);
  };
  const done = items.filter((item) => item.status === "done" && item.ref && !item.ctrl.signal.aborted && !discarded.current.has(item.id));
  const failed = items.filter((item) => item.status === "error").length;
  return { items, done, failed, pending: items.length - done.length - failed, uploading, cameraRef, libraryRef, ...storage,
    addFiles, removeItem, retryItem, markSaved: (value: boolean) => { saved.current = value; },
    retainUploads: () => { for (const item of done) if (!item.existing) retained.current.add(item.id); },
  };
}

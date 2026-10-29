"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_MAX_IMAGES, parseChatImage, type ChatImage } from "@/lib/maple/chat/images";
import { deviceHeaders } from "@/lib/maple/device";
import { FAMILY_MOVED_EVENT, shownFamilyHeaders } from "../shownFamily";
import { useChatNav } from "./ChatNav";
import { prepareChatImage } from "./chatImageUpload";

export function useChatImageUpload({ scope, enabled, count, onUploaded }: { scope: string; enabled: boolean; count: number; onUploaded: (image: ChatImage, scope: string) => void }) {
  const { termsNeeded } = useChatNav();
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancel = () => {
      pending.current?.abort();
      pending.current = null;
      setUploading(false);
      setProblem(null);
    };
    window.addEventListener("maple:chat-drafts-cleared", cancel);
    return () => {
      pending.current?.abort();
      window.removeEventListener("maple:chat-drafts-cleared", cancel);
    };
  }, [scope]);
  useEffect(() => {
    if (!enabled) {
      if (pending.current) setProblem("Photo upload stopped. Add the photo again when connected and chat terms are accepted.");
      pending.current?.abort();
      pending.current = null;
      setUploading(false);
    }
  }, [enabled]);

  const upload = useCallback(async (files: File[]) => {
    if (!enabled || pending.current || !files.length) return;
    if (files.length + count > CHAT_MAX_IMAGES) {
      setProblem(`Attach up to ${CHAT_MAX_IMAGES} photos per message. Choose fewer photos.`);
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const headers = { ...deviceHeaders(), ...shownFamilyHeaders() };
    setUploading(true);
    setProblem(null);
    try {
      for (const file of files) {
        const photo = await prepareChatImage(file);
        if (controller.signal.aborted) return;
        const body = new FormData();
        body.set("file", photo, "chat-photo.jpg");
        const response = await fetch("/api/maple/chat/images", { method: "POST", headers, body, signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (controller.signal.aborted) return;
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Couldn't upload the photo. Try again.");
        if (!response.ok) {
          if (result.code === "terms") termsNeeded();
          if (result.code === "family_mismatch") window.dispatchEvent(new Event(FAMILY_MOVED_EVENT));
          throw new Error(typeof result.error === "string" ? result.error : "Couldn't upload the photo. Try again.");
        }
        const image = parseChatImage(result.image);
        if (!image) throw new Error("Couldn't attach that photo. Try again.");
        onUploaded(image, scope);
      }
    } catch (error) {
      if (!controller.signal.aborted) setProblem(error instanceof Error ? error.message : "Couldn't upload the photo. Try again.");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setUploading(false);
      }
    }
  }, [enabled, count, onUploaded, scope, termsNeeded]);

  return { upload, uploading, problem, clearProblem: () => setProblem(null) };
}

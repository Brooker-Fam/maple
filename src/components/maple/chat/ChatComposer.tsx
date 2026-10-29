"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CHAT_IMAGE_ACCEPT, CHAT_MAX_IMAGES } from "@/lib/maple/chat/images";
import { CHAT_MAX_CHARS } from "@/lib/maple/chat/types";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import ChatImages from "./ChatImages";
import type { useChatThread } from "./useChatThread";
import { useChatImageUpload } from "./useChatImageUpload";

export default function ChatComposer({ t, onSend, disabled, imagesAllowed, offline }: { t: ReturnType<typeof useChatThread>; onSend: (text: string) => void; disabled: boolean; imagesAllowed: boolean; offline: boolean }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [showPicker, setShowPicker] = useState(false);
  const images = t.draftImages ?? [];
  const upload = useChatImageUpload({ scope: t.scope, enabled: imagesAllowed && !disabled && !offline, count: images.length, onUploaded: t.addDraftImage });
  const imageProblem = upload.problem || t.imageProblem;
  const near = t.draft.length > CHAT_MAX_CHARS - 200;
  const queueing = t.busy || offline || t.queuePaused || t.awaitingAnswer || t.queue.length > 0;
  const hasContent = !!t.draft.trim() || images.length > 0;
  const canSend = !disabled && !upload.uploading && !imageProblem && t.queue.length < t.queueLimit && hasContent && t.draft.length <= CHAT_MAX_CHARS;
  const canAttach = imagesAllowed && !disabled && !offline && !upload.uploading && images.length < CHAT_MAX_IMAGES;

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const grow = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    };
    grow();
    let width = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      grow();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [t.draft]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || !window.matchMedia("(pointer: fine)").matches) return;
    e.preventDefault();
    if (canSend) onSend(t.draft);
  };
  const choose = (files: FileList | null) => {
    setShowPicker(false);
    void upload.upload(Array.from(files ?? []));
  };

  return (
    <div>
      {images.length > 0 && <div className="mb-2 pt-1"><ChatImages images={images} onRemove={t.removeDraftImage} compact /></div>}
      {upload.uploading && <p role="status" className={cx(tone.muted, "mb-2 text-[13px]")}>Uploading photo…</p>}
      {imageProblem && <div className="mb-2 flex items-center gap-2"><p role="status" className={cx(tone.muted, "min-w-0 flex-1 text-[13px] leading-snug")}>{imageProblem}</p><Button size="sm" variant="ghost" onClick={() => { upload.clearProblem(); t.clearImageProblem(); }}>Dismiss</Button></div>}
      <input ref={photos} type="file" accept={CHAT_IMAGE_ACCEPT} multiple hidden aria-label="Choose chat photos" onChange={(e) => { choose(e.target.files); e.target.value = ""; }} />
      <input ref={camera} type="file" accept={CHAT_IMAGE_ACCEPT} capture="environment" hidden aria-label="Take chat photo" onChange={(e) => { choose(e.target.files); e.target.value = ""; }} />
      {showPicker && <div className="mb-2 flex flex-wrap gap-2" aria-label="Add a photo">
        <Button variant="soft" size="sm" disabled={!canAttach} onClick={() => photos.current?.click()}><Icon name="image" size={17} /> Choose photos</Button>
        <Button variant="soft" size="sm" disabled={!canAttach} onClick={() => camera.current?.click()}><Icon name="camera" size={17} /> Take photo</Button>
      </div>}
      <div className="flex items-end gap-2">
        <button type="button" aria-label="Add photo" aria-expanded={showPicker} onClick={() => setShowPicker((open) => !open)} disabled={!canAttach} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-surface text-mp-accent-fg disabled:opacity-40"><Icon name="image-plus" size={22} /></button>
        <textarea ref={area} value={t.draft} rows={1} maxLength={CHAT_MAX_CHARS} onChange={(e) => { t.setDraft(e.target.value); if (t.problem) t.clearProblem(); }} onKeyDown={onKey}
          placeholder={offline ? "Message · saved until you're online" : images.length ? "Add a message (optional)" : "Message"} aria-label="Message" disabled={disabled}
          className={cx(tone.input, "min-h-[44px] min-w-0 flex-1 resize-none rounded-[22px] py-2.5 leading-snug disabled:opacity-60")} />
        <button type="button" onClick={() => onSend(t.draft)} disabled={!canSend} aria-label={queueing ? "Queue message" : "Send"} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent transition active:scale-95 disabled:opacity-40"><Icon name="arrow-up" size={22} strokeWidth={2.25} /></button>
      </div>
      {t.storageProblem && <p role="status" className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>This browser couldn&apos;t save your draft. Keep this page open until your messages send.</p>}
      {hasContent && queueing && <p className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>{offline ? "Queue it here, then resume when you're connected." : "Add this to the queue while Maple finishes."}</p>}
      {images.length > 0 && <p className={cx(tone.faint, "mt-1 text-[12px] leading-snug")}>Photos go to the AI when you send. Say if you want something logged.</p>}
      {near && <p className={cx(tone.faint, "mt-1 text-right text-[12px] tabular-nums")}>{t.draft.length.toLocaleString("en-US")} / {CHAT_MAX_CHARS.toLocaleString("en-US")}</p>}
    </div>
  );
}

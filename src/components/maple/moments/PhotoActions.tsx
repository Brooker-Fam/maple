"use client";

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";

type Prepared = { file: File; url: string; shareable: boolean };

function usePhotoFile(src: string, filename: string, attempt: number) {
  const [photo, setPhoto] = useState<Prepared | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setPhoto(null);
    setFailed(false);
    void fetch(src, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Photo unavailable");
        const blob = await response.blob();
        if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error("Photo unavailable");
        if (controller.signal.aborted) return;
        const extension = blob.type.split("/")[1].replace("jpeg", "jpg");
        const file = new File([blob], `${filename}.${extension}`, { type: blob.type });
        objectUrl = URL.createObjectURL(file);
        let shareable = false;
        try { shareable = !!navigator.share && !!navigator.canShare?.({ files: [file] }); } catch {}
        setPhoto({ file, url: objectUrl, shareable });
      }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, filename, attempt]);
  return { photo, failed };
}

export default function PhotoActions({ src, filename }: { src: string; filename: string }) {
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState("");
  const { photo, failed } = usePhotoFile(src, filename, attempt);
  const share = async () => {
    if (!photo || sharing) return;
    setSharing(true);
    setNotice("");
    try { await navigator.share({ files: [photo.file] }); }
    catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setNotice("Couldn't open sharing. Save the photo and share it from your device.");
    } finally { setSharing(false); }
  };
  return (
    <div className="shrink-0 border-t border-mp-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {failed ? <div role="alert" className="flex items-center justify-between gap-3">
        <p className={cx(tone.muted, "text-sm")}>Couldn&apos;t prepare this photo for sharing.</p>
        <Button variant="soft" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </div> : !photo ? <p role="status" className={cx(tone.muted, "py-3 text-center text-sm")}>Preparing photo…</p> : <>
        <div className="flex gap-3">
          {photo.shareable && <Button variant="soft" aria-label="Share photo" className="min-h-[48px] flex-1" disabled={sharing} onClick={() => void share()}><Icon name="share" size={19} />{sharing ? "Sharing…" : "Share"}</Button>}
          <a href={photo.url} aria-label="Save photo" download={photo.file.name} onClick={() => setNotice("Photo download started.")} className="flex min-h-[48px] flex-1 items-center justify-center gap-2 rounded-xl bg-mp-sunken px-4 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-mp-focus"><Icon name="download" size={19} />Save</a>
        </div>
        {!photo.shareable && <p className={cx(tone.faint, "mt-2 text-center text-xs")}>Save a copy to share from your device.</p>}
      </>}
      {notice && <p role="status" className={cx(tone.muted, "mt-2 text-center text-sm")}>{notice}</p>}
    </div>
  );
}

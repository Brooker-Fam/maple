"use client";

import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { Label } from "../sheets/parts";
import { MAX_MOMENT_PHOTOS, type PhotoItem, type useMomentPhotos } from "./useMomentPhotos";
const NIGHT_DIM = "[.maple-night_&]:brightness-[.55] [.maple-night_&]:saturate-[.8]";

export default function MomentPhotoPicker({ photos }: { photos: ReturnType<typeof useMomentPhotos> }) {
  const { items, storage, retryStorage, cameraRef, libraryRef, addFiles, removeItem, retryItem } = photos;
  return (
    <section aria-label="Photos" className="ph-no-capture">
      <Label>Photos</Label>
      {items.length > 0 && (
        <ul className="mb-3 grid grid-cols-3 gap-2">
          {items.map((it) => (
            <PhotoTile key={it.id} item={it} onRemove={() => removeItem(it.id)} onRetry={() => retryItem(it.id)} />
          ))}
        </ul>
      )}
      {items.some((it) => it.status === "error") && (
        <ul className="mb-3 space-y-1 text-[13px] leading-snug text-mp-danger" aria-live="polite">
          {items
            .filter((it) => it.status === "error")
            .map((it) => (
              <li key={it.id}>
                <span className="font-semibold">{shortName(it.file?.name ?? "Photo")}:</span> {it.error}
              </li>
            ))}
        </ul>
      )}
      {storage === "off" || storage === "error" ? (
        <div className={cx(tone.inset, tone.muted, "flex gap-2.5 px-4 py-3 text-sm leading-snug")}>
          <Icon name="cloud-off" size={18} className="mt-px shrink-0 text-mp-ink-3" />
          <div>
            <p>
              {storage === "off"
                ? "Photo uploads aren't available right now. You can still save your other changes."
                : "Couldn't reach photo storage. Your photos and words are still here."}
            </p>
            {storage === "error" && (
              <Button variant="soft" size="sm" className="mt-2" onClick={retryStorage}>
                Retry photo storage
              </Button>
            )}
          </div>
        </div>
      ) : (
        items.length < MAX_MOMENT_PHOTOS && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="soft" size="lg" disabled={storage !== "ready"} onClick={() => cameraRef.current?.click()}>
              <Icon name="camera" size={20} />
              Take a photo
            </Button>
            <Button variant="soft" size="lg" disabled={storage !== "ready"} onClick={() => libraryRef.current?.click()}>
              <Icon name={items.length ? "image-plus" : "images"} size={20} />
              {items.length ? "Add more" : "Choose photos"}
            </Button>
          </div>
        )
      )}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => addFiles(e.target.files)} />
      <input ref={libraryRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
    </section>
  );
}

function PhotoTile({ item, onRemove, onRetry }: { item: PhotoItem; onRemove: () => void; onRetry: () => void }) {
  const busy = item.status === "preparing" || item.status === "uploading";
  return (
    <li className="relative aspect-square overflow-hidden rounded-[14px] bg-mp-sunken">
      {item.preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- private authenticated photo or local preview
        <img src={item.preview} alt="" className={cx("h-full w-full object-cover transition", busy && "opacity-70", NIGHT_DIM)} />
      ) : (
        <span className="flex h-full w-full animate-pulse items-center justify-center text-mp-ink-3 motion-reduce:animate-none [.maple-night_&]:animate-none" aria-hidden>
          <Icon name="image" size={22} />
        </span>
      )}
      {busy && (
        <span className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-mp-surface/80" role="progressbar" aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Uploading">
          <span className="block h-full rounded-full bg-mp-accent-fg transition-[width] duration-300" style={{ width: `${Math.max(4, item.progress)}%` }} />
        </span>
      )}
      {item.status === "done" && (
        <span className="absolute bottom-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent" role="img" aria-label="Uploaded">
          <Icon name="check" size={14} strokeWidth={2.75} />
        </span>
      )}
      {item.status === "error" && (
        <span className="absolute inset-0 flex flex-col items-center justify-end gap-1.5 bg-mp-surface/90 p-2 pt-11 text-center text-xs leading-tight font-semibold text-mp-danger">
          {item.retryable ? (
            <>
              <span>Didn&apos;t upload</span>
              <button type="button" onClick={onRetry} className="min-h-[44px] w-full rounded-[10px] bg-mp-sunken px-3 text-xs font-semibold text-mp-ink">
                Retry
              </button>
            </>
          ) : (
            <span className="flex flex-col items-center gap-1 pb-2">
              <Icon name="ban" size={18} />
              Can&apos;t add this one
            </span>
          )}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="absolute top-0 right-0 flex h-11 w-11 items-start justify-end p-1.5"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mp-surface/90 text-mp-ink shadow-[0_1px_3px_rgba(0,0,0,0.2)]">
          <Icon name="x" size={15} strokeWidth={2.25} />
        </span>
      </button>
    </li>
  );
}

function shortName(name: string): string {
  return name.length > 24 ? `${name.slice(0, 12)}…${name.slice(-9)}` : name;
}

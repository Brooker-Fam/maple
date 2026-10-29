"use client";

import { useState } from "react";
import type { ChatImage } from "@/lib/maple/chat/images";
import { Icon } from "../icons";
import { cx } from "../ui";

export default function ChatImages({ images, onRemove, compact = false }: { images: ChatImage[]; onRemove?: (url: string) => void; compact?: boolean }) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2" aria-label={onRemove ? "Attached photos" : "Message photos"}>
      {images.map((image, i) => (
        <div key={image.url} className="relative">
          <a href={image.url} target="_blank" rel="noopener noreferrer" aria-label={`Open photo ${i + 1}`} className="block overflow-hidden rounded-xl border border-mp-line bg-mp-surface">
            <ChatThumbnail key={image.url} src={image.url} index={i + 1} compact={compact} />
          </a>
          {onRemove && <button type="button" onClick={() => onRemove(image.url)} aria-label={`Remove photo ${i + 1}`} className="absolute -top-2 -right-2 flex h-11 w-11 items-center justify-center rounded-full text-mp-ink"><span className="flex h-7 w-7 items-center justify-center rounded-full border border-mp-line bg-mp-bg shadow-sm"><Icon name="x" size={16} /></span></button>}
        </div>
      ))}
    </div>
  );
}

function ChatThumbnail({ src, index, compact }: { src: string; index: number; compact: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = compact ? "h-20 w-20" : "h-32 w-32";
  if (failed) return <span className={cx(size, "flex items-center justify-center px-2 text-center text-[12px] text-mp-ink-2")}>Photo unavailable</span>;
  // eslint-disable-next-line @next/next/no-img-element -- authenticated image proxy must bypass the public image optimizer
  return <img src={src} alt={`Attached photo ${index}`} loading="lazy" decoding="async" onError={() => setFailed(true)} className={cx(size, "object-cover [.maple-night_&]:brightness-[.65]")} />;
}

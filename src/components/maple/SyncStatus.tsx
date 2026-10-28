"use client";

import { Icon } from "./icons";
import { useMaple } from "./useMaple";

export default function SyncStatus() {
  const { pending, online, error, refresh } = useMaple();
  if (pending === 0 && online && !error) return null;
  const text = !online
    ? pending ? `Offline · ${pending} saved on this phone` : "Offline"
    : error
      ? pending ? `Couldn't refresh · ${pending} waiting to sync` : "Couldn't refresh · Tap to retry"
      : `${pending} waiting to sync`;
  return (
    <div className="pointer-events-none sticky top-0 z-[65] flex justify-center px-4 pt-[env(safe-area-inset-top)]">
      <button
        type="button"
        onClick={() => void refresh()}
        aria-live="polite"
        aria-label={`${text}. Tap to try syncing now.`}
        className="pointer-events-auto flex min-h-[44px] items-center"
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-mp-surface/95 px-3 py-1.5 text-xs font-semibold text-mp-ink-2 shadow-sm ring-1 ring-mp-line backdrop-blur-md">
          <Icon name={online ? "refresh-cw" : "cloud-off"} size={14} />
          {text}
        </span>
      </button>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  discardUploads,
  encodeForUpload,
  getUploadMode,
  PhotoError,
  uploadPhoto,
  type EncodedPhoto,
} from "@/lib/maple/image";
import { MILESTONES, milestoneEmoji, milestoneLabel, milestonePreset } from "@/lib/maple/milestones";
import { dayKey, formatDayLabel, formatTime, zonedTimeToUtc } from "@/lib/maple/time";
import type { MomentData, PhotoRef } from "@/lib/maple/types";
import { photoUrl } from "../EntryRow";
import { Chip, Field, Sheet, TextArea, WhenField, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useSheets, type SheetProps } from "./index";
import { LoggedBy, SheetFooter, useOpenCount } from "./parts";

/**
 * Log or edit a moment: photos, a title, an optional "first" (milestone),
 * a note, and when it happened.
 *
 * Photos start uploading the moment they're picked, so they're usually done
 * by the time the title is typed. Nothing is saved until "Save moment"; photos
 * removed (or left behind when the sheet closes) are tidied up from storage.
 * A saved moment's photos are fixed (the server never takes a new photos list
 * on edit), so adding more is a new moment. Viewers get a read-only view.
 */

const MAX_PHOTOS = 12;
const COLLAPSED_CHIPS = 8;

type Item = {
  id: string;
  file: File;
  preview: string | null;
  status: "preparing" | "uploading" | "done" | "error";
  progress: number;
  error?: string;
  /** Upload hiccups can be retried; a file the phone can't read can't. */
  retryable?: boolean;
  encoded?: EncodedPhoto;
  ref?: PhotoRef;
  ctrl: AbortController;
};

type Storage = "checking" | "ready" | "off" | "error";

let nextId = 0;

/**
 * The sheet router keeps one instance mounted between opens (so it can animate
 * out); keying the form on the open count gives every open a fresh form: no
 * leftover photos (already tidied from storage on close), text, or preset.
 */
export default function MomentSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  return <MomentForm key={n} {...props} />;
}

function MomentForm({ open, onClose, entry, preset }: SheetProps) {
  const { state, log, update, remove, toast, now, readOnly } = useMaple();
  const { open: openSheet } = useSheets();
  const tz = state?.baby.timezone ?? "America/New_York";
  const moment = entry?.kind === "moment" ? entry : undefined;
  const isEdit = !!moment;

  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const [title, setTitle] = useState(() => moment?.data.title ?? str(preset?.title));
  const [milestone, setMilestone] = useState(() => moment?.data.milestone ?? str(preset?.milestone));
  const [note, setNote] = useState(() => moment?.note ?? str(preset?.note));
  const [when, setWhen] = useState<Date | null>(() => (moment ? new Date(moment.started_at) : null));
  const [whenFromPhoto, setWhenFromPhoto] = useState(false);
  const whenTouched = useRef(isEdit);
  const [showAllChips, setShowAllChips] = useState(() => {
    const i = MILESTONES.findIndex((m) => m.id === (moment?.data.milestone ?? preset?.milestone));
    return i >= COLLAPSED_CHIPS;
  });
  const [items, setItems] = useState<Item[]>([]);
  const [storage, setStorage] = useState<Storage>("checking");
  const [saving, setSaving] = useState(false);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const saved = useRef(false);
  /** Photos already cancelled/deleted, so each is tidied once (and never saved). */
  const discarded = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  // Which photo store is live (or none yet). Only new moments take photos.
  useEffect(() => {
    if (isEdit || !open || readOnly) return;
    let live = true;
    getUploadMode()
      .then((m) => live && setStorage(m.ready ? "ready" : "off"))
      .catch(() => live && setStorage("error"));
    return () => {
      live = false;
    };
  }, [isEdit, open, readOnly]);

  const patch = useCallback((id: string, p: Partial<Item>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }, []);

  /**
   * Cancel uploads in flight and delete anything uploaded but never saved.
   * Per photo rather than a one-shot flag: React's dev double-mount runs the
   * unmount cleanup once before any photo exists, and that must not count.
   */
  const tidyUp = useCallback(() => {
    if (saved.current) return;
    const refs: PhotoRef[] = [];
    for (const it of itemsRef.current) {
      if (discarded.current.has(it.id)) continue;
      discarded.current.add(it.id);
      it.ctrl.abort();
      if (it.ref) refs.push(it.ref);
    }
    discardUploads(refs);
  }, []);

  useEffect(() => {
    if (!open) tidyUp();
  }, [open, tidyUp]);

  useEffect(
    () => () => {
      tidyUp();
      for (const it of itemsRef.current) if (it.preview) URL.revokeObjectURL(it.preview);
    },
    [tidyUp]
  );

  const uploading = items.some((it) => it.status === "preparing" || it.status === "uploading");

  // Closing the tab mid-upload strands the photo; ask first.
  useEffect(() => {
    if (!uploading) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [uploading]);

  /** Camera time beats "now" for a photo from earlier, until someone picks a time. */
  const adoptPhotoTime = useCallback(
    (taken: EncodedPhoto["takenAt"]) => {
      if (!taken || whenTouched.current) return;
      const at = zonedTimeToUtc(taken.year, taken.month, taken.day, taken.hour, taken.minute, tz);
      const age = now().getTime() - at.getTime();
      if (Number.isNaN(age) || age < 10 * 60_000 || age > 400 * 864e5) return;
      whenTouched.current = true;
      setWhen(at);
      setWhenFromPhoto(true);
    },
    [now, tz]
  );

  const process = useCallback(
    async (id: string) => {
      const it = itemsRef.current.find((x) => x.id === id);
      if (!it || it.ctrl.signal.aborted) return;
      let encoded = it.encoded;
      if (!encoded) {
        try {
          encoded = await encodeForUpload(it.file);
        } catch (e) {
          // A file this phone can't read won't work on a second try either.
          if (!it.ctrl.signal.aborted) {
            patch(id, { status: "error", retryable: false, error: e instanceof PhotoError ? e.message : "Couldn't open that photo" });
          }
          return;
        }
        const preview = URL.createObjectURL(encoded.thumb ?? encoded.full);
        if (it.ctrl.signal.aborted) {
          URL.revokeObjectURL(preview);
          return;
        }
        patch(id, { encoded, preview });
        adoptPhotoTime(encoded.takenAt);
      }
      try {
        patch(id, { status: "uploading", progress: 3, error: undefined });
        const ref = await uploadPhoto(encoded, {
          signal: it.ctrl.signal,
          onProgress: (p) => patch(id, { progress: Math.max(3, p) }),
        });
        if (it.ctrl.signal.aborted) {
          discardUploads([ref]);
          return;
        }
        patch(id, { status: "done", progress: 100, ref });
      } catch (e) {
        if (it.ctrl.signal.aborted) return;
        const error = e instanceof PhotoError ? e.message : "Couldn't upload that photo";
        patch(id, { status: "error", retryable: !/too big|only jpeg/i.test(error), error });
      }
    },
    [adoptPhotoTime, patch]
  );

  // One photo at a time: phones run out of memory decoding several 12 MP images at once.
  const enqueue = useCallback(
    (id: string) => {
      queue.current = queue.current.then(() => process(id)).catch(() => {});
    },
    [process]
  );

  const addFiles = (files: FileList | null) => {
    const room = MAX_PHOTOS - itemsRef.current.length;
    const list = Array.from(files ?? []);
    if (list.length > room) toast(`Up to ${MAX_PHOTOS} photos per moment`, { tone: "info", emoji: "📸" });
    const fresh: Item[] = list.slice(0, Math.max(0, room)).map((file) => ({
      id: `p${nextId++}`,
      file,
      preview: null,
      status: "preparing",
      progress: 0,
      ctrl: new AbortController(),
    }));
    if (!fresh.length) return;
    setItems((cur) => [...cur, ...fresh]);
    itemsRef.current = [...itemsRef.current, ...fresh];
    fresh.forEach((f) => enqueue(f.id));
    if (cameraRef.current) cameraRef.current.value = "";
    if (libraryRef.current) libraryRef.current.value = "";
  };

  const removeItem = (id: string) => {
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    it.ctrl.abort();
    discarded.current.add(id);
    if (it.ref) discardUploads([it.ref]);
    if (it.preview) URL.revokeObjectURL(it.preview);
    setItems((cur) => cur.filter((x) => x.id !== id));
  };

  const retryItem = (id: string) => {
    const fresh: Partial<Item> = { status: "preparing", progress: 0, error: undefined, ctrl: new AbortController() };
    // The queue reads itemsRef, so it needs the new controller before the re-render.
    itemsRef.current = itemsRef.current.map((x) => (x.id === id ? { ...x, ...fresh } : x));
    patch(id, fresh);
    enqueue(id);
  };

  // A photo whose upload was cancelled or tidied away must never be saved.
  const done = items.filter((it) => it.status === "done" && it.ref && !it.ctrl.signal.aborted && !discarded.current.has(it.id));
  const failed = items.filter((it) => it.status === "error").length;
  const pending = items.length - done.length - failed;
  const hasWords = !!(title.trim() || milestone || note.trim());
  const canSave = !readOnly && !saving && !uploading && (isEdit || hasWords || done.length > 0);

  const save = async () => {
    // A closed sheet's photos are already gone from storage.
    if (!canSave || !openRef.current) return;
    setSaving(true);
    const t = title.trim();
    const n = note.trim();
    try {
      if (moment) {
        const res = await update(moment.id, {
          started_at: when?.toISOString(),
          data: { title: t || null, milestone: milestone || null },
          note: n || null,
        });
        if (res) {
          saved.current = true;
          onClose();
        }
        return;
      }
      const data: MomentData = {};
      if (t) data.title = t;
      if (milestone) data.milestone = milestone;
      if (done.length) data.photos = done.map((it) => it.ref!);
      const count = data.photos?.length ?? 0;
      // Mark saved before the request so closing mid-save can't tidy these photos away.
      saved.current = true;
      const res = await log(
        { kind: "moment", started_at: when?.toISOString(), data: data as Record<string, unknown>, note: n || null },
        {
          toast: count ? `Moment saved · ${count} photo${count === 1 ? "" : "s"}` : "Moment saved",
          emoji: milestoneEmoji(milestone) ?? (count ? "📸" : "✨"),
        }
      );
      if (res) onClose();
      else {
        saved.current = false;
        // Closed while the save was failing: tidy the photos as a close would have.
        if (!openRef.current) tidyUp();
      }
    } finally {
      setSaving(false);
    }
  };

  const del = () => {
    if (!moment) return;
    onClose();
    void remove(moment.id, { toast: "Moment removed" });
  };

  const footer = (
    <SheetFooter
      onClose={onClose}
      onDelete={isEdit ? del : undefined}
      onPrimary={() => void save()}
      disabled={!canSave}
      busy={saving}
      label={
        isEdit
          ? "Save"
          : uploading
            ? `Uploading ${pending} photo${pending === 1 ? "" : "s"}…`
            : failed && done.length + (hasWords ? 1 : 0) > 0
              ? `Save without ${failed} photo${failed === 1 ? "" : "s"}`
              : "Save moment"
      }
    />
  );

  // Chips: a non-preset tag (a monthly photo, a kept celebration) leads the row.
  const custom = milestone && !milestonePreset(milestone) ? milestone : null;
  const chips = showAllChips ? MILESTONES : MILESTONES.slice(0, COLLAPSED_CHIPS);

  // Viewers (read-only role) see the moment, not a form.
  if (readOnly) {
    const label = milestoneLabel(moment?.data.milestone);
    const heading = moment?.data.title || label || "A little moment";
    return (
      <Sheet open={open} onClose={onClose} title="Moment" emoji="✨" footer={footer}>
        {moment ? (
          <>
            <LoggedBy entry={moment} />
            <ExistingPhotos entryId={moment.id} count={moment.data.photos?.length ?? 0} />
            <div>
              {label && label !== heading && (
                <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-[#C49A3C]/20 px-2.5 py-0.5 text-xs font-semibold text-[#7A5A12] dark:text-[#F1D58F]">
                  <span aria-hidden>{milestoneEmoji(moment.data.milestone) ?? "✨"}</span> {label}
                </span>
              )}
              <p className={cx(tone.heading, "text-2xl italic")}>{heading}</p>
              {moment.note && <p className={cx(tone.body, "mt-1.5 text-[15px] whitespace-pre-line")}>{moment.note}</p>}
              <p className={cx(tone.muted, "mt-2 text-[13px]")}>
                {formatDayLabel(dayKey(new Date(moment.started_at), tz), dayKey(now(), tz))} · {formatTime(moment.started_at, tz)}
              </p>
            </div>
          </>
        ) : (
          <p className={cx(tone.muted, "text-sm")}>Moments are added by Maple&apos;s grown-ups.</p>
        )}
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={isEdit ? "Edit moment" : "New moment"} emoji={isEdit ? "✨" : "📸"} footer={footer}>
      {moment && <LoggedBy entry={moment} />}
      {/* Photos */}
      {moment ? (
        <ExistingPhotos
          entryId={moment.id}
          count={moment.data.photos?.length ?? 0}
          onNew={() => openSheet({ kind: "moment" })}
        />
      ) : (
        <section aria-label="Photos" className="ph-no-capture">
          <span className={cx(tone.label, "mb-1.5 block")}>Photos</span>
          {items.length > 0 && (
            <ul className="mb-3 grid grid-cols-3 gap-2.5">
              {items.map((it) => (
                <PhotoTile key={it.id} item={it} onRemove={() => removeItem(it.id)} onRetry={() => retryItem(it.id)} />
              ))}
            </ul>
          )}
          {items.some((it) => it.status === "error") && (
            <ul className="mb-3 space-y-1 text-[13px] leading-snug text-[#9A3A24] dark:text-[#F4A68F]" aria-live="polite">
              {items
                .filter((it) => it.status === "error")
                .map((it) => (
                  <li key={it.id}>
                    <span className="font-semibold">{shortName(it.file.name)}:</span> {it.error}
                  </li>
                ))}
            </ul>
          )}
          {storage === "off" || storage === "error" ? (
            <p className={cx(tone.muted, "rounded-2xl bg-[#5C7A4A]/10 px-4 py-3 text-sm dark:bg-[#F5EDDF]/[0.06]")}>
              {storage === "off"
                ? "🍃 Photo storage isn't set up yet, so this moment will be words only for now."
                : "🍃 Couldn't reach photo storage. You can still save the words, or close and try again."}
            </p>
          ) : (
            items.length < MAX_PHOTOS && (
              <div className="grid grid-cols-2 gap-2.5">
                <PickButton emoji="📷" label="Take a photo" disabled={storage !== "ready"} onClick={() => cameraRef.current?.click()} />
                <PickButton
                  emoji="🖼️"
                  label={items.length ? "Add more" : "Choose photos"}
                  disabled={storage !== "ready"}
                  onClick={() => libraryRef.current?.click()}
                />
              </div>
            )
          )}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => addFiles(e.target.files)} />
          <input ref={libraryRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
        </section>
      )}

      <Field label="Title">
        <input
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={milestone ? milestoneLabel(milestone) : "What happened?"}
          className={tone.input}
        />
      </Field>

      <div>
        <span className={cx(tone.label, "mb-1.5 block")}>
          A first? <span className="font-medium tracking-normal normal-case opacity-70">(optional)</span>
        </span>
        <div className="flex flex-wrap gap-2">
          {custom && (
            <Chip selected onClick={() => setMilestone("")}>
              <span aria-hidden>{milestoneEmoji(custom) ?? "✨"}</span> {milestoneLabel(custom)}
            </Chip>
          )}
          {chips.map((m) => (
            <Chip key={m.id} selected={milestone === m.id} onClick={() => setMilestone(milestone === m.id ? "" : m.id)}>
              <span aria-hidden>{m.emoji}</span> {m.label}
            </Chip>
          ))}
          {!showAllChips && (
            <Chip onClick={() => setShowAllChips(true)}>
              More firsts… <span aria-hidden>🌱</span>
            </Chip>
          )}
        </div>
      </div>

      <Field label="Note">
        <TextArea value={note} onChange={setNote} rows={3} placeholder="A few words for Maple to read someday…" />
      </Field>

      <div>
        <WhenField
          value={when}
          onChange={(d) => {
            whenTouched.current = true;
            setWhenFromPhoto(false);
            setWhen(d);
          }}
          tz={tz}
          offsets={[30, 60, 180]}
        />
        {whenFromPhoto && <p className={cx(tone.muted, "mt-1 text-xs")}>🕰️ Set from when the photo was taken.</p>}
      </div>
    </Sheet>
  );
}

function PickButton({ emoji, label, onClick, disabled }: { emoji: string; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[88px] flex-col items-center justify-center gap-1 rounded-3xl border-2 border-dashed border-[#5C7A4A]/35 bg-white/60 text-[15px] font-semibold text-[#1D4420] transition active:scale-[0.98] disabled:opacity-50 dark:border-[#A9C08F]/30 dark:bg-[#0E1E12] dark:text-[#F5EDDF]"
    >
      <span className="text-2xl" aria-hidden>
        {emoji}
      </span>
      {label}
    </button>
  );
}

function PhotoTile({ item, onRemove, onRetry }: { item: Item; onRemove: () => void; onRetry: () => void }) {
  const busy = item.status === "preparing" || item.status === "uploading";
  return (
    <li className="relative aspect-square overflow-hidden rounded-2xl bg-[#5C7A4A]/15 dark:bg-[#A9C08F]/10">
      {item.preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL
        <img src={item.preview} alt="" className={cx("h-full w-full object-cover transition", busy && "opacity-70")} />
      ) : (
        <span className="flex h-full w-full animate-pulse items-center justify-center text-2xl" aria-hidden>
          🍃
        </span>
      )}
      {busy && (
        <span className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-white/70" role="progressbar" aria-valuenow={item.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Uploading">
          <span className="block h-full rounded-full bg-[#C49A3C] transition-[width] duration-300" style={{ width: `${Math.max(4, item.progress)}%` }} />
        </span>
      )}
      {item.status === "done" && (
        <span className="absolute bottom-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[#1D4420] text-xs text-white" aria-label="Uploaded">
          ✓
        </span>
      )}
      {item.status === "error" && (
        <span className="absolute inset-0 flex flex-col items-center justify-end gap-1.5 bg-[#7A2E1E]/80 p-2 pt-11 text-center text-xs leading-tight font-semibold text-white">
          {item.retryable ? (
            <>
              <span>Didn&apos;t upload</span>
              <button type="button" onClick={onRetry} className="min-h-[36px] w-full rounded-full bg-white/20 px-3 text-xs font-bold">
                Retry
              </button>
            </>
          ) : (
            <span className="pb-2">
              <span className="mb-0.5 block text-lg" aria-hidden>
                🍂
              </span>
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
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#0B1A0D]/60 text-sm text-white backdrop-blur-sm">✕</span>
      </button>
    </li>
  );
}

function ExistingPhotos({ entryId, count, onNew }: { entryId: number; count: number; onNew?: () => void }) {
  return (
    <section aria-label="Photos" className="ph-no-capture">
      {count > 0 && (
        <ul className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {Array.from({ length: count }, (_, i) => (
            <li key={i} className="h-20 w-20 shrink-0 overflow-hidden rounded-2xl bg-[#5C7A4A]/15">
              <FallbackImg src={photoUrl(entryId, i)} />
            </li>
          ))}
        </ul>
      )}
      {onNew && (
        <p className={cx(tone.muted, "text-sm")}>
          {count > 0 ? "Photos stay just as they were saved. " : "This moment was saved without photos. "}
          To add more, start a{" "}
          <button type="button" onClick={onNew} className="font-semibold text-[#1D4420] underline decoration-[#C49A3C] underline-offset-2 dark:text-[#E0C27A]">
            new moment
          </button>{" "}
          🍃
        </p>
      )}
    </section>
  );
}

/** "IMG_2041.HEIC", or a trimmed version of a long name. */
function shortName(name: string): string {
  return name.length > 24 ? `${name.slice(0, 12)}…${name.slice(-9)}` : name;
}

/** An image that turns into a soft leaf if it can't load. */
function FallbackImg({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="flex h-full w-full items-center justify-center text-2xl" role="img" aria-label="Photo unavailable">
        🍃
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />;
}

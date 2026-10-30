"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { milestoneLabel, type MilestoneWords } from "@/lib/maple/milestones";
import { babyAge, dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { EntryOf, Member } from "@/lib/maple/types";
import { momentPhotoUrl } from "./moments/photo";
import PhotoActions from "./moments/PhotoActions";
import { useBabyWords, useMilestoneWords, type BabyWords } from "./familyWords";
import { Icon } from "./icons";
import { ageShort } from "./keepsake";
import { useNightActive } from "./nightLook";
import { Avatar, Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";
import { registerSheet } from "./sheetHistory";

type Moment = EntryOf<"moment">;
export type Slide = { entry: Moment; photo: number | null };
const NIGHT_DIM = "[.maple-night_&]:brightness-[.55] [.maple-night_&]:saturate-[.8]";

export const captionOf = (m: Moment, mw: MilestoneWords) => m.data.title || milestoneLabel(m.data.milestone, mw) || m.note || "A little moment";
/** The note, when it says something the caption doesn't. */
export const extraNote = (m: Moment, mw: MilestoneWords) => (m.note && captionOf(m, mw) !== m.note ? m.note : null);
/**
 * A photo-less slide in the lightbox shows a short note as its picture. A
 * long one would be cut off there, so it goes in the caption, in full.
 */
const pictureNote = (s: Slide, mw: MilestoneWords) => {
  const note = s.photo == null ? extraNote(s.entry, mw) : null;
  return note && note.length <= 120 && !note.includes("\n") ? note : null;
};

function ageAt(bornAt: string | null, at: string, tz: string, w: BabyWords): string | null {
  if (!bornAt) return null;
  if (Date.parse(at) < Date.parse(bornAt)) return `Before ${w.he} arrived`;
  const age = babyAge(bornAt, new Date(at), tz);
  if (age.days < 1) return age.label;
  if (age.days < 14) return `${age.days} day${age.days === 1 ? "" : "s"} old`;
  return `${age.label} old`;
}

type SafeImageProps = { src: string; className?: string; alt?: string };

export function SafeImg(props: SafeImageProps) {
  return <MomentImage key={props.src} {...props} />;
}

function MomentImage({ src, className, alt = "" }: SafeImageProps) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span role="img" aria-label="Couldn't load photo. Open to retry." className={cx("flex w-full flex-col items-center justify-center gap-1 bg-mp-sunken px-1 text-center text-mp-ink-2", className)}>
        <Icon name="image" size={22} />
        <span className="text-[12px] leading-tight">Couldn&apos;t load photo</span>
        <span className="text-[11px] leading-tight">Open to retry</span>
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy, not the image optimizer
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} className={cx(className, NIGHT_DIM)} />;
}

export function Lightbox({
  slides,
  index,
  onIndex,
  onClose,
  onEdit,
  bornAt,
  tz,
}: {
  slides: Slide[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onEdit?: (m: Moment) => void;
  bornAt: string | null;
  tz: string;
}) {
  const { memberName, member, now } = useMaple();
  const mw = useMilestoneWords();
  const reduce = useReducedMotion();
  const openNow = index >= 0;
  const [dir, setDir] = useState(0);
  const night = useNightActive();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (openNow) return registerSheet(() => onCloseRef.current(), () => false);
  }, [openNow]);

  const go = useCallback(
    (d: number) => {
      const next = index + d;
      if (next < 0 || next >= slides.length) return;
      setDir(d);
      onIndex(next);
    },
    [index, onIndex, slides.length]
  );

  useEffect(() => {
    if (!openNow || !dialogRef.current) return;
    const back = document.activeElement as HTMLElement | null;
    const outside = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== dialogRef.current && !element.inert && !element.matches("script, style, link"));
    outside.forEach((element) => { element.inert = true; });
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      outside.forEach((element) => { element.inert = false; });
      back?.focus?.();
    };
  }, [openNow]);

  useEffect(() => {
    if (!openNow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Tab") {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
        const first = controls?.[0];
        const last = controls?.[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go, onClose, openNow]);

  // Warm the neighbors so a swipe lands on a loaded photo.
  useEffect(() => {
    if (!openNow) return;
    for (const d of [1, -1]) {
      const s = slides[index + d];
      if (s && s.photo != null) new Image().src = momentPhotoUrl(s.entry.id, s.entry.data.photos![s.photo], s.photo, "full");
    }
  }, [index, openNow, slides]);

  if (!mounted) return null;
  const slide = openNow ? slides[index] : null;

  return createPortal(
    <AnimatePresence>
      {slide && (
        <motion.div
          key="lightbox"
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Moment"
          // Photos are viewed on near-black whatever the theme: the .dark class
          // gives this layer the dark tokens. At night the page's own night
          // tokens (on <html>) already are that, in amber.
          className={cx("ph-no-capture fixed inset-0 z-[85] flex flex-col bg-mp-bg text-mp-ink", !night && "dark")}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2 }}
        >
          <div className="flex shrink-0 items-center gap-1 px-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
            <span className={cx(tone.muted, "flex-1 pl-3 text-[13px] font-medium tabular-nums")}>
              {index + 1} of {slides.length}
            </span>
            {onEdit && slide.entry.id > 0 && (
              <button
                type="button"
                onClick={() => onEdit(slide.entry)}
                className="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-[15px] font-semibold text-mp-ink transition hover:bg-mp-ink/10"
              >
                <Icon name="pencil" size={17} />
                Edit
              </button>
            )}
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-full">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2">
                <Icon name="x" size={18} strokeWidth={2.25} />
              </span>
            </button>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence initial={false} custom={dir} mode="popLayout">
              <motion.div
                key={`${slide.entry.id}-${slide.photo}`}
                custom={dir}
                className="absolute inset-0 flex items-center justify-center px-3 py-2"
                initial={reduce ? { opacity: 0 } : { x: dir >= 0 ? "60%" : "-60%", opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={reduce ? { opacity: 0 } : { x: dir >= 0 ? "-60%" : "60%", opacity: 0 }}
                transition={{ duration: reduce ? 0.1 : 0.25, ease: "easeOut" }}
                drag={slides.length > 1 ? "x" : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.6}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -70 || info.velocity.x < -500) go(1);
                  else if (info.offset.x > 70 || info.velocity.x > 500) go(-1);
                }}
              >
                {slide.photo != null ? (
                  <FullPhoto entry={slide.entry} index={slide.photo} dim={night} />
                ) : (
                  // No photo: the words are the picture (the caption below skips what's shown here).
                  <div className="flex aspect-square max-h-full w-full max-w-xs flex-col items-center justify-center overflow-hidden rounded-[20px] border border-mp-line bg-mp-surface p-7 text-center">
                    <span className={cx(tone.display, "line-clamp-6 text-[24px] leading-tight lining-nums")}>
                      {pictureNote(slide, mw) ? `“${pictureNote(slide, mw)}”` : captionOf(slide.entry, mw)}
                    </span>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
            {index > 0 && <NavArrow side="left" onClick={() => go(-1)} />}
            {index < slides.length - 1 && <NavArrow side="right" onClick={() => go(1)} />}
          </div>

          <Caption slide={slide} bornAt={bornAt} tz={tz} now={now()} who={memberName(slide.entry.created_by)} avatar={member(slide.entry.created_by)} />
          {slide.photo != null && <PhotoActions key={`${slide.entry.id}-${slide.entry.data.photos![slide.photo].id ?? slide.photo}`} src={momentPhotoUrl(slide.entry.id, slide.entry.data.photos![slide.photo], slide.photo, "full")} filename={`maple-${slide.entry.id}-${slide.photo + 1}`} />}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function NavArrow({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
      className={cx(
        "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-mp-surface/80 text-mp-ink ring-1 ring-mp-line transition hover:bg-mp-surface",
        side === "left" ? "left-2" : "right-2"
      )}
    >
      <Icon name={side === "left" ? "chevron-left" : "chevron-right"} size={22} />
    </button>
  );
}

/** Thumb first (usually cached), then the full image fades in over it. */
function FullPhoto({ entry, index, dim }: { entry: Moment; index: number; dim: boolean }) {
  const [full, setFull] = useState<"loading" | "ok" | "broken">("loading");
  const [thumbBroken, setThumbBroken] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const cls = cx("max-h-full max-w-full rounded-[4px] object-contain select-none", dim && "brightness-[.55] saturate-[.8]");
  const src = (size: "thumb" | "full") => `${momentPhotoUrl(entry.id, entry.data.photos![index], index, size)}${attempt ? `&retry=${attempt}` : ""}`;
  const retry = () => {
    setAttempt((value) => value + 1);
    setThumbBroken(false);
    setFull("loading");
  };
  return (
    <div className="relative flex h-full w-full items-center justify-center" draggable={false}>
      {full !== "ok" && !thumbBroken && (
        // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy
        <img src={src("thumb")} alt="" draggable={false} onError={() => setThumbBroken(true)} className={cx(cls, "absolute blur-[1px]")} />
      )}
      {full !== "broken" && (
        // eslint-disable-next-line @next/next/no-img-element -- private photo via the auth proxy
        <img
          src={src("full")}
          alt=""
          draggable={false}
          onLoad={() => setFull("ok")}
          onError={() => setFull("broken")}
          className={cx(cls, "relative transition-opacity duration-300", full === "ok" ? "opacity-100" : "opacity-0")}
        />
      )}
      {full === "broken" && (
        <div role="alert" className="relative flex max-w-xs flex-col items-center gap-3 rounded-[20px] border border-mp-line bg-mp-surface p-6 text-center">
          <Icon name="image" size={24} className="text-mp-ink-2" />
          <p className={cx(tone.body, "text-sm")}>{thumbBroken ? "Couldn't load this photo." : "Couldn't load the full photo."}</p>
          <Button variant="soft" onClick={retry}>Retry photo</Button>
        </div>
      )}
    </div>
  );
}

function Caption({
  slide,
  bornAt,
  tz,
  now,
  who,
  avatar,
}: {
  slide: Slide;
  bornAt: string | null;
  tz: string;
  now: Date;
  who: string;
  avatar: Member | null;
}) {
  const w = useBabyWords();
  const mw = useMilestoneWords();
  const m = slide.entry;
  const at = new Date(m.started_at);
  // "Day 4" in her first two weeks, as the cards and Firsts say it; "2 weeks, 3 days old" after that.
  const short = ageShort(bornAt, m.started_at, tz);
  const age = short?.startsWith("Day ") ? short : ageAt(bornAt, m.started_at, tz, w);
  const milestone = m.data.milestone ? milestoneLabel(m.data.milestone, mw) : null;
  const title = captionOf(m, mw);
  // A photo-less slide already shows its (short) note as the picture, or else its title: say each once.
  const showNote = m.note && m.note !== title && !pictureNote(slide, mw);
  const showTitle = slide.photo != null || !!pictureNote(slide, mw);
  const via = m.source === "claude" ? " via Claude" : m.source === "chatgpt" ? " via ChatGPT" : m.source === "muse" ? " via Muse" : m.source === "grok" ? " via Grok" : m.source === "mcp" ? " via AI" : m.source === "chat" ? " via Maple chat" : "";
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
      {milestone && milestone !== title && <p className="mb-1 text-[13px] font-semibold text-mp-accent-fg">{milestone}</p>}
      {showTitle && <p className={cx(tone.display, "text-[26px] leading-tight lining-nums")}>{title}</p>}
      {showNote && <p className={cx(tone.muted, "mt-1.5 text-[15px] leading-relaxed whitespace-pre-line")}>{m.note}</p>}
      <p className={cx(tone.faint, "mt-2.5 text-[13px]")}>
        {formatDayLabel(dayKey(at, tz), dayKey(now, tz))} · {formatTime(at, tz)}
        {age && <> · {age.startsWith("Day ") ? age : age.charAt(0).toLowerCase() + age.slice(1)}</>}
      </p>
      <p className={cx(tone.faint, "mt-1 flex items-center gap-1.5 text-[13px]")}>
        <Avatar member={avatar} size={20} /> Added by {who}
        {via}
      </p>
    </div>
  );
}

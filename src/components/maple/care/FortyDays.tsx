"use client";

import { useEffect, useRef, useState } from "react";
import { fortyDay, fortyDaysNote } from "@/lib/maple/forty-days";
import {
  FORTY_DAYS_ABOUT,
  FORTY_DAYS_BOOK,
  FORTY_DAY_NOTES,
  FORTY_DAY_STAGES,
  fortyDaysHelp,
  visitorNote,
  type FortyDaysNote,
  type FortyDaysSource,
} from "@/lib/maple/guidelines/forty-days";
import { DEFAULT_TZ, dayKey } from "@/lib/maple/time";
import { useVoice } from "../familyWords";
import { Icon } from "../icons";
import { useNightActive } from "../nightLook";
import { CARE_COLOR } from "../palette";
import { Button, SectionTitle, Sheet, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { useCopyForOb } from "./CheckInResults";
import { GROUP, SwitchRow } from "./parts";
import type { UseCare } from "./useCare";
import { useFortyDaysPrefs } from "./useFortyDaysPrefs";

/**
 * "The first forty days" on her page: one short note a day from the birth to
 * day 40, drawn from Heng Ou's The First Forty Days and the traditions behind
 * it, checked against ACOG, WHO, CDC and NHS where a note touches her health
 * (guidelines/forty-days.ts). She reads hers ("you"); anyone else who opens her
 * page reads how to help with it. Like the daily discoveries it folds to one
 * line at night or while a timer runs, and hiding it (for today, or on this
 * phone) is this person's choice on this phone alone.
 */
export default function FortyDays({ care }: { care: UseCare }) {
  const { state, summary } = useMaple();
  const now = useNow(60_000);
  const night = useNightActive();
  const voice = useVoice();
  const { prefs, update, ready } = useFortyDaysPrefs();
  const [revealed, setRevealed] = useState(false);
  const [about, setAbout] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (revealed) heading.current?.focus({ preventScroll: true });
  }, [revealed]);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const day = state ? fortyDay(state.baby.born_at, now, tz) : null;
  const note = day ? fortyDaysNote(day) : null;
  if (!state || !ready || !day || !note || prefs.off) return null;
  const self = care.self;
  const today = dayKey(now, tz);
  // Her page can render before the log's summary has its timers (and does in its UI checks), so read them defensively.
  const quiet = night || !!summary?.active?.length;
  const eyebrow = `The first forty days · Day ${day}`;
  // The sheet stays mounted whichever way the card shows, so it always closes the usual way (and through Back).
  const sheet = <FortyDaysSheet open={about} onClose={() => setAbout(false)} day={day} self={self} onHide={() => { update({ hiddenDay: today }); setAbout(false); }} onOff={() => { update({ off: true }); setAbout(false); }} />;

  if (prefs.hiddenDay === today) return (
    <>
      <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-2 px-1 text-[13px] text-mp-ink-3">
        <span>Today&apos;s forty days note is hidden</span>
        <button type="button" onClick={() => update({ hiddenDay: null })} className="min-h-[44px] px-2 font-medium text-mp-accent-fg">Show again</button>
      </div>
      {sheet}
    </>
  );
  if (quiet && !revealed) return (
    <>
      <button type="button" onClick={() => setRevealed(true)} className="flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-left text-[14px] text-mp-ink-2">
        <Icon name="soup" size={18} className="mp-kind-ink shrink-0" style={{ color: CARE_COLOR }} />
        <span className="flex-1">{eyebrow}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {sheet}
    </>
  );

  return (
    <section aria-labelledby="forty-days-title" className="border-l-2 border-mp-accent-fg/50 pr-1 pl-4">
      <div className="flex items-center gap-2 text-[13px] text-mp-ink-2">
        <Icon name="soup" size={17} className="mp-kind-ink shrink-0" style={{ color: CARE_COLOR }} />
        <span className="flex-1">{eyebrow}</span>
        <button type="button" aria-label="About the forty days notes" onClick={() => setAbout(true)} className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-mp-ink-3">
          <Icon name="ellipsis" size={19} />
        </button>
      </div>
      <h2 ref={heading} tabIndex={-1} id="forty-days-title" className={cx(tone.heading, "text-[19px] leading-snug outline-none")}>
        {self ? note.title : note.othersTitle(voice)}
      </h2>
      <p className={cx(tone.muted, "mt-1.5 text-[15px] leading-relaxed")}>{self ? note.you : note.others(voice)}</p>
      {note.action === "visitors" && <VisitorNoteButton className="mt-2.5" />}
      <Sources sources={note.sources} className="mt-1" />
      <button type="button" onClick={() => setAbout(true)} className="block min-h-[44px] text-left text-[14px] font-medium text-mp-accent-fg">
        All forty days
      </button>
      {sheet}
    </section>
  );
}

/** A note's sources, the book's and any health body's, each a link. */
function Sources({ sources, className }: { sources: readonly FortyDaysSource[]; className?: string }) {
  return (
    <p className={cx(tone.faint, "text-[13px] leading-snug", className)}>
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && " · "}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[32px] items-center underline underline-offset-2">
            {s.label}
          </a>
        </span>
      ))}
    </p>
  );
}

/** Every note, by stretch of days (so she can read ahead or back), what they are, and this phone's two choices. */
function FortyDaysSheet({ open, onClose, day, self, onHide, onOff }: { open: boolean; onClose: () => void; day: number; self: boolean; onHide: () => void; onOff: () => void }) {
  const voice = useVoice();
  const text = (n: FortyDaysNote) => (self ? n.you : n.others(voice));
  return (
    <Sheet open={open} onClose={onClose} title="The first forty days" footer={<Button onClick={onClose} className="w-full">Done</Button>}>
      <div className="space-y-6">
        <div className="space-y-2 px-1">
          {FORTY_DAYS_ABOUT.map((p) => (
            <p key={p} className={cx(tone.body, "text-[15px] leading-relaxed")}>{p}</p>
          ))}
        </div>
        {FORTY_DAY_STAGES.map((stage) => {
          const notes = FORTY_DAY_NOTES.filter((n) => n.stage === stage.id);
          const here = day >= stage.from && day <= stage.to;
          return (
            <section key={stage.id} aria-labelledby={`forty-${stage.id}`}>
              <SectionTitle>
                <span id={`forty-${stage.id}`}>{stage.title}</span>
                {here && <span className={cx(tone.faint, "ml-2 text-[13px] font-normal")}>now</span>}
              </SectionTitle>
              <div className={GROUP}>
                {notes.map((n) => (
                  <div key={n.id} className="px-4 py-3">
                    <p className={cx(tone.body, "text-[15px] font-semibold")}>{self ? n.title : n.othersTitle(voice)}</p>
                    <p className={cx(tone.muted, "mt-0.5 text-[14px] leading-relaxed")}>{text(n)}</p>
                    <Sources sources={n.sources} className="mt-1" />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        <div className={GROUP}>
          <button type="button" onClick={onHide} className={cx(tone.row, "min-h-[52px] py-2.5 text-[15px] font-medium text-mp-accent-fg")}>Hide for today</button>
          <SwitchRow label="Show these notes on this phone" note="Turned off, the card stays away until you turn it back on here." checked onChange={(v) => { if (!v) onOff(); }} />
        </div>
      </div>
    </Sheet>
  );
}

/** Her page's Settings row: bring the card back on this phone (shown only in the forty days, and only while it's off). */
export function FortyDaysRow() {
  const { state } = useMaple();
  const now = useNow(60_000);
  const { prefs, update, ready } = useFortyDaysPrefs();
  const day = state ? fortyDay(state.baby.born_at, now, state.baby.timezone ?? DEFAULT_TZ) : null;
  if (!ready || !day || !prefs.off) return null;
  return <SwitchRow label="First forty days notes" note="Off on this phone" checked={false} onChange={(v) => { if (v) update({ off: false, hiddenDay: null }); }} />;
}

/**
 * "A note for visitors": the share sheet where there is one, else the
 * clipboard. The words are ours (visitorNote); nothing is sent until the
 * person sends it, and it names no one, so whoever shares it adds their own.
 */
export function VisitorNoteButton({ className }: { className?: string }) {
  const voice = useVoice();
  const copy = useCopyForOb();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  const text = visitorNote(voice);
  const send = async () => {
    if (canShare) {
      try {
        await navigator.share({ text });
        return;
      } catch (e) {
        // Cancelled: nothing to do. Anything else falls back to copying.
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    await copy(text);
  };
  return (
    <Button variant="soft" size="sm" className={className} onClick={() => void send()}>
      <Icon name={canShare ? "share" : "copy"} size={16} />
      {canShare ? "Share a note for visitors" : "Copy a note for visitors"}
    </Button>
  );
}

/**
 * Support's forty days card, through day 40: hers ("Support for you") says
 * how to let people help; everyone else's says how to help, with the visitor
 * note either way.
 */
export function FortyDaysHelp({ self }: { self: boolean }) {
  const { state } = useMaple();
  const now = useNow(60_000);
  const voice = useVoice();
  const day = state ? fortyDay(state.baby.born_at, now, state.baby.timezone ?? DEFAULT_TZ) : null;
  if (!day) return null;
  const help = fortyDaysHelp(voice);
  return (
    <section aria-labelledby="forty-days-help" className={cx(tone.card, "p-4")}>
      <h3 id="forty-days-help" className={cx(tone.heading, "flex items-center gap-2 text-[16px]")}>
        <Icon name="soup" size={18} className="mp-kind-ink shrink-0" style={{ color: CARE_COLOR }} />
        {help.heading}
      </h3>
      <p className={cx(tone.body, "mt-1.5 text-[15px] leading-relaxed")}>{help.intro}</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[15px] leading-snug text-mp-ink marker:text-mp-ink-3">
        {(self ? help.you : help.others).map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <VisitorNoteButton className="mt-3" />
      <p className={cx(tone.faint, "mt-2 text-[13px] leading-snug")}>
        From{" "}
        <a href={FORTY_DAYS_BOOK.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
          {FORTY_DAYS_BOOK.label}
        </a>
        {help.sources.map((s) => (
          <span key={s.url}>
            {" · "}
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {s.label}
            </a>
          </span>
        ))}
      </p>
    </section>
  );
}

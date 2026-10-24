"use client";

import { useState } from "react";
import { checkinResponse, daysSinceBirth } from "@/lib/maple/care";
import {
  BLUES_NOTE,
  CHECKIN_NOTE_PLACEHOLDER,
  CHECKIN_SUB,
  CHECKIN_SUGGEST,
  CHECKIN_TITLE,
  FULL_INTRO,
  MOOD_OPTIONS,
  MOOD_TAGS,
  type Assessment,
  type MoodTag,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ, dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { MoodEntry } from "@/lib/maple/types";
import { Icon } from "../icons";
import { AssessmentCard } from "../sheets/parts";
import { Button, SectionTitle, Sheet, TextArea, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import CheckInResultsSheet, { hotlineLinks } from "./CheckInResults";
import CrisisSheet, { CrisisStrip, HelpRow, OnTop } from "./CrisisSheet";
import FullCheckInSheet from "./FullCheckIn";
import { ConfirmSheet, GROUP, NavRow, Problem, errorText } from "./parts";
import { type UseCare, useCare } from "./useCare";

/**
 * "How are you doing?" (§6.1): her daily check-in, HELP_ROW, the fuller
 * check-in row, suggestions and her history. Hers only: renders nothing for
 * anyone else (their state has no mood at all).
 *
 * A habit, never a test: one tap saves, then "Anything else?" offers the
 * chips and a note on the same check-in. No score, streak or graph, and no
 * condition named. What it responds to ignores show_alerts and every other
 * setting: "Thoughts of hurting myself" opens the crisis sheet at once,
 * "Scary thoughts I don't want" shows INTRUSIVE, "Really struggling" shows
 * STRUGGLING, and in the first two weeks BLUES_NOTE sits under the card.
 */

type Checkin = Extract<MoodEntry, { kind: "checkin" }>;
type ScreenEntry = Extract<MoodEntry, { kind: "screen" }>;
type Level = 1 | 2 | 3 | 4 | 5;
type Mood = NonNullable<UseCare["mood"]>;

/** "Change" this soon after a check-in corrects it; later it's a new one (more than one a day is fine). */
const CORRECT_MS = 30 * 60_000;

const levelLabel = (level: number) => MOOD_OPTIONS.find((o) => o.value === level)?.label ?? "";
const tagText = (tags: MoodTag[] | undefined) => (tags ?? []).map((t) => MOOD_TAGS[t]).join(", ");

export function CheckInSection() {
  const care = useCare();
  if (!care?.mood || !care.access.mood) return null;
  return <CheckIn care={care} mood={care.mood} />;
}

export default CheckInSection;

function CheckIn({ care, mood }: { care: UseCare; mood: Mood }) {
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const todayKey = dayKey(t, tz);
  const today = mood.todayCheckin;
  const [changing, setChanging] = useState(false);
  const [extras, setExtras] = useState(false);
  const [crisis, setCrisis] = useState(false);
  const [full, setFull] = useState(false);
  const [history, setHistory] = useState(false);
  const [detail, setDetail] = useState<Checkin | null>(null);
  const [results, setResults] = useState<ScreenEntry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (level: Level) => {
    if (busy) return;
    setProblem(null);
    setChanging(false);
    // A quick change is a correction to the same check-in; later in the day it's another one.
    if (today && changing && t.getTime() - Date.parse(today.at) < CORRECT_MS) {
      if (level !== today.data.level) void care.act.updateCheckin(today.id, { level }).catch((e) => setProblem(errorText(e)));
      setExtras(true);
      return;
    }
    // It shows at once (useCare), so "Anything else?" opens with it rather than after the server answers.
    setExtras(true);
    setBusy(true);
    try {
      await care.act.checkin(level);
    } catch {
      // useCare's toast says why; the choices come back to try again.
    } finally {
      setBusy(false);
    }
  };

  // Today's answers, all of them: an earlier "Really struggling" still means a call today.
  const todays = mood.checkins.filter((c) => dayKey(new Date(c.at), tz) === todayKey);
  const day = daysSinceBirth(state?.baby.born_at ?? null, t, tz);
  const cards: Assessment[] = [];
  let blues = false;
  for (const c of todays) {
    const r = checkinResponse(c.data, { daysSinceBirth: day });
    for (const a of r.cards) if (!cards.some((x) => x.title === a.title)) cards.push(a);
    blues ||= r.blues;
  }
  cards.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  const past = [...mood.checkins, ...(mood.latestScreen ? [mood.latestScreen] : [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
  const asking = !today || changing;

  return (
    <section>
      <SectionTitle>{CHECKIN_TITLE}</SectionTitle>
      <div className="space-y-3">
        <div className={cx(tone.card, "p-4")}>
          <CrisisStrip inset className="mb-3" />
          <p className={cx(tone.muted, "flex items-center gap-1.5 text-[14px] leading-snug")}>
            <Icon name="lock" size={15} className="shrink-0 text-mp-ink-3" />
            {CHECKIN_SUB}
          </p>
          {asking ? (
            <div className="mt-3">
              <Levels value={changing ? today?.data.level : undefined} onPick={(l) => void pick(l)} disabled={busy} />
              {changing && (
                <Button variant="ghost" size="sm" className="-ml-3 mt-1" onClick={() => setChanging(false)}>
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            today && (
              <div className="mt-2">
                <div className="flex min-h-[44px] items-center gap-3">
                  <p className={cx(tone.body, "min-w-0 flex-1 text-[17px] leading-snug")}>
                    Today: <span className="font-semibold">{levelLabel(today.data.level)}</span>
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-3 shrink-0"
                    onClick={() => {
                      setExtras(false);
                      setChanging(true);
                    }}
                  >
                    Change
                  </Button>
                </div>
                {extras ? (
                  // Keyed by its time, which stays put when its temporary id becomes the saved one (a note being typed survives).
                  <Extras key={Date.parse(today.at)} entry={today} care={care} onCrisis={() => setCrisis(true)} onDone={() => setExtras(false)} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setExtras(true)}
                    className="-ml-1 flex min-h-[44px] w-full items-center gap-1.5 rounded-lg px-1 text-left text-[15px] text-mp-ink-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{tagText(today.data.tags) || today.note || "Anything else? (optional)"}</span>
                    <Icon name="pencil" size={15} className="shrink-0 text-mp-ink-3" />
                  </button>
                )}
              </div>
            )
          )}
          <Problem>{problem}</Problem>
          <div className="mt-3 border-t border-mp-line pt-1">
            <HelpRow />
          </div>
        </div>

        {cards.map((a) => (
          <AssessmentCard key={a.title} a={a} audience="mom" more={hotlineLinks(a)} />
        ))}
        {today && blues && (
          <p className={cx(tone.inset, tone.muted, "px-4 py-3 text-[14px] leading-relaxed")}>{BLUES_NOTE}</p>
        )}

        {mood.suggestion && (
          <div className={cx(tone.card, "p-4")}>
            <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{CHECKIN_SUGGEST[mood.suggestion]}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => setFull(true)}>
                Start
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void care.act.dismissSuggestion(mood.suggestion!).catch((e) => setProblem(errorText(e)))}>
                Not now
              </Button>
            </div>
          </div>
        )}

        <div className={GROUP}>
          <NavRow icon="list-checks" label={FULL_INTRO.title} note="PHQ-9 and GAD-7 · about 3 minutes" onClick={() => setFull(true)} />
          {past.length > 0 && (
            <div>
              <button type="button" onClick={() => setHistory((h) => !h)} aria-expanded={history} className={cx(tone.row, "min-h-[52px] py-2.5")}>
                <Icon name="history" size={20} className="shrink-0 text-mp-ink-2" />
                <span className={cx(tone.body, "min-w-0 flex-1 text-[15px]")}>Your check-ins</span>
                <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", history && "rotate-180")} />
              </button>
              {history && (
                <ul className={cx(tone.divide, "border-t border-mp-line")}>
                  {past.map((m) => (
                    <li key={`${m.kind}${m.id}`}>
                      <PastRow
                        m={m}
                        todayKey={todayKey}
                        tz={tz}
                        onOpen={() => (m.kind === "checkin" ? setDetail(m) : setResults(m as ScreenEntry))}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <OnTop>
        <FullCheckInSheet open={full} onClose={() => setFull(false)} />
        <CheckInResultsSheet entry={results} open={!!results} onClose={() => setResults(null)} />
        <CheckInSheet entry={detail} open={!!detail} onClose={() => setDetail(null)} care={care} onCrisis={() => setCrisis(true)} />
        <CrisisSheet open={crisis} onClose={() => setCrisis(false)} audience="her" from="checkin" />
      </OnTop>
    </section>
  );
}

const TIER_ORDER: Assessment["tier"][] = ["emergency", "now", "today", "mention", "nudge"];

/** The five answers, as big pills: one tap saves. */
function Levels({ value, onPick, disabled }: { value?: number; onPick: (l: Level) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={CHECKIN_TITLE} className="flex flex-wrap gap-2">
      {MOOD_OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onPick(o.value)}
          className={cx(
            "inline-flex min-h-[44px] items-center rounded-full px-4 text-[15px] font-medium transition active:scale-[0.97] disabled:opacity-50",
            value === o.value ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink active:bg-mp-ink/10"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * "Anything else? (optional)": the chips and a note on one check-in, saved
 * as she goes (useCare shows them at once). The harm chip opens the crisis
 * sheet the moment it's tapped, before anything reaches the server.
 */
function Extras({
  entry,
  care,
  onCrisis,
  onDone,
}: {
  entry: Checkin;
  care: UseCare;
  onCrisis: () => void;
  onDone?: () => void;
}) {
  const [note, setNote] = useState(entry.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const tags = entry.data.tags ?? [];

  const toggle = (tag: MoodTag) => {
    const on = !tags.includes(tag);
    if (tag === "harm_self" && on) onCrisis();
    setProblem(null);
    void care.act.updateCheckin(entry.id, { tags: on ? [...tags, tag] : tags.filter((x) => x !== tag) }).catch((e) => setProblem(errorText(e)));
  };
  const saveNote = () => {
    if (note.trim() === (entry.note ?? "").trim()) return;
    setProblem(null);
    void care.act.updateCheckin(entry.id, { note }).catch((e) => setProblem(errorText(e)));
  };

  return (
    <div className="mt-2 space-y-3">
      <p className={tone.label}>
        Anything else? <span className="font-normal text-mp-ink-3">(optional)</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(MOOD_TAGS) as MoodTag[]).map((tag) => {
          const on = tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(tag)}
              className={cx(
                "inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3 text-left text-[14px] leading-snug font-medium transition active:scale-[0.97]",
                on ? "bg-mp-accent text-mp-on-accent" : "bg-mp-sunken text-mp-ink active:bg-mp-ink/10"
              )}
            >
              {on && <Icon name="check" size={14} strokeWidth={2.25} className="shrink-0" />}
              {MOOD_TAGS[tag]}
            </button>
          );
        })}
      </div>
      <div onBlur={saveNote}>
        <TextArea value={note} onChange={setNote} placeholder={CHECKIN_NOTE_PLACEHOLDER} rows={2} />
      </div>
      <Problem>{problem}</Problem>
      {onDone && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="-mr-3"
            onClick={() => {
              saveNote();
              onDone();
            }}
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}

/** One row of "Your check-ins": "Thu, Oct 29 · Low · Tearful, Overwhelmed", her note under it, the time on the right. */
function PastRow({ m, todayKey, tz, onOpen }: { m: MoodEntry; todayKey: string; tz: string; onOpen: () => void }) {
  const day = formatDayLabel(dayKey(new Date(m.at), tz), todayKey);
  const line =
    m.kind === "checkin"
      ? [day, levelLabel(m.data.level), tagText(m.data.tags)].filter(Boolean).join(" · ")
      : `${day} · ${FULL_INTRO.title}${m.data.complete ? "" : " · unfinished"}`;
  return (
    <button type="button" onClick={onOpen} className={cx(tone.row, "min-h-[52px] py-2.5")}>
      <span className="min-w-0 flex-1">
        <span className={cx(tone.body, "block text-[15px] leading-snug")}>{line}</span>
        {m.note && <span className={cx(tone.muted, "mt-0.5 block truncate text-[13px]")}>{m.note}</span>}
      </span>
      <span className={cx(tone.faint, "shrink-0 text-[13px] tabular-nums")}>
        {formatTime(m.at, tz)}
        {m.pending ? " · not synced" : ""}
      </span>
      <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
    </button>
  );
}

/** One past check-in: its answer, chips and note to change, the cards they call for, and a hard delete. */
function CheckInSheet({
  entry,
  open,
  onClose,
  care,
  onCrisis,
}: {
  entry: Checkin | null;
  open: boolean;
  onClose: () => void;
  care: UseCare;
  onCrisis: () => void;
}) {
  const { state, now } = useMaple();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Keep the last one while the sheet slides away; read the live copy so chips show as they're tapped.
  const [shown, setShown] = useState<Checkin | null>(entry);
  if (entry && entry !== shown && entry.id !== shown?.id) setShown(entry);
  const base = entry ?? shown;
  const live = base ? (care.mood?.checkins.find((c) => c.id === base.id) ?? base) : null;
  if (!live) return null;
  const when = `${formatDayLabel(dayKey(new Date(live.at), tz), dayKey(now(), tz))} · ${formatTime(live.at, tz)}`;
  const cards = checkinResponse(live.data, { daysSinceBirth: null }).cards;

  const remove = async () => {
    setBusy(true);
    try {
      await care.act.deleteMood(live.id);
      setConfirm(false);
      onClose();
    } catch {
      // useCare's toast says why; the confirm stays open to try again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Your check-in"
        subtitle={when}
        footer={
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className={cx(tone.muted, "flex items-center gap-1.5 text-[14px] leading-snug")}>
          <Icon name="lock" size={15} className="shrink-0 text-mp-ink-3" />
          {CHECKIN_SUB}
        </p>
        <div>
          <Levels
            value={live.data.level}
            onPick={(level) => {
              setProblem(null);
              if (level !== live.data.level) void care.act.updateCheckin(live.id, { level }).catch((e) => setProblem(errorText(e)));
            }}
          />
          <Problem>{problem}</Problem>
        </div>
        <Extras key={Date.parse(live.at)} entry={live} care={care} onCrisis={onCrisis} />
        {cards.map((a) => (
          <AssessmentCard key={a.title} a={a} audience="mom" more={hotlineLinks(a)} />
        ))}
        <HelpRow />
        <div className="flex justify-center pb-1">
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
            <Icon name="trash-2" size={16} />
            Delete this check-in
          </Button>
        </div>
      </Sheet>
      <OnTop>
        <ConfirmSheet
          open={open && confirm}
          onClose={() => setConfirm(false)}
          title="Delete this check-in for good?"
          body="It's gone from Maple's Log for good, not hidden. This can't be undone."
          confirm="Delete for good"
          danger
          busy={busy}
          onConfirm={() => void remove()}
        />
      </OnTop>
    </>
  );
}

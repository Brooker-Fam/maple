"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { checkinResponse, daysSinceBirth } from "@/lib/maple/care";
import {
  BLUES_NOTE,
  CHECKIN_NOTE_PLACEHOLDER,
  CHECKIN_SUB,
  CHECKIN_TITLE,
  FULL_INTRO,
  MOOD_OPTIONS,
  checkinSuggest,
  moodTags,
  type Assessment,
  type MoodTag,
} from "@/lib/maple/guidelines";
import { DEFAULT_TZ, dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { MoodEntry } from "@/lib/maple/types";
import { useVoice } from "../familyWords";
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
type ExtrasTarget = { entry: Checkin; key: number } | { after: number[] };

/** "Change" this soon after a check-in corrects it; later it's a new one (more than one a day is fine). */
const CORRECT_MS = 30 * 60_000;

const levelLabel = (level: number) => MOOD_OPTIONS.find((o) => o.value === level)?.label ?? "";
const tagText = (tags: MoodTag[] | undefined, labels: Record<MoodTag, string>) => (tags ?? []).map((t) => labels[t]).join(", ");

export function CheckInSection() {
  const care = useCare();
  if (!care?.mood || !care.access.mood) return null;
  return <CheckIn care={care} mood={care.mood} />;
}

export default CheckInSection;

function CheckIn({ care, mood }: { care: UseCare; mood: Mood }) {
  const { state, now } = useMaple();
  const voice = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const t = now();
  const todayKey = dayKey(t, tz);
  const today = mood.todayCheckin;
  const [changing, setChanging] = useState(false);
  const [extras, setExtras] = useState<ExtrasTarget | null>(null);
  const [crisis, setCrisis] = useState(false);
  const [full, setFull] = useState(false);
  const [history, setHistory] = useState(false);
  const [detail, setDetail] = useState<Checkin | null>(null);
  const [results, setResults] = useState<ScreenEntry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const creationHarmEver = useRef(false);
  const saveExtras = useRef<(() => Promise<boolean>) | null>(null);
  // Keep editing this check-in when another phone adds a newer one. Its
  // temporary id can change after saving; its recorded time stays the same.
  const pinned = extras && "entry" in extras ? extras.entry : null;
  const current = pinned
    ? mood.checkins.find((entry) => entry.id === pinned.id)
      ?? (pinned.id < 0 ? mood.checkins.find((entry) => Date.parse(entry.at) === Date.parse(pinned.at)) : null)
      ?? pinned
    : extras && "after" in extras
      ? mood.checkins.find((entry) => !extras.after.includes(entry.id)) ?? null
      : today;
  if (current && extras && ("after" in extras || (pinned && pinned.id < 0 && current.id > 0))) setExtras({ entry: current, key: "entry" in extras ? extras.key : Date.parse(current.at) });

  const pick = async (level: Level) => {
    if (busy) return;
    setProblem(null);
    setCreationError(null);
    creationHarmEver.current = false;
    setChanging(false);
    // A quick change is a correction to the same check-in; later in the day it's another one.
    if (today && changing && t.getTime() - Date.parse(today.at) < CORRECT_MS) {
      if (level !== today.data.level) void care.act.updateCheckin(today.id, { level }).catch((e) => setProblem(errorText(e)));
      setExtras({ entry: today, key: Date.parse(today.at) });
      return;
    }
    // It shows at once (useCare), so "Anything else?" opens with it rather than after the server answers.
    setExtras({ after: mood.checkins.map((entry) => entry.id) });
    setBusy(true);
    try {
      await care.act.checkin(level);
    } catch (error) {
      // Keep the optimistic entry's open note/tags, but never call it saved.
      setCreationError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const retryCreation = async () => {
    if (busy || !current || !extras || !("entry" in extras)) return;
    setBusy(true);
    try {
      const saved = await care.act.checkin(current.data.level, { at: current.at, harmEver: creationHarmEver.current || current.data.harm_ever });
      if (saved.kind === "checkin") setExtras({ entry: saved, key: extras.key });
      setCreationError(null);
    } catch (error) {
      setCreationError(errorText(error));
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
    const r = checkinResponse(c.data, { daysSinceBirth: day, voice });
    for (const a of r.cards) if (!cards.some((x) => x.title === a.title)) cards.push(a);
    blues ||= r.blues;
  }
  cards.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

  const past = [...mood.checkins, ...(mood.latestScreen ? [mood.latestScreen] : [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id - a.id);
  const asking = !current || changing;

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
            current && (
              <div className="mt-2">
                <div className="flex min-h-[44px] items-center gap-3">
                  <p className={cx(tone.body, "min-w-0 flex-1 text-[17px] leading-snug")}>
                    Today: <span className="font-semibold">{levelLabel(current.data.level)}</span>
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-mr-3 shrink-0"
                    data-checkin-save
                    disabled={busy || !!creationError}
                    onClick={async () => {
                      if (saveExtras.current && !(await saveExtras.current())) return;
                      setExtras(null);
                      setChanging(true);
                    }}
                  >
                    Change
                  </Button>
                </div>
                {extras ? (
                  // Keep this editing session through both id sync and a retried creation.
                  <Extras key={"entry" in extras ? extras.key : Date.parse(current.at)} entry={current} care={care} onCrisis={() => { creationHarmEver.current = true; setCrisis(true); }} onDone={() => setExtras(null)} saveRef={saveExtras} creationBusy={busy} creationError={creationError} onRetryCreation={() => void retryCreation()} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setExtras({ entry: current, key: Date.parse(current.at) })}
                    className="-ml-1 flex min-h-[44px] w-full items-center gap-1.5 rounded-lg px-1 text-left text-[15px] text-mp-ink-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{tagText(current.data.tags, moodTags(voice)) || current.note || "Anything else? (optional)"}</span>
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
            <p className={cx(tone.body, "text-[15px] leading-relaxed")}>{checkinSuggest(voice)[mood.suggestion]}</p>
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

type ExtrasInput = { note: string; tags: MoodTag[] };
type ExtrasDraft = ExtrasInput & { harmEver: boolean };

function useExtrasDraft(entry: Checkin, care: UseCare, blocked = false) {
  const [note, setNote] = useState(entry.note ?? "");
  const [tags, setTags] = useState<MoodTag[]>(entry.data.tags ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const harmEver = useRef(!!entry.data.harm_ever || !!entry.data.tags?.includes("harm_self"));
  const initial = { note: entry.note ?? "", tags: entry.data.tags ?? [], harmEver: harmEver.current };
  const saved = useRef(initial);
  const [savedKey, setSavedKey] = useState(() => extrasKey(initial));
  const pending = useRef<{ key: string; id: number; promise: Promise<boolean> } | null>(null);
  const sequence = useRef(0);
  const latest = useRef({ note, tags, harmEver: harmEver.current });
  latest.current = { note, tags, harmEver: harmEver.current };
  const dirty = extrasKey(latest.current) !== savedKey;

  useEffect(() => { if (!blocked) setProblem(null); }, [blocked]);

  useEffect(() => {
    const current = latest.current.tags;
    const acknowledged = saved.current.tags;
    const changed = new Set([...current, ...acknowledged].filter((tag) => current.includes(tag) !== acknowledged.includes(tag)));
    const remote = entry.data.tags ?? [];
    const merged = [...remote.filter((tag) => !changed.has(tag)), ...current.filter((tag) => changed.has(tag))];
    saved.current = { ...saved.current, tags: [...remote.filter((tag) => !changed.has(tag)), ...acknowledged.filter((tag) => changed.has(tag))] };
    setSavedKey(extrasKey(saved.current));
    setTags(merged);
  }, [entry.data.tags]);

  const save = (input: ExtrasInput): Promise<boolean> => {
    // Clearing a crisis tag never clears the fact that it was selected,
    // including when creation or its retry has not reached the server yet.
    harmEver.current ||= input.tags.includes("harm_self");
    const draft: ExtrasDraft = { ...input, harmEver: harmEver.current };
    if (blocked) return Promise.resolve(false);
    const key = extrasKey(draft);
    if (pending.current?.key === key) return pending.current.promise;
    if (!pending.current && key === extrasKey(saved.current)) return Promise.resolve(true);
    const previous = pending.current?.promise;
    const request = ++sequence.current;
    setSaving(true);
    setProblem(null);
    const promise = Promise.resolve(previous).then(async () => {
      try {
        const patch = {
          ...(draft.note.trim() !== saved.current.note.trim() ? { note: draft.note } : {}),
          ...(tagKey(draft.tags) !== tagKey(saved.current.tags) ? { tags: draft.tags } : {}),
          ...(draft.harmEver && !saved.current.harmEver && !draft.tags.includes("harm_self") ? { harmEver: true as const } : {}),
        };
        if (Object.keys(patch).length) await care.act.updateCheckin(entry.id, patch);
        saved.current = draft;
        setSavedKey(key);
        if (pending.current?.id === request) setProblem(null);
        return true;
      } catch (e) {
        if (pending.current?.id === request) setProblem(errorText(e));
        return false;
      } finally {
        if (pending.current?.id === request) { pending.current = null; setSaving(false); }
      }
    });
    pending.current = { key, id: request, promise };
    return promise;
  };
  const saveCurrent = async () => {
    const draft = latest.current;
    return await save(draft) && extrasKey(latest.current) === extrasKey(draft);
  };
  return { note, setNote, tags, setTags, problem, saving, dirty, save, saveCurrent };
}

function useCheckinNavigationGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const beforeNavigate = (event: Event) => {
      if (!event.defaultPrevented && !window.confirm("Leave and discard your unsaved check-in changes?")) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("maple-before-navigate", beforeNavigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("maple-before-navigate", beforeNavigate);
    };
  }, [active]);
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
  saveRef,
  onDirtyChange,
  onSavingChange,
  creationBusy = false,
  creationError = null,
  onRetryCreation,
}: {
  entry: Checkin;
  care: UseCare;
  onCrisis: () => void;
  onDone?: () => void;
  saveRef: RefObject<(() => Promise<boolean>) | null>;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange?: (saving: boolean) => void;
  creationBusy?: boolean;
  creationError?: string | null;
  onRetryCreation?: () => void;
}) {
  const { note, setNote, tags, setTags, problem, saving, dirty, save, saveCurrent } = useExtrasDraft(entry, care, !!creationError);
  const labels = moodTags(useVoice());
  useCheckinNavigationGuard(!!onDone && (dirty || saving || creationBusy || !!creationError));
  const recoveringCreation = useRef(false);
  useEffect(() => {
    if (creationError) recoveringCreation.current = true;
    else if (recoveringCreation.current) {
      recoveringCreation.current = false;
      // Retry saves the retained extras too, including any crisis tag picked
      // while the first request was failing. This render has the new saved id.
      void saveCurrent();
    }
  }, [creationError, saveCurrent]);
  useEffect(() => {
    saveRef.current = saveCurrent;
    return () => { saveRef.current = null; };
  });
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
    return () => onDirtyChange?.(false);
  }, [dirty, saving, onDirtyChange]);
  useEffect(() => {
    onSavingChange?.(saving);
    return () => onSavingChange?.(false);
  }, [saving, onSavingChange]);

  const toggle = (tag: MoodTag) => {
    const on = !tags.includes(tag);
    if (tag === "harm_self" && on) onCrisis();
    const next = on ? [...tags, tag] : tags.filter((x) => x !== tag);
    setTags(next);
    void save({ note, tags: next });
  };

  return (
    <div className="mt-2 space-y-3">
      <p className={tone.label}>
        Anything else? <span className="font-normal text-mp-ink-3">(optional)</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(labels) as MoodTag[]).map((tag) => {
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
              {labels[tag]}
            </button>
          );
        })}
      </div>
      <div onBlur={(event) => {
        if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest("[data-checkin-save]"))) void saveCurrent();
      }}>
        <TextArea value={note} onChange={setNote} placeholder={CHECKIN_NOTE_PLACEHOLDER} rows={2} />
      </div>
      <p role="status" className={cx(tone.muted, "text-[13px]")}>
        {creationBusy ? "Saving check-in…" : creationError ? "Check-in not saved · your changes are still here" : saving ? "Saving changes…" : dirty ? "Unsaved changes" : entry.pending ? "Saved on this phone · not synced" : "Check-in saved"}
      </p>
      <Problem>{creationError ?? problem}</Problem>
      {creationError ? <Button variant="soft" size="sm" data-checkin-save disabled={creationBusy} onClick={onRetryCreation}>Retry check-in</Button>
        : problem && <Button variant="soft" size="sm" data-checkin-save disabled={saving} onClick={() => void saveCurrent()}>Try again</Button>}
      {onDone && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="-mr-3"
            data-checkin-save
            disabled={saving || creationBusy || !!creationError}
            onClick={async () => {
              if (await saveCurrent()) onDone();
            }}
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Done"}
          </Button>
        </div>
      )}
    </div>
  );
}

const tagKey = (tags: MoodTag[]) => [...tags].sort().join(",");
const extrasKey = (draft: ExtrasDraft) => JSON.stringify({ note: draft.note.trim(), tags: tagKey(draft.tags), harmEver: draft.harmEver });

/** One row of "Your check-ins": "Thu, Oct 29 · Low · Tearful, Overwhelmed", her note under it, the time on the right. */
function PastRow({ m, todayKey, tz, onOpen }: { m: MoodEntry; todayKey: string; tz: string; onOpen: () => void }) {
  const labels = moodTags(useVoice());
  const day = formatDayLabel(dayKey(new Date(m.at), tz), todayKey);
  const line =
    m.kind === "checkin"
      ? [day, levelLabel(m.data.level), tagText(m.data.tags, labels)].filter(Boolean).join(" · ")
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
  const voice = useVoice();
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [extrasDirty, setExtrasDirty] = useState(false);
  const [extrasSaving, setExtrasSaving] = useState(false);
  const saveExtras = useRef<(() => Promise<boolean>) | null>(null);
  // Keep the last one while the sheet slides away; read the live copy so chips show as they're tapped.
  const [shown, setShown] = useState<Checkin | null>(entry);
  if (entry && entry !== shown && entry.id !== shown?.id) setShown(entry);
  const base = entry ?? shown;
  const live = base ? (care.mood?.checkins.find((c) => c.id === base.id) ?? base) : null;
  if (!live) return null;
  const when = `${formatDayLabel(dayKey(new Date(live.at), tz), dayKey(now(), tz))} · ${formatTime(live.at, tz)}`;
  const cards = checkinResponse(live.data, { daysSinceBirth: null, voice }).cards;

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
        dirty={extrasDirty}
        onClose={onClose}
        title="Your check-in"
        subtitle={when}
        footer={
          <Button size="lg" className="w-full" data-checkin-save disabled={extrasSaving} onClick={async () => { if (!saveExtras.current || await saveExtras.current()) onClose(); }}>
            {extrasSaving ? "Saving…" : extrasDirty ? "Save changes" : "Done"}
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
        <Extras key={Date.parse(live.at)} entry={live} care={care} onCrisis={onCrisis} saveRef={saveExtras} onDirtyChange={setExtrasDirty} onSavingChange={setExtrasSaving} />
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

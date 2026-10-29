"use client";

import { useCallback, useRef, useState } from "react";
import type { EncodedPhoto } from "@/lib/maple/image";
import { milestoneLabel, milestonesFor } from "@/lib/maple/milestones";
import { zonedTimeToUtc } from "@/lib/maple/time";
import type { EntryOf } from "@/lib/maple/types";
import { useBabyWords, useMilestoneWords } from "../familyWords";
import { Icon } from "../icons";
import { Chip, Field, TextArea, WhenField, cx, tone } from "../ui";
import { Label, presetStart } from "../sheets/parts";
const COLLAPSED_CHIPS = 8;

export function useMomentDraft(moment: EntryOf<"moment"> | undefined, preset: Record<string, unknown> | undefined, tz: string, now: () => Date) {
  const str = (value: unknown) => typeof value === "string" ? value : "";
  const [title, setTitle] = useState(moment?.data.title ?? str(preset?.title));
  const [milestone, setMilestone] = useState(moment?.data.milestone ?? str(preset?.milestone));
  const [note, setNote] = useState(moment?.note ?? str(preset?.note));
  const [when, setWhen] = useState<Date | null>(moment ? new Date(moment.started_at) : presetStart(preset));
  const [timeInvalid, setTimeInvalid] = useState(false);
  const [whenFromPhoto, setWhenFromPhoto] = useState(false);
  const whenTouched = useRef(!!moment || !!presetStart(preset));
  const adoptPhotoTime = useCallback((taken: EncodedPhoto["takenAt"]) => {
    if (!taken || whenTouched.current) return;
    const at = zonedTimeToUtc(taken.year, taken.month, taken.day, taken.hour, taken.minute, tz);
    const age = now().getTime() - at.getTime();
    if (Number.isNaN(age) || age < 10 * 60_000 || age > 400 * 864e5) return;
    whenTouched.current = true;
    setWhen(at);
    setWhenFromPhoto(true);
  }, [now, tz]);
  const changeWhen = (value: Date | null) => { whenTouched.current = true; setWhenFromPhoto(false); setWhen(value); };
  return { title, setTitle, milestone, setMilestone, note, setNote, when, changeWhen, timeInvalid, setTimeInvalid, whenFromPhoto, adoptPhotoTime };
}

export function MomentDetails({ draft, tz }: { draft: ReturnType<typeof useMomentDraft>; tz: string }) {
  const { title, setTitle, milestone, setMilestone, note, setNote, when, changeWhen, setTimeInvalid, whenFromPhoto } = draft;
  const w = useBabyWords();
  const mw = useMilestoneWords();
  const presets = milestonesFor(mw);
  const [showAllChips, setShowAllChips] = useState(() => presets.findIndex((value) => value.id === milestone) >= COLLAPSED_CHIPS);
  const custom = milestone && !presets.some((value) => value.id === milestone) ? milestone : null;
  const chips = showAllChips ? presets : presets.slice(0, COLLAPSED_CHIPS);
  return <>
    <Field label="Title">
      <input
        value={title}
        maxLength={120}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={milestone ? milestoneLabel(milestone, mw) : "What happened?"}
        className={tone.input}
      />
    </Field>

    <div>
      <Label optional>A first?</Label>
      <div className="flex flex-wrap gap-2">
        {custom && (
          <Chip selected onClick={() => setMilestone("")}>
            {milestoneLabel(custom, mw)}
            <Icon name="x" size={14} strokeWidth={2.25} label="Remove" />
          </Chip>
        )}
        {chips.map((m) => (
          <Chip key={m.id} selected={milestone === m.id} onClick={() => setMilestone(milestone === m.id ? "" : m.id)}>
            {m.label}
          </Chip>
        ))}
        {!showAllChips && (
          <button
            type="button"
            onClick={() => setShowAllChips(true)}
            className="inline-flex min-h-[40px] items-center gap-1 px-2 text-sm font-medium text-mp-accent-fg"
          >
            More firsts
            <Icon name="chevron-down" size={16} />
          </button>
        )}
      </div>
    </div>

    <Field label="Note">
      <TextArea value={note} onChange={setNote} rows={3} placeholder={`A few words for ${w.name} to read someday…`} />
    </Field>

    <div>
      <WhenField
        value={when}
        onInvalidChange={setTimeInvalid}
        onChange={changeWhen}
        tz={tz}
        offsets={[1, 5, 30, 60, 180]}
      />
      {whenFromPhoto && (
        <p className={cx(tone.muted, "mt-1.5 flex items-center gap-1.5 text-xs")}>
          <Icon name="camera" size={14} className="shrink-0 text-mp-ink-3" />
          Set from when the photo was taken.
        </p>
      )}
    </div>
  </>;
}

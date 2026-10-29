"use client";

import { useRef, useState } from "react";
import { milestoneLabel } from "@/lib/maple/milestones";
import { dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { EntryOf } from "@/lib/maple/types";
import { useMilestoneWords } from "../familyWords";
import { SafeImg } from "../MomentPhotos";
import { MomentDetails, useMomentDraft } from "../moments/MomentDetails";
import MomentPhotoPicker from "../moments/MomentPhotoPicker";
import { momentPhotoUrl } from "../moments/photo";
import { useMomentPhotos } from "../moments/useMomentPhotos";
import { Button, Sheet, cx, tone } from "../ui";
import { useDraftChanged } from "../useDraftChanged";
import { ApiError, useMaple } from "../useMaple";
import type { SheetProps } from "./index";
import { LoggedBy, SheetFooter, useOpenCount } from "./parts";

type Moment = EntryOf<"moment">;

export default function MomentSheet(props: SheetProps) {
  const n = useOpenCount(props.open);
  const [replacement, setReplacement] = useState<{ open: number; entry: Moment } | null>(null);
  const entry = replacement?.open === n ? replacement.entry : props.entry;
  return <MomentForm key={`${n}-${replacement?.open === n ? replacement.entry.updated_at : "initial"}`} {...props} entry={entry} onReload={(entry) => setReplacement({ open: n, entry })} />;
}

function useMomentSave(moment: Moment | undefined, draft: ReturnType<typeof useMomentDraft>, photos: ReturnType<typeof useMomentPhotos>, onClose: () => void) {
  const { update, log } = useMaple();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Moment | null>(null);
  const save = async () => {
    setSaving(true);
    setError("");
    const data = { title: draft.title.trim() || null, milestone: draft.milestone || null, photos: photos.done.map((item) => item.ref!) };
    const patch = { started_at: draft.when?.toISOString(), data, note: draft.note.trim() || null };
    photos.markSaved(true);
    try {
      if (moment) {
        const result = await update(moment.id, { ...patch, expect_updated_at: moment.updated_at }, { toast: "Moment saved", throwOnError: true });
        if (result) onClose();
        else { photos.markSaved(false); setError("This moment is still syncing. Your draft is still here. Try saving again once it finishes."); }
      } else {
        const result = await log({ kind: "moment", ...patch, data: { ...data, title: data.title || undefined, milestone: data.milestone || undefined } }, { toast: data.photos.length ? `Moment saved · ${data.photos.length} photo${data.photos.length === 1 ? "" : "s"}` : "Moment saved" });
        if (result) onClose();
        else { photos.markSaved(false); setError("Couldn't save this moment. Your draft is still here. Try again."); }
      }
    } catch (err) {
      const uncertain = !(err instanceof ApiError) || err.status >= 500 || err.status === 408;
      if (uncertain) photos.retainUploads();
      photos.markSaved(false);
      const body = err instanceof ApiError ? err.body as { entry?: Moment; reason?: string } | null : null;
      if (err instanceof ApiError && err.status === 409 && body?.entry?.kind === "moment") setConflict(body.entry);
      else setError(`${uncertain ? "Couldn't confirm the save." : "Couldn't save this moment."} Your draft is still here. Try again.`);
    } finally { setSaving(false); }
  };
  return { saving, error, conflict, save };
}

function MomentForm({ open, onClose, entry, preset, onReload }: SheetProps & { onReload: (entry: Moment) => void }) {
  const { state, remove, toast, now, readOnly } = useMaple();
  const moment = entry?.kind === "moment" ? entry : undefined;
  const tz = state?.baby.timezone ?? "America/New_York";
  const draft = useMomentDraft(moment, preset, tz, now);
  const photos = useMomentPhotos({ moment, open, readOnly, familyId: state?.family?.id, toast, adoptPhotoTime: draft.adoptPhotoTime });
  const { saving, error, conflict, save } = useMomentSave(moment, draft, photos, onClose);
  const dirty = useDraftChanged({ title: draft.title, milestone: draft.milestone, note: draft.note, when: draft.when, timeInvalid: draft.timeInvalid, photos: photos.items.map((item) => item.id) });
  const locked = useRef(false);
  const hasWords = !!(draft.title.trim() || draft.milestone || draft.note.trim());
  const canSave = open && !draft.timeInvalid && !readOnly && !saving && !photos.uploading && !conflict && (!!moment || hasWords || photos.done.length > 0);
  const submit = () => { if (canSave && !locked.current) { locked.current = true; void save().finally(() => { locked.current = false; }); } };
  const label = photos.uploading ? `Uploading ${photos.pending} photo${photos.pending === 1 ? "" : "s"}…`
    : photos.failed ? `Save without ${photos.failed} photo${photos.failed === 1 ? "" : "s"}` : moment ? "Save changes" : "Save moment";
  const footer = readOnly ? <Button className="w-full" onClick={onClose}>Done</Button> : <fieldset disabled={saving} className="min-w-0"><SheetFooter onClose={onClose} onDelete={moment ? () => { onClose(); void remove(moment.id, { toast: "Moment removed" }); } : undefined} onPrimary={submit} disabled={!canSave} busy={saving} label={label} /></fieldset>;
  return <Sheet open={open} onClose={onClose} dirty={!readOnly && dirty} locked={saving} title={readOnly ? "Moment" : moment ? "Edit moment" : "New moment"} footer={footer}>
    {readOnly ? moment && <ReadMoment moment={moment} tz={tz} now={now()} /> : <>
      {error && <p role="alert" className="text-sm text-mp-danger">{error}</p>}
      {conflict && <div role="alert" className={cx(tone.inset, "space-y-3 p-4")}>
        <p className={cx(tone.body, "text-sm")}>Someone changed this moment while you were editing. Your draft is still here. Load their version to start again.</p>
        <Button variant="soft" onClick={() => onReload(conflict)}>Discard draft and load latest</Button>
      </div>}
      <fieldset disabled={saving} aria-busy={saving} className="min-w-0 space-y-5">
        {moment && <LoggedBy entry={moment} />}
        <MomentPhotoPicker photos={photos} />
        <MomentDetails draft={draft} tz={tz} />
      </fieldset>
    </>}
  </Sheet>;
}

function ReadMoment({ moment, tz, now }: { moment: Moment; tz: string; now: Date }) {
  const mw = useMilestoneWords();
  const label = milestoneLabel(moment.data.milestone, mw);
  const heading = moment.data.title || label || "A little moment";
  return <>
    <LoggedBy entry={moment} />
    <div className="grid grid-cols-3 gap-2">{moment.data.photos?.map((photo, index) => <SafeImg key={photo.id ?? index} src={momentPhotoUrl(moment.id, photo, index)} className="aspect-square rounded-xl object-cover" />)}</div>
    <div>{label && label !== heading && <p className="mb-1 text-[13px] font-semibold text-mp-accent-fg">{label}</p>}
      <p className={cx(tone.heading, "text-[22px] leading-snug")}>{heading}</p>
      {moment.note && <p className={cx(tone.body, "mt-1.5 text-[15px] leading-relaxed whitespace-pre-line")}>{moment.note}</p>}
      <p className={cx(tone.faint, "mt-2.5 text-[13px]")}>{formatDayLabel(dayKey(new Date(moment.started_at), tz), dayKey(now, tz))} · {formatTime(moment.started_at, tz)}</p>
    </div>
  </>;
}

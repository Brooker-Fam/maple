"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/maple/client-request";
import { memoryApplies, memoryLapsed, MEMORY_PRIORITY, reviewDue } from "@/lib/maple/memory/policy";
import {
  MEMORY_FACT_MAX,
  MEMORY_KINDS,
  MEMORY_KIND_HINT,
  MEMORY_KIND_LABEL,
  MEMORY_REASON_MAX,
  MEMORY_VIA_LABEL,
  type MemoryKind,
  type MemoryList,
  type MemoryRecord,
} from "@/lib/maple/memory/types";
import { dayKey, DEFAULT_TZ, formatDayLabel } from "@/lib/maple/time";
import { useAskWho, useBabyWords } from "../familyWords";
import { Button, Chip, cx, EmptyState, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useSettingsDraft } from "./DraftContext";
import { Disclosure, Footnote, GROUP, InputRow, Section, Toggle } from "./parts";

/**
 * Settings → Memories: what Maple chat and connected assistants keep in mind
 * for the family (memory/store.ts), one card each, with where it came from.
 * Owners and members add, edit, resolve, archive and forget them and work
 * the two switches; viewers read. Read when the page opens and again when
 * the app comes back to the front, never polled.
 */

type Draft = { id?: number; revision?: number; kind: MemoryKind; fact: string; reason: string; valid_from: string; valid_to: string; review_on: string };

const EMPTY: Draft = { kind: "feeding", fact: "", reason: "", valid_from: "", valid_to: "", review_on: "" };

const draftOf = (m: MemoryRecord): Draft => ({
  id: m.id,
  revision: m.revision,
  kind: m.kind,
  fact: m.fact,
  reason: m.reason ?? "",
  valid_from: m.valid_from ?? "",
  valid_to: m.valid_to ?? "",
  review_on: m.review_on ?? "",
});

const sameDraft = (a: Draft, b: Draft) => JSON.stringify({ ...a, id: 0, revision: 0 }) === JSON.stringify({ ...b, id: 0, revision: 0 });

const ENDED: Record<Exclude<MemoryRecord["status"], "active">, string> = { superseded: "Replaced", resolved: "Resolved", archived: "Archived" };

export default function MemorySettings({ active }: { active: boolean }) {
  const { api, toast, memberName, state } = useMaple();
  const w = useBabyWords();
  const askWho = useAskWho();
  const [list, setList] = useState<MemoryList | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ start: Draft; now: Draft } | null>(null);
  const [confirm, setConfirm] = useState<number | "all" | null>(null);
  const [past, setPast] = useState(false);
  useSettingsDraft("memory-editor", !!draft && !sameDraft(draft.start, draft.now));

  const load = useCallback(async () => {
    try {
      setList(await api<MemoryList>("/api/maple/memories"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    if (!active) return;
    void load();
    const back = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [active, load]);

  /** "ok", the refusal's code on a 409 (the list comes back as it is now), or "error". */
  const send = async (body: Record<string, unknown>, done: string): Promise<string> => {
    setBusy(true);
    try {
      setList(await api<MemoryList>("/api/maple/memories", { method: "POST", body: JSON.stringify(body) }));
      toast(done);
      return "ok";
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409 ? (e.body as { error?: string; code?: string; list?: MemoryList } | null) : null;
      if (conflict?.list) setList(conflict.list);
      toast(conflict?.error ?? (e instanceof Error ? e.message : "Couldn't save that"), { tone: "error" });
      return conflict?.code ?? "error";
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    const d = draft.now;
    const memory = { kind: d.kind, fact: d.fact, reason: d.reason || null, valid_from: d.valid_from || null, valid_to: d.valid_to || null, review_on: d.review_on || null };
    const result = d.id
      ? await send({ action: "correct", id: d.id, revision: d.revision, memory }, "Memory updated")
      : await send({ action: "save", memory }, "Memory saved");
    // Someone else changed or removed it: close the editor so what it says now shows. Another memory's words (duplicate) keep it open.
    if (result === "ok" || result === "changed" || result === "missing") setDraft(null);
  };

  if (!list) {
    return (
      <Section title="Saved memories">
        <div className={cx(GROUP, "px-4 py-6 text-center")}>
          {failed ? (
            <>
              <p className={cx(tone.muted, "text-[15px]")}>Couldn&apos;t load your family&apos;s memories.</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => void load()}>
                Try again
              </Button>
            </>
          ) : (
            <p className={cx(tone.muted, "text-[15px]")}>Loading…</p>
          )}
        </div>
      </Section>
    );
  }

  const { today, canEdit } = list;
  const tz = state?.baby.timezone || DEFAULT_TZ;
  const day = (key: string) => formatDayLabel(key, today);
  const dayOf = (at: string) => day(dayKey(new Date(at), tz));
  const current = list.records
    .filter((m) => memoryApplies(m, today))
    .sort((a, b) => MEMORY_PRIORITY.indexOf(a.kind) - MEMORY_PRIORITY.indexOf(b.kind) || b.stated_at.localeCompare(a.stated_at));
  const earlier = list.records.filter((m) => !memoryApplies(m, today)).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const editingId = draft?.now.id;

  const dates = (m: MemoryRecord): string[] => {
    const out: string[] = [];
    if (m.status !== "active") out.push(`${ENDED[m.status]} ${dayOf(m.ended_at ?? m.updated_at)}${m.ended_by ? ` by ${memberName(m.ended_by)}` : ""}`);
    else if (memoryLapsed(m, today)) out.push(`Ended ${day(m.valid_to!)}`);
    else {
      if (m.valid_from && m.valid_from > today) out.push(`From ${day(m.valid_from)}`);
      if (m.valid_to) out.push(`Until ${day(m.valid_to)}`);
      if (m.review_on && !reviewDue(m, today)) out.push(`Check again ${day(m.review_on)}`);
    }
    return out;
  };

  const editor = (
    <div className="space-y-3 px-4 py-3.5">
      {draft && (
        <>
          <div role="group" aria-label="What it's about" className="flex flex-wrap gap-2">
            {MEMORY_KINDS.map((k) => (
              <Chip key={k} selected={draft.now.kind === k} onClick={() => setDraft({ ...draft, now: { ...draft.now, kind: k } })}>
                {MEMORY_KIND_LABEL[k]}
              </Chip>
            ))}
          </div>
          <p className={cx(tone.faint, "text-[13px]")}>{MEMORY_KIND_HINT[draft.now.kind].replace("the baby", w.name)}</p>
          <label className="block">
            <span className={tone.label}>What to remember</span>
            <textarea
              className={cx(tone.input, "mt-1 min-h-[88px] resize-y")}
              maxLength={MEMORY_FACT_MAX}
              value={draft.now.fact}
              placeholder={`${w.Name} takes sensitive formula; regular formula upsets ${w.his} stomach.`}
              onChange={(e) => setDraft({ ...draft, now: { ...draft.now, fact: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className={tone.label}>Why (optional)</span>
            <input className={cx(tone.input, "mt-1")} maxLength={MEMORY_REASON_MAX} value={draft.now.reason} onChange={(e) => setDraft({ ...draft, now: { ...draft.now, reason: e.target.value } })} />
          </label>
          <div className={cx(tone.inset, tone.divide, "overflow-hidden")}>
            <InputRow type="date" label="Starts" value={draft.now.valid_from} onChange={(e) => setDraft({ ...draft, now: { ...draft.now, valid_from: e.target.value } })} />
            <InputRow type="date" label="Last day" value={draft.now.valid_to} onChange={(e) => setDraft({ ...draft, now: { ...draft.now, valid_to: e.target.value } })} />
            <InputRow type="date" label="Check again on" value={draft.now.review_on} onChange={(e) => setDraft({ ...draft, now: { ...draft.now, review_on: e.target.value } })} />
          </div>
          <div className="flex gap-2">
            <Button disabled={busy || draft.now.fact.trim().length < 2} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  );

  const card = (m: MemoryRecord, opts: { past?: boolean } = {}) => {
    if (editingId === m.id) return <li key={m.id}>{editor}</li>;
    const when = dates(m);
    return (
      <li key={m.id} className="space-y-1 px-4 py-3">
        <p className={tone.label}>
          {[MEMORY_KIND_LABEL[m.kind], ...when].join(" · ")}
          {reviewDue(m, today) && <span className="text-mp-accent-fg"> · Time to check it still holds</span>}
        </p>
        <p className={cx(tone.body, "text-[15px] leading-snug", opts.past && "text-mp-ink-2")}>{m.fact}</p>
        {m.reason && <p className={cx(tone.muted, "text-[13px] leading-snug")}>Why: {m.reason}</p>}
        {m.source_text && (
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>{m.source_words ? `“${m.source_text}”` : `Note: ${m.source_text}`}</p>
        )}
        <p className={cx(tone.faint, "text-[12px]")}>
          {memberName(m.said_by)} in {MEMORY_VIA_LABEL[m.via]} · {dayOf(m.stated_at)}
        </p>
        {canEdit &&
          (confirm === m.id ? (
            <div className="flex items-center gap-2 pt-1">
              <p className={cx(tone.body, "flex-1 text-sm")}>Forget it, with its earlier versions?</p>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void send({ action: "forget", id: m.id }, "Forgotten").then((r) => r === "ok" && setConfirm(null))}>
                Forget
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                Keep
              </Button>
            </div>
          ) : (
            <div className="-ml-2 flex flex-wrap gap-1 pt-0.5">
              {m.status === "active" && !draft && (
                <>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft({ start: draftOf(m), now: draftOf(m) })}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send({ action: "resolve", id: m.id, revision: m.revision }, "Marked resolved")}>
                    Mark resolved
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send({ action: "archive", id: m.id, revision: m.revision }, "Archived")}>
                    Archive
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" className="text-mp-danger" disabled={busy} onClick={() => setConfirm(m.id)}>
                Forget
              </Button>
            </div>
          ))}
      </li>
    );
  };

  return (
    <>
      <Section
        title="Saved memories"
        action={canEdit && !draft ? <Button variant="ghost" size="sm" onClick={() => setDraft({ start: EMPTY, now: EMPTY })}>Add</Button> : undefined}
        footnote={
          canEdit
            ? `Maple chat and connected assistants keep these in mind for ${w.name} and your family. Tell the chat something like “remember we're doing paced bottle feeding,” or add one here. Everyone in your family can see them.`
            : `Maple chat and connected assistants keep these in mind for ${w.name}. You can read them; ${askWho} can change them.`
        }
      >
        <div className={GROUP}>
          {draft && !editingId && editor}
          {current.length ? (
            <ul className={tone.divide}>{current.map((m) => card(m))}</ul>
          ) : (
            !draft && <EmptyState icon="sticky-note" title="Nothing saved yet">Things like the feeding plan, who does the night feeds, or what the doctor asked you to watch.</EmptyState>
          )}
        </div>
      </Section>

      <Section title="Chats and assistants" footnote="Memories go to the AI model with each chat message, like the parts of the log the chat reads.">
        <div className={GROUP}>
          <Toggle
            label="Let chats save memories"
            hint="Maple chat and connected assistants like Claude save and update memories when someone tells them something worth keeping. Off, you add them here."
            checked={list.state.capture}
            disabled={!canEdit || busy}
            onChange={(v) => void send({ action: "switches", capture: v }, v ? "Chats can save memories" : "Chats won't save memories")}
          />
          <Toggle
            label="Use memories in chats"
            hint="Off, chats and assistants don't read them. Saved memories stay here."
            checked={list.state.use}
            disabled={!canEdit || busy}
            onChange={(v) => void send({ action: "switches", use: v }, v ? "Chats use memories again" : "Chats won't use memories")}
          />
        </div>
      </Section>

      {earlier.length > 0 && (
        <div className={GROUP}>
          <Disclosure label="Earlier memories" summary={String(earlier.length)} open={past} onToggle={() => setPast((v) => !v)}>
            <ul className={cx(tone.divide, "-mx-4")}>{earlier.map((m) => card(m, { past: true }))}</ul>
          </Disclosure>
        </div>
      )}

      {canEdit && list.records.length > 0 && (
        <div className="space-y-2">
          {confirm === "all" ? (
            <div className={cx(GROUP, "space-y-3 p-4")}>
              <p className={cx(tone.body, "text-[15px] leading-relaxed")}>Forget every memory, current and earlier? This can&apos;t be undone.</p>
              <div className="flex gap-2">
                <Button variant="danger" disabled={busy} onClick={() => void send({ action: "forget_all" }, "Every memory forgotten").then((r) => r === "ok" && setConfirm(null))}>
                  Forget all
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Keep them
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="danger" className="w-full" disabled={busy} onClick={() => setConfirm("all")}>
              Forget all memories
            </Button>
          )}
          <Footnote>
            Resolved and archived memories stay under Earlier memories. Forget deletes a memory for good, and chats stop reading anyone&apos;s older messages, so it can&apos;t come back from them. The chat history on your phones stays, and what Claude or ChatGPT already saw stays there.
          </Footnote>
        </div>
      )}
    </>
  );
}

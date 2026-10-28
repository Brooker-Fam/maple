"use client";

import { useRef, useState } from "react";
import { parseEntryResults, type ChatEntryResults, type ChatSearchEntry } from "@/lib/maple/chat/search";
import { formatDayLabel, formatTime, dayKey } from "@/lib/maple/time";
import type { Entry } from "@/lib/maple/types";
import { useAppNav } from "../AppNav";
import { useSheets } from "../sheets";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

export default function ChatEntries({ results, disabled = false }: { results: unknown; disabled?: boolean }) {
  const parsed = parseEntryResults(results);
  if (!parsed) return <p className={cx(tone.muted, "text-sm")}>These search results are unavailable. Try searching again.</p>;
  return <EntriesCard key={`${parsed.asOf}:${JSON.stringify(parsed.criteria)}`} initial={parsed} disabled={disabled} />;
}

function EntriesCard({ initial, disabled }: { initial: ChatEntryResults; disabled: boolean }) {
  const { api, online, readOnly, update, state } = useMaple();
  const { open } = useSheets();
  const nav = useAppNav();
  const [rows, setRows] = useState(initial.entries);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const inflight = useRef(false);
  const today = dayKey(new Date(initial.asOf), initial.timezone);
  const blocked = disabled || !!pending || !online;
  const requestHeaders = { "X-Maple-Family": String(state?.family?.id ?? 1) };

  const run = async (key: string, work: () => Promise<void>) => {
    if (inflight.current || blocked) return;
    inflight.current = true;
    setPending(key);
    setProblem(null);
    try { await work(); }
    catch (error) { setProblem(error instanceof Error ? error.message : "That didn't finish. Try again."); }
    finally { inflight.current = false; setPending(null); }
  };

  const exact = async (row: ChatSearchEntry) => {
    const result = await api<{ entry: Entry; deleted: boolean }>(`/api/maple/chat/entry?target=baby&id=${row.id}`, { headers: requestHeaders });
    if (result.deleted) throw new Error("This entry was removed. Open History to see the current log.");
    if (result.entry.id !== row.id || result.entry.kind !== row.kind) throw new Error("This entry changed. Search again for its current details.");
    return result.entry;
  };

  const edit = (row: ChatSearchEntry) => run(`edit-${row.id}`, async () => {
    if (readOnly) return;
    const entry = await exact(row);
    open({ kind: entry.kind, entry });
  });

  const toggleQuestion = (row: ChatSearchEntry) => run(`question-${row.id}`, async () => {
    if (readOnly) return;
    const entry = await exact(row);
    if (entry.kind !== "note" || !entry.data.for_doctor) throw new Error("This is no longer a doctor question. Open History to see it.");
    const done = !row.done;
    const saved = await update(entry.id, { data: { done }, expect_updated_at: entry.updated_at }, { toast: done ? "Marked asked" : "Question reopened" });
    if (!saved) throw new Error("Couldn't change this question. Try again.");
    setRows((prev) => prev.map((item) => item.id === entry.id ? { ...item, done } : item));
  });

  const more = () => run("more", async () => {
    if (!cursor) return;
    const result = parseEntryResults(await api("/api/maple/chat/search", { method: "POST", body: JSON.stringify({ cursor }), headers: requestHeaders }));
    if (!result || result.asOf !== initial.asOf || JSON.stringify(result.criteria) !== JSON.stringify(initial.criteria)) throw new Error("These search results changed. Search again to refresh them.");
    setRows((prev) => [...prev, ...result.entries.filter((entry) => !prev.some((item) => item.id === entry.id))]);
    setCursor(result.nextCursor);
  });

  return (
    <section className={cx(tone.card, "overflow-hidden rounded-[20px]")} aria-label={initial.criteria.doctorQuestions ? "Doctor questions" : "Search results"} aria-busy={!!pending}>
      <div className="space-y-1 px-4 pt-4 pb-3">
        <h3 className={cx(tone.body, "text-[16px] font-semibold")}>{initial.criteria.doctorQuestions ? "Questions for the doctor" : "Matching entries"}</h3>
        {initial.criteria.query && <p className={cx(tone.body, "text-[14px] wrap-anywhere")}>Containing “{initial.criteria.query}”</p>}
        <p className={cx(tone.muted, "text-[12px]")}>{formatDayLabel(initial.criteria.from, today, { long: true })} to {formatDayLabel(initial.criteria.to, today, { long: true })}</p>
      </div>
      {rows.length ? (
        <ul className="divide-y divide-mp-line">
          {rows.map((row) => (
            <li key={row.id} className="space-y-2 px-4 py-3">
              <p className={cx(tone.muted, "text-[12px]")}>{formatDayLabel(dayKey(new Date(row.startedAt), initial.timezone), today)} · {formatTime(new Date(row.startedAt), initial.timezone)}{row.question && row.done ? " · Asked" : ""}</p>
              <p className={cx(tone.body, "text-[15px] leading-snug wrap-anywhere")}>{row.summary}</p>
              {!readOnly && <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="soft" disabled={blocked} onClick={() => void edit(row)}>{pending === `edit-${row.id}` ? "Opening…" : "Edit"}</Button>
                {row.question && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void toggleQuestion(row)}>{pending === `question-${row.id}` ? "Saving…" : row.done ? "Reopen question" : "Mark asked"}</Button>}
              </div>}
            </li>
          ))}
        </ul>
      ) : <p className={cx(tone.muted, "px-4 pb-3 text-[14px]")}>No matching entries in these dates.</p>}
      <div className="space-y-2 border-t border-mp-line px-4 py-3">
        {problem && <p role="alert" className="text-[14px] text-mp-danger">{problem}</p>}
        <div className="flex flex-wrap gap-2">
          {cursor && <Button size="sm" variant="soft" disabled={blocked} onClick={() => void more()}>{pending === "more" ? "Loading…" : "Load more"}</Button>}
          <Button size="sm" variant="ghost" onClick={() => nav.go("log")}>Open history</Button>
        </div>
        <p className={cx(tone.faint, "text-[12px]")}>Read at {formatTime(new Date(initial.asOf), initial.timezone)}. Entries may have changed since.</p>
      </div>
    </section>
  );
}

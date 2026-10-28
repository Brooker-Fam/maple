"use client";

import { useRef, useState } from "react";
import { describeEntry } from "@/lib/maple/describe";
import { careTime } from "@/lib/maple/care";
import { receiptText } from "@/lib/maple/chat/display";
import { careReceiptDetails, type ChatCareReceipt } from "@/lib/maple/chat/receipts";
import { dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import type { CareEntry, Entry } from "@/lib/maple/types";
import { useCare } from "../care/useCare";
import { Icon } from "../icons";
import { useSheets } from "../sheets";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import ChatCareEditor from "./ChatCareEditor";
import { useChatEntry } from "./useChatEntry";

type Receipt = { id: number; line: string; action?: "saved" | "deleted" | "updated" | "restored" };
const TITLES = {
  feed: "Feeding", pump: "Pumping", diaper: "Diaper", sleep: "Sleep", growth: "Measurements", temp: "Temperature",
  vitals: "Reading", med: "Medicine", tummy: "Tummy time", bath: "Bath", moment: "Moment", note: "Note",
};

/** Historical receipts stay recognizable, while their controls follow an exact server read. */
export default function ChatReceipt({ receipt }: { receipt: Receipt }) {
  const { remove, restore, readOnly, online, now, state, units } = useMaple();
  const { open } = useSheets();
  const current = useChatEntry<Entry>("baby", receipt.id);
  const entry = current.data?.entry;
  const removed = current.data?.deleted;
  const movedToCare = entry != null && "moved_to" in entry.data && entry.data.moved_to != null;
  const tz = state?.baby.timezone ?? "America/New_York";
  const d = entry ? describeEntry(entry, { units, now: now(), removed }) : null;
  const when = entry ? `${formatDayLabel(dayKey(new Date(entry.started_at), tz), dayKey(now(), tz))} at ${formatTime(entry.started_at, tz)}` : null;
  return <ReceiptCard receipt={receipt} current={current} allowed={!readOnly && !movedToCare} online={online}
    title={movedToCare ? "Moved to the care log" : entry ? `${TITLES[entry.kind]} ${removed ? "removed" : "in the log"}` : null}
    detail={d ? [d.text, when].filter(Boolean).join(" · ") : null}
    onEdit={entry ? () => open({ kind: entry.kind, entry }) : undefined}
    onRemove={() => remove(receipt.id, { toast: "Undone" })}
    onRestore={async () => !!(await restore(receipt.id))} />;
}

export function CareReceipt({ receipt }: { receipt: ChatCareReceipt }) {
  const { online, now, state, units } = useMaple();
  const { consent } = useChatNav();
  const care = useCare();
  const allowed = !!care && consent?.care === true;
  const current = useChatEntry<CareEntry>("care", receipt.id, allowed);
  const [editing, setEditing] = useState<CareEntry | null>(null);
  if (!allowed || !care) return <p className={cx(tone.faint, "p-3.5 text-[14px]")}>This care entry isn&apos;t available in chat.</p>;
  const entry = current.data?.entry;
  const { title, description } = entry ? careReceiptDetails(entry, units) : { title: "Care entry", description: null };
  const detail = entry ? [description, careTime(entry.at, now(), state?.baby.timezone ?? "America/New_York")].filter(Boolean).join(" · ") : null;
  return <>
    <ReceiptCard receipt={receipt} current={current} allowed={care.access.write} online={online}
      title={entry ? `${title} · ${current.data?.deleted ? "removed" : "in the log"}` : null} detail={detail}
      editLabel={entry?.kind === "dose" ? "Edit time" : "Edit"}
      onEdit={entry ? () => setEditing(entry) : undefined}
      onRemove={async () => { await care.act.deleteEntry(receipt.id); return true; }}
      onRestore={async () => { await care.act.restoreEntry(receipt.id); return true; }} />
    {editing && <ChatCareEditor entry={editing} onClose={() => { setEditing(null); current.check(); }} />}
  </>;
}

function ReceiptCard<T extends Entry | CareEntry>({ receipt, current, allowed, online, title, detail, editLabel = "Edit", onEdit, onRemove, onRestore }: {
  receipt: Receipt;
  current: ReturnType<typeof useChatEntry<T>>;
  allowed: boolean; online: boolean; title: string | null; detail: string | null; editLabel?: string;
  onEdit?: () => void; onRemove: () => Promise<boolean>; onRestore: () => Promise<boolean>;
}) {
  const [action, setAction] = useState<"remove" | "restore" | null>(null);
  const [failed, setFailed] = useState<"remove" | "restore" | null>(null);
  const inflight = useRef(false);
  const removed = current.data?.deleted;
  const pending = action !== null;
  const known = current.data !== null;
  const act = async (next: "remove" | "restore") => {
    if (inflight.current || !current.ready || !allowed || !online) return;
    inflight.current = true;
    setAction(next); setFailed(null);
    try {
      const ok = await (next === "remove" ? onRemove() : onRestore());
      if (ok) current.setDeleted(next === "remove");
      else setFailed(next);
    } catch { setFailed(next); }
    finally { inflight.current = false; setAction(null); }
  };
  const historical = receipt.action === "deleted" ? "Removed earlier" : receipt.action === "updated" ? "Updated earlier" : receipt.action === "restored" ? "Restored earlier" : "Saved earlier";
  const undoable = !receipt.action || receipt.action === "saved" || receipt.action === "restored";
  return <section ref={current.element} className="space-y-2 px-3.5 py-3" aria-label="Saved entry" aria-busy={pending || current.loading}>
    <div className="flex items-center gap-2">
      <Icon name={removed ? "trash-2" : known ? "check" : "clock-3"} size={17} strokeWidth={2.25} className="shrink-0 text-mp-ink-2" />
      <p className={cx(tone.body, "text-[14px] font-semibold")} role="status">{pending ? action === "remove" ? "Undoing…" : "Restoring…" : title ?? historical}</p>
    </div>
    <p className={cx(tone.body, "text-[15px] leading-snug wrap-anywhere", removed && "text-mp-ink-3")}>{detail ?? receiptText(receipt.line).replace(/^(?:Saved|Updated|Deleted|Restored):\s*/i, "").replace(/\. To bring it back.*$/, "")}</p>
    {!known && <p className={cx(tone.faint, "text-[12px]")}>{current.loading && online ? "Checking the current entry…" : "Earlier confirmation. Current status is unavailable."}</p>}
    {known && !online && <p className={cx(tone.faint, "text-[12px]")}>Offline. Showing the last checked entry.</p>}
    {failed && <p role="alert" className="text-[14px] leading-snug text-mp-danger">{failed === "remove" ? "Couldn't undo this entry. Check its status before trying again." : "Couldn't restore this entry. Check its status before trying again."}</p>}
    <div className="flex flex-wrap gap-2">
      {known && !removed && allowed && onEdit && <Button size="sm" variant="soft" disabled={pending || !current.ready || !!failed} onClick={onEdit}>{editLabel}</Button>}
      {known && allowed && (removed || undoable) && <Button size="sm" variant="ghost" disabled={pending || !current.ready || !!failed} onClick={() => void act(removed ? "restore" : "remove")}>{pending ? action === "remove" ? "Undoing…" : "Restoring…" : removed ? "Restore" : "Undo"}</Button>}
      {(!known || failed) && <Button size="sm" variant="ghost" disabled={pending || current.loading || !online} onClick={() => { setFailed(null); current.check(); }}>Check status</Button>}
    </div>
  </section>;
}

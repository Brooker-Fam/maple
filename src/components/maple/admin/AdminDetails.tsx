"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminDetails as Details, AdminDetailsFilter, AdminDetailsRow, AdminDetailsView, AdminFamilyRow, AdminFeedbackRow, AdminWaitlistRow } from "@/lib/maple/admin/details-types";
import { FEEDBACK_QUESTION, RATING_LABEL, TOPIC_LABEL, VIA_LABEL } from "@/lib/maple/feedback/types";
import type { Role } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Button, cx, tone } from "../ui";
import { adminRequest, authProblem, type AdminAuthProblem } from "./admin-request";
import { FEATURE_LABEL, SOURCE_LABEL } from "./AdminUsage";
import RevealEmail from "./RevealEmail";
import WaitlistInvitation from "./WaitlistInvitation";

export type DetailsSelection = { view: AdminDetailsView; filter: AdminDetailsFilter };
const number = new Intl.NumberFormat("en-US");
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const timeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
export const detailDate = (value: string | null) => value ? dateFormat.format(new Date(value)) : "Not yet";
const titles: Record<AdminDetailsView, string> = { families: "Families", people: "People", feedback: "Feedback", waitlist: "Waitlist" };
const familyFilters: Array<[AdminDetailsFilter, string]> = [
  ["all", "All families"], ["7d", "Signed up in 7 days"], ["30d", "Signed up in 30 days"],
  ["setup_complete", "Setup complete"], ["onboarding", "Still setting up"], ["deleting", "Deletion requested"],
  ["active7d", "Active in 7 days"], ["active30d", "Active in 30 days"],
  ["logged7d", "Logged in 7 days"], ["chat30d", "Used the chat in 30 days"],
];
const ROLE_WORD: Record<Role, string> = { owner: "Owner", member: "Member", viewer: "View-only guest", photos: "Photos-only guest" };
const plural = (n: number, one: string, many = `${one}s`) => `${number.format(n)} ${n === 1 ? one : many}`;

export default function AdminDetails({ selection, onSelect, onClose, onAuthProblem }: {
  selection: DetailsSelection;
  onSelect: (selection: DetailsSelection) => void;
  onClose: () => void;
  onAuthProblem: (problem: AdminAuthProblem) => void;
}) {
  const [data, setData] = useState<Details | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [privateVersion, setPrivateVersion] = useState(0);
  const [invitation, setInvitation] = useState<AdminWaitlistRow | null>(null);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setData(null);
    setInvitation(null);
    setPrivateVersion(value => value + 1);
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ view: selection.view, filter: selection.filter, page: String(page) });
      const result = await adminRequest<Details>(`/api/maple/admin/details?${params}`, current.signal);
      if (!current.signal.aborted) setData(result);
    } catch (error) {
      if (current.signal.aborted) return;
      const problem = authProblem(error);
      if (problem) onAuthProblem(problem);
      else setFailed(true);
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [selection.view, selection.filter, page, onAuthProblem]);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  useEffect(() => {
    const clearPrivate = () => {
      setPrivateVersion(value => value + 1);
      setInvitation(null);
    };
    const visibility = () => { if (document.hidden) clearPrivate(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", clearPrivate);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", clearPrivate);
    };
  }, []);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const changePage = (next: number) => {
    setData(null);
    setInvitation(null);
    setPrivateVersion(value => value + 1);
    setLoading(true);
    setPage(next);
  };
  return (
    <section className={cx(tone.card, "scroll-mt-4 overflow-hidden border-mp-accent/30")} aria-labelledby="admin-details-title">
      <div className="border-b border-mp-line p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 ref={heading} id="admin-details-title" tabIndex={-1} className={cx(tone.heading, "text-xl outline-none")}>{titles[selection.view]}</h2>
            <p className="mt-1 text-sm leading-relaxed text-mp-ink-2">{selection.view === "feedback" ? "Newest first. Senders' emails stay hidden until you reveal them." : "Emails stay hidden until you reveal them. Leaving this view hides them again."}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close details" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2 focus-visible:outline-2 focus-visible:outline-mp-focus"><Icon name="x" size={18} /></button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1 rounded-xl bg-mp-sunken p-1" aria-label="Choose a list">
            {(["families", "people", "feedback", "waitlist"] as const).map(view => <button key={view} type="button" aria-pressed={view === selection.view} onClick={() => onSelect({ view, filter: "all" })}
              className={cx("min-h-10 rounded-lg px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-mp-focus", view === selection.view ? "bg-mp-surface text-mp-ink shadow-sm" : "text-mp-ink-2")}>{titles[view]}</button>)}
          </div>
          {selection.view === "families" && <select aria-label="Filter families" value={selection.filter} onChange={event => onSelect({ view: "families", filter: event.target.value as AdminDetailsFilter })}
            className="min-h-11 max-w-full rounded-xl border border-mp-line bg-mp-surface px-3 text-sm text-mp-ink focus:outline-mp-focus">
            {familyFilters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>}
          <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-mp-accent-fg disabled:opacity-50"><Icon name="refresh-cw" size={15} />Refresh list</button>
        </div>
      </div>

      {invitation && <WaitlistInvitation key={invitation.ref} row={invitation} onClose={() => setInvitation(null)} onAuthProblem={onAuthProblem} />}
      {loading ? <p role="status" className="p-6 text-sm text-mp-ink-2">Loading {titles[selection.view].toLowerCase()}…</p>
        : failed ? <div role="alert" className="p-6"><p className="mb-4 text-sm text-mp-ink-2">This list couldn’t load. Try again.</p><Button variant="soft" onClick={() => void load()}>Try again</Button></div>
        : data && <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs text-mp-ink-3 sm:px-6">
            <span>{selection.view === "feedback" ? plural(data.total, "message") : `${number.format(data.total)} ${titles[selection.view].toLowerCase()}`}{selection.filter !== "all" ? " in this view" : ""}</span>
            <span>Dates in Eastern Time</span>
          </div>
          {!data.rows.length ? <p className="px-6 pt-2 pb-8 text-sm text-mp-ink-2">No {titles[selection.view].toLowerCase()} in this view yet.</p>
            : <ul key={privateVersion} className="divide-y divide-mp-line border-t border-mp-line">
              {data.rows.map((row, index) => <DetailRow key={row.kind === "person" ? row.ref : `${row.kind}-${row.id}`} row={row} index={(page - 1) * data.pageSize + index + 1} onAuthProblem={onAuthProblem} onPreview={setInvitation} />)}
            </ul>}
          <div className="flex items-center justify-between gap-3 border-t border-mp-line px-5 py-4 sm:px-6">
            <Button variant="soft" disabled={page <= 1} onClick={() => changePage(page - 1)}><Icon name="chevron-left" size={16} />Previous</Button>
            <span className="text-xs tabular-nums text-mp-ink-2">Page {page} of {pages}</span>
            <Button variant="soft" disabled={page >= pages} onClick={() => changePage(page + 1)}>Next<Icon name="chevron-right" size={16} /></Button>
          </div>
        </>}
    </section>
  );
}

function DetailRow({ row, index, onAuthProblem, onPreview }: {
  row: AdminDetailsRow;
  index: number;
  onAuthProblem: (problem: AdminAuthProblem) => void;
  onPreview: (row: AdminWaitlistRow) => void;
}) {
  if (row.kind === "feedback") return <FeedbackRow row={row} onAuthProblem={onAuthProblem} />;
  const status = row.kind === "family" ? { active: "Setup complete", onboarding: "Still setting up", deleting: "Deletion requested" }[row.status] : null;
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5 sm:px-6">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-mp-ink">{row.kind === "family" ? `Family ${row.id}` : row.kind === "waitlist" ? `Waitlist contact ${row.id}` : `Account ${index}`}</p>
        {row.ref && row.emailMasked ? <RevealEmail reference={row.ref} masked={row.emailMasked} onAuthProblem={onAuthProblem} /> : <p className="mt-2 text-sm text-mp-ink-3">No account email available</p>}
        <p className="mt-1 text-xs leading-relaxed text-mp-ink-3">
          {row.kind === "family" ? `Started ${detailDate(row.createdAt)} · ${row.members} accepted ${row.members === 1 ? "member" : "members"}`
            : row.kind === "person" ? `Joined ${detailDate(row.joinedAt)} · Last seen ${detailDate(row.lastSeenAt)} · ${row.familyIds.map(id => `Family ${id}`).join(", ")}`
            : `Joined the waitlist ${detailDate(row.createdAt)}`}
        </p>
        {row.kind === "person" && <p className="mt-1 text-xs leading-relaxed text-mp-ink-2">In 30 days: {plural(row.usage.entries30d, "entry", "entries")} logged · {plural(row.usage.chat30d, "chat message")}</p>}
        {row.kind === "family" && <FamilyUsage usage={row.usage} />}
      </div>
      {status && <span className="self-start rounded-full bg-mp-sunken px-3 py-1.5 text-xs font-medium text-mp-ink-2 sm:self-center">{status}</span>}
      {row.kind === "waitlist" && <Button variant="soft" onClick={() => onPreview(row)} className="self-start sm:shrink-0">Preview invitation<Icon name="arrow-right" size={16} /></Button>}
    </li>
  );
}

/** What one family did lately: counts, the parts of Maple it used and how it logged, never what it logged. */
function FamilyUsage({ usage: u }: { usage: AdminFamilyRow["usage"] }) {
  return (
    <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-mp-ink-2">
      <p>
        {u.lastEntryAt ? `Last entry ${detailDate(u.lastEntryAt)}` : "No entries yet"} · {plural(u.entries7d, "entry", "entries")} on {u.days7d} of the last 7 days · {plural(u.entries30d, "entry", "entries")} in 30 days
      </p>
      <p>
        Last seen {detailDate(u.lastSeenAt)} · {plural(u.chat30d, "chat message")} in 30 days{u.sources.length ? ` · Logged with ${u.sources.map((key) => SOURCE_LABEL[key].replace(/^The /, "the ")).join(", ")}` : ""}
      </p>
      {u.features.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Parts of Maple used in 30 days">
          {u.features.map((key) => <li key={key} className="rounded-full bg-mp-sunken px-2.5 py-1 text-mp-ink-2">{FEATURE_LABEL[key]}</li>)}
        </ul>
      )}
    </div>
  );
}

/** One feedback message in full, who sent it by family and role, and their address behind Reveal. */
function FeedbackRow({ row, onAuthProblem }: { row: AdminFeedbackRow; onAuthProblem: (problem: AdminAuthProblem) => void }) {
  const label = row.topic ? TOPIC_LABEL[row.topic] : row.rating ? "Answer to the question" : "Feedback";
  return (
    <li className="px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold text-mp-ink">{label} · Family {row.familyId}</p>
        <span className="rounded-full bg-mp-sunken px-3 py-1 text-xs font-medium text-mp-ink-2">{row.emailed ? "Emailed" : "Not emailed"}</span>
      </div>
      {row.rating && <p className="mt-2 text-sm text-mp-ink-2">{FEEDBACK_QUESTION} <span className="font-semibold text-mp-ink">{RATING_LABEL[row.rating]}</span></p>}
      {row.message ? <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-wrap wrap-anywhere text-mp-ink">{row.message}</p> : <p className="mt-2 text-sm text-mp-ink-3">No message</p>}
      {row.ref && row.emailMasked ? <RevealEmail reference={row.ref} masked={row.emailMasked} onAuthProblem={onAuthProblem} /> : <p className="mt-2 text-sm text-mp-ink-3">No reply address</p>}
      <p className="mt-1 text-xs leading-relaxed text-mp-ink-3">
        <time dateTime={row.createdAt}>{timeFormat.format(new Date(row.createdAt))}</time> · {ROLE_WORD[row.role] ?? "Member"} · from {VIA_LABEL[row.via]}
      </p>
    </li>
  );
}

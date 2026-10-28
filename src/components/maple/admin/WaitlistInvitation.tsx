"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminWaitlistRow } from "@/lib/maple/admin/details-types";
import type { AdminWaitlistPreview, AdminWaitlistSendResult } from "@/lib/maple/admin/waitlist-email-types";
import { Icon } from "../icons";
import { Button } from "../ui";
import { AdminRequestError, adminRequest, authProblem, type AdminAuthProblem } from "./admin-request";
import RevealEmail from "./RevealEmail";

const reasons = {
  already_signed_up: "This address already belongs to an accepted Maple account. A launch invitation isn’t needed.",
  already_sent: "This invitation has already been sent to the email provider.",
  send_pending: "A send is already in progress or awaiting confirmation. Check its status before taking any further action.",
  delivery_unknown: "The last send couldn’t be confirmed. Check Resend before sending anything else to this contact.",
  email_unavailable: "Email sending isn’t available right now. The preview is ready, but the invitation can’t be sent yet.",
  signup_closed: "Public signup isn’t open right now. Send the invitation once families can create their own log.",
} as const;

export default function WaitlistInvitation({ row, onClose, onAuthProblem }: {
  row: AdminWaitlistRow;
  onClose: () => void;
  onAuthProblem: (problem: AdminAuthProblem) => void;
}) {
  const [preview, setPreview] = useState<AdminWaitlistPreview | null>(null);
  const [result, setResult] = useState<AdminWaitlistSendResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshListNeeded, setRefreshListNeeded] = useState(false);
  const [privateVersion, setPrivateVersion] = useState(0);
  const sendingRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    if (sendingRef.current) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setPreview(null);
    setResult(null);
    setError(null);
    setRefreshListNeeded(false);
    setPrivateVersion(value => value + 1);
    setLoading(true);
    try {
      const response = await adminRequest<AdminWaitlistPreview>("/api/maple/admin/waitlist/preview", current.signal, { ref: row.ref });
      if (!current.signal.aborted) setPreview(response);
    } catch (error) {
      if (current.signal.aborted) return;
      const problem = authProblem(error);
      if (problem) onAuthProblem(problem);
      else {
        const expired = error instanceof AdminRequestError && [400, 404, 409].includes(error.status);
        setRefreshListNeeded(expired);
        setError(expired
          ? "This contact changed or the link expired. Close this preview and refresh the waitlist."
          : "The invitation preview couldn’t load. Try again.");
      }
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }, [row.ref, onAuthProblem]);

  useEffect(() => {
    void load();
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return () => controller.current?.abort();
  }, [load]);

  const send = async () => {
    if (sendingRef.current || !preview?.canSend || !preview.sendToken) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    try {
      const response = await adminRequest<AdminWaitlistSendResult>("/api/maple/admin/waitlist/send", current.signal, { sendToken: preview.sendToken });
      if (current.signal.aborted) return;
      setResult(response);
      setPreview(value => value && { ...value, canSend: false, sendToken: null });
    } catch (error) {
      if (current.signal.aborted) return;
      setPreview(value => value && { ...value, canSend: false, sendToken: null });
      setPrivateVersion(value => value + 1);
      const problem = authProblem(error);
      if (problem) onAuthProblem(problem);
      else if (error instanceof AdminRequestError && [400, 404, 409].includes(error.status)) {
        setError("The recipient or sending conditions changed, or this preview expired. Review a fresh preview before sending.");
      } else {
        // A network error can happen after the server accepted the send. A
        // fresh status check is safe; repeating the send automatically isn't.
        setResult({ status: "delivery_unknown", sentAt: null });
      }
    } finally {
      sendingRef.current = false;
      if (!current.signal.aborted) setSending(false);
    }
  };

  const status = result?.status ?? preview?.reason;
  const statusText = status === "sent"
    ? "Invitation sent to the email provider. Delivery can be checked in Resend."
    : status ? reasons[status] : null;

  return (
    <section aria-labelledby="waitlist-preview-title" className="scroll-mt-4 border-b border-mp-line bg-mp-sunken/50 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-mp-accent-fg">Waitlist contact {row.id}</p>
          <h3 ref={heading} tabIndex={-1} id="waitlist-preview-title" className="mt-1 text-lg font-semibold text-mp-ink outline-none">Preview launch invitation</h3>
          <p className="mt-1 text-sm text-mp-ink-2">Review the message, then send it to this one contact.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close invitation preview" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-mp-surface text-mp-ink-2"><Icon name="x" size={18} /></button>
      </div>
      {loading && <p role="status" className="py-8 text-sm text-mp-ink-2">Preparing the preview…</p>}
      {preview && <div className="mt-5 rounded-2xl border border-mp-line bg-mp-surface p-4 sm:p-5">
        <dl className="space-y-3 text-sm">
          <div><dt className="text-xs text-mp-ink-3">To</dt><dd><RevealEmail key={privateVersion} masked={preview.toMasked} reference={row.ref} onAuthProblem={onAuthProblem} /></dd></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-mp-ink-3">From</dt><dd className="mt-1 break-all text-mp-ink-2">{preview.from}</dd></div>
            <div><dt className="text-xs text-mp-ink-3">Replies go to</dt><dd className="mt-1 break-all text-mp-ink-2">{preview.replyTo}</dd></div>
          </div>
          <div className="border-t border-mp-line pt-4"><dt className="text-xs text-mp-ink-3">Subject</dt><dd className="mt-1 font-semibold text-mp-ink">{preview.subject}</dd></div>
        </dl>
        <p className="mt-5 whitespace-pre-wrap break-words border-t border-mp-line pt-5 text-[15px] leading-relaxed text-mp-ink-2">{preview.text}</p>
      </div>}
      {statusText && <p role="status" className="mt-4 rounded-xl bg-mp-surface px-4 py-3 text-sm leading-relaxed text-mp-ink-2">{statusText}</p>}
      {error && <p role="alert" className="mt-4 text-sm leading-relaxed text-mp-danger">{error}</p>}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {preview?.canSend && <Button onClick={() => void send()} disabled={sending || loading}>{sending ? "Sending…" : "Send invitation"}<Icon name="arrow-right" size={16} /></Button>}
        {!loading && !sending && !refreshListNeeded && (error || result?.status === "delivery_unknown" || status === "send_pending") && <Button variant="soft" onClick={() => void load()}>{error ? "Review fresh preview" : "Check status"}</Button>}
        <Button variant="soft" onClick={onClose}>{result?.status === "sent" || status === "already_sent" ? "Done" : "Close preview"}</Button>
      </div>
      {sending && <p role="status" className="mt-3 text-xs text-mp-ink-3">Sending this invitation once. You can check its status here if the connection drops.</p>}
    </section>
  );
}

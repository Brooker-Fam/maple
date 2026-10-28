"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { AdminRequestError, adminRequest, authProblem, type AdminAuthProblem } from "./admin-request";

export default function RevealEmail({ masked, reference, onAuthProblem }: {
  masked: string;
  reference: string;
  onAuthProblem: (problem: AdminAuthProblem) => void;
}) {
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const toggle = async () => {
    controller.current?.abort();
    setError(null);
    if (email) {
      setEmail(null);
      setBusy(false);
      return;
    }
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    try {
      const result = await adminRequest<{ email: string }>("/api/maple/admin/reveal", current.signal, { ref: reference });
      if (!current.signal.aborted) setEmail(result.email);
    } catch (error) {
      if (current.signal.aborted) return;
      setEmail(null);
      const problem = authProblem(error);
      if (problem) onAuthProblem(problem);
      else setError(error instanceof AdminRequestError && [400, 404].includes(error.status)
        ? "This contact changed or the link expired. Refresh the list and try again."
        : "The email couldn’t be revealed. Try again.");
    } finally {
      if (!current.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="break-all text-[15px] text-mp-ink" aria-live="polite">{email ?? masked}</span>
        <button type="button" onClick={() => void toggle()} disabled={busy} aria-pressed={!!email}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-xs font-semibold text-mp-accent-fg underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mp-focus disabled:opacity-50">
          <Icon name={email ? "lock" : "eye"} size={15} />
          {busy ? "Revealing…" : email ? "Hide email" : "Reveal email"}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 max-w-sm text-xs leading-relaxed text-mp-danger">{error}</p>}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { babyMonthOptions, type MonthOption } from "@/lib/waitlist";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string; invalid?: boolean };

export default function WaitlistForm() {
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [months, setMonths] = useState<{ expecting: MonthOption[]; born: MonthOption[] } | null>(null);

  useEffect(() => setMonths(babyMonthOptions(new Date())), []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status.kind === "sending") return;
    const form = new FormData(e.currentTarget);
    setStatus({ kind: "sending" });
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          baby_month: form.get("baby_month") || null,
          website: form.get("website"),
        }),
      });
      if (res.status === 204) return setStatus({ kind: "done" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus({ kind: "error", message: body?.error ?? "Couldn't add you just now. Try again in a minute.", invalid: res.status === 400 });
    } catch {
      setStatus({ kind: "error", message: "Couldn't reach Maple. Check your connection and try again." });
    }
  }

  if (status.kind === "done") {
    return (
      <div role="status" className="max-w-[34rem] rounded-[18px] border border-mp-line bg-mp-surface px-5 py-4">
        <p className="font-display text-[1.6rem] leading-tight font-semibold text-mp-ink">You&rsquo;re on the list.</p>
        <p className="mt-1 text-[15px] leading-relaxed text-mp-ink-2">We&rsquo;ll email you when Maple opens to more families. Nothing else.</p>
      </div>
    );
  }

  const error = status.kind === "error" ? status.message : null;
  const invalid = status.kind === "error" && status.invalid;
  return (
    <form action="/api/waitlist" method="post" onSubmit={submit} className="max-w-[34rem]">
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <label htmlFor={`${id}-email`} className="sr-only">
          Email address
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          inputMode="email"
          spellCheck={false}
          placeholder="you@example.com"
          aria-invalid={invalid || undefined}
          aria-describedby={error ? `${id}-error` : `${id}-note`}
          className="site-field w-full min-w-0 sm:flex-1"
        />
        <button type="submit" disabled={status.kind === "sending"} className="site-button shrink-0">
          {status.kind === "sending" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <label htmlFor={`${id}-month`} className="text-[15px] text-mp-ink-2">
          Baby due or born
        </label>
        <select id={`${id}-month`} name="baby_month" defaultValue="" className="site-select">
          <option value="">Rather not say</option>
          {months && (
            <>
              <optgroup label="Expecting">
                {months.expecting.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Already here">
                {months.born.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            </>
          )}
        </select>
      </div>
      <div className="site-honeypot" aria-hidden>
        <label htmlFor={`${id}-website`}>Leave this empty</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <p aria-live="polite" id={`${id}-error`} className="mt-2 min-h-[1.25rem] text-[15px] text-mp-danger">
        {error}
      </p>
      <p id={`${id}-note`} className="text-[14px] leading-relaxed text-mp-ink-3">
        Families can&rsquo;t sign up yet. We&rsquo;ll use your email only to tell you when you can.{" "}
        <Link href="/privacy" className="site-link">
          Privacy
        </Link>
      </p>
    </form>
  );
}

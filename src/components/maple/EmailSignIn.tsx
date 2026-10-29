"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

type StartFields = Record<string, string>;

/** One form owns the email and code steps; a sign-up form can supply its validated fields. */
export default function EmailSignIn({
  mode = "signin",
  appearance = "app",
  startFields,
  label,
}: {
  mode?: "signin" | "signup" | "link";
  appearance?: "app" | "site";
  startFields?: () => StartFields | null;
  label?: string;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState<"send" | "verify" | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const savedFields = useRef<StartFields | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (resendSeconds <= 0) return;
    const timer = window.setTimeout(() => setResendSeconds((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [resendSeconds]);
  const site = appearance === "site";
  const button = site
    ? "site-button w-full disabled:opacity-40"
    : "flex min-h-[52px] w-full items-center justify-center rounded-[14px] bg-mp-sunken px-5 text-base font-semibold text-mp-ink transition hover:opacity-90 active:scale-[0.98] disabled:opacity-40";
  const field = site
    ? "site-field w-full"
    : "w-full rounded-xl border border-mp-line bg-mp-surface px-3.5 py-3 text-base text-mp-ink outline-none focus:border-mp-focus focus:ring-2 focus:ring-mp-focus/25";
  const textButton = "min-h-[44px] rounded-lg px-2 text-sm font-medium text-mp-accent-fg disabled:opacity-40";

  const send = async (resend = false) => {
    if (busy) return;
    const fields = resend ? savedFields.current : startFields?.() ?? (startFields ? null : {});
    if (!fields) return;
    setBusy("send");
    setError(null);
    setNotice(null);
    try {
      const back = new URL(window.location.href).searchParams.get("return");
      const response = await fetch("/api/maple/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(mode === "signin" && back && back.length <= 4096 ? { return: back } : {}), ...fields, mode, email: email.trim(), site: window.location.origin }),
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        setError(result.error || "Couldn't send a code. Please try again.");
        return;
      }
      savedFields.current = fields;
      setCode("");
      setSent(true);
      setResendSeconds(60);
      setNotice(resend ? "A new code is on its way. Use the latest email." : "Check your inbox for a six-digit code. It expires in 10 minutes.");
      window.setTimeout(() => codeInput.current?.focus(), 0);
    } catch {
      setError("Couldn't connect. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!sent) return void send();
    setBusy("verify");
    setError(null);
    try {
      const response = await fetch("/api/maple/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await response.json().catch(() => ({})) as { ok?: boolean; redirect?: string; error?: string };
      if (!response.ok || !result.ok || !result.redirect) {
        setError(result.error || "That code didn't work. Check it or send a new one.");
        return;
      }
      window.location.assign(result.redirect);
    } catch {
      setError("Couldn't connect. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!expanded) {
    return (
      <button type="button" className={button} onClick={() => {
        setExpanded(true);
        window.setTimeout(() => emailInput.current?.focus(), 0);
      }}>
        {label ?? (mode === "link" ? "Connect an email address" : "Continue with email")}
      </button>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3 text-left" aria-label={mode === "link" ? "Connect email sign-in" : "Sign in with email"}>
      {sent ? (
        <>
          <p className="text-sm leading-relaxed text-mp-ink-2">Enter the code sent to <strong className="break-all font-medium text-mp-ink">{email.trim()}</strong>.</p>
          <label htmlFor={`${id}-code`} className="block text-sm font-medium text-mp-ink">Six-digit code</label>
          <input ref={codeInput} disabled={!!busy} id={`${id}-code`} className={`${field} font-mono tracking-[0.25em]`} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required aria-describedby={`${id}-notice`} />
        </>
      ) : (
        <>
          <label htmlFor={`${id}-email`} className="block text-sm font-medium text-mp-ink">Email address</label>
          <input ref={emailInput} disabled={!!busy} id={`${id}-email`} className={field} value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} required />
          <p className="text-sm leading-relaxed text-mp-ink-2">We&apos;ll email you a code. No password to remember.</p>
        </>
      )}
      <p id={`${id}-notice`} role="status" className="text-sm leading-relaxed text-mp-ink-2">{notice}</p>
      {error && <p role="alert" className="text-sm leading-relaxed text-mp-danger">{error}</p>}
      <button type="submit" className={button} disabled={!!busy || (sent ? code.length !== 6 : !email.trim())}>
        {busy ? (busy === "verify" ? "Checking…" : "Sending…") : sent ? (mode === "link" ? "Connect email" : "Continue") : "Send a code"}
      </button>
      <div className="flex flex-wrap justify-between gap-x-2">
        {sent && <button type="button" className={textButton} disabled={!!busy || resendSeconds > 0} onClick={() => void send(true)}>{resendSeconds > 0 ? `Send a new code in ${resendSeconds}s` : "Send a new code"}</button>}
        <button type="button" className={textButton} disabled={!!busy} onClick={() => {
          setSent(false);
          setCode("");
          setError(null);
          setNotice(null);
          savedFields.current = null;
          if (!sent) setExpanded(false);
          else window.setTimeout(() => emailInput.current?.focus(), 0);
        }}>{sent ? "Change email" : "Cancel"}</button>
      </div>
    </form>
  );
}

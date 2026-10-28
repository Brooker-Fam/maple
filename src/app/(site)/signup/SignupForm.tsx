"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import EmailSignIn from "@/components/maple/EmailSignIn";
import AppleMark from "@/components/maple/AppleMark";

/** OAuth works as a plain form post. Email shares the form's validated sign-up details. */
export default function SignupForm({ mode, error, joining, providers }: {
  mode: "invite" | "open";
  error: string | null;
  joining: boolean;
  providers: { google: boolean; apple: boolean; email: boolean };
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const [tz, setTz] = useState("");
  const [site, setSite] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [sending, setSending] = useState<"google" | "apple" | null>(null);

  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
    } catch {
      // The server falls back to its default; onboarding asks to confirm it.
    }
    setSite(window.location.origin);
    const hash = window.location.hash.replace(/^#/, "");
    if (hash.startsWith("join=")) {
      try {
        setInvite(decodeURIComponent(hash.slice("join=".length)));
      } catch {
        setInvite("");
      }
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    const reset = () => setSending(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const join = invite !== null;
  const startFields = () => {
    if (!form.current?.reportValidity()) return null;
    const data = new FormData(form.current);
    return Object.fromEntries([...data.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    // Let the browser collect the clicked button's provider before disabling it.
    const provider = button?.value === "apple" ? "apple" : "google";
    window.setTimeout(() => setSending(provider), 0);
  };

  return (
    <div className="max-w-[34rem]">
      <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
        {join ? "Join your family’s log" : "Start your family’s log"}
      </h1>
      <p className="site-prose mt-4">
        {join
          ? "You’ve been invited to a family’s log on Maple. Choose how you’d like to sign in."
          : "Choose how you’d like to sign in, then Maple asks a few questions to set up your baby’s log. You can invite everyone else after."}
      </p>
      {error && <p role="alert" className="mt-4 text-[15px] leading-relaxed text-mp-danger">{joining && !join ? `${error} Open the invite link again to retry.` : error}</p>}

      <form ref={form} action="/api/maple/signup/start" method="post" onSubmit={submit}>
        <input type="hidden" name="tz" value={tz} />
        <input type="hidden" name="site" value={site} />
        {join && <input type="hidden" name="invite" value={invite} />}

        {!join && mode === "invite" && (
          <div className="mt-8">
            <label htmlFor={`${id}-code`} className="block text-[15px] font-semibold text-mp-ink">Invite code</label>
            <input id={`${id}-code`} name="code" type="text" required maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="MAPLE-XXXXX-XXXXX-XXXXX" aria-describedby={`${id}-code-note`} className="site-field mt-2 w-full font-mono tracking-wide" />
            <p id={`${id}-code-note`} className="mt-2 text-[14px] leading-relaxed text-mp-ink-3">Maple is invite-only while it’s new. One code starts one family.</p>
          </div>
        )}

        {!join && (
          <label className="mt-8 flex items-start gap-3 text-[15px] leading-relaxed text-mp-ink-2">
            <input type="checkbox" name="terms" value="yes" required className="mt-1 h-5 w-5 shrink-0 accent-[var(--mp-accent)]" />
            <span>I’m 18 or older, I live in the US, and I agree to the <Link href="/terms" className="site-link">Terms</Link> and <Link href="/privacy" className="site-link">Privacy</Link>. Maple is a tracker, not medical advice.</span>
          </label>
        )}

        <div className="mt-6 space-y-3">
          {providers.google && <button type="submit" name="provider" value="google" disabled={!!sending} className="site-button w-full disabled:opacity-40">{sending === "google" ? "Opening Google…" : "Continue with Google"}</button>}
          {providers.apple && <button type="submit" name="provider" value="apple" disabled={!!sending} className="flex min-h-[52px] w-full items-center justify-center gap-3 rounded-[14px] bg-mp-ink px-5 text-base font-semibold text-mp-bg transition hover:opacity-90 disabled:opacity-40"><AppleMark />{sending === "apple" ? "Opening Apple…" : "Continue with Apple"}</button>}
        </div>
      </form>
      {providers.email && <div className="mt-3"><EmailSignIn mode="signup" appearance="site" startFields={startFields} /></div>}
      {!providers.google && !providers.apple && !providers.email && <p role="status" className="mt-6 text-[15px] text-mp-ink-2">Sign-in is unavailable for a moment. Please try again shortly.</p>}
      {join && <p className="mt-4 text-[15px] text-mp-ink-2">You can also <a className="site-link" href={`/maple/join#${encodeURIComponent(invite ?? "")}`} rel="nofollow">join with the link alone</a>.</p>}
      <p className="mt-6 text-[14px] leading-relaxed text-mp-ink-3">Already using Maple? <a href="/maple" className="site-link">Sign in</a> the way you used before. You can connect another sign-in method in Family without starting a new log.</p>
    </div>
  );
}

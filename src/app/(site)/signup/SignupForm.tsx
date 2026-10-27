"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";

/**
 * A plain form post to /api/maple/signup/start, so it works before this
 * script loads. The script only adds what the browser knows: its timezone
 * (onboarding asks to confirm it), its origin, and an invite link's token,
 * which rides in the #fragment (/signup#join=<token>) so it never reaches a
 * server log.
 */
export default function SignupForm({ mode, error, joining }: { mode: "invite" | "open"; error: string | null; joining: boolean }) {
  const id = useId();
  const [tz, setTz] = useState("");
  const [site, setSite] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
    } catch {
      // the server falls back to its default
    }
    setSite(window.location.origin);
    const hash = window.location.hash.replace(/^#/, "");
    if (hash.startsWith("join=")) {
      setInvite(decodeURIComponent(hash.slice("join=".length)));
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    // Back from Google's page restores this one from the cache with the button still saying "Opening Google…".
    const reset = () => setSending(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const join = invite !== null;
  return (
    <form action="/api/maple/signup/start" method="post" onSubmit={() => setSending(true)} className="max-w-[34rem]">
      <h1 className="site-display text-[clamp(2.4rem,1.6rem+3.2vw,3.5rem)] leading-[1.05] text-mp-ink">
        {join ? "Join your family’s log" : "Start your family’s log"}
      </h1>
      <p className="site-prose mt-4">
        {join
          ? "You’ve been invited to a family’s log on Maple. Sign in with Google to join it with your own account."
          : "Sign in with Google, then Maple asks a few questions to set up your baby’s log. You can invite everyone else after."}
      </p>
      {error && (
        <p role="alert" className="mt-4 text-[15px] leading-relaxed text-mp-danger">
          {joining && !join ? `${error} Open the invite link again to retry.` : error}
        </p>
      )}

      <input type="hidden" name="tz" value={tz} />
      <input type="hidden" name="site" value={site} />
      {join && <input type="hidden" name="invite" value={invite} />}

      {!join && mode === "invite" && (
        <div className="mt-8">
          <label htmlFor={`${id}-code`} className="block text-[15px] font-semibold text-mp-ink">
            Invite code
          </label>
          <input
            id={`${id}-code`}
            name="code"
            type="text"
            required
            maxLength={64}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="MAPLE-XXXXX-XXXXX-XXXXX"
            aria-describedby={`${id}-code-note`}
            className="site-field mt-2 w-full font-mono tracking-wide"
          />
          <p id={`${id}-code-note`} className="mt-2 text-[14px] leading-relaxed text-mp-ink-3">
            Maple is invite-only while it’s new. One code starts one family.
          </p>
        </div>
      )}

      {!join && (
        <label className="mt-8 flex items-start gap-3 text-[15px] leading-relaxed text-mp-ink-2">
          <input type="checkbox" name="terms" value="yes" required className="mt-1 h-5 w-5 shrink-0 accent-[var(--mp-accent)]" />
          <span>
            I’m 18 or older, I live in the US, and I agree to the{" "}
            <Link href="/terms" className="site-link">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="site-link">
              Privacy
            </Link>
            . Maple is a tracker, not medical advice.
          </span>
        </label>
      )}

      <button type="submit" disabled={sending} className="site-button mt-6 w-full sm:w-auto">
        {sending ? "Opening Google…" : "Continue with Google"}
      </button>
      {join && (
        <p className="mt-4 text-[15px] text-mp-ink-2">
          No Google account?{" "}
          <a className="site-link" href={`/maple/join#${encodeURIComponent(invite ?? "")}`} rel="nofollow">
            Join with the link alone
          </a>
        </p>
      )}
    </form>
  );
}

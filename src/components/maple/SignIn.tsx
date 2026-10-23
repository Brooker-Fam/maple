"use client";

import { motion } from "framer-motion";
import { useEffect, useState, type FormEvent } from "react";
import { MapleLeaf, useStill } from "./art";
import { Icon } from "./icons";
import { Button, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * The door to Maple's Log. Google sign-in for the family; the site admin
 * password as a quieter fallback. Google's callback lands back on /maple with
 * ?auth=<reason> when something went wrong, which we turn into plain words.
 */

const AUTH_MESSAGES: Record<string, string> = {
  not_invited: "That Google account isn't on Maple's list yet — ask Matt or Brittany to add it, then try again.",
  bad_state: "That sign-in took a wrong turn (it may have sat open too long). Please try once more.",
  denied: "Google sign-in was cancelled. No harm done; try again whenever you're ready.",
  failed: "Something went wrong signing in with Google. Please try again.",
  no_code: "Something went wrong signing in with Google. Please try again.",
  no_email: "Google didn't share a verified email for that account. Try a different account.",
  unavailable: "Maple's log is offline for a moment. Please try again shortly.",
  not_configured: "Google sign-in isn't set up yet. Use the site admin password below, or ask Matt.",
};

export default function SignIn() {
  const { auth, refresh } = useMaple();
  const still = useStill();
  const [notice, setNotice] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Read (then tidy away) the callback's ?auth= so a reload doesn't repeat it.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const reason = url.searchParams.get("auth");
      if (!reason) return;
      if (reason !== "ok") setNotice(AUTH_MESSAGES[reason] ?? AUTH_MESSAGES.failed);
      if (reason === "not_configured") setShowPassword(true);
      url.searchParams.delete("auth");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    } catch {
      // odd URL: nothing to show
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/maple/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "That didn't work. Try again?");
        setBusy(false);
        return;
      }
      await refresh();
    } catch {
      setError("Couldn't reach the forest. Check your connection and try again.");
    }
    setBusy(false);
  };

  const google = auth?.google ?? false;
  const passwordOk = auth?.password ?? false;
  const nothing = auth && !google && !passwordOk;

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <motion.div
        className="w-full max-w-sm text-center"
        initial={still ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        {/* The app icon's leaf on a plain tile: the one mark on this page. */}
        <div className="mx-auto flex h-[88px] w-[88px] items-center justify-center rounded-[24px] border border-mp-line bg-mp-surface">
          <MapleLeaf size={60} className="[.maple-night_&]:opacity-70" />
        </div>
        <h1 className={cx(tone.display, "mt-6 text-[34px] leading-[1.05]")}>Maple&apos;s Log</h1>
        <p className={cx(tone.muted, "mx-auto mt-2 max-w-[18rem] text-[15px] leading-relaxed text-balance")}>
          Just for Maple&apos;s family. Sign in to come in.
        </p>

        {notice && (
          <p role="alert" className={cx(tone.card, "mt-6 flex gap-2.5 px-4 py-3 text-left text-sm leading-relaxed text-mp-ink")}>
            <Icon name="circle-alert" size={18} className="mt-0.5 shrink-0 text-mp-maple" />
            {notice}
          </p>
        )}

        <div className="mt-8 min-h-[52px] space-y-3">
          {google && (
            // A full-page hop to the OAuth redirect route, not a client-side page (so not <Link>).
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a
              href="/api/maple/auth/start?return=%2Fmaple"
              className="flex min-h-[52px] w-full items-center justify-center gap-3 rounded-[14px] bg-mp-accent px-5 text-base font-semibold text-mp-on-accent transition hover:opacity-90 active:scale-[0.98]"
            >
              {/* Google's mark on its own white chip, as their dark-button style asks. */}
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white [.maple-night_&]:opacity-80">
                <GoogleG />
              </span>
              Continue with Google
            </a>
          )}
          {nothing && <p className={cx(tone.muted, "text-sm")}>Sign-in isn&apos;t set up yet. Ask Matt to finish setting up Maple&apos;s Log.</p>}
        </div>

        {passwordOk && (
          <div className="mt-4">
            {!showPassword ? (
              <button
                type="button"
                onClick={() => setShowPassword(true)}
                className="min-h-[44px] px-3 text-[15px] font-medium text-mp-accent-fg"
              >
                Use the site admin password
              </button>
            ) : (
              <form onSubmit={(e) => void submit(e)} className={cx(tone.card, "space-y-3 p-4 text-left")}>
                <p className={tone.label}>Site admin password</p>
                <input
                  className={tone.input}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Username"
                  aria-label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                <input
                  className={tone.input}
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  aria-label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {error && (
                  <p role="alert" className="flex gap-1.5 text-sm font-medium text-mp-danger">
                    <Icon name="circle-alert" size={16} className="mt-0.5 shrink-0" />
                    {error}
                  </p>
                )}
                <Button type="submit" variant={google ? "soft" : "primary"} className="w-full" disabled={busy || !username || !password}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </form>
            )}
          </div>
        )}

        <p className={cx(tone.faint, "mx-auto mt-10 max-w-[18rem] text-[13px] leading-relaxed")}>
          Got an invite link from Matt or Brittany? Just open it on this phone and you&apos;re in.
        </p>
      </motion.div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

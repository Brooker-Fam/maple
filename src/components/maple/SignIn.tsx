"use client";

import { motion } from "framer-motion";
import { useEffect, useState, type FormEvent } from "react";
import { FallingLeaves, Fireflies, MapleLeaf, useStill } from "./art";
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
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
      <FallingLeaves count={7} className="opacity-60 dark:opacity-40" />
      <Fireflies count={6} />

      <motion.div
        className="relative w-full max-w-sm text-center"
        initial={still ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[28px] bg-[#FDF8F0] shadow-[0_8px_30px_rgba(196,154,60,0.25)] ring-1 ring-[#C49A3C]/20 dark:bg-[#12261A] dark:shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
          <MapleLeaf size={72} />
        </div>
        <h1 className={cx(tone.heading, "mt-5 text-[40px] leading-tight")}>Maple&apos;s Log</h1>
        <p className={cx(tone.body, "mx-auto mt-2 max-w-[19rem] text-[16px] leading-relaxed")}>
          This corner of the forest is just for Maple&apos;s family. Sign in to come in.
        </p>

        {notice && (
          <p role="alert" className="mt-5 rounded-2xl border border-[#C49A3C]/35 bg-[#C49A3C]/10 px-4 py-3 text-left text-sm leading-relaxed text-[#5A3E12] dark:border-[#C49A3C]/30 dark:bg-[#C49A3C]/10 dark:text-[#F0DDB0]">
            {notice}
          </p>
        )}

        <div className="mt-7 min-h-[56px] space-y-3">
          {google && (
            // A full-page hop to the OAuth redirect route, not a client-side page (so not <Link>).
            // eslint-disable-next-line @next/next/no-html-link-for-pages
            <a
              href="/api/maple/auth/start?return=%2Fmaple"
              className="flex min-h-[56px] w-full items-center justify-center gap-3 rounded-full border border-[#1D4420]/15 bg-white px-5 text-base font-semibold text-[#1F2A1E] shadow-sm transition hover:shadow-md active:scale-[0.98] dark:border-transparent dark:bg-[#FDF8F0] dark:text-[#14210F]"
            >
              <GoogleG />
              Continue with Google
            </a>
          )}
          {nothing && <p className={cx(tone.muted, "text-sm")}>Sign-in isn&apos;t set up yet. Ask Matt to finish setting up Maple&apos;s Log.</p>}
        </div>

        {passwordOk && (
          <div className="mt-5">
            {!showPassword ? (
              <button
                type="button"
                onClick={() => setShowPassword(true)}
                className={cx(tone.muted, "min-h-[44px] px-3 text-sm underline decoration-[#C49A3C]/50 underline-offset-4 hover:text-[#1D4420] dark:hover:text-[#F5EDDF]")}
              >
                Use the site admin password
              </button>
            ) : (
              <form onSubmit={(e) => void submit(e)} className="space-y-3 text-left">
                <p className={cx(tone.label, "text-center")}>Site admin password</p>
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
                  <p role="alert" className="text-sm font-medium text-[#9A3A24] dark:text-[#F4A68F]">
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

        <p className={cx(tone.muted, "mx-auto mt-8 max-w-[18rem] text-xs leading-relaxed")}>
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

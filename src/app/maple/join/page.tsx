"use client";

import { useEffect, useState } from "react";
import { Fireflies, MapleLeaf } from "@/components/maple/art";
import { cx, tone } from "@/components/maple/ui";

/**
 * /maple/join#<token> — where a one-time invite link lands (for grandparents
 * and helpers without Google). The token rides in the #fragment, so it never
 * reaches server logs; we post it to /api/maple/auth/join, which redeems it
 * and sets the session cookie, then hop into the app. Robots noindex comes
 * from the /maple layout.
 */

type Phase =
  | { kind: "working" }
  | { kind: "welcome"; name: string | null }
  | { kind: "missing" }
  | { kind: "used"; message: string }
  | { kind: "busy" }
  | { kind: "offline" };

// Redeem once per token, even if React runs the effect twice (dev Strict Mode).
const attempts = new Map<string, Promise<Response>>();

export default function JoinPage() {
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const [token, setToken] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const read = () => {
      let raw = window.location.hash.replace(/^#/, "").trim();
      try {
        raw = decodeURIComponent(raw);
      } catch {
        // keep it as typed
      }
      const t = raw.startsWith("t=") ? raw.slice(2) : raw;
      if (t) setToken(t);
      else setPhase((p) => (p.kind === "working" ? { kind: "missing" } : p));
    };
    read();
    // Pasting the full link into this same tab only changes the #fragment.
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  useEffect(() => {
    if (!token) return;
    let live = true;
    setPhase({ kind: "working" });
    // Once the link is spent (or worked), keep the key out of history.
    const forget = () => window.history.replaceState(window.history.state, "", window.location.pathname);
    let attempt = attempts.get(token);
    if (!attempt) {
      attempt = fetch("/api/maple/auth/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      attempts.set(token, attempt);
    }
    attempt
      .then(async (res) => {
        const body = (await res.clone().json().catch(() => ({}))) as { error?: string; member?: { display_name?: string | null } };
        if (!live) return;
        if (res.ok) {
          forget();
          setPhase({ kind: "welcome", name: body.member?.display_name ?? null });
          setTimeout(() => window.location.replace("/maple"), 1400);
        } else if (res.status === 429) {
          setPhase({ kind: "busy" });
        } else if (res.status >= 500) {
          attempts.delete(token);
          setPhase({ kind: "offline" });
        } else {
          forget();
          setPhase({
            kind: "used",
            message: body.error ?? "This invite link has already been used or has expired. Ask Matt or Brittany for a fresh one.",
          });
        }
      })
      .catch(() => {
        attempts.delete(token);
        if (live) setPhase({ kind: "offline" });
      });
    return () => {
      live = false;
    };
  }, [token, tries]);

  const retry = () => {
    if (token) attempts.delete(token);
    setTries((n) => n + 1);
  };

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center">
      <Fireflies count={5} />
      <div className="relative w-full max-w-sm">
        <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-[28px] bg-[#FDF8F0] shadow-[0_8px_30px_rgba(196,154,60,0.25)] ring-1 ring-[#C49A3C]/20 dark:bg-[#12261A] dark:shadow-none">
          <MapleLeaf size={72} />
        </div>

        {phase.kind === "working" && (
          <>
            <h1 className={cx(tone.heading, "mt-6 text-[34px] leading-tight")}>Opening the gate…</h1>
            <p className={cx(tone.muted, "mt-2 text-[15px]")} aria-live="polite">
              Checking your invite to Maple&apos;s Log.
            </p>
          </>
        )}

        {phase.kind === "welcome" && (
          <>
            <h1 className={cx(tone.heading, "mt-6 text-[34px] leading-tight")}>Welcome{phase.name ? `, ${phase.name}` : ""}!</h1>
            <p className={cx(tone.body, "mt-2 text-[15px] leading-relaxed")} aria-live="polite">
              You&apos;re in. Taking you to Maple&apos;s Log…
            </p>
            <a href="/maple" className="mt-6 inline-flex min-h-[48px] items-center rounded-full bg-[#1D4420] px-6 font-semibold text-[#FDF8F0] dark:bg-[#C49A3C] dark:text-[#14210F]">
              Go to Maple&apos;s Log
            </a>
          </>
        )}

        {phase.kind === "missing" && (
          <Stuck title="This link is missing its key">
            Invite links look like <span className="font-mono text-[13px]">brooker.family/maple/join#…</span> with a long code at the end. Try
            copying the whole link again, or ask Matt or Brittany to send a fresh one.
          </Stuck>
        )}

        {phase.kind === "used" && <Stuck title="This link no longer works">{phase.message}</Stuck>}

        {phase.kind === "busy" && (
          <Stuck title="A few too many tries">
            Take a short break and open the link again in a little while.
            <RetryButton onClick={retry} />
          </Stuck>
        )}

        {phase.kind === "offline" && (
          <Stuck title="Couldn't reach the forest">
            Check your connection, then try again. Your link still works.
            <RetryButton onClick={retry} />
          </Stuck>
        )}
      </div>
    </div>
  );
}

function Stuck({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className={cx(tone.heading, "mt-6 text-[32px] leading-tight")}>{title}</h1>
      <div role="alert" className={cx(tone.body, "mt-3 text-[15px] leading-relaxed")}>
        {children}
      </div>
      <a href="/maple" className={cx(tone.muted, "mt-6 inline-flex min-h-[44px] items-center text-sm underline decoration-[#C49A3C]/50 underline-offset-4")}>
        Already signed in? Go to Maple&apos;s Log
      </a>
    </>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="mt-5 block">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex min-h-[48px] items-center rounded-full bg-[#1D4420] px-6 font-semibold text-[#FDF8F0] dark:bg-[#C49A3C] dark:text-[#14210F]"
      >
        Try again
      </button>
    </span>
  );
}

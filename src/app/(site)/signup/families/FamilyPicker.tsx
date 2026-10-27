"use client";

import { useEffect, useState } from "react";

type Choice = { familyId: number; label: string; role: "owner" | "member" | "viewer"; current: boolean; onboarding: boolean };
type View = { kind: "loading" } | { kind: "signed_out" } | { kind: "one" } | { kind: "list"; families: Choice[] } | { kind: "error"; message: string };

const OUTBOX_KEY = "maple-outbox-v1";
const ROLE: Record<Choice["role"], string> = { owner: "Owner", member: "Can log", viewer: "View only" };

// Writes still waiting on this phone would post to whichever family is signed in when they send.
function outboxWaiting(): boolean {
  try {
    const items: unknown = JSON.parse(window.localStorage.getItem(OUTBOX_KEY) ?? "[]");
    return Array.isArray(items) && items.length > 0;
  } catch {
    return false;
  }
}

export default function FamilyPicker() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/maple/signup/families", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) return setView({ kind: "signed_out" });
        const body = (await res.json().catch(() => null)) as { switcher?: boolean; families?: Choice[]; error?: string } | null;
        if (!res.ok || !body) return setView({ kind: "error", message: body?.error ?? "Couldn’t load your families. Try again in a minute." });
        setView(body.switcher && body.families ? { kind: "list", families: body.families } : { kind: "one" });
      })
      .catch(() => setView({ kind: "error", message: "Couldn’t reach Maple. Check your connection and try again." }));
  }, []);

  async function pick(f: Choice) {
    if (f.current) return window.location.assign("/maple");
    if (outboxWaiting()) {
      return setView({ kind: "error", message: "This phone has entries still waiting to send. Open the log until they’ve sent, then switch." });
    }
    setBusy(f.familyId);
    try {
      const res = await fetch("/api/maple/signup/families", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ familyId: f.familyId }),
      });
      if (res.ok) return window.location.assign("/maple");
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setView({ kind: "error", message: body?.error ?? "Couldn’t switch. Try again in a minute." });
    } catch {
      setView({ kind: "error", message: "Couldn’t reach Maple. Check your connection and try again." });
    }
    setBusy(null);
  }

  if (view.kind === "loading") return <p className="site-prose mt-4">Loading…</p>;
  if (view.kind === "signed_out" || view.kind === "one") {
    return (
      <p className="site-prose mt-4">
        {view.kind === "signed_out" ? "Sign in to see your families." : "You’re in one family’s log."}{" "}
        <a className="site-link" href="/maple" rel="nofollow">
          {view.kind === "signed_out" ? "Sign in" : "Open it"}
        </a>
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <p role="alert" className="mt-4 text-[15px] leading-relaxed text-mp-danger">
        {view.message}
      </p>
    );
  }
  return (
    <ul className="mt-8 flex max-w-[34rem] flex-col gap-3">
      {view.families.map((f) => (
        <li key={f.familyId}>
          <button
            type="button"
            onClick={() => pick(f)}
            disabled={busy !== null}
            aria-current={f.current || undefined}
            className="flex min-h-[64px] w-full items-center justify-between gap-4 rounded-[18px] border border-mp-line bg-mp-surface px-5 py-3 text-left disabled:opacity-70"
          >
            <span>
              <span className="block text-[17px] font-semibold text-mp-ink">{f.label}</span>
              <span className="block text-[14px] text-mp-ink-3">
                {ROLE[f.role]}
                {f.onboarding ? " · setting up" : ""}
              </span>
            </span>
            <span className="text-[14px] text-mp-ink-2">{busy === f.familyId ? "Switching…" : f.current ? "Signed in" : "Switch"}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

"use client";

import { useState } from "react";
import { CONTACT_EMAIL } from "@/components/site/legal";
import { TRACKER_NOTE } from "@/lib/maple/guidelines";
import { useBabyWords, useFamilyOne } from "../familyWords";
import { Icon } from "../icons";
import { LegalLinks } from "../Legal";
import { useNotifications } from "../notify";
import { Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { DANGER_TEXT, GROUP, Row, Section } from "./parts";

const FEEDBACK_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Maple feedback")}`;

export function About() {
  return (
    <Section title="About">
      <div className={GROUP}>
        <a href={FEEDBACK_HREF} className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="lightbulb" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-mp-accent-fg">Send feedback</span>
            <span className={cx(tone.muted, "block truncate text-[13px] leading-snug")}>{CONTACT_EMAIL}</span>
          </span>
        </a>
        <div className="flex items-center gap-3 py-1 pr-2 pl-4">
          <p className={cx(tone.muted, "min-w-0 flex-1 text-[13px] leading-snug")}>{TRACKER_NOTE}</p>
          <LegalLinks className="shrink-0" />
        </div>
      </div>
    </Section>
  );
}

// ── Data and account ─────────────────────────────────────────────────────

export function DataAndAccount() {
  const { api, refresh, state, memberName, toast } = useMaple();
  const one = useFamilyOne();
  const [leaving, setLeaving] = useState(false);
  const w = useBabyWords();
  const notify = useNotifications();
  const [busy, setBusy] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const guest = state!.me.email.startsWith("invite:");
  const signOut = async () => {
    setBusy(true);
    // This phone stops getting notices first (it tells the server and unsubscribes), while the session still works.
    await notify.forgetThisPhone({ everywhere: true });
    try {
      await api("/api/maple/auth/signout", { method: "POST" });
    } catch {
      toast("Couldn't confirm sign-out. Try again.", { tone: "error" });
    }
    await refresh();
    setBusy(false);
  };
  // What you logged stays in their log; this phone stops its notices first, as signing out does.
  const leave = async () => {
    setBusy(true);
    await notify.forgetThisPhone();
    try {
      await api(`/api/maple/members?email=${encodeURIComponent(state!.me.email)}`, { method: "DELETE" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't leave just now", { tone: "error" });
      setLeaving(false);
    }
    await refresh();
    setBusy(false);
  };
  return (
    <Section title="Data & account">
      <div className={GROUP}>
        <a href="/api/maple/export" download className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="download" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-mp-accent-fg">Download {w.name}&apos;s log (CSV)</span>
            <span className={cx(tone.muted, "block text-[13px] leading-snug")}>Baby-log entries for a spreadsheet or {w.his} pediatrician. Photo files, recovery records and chat are not included.</span>
          </span>
        </a>
        <Row label={<span className="block truncate">Signed in as {memberName(state!.me.email)}</span>}>
          <button type="button" disabled={busy} onClick={() => guest ? setConfirmSignOut(true) : void signOut()} className={DANGER_TEXT}>
            Sign out
          </button>
        </Row>
        {guest && confirmSignOut && (
          <div className="space-y-3 px-4 py-3">
            <p className={cx(tone.body, "text-[15px] leading-relaxed")}>You joined with a one-time link. After signing out, you will need a new invite from a family owner. The link you used cannot sign you in again.</p>
            <div className="flex gap-2">
              <Button variant="danger" disabled={busy} onClick={() => void signOut()}>{busy ? "Signing out…" : "Sign out anyway"}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmSignOut(false)}>Stay signed in</Button>
            </div>
          </div>
        )}
        {!one && state!.me.email !== "admin" && (
          <Row label={<span className="block truncate">Leave this family&apos;s log</span>}>
            {leaving ? (
              <button type="button" disabled={busy} onClick={() => void leave()} className={DANGER_TEXT}>
                Leave for good
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => setLeaving(true)} className={DANGER_TEXT}>
                Leave
              </button>
            )}
          </Row>
        )}
      </div>
    </Section>
  );
}

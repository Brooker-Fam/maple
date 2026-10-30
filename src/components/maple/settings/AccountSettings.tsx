"use client";

import { useState } from "react";
import { TRACKER_NOTE } from "@/lib/maple/guidelines";
import { useBabyWords, useFamilyOne } from "../familyWords";
import { Icon } from "../icons";
import { LegalLinks } from "../Legal";
import { useNotifications } from "../notify";
import SignOutButton from "../SignOutButton";
import { cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { FeedbackSheet } from "./FeedbackSheet";
import { DANGER_TEXT, GROUP, Row, Section } from "./parts";

export function About() {
  const [feedback, setFeedback] = useState(false);
  return (
    <Section title="About">
      <div className={GROUP}>
        <button type="button" onClick={() => setFeedback(true)} className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="lightbulb" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-mp-accent-fg">Send feedback</span>
            <span className={cx(tone.muted, "block truncate text-[13px] leading-snug")}>A problem, an idea, or what you like</span>
          </span>
        </button>
        <div className="flex items-center gap-3 py-1 pr-2 pl-4">
          <p className={cx(tone.muted, "min-w-0 flex-1 text-[13px] leading-snug")}>{TRACKER_NOTE}</p>
          <LegalLinks className="shrink-0" />
        </div>
      </div>
      <FeedbackSheet open={feedback} onClose={() => setFeedback(false)} />
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
        {state?.me.role !== "photos" && <a href="/api/maple/export" download className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="download" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-mp-accent-fg">Download {w.name}&apos;s log (CSV)</span>
            <span className={cx(tone.muted, "block text-[13px] leading-snug")}>Baby-log entries for a spreadsheet or {w.his} pediatrician. Photo files, recovery records and chat are not included.</span>
          </span>
        </a>}
        <Row label={<span className="block truncate">Signed in as {memberName(state!.me.email)}</span>}>
          <SignOutButton disabled={busy} className={DANGER_TEXT} />
        </Row>
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

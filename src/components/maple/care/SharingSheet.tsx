"use client";

import { useState } from "react";
import { SUPPORT } from "@/lib/maple/guidelines";
import { Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { ConfirmSheet, Footnote, GROUP, Problem, SwitchRow, eligibleMembers, errorText } from "./parts";
import type { UseCare } from "./useCare";

/**
 * "Who sees this" (§9.3), hers only: one switch per owner or member (never
 * a viewer, never the admin login), what stays hers whatever she picks, and
 * deleting the whole page. Owners and the admin password can't change any
 * of this for her (the server checks manage on every write).
 */
export default function SharingSheet({ open, onClose, care, onDeleted }: { open: boolean; onClose: () => void; care: UseCare; onDeleted: () => void }) {
  const { state, memberName, api, refresh } = useMaple();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const her = care.state.person.member;
  const people = eligibleMembers(state?.members ?? []).filter((m) => m.email !== her);
  const shared = care.state.shared_with ?? [];

  // The switch moves at once (useCare patches this phone's state first); a refusal says so and the poll puts it back.
  const toggle = async (email: string, on: boolean) => {
    setBusy(email);
    setProblem(null);
    try {
      const next = on ? [...new Set([...shared, email])] : shared.filter((x) => x !== email);
      await care.act.patchPerson({ shared_with: next });
    } catch (e) {
      setProblem(errorText(e));
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    setBusy("delete");
    try {
      await api("care/person", { method: "DELETE", body: JSON.stringify({ confirm: true }) });
      setConfirm(false);
      onDeleted();
      await refresh();
    } catch (e) {
      setConfirm(false);
      setProblem(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Sheet open={open && !confirm} onClose={onClose} title="Who sees this">
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>Only the people you pick can see this. Viewers never can.</p>
        {people.length > 0 && (
          <div className={GROUP}>
            {people.map((m) => (
              <SwitchRow
                key={m.email}
                label={memberName(m.email)}
                note="Can see and log your medicines, temperature and questions"
                checked={shared.includes(m.email)}
                disabled={busy === m.email}
                onChange={(v) => void toggle(m.email, v)}
              />
            ))}
          </div>
        )}
        <Problem>{problem}</Problem>
        <Footnote className="mt-0">
          Anything you mark Only me stays yours. Check-ins are always only yours: they never go to anyone else, their Claude or ChatGPT, the admin login or the calendar
          connector. People you share with can see the rest through their own Claude or ChatGPT too.
        </Footnote>
        <p className={cx(tone.muted, "px-1 text-[13px] leading-snug")}>{SUPPORT.privacy}</p>
        <div className={GROUP}>
          <button type="button" onClick={() => setConfirm(true)} className={cx(tone.row, "min-h-[52px] py-2.5 text-[15px] font-medium text-mp-danger")}>
            Delete this page and everything on it
          </button>
        </div>
      </Sheet>
      <ConfirmSheet
        open={open && confirm}
        onClose={() => setConfirm(false)}
        title="Delete everything here for good?"
        body="Your medicines, readings, check-ins and questions will be deleted. This can't be undone."
        confirm="Delete for good"
        danger
        busy={busy === "delete"}
        onConfirm={() => void deleteAll()}
      />
    </>
  );
}

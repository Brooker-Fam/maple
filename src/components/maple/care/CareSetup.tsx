"use client";

import { useState } from "react";
import type { Member } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Avatar, Button, Sheet, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { useCareNav } from "./CareNav";
import { Footnote, GROUP, Problem, eligibleMembers, errorText } from "./parts";
import { useCareSetup } from "./useCare";

/**
 * "Medicines and support after the birth" (§9.3): one explicit tap picks who
 * it's for (an owner or member, never admin or a viewer), with a confirm when
 * it's someone else. The app never guesses who gave birth.
 *
 * Before setup there's no care state to act through (useCare is null), so
 * this posts to /api/maple/care/person itself and then opens her screen.
 * Who may set it up comes from the server (state.care_setup): any owner,
 * member or the admin login, for any owner or member; nobody once it exists.
 */
export type CareSetupProps = { open: boolean; onClose: () => void };

export default function CareSetup({ open, onClose }: CareSetupProps) {
  const { state, api, refresh, memberName } = useMaple();
  const nav = useCareNav();
  const mode = useCareSetup();
  const [pick, setPick] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const me = state?.me;
  const members = state?.members ?? [];
  const eligible = eligibleMembers(members);
  const choices = mode === "anyone" ? eligible : mode === "self" ? eligible.filter((m) => m.email === me?.email) : [];

  const close = () => {
    setPick(null);
    setProblem(null);
    onClose();
  };

  const setup = async (m: Member) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api("care/person", { method: "POST", body: JSON.stringify({ member: m.email }) });
      await refresh();
      close();
      // Her screen next, with the empty list and "Add a medicine" (let this sheet start closing first).
      window.setTimeout(() => nav.openCare(), 150);
    } catch (e) {
      setPick(null);
      setProblem(e instanceof ApiError && e.status === 409 ? "This is already set up. She decides who sees it." : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // The default sharing (§9.1): every other current owner, never admin, never a viewer.

  return (
    <>
      <Sheet open={open && !pick} onClose={close} title="Medicines and support after the birth">
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Keep track of mom&apos;s medicines on her doctor&apos;s schedule, with help lines for the weeks after birth. Who&apos;s it for?
        </p>
        {choices.length ? (
          <div>
            <div className={GROUP}>
              {choices.map((m) => (
                <button
                  key={m.email}
                  type="button"
                  disabled={busy}
                  onClick={() => (m.email === me?.email ? void setup(m) : setPick(m))}
                  className={cx(tone.row, "min-h-[56px] py-2.5 disabled:opacity-50")}
                >
                  <Avatar member={m} size={30} />
                  <span className={cx(tone.body, "min-w-0 flex-1 text-[16px] font-medium")}>
                    {memberName(m.email)}
                    {m.email === me?.email ? " (you)" : ""}
                  </span>
                  <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
                </button>
              ))}
            </div>
            <Footnote>One person per log. Everyone signed in to Maple&apos;s Log can see it and log on it.</Footnote>
          </div>
        ) : (
          <p className={cx(tone.muted, "text-[15px]")}>An owner of this log can set this up.</p>
        )}
        <Problem>{problem}</Problem>
      </Sheet>
      <Sheet
        open={open && !!pick}
        onClose={() => setPick(null)}
        title={pick ? `Set this up for ${memberName(pick.email)}?` : ""}
        footer={
          <div className="flex gap-3">
            <Button variant="soft" size="lg" className="flex-1" onClick={() => setPick(null)}>
              Cancel
            </Button>
            <Button size="lg" className="flex-1" disabled={busy} onClick={() => pick && void setup(pick)}>
              {busy ? "Setting up…" : "Set up"}
            </Button>
          </div>
        }
      >
        {pick && (
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>A page for her medicines, temperature, questions and check-ins.</p>
        )}
      </Sheet>
    </>
  );
}

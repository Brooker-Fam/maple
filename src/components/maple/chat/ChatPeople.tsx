"use client";

import { useState } from "react";
import { CARE_LEVEL_LABEL, careLevelOf, matchPerson, parseCareLevel, ROLE_FROM_WORD, ROLE_LABEL, type CareLevel } from "@/lib/maple/access";
import type { ChatInvite } from "@/lib/maple/chat/types";
import type { Member, Role } from "@/lib/maple/types";
import { useCare } from "../care/useCare";
import { CopyButton } from "../settings/parts";
import { Avatar, Button, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * The chat's cards for changing who's in the family (people-mcp.ts):
 * inviting someone, changing what they reach, removing them. Each waits for
 * this tap, which is the person's yes; the server runs only the call it
 * stored, after Invite, Change or Remove. Then the invite's link, to copy.
 */

export const PEOPLE_APPROVALS = new Set(["invite_person", "change_access", "remove_person"]);

/** What a card says once it's been passed by, answered no, or answered yes without a result yet. */
export function approvalWords(name: string): { idle: string; kept: string; unknown: string } {
  switch (name) {
    case "invite_person":
      return { idle: "Nobody was invited.", kept: "Not invited.", unknown: "That didn't finish. Check People & permissions to see whether they were invited." };
    case "change_access":
      return { idle: "Nobody's access changed.", kept: "Kept. Their access didn't change.", unknown: "That didn't finish. Check People & permissions to see whether their access changed." };
    case "remove_person":
      return { idle: "Nobody was removed.", kept: "Kept. Nobody was removed.", unknown: "That didn't finish. Check People & permissions to see whether they were removed." };
    default:
      return { idle: "Nothing was deleted.", kept: "Kept. Nothing was deleted.", unknown: "That didn't finish. Check the log to see whether it was deleted." };
  }
}

type Input = { email?: unknown; name?: unknown; person?: unknown; access?: unknown; mom_page?: unknown };

const roleOf = (word: unknown): Role | null => (typeof word === "string" && ROLE_FROM_WORD[word] ? ROLE_FROM_WORD[word] : null);

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <p className="flex items-baseline justify-between gap-3 text-[14px] leading-snug">
      <span className={tone.muted}>{label}</span>
      <span className={cx(tone.body, "text-right font-medium")}>{value}</span>
    </p>
  );
}

export function PeopleApproval({ name, input, onAnswer }: { name: string; input: unknown; onAnswer: (approved: boolean) => void }) {
  const { state, memberName } = useMaple();
  const care = useCare();
  const [answered, setAnswered] = useState(false);
  const raw = (input ?? {}) as Input;
  const members = state?.members ?? [];
  // Her page's name only for someone who can see it (owners always can); the line is left off where there's none.
  const page = care ? `${care.name}'s page` : null;
  const herself = care?.state?.person?.member ?? null;
  const levelOf = (m: Member) => (m.email === herself && (m.role === "owner" || m.role === "member") ? "log" : careLevelOf(m));
  const pageRow = (role: Role, level: CareLevel, before?: CareLevel) =>
    page && role !== "photos" && role !== "owner" ? <Row label={page} value={before && before !== level ? `${CARE_LEVEL_LABEL[before]} → ${CARE_LEVEL_LABEL[level]}` : CARE_LEVEL_LABEL[level]} /> : null;

  let title: string;
  let yes: string;
  let body: React.ReactNode;
  let danger = false;
  if (name === "invite_person") {
    const role = roleOf(raw.access);
    const level = role ? careLevelOf({ role, care: parseCareLevel(raw.mom_page) }) : null;
    title = "Invite this person?";
    yes = "Invite";
    body = (
      <div className="space-y-1.5">
        <p className={cx(tone.body, "text-[15px] leading-snug font-medium break-all")}>{typeof raw.email === "string" ? raw.email : "Their email address"}</p>
        {typeof raw.name === "string" && raw.name.trim() && <Row label="Shown as" value={raw.name.trim()} />}
        {role && <Row label="Baby's log" value={ROLE_LABEL[role]} />}
        {role && level && pageRow(role, level)}
        <p className={cx(tone.muted, "text-[13px] leading-snug")}>Only that email address can use the invite.</p>
      </div>
    );
  } else {
    const people = members.map((m) => ({ ...m, id: m.email, name: memberName(m.email) }));
    const hit = typeof raw.person === "string" ? matchPerson(raw.person, people) : { missing: true as const };
    const target = "found" in hit ? members.find((m) => m.email === hit.found.id) ?? null : null;
    const who = target ? memberName(target.email) : typeof raw.person === "string" ? raw.person : "this person";
    const id = target && target.email !== "admin" && !target.email.startsWith("invite:") ? target.email : null;
    const person = (
      <div className="flex items-center gap-3">
        <Avatar member={target} size={36} />
        <span className="min-w-0">
          <span className={cx(tone.body, "block truncate text-[15px] leading-snug font-medium")}>{who}</span>
          {id && <span className={cx(tone.muted, "block truncate text-[13px] leading-snug")}>{id}</span>}
        </span>
      </div>
    );
    if (name === "remove_person") {
      title = `Remove ${who}?`;
      yes = "Remove";
      danger = true;
      body = (
        <div className="space-y-2">
          {person}
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>Their sign-ins, connected assistants and Siri keys stop working. What they logged stays.</p>
        </div>
      );
    } else {
      const role = roleOf(raw.access) ?? target?.role ?? null;
      const set = parseCareLevel(raw.mom_page);
      const level = role ? careLevelOf({ role, care: set ?? target?.care ?? null }) : null;
      title = `Change ${who}'s access?`;
      yes = "Change";
      body = (
        <div className="space-y-2">
          {person}
          {role && <Row label="Baby's log" value={target && target.role !== role ? `${ROLE_LABEL[target.role]} → ${ROLE_LABEL[role]}` : ROLE_LABEL[role]} />}
          {role && level && pageRow(role, level, target ? levelOf(target) : undefined)}
        </div>
      );
    }
  }
  const answer = (ok: boolean) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(ok);
  };
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label={title}>
      <p className="text-[13px] font-semibold text-mp-ink-2">{title}</p>
      {body}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="soft" onClick={() => answer(false)} disabled={answered}>
          {name === "invite_person" ? "Cancel" : "Keep"}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => answer(true)} disabled={answered}>
          {yes}
        </Button>
      </div>
    </section>
  );
}

/** After an invite: who it's for, and its link to copy (it opens only for that address). */
export function InviteCard({ invite }: { invite: ChatInvite }) {
  const title = invite.emailed ? "Invite emailed" : "Invite ready";
  return (
    <section className={cx(tone.card, "space-y-2.5 p-4")} aria-label={title}>
      <p className="text-[13px] font-semibold text-mp-ink-2">{title}</p>
      <p className={cx(tone.body, "text-[15px] leading-snug font-medium break-all")}>{invite.email}</p>
      <p className={cx(tone.muted, "text-[13px] leading-snug")}>
        {invite.emailed ? "Maple emailed them the link." : "Email isn't set up here, so send them this link."} It works once, for 7 days, and only when they sign in with that address.
      </p>
      <CopyButton text={invite.url} label="Copy invite link" className="min-h-[44px] w-full text-[15px]" />
    </section>
  );
}

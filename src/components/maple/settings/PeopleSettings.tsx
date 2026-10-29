"use client";

import { useCallback, useEffect, useState } from "react";
import type { Member, Role } from "@/lib/maple/types";
import { MAPLE_HOST } from "@/lib/maple/origin";
import { useCare } from "../care/useCare";
import { useBabyWords } from "../familyWords";
import { Icon } from "../icons";
import { Avatar, Button, Field, MEMBER_PALETTE, Sheet, cx, memberColor, tone } from "../ui";
import { useMaple } from "../useMaple";
import { ActionRow, CopyButton, DANGER_TEXT, EmojiPicker, GROUP, Section } from "./parts";
import { useSettingsDraft } from "./DraftContext";
import SharingRolePicker, { SHARING_ROLES, type InviteRole } from "./SharingRolePicker";

type Invite = {
  id: number;
  role: Role;
  /** A pending invite for one email address (outside family 1). */
  email?: string | null;
  display_name: string | null;
  emoji: string | null;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
};

const ROLE_LINE: Record<Role, string> = {
  owner: "Owner · can invite and manage",
  member: "Can log",
  viewer: "View only",
  photos: "Photos only",
};


export default function People() {
  const { state, api, toast, now } = useMaple();
  const w = useBabyWords();
  const care = useCare();
  const me = state!.me;
  const owner = me.role === "owner";
  const members = state!.members;
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteProblem, setInviteProblem] = useState<string | null>(null);
  const [loadingInvites, setLoadingInvites] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const loadInvites = useCallback(async () => {
    if (!owner) return;
    setLoadingInvites(true);
    try {
      const r = await api<{ invites: Invite[] }>("/api/maple/invites");
      setInvites(r.invites);
      setInviteProblem(null);
    } catch {
      setInviteProblem("Couldn't check pending invites. Try again to see who still has a link.");
    } finally {
      setLoadingInvites(false);
    }
  }, [api, owner]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites, members.length]);

  const revoke = async (inv: Invite) => {
    try {
      const r = await api<{ invites: Invite[] }>(`/api/maple/invites?id=${inv.id}`, { method: "DELETE" });
      setInvites(r.invites);
      toast(`Invite for ${inv.display_name ?? inv.email ?? "them"} revoked`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke that", { tone: "error" });
    }
  };

  const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - now().getTime()) / 864e5));

  return (
    <>
      <Section
        title={`${w.name}'s people`}
        footnote={owner && members.length === 1 ? `It's just you so far. Invite ${care && !care.self ? care.name : "family"}, grandparents, or anyone helping out.` : undefined}
      >
        <ul className={GROUP}>
          {members.map((m) => (
            <MemberRow key={m.email} m={m} me={me} owner={owner} />
          ))}
          {/* Invite links not used yet sit with the people they're for. */}
          {owner &&
            invites.map((inv) => {
              const d = daysLeft(inv.expires_at);
              return (
                <li key={`invite-${inv.id}`} className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-[22px] text-mp-ink-2" aria-hidden>
                    {inv.emoji ?? <Icon name="link" size={18} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cx(tone.body, "truncate text-[15px] font-medium")}>{inv.display_name ?? inv.email ?? "Someone"}</p>
                    <p className={cx(tone.muted, "text-[13px] leading-snug")}>
                      Invite link waiting · {ROLE_LINE[inv.role]} · expires {d <= 1 ? "within a day" : `in ${d} days`}
                    </p>
                  </div>
                  <button type="button" onClick={() => void revoke(inv)} className={DANGER_TEXT}>
                    Revoke
                  </button>
                </li>
              );
            })}
        </ul>
        {owner && inviteProblem && (
          <div className={cx(tone.inset, "mt-3 space-y-2 px-4 py-3")}>
            <p role="alert" className={cx(tone.body, "text-[14px] leading-snug")}>{inviteProblem}</p>
            <Button variant="soft" size="sm" disabled={loadingInvites} onClick={() => void loadInvites()}>
              {loadingInvites ? "Checking…" : "Try again"}
            </Button>
          </div>
        )}
      </Section>

      {owner && (
        <Section title="Invite someone">
          <div className={GROUP}>
            <InviteByEmail onInvited={() => void loadInvites()} />
            <ActionRow
              icon="link"
              label="Invite with a one-time link"
              note="A one-time link for grandparents or a helper. No account needed."
              chevron
              onClick={() => setLinkOpen(true)}
            />
          </div>
          <InviteLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} onCreated={() => void loadInvites()} />
        </Section>
      )}
    </>
  );
}

function MemberRow({ m, me, owner }: { m: Member; me: Member; owner: boolean }) {
  const { state, api, refresh, toast, memberName } = useMaple();
  const isMe = m.email === me.email;
  // The site admin password signs in as the "admin" owner; a real owner can switch it off.
  const isAdminLogin = m.email === "admin";
  const [editing, setEditing] = useState(false);
  const [managing, setManaging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [name, setName] = useState(m.display_name ?? "");
  // "" is their initial: emoji are opt-in.
  const [emoji, setEmoji] = useState(m.emoji ?? "");
  const [busy, setBusy] = useState(false);

  const who = m.email === "admin" ? "Site admin login" : m.email.startsWith("invite:") ? "Joined with an invite link" : m.email;
  useSettingsDraft(`member:${m.email}`, editing && (name !== (m.display_name ?? "") || emoji !== (m.emoji ?? "")));
  const sub = owner && !isMe ? `${ROLE_LINE[m.role]} · ${who}` : ROLE_LINE[m.role];

  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api("/api/maple/members", { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
      toast(done);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async () => {
    setBusy(true);
    try {
      await api(`/api/maple/members?email=${encodeURIComponent(m.email)}`, { method: "DELETE" });
      await refresh();
      toast(`${memberName(m.email)} removed`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove them", { tone: "error" });
      setBusy(false);
    }
  };

  const confirmRow = (question: string, yes: string) => (
    <div className="flex items-center gap-2">
      <p className={cx(tone.body, "flex-1 text-sm")}>{question}</p>
      <Button variant="danger" size="sm" disabled={busy} onClick={() => void removeMember()}>
        {yes}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
        Keep
      </Button>
    </div>
  );

  return (
    <li className="px-4 py-2.5">
      <div className="flex min-h-[40px] items-center gap-3">
        <Avatar member={m} size={40} />
        <div className="min-w-0 flex-1">
          <p className={cx(tone.body, "truncate text-[15px] font-medium")}>
            {memberName(m.email)}
            {isMe && <span className={cx(tone.muted, "ml-1.5 font-normal")}>(you)</span>}
          </p>
          <p className={cx(tone.muted, "text-[13px] leading-snug break-words")}>{sub}</p>
        </div>
        {isMe && !editing && (
          <Button variant="ghost" size="sm" className="-mr-3" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {owner && !isMe && (m.role !== "owner" || isAdminLogin) && (
          <Button variant="ghost" size="sm" className="-mr-3" onClick={() => setManaging((v) => !v)} aria-label={`Manage ${memberName(m.email)}`}>
            {managing ? "Done" : "Manage"}
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-4 pb-1.5">
          <Field label="Your name">
            <input className={tone.input} value={name} maxLength={40} placeholder="What should the log call you?" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div>
            <span className={cx(tone.label, "mb-1.5 block")}>Shown as</span>
            <EmojiPicker value={emoji} onChange={setEmoji} initial={(name.trim() || memberName(m.email))[0]?.toUpperCase() ?? "?"} color={memberColor(m, state?.members ?? [])} />
          </div>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={async () => {
                if (await patch({ display_name: name.trim() || null, emoji }, "Saved")) setEditing(false);
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setName(m.display_name ?? "");
                setEmoji(m.emoji ?? "");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {managing && isAdminLogin && (
        <div className="mt-3 space-y-3 pb-1.5">
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>
            This is the site&apos;s admin password. Turning it off here means it no longer opens Maple&apos;s Log (or connects
            Claude/ChatGPT to it). Other sign-in methods keep working for everyone else.
          </p>
          {!confirmRemove ? (
            <Button variant="danger" size="sm" className="w-full" onClick={() => setConfirmRemove(true)}>
              Turn off admin login
            </Button>
          ) : (
            confirmRow("Turn off the admin login for Maple?", "Turn off")
          )}
        </div>
      )}

      {managing && !isAdminLogin && (
        <div className="mt-3 space-y-3 pb-1.5">
          <SharingRolePicker
            value={m.role === "owner" ? "member" : m.role}
            disabled={busy}
            onChange={(role) => void patch({ email: m.email, role }, `Access updated: ${SHARING_ROLES[role].label.toLowerCase()}`)}
          />
          {!confirmRemove ? (
            <Button variant="danger" size="sm" className="w-full" onClick={() => setConfirmRemove(true)}>
              Remove from Maple&apos;s Log
            </Button>
          ) : (
            confirmRow(`Remove ${memberName(m.email)}?`, "Remove")
          )}
        </div>
      )}
    </li>
  );
}

function InviteByEmail({ onInvited }: { onInvited: () => void }) {
  const { api, refresh, toast } = useMaple();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteRole>("photos");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  useSettingsDraft("invite-email", !!email.trim());

  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = await api<{ url?: string; emailed?: boolean }>("/api/maple/members", { method: "POST", body: JSON.stringify({ email: email.trim(), role }) });
      await refresh();
      // Outside the Brookers' log an address only gets an invite: they join by its link, signed in as that address.
      if (r.url) {
        setPending({ email: email.trim(), url: r.url, emailed: r.emailed === true });
        onInvited();
      } else toast(`Added ${email.trim()}. They can sign in with that email address at ${MAPLE_HOST}/maple`, { duration: 6000 });
      setEmail("");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add them", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      className="space-y-2.5 px-4 pt-3 pb-3.5"
    >
      <span className={cx(tone.label, "block")}>Invite by email</span>
      <input
        className={tone.input}
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        placeholder="name@example.com"
        aria-label="Their email address"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <SharingRolePicker value={role} onChange={setRole} disabled={busy} />
      <Button type="submit" className="w-full" disabled={!valid || busy}>
        {busy ? "Inviting…" : "Invite by email"}
      </Button>
      {pending?.emailed && (
        <div className="space-y-2 pt-1" aria-live="polite">
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>
            Invite emailed to {pending.email}. They join once they open its link and sign in with that email address. It works once, for 7 days.
          </p>
          <CopyButton text={pending.url} label="Copy link" className="min-h-[44px] w-full text-[15px]" />
        </div>
      )}
      {pending && !pending.emailed && (
        <div className="space-y-2 pt-1" aria-live="polite">
          <p className={cx(tone.muted, "text-[13px] leading-snug")}>
            Send {pending.email} this link. They join once they open it and sign in with that email address. It works once, for 7 days.
          </p>
          <div className={cx(tone.inset, "p-3")}>
            <p className="font-mono text-[13px] leading-relaxed break-all text-mp-ink select-all">{pending.url}</p>
          </div>
          <CopyButton text={pending.url} label="Copy link" className="min-h-[44px] w-full text-[15px]" />
        </div>
      )}
    </form>
  );
}

function InviteLinkSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { state, api, toast } = useMaple();
  const w = useBabyWords();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [role, setRole] = useState<InviteRole>("photos");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; name: string; role: InviteRole } | null>(null);
  const url = created?.url;
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  // Start fresh each time it opens; the link itself is only ever shown once.
  useEffect(() => {
    if (open) {
      setName("");
      setEmoji("");
      setRole("photos");
      setCreated(null);
    }
  }, [open]);

  const create = async () => {
    if (!name.trim() || busy) return;
    const submitted = { name: name.trim(), role };
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/maple/invites", {
        method: "POST",
        body: JSON.stringify({ display_name: submitted.name, emoji, role: submitted.role }),
      });
      setCreated({ ...submitted, url: r.url });
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't make a link", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!created) return;
    try {
      await navigator.share({
        title: `${w.name}'s moments`,
        text: `${created.name}, join ${w.name}'s family in Maple with ${SHARING_ROLES[created.role].label.toLowerCase()} access. This link works once, for 7 days.`,
        url: created.url,
      });
    } catch {
      // cancelled
    }
  };

  return (
    <Sheet
      open={open}
      locked={busy}
      dirty={!url && (!!name.trim() || !!emoji || role !== "photos")}
      onClose={onClose}
      title={url ? "Link ready" : "Invite with a link"}
      footer={
        url ? (
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button size="lg" className="w-full" disabled={!name.trim() || busy} onClick={() => void create()}>
            {busy ? "Making the link…" : "Create invite link"}
          </Button>
        )
      }
    >
      {!created ? (
        <fieldset disabled={busy} className="min-w-0 space-y-4">
          <Field label="Their name">
            <input className={tone.input} value={name} maxLength={40} placeholder="Grandma Sue" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div>
            <span className={cx(tone.label, "mb-1.5 block")}>Shown as</span>
            {/* They'll join at the end of the family list, so that's the color their initial gets; the letter fills in as their name is typed. */}
            <EmojiPicker
              value={emoji}
              onChange={setEmoji}
              initial={name.trim()[0]?.toUpperCase() ?? ""}
              color={MEMBER_PALETTE[(state?.members.length ?? 0) % MEMBER_PALETTE.length]}
            />
          </div>
          <SharingRolePicker value={role} onChange={setRole} disabled={busy} />
        </fieldset>
      ) : (
        <>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Send this to {created.name}. It works <strong className="font-semibold">once</strong>, for <strong className="font-semibold">7 days</strong>, and signs them in on whichever phone
            opens it. You won&apos;t see this link again.
          </p>
          <div className="space-y-1">
            <p className={cx(tone.body, "text-[15px] font-semibold")}>{SHARING_ROLES[created.role].label}</p>
            <p className={cx(tone.muted, "text-[13px] leading-snug")}>
              {SHARING_ROLES[created.role].description}
            </p>
          </div>
          <div className={cx(tone.inset, "p-3")}>
            <p className="font-mono text-[13px] leading-relaxed break-all text-mp-ink select-all">{url}</p>
          </div>
          <div className="flex gap-2">
            <CopyButton text={created.url} label="Copy link" className="min-h-[48px] flex-1 text-[15px]" />
            {canShare && (
              <Button className="min-h-[48px] flex-1" onClick={() => void share()}>
                <Icon name="share" size={18} />
                Share…
              </Button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

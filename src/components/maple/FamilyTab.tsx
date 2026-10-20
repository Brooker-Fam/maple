"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { DISCLAIMER } from "@/lib/maple/guidelines";
import { dayKey, formatDayLabel, formatRelative, formatTime } from "@/lib/maple/time";
import { formatLength, formatWeight } from "@/lib/maple/units";
import type { Entry, EntryOf, Member, Role } from "@/lib/maple/types";
import BirthSheet from "./BirthSheet";
import { useNightPref, type NightPref } from "./nightLook";
import { Avatar, Button, Card, Field, Segmented, SectionTitle, Sheet, TextArea, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Family: who's in the log (and inviting more), Maple's details and her
 * doctor, questions for the next checkup, this phone's preferences,
 * connecting Claude/ChatGPT and Siri, and the CSV export. Viewers get a
 * read-only version.
 */

type Invite = {
  id: number;
  role: Role;
  display_name: string | null;
  emoji: string | null;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
};

type PersonalToken = { id: number; label: string | null; created_at: string; last_used_at: string | null };

type Question = EntryOf<"note">;

const EMOJIS = ["🌲", "🌸", "🦊", "🍄", "🦉", "🐻", "🐿️", "🦔", "🌻", "🐝", "🦌", "🐞", "🌼", "🌙", "⭐", "🐸", "🪺", "🍂", "🌰", "🍁"];

const ROLE_LINE: Record<Role, string> = {
  owner: "Owner · can invite and manage",
  member: "Can log",
  viewer: "View only",
};

const MCP_URL = "https://brooker.family/api/maple/mcp";

// ── Small pieces ─────────────────────────────────────────────────────────

function Section({ title, sub, children, action }: { title: string; sub?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section>
      <SectionTitle action={action}>{title}</SectionTitle>
      {sub && <p className={cx(tone.muted, "-mt-1 mb-2 px-1 text-sm")}>{sub}</p>}
      {children}
    </section>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older iOS / insecure context: fall back to a hidden textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  return (
    <Button
      variant="soft"
      size="sm"
      className={cx("shrink-0", className)}
      onClick={async () => {
        setState((await copy(text)) ? "done" : "fail");
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "done" ? "Copied ✓" : state === "fail" ? "Press and hold to copy" : label}
    </Button>
  );
}

function Code({ children }: { children: ReactNode }) {
  // Short tokens (`speak`, `pee`) stay whole; long URLs and keys may break anywhere.
  const long = typeof children === "string" ? children.length > 24 : true;
  return (
    <code
      className={cx(
        "rounded-md bg-[#1D4420]/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-[#1D4420] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]",
        long ? "break-all" : "whitespace-nowrap"
      )}
    >
      {children}
    </code>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="flex min-h-[56px] items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className={cx(tone.body, "text-[15px] font-semibold")}>{label}</p>
        {hint && <p className={cx(tone.muted, "text-xs leading-snug")}>{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative h-8 w-14 shrink-0 rounded-full transition disabled:opacity-40",
          checked ? "bg-[#1D4420] dark:bg-[#C49A3C]" : "bg-[#1D4420]/15 dark:bg-[#F5EDDF]/20"
        )}
      >
        <span
          className={cx(
            "absolute top-1 left-1 h-6 w-6 rounded-full bg-white shadow transition-transform dark:bg-[#FDF8F0]",
            checked && "translate-x-6"
          )}
        />
      </button>
    </div>
  );
}

function EmojiPicker({ value, onChange }: { value: string; onChange: (e: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Emoji">
      {EMOJIS.map((e) => (
        <button
          key={e}
          type="button"
          role="radio"
          aria-checked={value === e}
          aria-label={e}
          onClick={() => onChange(e)}
          className={cx(
            "flex h-11 w-11 items-center justify-center rounded-full text-xl transition active:scale-95",
            value === e ? "bg-[#C49A3C]/25 ring-2 ring-[#C49A3C]" : "bg-[#1D4420]/[0.05] dark:bg-[#F5EDDF]/[0.07]"
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

function isQuestion(e: Entry): e is Question {
  return e.kind === "note" && !!e.data.for_doctor;
}

// ── The tab ──────────────────────────────────────────────────────────────

export default function FamilyTab() {
  const { state, readOnly } = useMaple();
  if (!state) return null;
  return (
    <div className="space-y-8 px-4 pt-[calc(env(safe-area-inset-top)+20px)] pb-8">
      <header className="px-1">
        <h1 className={cx(tone.heading, "text-[34px] leading-tight")}>Family</h1>
        <p className={cx(tone.muted, "mt-0.5 text-[15px]")}>Everyone helping Maple grow, and how the log works for you.</p>
      </header>
      <People />
      <BabyDetails />
      <DoctorQuestions />
      <Preferences />
      {!readOnly && <ConnectAI />}
      {!readOnly && <HandsFree />}
      <DataAndAccount />
      <p className={cx(tone.muted, "px-2 text-center text-xs leading-relaxed")}>{DISCLAIMER}</p>
    </div>
  );
}

// ── People ───────────────────────────────────────────────────────────────

function People() {
  const { state, api, toast, now } = useMaple();
  const me = state!.me;
  const owner = me.role === "owner";
  const members = state!.members;
  const [invites, setInvites] = useState<Invite[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);

  const loadInvites = useCallback(async () => {
    if (!owner) return;
    try {
      const r = await api<{ invites: Invite[] }>("/api/maple/invites");
      setInvites(r.invites);
    } catch {
      // the list just stays as it was
    }
  }, [api, owner]);

  useEffect(() => {
    void loadInvites();
  }, [loadInvites, members.length]);

  const revoke = async (inv: Invite) => {
    try {
      const r = await api<{ invites: Invite[] }>(`/api/maple/invites?id=${inv.id}`, { method: "DELETE" });
      setInvites(r.invites);
      toast(`Invite for ${inv.display_name ?? "them"} revoked`, { emoji: "🍂" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke that", { tone: "error" });
    }
  };

  const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - now().getTime()) / 864e5));

  return (
    <Section title="Maple's people">
      <Card className="p-0">
        <ul className="divide-y divide-[#1D4420]/[0.07] dark:divide-[#F5EDDF]/[0.08]">
          {members.map((m) => (
            <MemberRow key={m.email} m={m} me={me} owner={owner} />
          ))}
        </ul>

        {members.length === 1 && (
          <p className={cx(tone.muted, "border-t border-[#1D4420]/[0.07] px-4 py-4 text-center text-[15px] leading-relaxed dark:border-[#F5EDDF]/[0.08]")}>
            It&apos;s just you so far. Invite Brittany, grandparents, or anyone helping out.
          </p>
        )}

        {owner && invites.length > 0 && (
          <div className="border-t border-[#1D4420]/[0.07] px-4 py-3 dark:border-[#F5EDDF]/[0.08]">
            <p className={cx(tone.label, "mb-1")}>Invite links waiting</p>
            <ul>
              {invites.map((inv) => {
                const d = daysLeft(inv.expires_at);
                return (
                  <li key={inv.id} className="flex min-h-[52px] items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#C49A3C]/15 text-lg" aria-hidden>
                      {inv.emoji ?? "🔗"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cx(tone.body, "truncate text-[15px] font-semibold")}>{inv.display_name ?? "Someone"}</p>
                      <p className={cx(tone.muted, "text-xs")}>
                        {inv.role === "viewer" ? "View only" : "Can log"} · link expires {d <= 1 ? "within a day" : `in ${d} days`}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => void revoke(inv)}>
                      Revoke
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {owner && (
          <div className="space-y-4 border-t border-[#1D4420]/[0.07] px-4 py-4 dark:border-[#F5EDDF]/[0.08]">
            <InviteByEmail />
            <div>
              <Button variant="soft" className="w-full" onClick={() => setLinkOpen(true)}>
                🔗 Invite someone without Google
              </Button>
              <p className={cx(tone.muted, "mt-1.5 px-2 text-center text-xs leading-snug")}>
                A one-time link for grandparents or a helper. No account needed.
              </p>
            </div>
          </div>
        )}
      </Card>
      {owner && <InviteLinkSheet open={linkOpen} onClose={() => setLinkOpen(false)} onCreated={() => void loadInvites()} />}
    </Section>
  );
}

function MemberRow({ m, me, owner }: { m: Member; me: Member; owner: boolean }) {
  const { api, refresh, toast, memberName } = useMaple();
  const isMe = m.email === me.email;
  // The site admin password signs in as the "admin" owner; a real owner can switch it off.
  const isAdminLogin = m.email === "admin";
  const [editing, setEditing] = useState(false);
  const [managing, setManaging] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [name, setName] = useState(m.display_name ?? "");
  const [emoji, setEmoji] = useState(m.emoji ?? "🍁");
  const [busy, setBusy] = useState(false);

  const who = m.email === "admin" ? "Site admin login" : m.email.startsWith("invite:") ? "Joined with an invite link" : m.email;
  const sub = owner && !isMe ? `${ROLE_LINE[m.role]} · ${who}` : ROLE_LINE[m.role];

  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api("/api/maple/members", { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
      toast(done, { emoji: "🍁" });
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
      toast(`${memberName(m.email)} removed`, { emoji: "🍂" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't remove them", { tone: "error" });
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <Avatar member={m} size={44} />
        <div className="min-w-0 flex-1">
          <p className={cx(tone.body, "truncate text-base font-semibold")}>
            {memberName(m.email)}
            {isMe && <span className={cx(tone.muted, "ml-1.5 text-sm font-normal")}>(you)</span>}
          </p>
          <p className={cx(tone.muted, "truncate text-xs")}>{sub}</p>
        </div>
        {isMe && !editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {owner && !isMe && (m.role !== "owner" || isAdminLogin) && (
          <Button variant="ghost" size="sm" onClick={() => setManaging((v) => !v)} aria-label={`Manage ${memberName(m.email)}`}>
            {managing ? "Done" : "Manage"}
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-3 space-y-3">
          <Field label="Your name">
            <input className={tone.input} value={name} maxLength={40} placeholder="What should the log call you?" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div>
            <span className={cx(tone.label, "mb-1.5 block")}>Your emoji</span>
            <EmojiPicker value={emoji} onChange={setEmoji} />
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
                setEmoji(m.emoji ?? "🍁");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {managing && isAdminLogin && (
        <div className="mt-3 space-y-2">
          <p className={cx(tone.muted, "text-xs")}>
            This is the site&apos;s admin password. Turning it off here means it no longer opens Maple&apos;s Log (or connects
            Claude/ChatGPT to it); the rest of brooker.family is unaffected. Google sign-in keeps working for everyone else.
          </p>
          {!confirmRemove ? (
            <Button variant="danger" size="sm" className="w-full" onClick={() => setConfirmRemove(true)}>
              Turn off admin login
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <p className={cx(tone.body, "flex-1 text-sm")}>Turn off the admin login for Maple?</p>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void removeMember()}>
                Turn off
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </div>
          )}
        </div>
      )}

      {managing && !isAdminLogin && (
        <div className="mt-3 space-y-3">
          <Segmented
            value={m.role === "viewer" ? "viewer" : "member"}
            onChange={(r) => void patch({ email: m.email, role: r }, r === "viewer" ? "Now view only" : "Can log now")}
            options={[
              { value: "member", label: "Can log" },
              { value: "viewer", label: "View only" },
            ]}
          />
          {!confirmRemove ? (
            <Button variant="danger" size="sm" className="w-full" onClick={() => setConfirmRemove(true)}>
              Remove from Maple&apos;s Log
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <p className={cx(tone.body, "flex-1 text-sm")}>Remove {memberName(m.email)}?</p>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => void removeMember()}>
                Remove
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                Keep
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function InviteByEmail() {
  const { api, refresh, toast } = useMaple();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api("/api/maple/members", { method: "POST", body: JSON.stringify({ email: email.trim(), role }) });
      await refresh();
      toast(`Added ${email.trim()}. They can sign in with Google at brooker.family/maple`, { emoji: "🍁", duration: 6000 });
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
      className="space-y-2"
    >
      <span className={cx(tone.label, "block")}>Invite with a Google account</span>
      <input
        className={tone.input}
        type="email"
        inputMode="email"
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        placeholder="brittany@gmail.com"
        aria-label="Their Google email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <div className="flex gap-2">
        <Segmented
          className="flex-1"
          value={role}
          onChange={setRole}
          options={[
            { value: "member", label: "Can log" },
            { value: "viewer", label: "View only" },
          ]}
        />
        <Button type="submit" disabled={!valid || busy}>
          Add
        </Button>
      </div>
    </form>
  );
}

function InviteLinkSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { api, toast } = useMaple();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🦉");
  const [role, setRole] = useState<"member" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  // Start fresh each time it opens; the link itself is only ever shown once.
  useEffect(() => {
    if (open) {
      setName("");
      setEmoji("🦉");
      setRole("viewer");
      setUrl(null);
    }
  }, [open]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/maple/invites", {
        method: "POST",
        body: JSON.stringify({ display_name: name.trim(), emoji, role }),
      });
      setUrl(r.url);
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't make a link", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const share = async () => {
    if (!url) return;
    try {
      await navigator.share({
        title: "Maple's Log",
        text: `${name.trim() ? `${name.trim()}, here's` : "Here's"} your way into Maple's Log 🍁 (the link works once, for 7 days)`,
        url,
      });
    } catch {
      // cancelled
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={url ? "Link ready" : "Invite without Google"}
      emoji="🔗"
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
      {!url ? (
        <>
          <Field label="Their name">
            <input className={tone.input} value={name} maxLength={40} placeholder="Grandma Sue" onChange={(e) => setName(e.target.value)} />
          </Field>
          <div>
            <span className={cx(tone.label, "mb-1.5 block")}>Their emoji</span>
            <EmojiPicker value={emoji} onChange={setEmoji} />
          </div>
          <div>
            <span className={cx(tone.label, "mb-1.5 block")}>What they can do</span>
            <Segmented
              value={role}
              onChange={setRole}
              options={[
                { value: "member", label: "Member · can log" },
                { value: "viewer", label: "Viewer · can see" },
              ]}
            />
            <p className={cx(tone.muted, "mt-1.5 text-xs leading-snug")}>
              {role === "viewer"
                ? "Viewers see Maple's day and her moments, but can't log or change anything."
                : "Members can log feeds, diapers and sleep, just like you."}
            </p>
          </div>
        </>
      ) : (
        <>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Send this to {name.trim() || "them"}. It works <strong>once</strong>, for <strong>7 days</strong>, and signs them in on whichever phone
            opens it. You won&apos;t see this link again.
          </p>
          <div className={cx(tone.inset, "p-3")}>
            <p className="font-mono text-[13px] leading-relaxed break-all text-[#1D4420] select-all dark:text-[#F5EDDF]">{url}</p>
          </div>
          <div className="flex gap-2">
            <CopyButton text={url} label="Copy link" className="min-h-[48px] flex-1 text-[15px]" />
            {canShare && (
              <Button variant="gold" className="min-h-[48px] flex-1" onClick={() => void share()}>
                Share…
              </Button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

// ── Baby ─────────────────────────────────────────────────────────────────

type Profile = { name: string; nickname: string; due: string };
type Doctor = { pedPhone: string; afterHours: string; gaWeeks: string; feedHours: string };

const numOrNull = (s: string) => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

function BabyDetails() {
  const { state, api, refresh, toast, readOnly, units, now } = useMaple();
  const baby = state!.baby;
  const tz = baby.timezone;
  const settings = baby.settings;
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

  const profileSrc: Profile = { name: baby.name, nickname: baby.nickname ?? "", due: baby.due_date ?? "" };
  const doctorSrc: Doctor = {
    pedPhone: str(settings.pediatrician_phone),
    afterHours: str(settings.after_hours_phone),
    gaWeeks: str(settings.gestational_age_weeks),
    feedHours: str(settings.feed_interval_hours),
  };
  const [pEdits, setPEdits] = useState<Partial<Profile>>({});
  const [dEdits, setDEdits] = useState<Partial<Doctor>>({});
  const [busy, setBusy] = useState<"profile" | "doctor" | null>(null);
  const [birthOpen, setBirthOpen] = useState(false);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});

  const p = { ...profileSrc, ...pEdits };
  const d = { ...doctorSrc, ...dEdits };
  const pDirty = (Object.keys(pEdits) as (keyof Profile)[]).some((k) => pEdits[k] !== profileSrc[k]);
  const dDirty = (Object.keys(dEdits) as (keyof Doctor)[]).some((k) => dEdits[k] !== doctorSrc[k]);

  const save = async (which: "profile" | "doctor") => {
    let body: Record<string, unknown>;
    if (which === "profile") {
      if (!p.name.trim()) return toast("She needs a name!", { tone: "error" });
      body = { name: p.name.trim(), nickname: p.nickname.trim() || null, due_date: p.due || null };
    } else {
      const ga = numOrNull(d.gaWeeks);
      const fh = numOrNull(d.feedHours);
      if (ga !== null && (Number.isNaN(ga) || ga < 22 || ga > 44)) return toast("Gestational age should be in weeks, like 39", { tone: "error" });
      if (fh !== null && (Number.isNaN(fh) || fh < 1 || fh > 8)) return toast("Feed interval should be in hours, like 3", { tone: "error" });
      body = {
        settings: {
          pediatrician_phone: d.pedPhone.trim().slice(0, 30) || null,
          after_hours_phone: d.afterHours.trim().slice(0, 30) || null,
          gestational_age_weeks: ga,
          feed_interval_hours: fh,
        },
      };
    }
    setBusy(which);
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
      if (which === "profile") setPEdits({});
      else setDEdits({});
      toast("Saved", { emoji: "🍁" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const setSetting = async (key: string, value: boolean) => {
    setToggles((t) => ({ ...t, [key]: value }));
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ settings: { [key]: value } }) });
      await refresh();
    } catch (e) {
      setToggles((t) => ({ ...t, [key]: !value }));
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
    }
  };
  const flag = (key: string) => toggles[key] ?? settings[key] !== false;

  const born = baby.born_at ? new Date(baby.born_at) : null;
  const bornDay = born ? formatDayLabel(dayKey(born, tz), dayKey(now(), tz), { long: true }) : "";
  const bornLine = born ? `Born ${/^(Today|Yesterday)$/.test(bornDay) ? bornDay.toLowerCase() : bornDay} at ${formatTime(born, tz)}` : null;
  const stats = [
    baby.birth_weight_g ? formatWeight(baby.birth_weight_g, units) : null,
    baby.birth_length_cm ? `${formatLength(baby.birth_length_cm, units)} long` : null,
    baby.birth_head_cm ? `head ${formatLength(baby.birth_head_cm, units)}` : null,
  ].filter(Boolean);

  const birthCard = (
    <div className={cx(tone.inset, "flex items-center gap-3 px-4 py-3")}>
      <span className="text-2xl" aria-hidden>
        {born ? "🍁" : "🌱"}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx(tone.body, "text-[15px] font-semibold")}>{bornLine ?? "Not born yet"}</p>
        <p className={cx(tone.muted, "text-xs")}>
          {born ? (stats.length ? stats.join(" · ") : "Weight and length not added yet") : baby.due_date ? `Due ${formatDayLabel(baby.due_date, dayKey(now(), tz), { long: true })}` : "Any day now"}
        </p>
      </div>
      {!readOnly && (
        <Button variant={born ? "ghost" : "gold"} size="sm" onClick={() => setBirthOpen(true)}>
          {born ? "Edit" : "She's here!"}
        </Button>
      )}
    </div>
  );

  if (readOnly) {
    const phone = doctorSrc.pedPhone;
    return (
      <Section title="Maple">
        <Card className="space-y-3">
          <p className={cx(tone.heading, "text-2xl")}>
            {baby.name}
            {baby.nickname && <span className={cx(tone.muted, "ml-2 font-[family-name:var(--font-body)] text-sm font-normal")}>“{baby.nickname}”</span>}
          </p>
          {birthCard}
          {phone && (
            <a href={telHref(phone)} className={cx(tone.body, "flex min-h-[44px] items-center gap-2 text-[15px] font-semibold underline decoration-[#C49A3C]/50 underline-offset-4")}>
              📞 Pediatrician · {phone}
            </a>
          )}
        </Card>
      </Section>
    );
  }

  return (
    <Section title="Maple" sub="Her details, and her doctor's numbers for the middle of the night.">
      <div className="space-y-3">
        <Card className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input className={tone.input} value={p.name} maxLength={80} onChange={(e) => setPEdits((x) => ({ ...x, name: e.target.value }))} />
            </Field>
            <Field label="Nickname">
              <input className={tone.input} value={p.nickname} maxLength={40} placeholder="Maple" onChange={(e) => setPEdits((x) => ({ ...x, nickname: e.target.value }))} />
            </Field>
          </div>
          <Field label="Due date">
            <input type="date" className={cx(tone.input, "min-h-[50px]")} value={p.due} onChange={(e) => setPEdits((x) => ({ ...x, due: e.target.value }))} />
          </Field>
          {birthCard}
          {pDirty && (
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy === "profile"} onClick={() => void save("profile")}>
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setPEdits({})}>
                Cancel
              </Button>
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <p className={cx(tone.heading, "text-lg")}>Her doctor</p>
          <PhoneField label="Pediatrician" value={d.pedPhone} saved={doctorSrc.pedPhone} onChange={(v) => setDEdits((x) => ({ ...x, pedPhone: v }))} />
          <PhoneField label="After-hours line" value={d.afterHours} saved={doctorSrc.afterHours} onChange={(v) => setDEdits((x) => ({ ...x, afterHours: v }))} />
          <Field label="Weeks at birth" hint="Born before 37 weeks or under 5½ lb? Maple's reminders step back and defer to your pediatrician's plan.">
            <input
              className={tone.input}
              inputMode="numeric"
              placeholder="e.g. 39"
              value={d.gaWeeks}
              onChange={(e) => setDEdits((x) => ({ ...x, gaWeeks: e.target.value.replace(/[^\d.]/g, "") }))}
            />
          </Field>
          <Field label="Feed every … hours (optional)" hint="Only if her pediatrician gave you a number. It replaces the built-in feeding reminders.">
            <input
              className={tone.input}
              inputMode="decimal"
              placeholder="e.g. 3"
              value={d.feedHours}
              onChange={(e) => setDEdits((x) => ({ ...x, feedHours: e.target.value.replace(/[^\d.]/g, "") }))}
            />
          </Field>
          {dDirty && (
            <div className="flex gap-2">
              <Button className="flex-1" disabled={busy === "doctor"} onClick={() => void save("doctor")}>
                Save changes
              </Button>
              <Button variant="ghost" onClick={() => setDEdits({})}>
                Cancel
              </Button>
            </div>
          )}
        </Card>

        <Card className="divide-y divide-[#1D4420]/[0.07] py-1 dark:divide-[#F5EDDF]/[0.08]">
          <Toggle
            label="Vitamin D reminder"
            hint="A gentle evening nudge if no sunshine drops are logged that day."
            checked={flag("vitamin_d_reminder")}
            onChange={(v) => void setSetting("vitamin_d_reminder", v)}
          />
          <Toggle
            label="Show diaper brigade"
            hint="This week's diaper changes as a team tally. Just for fun, never a contest."
            checked={flag("show_brigade")}
            onChange={(v) => void setSetting("show_brigade", v)}
          />
        </Card>
      </div>
      <BirthSheet open={birthOpen} onClose={() => setBirthOpen(false)} mode={born ? "edit" : "birth"} />
    </Section>
  );
}

function PhoneField({ label, value, saved, onChange }: { label: string; value: string; saved: string; onChange: (v: string) => void }) {
  return (
    <div>
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <div className="flex items-center gap-2">
        <input
          className={tone.input}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="(518) 555-0123"
          aria-label={`${label} phone`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {saved && (
          <a
            href={telHref(saved)}
            aria-label={`Call ${label}`}
            className="flex min-h-[50px] shrink-0 items-center rounded-full bg-[#1D4420] px-4 text-sm font-semibold text-[#FDF8F0] dark:bg-[#C49A3C] dark:text-[#14210F]"
          >
            📞 Call
          </a>
        )}
      </div>
    </div>
  );
}

// ── Questions for the doctor ─────────────────────────────────────────────

function DoctorQuestions() {
  const { state, api, log, update, remove, readOnly, memberName, now } = useMaple();
  const tz = state!.baby.timezone;
  const rev = state!.rev;
  const [fetched, setFetched] = useState<Question[]>([]);
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);

  // Questions can be weeks old, older than the app's 72-hour window, so load
  // them all; reload whenever the log changes.
  useEffect(() => {
    let live = true;
    api<{ entries: Entry[] }>("/api/maple/entries?kind=note&limit=500")
      .then((r) => live && setFetched(r.entries.filter(isQuestion)))
      .catch(() => {
        // keep what we have
      });
    return () => {
      live = false;
    };
  }, [api, rev]);

  // Fresh local saves (incl. not-yet-synced ones) win over the last fetch.
  const all = useMemo(() => {
    const byId = new Map<number, Question>();
    for (const q of fetched) byId.set(q.id, q);
    for (const e of state!.entries) if (isQuestion(e)) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  }, [fetched, state]);
  const open = all.filter((q) => !q.data.done);
  const done = all.filter((q) => q.data.done);

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    await log({ kind: "note", data: { for_doctor: true }, note: t }, { toast: "Added to the list for the doctor", emoji: "🩺" });
  };

  const patchLocal = (saved: Entry | null) => {
    if (saved && isQuestion(saved)) setFetched((list) => list.map((q) => (q.id === saved.id ? saved : q)));
  };

  return (
    <Section
      title="Questions for the doctor"
      sub={readOnly ? "What the family plans to ask at her next checkup." : "Jot them down as they come up; tick them off at her checkup."}
    >
      <Card className="space-y-3">
        {!readOnly && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="flex gap-2"
          >
            <input
              className={tone.input}
              value={text}
              maxLength={300}
              placeholder="Is her cheek rash okay?"
              aria-label="New question for the doctor"
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" disabled={!text.trim()}>
              Add
            </Button>
          </form>
        )}

        {open.length === 0 ? (
          <p className={cx(tone.muted, "py-2 text-center text-sm leading-relaxed")}>
            {done.length ? "All asked. Nice work." : "No questions yet."}
          </p>
        ) : (
          <ul className="space-y-1">
            {open.map((q) => (
              <QuestionRow
                key={q.id}
                q={q}
                readOnly={readOnly}
                by={`${memberName(q.created_by)} · ${formatDayLabel(dayKey(new Date(q.started_at), tz), dayKey(now(), tz))}`}
                onDone={async (answer) =>
                  patchLocal(await update(q.id, { data: { done: true, ...(answer ? { answer } : {}) } }, { toast: "Ticked off" }))
                }
                onRemove={() => void remove(q.id)}
              />
            ))}
          </ul>
        )}

        {done.length > 0 && (
          <div className="border-t border-[#1D4420]/[0.07] pt-2 dark:border-[#F5EDDF]/[0.08]">
            <button type="button" onClick={() => setShowDone((v) => !v)} className={cx(tone.muted, "min-h-[44px] w-full text-left text-sm font-semibold")} aria-expanded={showDone}>
              {showDone ? "▾" : "▸"} Asked ({done.length})
            </button>
            {showDone && (
              <ul className="space-y-2 pb-1">
                {done.map((q) => (
                  <li key={q.id} className="flex items-start gap-3">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={async () => patchLocal(await update(q.id, { data: { done: false } }, { toast: "Back on the list" }))}
                      aria-label="Put back on the list"
                      className="flex h-11 w-11 shrink-0 items-center justify-center"
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#5C7A4A] text-xs text-white dark:bg-[#A9C08F] dark:text-[#14210F]">✓</span>
                    </button>
                    <div className="min-w-0 flex-1 py-2.5">
                      <p className={cx(tone.muted, "text-[15px] leading-snug line-through decoration-[#5C7A4A]/40")}>{q.note}</p>
                      {q.data.answer && <p className={cx(tone.body, "mt-1 text-sm leading-snug")}>🩺 {q.data.answer}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
    </Section>
  );
}

function QuestionRow({
  q,
  by,
  readOnly,
  onDone,
  onRemove,
}: {
  q: Question;
  by: string;
  readOnly: boolean;
  onDone: (answer: string) => Promise<void>;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState("");
  return (
    <li>
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen((v) => !v)}
          aria-label="Tick off"
          aria-expanded={open}
          className="flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <span className={cx("h-6 w-6 rounded-full border-2 transition", open ? "border-[#5C7A4A] bg-[#5C7A4A]/15" : "border-[#1D4420]/30 dark:border-[#F5EDDF]/35")} />
        </button>
        <div className="min-w-0 flex-1 py-2.5">
          <p className={cx(tone.body, "text-[15px] leading-snug")}>{q.note || "(no text)"}</p>
          <p className={cx(tone.muted, "mt-0.5 text-xs")}>{by}</p>
        </div>
      </div>
      {open && (
        <div className="mb-2 ml-14 space-y-2">
          <TextArea value={answer} onChange={setAnswer} placeholder="What did the doctor say? (optional)" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void onDone(answer.trim())}>
              Asked ✓
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Not yet
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onRemove}>
              Delete
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Preferences ──────────────────────────────────────────────────────────

function Preferences() {
  const { units, setUnits } = useMaple();
  const [night, setNight] = useNightPref();
  const { theme, setTheme } = useTheme();
  const [standalone, setStandalone] = useState(true);
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true);
  }, []);

  return (
    <Section title="On this phone">
      <Card className="space-y-5">
        <div>
          <span className={cx(tone.label, "mb-1.5 block")}>Units</span>
          <Segmented
            value={units}
            onChange={setUnits}
            options={[
              { value: "us", label: "lb · oz · °F" },
              { value: "metric", label: "kg · ml · °C" },
            ]}
          />
        </div>
        <div>
          <span className={cx(tone.label, "mb-1.5 block")}>Night look</span>
          <Segmented<NightPref>
            value={night}
            onChange={setNight}
            options={[
              { value: "auto", label: "Auto" },
              { value: "always", label: "Always" },
              { value: "off", label: "Off" },
            ]}
          />
          <p className={cx(tone.muted, "mt-1.5 text-xs leading-snug")}>
            {night === "auto"
              ? "Dim amber from 8pm to 7am, easy on sleepy eyes."
              : night === "always"
                ? "Dim amber all the time."
                : "Follows the light or dark theme below."}
          </p>
        </div>
        <div>
          <span className={cx(tone.label, "mb-1.5 block")}>Theme</span>
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "system", label: "Auto" },
              { value: "dark", label: "Dark" },
            ]}
          />
          <p className={cx(tone.muted, "mt-1.5 text-xs leading-snug")}>Same setting as the rest of brooker.family.</p>
        </div>
        {!standalone && (
          <div className={cx(tone.inset, "flex gap-3 px-4 py-3")}>
            <span className="text-2xl" aria-hidden>
              📲
            </span>
            <p className={cx(tone.body, "text-sm leading-relaxed")}>
              <strong>Add Maple&apos;s Log to your Home Screen</strong> for one-tap logging. On iPhone, open this page in Safari, tap{" "}
              <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}

// ── Claude / ChatGPT ─────────────────────────────────────────────────────

function ConnectAI() {
  return (
    <Section title="Talk to Maple's Log">
      <Card className="space-y-4">
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Connect Claude or ChatGPT and just say what happened. It lands here with your name on it, and you can ask questions too.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {["“Log a wet diaper.”", "“Start a feed on the right.”", "“Which side next?”", "“How did last night go?”", "“Add a question for the doctor.”"].map((s) => (
            <li key={s} className="rounded-full bg-[#B8A9C9]/20 px-3 py-1.5 text-sm text-[#4A1A2A] dark:bg-[#B8A9C9]/15 dark:text-[#E2D8EC]">
              {s}
            </li>
          ))}
        </ul>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className={cx(tone.body, "font-semibold")}>Claude (web, desktop, phone)</dt>
            <dd className={tone.muted}>Settings → Connectors → Add custom connector, then sign in with Google.</dd>
          </div>
          <div>
            <dt className={cx(tone.body, "font-semibold")}>ChatGPT</dt>
            <dd className={tone.muted}>Settings → Connectors, with developer mode on.</dd>
          </div>
          <div>
            <dt className={cx(tone.body, "font-semibold")}>Claude Code</dt>
            <dd className={cx(tone.muted, "mt-1 flex items-start gap-2")}>
              <Code>claude mcp add --transport http maple {MCP_URL}</Code>
              <CopyButton text={`claude mcp add --transport http maple ${MCP_URL}`} />
            </dd>
          </div>
        </dl>
        <Link
          href="/maple/connect"
          className="flex min-h-[48px] items-center justify-center rounded-full bg-[#1D4420] px-5 text-[15px] font-semibold text-[#FDF8F0] transition active:scale-[0.98] dark:bg-[#C49A3C] dark:text-[#14210F]"
        >
          Step-by-step setup →
        </Link>
      </Card>
    </Section>
  );
}

// ── Siri / iOS Shortcuts ─────────────────────────────────────────────────

const SHORTCUTS: [string, string][] = [
  ["Maple pee", "pee"],
  ["Maple poop", "poop"],
  ["Maple both", "both"],
  ["Maple left", "nurse_left"],
  ["Maple right", "nurse_right"],
  ["Maple switch", "switch"],
  ["Maple stop", "stop"],
  ["Maple sleep", "sleep"],
  ["Maple awake", "wake"],
  ["Maple status", "status"],
];

function HandsFree() {
  const { api, toast, now } = useMaple();
  const [tokens, setTokens] = useState<PersonalToken[] | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [howTo, setHowTo] = useState(false);
  const [origin, setOrigin] = useState("https://brooker.family");

  useEffect(() => {
    setOrigin(window.location.origin);
    api<{ tokens: PersonalToken[] }>("/api/maple/tokens")
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]));
  }, [api]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api<{ token: string; record: PersonalToken }>("/api/maple/tokens", {
        method: "POST",
        body: JSON.stringify({ label: label.trim() || "iPhone Shortcuts" }),
      });
      setFresh(r.token);
      setTokens((t) => [r.record, ...(t ?? [])]);
      setLabel("");
      setHowTo(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't make a key", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (t: PersonalToken) => {
    try {
      const r = await api<{ tokens: PersonalToken[] }>(`/api/maple/tokens?id=${t.id}`, { method: "DELETE" });
      setTokens(r.tokens);
      toast("Key revoked. Shortcuts using it stop working.", { emoji: "🍂" });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke", { tone: "error" });
    }
  };

  const url = `${origin}/api/maple/quick`;
  const header = `Bearer ${fresh ?? "<your key>"}`;

  return (
    <Section title="Hands-free with Siri">
      <Card className="space-y-4">
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Say <strong>“Hey Siri, Maple pee”</strong> and it&apos;s logged, no unlocking or tapping. Works with the Action Button and Back Tap too. Each
          grown-up makes their own key, so entries carry their name.
        </p>

        {fresh ? (
          <div className="space-y-2 rounded-2xl border border-[#C49A3C]/40 bg-[#C49A3C]/10 p-3 dark:border-[#C49A3C]/30">
            <p className={cx(tone.label)}>Your new key · shown once</p>
            <p className="font-mono text-[13px] break-all text-[#1D4420] select-all dark:text-[#F5EDDF]">{fresh}</p>
            <div className="flex items-center gap-2">
              <CopyButton text={fresh} label="Copy key" />
              <p className={cx(tone.muted, "text-xs leading-snug")}>Keep it private: anyone with it can log as you.</p>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              className={tone.input}
              value={label}
              maxLength={40}
              placeholder="Matt's iPhone"
              aria-label="Key name"
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button disabled={busy} onClick={() => void create()} className="shrink-0">
              Make a key
            </Button>
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setHowTo((v) => !v)}
            aria-expanded={howTo}
            className={cx(tone.body, "flex min-h-[44px] w-full items-center justify-between text-left text-[15px] font-semibold")}
          >
            Set up the shortcut
            <span aria-hidden className={tone.muted}>
              {howTo ? "▾" : "▸"}
            </span>
          </button>
          {howTo && (
            <ol className={cx(tone.body, "mt-1 list-decimal space-y-3 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-[#C49A3C]")}>
              <li>
                Open the <strong>Shortcuts</strong> app, tap <strong>＋</strong>, and name the shortcut <strong>Maple pee</strong>.
              </li>
              <li>
                Add the action <strong>Get Contents of URL</strong> and set the URL to
                <span className="mt-1.5 flex items-center gap-2">
                  <Code>{url}</Code>
                  <CopyButton text={url} />
                </span>
              </li>
              <li>
                Tap <strong>›</strong> to show more. Set <strong>Method</strong> to <strong>POST</strong>.
              </li>
              <li>
                Under <strong>Headers</strong>, add <Code>Authorization</Code> with the value
                <span className="mt-1.5 flex items-center gap-2">
                  <Code>{header}</Code>
                  {fresh && <CopyButton text={header} />}
                </span>
                {!fresh && <span className={cx(tone.muted, "mt-1 block text-xs")}>Make a key above to fill this in.</span>}
              </li>
              <li>
                Set <strong>Request Body</strong> to <strong>JSON</strong> and add a Text field: key <Code>action</Code>, value <Code>pee</Code>.
              </li>
              <li>
                Add <strong>Get Dictionary Value</strong>: get the value for <Code>speak</Code> in <strong>Contents of URL</strong>.
              </li>
              <li>
                Add <strong>Speak Text</strong> with that <strong>Dictionary Value</strong>, so Siri tells you what was logged.
              </li>
              <li>
                Try it: <strong>“Hey Siri, Maple pee.”</strong> For one-press logging, choose the shortcut under Settings → Action Button, or Settings →
                Accessibility → Touch → Back Tap.
              </li>
              <li>
                Duplicate it for the rest, changing the name and the <Code>action</Code>:
                <table className="mt-2 w-full text-left text-[13px]">
                  <tbody>
                    {SHORTCUTS.map(([name, action]) => (
                      <tr key={action} className="border-b border-[#1D4420]/[0.06] last:border-0 dark:border-[#F5EDDF]/[0.06]">
                        <td className="py-1.5 pr-2 font-semibold">{name}</td>
                        <td className="py-1.5">
                          <Code>{action}</Code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <span className={cx(tone.muted, "mt-2 block text-xs leading-snug")}>
                  Also: <Code>vitamin_d</Code>, and <Code>bottle</Code> (add a Number field <Code>amount_oz</Code>). “Maple status” reads back when she last
                  ate and which side is next.
                </span>
              </li>
            </ol>
          )}
        </div>

        {tokens && tokens.length > 0 && (
          <div className="border-t border-[#1D4420]/[0.07] pt-3 dark:border-[#F5EDDF]/[0.08]">
            <p className={cx(tone.label, "mb-1")}>Your keys</p>
            <ul>
              {tokens.map((t) => (
                <li key={t.id} className="flex min-h-[52px] items-center gap-3">
                  <span className="text-lg" aria-hidden>
                    🗝️
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cx(tone.body, "truncate text-[15px] font-semibold")}>{t.label || "iPhone Shortcuts"}</p>
                    <p className={cx(tone.muted, "text-xs")}>{t.last_used_at ? `Last used ${formatRelative(t.last_used_at, now())}` : "Not used yet"}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => void revoke(t)}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
            {fresh && (
              <Button variant="ghost" size="sm" className="mt-1" onClick={() => setFresh(null)}>
                ＋ Make another key
              </Button>
            )}
          </div>
        )}
      </Card>
    </Section>
  );
}

// ── Data and account ─────────────────────────────────────────────────────

function DataAndAccount() {
  const { api, refresh, state, memberName } = useMaple();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await api("/api/maple/auth/signout", { method: "POST" });
    } catch {
      // the next poll will tell
    }
    await refresh();
    setBusy(false);
  };
  return (
    <Section title="Data">
      <Card className="space-y-3">
        <a
          href="/api/maple/export"
          download
          className="flex min-h-[48px] items-center justify-center gap-2 rounded-full bg-[#1D4420]/[0.07] px-5 text-[15px] font-semibold text-[#1D4420] dark:bg-[#F5EDDF]/10 dark:text-[#F5EDDF]"
        >
          ⬇️ Download everything (CSV)
        </a>
        <p className={cx(tone.muted, "text-center text-xs")}>Every entry, for a spreadsheet or her pediatrician.</p>
        <div className="flex items-center justify-between border-t border-[#1D4420]/[0.07] pt-3 dark:border-[#F5EDDF]/[0.08]">
          <p className={cx(tone.muted, "min-w-0 truncate text-sm")}>Signed in as {memberName(state!.me.email)}</p>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Card>
    </Section>
  );
}

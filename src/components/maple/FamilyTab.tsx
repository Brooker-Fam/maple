"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useTheme } from "@/components/ThemeProvider";
import { DISCLAIMER } from "@/lib/maple/guidelines";
import { adminActsAs, alertsOn } from "@/lib/maple/insights";
import { dayKey, formatDayLabel, formatRelative, formatTime } from "@/lib/maple/time";
import { formatLength, formatWeight } from "@/lib/maple/units";
import type { Entry, EntryOf, Member, Role } from "@/lib/maple/types";
import BirthSheet from "./BirthSheet";
import { Icon, type IconName } from "./icons";
import { useNightPref, type NightPref } from "./nightLook";
import { Avatar, Button, Field, MEMBER_PALETTE, Segmented, SectionTitle, Sheet, TextArea, cx, memberColor, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * Family: who's in the log (and inviting more), Maple's details and her
 * doctor, questions for the next checkup, this phone's preferences,
 * connecting Claude/ChatGPT and Siri, and the CSV export. Viewers get a
 * read-only version.
 *
 * Laid out like iOS Settings: one card per group, rows with the label on the
 * left and the control or value on the right, hairlines between rows, and
 * explanations as small notes rather than more boxes.
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

// Avatar choices after the initial (the default). Members pick their own mark, so these stay emoji.
const EMOJIS = ["🌲", "🌸", "🦊", "🍄", "🦉", "🐻", "🐿️", "🦔", "🌻", "🐝", "🦌", "🐞", "🌼", "🌙", "⭐", "🐸", "🪺", "🍂", "🌰", "🍁"];

const ROLE_LINE: Record<Role, string> = {
  owner: "Owner · can invite and manage",
  member: "Can log",
  viewer: "View only",
};

const MCP_URL = "https://brooker.family/api/maple/mcp";

const EXAMPLES = ["“Log a wet diaper.”", "“Start a feed on the right.”", "“Which side next?”", "“How did last night go?”", "“Add a question for the doctor.”"];

// ── Small pieces ─────────────────────────────────────────────────────────

/** A list card: rows separated by hairlines. */
const GROUP = cx(tone.card, tone.divide, "overflow-hidden");

/** A borderless input that sits on the right of a row (iOS-style). 16px so iOS doesn't zoom on focus. */
const INLINE_INPUT =
  "min-h-[44px] bg-transparent py-2 text-right text-base text-mp-ink outline-none placeholder:text-mp-ink-3 [&::-webkit-date-and-time-value]:text-right [&::-webkit-datetime-edit]:text-right";

/**
 * Chromium's date-picker glyph ignores the theme (black in dark mode, white at
 * night), so it's redrawn as the calendar line icon in ink-3 via a mask. iOS
 * has no glyph; the picker opens from the field itself.
 */
const DATE_PICKER_ICON =
  "[&::-webkit-calendar-picker-indicator]:bg-none [&::-webkit-calendar-picker-indicator]:bg-mp-ink-3 [&::-webkit-calendar-picker-indicator]:[mask:url(data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.75%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpath%20d%3D%22M8%202v3M16%202v3M3%209h18%22%2F%3E%3Crect%20x%3D%223%22%20y%3D%223%22%20width%3D%2218%22%20height%3D%2218%22%20rx%3D%222%22%2F%3E%3C%2Fsvg%3E)_center/18px_no-repeat]";

/** Quiet destructive text action at the end of a row (Revoke, Sign out, Delete). */
const DANGER_TEXT =
  "-mr-2 min-h-[44px] shrink-0 rounded-[10px] px-2 text-[15px] font-medium text-mp-danger transition hover:bg-mp-danger/10 active:scale-[0.97] disabled:opacity-40";

function Section({ title, footnote, children, action }: { title: string; footnote?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section>
      <SectionTitle action={action}>{title}</SectionTitle>
      {children}
      {footnote && <Footnote>{footnote}</Footnote>}
    </section>
  );
}

function Footnote({ children }: { children: ReactNode }) {
  return <p className={cx(tone.faint, "mt-2 px-1 text-[13px] leading-snug")}>{children}</p>;
}

/** One settings row: label (and an optional note) on the left, the control on the right. */
function Row({ label, note, children, className }: { label: ReactNode; note?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-h-[52px] items-center gap-3 px-4 py-2.5", className)}>
      <div className="min-w-0 flex-1">
        <div className={cx(tone.body, "text-[15px]")}>{label}</div>
        {note && <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{note}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * A text field as a row: the label on the left, the value typed on the right.
 * With a note, the label and note take the room and the field is short.
 * `after` sits outside the <label> (a link inside a label is invalid).
 */
function InputRow({
  label,
  note,
  after,
  className,
  ...input
}: { label: string; note?: ReactNode; after?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex items-center gap-1 pr-4 transition focus-within:bg-mp-ink/[0.03]">
      <label className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-1 pl-4">
        <span className={cx("min-w-0", note ? "flex-1 py-1.5" : "shrink-0")}>
          <span className={cx(tone.body, "block text-[15px]")}>{label}</span>
          {note && <span className={cx(tone.muted, "mt-0.5 block text-[13px] leading-snug")}>{note}</span>}
        </span>
        <input
          {...input}
          // A date field sizes to its content and sits right (Chromium won't right-align inside it).
          className={cx(INLINE_INPUT, note ? "w-20 shrink-0" : input.type === "date" ? cx("ml-auto min-w-0", DATE_PICKER_ICON) : "w-full min-w-0 flex-1", className)}
        />
      </label>
      {after}
    </div>
  );
}

/** A tappable row that does something: an icon, accent text, an optional note, and a chevron when it goes somewhere. */
function ActionRow({
  icon,
  label,
  note,
  chevron,
  onClick,
}: {
  icon: IconName;
  label: string;
  note?: string;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className={cx(tone.row, "min-h-[52px] py-2.5")}>
      <Icon name={icon} size={20} className="shrink-0 text-mp-accent-fg" />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium text-mp-accent-fg">{label}</span>
        {note && <span className={cx(tone.muted, "block text-[13px] leading-snug")}>{note}</span>}
      </span>
      {chevron && <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />}
    </button>
  );
}

/** A row that opens and closes the content under it. */
function Disclosure({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className={cx(tone.row, "min-h-[52px]")}>
        <span className={cx(tone.body, "shrink-0 text-[15px] font-medium")}>{label}</span>
        <span className={cx(tone.muted, "min-w-0 flex-1 truncate text-right text-sm")}>{summary}</span>
        <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", open && "rotate-180")} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
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
      {state === "done" ? (
        <>
          <Icon name="check" size={16} strokeWidth={2.25} />
          Copied
        </>
      ) : state === "fail" ? (
        "Press and hold to copy"
      ) : (
        label
      )}
    </Button>
  );
}

function Code({ children }: { children: ReactNode }) {
  // Short tokens (`speak`, `pee`) stay whole; long URLs and keys may break anywhere.
  const long = typeof children === "string" ? children.length > 24 : true;
  return (
    <code className={cx("rounded-md bg-mp-sunken px-1.5 py-0.5 font-mono text-[13px] text-mp-ink", long ? "break-all" : "whitespace-nowrap")}>
      {children}
    </code>
  );
}

/** An iOS-style switch. The button is a 44px target around the 51×31 track. */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="-my-1.5 flex h-11 shrink-0 items-center disabled:opacity-40"
    >
      <span
        className={cx(
          "relative block h-[31px] w-[51px] rounded-full transition-colors",
          checked ? "bg-mp-accent [.maple-night_&]:bg-[rgb(224_169_59/0.3)]" : "bg-mp-sunken ring-1 ring-mp-line ring-inset [.maple-night_&]:bg-transparent"
        )}
      >
        {/* White knob by day and in dark mode. At night on is filled (a bright knob on an amber track) and off is hollow, so off can't pass for on. */}
        <span
          className={cx(
            "absolute top-[2px] left-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(0,0,0,0.18)] transition-transform",
            checked
              ? "translate-x-5 [.maple-night_&]:bg-mp-on-accent"
              : "[.maple-night_&]:bg-transparent [.maple-night_&]:shadow-[inset_0_0_0_2px_rgb(224_169_59/0.5)]"
          )}
        />
      </span>
    </button>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <Row label={label} note={hint}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </Row>
  );
}

/** How someone shows on rows: their initial on their color (value "", the default), or an emoji they pick. */
function EmojiPicker({ value, onChange, initial, color }: { value: string; onChange: (e: string) => void; initial: string; color: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Shown as">
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        aria-label="Initial"
        onClick={() => onChange("")}
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-full transition active:scale-95",
          value === "" ? "bg-mp-accent/10 ring-2 ring-mp-accent-fg" : "bg-mp-sunken"
        )}
      >
        <span aria-hidden className="mp-kind-fill flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold text-white" style={{ backgroundColor: color }}>
          {initial}
        </span>
      </button>
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
            value === e ? "bg-mp-accent/10 ring-2 ring-mp-accent-fg" : "bg-mp-sunken"
          )}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/** Save / Cancel under a card once something in it has changed. */
function SaveBar({ busy, onSave, onCancel }: { busy: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="mt-3 flex gap-2">
      <Button className="flex-1" disabled={busy} onClick={onSave}>
        Save changes
      </Button>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
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
    <div className="space-y-6 px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-8">
      <header className="px-1">
        <h1 className={cx(tone.display, "flex min-h-[44px] items-center text-[34px] leading-[1.05]")}>Family</h1>
      </header>
      <People />
      <BabyDetails />
      <DoctorQuestions />
      <Preferences />
      {!readOnly && <ConnectAI />}
      {!readOnly && <HandsFree />}
      <DataAndAccount />
      <p className={cx(tone.faint, "px-4 text-center text-xs leading-relaxed")}>{DISCLAIMER}</p>
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
      toast(`Invite for ${inv.display_name ?? "them"} revoked`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke that", { tone: "error" });
    }
  };

  const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - now().getTime()) / 864e5));

  return (
    <>
      <Section
        title="Maple's people"
        footnote={members.length === 1 ? "It's just you so far. Invite Brittany, grandparents, or anyone helping out." : undefined}
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
                    <p className={cx(tone.body, "truncate text-[15px] font-medium")}>{inv.display_name ?? "Someone"}</p>
                    <p className={cx(tone.muted, "text-[13px] leading-snug")}>
                      Invite link waiting · {inv.role === "viewer" ? "View only" : "Can log"} · expires {d <= 1 ? "within a day" : `in ${d} days`}
                    </p>
                  </div>
                  <button type="button" onClick={() => void revoke(inv)} className={DANGER_TEXT}>
                    Revoke
                  </button>
                </li>
              );
            })}
        </ul>
      </Section>

      {owner && (
        <Section title="Invite someone">
          <div className={GROUP}>
            <InviteByEmail />
            <ActionRow
              icon="link"
              label="Invite someone without Google"
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
            Claude/ChatGPT to it); the rest of brooker.family is unaffected. Google sign-in keeps working for everyone else.
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
            confirmRow(`Remove ${memberName(m.email)}?`, "Remove")
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
      toast(`Added ${email.trim()}. They can sign in with Google at brooker.family/maple`, { duration: 6000 });
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
  const { state, api, toast } = useMaple();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
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
      setEmoji("");
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
            <span className={cx(tone.label, "mb-1.5 block")}>Shown as</span>
            {/* They'll join at the end of the family list, so that's the color their initial gets; the letter fills in as their name is typed. */}
            <EmojiPicker
              value={emoji}
              onChange={setEmoji}
              initial={name.trim()[0]?.toUpperCase() ?? ""}
              color={MEMBER_PALETTE[(state?.members.length ?? 0) % MEMBER_PALETTE.length]}
            />
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
            <p className={cx(tone.muted, "mt-1.5 text-[13px] leading-snug")}>
              {role === "viewer"
                ? "Viewers see Maple's day and her moments, but can't log or change anything."
                : "Members can log feeds, diapers and sleep, just like you."}
            </p>
          </div>
        </>
      ) : (
        <>
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Send this to {name.trim() || "them"}. It works <strong className="font-semibold">once</strong>, for <strong className="font-semibold">7 days</strong>, and signs them in on whichever phone
            opens it. You won&apos;t see this link again.
          </p>
          <div className={cx(tone.inset, "p-3")}>
            <p className="font-mono text-[13px] leading-relaxed break-all text-mp-ink select-all">{url}</p>
          </div>
          <div className="flex gap-2">
            <CopyButton text={url} label="Copy link" className="min-h-[48px] flex-1 text-[15px]" />
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
      toast("Saved");
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
  // Off unless switched on (the others default on).
  const warnings = toggles.show_alerts ?? alertsOn(baby);

  const born = baby.born_at ? new Date(baby.born_at) : null;
  const bornDay = born ? formatDayLabel(dayKey(born, tz), dayKey(now(), tz), { long: true }) : "";
  const bornLine = born ? `Born ${/^(Today|Yesterday)$/.test(bornDay) ? bornDay.toLowerCase() : bornDay} at ${formatTime(born, tz)}` : null;
  const stats = [
    baby.birth_weight_g ? formatWeight(baby.birth_weight_g, units) : null,
    baby.birth_length_cm ? `${formatLength(baby.birth_length_cm, units)} long` : null,
    baby.birth_head_cm ? `head ${formatLength(baby.birth_head_cm, units)}` : null,
  ].filter(Boolean);

  const birthRow = (
    <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cx(tone.body, "text-[15px]")}>{bornLine ?? "Not born yet"}</p>
        <p className={cx(tone.muted, "text-[13px] tabular-nums")}>
          {born ? (stats.length ? stats.join(" · ") : "Weight and length not added yet") : baby.due_date ? `Due ${formatDayLabel(baby.due_date, dayKey(now(), tz), { long: true })}` : "Any day now"}
        </p>
      </div>
      {!readOnly && (
        <Button variant={born ? "ghost" : "primary"} size="sm" className={born ? "-mr-3" : undefined} onClick={() => setBirthOpen(true)}>
          {born ? "Edit" : "She's here!"}
        </Button>
      )}
    </div>
  );

  if (readOnly) {
    const phone = doctorSrc.pedPhone;
    return (
      <Section title="Maple">
        <div className={GROUP}>
          <p className="flex flex-wrap items-baseline gap-x-2 px-4 py-3.5">
            <span className={cx(tone.display, "text-[24px] leading-tight")}>{baby.name}</span>
            {baby.nickname && <span className={cx(tone.muted, "text-sm")}>“{baby.nickname}”</span>}
          </p>
          {birthRow}
          {phone && (
            <a href={telHref(phone)} className={cx(tone.row, "min-h-[52px]")}>
              <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
              <span className={cx(tone.body, "flex-1 text-[15px]")}>Pediatrician</span>
              <span className="text-[15px] font-medium text-mp-accent-fg tabular-nums">{phone}</span>
            </a>
          )}
        </div>
      </Section>
    );
  }

  return (
    <>
      <Section title="Maple">
        <div className={GROUP}>
          <InputRow label="Name" value={p.name} maxLength={80} onChange={(e) => setPEdits((x) => ({ ...x, name: e.target.value }))} />
          <InputRow
            label="Nickname"
            value={p.nickname}
            maxLength={40}
            placeholder="Maple"
            onChange={(e) => setPEdits((x) => ({ ...x, nickname: e.target.value }))}
          />
          <InputRow label="Due date" type="date" value={p.due} onChange={(e) => setPEdits((x) => ({ ...x, due: e.target.value }))} />
          {birthRow}
        </div>
        {pDirty && <SaveBar busy={busy === "profile"} onSave={() => void save("profile")} onCancel={() => setPEdits({})} />}
      </Section>

      <Section title="Her doctor" footnote="Her doctor's numbers, for the middle of the night.">
        <div className={GROUP}>
          <PhoneRow label="Pediatrician" value={d.pedPhone} saved={doctorSrc.pedPhone} onChange={(v) => setDEdits((x) => ({ ...x, pedPhone: v }))} />
          <PhoneRow label="After-hours line" value={d.afterHours} saved={doctorSrc.afterHours} onChange={(v) => setDEdits((x) => ({ ...x, afterHours: v }))} />
          {/* These only tune the reminders. */}
          {warnings && (
            <>
              <InputRow
                label="Weeks at birth"
                note="Born before 37 weeks or under 5½ lb? Maple's reminders step back and defer to your pediatrician's plan."
                inputMode="numeric"
                placeholder="e.g. 39"
                value={d.gaWeeks}
                onChange={(e) => setDEdits((x) => ({ ...x, gaWeeks: e.target.value.replace(/[^\d.]/g, "") }))}
              />
              <InputRow
                label="Feed every … hours (optional)"
                note="Only if her pediatrician gave you a number. It replaces the built-in feeding reminders."
                inputMode="decimal"
                placeholder="e.g. 3"
                value={d.feedHours}
                onChange={(e) => setDEdits((x) => ({ ...x, feedHours: e.target.value.replace(/[^\d.]/g, "") }))}
              />
            </>
          )}
        </div>
        {dDirty && <SaveBar busy={busy === "doctor"} onSave={() => void save("doctor")} onCancel={() => setDEdits({})} />}
      </Section>

      <Section title="On Today">
        <div className={GROUP}>
          <Toggle
            label="Warnings & reminders"
            hint="Feed gaps, diaper counts, weight, vitamin D and checkups. They only make sense when everything gets logged. A temperature, oxygen reading or poop color is still checked as you enter it."
            checked={warnings}
            onChange={(v) => void setSetting("show_alerts", v)}
          />
          {warnings && (
            <Toggle
              label="Vitamin D reminder"
              hint="A gentle evening nudge if no vitamin D drops are logged that day."
              checked={flag("vitamin_d_reminder")}
              onChange={(v) => void setSetting("vitamin_d_reminder", v)}
            />
          )}
          <Toggle
            label="Show diaper brigade"
            hint="Who changed how many this week, nights included."
            checked={flag("show_brigade")}
            onChange={(v) => void setSetting("show_brigade", v)}
          />
        </div>
      </Section>
      <BirthSheet open={birthOpen} onClose={() => setBirthOpen(false)} mode={born ? "edit" : "birth"} />
    </>
  );
}

function PhoneRow({ label, value, saved, onChange }: { label: string; value: string; saved: string; onChange: (v: string) => void }) {
  return (
    <InputRow
      label={label}
      type="tel"
      inputMode="tel"
      autoComplete="off"
      // Not a sample number: borderless, it would read like a saved one at 3am.
      placeholder="Add number"
      aria-label={`${label} phone`}
      className="tabular-nums"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      after={
        saved ? (
          <a href={telHref(saved)} aria-label={`Call ${label}`} className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent">
              <Icon name="phone" size={16} strokeWidth={2} />
            </span>
          </a>
        ) : undefined
      }
    />
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
    await log({ kind: "note", data: { for_doctor: true }, note: t }, { toast: "Added to the list for the doctor" });
  };

  const patchLocal = (saved: Entry | null) => {
    if (saved && isQuestion(saved)) setFetched((list) => list.map((q) => (q.id === saved.id ? saved : q)));
  };

  return (
    <Section
      title="Questions for the doctor"
      footnote={readOnly ? "What the family plans to ask at her next checkup." : "Jot them down as they come up; tick them off at her checkup."}
    >
      <div className={GROUP}>
        {!readOnly && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            className="flex items-center gap-1 py-1.5 pr-2 pl-1.5"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-mp-accent-fg" aria-hidden>
              <Icon name="plus" size={20} strokeWidth={2} />
            </span>
            <input
              className="min-h-[44px] min-w-0 flex-1 bg-transparent text-base text-mp-ink outline-none placeholder:text-mp-ink-3"
              value={text}
              maxLength={300}
              placeholder="Is her cheek rash okay?"
              aria-label="New question for the doctor"
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={!text.trim()}>
              Add
            </Button>
          </form>
        )}

        {open.length === 0 ? (
          <p className={cx(tone.muted, "px-4 py-4 text-center text-sm")}>{done.length ? "All asked." : "No questions yet."}</p>
        ) : (
          <ul className={tone.divide}>
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
          <Disclosure label="Asked" summary={done.length} open={showDone} onToggle={() => setShowDone((v) => !v)}>
            <ul className="-ml-2.5 space-y-1">
              {done.map((q) => (
                <li key={q.id} className="flex items-start gap-1">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={async () => patchLocal(await update(q.id, { data: { done: false } }, { toast: "Back on the list" }))}
                    aria-label="Put back on the list"
                    className="flex h-11 w-11 shrink-0 items-center justify-center"
                  >
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-mp-accent text-mp-on-accent">
                      <Icon name="check" size={14} strokeWidth={2.75} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1 py-2.5">
                    <p className={cx(tone.muted, "text-[15px] leading-snug line-through decoration-mp-ink-3/60")}>{q.note}</p>
                    {q.data.answer && (
                      <p className={cx(tone.body, "mt-1 flex gap-1.5 text-sm leading-snug")}>
                        <Icon name="stethoscope" size={15} className="mt-[2px] shrink-0 text-mp-ink-3" label="Doctor's answer" />
                        <span>{q.data.answer}</span>
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
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
      <div className="flex items-start gap-1 pr-4 pl-1.5">
        <button
          type="button"
          disabled={readOnly}
          onClick={() => setOpen((v) => !v)}
          aria-label="Tick off"
          aria-expanded={open}
          className="flex h-11 w-11 shrink-0 items-center justify-center"
        >
          <span
            className={cx(
              "h-[22px] w-[22px] rounded-full border-[1.5px] transition",
              open ? "border-mp-accent-fg bg-mp-accent/10" : "border-mp-ink-3"
            )}
          />
        </button>
        <div className="min-w-0 flex-1 py-2.5">
          <p className={cx(tone.body, "text-[15px] leading-snug")}>{q.note || "(no text)"}</p>
          <p className={cx(tone.faint, "mt-0.5 text-xs")}>{by}</p>
        </div>
      </div>
      {open && (
        <div className="mr-4 mb-3 ml-[54px] space-y-2">
          <TextArea value={answer} onChange={setAnswer} placeholder="What did the doctor say? (optional)" />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void onDone(answer.trim())}>
              <Icon name="check" size={16} strokeWidth={2.25} />
              Asked
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Not yet
            </Button>
            <button type="button" onClick={onRemove} className={cx(DANGER_TEXT, "ml-auto text-sm")}>
              Delete
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// ── Preferences ──────────────────────────────────────────────────────────

/** A label on the left and a segmented control on the right; it wraps under on a very narrow phone. */
function SegmentRow({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className={cx(tone.body, "text-[15px]")}>{label}</span>
        <div className="ml-auto w-[13.5rem] max-w-full">{children}</div>
      </div>
      {note && <p className={cx(tone.muted, "mt-2 text-[13px] leading-snug")}>{note}</p>}
    </div>
  );
}

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
      <div className={GROUP}>
        <SegmentRow label="Units">
          <Segmented
            value={units}
            onChange={setUnits}
            options={[
              { value: "us", label: "lb · oz · °F" },
              { value: "metric", label: "kg · ml · °C" },
            ]}
          />
        </SegmentRow>
        <SegmentRow
          label="Night look"
          note={
            night === "auto"
              ? "Dim amber from 8pm to 7am, easy on sleepy eyes."
              : night === "always"
                ? "Dim amber all the time."
                : "Follows the light or dark theme below."
          }
        >
          <Segmented<NightPref>
            value={night}
            onChange={setNight}
            options={[
              { value: "auto", label: "Auto" },
              { value: "always", label: "Always" },
              { value: "off", label: "Off" },
            ]}
          />
        </SegmentRow>
        <SegmentRow label="Theme" note="Same setting as the rest of brooker.family.">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "system", label: "Auto" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SegmentRow>
        {!standalone && (
          <div className="flex gap-3 px-4 py-3.5">
            <Icon name="share" size={20} className="mt-0.5 shrink-0 text-mp-accent-fg" />
            <p className={cx(tone.muted, "text-sm leading-relaxed")}>
              <strong className="font-semibold text-mp-ink">Add Maple&apos;s Log to your Home Screen</strong> for one-tap logging. On iPhone, open
              this page in Safari, tap <strong className="font-semibold text-mp-ink">Share</strong>, then{" "}
              <strong className="font-semibold text-mp-ink">Add to Home Screen</strong>.
            </p>
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Claude / ChatGPT ─────────────────────────────────────────────────────

function ConnectAI() {
  const [manual, setManual] = useState(false);
  return (
    <Section title="Talk to Maple's Log">
      <div className={GROUP}>
        <div className="space-y-3 px-4 py-3.5">
          <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
            Connect Claude or ChatGPT and just say what happened. It lands here with your name on it, and you can ask questions too.
          </p>
          <ul className="space-y-1 border-l-2 border-mp-line pl-3" aria-label="Things you can say">
            {EXAMPLES.map((s) => (
              <li key={s} className={cx(tone.muted, "text-[15px] leading-snug")}>
                {s}
              </li>
            ))}
          </ul>
        </div>
        <Link href="/maple/connect" className={cx(tone.row, "min-h-[52px]")}>
          <Icon name="list-checks" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="flex-1 text-[15px] font-medium text-mp-accent-fg">Step-by-step setup</span>
          <Icon name="chevron-right" size={18} className="shrink-0 text-mp-ink-3" />
        </Link>
        <Disclosure label="Where to add it" summary="Claude, ChatGPT" open={manual} onToggle={() => setManual((v) => !v)}>
          <dl className="space-y-3 text-sm">
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
        </Disclosure>
        <CalendarConnectorAsMe />
      </div>
    </Section>
  );
}

/**
 * The "Brooker Family Calendar" connector (the site admin login) carries
 * Maple's tools too. An owner can have what it logs count as them, so it
 * isn't split off under "Admin".
 */
function CalendarConnectorAsMe() {
  const { state, api, refresh, toast, memberName } = useMaple();
  const [busy, setBusy] = useState(false);
  const me = state?.me;
  if (!state || !me || me.role !== "owner" || me.email === "admin") return null;
  const raw = (state.baby.settings as { admin_as?: unknown }).admin_as;
  const stored = typeof raw === "string" ? raw : null;
  const someoneElse = stored && stored !== me.email && adminActsAs(state.baby, state.members) ? stored : null;

  const set = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ settings: { admin_as: on ? me.email : null } }) });
      await refresh();
      toast(on ? "The calendar connector logs as you now" : "The calendar connector logs as Admin");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Toggle
      label="Calendar connector logs as me"
      hint={`The Brooker Family Calendar connector (the site's admin login) can log Maple too. ${
        someoneElse ? `Right now it logs as ${memberName(someoneElse)}.` : "Turn this on so what it logs counts as you, not “Admin”."
      }`}
      checked={stored === me.email}
      disabled={busy}
      onChange={(v) => void set(v)}
    />
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

const KEY_MARK = "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2";

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
      toast("Key revoked. Shortcuts using it stop working.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't revoke", { tone: "error" });
    }
  };

  const url = `${origin}/api/maple/quick`;
  const header = `Bearer ${fresh ?? "<your key>"}`;
  const strong = "font-semibold text-mp-ink";

  return (
    <Section title="Hands-free with Siri">
      <div className={GROUP}>
        <p className={cx(tone.body, "px-4 py-3.5 text-[15px] leading-relaxed")}>
          Say <strong className="font-semibold">“Hey Siri, Maple pee”</strong> and it&apos;s logged, no unlocking or tapping. Works with the Action
          Button and Back Tap too. Each grown-up makes their own key, so entries carry their name.
        </p>

        {tokens &&
          tokens.map((t) => (
            <div key={t.id} className="flex min-h-[56px] items-center gap-3 px-4 py-2">
              <span className={KEY_MARK} aria-hidden>
                <Icon name="key-round" size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className={cx(tone.body, "truncate text-[15px] font-medium")}>{t.label || "iPhone Shortcuts"}</p>
                <p className={cx(tone.muted, "text-[13px]")}>{t.last_used_at ? `Last used ${formatRelative(t.last_used_at, now())}` : "Not used yet"}</p>
              </div>
              <button type="button" onClick={() => void revoke(t)} className={DANGER_TEXT}>
                Revoke
              </button>
            </div>
          ))}

        {fresh ? (
          <div className="space-y-2.5 px-4 py-3.5">
            <p className={tone.label}>Your new key · shown once</p>
            <div className={cx(tone.inset, "px-3 py-2.5")}>
              <p className="font-mono text-[13px] break-all text-mp-ink select-all">{fresh}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyButton text={fresh} label="Copy key" />
              {/* Dismisses this key (it was shown once) and brings back the form for another. */}
              <Button variant="ghost" size="sm" onClick={() => setFresh(null)}>
                <Icon name="plus" size={16} strokeWidth={2} />
                Make another key
              </Button>
            </div>
            <p className={cx(tone.muted, "text-[13px] leading-snug")}>Keep it private: anyone with it can log as you.</p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            className="flex items-center gap-1 py-1.5 pr-2 pl-1.5"
          >
            {/* The same "add" mark as a new doctor question, so it doesn't read as one of the keys. */}
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-mp-accent-fg" aria-hidden>
              <Icon name="plus" size={20} strokeWidth={2} />
            </span>
            <input
              className="min-h-[44px] min-w-0 flex-1 bg-transparent text-base text-mp-ink outline-none placeholder:text-mp-ink-3"
              value={label}
              maxLength={40}
              placeholder="Matt's iPhone"
              aria-label="Key name"
              onChange={(e) => setLabel(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy} className="shrink-0">
              Make a key
            </Button>
          </form>
        )}

        <Disclosure label="Set up the shortcut" open={howTo} onToggle={() => setHowTo((v) => !v)}>
          <ol className={cx(tone.body, "list-decimal space-y-3 pl-5 text-sm leading-relaxed marker:font-semibold marker:text-mp-ink-3")}>
            <li>
              Open the <strong className={strong}>Shortcuts</strong> app, tap <strong className={strong}>+</strong>, and name the shortcut{" "}
              <strong className={strong}>Maple pee</strong>.
            </li>
            <li>
              Add the action <strong className={strong}>Get Contents of URL</strong> and set the URL to
              <span className="mt-1.5 flex items-center gap-2">
                <Code>{url}</Code>
                <CopyButton text={url} />
              </span>
            </li>
            <li>
              Tap <strong className={strong}>›</strong> to show more. Set <strong className={strong}>Method</strong> to{" "}
              <strong className={strong}>POST</strong>.
            </li>
            <li>
              Under <strong className={strong}>Headers</strong>, add <Code>Authorization</Code> with the value
              <span className="mt-1.5 flex items-center gap-2">
                <Code>{header}</Code>
                {fresh && <CopyButton text={header} />}
              </span>
              {!fresh && <span className={cx(tone.muted, "mt-1 block text-xs")}>Make a key above to fill this in.</span>}
            </li>
            <li>
              Set <strong className={strong}>Request Body</strong> to <strong className={strong}>JSON</strong> and add a Text field: key{" "}
              <Code>action</Code>, value <Code>pee</Code>.
            </li>
            <li>
              Add <strong className={strong}>Get Dictionary Value</strong>: get the value for <Code>speak</Code> in{" "}
              <strong className={strong}>Contents of URL</strong>.
            </li>
            <li>
              Add <strong className={strong}>Speak Text</strong> with that <strong className={strong}>Dictionary Value</strong>, so Siri tells you
              what was logged.
            </li>
            <li>
              Try it: <strong className={strong}>“Hey Siri, Maple pee.”</strong> For one-press logging, choose the shortcut under Settings → Action
              Button, or Settings → Accessibility → Touch → Back Tap.
            </li>
            <li>
              Duplicate it for the rest, changing the name and the <Code>action</Code>:
              <table className="mt-2 w-full text-left text-[13px]">
                <tbody className={tone.divide}>
                  {SHORTCUTS.map(([name, action]) => (
                    <tr key={action}>
                      <td className="py-1.5 pr-2 font-medium">{name}</td>
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
        </Disclosure>
      </div>
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
    <Section title="Data & account">
      <div className={GROUP}>
        <a href="/api/maple/export" download className={cx(tone.row, "min-h-[52px] py-2.5")}>
          <Icon name="download" size={20} className="shrink-0 text-mp-accent-fg" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-mp-accent-fg">Download everything (CSV)</span>
            <span className={cx(tone.muted, "block text-[13px] leading-snug")}>Every entry, for a spreadsheet or her pediatrician.</span>
          </span>
        </a>
        <Row label={<span className="block truncate">Signed in as {memberName(state!.me.email)}</span>}>
          <button type="button" disabled={busy} onClick={() => void signOut()} className={DANGER_TEXT}>
            Sign out
          </button>
        </Row>
      </div>
    </Section>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { partLevelOf } from "@/lib/maple/access";
import type { Member } from "@/lib/maple/types";
import { Icon } from "../icons";
import { Avatar, Button, Field, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";

/**
 * Shared chats on the Chat tab (lib/maple/chat/shared.ts): the person's own
 * chat, or one of the chats they share with people they picked. The switcher
 * sits under the Chat header; its sheet lists the chats and starts a new one,
 * and a shared chat's People sheet adds people or leaves it. The server
 * decides who's in a chat and what it reads; this only offers what it would
 * take (anyone the chat is on for, never a photos-only guest).
 */

export type SharedChat = { id: string; name: string | null; people: string[]; createdBy: string; updatedAt: string; busy: boolean };

/**
 * The person's shared chats, read when the Chat tab shows and after every
 * change here. A family of one has nobody to share a chat with, so it reads
 * nothing.
 */
export function useSharedChats(active: boolean) {
  const { api, state } = useMaple();
  const me = state?.me.email ?? "";
  const family = state?.family?.id ?? 1;
  const others = (state?.members ?? []).some((m) => m.email !== me && m.role !== "photos");
  const [chats, setChats] = useState<SharedChat[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ chats: SharedChat[] }>("/api/maple/chat/shared");
      setChats(r.chats);
      setLoaded(true);
      return r.chats;
    } catch {
      return null;
    }
  }, [api]);
  useEffect(() => {
    setChats([]);
    setLoaded(false);
  }, [me, family]);
  useEffect(() => {
    if (active && others) void reload();
  }, [active, others, reload, me, family]);
  const post = useCallback(async (body: Record<string, unknown>) => {
    const r = await api<{ chat?: SharedChat }>("/api/maple/chat/shared", { method: "POST", body: JSON.stringify(body) });
    await reload();
    return r.chat ?? null;
  }, [api, reload]);
  return {
    chats,
    loaded,
    reload,
    create: (people: string[], name: string) => post({ action: "create", people, ...(name.trim() ? { name: name.trim() } : {}) }),
    add: (id: string, people: string[]) => post({ action: "add", id, people }),
    leave: (id: string) => post({ action: "leave", id }),
  };
}

export type SharedChats = ReturnType<typeof useSharedChats>;

/** People who can be in a shared chat with this person: everyone else the chat is on for. */
export function shareablePeople(members: Member[], me: string): Member[] {
  return members.filter((m) => m.email !== me && m.role !== "photos" && partLevelOf(m, "chat") !== "none");
}

/** A shared chat's name: the one it was given, else the others in it ("Blake and Casey"). */
export function sharedChatName(chat: Pick<SharedChat, "name" | "people">, me: string, nameOf: (id: string) => string): string {
  if (chat.name) return chat.name;
  const others = chat.people.filter((p) => p !== me).map(nameOf);
  if (!others.length) return "Just you";
  if (others.length <= 2) return others.join(" and ");
  return `${others.slice(0, 2).join(", ")} and ${others.length - 2} more`;
}

/** The row under the Chat header: which conversation this is, a way to the others, and a shared chat's people. */
export function ChatSwitcher({ chat, shared, disabled, onOpenList, onOpenPeople }: {
  chat: SharedChat | null;
  shared: SharedChats;
  disabled: boolean;
  onOpenList: () => void;
  onOpenPeople: () => void;
}) {
  const { state, memberName } = useMaple();
  const me = state?.me.email ?? "";
  const members = state?.members ?? [];
  const label = chat ? sharedChatName(chat, me, memberName) : "Your chat";
  const offerShared = shareablePeople(members, me).length > 0 || shared.chats.length > 0;
  if (!chat && !offerShared) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
      <button
        type="button"
        onClick={onOpenList}
        disabled={disabled}
        aria-label={`${label}. Switch chats`}
        className={cx(tone.card, "flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-full px-3.5 text-left disabled:opacity-50")}
      >
        <Icon name={chat ? "users" : "message-square"} size={18} className="shrink-0 text-mp-ink-2" />
        <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-semibold")}>{label}</span>
        {!chat && shared.chats.length > 0 && <span className={cx(tone.muted, "shrink-0 text-[13px]")}>{shared.chats.length} shared</span>}
        <Icon name="chevron-down" size={18} className="shrink-0 text-mp-ink-3" />
      </button>
      {chat && (
        <button type="button" onClick={onOpenPeople} className="flex min-h-[44px] shrink-0 items-center -space-x-2 rounded-full px-1" aria-label={`People in ${label}`}>
          {chat.people.slice(0, 3).map((p) => <Avatar key={p} member={members.find((m) => m.email === p) ?? null} size={30} />)}
          {chat.people.length > 3 && <span className={cx(tone.muted, "pl-3 text-[13px]")}>+{chat.people.length - 3}</span>}
        </button>
      )}
    </div>
  );
}

/** Every chat this person has: their own, then the shared ones, newest first, and a way to start one. */
export function ChatListSheet({ open, onClose, current, shared, onPick, onNew }: {
  open: boolean;
  onClose: () => void;
  current: SharedChat | null;
  shared: SharedChats;
  onPick: (chat: SharedChat | null) => void;
  onNew: () => void;
}) {
  const { state, memberName } = useMaple();
  const me = state?.me.email ?? "";
  const canStart = shareablePeople(state?.members ?? [], me).length > 0;
  const row = (chat: SharedChat | null) => {
    const selected = (chat?.id ?? null) === (current?.id ?? null);
    return (
      <li key={chat?.id ?? "own"}>
        <button
          type="button"
          onClick={() => onPick(chat)}
          aria-current={selected ? "true" : undefined}
          className={cx(tone.row, "min-h-[60px] w-full py-2.5 text-left", selected && "bg-mp-accent/5")}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-mp-sunken text-mp-ink-2" aria-hidden>
            <Icon name={chat ? "users" : "message-square"} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cx(tone.body, "block truncate text-[15px] font-medium")}>{chat ? sharedChatName(chat, me, memberName) : "Your chat"}</span>
            <span className={cx(tone.muted, "block truncate text-[13px] leading-snug")}>
              {chat ? `With ${chat.people.filter((p) => p !== me).map(memberName).join(", ") || "nobody else yet"}` : "Only you can see it"}
            </span>
          </span>
          {selected && <Icon name="check" size={18} className="shrink-0 text-mp-accent-fg" />}
        </button>
      </li>
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Chats">
      <ul className="-mx-4 divide-y divide-mp-line">
        {row(null)}
        {shared.chats.map((c) => row(c))}
      </ul>
      {canStart && (
        <Button className="mt-4 w-full" onClick={onNew}>
          <Icon name="plus" size={18} />
          New shared chat
        </Button>
      )}
      <p className={cx(tone.faint, "mt-3 text-[13px] leading-snug")}>
        Everyone in a shared chat reads what&apos;s said in it, and Maple only uses what all of them can see.
      </p>
    </Sheet>
  );
}

/** People to pick, as checkboxes: avatar, name, and why someone can't be picked. */
function PeoplePicker({ people, picked, onChange, disabled, legend }: { people: Member[]; picked: string[]; onChange: (next: string[]) => void; disabled?: boolean; legend: string }) {
  const { memberName } = useMaple();
  return (
    <fieldset disabled={disabled} className="space-y-1">
      <legend className="mb-2 text-[13px] font-semibold text-mp-ink-2">{legend}</legend>
      {people.map((m) => {
        const on = picked.includes(m.email);
        return (
          <label key={m.email} className={cx("flex min-h-[52px] cursor-pointer items-center gap-3 rounded-xl border px-3 py-2", on ? "border-mp-accent bg-mp-accent/5" : "border-mp-line")}>
            <input
              type="checkbox"
              checked={on}
              onChange={() => onChange(on ? picked.filter((p) => p !== m.email) : [...picked, m.email])}
              className="h-4 w-4 shrink-0 accent-mp-accent"
            />
            <Avatar member={m} size={32} />
            <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-medium")}>{memberName(m.email)}</span>
            {m.role === "viewer" && <span className={cx(tone.muted, "shrink-0 text-[12px]")}>View only</span>}
          </label>
        );
      })}
    </fieldset>
  );
}

/** Starts a shared chat with the people picked, named or not. */
export function NewSharedChatSheet({ open, onClose, shared, onCreated }: { open: boolean; onClose: () => void; shared: SharedChats; onCreated: (chat: SharedChat) => void }) {
  const { state, toast } = useMaple();
  const me = state?.me.email ?? "";
  const people = useMemo(() => shareablePeople(state?.members ?? [], me), [state?.members, me]);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPicked([]);
      setName("");
    }
  }, [open]);
  const create = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      const chat = await shared.create(picked, name);
      if (chat) onCreated(chat);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't start that chat", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open={open}
      locked={busy}
      dirty={!!picked.length || !!name.trim()}
      onClose={onClose}
      title="New shared chat"
      footer={
        <Button size="lg" className="w-full" disabled={!picked.length || busy} onClick={() => void create()}>
          {busy ? "Starting…" : "Start chat"}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Everyone you pick reads every message and every answer in it. Maple only uses what all of you can see, so something hidden from
          one of you stays out of it.
        </p>
        <PeoplePicker legend="Who's in it" people={people} picked={picked} onChange={setPicked} disabled={busy} />
        <Field label="Name (optional)">
          <input className={tone.input} value={name} maxLength={60} placeholder="Night shift" onChange={(e) => setName(e.target.value)} disabled={busy} />
        </Field>
        <p className={cx(tone.faint, "text-[13px] leading-snug")}>Photos stay in your own chat for now.</p>
      </div>
    </Sheet>
  );
}

/** A shared chat's people: who's in it, adding more, and leaving it. */
export function SharedPeopleSheet({ open, onClose, chat, shared, onLeft }: { open: boolean; onClose: () => void; chat: SharedChat | null; shared: SharedChats; onLeft: () => void }) {
  const { state, memberName, toast } = useMaple();
  const me = state?.me.email ?? "";
  const members = useMemo(() => state?.members ?? [], [state?.members]);
  const addable = useMemo(() => (chat ? shareablePeople(members, me).filter((m) => !chat.people.includes(m.email)) : []), [chat, members, me]);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setAdding(false);
      setPicked([]);
      setConfirmLeave(false);
    }
  }, [open]);
  if (!chat) return null;
  const name = sharedChatName(chat, me, memberName);
  const add = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    try {
      await shared.add(chat.id, picked);
      toast(picked.length === 1 ? `${memberName(picked[0])} is in the chat now` : "They're in the chat now");
      setAdding(false);
      setPicked([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't add them", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const leave = async () => {
    setBusy(true);
    try {
      await shared.leave(chat.id);
      toast(`You left ${name}`);
      onLeft();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't leave the chat", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} locked={busy} dirty={adding && !!picked.length} onClose={onClose} title={name} subtitle="Shared chat">
      <div className="space-y-4">
        <ul className="-mx-4 divide-y divide-mp-line">
          {chat.people.map((p) => (
            <li key={p} className="flex min-h-[56px] items-center gap-3 px-4 py-2">
              <Avatar member={members.find((m) => m.email === p) ?? null} size={36} />
              <span className={cx(tone.body, "min-w-0 flex-1 truncate text-[15px] font-medium")}>
                {memberName(p)}
                {p === me && <span className={cx(tone.muted, "ml-1.5 font-normal")}>(you)</span>}
              </span>
              {p === chat.createdBy && <span className={cx(tone.muted, "shrink-0 text-[12px]")}>Started it</span>}
            </li>
          ))}
        </ul>
        {adding ? (
          <div className="space-y-3">
            <PeoplePicker legend="People to add" people={addable} picked={picked} onChange={setPicked} disabled={busy} />
            <p className={cx(tone.faint, "text-[13px] leading-snug")}>They&apos;ll read everything said here so far.</p>
            <div className="flex gap-2">
              <Button className="flex-1" disabled={!picked.length || busy} onClick={() => void add()}>
                {busy ? "Adding…" : "Add to chat"}
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          addable.length > 0 && (
            <Button variant="soft" className="w-full" onClick={() => setAdding(true)}>
              <Icon name="plus" size={18} />
              Add people
            </Button>
          )
        )}
        {!confirmLeave ? (
          <Button variant="danger" size="sm" className="w-full" onClick={() => setConfirmLeave(true)}>
            Leave this chat
          </Button>
        ) : (
          <div className="space-y-2">
            <p className={cx(tone.body, "text-sm leading-snug")}>
              Leave {name}? It&apos;s gone from your chats. What you wrote stays for everyone still in it, and the last person to leave
              deletes it.
            </p>
            <div className="flex gap-2">
              <Button variant="danger" size="sm" className="flex-1" disabled={busy} onClick={() => void leave()}>
                Leave
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmLeave(false)}>
                Stay
              </Button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

import { randomUUID } from "node:crypto";
import { query, transaction } from "@/lib/db";
import { careLevelOf, partLevelOf, PARTS, type Parts, type PartLevel } from "../access";
import { ACCEPTED_MEMBERSHIP, type FamilyScope } from "../family";
import { StoreUnavailable } from "../store";
import type { Member, Role } from "../types";
import { openable, threadAccess } from "./history";
import type { ChatMessage } from "./types";
import { STREAM_PAGE, streamPage, type StreamItem } from "./window";

/**
 * Shared chats: a thread several people of one family read and post in, with
 * Maple answering, apart from each person's own chat. Its people
 * (maple_chat_people) are the only thing that opens it, never the thread's
 * `member`, which stays whoever made it. Every turn in it reads only what
 * everyone in it can see (sharedAccess): a part hidden from anyone is hidden
 * from the chat, and her page opens only when she let the chat see it and
 * each person here could read it in their own chat. Someone whose access
 * shrank below what the thread ever had open (its care_open, doctor_open and
 * moments_open, as for a person's own threads) no longer opens it, and no
 * longer counts toward what it reads. Text only: no photos (a chat image is
 * its uploader's alone). Another family's shared chat reads as none at all.
 */

type Fam = Pick<FamilyScope, "familyId">;

export const SHARED_PEOPLE_MAX = 12;
export const SHARED_NAME_MAX = 60;

/** A shared chat as its people's phones list it. `people`: member ids, its maker first. */
export type SharedChat = { id: string; name: string | null; people: string[]; createdBy: string; updatedAt: string; busy: boolean };

/** A refusal fit to show the person, with the status a route answers. */
export class SharedChatError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
  }
}

async function rows(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Record<string, unknown>[];
}

/** The SQL test that member `$n` is one of thread `t`'s people. */
export const sharedPerson = (t: string, n: string) => `EXISTS (SELECT 1 FROM maple_chat_people p WHERE p.thread_id = ${t}.id AND p.family_id = ${t}.family_id AND p.member = ${n})`;

/** Who can be in a shared chat: anyone who can use the chat (never a photos-only guest, never someone it's off for). */
export const canShareChat = (m: Pick<Member, "role" | "parts">): boolean => m.role !== "photos" && partLevelOf(m, "chat") !== "none";

/** What a shared thread ever had open (the flags its turns set, as for a person's own threads). */
export type ThreadFlags = { careOpen: boolean; doctorOpen: boolean; momentsOpen: boolean };

/**
 * This person can open a shared thread with these flags now: what it ever had
 * open is still open to them. For her page that's her page reaching their
 * chat at all: never a view-only guest's, as in their own chat. The SQL twin
 * is history.ts `openable` on a shared thread.
 */
export function opensShared(m: Pick<Member, "role" | "care" | "parts">, flags: ThreadFlags): boolean {
  const a = threadAccess(m);
  return !(flags.careOpen && (a.careHidden || a.viewer)) && !(flags.doctorOpen && a.doctorHidden) && !(flags.momentsOpen && a.momentsHidden);
}

const LEVELS: PartLevel[] = ["none", "view", "log"];
const lowest = (levels: PartLevel[]): PartLevel => LEVELS[Math.min(...levels.map((l) => LEVELS.indexOf(l)))];

/**
 * What one turn in a shared chat may read and do, for `sender`:
 *   `narrow`: the parts no lower than the least anyone here has (only hidden
 *   ever comes through: a part someone here can only see stays the sender's
 *   own level, since seeing their write is fine), applied on top of the
 *   sender's own levels, owners included;
 *   `care`: her page is open to this turn: she let the chat see it, and every
 *   person here could read it in their own chat (never a view-only guest);
 *   `people`: who counts, the people who can open the thread now (someone
 *   the chat is off for, or made a photos-only guest, reads none of it, so
 *   doesn't count either).
 */
export function sharedAccess(
  sender: Member,
  people: Member[],
  flags: ThreadFlags,
  opts: { herConsent: boolean; carePerson: string | null }
): { narrow: Parts; care: boolean; people: Member[] } {
  const counted = people.filter((p) => p.email === sender.email || (canShareChat(p) && opensShared(p, flags)));
  if (!counted.some((p) => p.email === sender.email)) counted.push(sender);
  const narrow: Parts = {};
  for (const part of PARTS) {
    if (part === "chat") continue;
    if (lowest(counted.map((p) => partLevelOf(p, part))) === "none") narrow[part] = "none";
  }
  const reads = (p: Member) => p.role !== "viewer" && p.role !== "photos" && (p.email === opts.carePerson || careLevelOf(p) !== "none");
  return { narrow, care: opts.herConsent && counted.every(reads), people: counted };
}

function rowToChat(r: Record<string, unknown>): SharedChat {
  const people = Array.isArray(r.people) ? (r.people as unknown[]).map(String) : [];
  const createdBy = String(r.created_by);
  return {
    id: String(r.id),
    name: r.title == null ? null : String(r.title),
    // Its maker first while they're in it, then everyone in the order they came.
    people: [...people.filter((p) => p === createdBy), ...people.filter((p) => p !== createdBy)],
    createdBy,
    updatedAt: new Date(String(r.last_at ?? r.updated_at)).toISOString(),
    busy: r.busy === true,
  };
}

const CHAT_COLS = `t.id, t.title, t.member AS created_by, t.updated_at, COALESCE(t.busy_until > NOW(), FALSE) AS busy,
  (SELECT array_agg(q.member ORDER BY q.added_at, q.member) FROM maple_chat_people q WHERE q.thread_id = t.id AND q.family_id = t.family_id) AS people,
  (SELECT MAX(m.created_at) FROM maple_chat_messages m WHERE m.thread_id = t.id AND m.family_id = t.family_id) AS last_at`;

/** The params openable() reads for this member, from $3: viewer, careHidden, doctorHidden, momentsHidden. */
function accessParams(member: Pick<Member, "role" | "care" | "parts">): boolean[] {
  const a = threadAccess(member);
  return [a.viewer, a.careHidden, !!a.doctorHidden, !!a.momentsHidden];
}

/** This member's shared chats in this family, newest first: those they're in and can open now. */
export async function listSharedChats(fam: Fam, member: Member): Promise<SharedChat[]> {
  const r = await rows(
    `SELECT ${CHAT_COLS} FROM maple_chat_threads t
     WHERE t.family_id = $1 AND t.shared AND ${sharedPerson("t", "$2")} AND ${openable("t", "$3", "$4", "$5", "$6")}
     ORDER BY COALESCE((SELECT MAX(m.created_at) FROM maple_chat_messages m WHERE m.thread_id = t.id AND m.family_id = t.family_id), t.created_at) DESC
     LIMIT 50`,
    [fam.familyId, member.email, ...accessParams(member)]
  );
  return r.map(rowToChat);
}

/** One shared chat this member is in and can open now, else null (another family's, or not theirs, reads the same). */
export async function getSharedChat(fam: Fam, id: string, member: Member): Promise<SharedChat | null> {
  const r = await rows(
    `SELECT ${CHAT_COLS} FROM maple_chat_threads t
     WHERE t.family_id = $1 AND t.id = $7 AND t.shared AND ${sharedPerson("t", "$2")} AND ${openable("t", "$3", "$4", "$5", "$6")}`,
    [fam.familyId, member.email, ...accessParams(member), id]
  );
  return r.length ? rowToChat(r[0]) : null;
}

/** A thread's shared facts, for a turn: whether it's shared, its people and what it ever had open; null when there's no such thread here. */
export async function sharedThread(fam: Fam, id: string): Promise<{ shared: boolean; people: string[]; flags: ThreadFlags } | null> {
  const r = await rows(
    `SELECT t.shared, t.care_open, t.doctor_open, t.moments_open,
       (SELECT array_agg(q.member) FROM maple_chat_people q WHERE q.thread_id = t.id AND q.family_id = t.family_id) AS people
     FROM maple_chat_threads t WHERE t.family_id = $1 AND t.id = $2`,
    [fam.familyId, id]
  );
  if (!r.length) return null;
  return {
    shared: r[0].shared === true,
    people: Array.isArray(r[0].people) ? (r[0].people as unknown[]).map(String) : [],
    flags: { careOpen: r[0].care_open !== false, doctorOpen: r[0].doctor_open !== false, momentsOpen: r[0].moments_open !== false },
  };
}

/** The people a request names, checked: real ids, nobody twice, never the caller, and each one able to be in a shared chat. */
function checkPeople(raw: unknown, caller: string, members: Member[]): Member[] {
  if (!Array.isArray(raw) || !raw.length) throw new SharedChatError("Choose who's in the chat.");
  const ids = [...new Set(raw.map((x) => (typeof x === "string" ? x.trim() : "")))].filter((x) => x && x !== caller);
  if (!ids.length) throw new SharedChatError("Choose at least one other person.");
  return ids.map((id) => {
    const m = members.find((x) => x.email === id);
    if (!m) throw new SharedChatError("That person isn't in this family's log.");
    if (!canShareChat(m)) throw new SharedChatError(`${m.display_name ?? "They"} can't use the chat, so they can't be in a shared one.`);
    return m;
  });
}

/** Accepted members of this family only (a membership nobody took up opens nothing, and so can't be added). */
async function accepted(fam: Fam, ids: string[]): Promise<Set<string>> {
  const r = await rows(`SELECT m.email FROM maple_members m WHERE m.family_id = $1 AND m.email = ANY($2::text[]) AND ${ACCEPTED_MEMBERSHIP("m")}`, [fam.familyId, ids]);
  return new Set(r.map((x) => String(x.email)));
}

export function cleanName(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new SharedChatError("The chat's name must be text.");
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length > SHARED_NAME_MAX) throw new SharedChatError(`Keep the name under ${SHARED_NAME_MAX} characters.`);
  return name || null;
}

/**
 * Starts a shared chat with the people a member picked (everyone in the
 * family who can use the chat, never a photos-only guest or someone it's off
 * for), named or not. Nothing is open in it until its first turn.
 */
export async function createSharedChat(fam: Fam, creator: Member, opts: { people: unknown; name?: unknown; model: string; members: Member[] }): Promise<SharedChat> {
  if (!canShareChat(creator)) throw new SharedChatError("The chat is off for you.", 403);
  const people = checkPeople(opts.people, creator.email, opts.members);
  if (people.length + 1 > SHARED_PEOPLE_MAX) throw new SharedChatError(`A shared chat holds up to ${SHARED_PEOPLE_MAX} people.`);
  const ok = await accepted(fam, people.map((p) => p.email));
  const missing = people.find((p) => !ok.has(p.email));
  if (missing) throw new SharedChatError(`${missing.display_name ?? "That person"} hasn't joined the log yet.`);
  const name = cleanName(opts.name);
  const id = randomUUID();
  const result = await transaction([
    {
      sql: `INSERT INTO maple_chat_threads (family_id, id, member, title, model, shared, viewer_only, care_open, doctor_open, moments_open)
            VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, FALSE, FALSE, FALSE)`,
      params: [fam.familyId, id, creator.email, name, opts.model],
    },
    {
      sql: `INSERT INTO maple_chat_people (family_id, thread_id, member, added_by) SELECT $1, $2, x, $3 FROM unnest($4::text[]) AS x`,
      params: [fam.familyId, id, creator.email, [creator.email, ...people.map((p) => p.email)]],
    },
  ]);
  if (result === null) throw new StoreUnavailable();
  const chat = await getSharedChat(fam, id, creator);
  if (!chat) throw new StoreUnavailable();
  return chat;
}

/**
 * Adds people to a shared chat one of its people is in. Each must be able to
 * open it as it is (what it ever had open still open to them), since they'll
 * read everything said in it so far.
 */
export async function addSharedPeople(fam: Fam, actor: Member, id: string, opts: { people: unknown; members: Member[] }): Promise<SharedChat> {
  const chat = await getSharedChat(fam, id, actor);
  if (!chat) throw new SharedChatError("That shared chat isn't here.", 404);
  const people = checkPeople(opts.people, actor.email, opts.members).filter((p) => !chat.people.includes(p.email));
  if (!people.length) throw new SharedChatError("They're already in this chat.");
  if (chat.people.length + people.length > SHARED_PEOPLE_MAX) throw new SharedChatError(`A shared chat holds up to ${SHARED_PEOPLE_MAX} people.`);
  const facts = await sharedThread(fam, id);
  if (!facts) throw new SharedChatError("That shared chat isn't here.", 404);
  const blocked = people.find((p) => !opensShared(p, facts.flags));
  if (blocked) throw new SharedChatError(`This chat has already talked about things ${blocked.display_name ?? "they"} can't see, so they can't join it. Start a new shared chat with them instead.`, 409);
  const ok = await accepted(fam, people.map((p) => p.email));
  const missing = people.find((p) => !ok.has(p.email));
  if (missing) throw new SharedChatError(`${missing.display_name ?? "That person"} hasn't joined the log yet.`);
  await rows(
    `INSERT INTO maple_chat_people (family_id, thread_id, member, added_by) SELECT $1, $2, x, $3 FROM unnest($4::text[]) AS x
     WHERE EXISTS (SELECT 1 FROM maple_chat_threads t WHERE t.id = $2 AND t.family_id = $1 AND t.shared)
     ON CONFLICT (thread_id, member) DO NOTHING`,
    [fam.familyId, id, actor.email, people.map((p) => p.email)]
  );
  const after = await getSharedChat(fam, id, actor);
  if (!after) throw new SharedChatError("That shared chat isn't here.", 404);
  return after;
}

/** Deletes shared threads nobody is in anymore, keeping only their delivery receipts' bare rows (as deleting a chat does). */
const EMPTY_SHARED = (fam: string) => `WITH empty AS (
    SELECT t.id FROM maple_chat_threads t WHERE t.family_id = ${fam} AND t.shared
      AND NOT EXISTS (SELECT 1 FROM maple_chat_people p WHERE p.thread_id = t.id AND p.family_id = t.family_id)
  ), detached AS (
    UPDATE maple_chat_deliveries SET thread_id = NULL WHERE family_id = ${fam} AND thread_id IN (SELECT id FROM empty)
  ) DELETE FROM maple_chat_threads t WHERE t.family_id = ${fam} AND t.id IN (SELECT id FROM empty)`;

/**
 * Leaves one shared chat: it's gone from this person's list, and what they
 * wrote in it stays for everyone still in it. The last one out deletes it.
 */
export async function leaveSharedChat(fam: Fam, member: Member, id: string): Promise<void> {
  const left = await rows(`DELETE FROM maple_chat_people p WHERE p.family_id = $1 AND p.thread_id = $2 AND p.member = $3 RETURNING p.member`, [fam.familyId, id, member.email]);
  if (!left.length) throw new SharedChatError("That shared chat isn't here.", 404);
  await rows(EMPTY_SHARED("$1"), [fam.familyId]);
}

/** Takes someone out of every shared chat in this family (removed, or leaving the family); chats nobody is left in go. */
export async function dropFromSharedChats(fam: Fam, member: string): Promise<void> {
  await rows(`DELETE FROM maple_chat_people WHERE family_id = $1 AND member = $2`, [fam.familyId, member]);
  await rows(EMPTY_SHARED("$1"), [fam.familyId]);
}

/** One shared chat's messages, a page at a time as the phone reads them, each with who sent it (`by`). */
export async function sharedStream(fam: Fam, id: string, member: Member, before: string | null, size = STREAM_PAGE): Promise<{ current: { id: string; busy: boolean } | null; items: (StreamItem & { by: string })[]; more: boolean }> {
  const chat = await getSharedChat(fam, id, member);
  if (!chat) throw new SharedChatError("That shared chat isn't here.", 404);
  const page = await rows(
    `SELECT m.id, m.role, m.parts, m.member FROM maple_chat_messages m
     WHERE m.family_id = $1 AND m.thread_id = $2
       AND ($3::text IS NULL OR m.seq < (SELECT c.seq FROM maple_chat_messages c WHERE c.id = $3 AND c.family_id = $1 AND c.thread_id = $2))
     ORDER BY m.seq DESC LIMIT $4`,
    [fam.familyId, id, before, size + 1]
  );
  const by = new Map(page.map((m) => [String(m.id), String(m.member)]));
  const { items, more } = streamPage(
    page.map((m) => ({ thread: id, message: { id: String(m.id), role: m.role as "user" | "assistant", parts: Array.isArray(m.parts) ? (m.parts as ChatMessage["parts"]) : [] } })),
    size
  );
  return { current: { id, busy: chat.busy }, items: items.map((i) => ({ ...i, by: by.get(i.message.id) ?? "" })), more };
}

/** Who sent the newest message in a thread (the turn whose cards wait for an answer), or null in an empty one. */
export async function lastSender(fam: Fam, id: string): Promise<string | null> {
  const r = await rows(`SELECT member FROM maple_chat_messages WHERE family_id = $1 AND thread_id = $2 AND role = 'user' ORDER BY seq DESC LIMIT 1`, [fam.familyId, id]);
  return r.length ? String(r[0].member) : null;
}

/** A role's word in a shared chat's prompt line ("Sam (view only)"). */
export const shareRoleWord = (role: Role): string => (role === "viewer" ? " (view only)" : "");

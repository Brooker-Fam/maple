import type { Role } from "./types";

/**
 * How far one person reaches into her page (the care person's medicines and
 * doses, food and drinks, temperatures and questions for her OB), set per
 * person by an owner, apart from their role on the baby's log:
 *   "none": hidden, as for view-only and photos-only guests by default;
 *   "view": read only: no check-ins, therapist, Only me rows, settings or changes;
 *   "log":  everything, as for owners and members by default.
 *
 * Stored on maple_members.care_access (and maple_invites.care_access, for the
 * membership an invite makes). NULL takes the role's default, and only a
 * level that differs from it is stored, so the role's default comes back when
 * an owner picks it again. A stored level stays through role changes; the
 * role caps it (careLevelOf). careAccess() in care.ts is the one place it opens
 * anything. Client-safe: People settings and the chat's cards read it too.
 */

export const CARE_LEVELS = ["none", "view", "log"] as const;
export type CareLevel = (typeof CARE_LEVELS)[number];

export const parseCareLevel = (raw: unknown): CareLevel | null => (raw === "none" || raw === "view" || raw === "log" ? raw : null);

/** What a role reaches with nothing set: owners and members log on her page; view-only and photos-only guests don't see it. */
export function roleCareLevel(role: Role): CareLevel {
  return role === "owner" || role === "member" ? "log" : "none";
}

/** The most a role can be given: owners always log, view-only guests at most read, photos-only guests never see it. */
export function maxCareLevel(role: Role): CareLevel {
  return role === "photos" ? "none" : role === "viewer" ? "view" : "log";
}

const RANK: Record<CareLevel, number> = { none: 0, view: 1, log: 2 };

/** The level in force for a member: their stored level (else the role's default), capped by the role. */
export function careLevelOf(m: { role: Role; care?: CareLevel | null }): CareLevel {
  if (m.role === "owner") return "log";
  const want = m.care ?? roleCareLevel(m.role);
  const max = maxCareLevel(m.role);
  return RANK[want] > RANK[max] ? max : want;
}

/** What to store for an owner's choice: null when it's the role's own default (or the role can't be given anything else). */
export function storedCareLevel(role: Role, level: CareLevel): CareLevel | null {
  if (role === "owner" || role === "photos") return null;
  return level === roleCareLevel(role) ? null : level;
}

/** Why an owner can't give this role this level, or null when it fits. */
export function careLevelProblem(role: Role, level: CareLevel): string | null {
  if (RANK[level] <= RANK[maxCareLevel(role)]) return null;
  if (role === "photos") return "Photos-only guests never see mom's page. Give them view-only or log access to the baby's log first.";
  return "View-only guests can at most see mom's page. Let them log the baby's log too, or give her page view access.";
}

// ── Parts: what an owner can turn down for one person, apart from the role ──

/**
 * Parts of the app an owner can turn down for one person, below what their
 * role gives (the role is always the most a part opens):
 *   "doctor":  the questions for the pediatrician (notes marked for the
 *              doctor), their answers, and the checkup summary's questions;
 *   "moments": moments and their photos;
 *   "chat":    Maple's in-app chat ("view": it only reads for them).
 * Each takes the same three levels as her page: "none" (hidden), "view"
 * (read only) and "log" (everything the role allows).
 *
 * Stored on maple_members.parts (and maple_invites.parts, for the membership
 * an invite makes) as JSONB, e.g. {"doctor":"none"}. Only a level below the
 * role's is stored, so NULL (or a part left out) is the role's own, and the
 * role's own comes back when an owner picks it again. A stored level stays
 * through role changes; the role caps it (partLevelOf). Releases from before
 * this column give every member and viewer all of each part, so roll forward.
 *
 * Every read and write of these parts goes through partLevelOf: the store
 * leaves hidden entries out of a member's reads (unseenSql in store.ts) and
 * refuses writes beyond their level (PartForbidden), the chat and MCP tools
 * leave out what a level doesn't reach, and the app hides what's left.
 * Client-safe, like the rest of this file.
 */

export const PARTS = ["doctor", "moments", "chat"] as const;
export type Part = (typeof PARTS)[number];
/** A part's level: the same three as her page. */
export type PartLevel = CareLevel;
/** The levels an owner set below a person's role, by part; a part left out is the role's own. */
export type Parts = Partial<Record<Part, PartLevel>>;

export const isPart = (raw: unknown): raw is Part => raw === "doctor" || raw === "moments" || raw === "chat";

/** The most a role gives a part, which is also what it gives with nothing set: photos-only guests see shared moments and nothing else. */
export function rolePartLevel(role: Role, part: Part): PartLevel {
  if (role === "owner" || role === "member") return "log";
  if (role === "viewer") return "view";
  return part === "moments" ? "view" : "none";
}

/** The least a role can be turned down to: photos-only guests always keep their shared moments (they'd have nothing left). */
export function minPartLevel(role: Role, part: Part): PartLevel {
  return role === "photos" && part === "moments" ? "view" : role === "owner" ? "log" : "none";
}

/** The level in force for a person: their stored level when it's lower, else the role's; never above the role's, never below its least. */
export function partLevelOf(m: { role: Role; parts?: Parts | null }, part: Part): PartLevel {
  const max = rolePartLevel(m.role, part);
  if (m.role === "owner") return max;
  const want = m.parts?.[part];
  if (!want || RANK[want] >= RANK[max]) return max;
  const min = minPartLevel(m.role, part);
  return RANK[want] < RANK[min] ? min : want;
}

/**
 * A part's level for one conversation: the person's own, lowered to
 * `narrow` where that's less. A shared chat narrows each turn to the least
 * anyone in it has (chat/shared.ts), owners included, since everyone in it
 * reads the answer.
 */
export function partLevelIn(m: { role: Role; parts?: Parts | null }, part: Part, narrow?: Parts | null): PartLevel {
  const own = partLevelOf(m, part);
  const cap = narrow?.[part];
  return cap && RANK[cap] < RANK[own] ? cap : own;
}

/** `level` reaches at least `need` (none < view < log). */
export const atLeast = (level: PartLevel, need: PartLevel): boolean => RANK[level] >= RANK[need];

/** The levels an owner can pick for this role's part, least first; one choice (or none) means there's nothing to choose. */
export function partChoices(role: Role, part: Part): PartLevel[] {
  const lo = RANK[minPartLevel(role, part)];
  const hi = RANK[rolePartLevel(role, part)];
  return CARE_LEVELS.filter((l) => RANK[l] >= lo && RANK[l] <= hi);
}

/** Stored parts from whatever a row or a request holds: known parts and levels only; null when there's nothing. */
export function parseParts(raw: unknown): Parts | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Parts = {};
  for (const part of PARTS) {
    const level = parseCareLevel((v as Record<string, unknown>)[part]);
    if (level) out[part] = level;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A change to someone's parts, as a request or a tool sends it: each part
 * named with its level, or null to put the role's own back. Null when it
 * isn't one (an unknown part or level); an empty change is {}.
 */
export type PartsChange = Partial<Record<Part, PartLevel | null>>;

export function parsePartsChange(raw: unknown): PartsChange | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: PartsChange = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPart(key)) return null;
    if (value === null) out[key] = null;
    else {
      const level = parseCareLevel(value);
      if (!level) return null;
      out[key] = level;
    }
  }
  return out;
}

/**
 * Stored parts after a change, under this role: each part changed is stored
 * only below the role's own (otherwise it's dropped, so the role's own comes
 * back); the parts left alone stay as they are, as they do through a role
 * change. Null when nothing is left stored.
 */
export function applyPartsChange(role: Role, current: Parts | null | undefined, change: PartsChange): Parts | null {
  if (role === "owner") return null;
  const out: Parts = { ...(current ?? {}) };
  for (const part of PARTS) {
    if (!(part in change)) continue;
    const level = change[part];
    if (level && RANK[level] < RANK[rolePartLevel(role, part)]) out[part] = level;
    else delete out[part];
  }
  return Object.keys(out).length ? out : null;
}

/** What to store for these levels under this role: only the parts turned down below the role's own; null when none are (or for an owner). */
export function storedParts(role: Role, parts: Parts | null | undefined): Parts | null {
  if (!parts || role === "owner") return null;
  const out: Parts = {};
  for (const part of PARTS) {
    const level = parts[part];
    if (level && RANK[level] < RANK[rolePartLevel(role, part)]) out[part] = level;
  }
  return Object.keys(out).length ? out : null;
}

/** Why an owner can't give this role this level of a part, or null when it fits. */
export function partLevelProblem(role: Role, part: Part, level: PartLevel): string | null {
  const name = PART_NAME[part];
  if (role === "owner") return level === "log" ? null : "Owners always have everything.";
  if (RANK[level] < RANK[minPartLevel(role, part)]) return "Photos-only guests always see the shared moments. Remove them instead, or give them more access first.";
  if (RANK[level] <= RANK[rolePartLevel(role, part)]) return null;
  if (role === "photos") return `Photos-only guests only see shared moments. Give them view-only or log access to the baby's log first to open ${name}.`;
  return `View-only guests can at most see ${name}. Let them log the baby's log too to give them more.`;
}

/** Each part's name in a sentence ("the questions for the doctor"), and as a heading. */
export const PART_NAME: Record<Part, string> = { doctor: "the questions for the doctor", moments: "moments and photos", chat: "the chat" };
export const PART_LABEL: Record<Part, string> = { doctor: "Questions for the doctor", moments: "Moments and photos", chat: "Chat" };

/** A part's levels as People settings and the chat's cards say them. */
export const PART_LEVEL_LABEL: Record<Part, Record<PartLevel, string>> = {
  doctor: { none: "Hidden", view: "Can view", log: "Can add" },
  moments: { none: "Hidden", view: "Can view", log: "Can add" },
  chat: { none: "Off", view: "Reads only", log: "Can log" },
};

/** The parts turned down for this person, as "Questions for the doctor: hidden" lines; empty when every part is the role's own. */
export function partLines(m: { role: Role; parts?: Parts | null }): string[] {
  if (m.role === "owner" || m.role === "photos" || !m.parts) return [];
  return PARTS.filter((part) => partLevelOf(m, part) !== rolePartLevel(m.role, part)).map(
    (part) => `${PART_LABEL[part]}: ${PART_LEVEL_LABEL[part][partLevelOf(m, part)].toLowerCase()}`
  );
}

/**
 * The part an entry of the baby's log belongs to when it's one an owner can
 * hide: a question for the doctor (a note marked for the doctor) or a moment.
 * Everything else is the baby's log itself, which the role decides.
 */
export function entryPart(e: { kind: string; data?: unknown }): Part | null {
  if (e.kind === "moment") return "moments";
  if (e.kind === "note" && (e.data as { for_doctor?: unknown } | null | undefined)?.for_doctor === true) return "doctor";
  return null;
}

/** This person can read the entry: it's in no part, or in one that isn't hidden from them. */
export function seesEntry(m: { role: Role; parts?: Parts | null }, e: { kind: string; data?: unknown }): boolean {
  const part = entryPart(e);
  return !part || partLevelOf(m, part) !== "none";
}

/** This person can change the entry (as far as its part goes): it's in no part, or in one they can add to. */
export function writesEntry(m: { role: Role; parts?: Parts | null }, e: { kind: string; data?: unknown }): boolean {
  const part = entryPart(e);
  return !part || partLevelOf(m, part) === "log";
}

/**
 * A write this person's levels refuse: adding, changing, removing or putting
 * back a question for the doctor or a moment they can only see (or can't). The
 * store throws it; the routes answer 403 and the tools say it as it is.
 */
export class PartForbidden extends Error {
  constructor(readonly part: Part, readonly level: PartLevel) {
    super(partForbiddenCopy(part, level));
  }
}

export function partForbiddenCopy(part: Part, level: PartLevel): string {
  const ask = "Ask an owner of this log if you'd like to.";
  if (part === "doctor") return level === "view" ? `You can see the questions for the doctor but not add or change them. ${ask}` : `The questions for the doctor aren't shared with you. ${ask}`;
  if (part === "moments") return level === "view" ? `You can see moments but not add or change them. ${ask}` : `Moments aren't shared with you. ${ask}`;
  return level === "view" ? `The chat only reads the log for you, so it can't log or change anything. ${ask}` : `The chat is off for you. ${ask}`;
}

/** The roles an owner hands out, as the chat, the MCP and People settings name them. */
export const ACCESS_ROLES = ["member", "viewer", "photos"] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

/** "log" / "view" / "photos": the words the people tools use for a role on the baby's log. */
export const ACCESS_WORD: Record<Role, string> = { owner: "owner", member: "log", viewer: "view", photos: "photos" };
export const ROLE_FROM_WORD: Record<string, AccessRole> = { log: "member", view: "viewer", photos: "photos" };

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", member: "Can log", viewer: "View only", photos: "Photos only" };

/** Her page's level, as People settings and the chat's cards say it. */
export const CARE_LEVEL_LABEL: Record<CareLevel, string> = { none: "Hidden", view: "Can view", log: "Can view and add" };

/**
 * "Can log · Dana's page: hidden": a person's access in one line. `page` is
 * her page's name ("Dana's page"), or null where the family has none. Her
 * page is named only when a level other than the role's default is set.
 */
export function accessLine(m: { role: Role; care?: CareLevel | null; parts?: Parts | null }, page: string | null): string {
  const role = m.role === "owner" ? "Owner · can invite and manage" : ROLE_LABEL[m.role];
  // The parts turned down below the role's own ("Questions for the doctor: hidden"), after her page.
  const parts = partLines(m);
  if (!page || m.care == null || m.role === "owner" || m.role === "photos") return [role, ...parts].join(" · ");
  return [role, `${page}: ${CARE_LEVEL_LABEL[careLevelOf(m)].toLowerCase()}`, ...parts].join(" · ");
}

/** A person as the people tools find them: by id (their email for most), or by a name only one person has (a first name counts). */
export type PersonMatch<T> = { found: T } | { ambiguous: T[] } | { missing: true };

export function matchPerson<T extends { id: string; name: string }>(query: string, people: T[]): PersonMatch<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { missing: true };
  const byId = people.find((p) => p.id.toLowerCase() === q);
  if (byId) return { found: byId };
  const named = people.filter((p) => {
    const name = p.name.trim().toLowerCase();
    return name === q || name.split(/\s+/)[0] === q;
  });
  if (named.length === 1) return { found: named[0] };
  if (named.length > 1) return { ambiguous: named };
  return { missing: true };
}

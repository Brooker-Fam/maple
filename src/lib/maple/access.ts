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
export function accessLine(m: { role: Role; care?: CareLevel | null }, page: string | null): string {
  const role = m.role === "owner" ? "Owner · can invite and manage" : ROLE_LABEL[m.role];
  if (!page || m.care == null || m.role === "owner" || m.role === "photos") return role;
  return `${role} · ${page}: ${CARE_LEVEL_LABEL[careLevelOf(m)].toLowerCase()}`;
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

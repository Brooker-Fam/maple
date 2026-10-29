import type { FamilyScope } from "./family";
import type { FamilyInfo, Member } from "./types";

/**
 * Who a view-only guest asks to change something: the owners by first name
 * ("Avery or Blake"), in the order they joined, else "an owner".
 */
export function ownersToAsk(members: readonly Member[]): string {
  const names = members
    .filter((m) => m.role === "owner" && m.email !== "admin")
    .map((m) => (m.display_name?.trim() || m.email.split("@")[0]).split(/\s+/)[0]);
  if (!names.length) return "an owner";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** What the app learns about its family (MapleState.family), using its current owners. */
export function familyInfo(fam: Pick<FamilyScope, "familyId">, members: readonly Member[]): FamilyInfo {
  return { id: fam.familyId, ask: ownersToAsk(members) };
}

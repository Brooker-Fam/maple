import { query } from "@/lib/db";
import { isClock } from "./goals";
import type { RosterGoals } from "./roster";
import type { RosterWindow } from "./types";

/**
 * The night roster's one read for notifications and Siri: the active sleep
 * goals' protected windows for a family's baby, and nothing else of the
 * goals (store.ts owns them and every write). One small query; a family
 * with no active goal (or no baby yet) reads as an empty roster.
 */
export async function activeRosters(fam: { familyId: number; babyId: number | null }): Promise<RosterGoals> {
  if (fam.babyId == null) return [];
  const rows = await query(`SELECT roster FROM maple_sleep_goals WHERE family_id = $1 AND baby_id = $2 AND status = 'active' AND deleted_at IS NULL`, [fam.familyId, fam.babyId]);
  if (rows === null) throw new Error("No database");
  return rows.map((r) => ({ status: "active" as const, roster: rosterOf((r as { roster?: unknown }).roster) })).filter((g) => g.roster.length);
}

/** A stored roster's windows (who, from, to and the nights they begin on), read past anything this release doesn't know. */
function rosterOf(v: unknown): RosterWindow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): RosterWindow[] => {
    const w = x as Partial<RosterWindow> | null;
    if (!w || typeof w !== "object" || typeof w.member !== "string" || !isClock(w.from) || !isClock(w.to) || !Array.isArray(w.nights)) return [];
    return [{ id: String(w.id ?? ""), member: w.member, from: w.from, to: w.to, nights: w.nights.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6) }];
  });
}

import { query } from "@/lib/db";
import { isDayKey } from "../time";
import { isClock } from "./goals";
import type { RosterGoals } from "./roster";
import { WINDOW_COVERS, type GoalTemplate, type RosterWindow, type WindowCovers } from "./types";

/**
 * The night roster's one read for notifications and Siri: the active sleep
 * goals' protected windows for a family's baby (with how each window's feeds
 * are covered), and who nurses when a goal's template says, and nothing else
 * of the goals (store.ts owns them and every write). One small query; a
 * family with no active goal (or no baby yet) reads as an empty roster.
 */
export async function activeRosters(fam: { familyId: number; babyId: number | null }): Promise<RosterGoals> {
  if (fam.babyId == null) return [];
  const rows = await query(`SELECT roster, template FROM maple_sleep_goals WHERE family_id = $1 AND baby_id = $2 AND status = 'active' AND deleted_at IS NULL`, [fam.familyId, fam.babyId]);
  if (rows === null) throw new Error("No database");
  return rows
    .map((r) => {
      const row = r as { roster?: unknown; template?: unknown };
      return { status: "active" as const, roster: rosterOf(row.roster), template: templateOf(row.template) };
    })
    .filter((g) => g.roster.length);
}

/** A stored roster's windows (who, from, to, the nights they begin on, and their feeds' cover), read past anything this release doesn't know. */
function rosterOf(v: unknown): RosterWindow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): RosterWindow[] => {
    const w = x as Partial<RosterWindow> | null;
    if (!w || typeof w !== "object" || typeof w.member !== "string" || !isClock(w.from) || !isClock(w.to) || !Array.isArray(w.nights)) return [];
    const covers = (WINDOW_COVERS as readonly unknown[]).includes(w.covers) ? (w.covers as WindowCovers) : undefined;
    return [{ id: String(w.id ?? ""), member: w.member, from: w.from, to: w.to, nights: w.nights.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6), ...(covers ? { covers } : {}) }];
  });
}

/**
 * Who nurses (the catch-up's feeding line) and the night the roster starts (`roster_from`: before it, its windows
 * protect no one yet): a template without a kind or member reads as none.
 */
function templateOf(v: unknown): GoalTemplate | null {
  const t = v as Partial<GoalTemplate> | null;
  if (!t || typeof t !== "object" || typeof t.kind !== "string" || typeof t.member !== "string" || typeof t.date !== "string") return null;
  return { kind: t.kind as GoalTemplate["kind"], member: t.member, date: t.date, nursing: typeof t.nursing === "string" ? t.nursing : null, ...(isDayKey(t.roster_from) ? { roster_from: t.roster_from } : {}) };
}

import { createHash, createHmac } from "node:crypto";
import { query } from "@/lib/db";
import { familyInfo } from "./family-info";
import { StoreUnavailable, toClientEntry } from "./store";
import type { FamilyCtx } from "./family";
import type { Baby, Entry, MapleState, Member } from "./types";

function authorId(ctx: FamilyCtx, id: string | null): string | null {
  if (!id || id === ctx.member) return id;
  const secret = process.env.MAPLE_SESSION_SECRET?.trim() || process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new StoreUnavailable();
  return `person:${createHmac("sha256", secret).update(`photo-author:${ctx.familyId}:${id}`).digest("hex").slice(0, 24)}`;
}

export function membersForReader(ctx: FamilyCtx, members: Member[]): Member[] {
  if (ctx.role !== "photos") return members;
  return members.map((member) => ({ ...member, email: authorId(ctx, member.email)! }));
}

export function entryForReader(ctx: FamilyCtx, entry: Entry): Entry {
  const safe = toClientEntry(entry);
  if (ctx.role !== "photos") return safe;
  return { ...safe, created_by: authorId(ctx, safe.created_by), updated_by: authorId(ctx, safe.updated_by) };
}

function photoBaby(baby: Baby): Baby {
  return {
    id: baby.id, name: baby.name, nickname: baby.nickname, born_at: baby.born_at,
    timezone: baby.timezone, sex: null, due_date: null, birth_weight_g: null,
    birth_length_cm: null, birth_head_cm: null, settings: {},
  };
}

export async function photoState(ctx: FamilyCtx, me: Member, baby: Baby, members: Member[], now: Date): Promise<MapleState> {
  const rows = await query(`SELECT COALESCE(MAX(updated_at)::text, '') || '/' || COUNT(*) AS changes
    FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND kind = 'moment'`, [ctx.familyId, baby.id]);
  if (!rows) throw new StoreUnavailable();
  const profile = photoBaby(baby);
  const people = membersForReader(ctx, members);
  const revision = createHash("sha256").update(JSON.stringify([rows[0]?.changes, profile, people])).digest("hex");
  return {
    now: now.toISOString(), baby: profile, me, members: people, entries: [], growth: [],
    lifetime: { diapers: 0, feeds: 0 }, rev: `photos:${revision}`, seen_at: null,
    family: familyInfo(ctx, members),
  };
}

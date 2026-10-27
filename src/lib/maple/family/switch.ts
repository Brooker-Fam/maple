import { NextResponse, type NextRequest } from "next/server";
import { query } from "@/lib/db";
import { ADMIN_ID, sessionContext, setSessionCookies } from "../auth";
import { ACCEPTED_MEMBERSHIP, parseFamilyId } from "../family";
import type { Role } from "../types";

/**
 * The family switcher, for someone in two or more families. It lists only the
 * families the signed-in person is a member of right now, and switching
 * re-seals their session for the one they pick after checking that
 * membership again. The admin login belongs to one family and never switches.
 */

export type FamilyChoice = { familyId: number; label: string; role: Role; current: boolean; onboarding: boolean };

function labelFor(name: unknown, baby: unknown, familyId: number): string {
  if (typeof name === "string" && name.trim()) return name.trim();
  if (typeof baby === "string" && baby.trim()) return `${baby.trim()}’s family`;
  return `Family ${familyId}`;
}

export async function familyChoices(member: string, currentFamily: number): Promise<FamilyChoice[] | null> {
  const rows = await query(
    `SELECT f.id, f.name, f.status, m.role,
       (SELECT b.name FROM maple_babies b WHERE b.family_id = f.id AND b.archived_at IS NULL ORDER BY b.id LIMIT 1) AS baby
     FROM maple_members m JOIN maple_families f ON f.id = m.family_id
     WHERE m.email = $1 AND f.status <> 'deleting' AND ${ACCEPTED_MEMBERSHIP("m")}
     ORDER BY f.id`,
    [member]
  );
  if (!rows) return null;
  return rows.flatMap((r) => {
    const familyId = parseFamilyId(r.id);
    if (familyId === null) return [];
    const role: Role = r.role === "owner" || r.role === "viewer" ? r.role : "member";
    return [{ familyId, label: labelFor(r.name, r.baby, familyId), role, current: familyId === currentFamily, onboarding: r.status === "onboarding" }];
  });
}

/** GET /api/maple/signup/families: `switcher` is true only for someone in more than one family. */
export async function listFamilies(req: NextRequest): Promise<NextResponse> {
  const signedIn = await sessionContext(req);
  if (!signedIn) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const families = signedIn.member.email === ADMIN_ID ? [] : await familyChoices(signedIn.member.email, signedIn.ctx.familyId);
  if (!families) return NextResponse.json({ error: "Maple is offline for a moment." }, { status: 503 });
  const switcher = families.length > 1;
  return NextResponse.json({ switcher, families: switcher ? families : [] }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/maple/signup/families { familyId }: signs in to another of this person's families. */
export async function switchFamily(req: NextRequest): Promise<NextResponse> {
  if (req.headers.get("sec-fetch-site") === "cross-site") return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const signedIn = await sessionContext(req);
  if (!signedIn) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { familyId?: unknown } | null;
  const target = parseFamilyId(body?.familyId);
  const id = signedIn.member.email;
  if (target === null || id === ADMIN_ID) return NextResponse.json({ error: "That family isn’t one of yours." }, { status: 404 });
  const families = await familyChoices(id, signedIn.ctx.familyId);
  if (!families) return NextResponse.json({ error: "Maple is offline for a moment." }, { status: 503 });
  if (!families.some((f) => f.familyId === target)) return NextResponse.json({ error: "That family isn’t one of yours." }, { status: 404 });
  const res = NextResponse.json({ ok: true, familyId: target });
  setSessionCookies(res, id, target);
  return res;
}

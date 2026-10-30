import { query } from "@/lib/db";
import { sessionCare } from "../api";
import { readableEntryStatus } from "../care-store";
import { chatCareOpen, chatConsent } from "../consent";
import type { FamilyCtx } from "../family";
import { getBaby, NotFound, rowToEntry, StoreUnavailable, toClientEntry } from "../store";
import type { Member } from "../types";

/** Only the current family's baby or the care entries this chat may still read. */
export async function chatEntryStatus(fam: FamilyCtx, member: Member, target: "baby" | "care", id: number) {
  const consent = await chatConsent(fam, member);
  if (!consent.terms) throw new NotFound("Not found");
  if (target === "care") {
    if (!chatCareOpen(member, consent)) throw new NotFound("Not found");
    const session = await sessionCare(member, fam);
    return readableEntryStatus(session, id, { includeDeleted: true });
  }
  const baby = await getBaby(fam);
  const rows = await query("SELECT * FROM maple_entries WHERE family_id = $1 AND baby_id = $2 AND id = $3", [fam.familyId, baby.id, id]);
  if (rows == null) throw new StoreUnavailable();
  if (!rows.length) throw new NotFound("Not found");
  return { entry: toClientEntry(rowToEntry(rows[0])), deleted: rows[0].deleted_at != null };
}

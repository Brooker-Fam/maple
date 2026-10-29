/** Synthetic current-entry reads: cards never infer deletion from a bounded recent log. */
import { listMembers } from "../../src/lib/maple/auth";
import { chatEntryStatus } from "../../src/lib/maple/chat/entry-status";
import { acceptConsent, withdrawConsent } from "../../src/lib/maple/consent";
import { familyForAuth } from "../../src/lib/maple/family";
import { NotFound } from "../../src/lib/maple/store";
import type { Role } from "../../src/lib/maple/types";
import { done, eq, freshDb, ok, seedFamilies, sql, test, type FamilySeed } from "./harness";

async function actor(family: FamilySeed, role: Exclude<Role, "photos"> = "owner") {
  const fam = await familyForAuth({ sub: `maple:${family[role]}`, fam: family.familyId });
  if (!fam) throw new Error("Synthetic member missing");
  const member = (await listMembers(fam)).find((m) => m.email === family[role]);
  if (!member) throw new Error("Synthetic member missing");
  return { fam, member };
}

async function absent(run: () => Promise<unknown>) {
  let denied = false;
  try { await run(); } catch (error) { denied = error instanceof NotFound; }
  ok(denied, "unavailable or foreign entry is indistinguishable");
}

async function main() {
  await freshDb();
  const { alpha, beta } = await seedFamilies();
  const a = await actor(alpha);
  const b = await actor(beta);
  const v = await actor(alpha, "viewer");
  for (const who of [a, b, v]) await acceptConsent(who.fam, who.member.email, "chat");

  await test("current baby entry details and removal state survive reload", async () => {
    eq((await chatEntryStatus(a.fam, a.member, "baby", alpha.entries.diaper)).deleted, false);
    await sql("UPDATE maple_entries SET data = '{\"pee\":true,\"poop\":true}', deleted_at = NOW() WHERE family_id = $1 AND id = $2", [alpha.familyId, alpha.entries.diaper]);
    const result = await chatEntryStatus(a.fam, a.member, "baby", alpha.entries.diaper);
    eq(result.deleted, true);
    eq(result.entry.data, { pee: true, poop: true });
  });

  await test("foreign family IDs are unavailable and viewers can read baby cards", async () => {
    await absent(() => chatEntryStatus(b.fam, b.member, "baby", alpha.entries.feed));
    eq((await chatEntryStatus(v.fam, v.member, "baby", alpha.entries.feed)).entry.id, alpha.entries.feed);
    const photo = await chatEntryStatus(a.fam, a.member, "baby", alpha.entries.moment);
    ok(!JSON.stringify(photo).includes("made-up.jpg"), "private photo storage keys are stripped");
  });

  await test("care cards require current care consent and remain unavailable to viewers", async () => {
    const id = alpha.care!.doseId;
    await absent(() => chatEntryStatus(a.fam, a.member, "care", id));
    await acceptConsent(a.fam, alpha.care!.person, "chat_care");
    eq((await chatEntryStatus(a.fam, a.member, "care", id)).deleted, false);
    await sql("UPDATE maple_care_entries SET deleted_at = NOW() WHERE family_id = $1 AND id = $2", [alpha.familyId, id]);
    eq((await chatEntryStatus(a.fam, a.member, "care", id)).deleted, true);
    await absent(() => chatEntryStatus(v.fam, v.member, "care", id));
    await absent(() => chatEntryStatus(b.fam, b.member, "care", id));
    await withdrawConsent(a.fam, alpha.care!.person, "chat_care");
    await absent(() => chatEntryStatus(a.fam, a.member, "care", id));
  });

  await test("closed chat consent and an archived baby make old cards unavailable", async () => {
    await withdrawConsent(a.fam, a.member.email, "chat");
    await absent(() => chatEntryStatus(a.fam, a.member, "baby", alpha.entries.feed));
    await acceptConsent(a.fam, a.member.email, "chat");
    await sql("UPDATE maple_babies SET archived_at = NOW() WHERE family_id = $1 AND id = $2", [alpha.familyId, alpha.babyId]);
    await sql("INSERT INTO maple_babies (family_id, name, timezone) VALUES ($1, 'Synthetic sibling', $2)", [alpha.familyId, alpha.tz]);
    await absent(() => chatEntryStatus(a.fam, a.member, "baby", alpha.entries.feed));
  });
  done("chat-entry-status.check.ts");
}
main().catch((error) => { console.error(error instanceof Error ? error.name : "check_error"); process.exit(1); });

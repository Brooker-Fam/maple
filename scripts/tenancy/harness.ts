import { createHash, randomUUID } from "node:crypto";
import { isPglite, PGLITE_PREFIX, query, type Row } from "../../src/lib/db";
import { migrate } from "../../src/lib/migrate";
import { applyFinalShape } from "./final-shape";

/**
 * The tenancy checks' shared harness: an in-memory Postgres (PGlite, behind
 * src/lib/db.ts) built by the real migrate.ts, and two made-up families.
 * Never point it at a real database: freshDb() only ever sets a pglite: URL.
 *
 * Shapes:
 *   "production": what migrate.ts leaves (family_id DEFAULT 1, old and new keys side by side).
 *   "final": the Phase 3 contract applied too (no default, NOT NULL, new keys only), where a
 *   forgotten family_id fails with 23502 instead of landing in family 1.
 * Code must pass on both.
 */

export type Shape = "production" | "final";

let passed = 0;
let failed = 0;

export async function test(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function eq(got: unknown, want: unknown, label = ""): void {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${label ? `${label}: ` : ""}got ${a}, want ${b}`);
}

export function ok(cond: unknown, label: string): void {
  if (!cond) throw new Error(label);
}

/** Prints the tally; exits 1 on any failure. Call once at the end of a check file. */
export function done(file: string): void {
  console.log(`\n${file}: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

/** A new empty in-memory database, migrated (twice when asked), in the given shape. */
export async function freshDb(opts: { shape?: Shape; migrations?: 0 | 1 | 2 } = {}): Promise<void> {
  process.env.DATABASE_URL = `${PGLITE_PREFIX}${randomUUID()}`;
  const runs = opts.migrations ?? 1;
  for (let i = 0; i < runs; i++) await quietly(migrate);
  if ((opts.shape ?? "production") === "final") await applyFinalShape();
}

export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

/** Runs SQL on the check's database; never null (that would mean no database at all). */
export async function sql(text: string, params: unknown[] = []): Promise<Row[]> {
  if (!isPglite()) throw new Error("tenancy checks run only against a pglite: database");
  const rows = await query(text, params);
  if (!rows) throw new Error("no database");
  return rows;
}

/** The Postgres error code a statement fails with, or null when it succeeds. */
export async function sqlError(text: string, params: unknown[] = []): Promise<string | null> {
  try {
    await sql(text, params);
    return null;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? "no_code");
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ── two made-up families ─────────────────────────────────────────────

export type FamilySeed = {
  familyId: number;
  name: string;
  tz: string;
  babyId: number;
  babyName: string;
  owner: string;
  member: string;
  viewer: string;
  entries: { diaper: number; feed: number; moment: number };
  entryClientId: string;
  care: { person: string; medId: number; doseId: number; doseClientId: string } | null;
  pushSubId: number;
  pushEndpoint: string;
  receiptToken: string;
  tokenId: number;
  /** The Siri token in clear; only its hash is stored. */
  token: string;
  inviteId: number;
  inviteToken: string;
  threadId: string;
  messageId: string;
};

export type Seed = { alpha: FamilySeed; beta: FamilySeed };

type Spec = {
  familyId: number;
  name: string;
  tz: string;
  baby: { name: string; nickname: string; sex: "female" | "male"; born: string };
  people: { owner: [string, string]; member: [string, string]; viewer: [string, string] };
  care: { person: string } | null;
  ids: { med: number; dose: number };
};

const ALPHA: Spec = {
  familyId: 1,
  name: "Family Alpha",
  tz: "America/Chicago",
  baby: { name: "Juniper Test", nickname: "June", sex: "female", born: "2026-10-10T08:00:00Z" },
  people: {
    owner: ["avery.alpha@example.com", "Avery"],
    member: ["blake.alpha@example.com", "Blake"],
    viewer: ["casey.alpha@example.com", "Casey"],
  },
  care: { person: "Dana" },
  ids: { med: 10000001, dose: 10000002 },
};

const BETA: Spec = {
  familyId: 2,
  name: "Family Beta",
  tz: "America/Los_Angeles",
  baby: { name: "Rowan Test", nickname: "Ro", sex: "male", born: "2026-10-14T19:30:00Z" },
  people: {
    owner: ["emery.beta@example.com", "Emery"],
    member: ["finley.beta@example.com", "Finley"],
    viewer: ["gray.beta@example.com", "Gray"],
  },
  care: null,
  ids: { med: 20000001, dose: 20000002 },
};

/**
 * Family Alpha takes family 1 (the row migrate.ts makes for the Brookers)
 * and stands in for them; Family Beta is family 2. Alpha has a care page,
 * Beta doesn't. Every insert names its family, so the seed works on both
 * shapes.
 */
export async function seedFamilies(): Promise<Seed> {
  await sql(`UPDATE maple_families SET name = $2, timezone = $3 WHERE id = $1`, [ALPHA.familyId, ALPHA.name, ALPHA.tz]);
  await sql(
    `INSERT INTO maple_families (name, timezone, status, created_by) VALUES ($1, $2, 'active', $3) RETURNING id`,
    [BETA.name, BETA.tz, BETA.people.owner[0]]
  ).then((rows) => {
    if (Number(rows[0].id) !== BETA.familyId) throw new Error(`family 2 came out as ${rows[0].id}`);
  });
  return { alpha: await seedOne(ALPHA), beta: await seedOne(BETA) };
}

async function seedOne(f: Spec): Promise<FamilySeed> {
  const fam = f.familyId;
  const tag = f.name.split(" ")[1].toLowerCase();
  const [baby] = await sql(
    `INSERT INTO maple_babies (family_id, name, nickname, sex, born_at, timezone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [fam, f.baby.name, f.baby.nickname, f.baby.sex, f.baby.born, f.tz]
  );
  const babyId = Number(baby.id);
  for (const [role, [email, name]] of Object.entries(f.people)) {
    await sql(`INSERT INTO maple_members (family_id, email, role, display_name, added_by, accepted_at) VALUES ($1, $2, $3, $4, 'self', NOW())`, [fam, email, role, name]);
  }
  const owner = f.people.owner[0];
  const entry = async (kind: string, data: unknown, at: string, clientId: string | null = null) => {
    const [row] = await sql(
      `INSERT INTO maple_entries (family_id, baby_id, kind, started_at, data, created_by, client_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [fam, babyId, kind, at, data, owner, clientId]
    );
    return Number(row.id);
  };
  const entryClientId = `seed-${tag}-diaper`;
  const entries = {
    diaper: await entry("diaper", { pee: true }, "2026-10-20T10:00:00Z", entryClientId),
    feed: await entry("feed", { side: "L" }, "2026-10-20T11:00:00Z"),
    moment: await entry("moment", { title: `${f.baby.nickname}'s first bath`, photos: [{ key: `maple/moments/${tag}-made-up.jpg`, access: "private" }] }, "2026-10-20T12:00:00Z"),
  };

  let care: FamilySeed["care"] = null;
  if (f.care) {
    await sql(`INSERT INTO maple_care_people (family_id, member, created_by) VALUES ($1, $2, $3)`, [fam, f.care.person, owner]);
    await sql(
      `INSERT INTO maple_care_meds (family_id, id, person, name, schedule, created_by) VALUES ($1, $2, $3, 'Ibuprofen', '{"type":"every","hours":6}', $4)`,
      [fam, f.ids.med, f.care.person, owner]
    );
    const doseClientId = `seed-${tag}-dose`;
    await sql(
      `INSERT INTO maple_care_entries (family_id, id, person, kind, med_id, at, data, created_by, client_id) VALUES ($1, $2, $3, 'dose', $4, $5, '{}', $6, $7)`,
      [fam, f.ids.dose, f.care.person, f.ids.med, "2026-10-20T09:00:00Z", owner, doseClientId]
    );
    care = { person: f.care.person, medId: f.ids.med, doseId: f.ids.dose, doseClientId };
  }

  const pushEndpoint = `https://push.example.test/${tag}-phone-1`;
  const receiptToken = sha256(`${tag}-receipt`).slice(0, 32);
  const [sub] = await sql(
    `INSERT INTO maple_push_subs (family_id, member, endpoint, p256dh, auth, prefs, receipt_token) VALUES ($1, $2, $3, 'made-up-p256dh', 'made-up-auth', '{"meds":true}', $4) RETURNING id`,
    [fam, owner, pushEndpoint, receiptToken]
  );
  const token = `maple_${tag}SiriTokenMadeUp0123456789`;
  const [tok] = await sql(`INSERT INTO maple_tokens (family_id, member, token_hash, label) VALUES ($1, $2, $3, 'Made-up iPhone') RETURNING id`, [fam, owner, sha256(token)]);
  const inviteToken = `${tag}InviteTokenMadeUp0123456789`;
  const [inv] = await sql(
    `INSERT INTO maple_invites (family_id, token_hash, role, display_name, created_by, expires_at) VALUES ($1, $2, 'member', 'Grandparent', $3, NOW() + INTERVAL '7 days') RETURNING id`,
    [fam, sha256(inviteToken), owner]
  );
  const threadId = `thread_${tag}_made_up`;
  const messageId = `msg_${tag}_made_up`;
  await sql(`INSERT INTO maple_chat_threads (family_id, id, member, title, model) VALUES ($1, $2, $3, 'Made-up thread', 'zai/glm-5.3-flash')`, [fam, threadId, owner]);
  await sql(
    `INSERT INTO maple_chat_messages (family_id, id, thread_id, member, seq, role, parts) VALUES ($1, $2, $3, $4, 1, 'user', '[{"type":"text","text":"How many diapers today?"}]')`,
    [fam, messageId, threadId, owner]
  );
  await sql(`INSERT INTO maple_chat_daily (family_id, member, day, messages) VALUES ($1, $2, DATE '2026-10-20', 3)`, [fam, owner]);
  await sql(`INSERT INTO maple_consents (family_id, member, kind, version) VALUES ($1, $2, 'chat', 3)`, [fam, owner]);
  await sql(
    `INSERT INTO maple_ai_usage (family_id, member, thread_id, message_id, step, model, input_tokens, output_tokens, cost_micro_usd, price_key) VALUES ($1, $2, $3, $4, 1, 'zai/glm-5.3-flash', 1000, 100, 200, 'zai/glm-5.3-flash')`,
    [fam, owner, threadId, messageId]
  );
  await sql(`INSERT INTO maple_removed (family_id, email, removed_by) VALUES ($1, $2, $3)`, [fam, `removed.${tag}@example.com`, owner]);

  return {
    familyId: fam,
    name: f.name,
    tz: f.tz,
    babyId,
    babyName: f.baby.name,
    owner,
    member: f.people.member[0],
    viewer: f.people.viewer[0],
    entries,
    entryClientId,
    care,
    pushSubId: Number(sub.id),
    pushEndpoint,
    receiptToken,
    tokenId: Number(tok.id),
    token,
    inviteId: Number(inv.id),
    inviteToken,
    threadId,
    messageId,
  };
}

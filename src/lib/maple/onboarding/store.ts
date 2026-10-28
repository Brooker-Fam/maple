import { query, transaction } from "@/lib/db";
import { captureAppEventSoon } from "@/lib/analytics/server";
import { createInvite, familyOf, listInvites, listMembers, type Fam } from "../auth";
import { CareConflict, createCarePerson, patchCarePerson } from "../care-store";
import { ADMIN_MEMBER_ID, type FamilyCtx } from "../family";
import { StoreUnavailable } from "../store";
import type { Member } from "../types";
import {
  AnswerError,
  BABY_DEFAULT_NAME,
  birthInstant,
  birthProblem,
  isStep,
  MAX_OPEN_INVITES,
  missingSteps,
  nextStep,
  ONBOARDING_MODEL_STEPS,
  parseAnswer,
  skippable,
  type Answer,
  type OnboardingView,
  type Progress,
  type StepId,
} from "./steps";

/**
 * Onboarding's writes, every one inside the caller's family. Progress lives
 * in maple_families.onboarding ({ done, birth, care, notifications,
 * model_steps }); every answer lands in its real column: the member's name,
 * the family's timezone and units, the baby's row and settings, invite links,
 * her care page. Only an owner of a family still in status 'onboarding'
 * writes here, so a family that finished (family 1 among them) is never
 * touched.
 */

export const CARE_CONSENT_VERSION = 1;
const MAX_PEOPLE = 12;

export class OnboardingClosed extends Error {}

type Row = Record<string, unknown>;

async function rows(sql: string, params: unknown[]): Promise<Row[]> {
  const r = await query(sql, params);
  if (r === null) throw new StoreUnavailable();
  return r as Row[];
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

type State = {
  done?: Partial<Record<StepId, Progress>>;
  /** The birth's wall time, kept so a timezone change moves the instant; null for a due date. */
  birth?: { date: string; time: string | null } | null;
  terms_at?: string;
  care?: "me" | "later" | "no";
  notifications?: boolean;
  model_steps?: number;
};

function progress(raw: unknown): State {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as State) : {};
  const done: Partial<Record<StepId, Progress>> = {};
  for (const [k, v] of Object.entries(s.done ?? {})) if (isStep(k) && (v === "answered" || v === "skipped")) done[k] = v;
  return { ...s, done };
}

export async function readView(ctx: FamilyCtx): Promise<OnboardingView> {
  const r = await rows(
    `SELECT f.status, f.onboarding, f.settings AS family_settings, f.timezone, f.units, m.display_name, m.role_word,
       b.id AS baby_id, b.name, b.nickname, b.sex, to_char(b.due_date, 'YYYY-MM-DD') AS due, b.born_at, b.settings,
       (SELECT COUNT(*) FROM maple_invites i WHERE i.family_id = f.id) AS invites
     FROM maple_families f
     JOIN maple_members m ON m.family_id = f.id AND m.email = $2
     LEFT JOIN LATERAL (
       SELECT * FROM maple_babies WHERE family_id = f.id AND archived_at IS NULL ORDER BY id LIMIT 1
     ) b ON TRUE
     WHERE f.id = $1`,
    [familyOf(ctx), ctx.member]
  );
  if (!r.length) throw new OnboardingClosed();
  const row = r[0];
  const s = progress(row.onboarding);
  const done = s.done ?? {};
  // /signup takes the terms, 18 and over and US only, before the family exists.
  if (!done.welcome && (row.family_settings as { signup?: { terms?: unknown } } | null)?.signup?.terms) done.welcome = "answered";
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const feeding = settings.feeding_methods as { nursing?: unknown; pumping?: unknown; formula?: unknown } | undefined;
  const status = row.status === "active" || row.status === "deleting" ? row.status : "onboarding";
  const missing = missingSteps(done);
  return {
    familyId: familyOf(ctx),
    status,
    owner: ctx.role === "owner",
    done,
    next: nextStep(done),
    canFinish: !missing.length,
    missing,
    values: {
      you: { name: str(row.display_name), role_word: str(row.role_word) },
      timezone: { timezone: String(row.timezone), units: row.units === "metric" ? "metric" : "us" },
      baby:
        row.baby_id == null
          ? null
          : {
              name: str(row.name),
              nickname: str(row.nickname),
              sex: row.sex === "female" || row.sex === "male" ? row.sex : null,
              born_at: row.born_at == null ? null : new Date(row.born_at as string).toISOString(),
              due_date: str(row.due),
              birth_time_known: settings.birth_time_approx !== true,
            },
      feeding: feeding ? { nursing: feeding.nursing === true, pumping: feeding.pumping === true, formula: feeding.formula === true } : null,
      invites: Number(row.invites ?? 0),
      care: s.care ?? null,
      pediatrician:
        done.pediatrician === "answered"
          ? { name: str(settings.pediatrician_name), phone: str(settings.pediatrician_phone), after_hours: str(settings.after_hours_phone) }
          : null,
      notifications: typeof s.notifications === "boolean" ? s.notifications : null,
    },
    modelSteps: Number(s.model_steps ?? 0),
  };
}

function writer(ctx: FamilyCtx, member: Member) {
  if (ctx.status !== "onboarding") throw new OnboardingClosed();
  if (member.role !== "owner" || member.email !== ctx.member) throw new AnswerError("Only the person setting up this log can answer these.");
}

async function mark(ctx: Fam, step: StepId, how: Progress, extra: Partial<State> = {}): Promise<void> {
  const r = await rows(
    `UPDATE maple_families
     SET onboarding = onboarding || $3::jsonb || jsonb_build_object('done', COALESCE(onboarding->'done', '{}'::jsonb) || jsonb_build_object($2::text, $4::text)),
         updated_at = NOW()
     WHERE id = $1 AND status = 'onboarding' RETURNING id`,
    [familyOf(ctx), step, JSON.stringify(extra), how]
  );
  if (!r.length) throw new OnboardingClosed();
}

/** The lock keeps two phones answering at once from making two babies. */
async function ensureBaby(ctx: Fam): Promise<number> {
  const familyId = familyOf(ctx);
  const out = await transaction([
    { sql: `SELECT pg_advisory_xact_lock(hashtext('maple_onboarding_baby'), $1::int)`, params: [familyId] },
    {
      sql: `INSERT INTO maple_babies (family_id, name, timezone)
            SELECT f.id, $2, f.timezone FROM maple_families f
            WHERE f.id = $1 AND NOT EXISTS (SELECT 1 FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL)`,
      params: [familyId, BABY_DEFAULT_NAME],
    },
    { sql: `SELECT id FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1`, params: [familyId] },
  ]);
  if (out === null) throw new StoreUnavailable();
  const id = out[2]?.[0]?.id;
  if (id == null) throw new OnboardingClosed();
  return Number(id);
}

async function setBaby(ctx: Fam, sets: string, params: unknown[]): Promise<void> {
  const babyId = await ensureBaby(ctx);
  await rows(`UPDATE maple_babies SET ${sets}, updated_at = NOW() WHERE id = $1 AND family_id = $2`, [babyId, familyOf(ctx), ...params]);
}

async function setBabySettings(ctx: Fam, settings: Record<string, unknown>): Promise<void> {
  await setBaby(ctx, `settings = jsonb_strip_nulls(settings || $3::jsonb)`, [JSON.stringify(settings)]);
}

async function familyTz(ctx: Fam): Promise<string> {
  const r = await rows(`SELECT timezone FROM maple_families WHERE id = $1`, [familyOf(ctx)]);
  return String(r[0]?.timezone ?? "");
}

async function writeBirth(ctx: Fam, a: Answer["birth"], tz: string): Promise<void> {
  if (a.born) {
    await setBaby(ctx, `born_at = $3, settings = jsonb_strip_nulls(settings || $4::jsonb)`, [
      birthInstant(a, tz).toISOString(),
      JSON.stringify({ birth_time_approx: a.time === null ? true : null }),
    ]);
  } else {
    await setBaby(ctx, `due_date = $3::date, born_at = NULL`, [a.due]);
  }
}

export type AnswerResult = { view: OnboardingView; invites?: { name: string; role: "member" | "viewer"; token: string }[] };

export async function answerStep(ctx: FamilyCtx, member: Member, step: StepId, raw: unknown, now = new Date()): Promise<AnswerResult> {
  writer(ctx, member);
  const fam = { familyId: ctx.familyId };
  const out: AnswerResult = { view: null as unknown as OnboardingView };
  switch (step) {
    case "welcome": {
      parseAnswer("welcome", raw);
      await mark(fam, step, "answered", { terms_at: now.toISOString() });
      break;
    }
    case "you": {
      const a = parseAnswer("you", raw);
      await rows(`UPDATE maple_members SET display_name = $3, role_word = $4, updated_at = NOW() WHERE family_id = $1 AND email = $2`, [
        familyOf(fam),
        member.email,
        a.name,
        a.role_word,
      ]);
      await mark(fam, step, "answered");
      break;
    }
    case "timezone": {
      const a = parseAnswer("timezone", raw);
      await rows(`UPDATE maple_families SET timezone = $2, units = $3, updated_at = NOW() WHERE id = $1`, [familyOf(fam), a.timezone, a.units]);
      await rows(`UPDATE maple_babies SET timezone = $2, updated_at = NOW() WHERE family_id = $1 AND archived_at IS NULL`, [familyOf(fam), a.timezone]);
      const s = progress((await rows(`SELECT onboarding FROM maple_families WHERE id = $1`, [familyOf(fam)]))[0]?.onboarding);
      // A birth time was given on the family's clock: a new clock moves the instant, not the wall time.
      if (s.birth && s.done?.birth === "answered") await writeBirth(fam, { born: true, ...s.birth }, a.timezone);
      await mark(fam, step, "answered");
      break;
    }
    case "baby_name": {
      const a = parseAnswer("baby_name", raw);
      await setBaby(fam, `name = $3, nickname = $4`, [a.name ?? BABY_DEFAULT_NAME, a.nickname]);
      await mark(fam, step, "answered");
      break;
    }
    case "birth": {
      const a = parseAnswer("birth", raw);
      const tz = await familyTz(fam);
      const problem = birthProblem(a, tz, now);
      if (problem) throw new AnswerError(problem);
      await writeBirth(fam, a, tz);
      await mark(fam, step, "answered", { birth: a.born ? { date: a.date, time: a.time } : null });
      break;
    }
    case "sex": {
      const a = parseAnswer("sex", raw);
      await setBaby(fam, `sex = $3`, [a.sex]);
      await mark(fam, step, "answered");
      break;
    }
    case "feeding": {
      const a = parseAnswer("feeding", raw);
      // Pumped milk and formula both go in bottles; nothing logged is hidden either way.
      await setBabySettings(fam, { feeding_methods: a, feeds_bottle: a.formula || a.pumping, track_pump: a.pumping });
      await mark(fam, step, "answered");
      break;
    }
    case "invites": {
      if (member.email === ADMIN_MEMBER_ID) throw new AnswerError("Invite people from Settings → People & permissions once you're signed in with Google.");
      const a = parseAnswer("invites", raw);
      const [members, open] = await Promise.all([listMembers(fam), listInvites(fam)]);
      if (open.length + a.people.length > MAX_OPEN_INVITES || members.length + open.length + a.people.length > MAX_PEOPLE) {
        throw new AnswerError("That's more invites than one log can have open. Add the rest later in Settings → People & permissions.");
      }
      out.invites = [];
      for (const p of a.people) {
        const { token } = await createInvite(fam, { role: p.role, displayName: p.name, emoji: null, createdBy: member.email });
        captureAppEventSoon(ctx.familyId, "invite_sent");
        out.invites.push({ name: p.name, role: p.role, token });
      }
      await mark(fam, step, "answered");
      break;
    }
    case "care": {
      const a = parseAnswer("care", raw);
      if (a.choice === "me") await openCarePage(fam, member, now);
      await mark(fam, step, "answered", { care: a.choice });
      break;
    }
    case "pediatrician": {
      const a = parseAnswer("pediatrician", raw);
      await setBabySettings(fam, { pediatrician_name: a.name, pediatrician_phone: a.phone, after_hours_phone: a.after_hours });
      await mark(fam, step, "answered");
      break;
    }
    case "notifications": {
      const a = parseAnswer("notifications", raw);
      await mark(fam, step, "answered", { notifications: a.on });
      break;
    }
  }
  out.view = await readView(ctx);
  return out;
}

/**
 * Her page, tied to her own member id, made only when she says yes herself
 * (the signed-in owner is the birth parent), with that consent kept on it.
 * Someone else's page waits for them to join and turn it on.
 */
async function openCarePage(fam: Fam, member: Member, now: Date): Promise<void> {
  if (member.email === ADMIN_MEMBER_ID || member.role === "viewer") throw new AnswerError("This page can only be turned on from the birth parent's own account.");
  const members = await listMembers(fam);
  try {
    await createCarePerson(fam, member.email, member.email, members);
  } catch (e) {
    if (!(e instanceof CareConflict)) throw e;
    const existing = await rows(`SELECT member FROM maple_care_people WHERE family_id = $1`, [familyOf(fam)]);
    if (existing[0]?.member !== member.email) throw new AnswerError("This log already has a recovery page.");
  }
  const baby = await rows(`SELECT settings FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [familyOf(fam)]);
  const methods = (baby[0]?.settings as { feeding_methods?: { nursing?: boolean; pumping?: boolean } } | undefined)?.feeding_methods;
  await patchCarePerson(fam, member.email, {
    settings: {
      consent: { at: now.toISOString(), by: member.email, version: CARE_CONSENT_VERSION },
      ...(methods ? { feeding: methods.nursing || methods.pumping ? "yes" : "no" } : {}),
    },
  });
}

/** A skipped step keeps its default: a baby named "Baby", every feeding switch on. */
export async function skipStep(ctx: FamilyCtx, member: Member, step: StepId): Promise<OnboardingView> {
  writer(ctx, member);
  if (!skippable(step)) throw new AnswerError("This one is needed before you can start logging.");
  const fam = { familyId: ctx.familyId };
  if (step === "baby_name") await ensureBaby(fam);
  await mark(fam, step, "skipped", step === "care" ? { care: "no" } : step === "notifications" ? { notifications: false } : {});
  return readView(ctx);
}

export async function finishOnboarding(ctx: FamilyCtx, member: Member, now = new Date()): Promise<OnboardingView> {
  writer(ctx, member);
  const view = await readView(ctx);
  if (!view.canFinish) throw new AnswerError(`Still needed: ${view.missing.join(", ")}.`);
  const fam = { familyId: ctx.familyId };
  await ensureBaby(fam);
  const r = await rows(
    `UPDATE maple_families SET status = 'active', onboarding = onboarding || jsonb_build_object('finished_at', $2::text), updated_at = NOW()
     WHERE id = $1 AND status = 'onboarding' RETURNING id`,
    [familyOf(fam), now.toISOString()]
  );
  if (!r.length) throw new OnboardingClosed();
  captureAppEventSoon(ctx.familyId, "onboarding_completed");
  return readView({ ...ctx, status: "active" });
}

/**
 * Claims `n` of the onboarding's model steps before a chat turn, or null once
 * the cap is reached (the form carries on). Claimed up front, so turns running
 * at once can't each spend past it.
 */
export async function claimModelSteps(ctx: Fam, n: number): Promise<number | null> {
  const r = await rows(
    `UPDATE maple_families
     SET onboarding = onboarding || jsonb_build_object('model_steps', COALESCE((onboarding->>'model_steps')::int, 0) + $2)
     WHERE id = $1 AND status = 'onboarding' AND COALESCE((onboarding->>'model_steps')::int, 0) + $2 <= $3
     RETURNING (onboarding->>'model_steps')::int AS used`,
    [familyOf(ctx), n, ONBOARDING_MODEL_STEPS]
  );
  return r.length ? Number(r[0].used) : null;
}

export async function returnModelSteps(ctx: Fam, n: number): Promise<void> {
  if (n <= 0) return;
  await rows(
    `UPDATE maple_families SET onboarding = onboarding || jsonb_build_object('model_steps', GREATEST(0, COALESCE((onboarding->>'model_steps')::int, 0) - $2))
     WHERE id = $1`,
    [familyOf(ctx), n]
  );
}

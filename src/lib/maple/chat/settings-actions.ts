import { query } from "@/lib/db";
import { chatConsent, CONSENT_VERSION } from "../consent";
import type { FamilyCtx } from "../family";
import { StoreUnavailable } from "../store";
import type { Member } from "../types";
import { settingActionSchema, settingInputSchema, settingProposalSchema, settingResultText, type SettingAction, type SettingActionResult, type SettingProposal } from "./settings";
import { validateSetting } from "./settings-tools";

export class SettingActionError extends Error {
  constructor(message: string, public status: 400 | 403 | 404 | 409) { super(message); }
}

async function rows(sql: string, params: unknown[]) {
  const result = await query(sql, params);
  if (result === null) throw new StoreUnavailable();
  return result;
}

/** Resolve authority from the stored tool result, never a client-supplied patch or previous value. */
export async function applyChatSetting(fam: Pick<FamilyCtx, "familyId">, member: Pick<Member, "email" | "role">, raw: unknown, device: string | null): Promise<SettingActionResult> {
  const parsed = settingActionSchema.safeParse(raw);
  if (!parsed.success) throw new SettingActionError("That setting action is incomplete.", 400);
  const action = parsed.data;
  const consent = await chatConsent(fam, member);
  if (!consent.terms) throw new SettingActionError("Accept the chat's terms first.", 403);
  const found = await rows(
    `SELECT m.parts, COALESCE(t.busy_until > NOW(), FALSE) AS busy
       FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id AND t.family_id = m.family_id
       JOIN maple_members u ON u.family_id = t.family_id AND u.email = t.member
       WHERE t.family_id = $1 AND t.member = $2 AND t.id = $3 AND m.id = $4 AND m.member = $2 AND m.role = 'assistant'
         AND (t.viewer_only OR u.role <> 'viewer') AND (u.accepted_at IS NOT NULL OR u.family_id = 1)`,
    [fam.familyId, member.email, action.threadId, action.messageId],
  );
  if (!found.length) throw new SettingActionError("That setting card is no longer available.", 404);
  if (found[0].busy === true) throw new SettingActionError("The reply is still finishing. Try this card again in a moment.", 409);
  const parts = found[0].parts as Record<string, unknown>[];
  if (!Array.isArray(parts)) throw new SettingActionError("That setting card is no longer available.", 404);
  const index = parts.findIndex((part) => part.toolCallId === action.toolCallId && (part.type === "tool-propose_setting" || (part.type === "dynamic-tool" && part.toolName === "propose_setting")) && part.state === "output-available");
  const output = index < 0 ? null : parts[index].output as Record<string, unknown> | null;
  const proposal = settingProposalSchema.safeParse(output?.setting);
  if (!output || output.ok !== true || !proposal.success) throw new SettingActionError("That setting card is no longer available.", 404);
  const setting = proposal.data;
  if (setting.scope === "family" && member.role === "viewer") throw new SettingActionError("View-only members cannot change family settings.", 403);
  if (setting.scope === "phone" && (!device || device !== setting.phoneDevice)) throw new SettingActionError("This card belongs to another phone. Open Family to change this phone's preferences.", 409);
  if (setting.scope === "family" && action.phonePrevious !== undefined) throw new SettingActionError("This setting does not use a phone preference.", 400);
  // Lost-response retries return the durable receipt without replaying a write.
  if ((action.action === "apply" && setting.status === "applied") || (action.action === "undo" && setting.status === "undone")) return { setting, text: settingResultText(setting) };
  if ((action.action === "apply" && setting.status !== "proposed") || (action.action === "undo" && setting.status !== "applied")) throw new SettingActionError("That setting card has already moved on. Ask for a new change.", 409);
  const next = nextSetting(setting, action, fam.familyId);
  const text = settingResultText(next);
  const newParts = parts.map((part, i) => i === index ? { ...part, output: { ...output, setting: next, text } } : part);
  const params: unknown[] = [fam.familyId, member.email, action.threadId, action.messageId, JSON.stringify(parts), JSON.stringify(newParts), CONSENT_VERSION.chat, setting.scope === "family"];
  // Locks both rows for this one atomic operation: a model turn, another tap,
  // history deletion, or a receipt update cannot slip between the write and receipt.
  const locked = `locked AS MATERIALIZED (
    SELECT m.id FROM maple_chat_messages m JOIN maple_chat_threads t ON t.id = m.thread_id AND t.family_id = m.family_id
    JOIN maple_members u ON u.family_id = t.family_id AND u.email = t.member
    WHERE t.family_id = $1 AND t.member = $2 AND t.id = $3 AND m.id = $4 AND m.member = $2
      AND m.parts = $5::jsonb AND (t.busy_until IS NULL OR t.busy_until < NOW())
      AND (t.viewer_only OR u.role <> 'viewer') AND (NOT $8::boolean OR u.role <> 'viewer')
      AND (u.accepted_at IS NOT NULL OR u.family_id = 1)
      AND EXISTS (SELECT 1 FROM maple_consents c WHERE c.family_id = $1 AND c.member = $2 AND c.kind = 'chat' AND c.version = $7)
    FOR UPDATE OF t, m
  )`;
  let changed = "";
  let changeCondition = "EXISTS (SELECT 1 FROM locked)";
  if (setting.scope === "family") {
    const value = action.action === "apply" ? setting.value : setting.previous;
    const expected = action.action === "apply" ? setting.previous : setting.value;
    params.push(setting.key, JSON.stringify(value), JSON.stringify(expected), setting.babyId);
    // These are closed, fixed SQL fragments, never identifiers from the request.
    const column = setting.key === "baby_name" ? "name" : setting.key === "nickname" ? "nickname" : null;
    const current = column ? `COALESCE(to_jsonb(b.${column}), 'null'::jsonb)` : "COALESCE(b.settings->$9::text, 'null'::jsonb)";
    const patch = column ? `${column} = ($10::jsonb #>> '{}')` : "settings = jsonb_strip_nulls(b.settings || jsonb_build_object($9::text, $10::jsonb))";
    changed = `, changed AS (
      UPDATE maple_babies b SET ${patch}, updated_at = NOW()
      WHERE b.family_id = $1 AND b.id = $12 AND b.archived_at IS NULL
        AND b.id = (SELECT id FROM maple_babies WHERE family_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1)
        AND $9::text IS NOT NULL AND ${current} = $11::jsonb AND EXISTS (SELECT 1 FROM locked)
      RETURNING b.id
    )`;
    changeCondition = "EXISTS (SELECT 1 FROM changed)";
  }
  const saved = await rows(`WITH ${locked}${changed}
    UPDATE maple_chat_messages m SET parts = $6::jsonb, updated_at = NOW()
      WHERE m.family_id = $1 AND m.member = $2 AND m.id = $4 AND m.thread_id = $3 AND ${changeCondition}
      RETURNING m.id`, params);
  if (!saved.length) {
    // A concurrent retry may already have committed the exact action. Read its
    // receipt once; never automatically retry a setting against new values.
    const latest = await rows("SELECT parts FROM maple_chat_messages WHERE family_id = $1 AND member = $2 AND thread_id = $3 AND id = $4", [fam.familyId, member.email, action.threadId, action.messageId]);
    const latestParts = latest[0]?.parts;
    const latestPart = Array.isArray(latestParts) ? latestParts.find((part) => part.toolCallId === action.toolCallId) : null;
    const applied = settingProposalSchema.safeParse(latestPart?.output?.setting);
    if (applied.success && applied.data.status === next.status && applied.data.phoneDevice === next.phoneDevice) return { setting: applied.data, text: settingResultText(applied.data) };
    throw new SettingActionError("This setting or conversation changed since the card was shown. Nothing was overwritten. Ask for a fresh change.", 409);
  }
  return { setting: next, text };
}

function nextSetting(setting: SettingProposal, action: SettingAction, familyId: number): SettingProposal {
  let previous = setting.previous;
  if (setting.scope === "phone" && action.action === "apply") {
    const input = settingInputSchema.safeParse({ key: setting.key, value: action.phonePrevious });
    if (!input.success) throw new SettingActionError("The phone's previous preference is needed to keep Undo accurate.", 400);
    previous = input.data.value;
  }
  const target = action.action === "apply" ? setting.value : previous;
  if (target !== null) {
    try { validateSetting(settingInputSchema.parse({ key: setting.key, value: target }), familyId); }
    catch { throw new SettingActionError("That saved value no longer fits this setting. Open Family to make the change.", 400); }
  } else if (setting.key === "baby_name") throw new SettingActionError("The baby's name cannot be cleared.", 400);
  return { ...setting, previous, status: action.action === "apply" ? "applied" : "undone", changedAt: new Date().toISOString() };
}

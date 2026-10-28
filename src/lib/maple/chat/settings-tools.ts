import { tool, zodSchema } from "ai";
import { z } from "zod";
import { familyName } from "../api";
import { context, type Extra } from "../mcp-tools";
import { parseAnswer } from "../onboarding/steps";
import type { ChatToolOutput } from "./types";
import { currentSetting, FAMILY_SETTING_KEYS, isPhoneSetting, SETTING_KEYS, SETTING_LABELS, settingInputSchema, settingProposalSchema, settingResultText, settingValueLabel, type SettingInput, type SettingProposal, type SettingsSnapshot, type SettingValue } from "./settings";

export type SettingsToolOutput = ChatToolOutput & { setting?: SettingProposal; settings?: SettingsSnapshot };

// Providers require an object at the tool-schema root. The discriminated
// validator below still enforces the exact value type for the chosen key.
const proposalInput = z.object({ key: z.enum(SETTING_KEYS), value: z.union([z.boolean(), z.string().max(80), z.null()]) }).strict();

/** Exactly the same name/contact validators used by the profile and setup forms. */
export function validateSetting(input: SettingInput, familyId: number): SettingInput {
  let value: SettingValue = input.value;
  if (input.key === "baby_name" || input.key === "nickname") {
    value = familyName({ familyId }, value, input.key === "baby_name" ? 80 : 40, input.key === "baby_name" ? "The baby's name" : "The nickname");
    if (input.key === "baby_name" && !value) throw new Error("The baby's name is required.");
  }
  if (input.key === "pediatrician_name" || input.key === "pediatrician_phone" || input.key === "after_hours_phone") {
    const field = input.key === "pediatrician_name" ? "name" : input.key === "pediatrician_phone" ? "phone" : "after_hours";
    const checked = parseAnswer("pediatrician", { [field]: value });
    value = checked[field];
  }
  return settingInputSchema.parse({ key: input.key, value });
}

export function settingsTools(extra: Extra) {
  const toModelOutput = ({ output }: { output: SettingsToolOutput }) => ({ type: output.ok ? "text" as const : "error-text" as const, value: output.text });
  return {
    get_settings: tool<Record<string, never>, SettingsToolOutput, Record<string, unknown>>({
      description: "Read current family display settings, baby's name/nickname and pediatrician contact details. Only this allowlist is read. Phone units, theme and night look are local to each phone and cannot be read by this server; use open_screen for their current values. Does not read medicines, consent, accounts or private recovery settings.",
      inputSchema: zodSchema(z.object({}).strict()),
      execute: async () => {
        const ctx = await context(extra);
        const items = FAMILY_SETTING_KEYS.map((key) => ({ key, label: SETTING_LABELS[key], value: currentSetting(ctx.baby, key) }));
        return { ok: true, write: false, settings: { v: 1, scope: "family", items, phone: "unknown" }, text: `Family settings: ${items.map((item) => `${item.label}: ${settingValueLabel(item.key, item.value)}`).join("; ")}. This phone's units, theme and night look are not available to the server. These values describe the family settings now; no settings were changed.` };
      },
      toModelOutput,
    }),
    propose_setting: tool<z.infer<typeof proposalInput>, SettingsToolOutput, Record<string, unknown>>({
      description: "Show one requested setting change as an Apply card. Nothing is saved by this tool. Family settings: feeds_bottle, track_pump, track_nursing, show_brigade, show_alerts (booleans); baby_name, nickname, pediatrician_name, pediatrician_phone, after_hours_phone (text, null clears optional text). Phone-only preferences: units us/metric, night auto/always/off, theme light/system/dark. Only propose a change the person requested. State that family changes affect everyone; phone choices affect this phone. Use open_screen for birth/timezone, notifications, account access, consent and medicine plans. Do not infer medical settings or change permissions.",
      inputSchema: zodSchema(proposalInput),
      execute: async (raw) => {
        const ctx = await context(extra);
        try {
          const input = validateSetting(settingInputSchema.parse(raw), ctx.fam.familyId);
          const phone = isPhoneSetting(input.key);
          if (!phone && ctx.who.role === "viewer") return { ok: false, write: false, text: "You have view-only access, so family settings cannot be changed. An owner can make you a member in Family." };
          if (phone && !ctx.device) return { ok: false, write: false, text: "Open Family to change this phone's preferences." };
          const setting = settingProposalSchema.parse({ v: 1, scope: phone ? "phone" : "family", key: input.key, label: SETTING_LABELS[input.key], previous: phone ? null : currentSetting(ctx.baby, input.key), value: input.value, status: "proposed", ...(phone ? { phoneDevice: ctx.device } : { babyId: ctx.baby.id }) });
          return { ok: true, write: false, setting, text: settingResultText(setting) };
        } catch (error) {
          if (error instanceof Error && !('code' in error)) return { ok: false, write: false, text: error.message.length < 200 ? error.message : "That setting value does not fit. Nothing was changed." };
          throw error;
        }
      },
      toModelOutput,
    }),
  };
}

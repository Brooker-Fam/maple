import { z } from "zod";
import type { Baby } from "../types";

/** Client-safe, closed list. No arbitrary profile, consent or medicine fields. */
export const FAMILY_SETTING_KEYS = ["feeds_bottle", "track_pump", "track_nursing", "show_brigade", "show_alerts", "baby_name", "nickname", "pediatrician_name", "pediatrician_phone", "after_hours_phone"] as const;
export const PHONE_SETTING_KEYS = ["units", "night", "theme"] as const;
export const SETTING_KEYS = [...FAMILY_SETTING_KEYS, ...PHONE_SETTING_KEYS] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type PhoneSettingKey = (typeof PHONE_SETTING_KEYS)[number];
export type SettingValue = boolean | string | null;

export const SETTING_LABELS: Record<SettingKey, string> = {
  feeds_bottle: "Bottles", track_pump: "Pumping", track_nursing: "Nursing", show_brigade: "Diaper brigade", show_alerts: "Warnings & reminders",
  baby_name: "Baby's name", nickname: "Nickname", pediatrician_name: "Pediatrician", pediatrician_phone: "Pediatrician phone", after_hours_phone: "After-hours phone",
  units: "Units", night: "Night look", theme: "Theme",
};

const text = (max: number) => z.string().trim().max(max).nullable();
export const settingInputSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("feeds_bottle"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("track_pump"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("track_nursing"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("show_brigade"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("show_alerts"), value: z.boolean() }).strict(),
  z.object({ key: z.literal("baby_name"), value: z.string().trim().min(1).max(80) }).strict(),
  z.object({ key: z.literal("nickname"), value: text(40) }).strict(),
  z.object({ key: z.literal("pediatrician_name"), value: text(80) }).strict(),
  z.object({ key: z.literal("pediatrician_phone"), value: text(30) }).strict(),
  z.object({ key: z.literal("after_hours_phone"), value: text(30) }).strict(),
  z.object({ key: z.literal("units"), value: z.enum(["us", "metric"]) }).strict(),
  z.object({ key: z.literal("night"), value: z.enum(["auto", "always", "off"]) }).strict(),
  z.object({ key: z.literal("theme"), value: z.enum(["light", "system", "dark"]) }).strict(),
]);
export type SettingInput = z.infer<typeof settingInputSchema>;
export const isPhoneSetting = (key: SettingKey): key is PhoneSettingKey => (PHONE_SETTING_KEYS as readonly string[]).includes(key);

/** The exact stored value for compare-and-set, before display defaults apply. */
export function currentSetting(baby: Pick<Baby, "name" | "nickname" | "settings">, key: SettingKey): SettingValue {
  const raw = key === "baby_name" ? baby.name : key === "nickname" ? baby.nickname : baby.settings[key];
  if (raw == null) return null;
  if ((typeof raw !== "boolean" && typeof raw !== "string") || !settingInputSchema.safeParse({ key, value: raw }).success) throw new Error("This setting needs to be changed in Family.");
  return raw;
}

const value = z.union([z.boolean(), z.string().max(80), z.null()]);
export const settingProposalSchema = z.object({
  v: z.literal(1), scope: z.enum(["family", "phone"]), key: z.enum(SETTING_KEYS), label: z.string().max(40),
  previous: value, value, status: z.enum(["proposed", "applied", "undone"]), changedAt: z.string().datetime().optional(),
  /** Family proposals stay attached to the baby whose settings were read. */
  babyId: z.number().int().positive().optional(),
  /** Device applicability only, never account access. Kept out of the model's text. */
  phoneDevice: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
}).strict().superRefine((p, ctx) => {
  if (!settingInputSchema.safeParse({ key: p.key, value: p.value }).success) ctx.addIssue({ code: "custom", message: "Invalid setting value" });
  if ((p.scope === "phone") !== isPhoneSetting(p.key)) ctx.addIssue({ code: "custom", message: "Wrong setting scope" });
  if (p.previous !== null && !settingInputSchema.safeParse({ key: p.key, value: p.previous }).success) ctx.addIssue({ code: "custom", message: "Invalid previous value" });
  if (p.scope === "phone" && !p.phoneDevice) ctx.addIssue({ code: "custom", message: "Phone proposal requires its device" });
  if (p.scope === "family" && !p.babyId) ctx.addIssue({ code: "custom", message: "Family proposal requires its baby" });
});
export type SettingProposal = z.infer<typeof settingProposalSchema>;
export type SettingsSnapshot = { v: 1; scope: "family"; items: { key: SettingKey; label: string; value: SettingValue }[]; phone: "unknown" };

export function settingValueLabel(key: SettingKey, value: SettingValue): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (value === null) {
    if (["feeds_bottle", "track_pump", "track_nursing", "show_brigade"].includes(key)) return "On (default)";
    if (key === "show_alerts") return "Off (default)";
    return isPhoneSetting(key) ? "This phone's current choice" : "Not set";
  }
  if (key === "units") return value === "metric" ? "kg · ml · °C" : "lb · oz · °F";
  if (key === "night") return ({ auto: "Auto", always: "Always", off: "Off" } as Record<string, string>)[value] ?? value;
  if (key === "theme") return ({ light: "Light", system: "Auto", dark: "Dark" } as Record<string, string>)[value] ?? value;
  return value;
}

export const settingActionSchema = z.object({
  threadId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), toolCallId: z.string().min(1).max(160),
  action: z.enum(["apply", "undo"]), phonePrevious: value.optional(),
}).strict();
export type SettingAction = z.infer<typeof settingActionSchema>;
export type SettingActionResult = { setting: SettingProposal; text: string };

export function settingResultText(p: SettingProposal): string {
  const shown = settingValueLabel(p.key, p.status === "undone" ? p.previous : p.value);
  const where = p.scope === "phone" ? "on the phone where this card was shown" : "for the family";
  if (p.status === "proposed") return `Proposed ${p.label}: ${shown} ${where}. Nothing has changed; the person must tap Apply on the card.`;
  return `${p.status === "undone" ? "Restored" : "Changed"} ${p.label}: ${shown} ${where}.${p.scope === "phone" ? " This is that phone's reported choice; other phones can have different preferences." : ""}`;
}

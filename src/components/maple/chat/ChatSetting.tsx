"use client";

import { useRef, useState } from "react";
import { deviceId } from "@/lib/maple/device";
import { currentSetting, isPhoneSetting, settingProposalSchema, settingValueLabel, type SettingAction, type SettingActionResult, type SettingKey, type SettingProposal, type SettingsSnapshot, type SettingValue } from "@/lib/maple/chat/settings";
import { useAppNav, type SettingsTarget } from "../AppNav";
import { Icon } from "../icons";
import { useNotifications } from "../notify";
import { Button, cx, tone } from "../ui";
import { ApiError, useMaple } from "../useMaple";
import { usePhoneSettings } from "./phoneSettings";

type Ref = { threadId: string; messageId: string; toolCallId: string };
type PendingPhone = { action: SettingAction["action"]; previous: SettingValue; value: SettingValue };

function settingsPage(key: SettingKey): SettingsTarget {
  if (isPhoneSetting(key)) return "family/appearance";
  if (key === "baby_name" || key === "nickname") return "family/baby";
  if (key === "pediatrician_name" || key === "pediatrician_phone" || key === "after_hours_phone") return "family/doctor";
  return "family/today";
}

export default function ChatSetting({ setting: raw, ...props }: Ref & { setting: SettingProposal | unknown; busy?: boolean }) {
  const parsed = settingProposalSchema.safeParse(raw);
  if (!parsed.success) return <p className={cx(tone.muted, "text-[14px]")}>This setting card is no longer available. Open Settings to change it.</p>;
  return <SettingCard key={`${props.threadId}/${props.messageId}/${props.toolCallId}`} initial={parsed.data} {...props} />;
}

function SettingCard({ initial, threadId, messageId, toolCallId, busy = false }: Ref & { initial: SettingProposal; busy?: boolean }) {
  const { api, refresh, readOnly, online, state } = useMaple();
  const app = useAppNav();
  const phone = usePhoneSettings();
  const currentPhone = useRef(phone);
  currentPhone.current = phone;
  const [saved, setSaved] = useState<SettingProposal | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [phonePending, setPhonePending] = useState<PendingPhone | null>(null);
  const inflight = useRef(false);
  // A fresh server history can supersede the local result (for example an Undo on another phone).
  const setting = saved && (!initial.changedAt || (saved.changedAt ?? "") >= initial.changedAt) ? saved : initial;
  const key = setting.key;
  const local = isPhoneSetting(key);
  const samePhone = !local || setting.phoneDevice === deviceId();
  let current = local ? phone.values[key] : setting.status === "applied" ? setting.value : setting.previous;
  let familyChanged = false;
  if (!local && setting.status === "proposed" && state?.baby) {
    try {
      current = currentSetting(state.baby, key);
      familyChanged = state.baby.id !== setting.babyId || current !== setting.previous;
    } catch { familyChanged = true; }
  }
  const hasRef = !!threadId && !!messageId && !!toolCallId;
  const canChange = hasRef && samePhone && (local || !readOnly);
  const undoChanged = local && setting.status === "applied" && current !== setting.value;
  const disabled = pending || busy || !online || !canChange;

  const act = async (action: SettingAction["action"], retry?: PendingPhone) => {
    if (inflight.current || disabled) return;
    inflight.current = true;
    setPending(true);
    setProblem(null);
    let localChange = retry;
    try {
      if (local && !retry) {
        const before = currentPhone.current.values[key];
        if (action === "undo" && before !== setting.value) {
          setProblem("This preference changed again. Open this phone's settings to choose it now.");
          return;
        }
        const value = action === "undo" ? setting.previous : setting.value;
        currentPhone.current.set(key, value);
        localChange = { action, previous: before, value };
        setPhonePending(localChange);
      }
      const result = await api<SettingActionResult>("/api/maple/chat/settings", {
        method: "POST",
        body: JSON.stringify({ threadId, messageId, toolCallId, action, ...(local && action === "apply" ? { phonePrevious: localChange?.previous } : {}) }),
      });
      const parsed = settingProposalSchema.safeParse(result.setting);
      if (!parsed.success) throw new Error("The saved setting couldn't be read.");
      setSaved(parsed.data);
      setPhonePending(null);
      void refresh();
    } catch (error) {
      if (localChange) {
        // A preference can apply locally before its chat acknowledgment reaches the server.
        // Keep that true state visible and retry only the acknowledgment, never a second local write.
        setPhonePending(localChange);
        setProblem("Changed on this phone, but the chat couldn't record it. Try checking again.");
      } else if (error instanceof ApiError && error.status === 409) {
        setProblem("This setting or conversation changed. Open Settings to check its current value.");
        void refresh();
      } else {
        setProblem("Couldn't confirm this setting. Check again before changing it elsewhere.");
      }
    } finally {
      inflight.current = false;
      setPending(false);
    }
  };

  const value = phonePending?.value ?? (setting.status === "undone" ? setting.previous : setting.value);
  const changed = setting.status === "applied" || !!phonePending;
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label={`${setting.label} setting`} aria-busy={pending}>
      <div className="flex items-start gap-2">
        <Icon name={changed || setting.status === "undone" ? "check" : "pencil"} size={18} className="mt-0.5 shrink-0 text-mp-accent-fg" />
        <div className="min-w-0 flex-1">
          <h3 className={cx(tone.body, "text-[15px] font-semibold")}>{setting.label}</h3>
          <p className={cx(tone.muted, "text-[13px]")}>{local ? "This phone" : "Family"}</p>
        </div>
      </div>
      <div className="space-y-1 text-[15px] leading-snug wrap-anywhere">
        {setting.status === "proposed" && !phonePending && <p className={tone.muted}>Current: {settingValueLabel(key, current)}</p>}
        <p className={tone.body} role="status">{pending ? "Saving…" : phonePending ? "Changed on this phone: " : setting.status === "applied" ? "Saved: " : setting.status === "undone" ? "Restored: " : "Change to: "}{!pending && settingValueLabel(key, value)}</p>
      </div>
      {local && !samePhone && <p className={cx(tone.muted, "text-[13px] leading-snug")}>This card is for the phone where it was requested. Ask again to change this phone.</p>}
      {undoChanged && !phonePending && <p className={cx(tone.muted, "text-[13px] leading-snug")}>Changed again since this card. Your current choice is {settingValueLabel(key, current)}.</p>}
      {familyChanged && <p className={cx(tone.muted, "text-[13px] leading-snug")}>This setting changed since the card was made. Check its current value in Settings.</p>}
      {problem && <p role="alert" className="text-[14px] leading-snug text-mp-danger">{problem}</p>}
      {canChange && setting.status !== "undone" && (
        <div className="flex flex-wrap gap-2">
          {phonePending
            ? <Button size="sm" variant="soft" disabled={disabled} onClick={() => void act(phonePending.action, phonePending)}>Check again</Button>
            : setting.status === "applied"
              ? <Button size="sm" variant="ghost" disabled={disabled || undoChanged} onClick={() => void act("undo")}>Undo</Button>
              : familyChanged
                ? <Button size="sm" variant="soft" onClick={() => app.go(settingsPage(key))}>Open Settings</Button>
                : <Button size="sm" disabled={disabled} onClick={() => void act("apply")}>Apply</Button>}
        </div>
      )}
    </section>
  );
}

/** Family values are a dated result; phone values are read here, on this device. */
export function SettingsSummary({ settings }: { settings: SettingsSnapshot }) {
  const phone = usePhoneSettings();
  const notifications = useNotifications();
  if (settings?.v !== 1 || !Array.isArray(settings.items)) return null;
  return (
    <section className={cx(tone.card, "space-y-3 p-4")} aria-label="Settings">
      <h3 className={cx(tone.body, "text-[15px] font-semibold")}>Family settings</h3>
      <p className={cx(tone.muted, "text-[13px]")}>As they were when this reply was made.</p>
      <dl className="space-y-2">
        {settings.items.map((item) => <div key={item.key} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[14px]"><dt className={tone.muted}>{item.label}</dt><dd className={cx(tone.body, "max-w-full wrap-anywhere")}>{settingValueLabel(item.key, item.value)}</dd></div>)}
      </dl>
      <h3 className={cx(tone.body, "border-t border-mp-line pt-3 text-[15px] font-semibold")}>On this phone</h3>
      <dl className="space-y-2 text-[14px]">
        <div className="flex justify-between gap-3"><dt className={tone.muted}>Units</dt><dd>{settingValueLabel("units", phone.values.units)}</dd></div>
        <div className="flex justify-between gap-3"><dt className={tone.muted}>Night look</dt><dd>{settingValueLabel("night", phone.values.night)}</dd></div>
        <div className="flex justify-between gap-3"><dt className={tone.muted}>Theme</dt><dd>{settingValueLabel("theme", phone.values.theme)}</dd></div>
        <div className="flex justify-between gap-3"><dt className={tone.muted}>Notifications</dt><dd>{notifications.value ?? "Checking…"}</dd></div>
      </dl>
      <Button variant="ghost" size="sm" onClick={() => notifications.open()}>Review notifications</Button>
    </section>
  );
}

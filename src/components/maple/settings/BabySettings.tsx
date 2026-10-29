"use client";

import { useRef, useState } from "react";
import { alertsOn } from "@/lib/maple/insights";
import { dayKey, formatDayLabel, formatTime } from "@/lib/maple/time";
import { formatLength, formatWeight } from "@/lib/maple/units";
import BirthSheet from "../BirthSheet";
import { useBabyWords, useFamilyOne } from "../familyWords";
import { Icon } from "../icons";
import { logSwitches } from "../MoreSheet";
import { Button, Segmented, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { GROUP, InputRow, SaveBar, Section, Toggle, telHref } from "./parts";
import { useSettingsDraft } from "./DraftContext";

type Profile = { name: string; nickname: string; due: string };
type Doctor = { pedName: string; pedPhone: string; afterHours: string; gaWeeks: string; feedHours: string };

const numOrNull = (s: string) => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export default function BabySettings({ section }: { section: "baby" | "doctor" | "today" }) {
  const { state, api, refresh, toast, readOnly, units, now } = useMaple();
  const w = useBabyWords();
  const one = useFamilyOne();
  const baby = state!.baby;
  const tz = baby.timezone;
  const settings = baby.settings;
  const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

  const profileSrc: Profile = { name: baby.name, nickname: baby.nickname ?? "", due: baby.due_date ?? "" };
  const doctorSrc: Doctor = {
    pedName: str(settings.pediatrician_name),
    pedPhone: str(settings.pediatrician_phone),
    afterHours: str(settings.after_hours_phone),
    gaWeeks: str(settings.gestational_age_weeks),
    feedHours: str(settings.feed_interval_hours),
  };
  const [pEdits, setPEdits] = useState<Partial<Profile>>({});
  const [dEdits, setDEdits] = useState<Partial<Doctor>>({});
  const [busy, setBusy] = useState<"profile" | "doctor" | null>(null);
  const [birthOpen, setBirthOpen] = useState(false);
  const [toggles, setToggles] = useState<Record<string, boolean>>({});
  const settingsInFlight = useRef(new Set<string>());
  const [savingSettings, setSavingSettings] = useState(new Set<string>());

  const p = { ...profileSrc, ...pEdits };
  const d = { ...doctorSrc, ...dEdits };
  const pDirty = (Object.keys(pEdits) as (keyof Profile)[]).some((k) => pEdits[k] !== profileSrc[k]);
  const dDirty = (Object.keys(dEdits) as (keyof Doctor)[]).some((k) => dEdits[k] !== doctorSrc[k]);
  useSettingsDraft(section, section === "baby" ? pDirty : section === "doctor" && dDirty);

  const save = async (which: "profile" | "doctor") => {
    let body: Record<string, unknown>;
    if (which === "profile") {
      if (!p.name.trim()) return toast(`${baby.sex ? w.He : "The baby"} needs a name!`, { tone: "error" });
      body = { name: p.name.trim(), nickname: p.nickname.trim() || null, due_date: p.due || null };
    } else {
      const ga = numOrNull(d.gaWeeks);
      const fh = numOrNull(d.feedHours);
      if (ga !== null && (Number.isNaN(ga) || ga < 22 || ga > 44)) return toast("Gestational age should be in weeks, like 39", { tone: "error" });
      if (fh !== null && (Number.isNaN(fh) || fh < 1 || fh > 8)) return toast("Feed interval should be in hours, like 3", { tone: "error" });
      body = {
        settings: {
          pediatrician_name: d.pedName.trim().slice(0, 80) || null,
          pediatrician_phone: d.pedPhone.trim().slice(0, 30) || null,
          after_hours_phone: d.afterHours.trim().slice(0, 30) || null,
          gestational_age_weeks: ga,
          feed_interval_hours: fh,
        },
      };
    }
    setBusy(which);
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
      if (which === "profile") setPEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([key, value]) => value !== pEdits[key as keyof Profile])));
      else setDEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([key, value]) => value !== dEdits[key as keyof Doctor])));
      toast("Saved");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const setSetting = async (key: string, value: boolean) => {
    if (settingsInFlight.current.has(key)) return;
    settingsInFlight.current.add(key);
    setSavingSettings(new Set(settingsInFlight.current));
    setToggles((t) => ({ ...t, [key]: value }));
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ settings: { [key]: value } }) });
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
    } finally {
      settingsInFlight.current.delete(key);
      setSavingSettings(new Set(settingsInFlight.current));
      setToggles((t) => {
        const next = { ...t };
        delete next[key];
        return next;
      });
    }
  };
  const flag = (key: string) => toggles[key] ?? settings[key] !== false;
  const [sex, setSex] = useState<"female" | "male" | "unset" | null>(null);
  const saveSex = async (value: "female" | "male" | "unset") => {
    setSex(value);
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify({ sex: value === "unset" ? null : value }) });
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save", { tone: "error" });
    } finally {
      setSex(null);
    }
  };
  // Off unless switched on (the others default on).
  const warnings = toggles.show_alerts ?? alertsOn(baby);

  const born = baby.born_at ? new Date(baby.born_at) : null;
  const bornDay = born ? formatDayLabel(dayKey(born, tz), dayKey(now(), tz), { long: true }) : "";
  const bornLine = born ? `Born ${/^(Today|Yesterday)$/.test(bornDay) ? bornDay.toLowerCase() : bornDay}${settings.birth_time_approx === true ? ", time not recorded" : ` at ${formatTime(born, tz)}`}` : null;
  const stats = [
    baby.birth_weight_g ? formatWeight(baby.birth_weight_g, units) : null,
    baby.birth_length_cm ? `${formatLength(baby.birth_length_cm, units)} long` : null,
    baby.birth_head_cm ? `head ${formatLength(baby.birth_head_cm, units)}` : null,
  ].filter(Boolean);

  const birthRow = (
    <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <p className={cx(tone.body, "text-[15px]")}>{bornLine ?? "Not born yet"}</p>
        <p className={cx(tone.muted, "text-[13px] tabular-nums")}>
          {born ? (stats.length ? stats.join(" · ") : "Weight and length not added yet") : baby.due_date ? `Due ${formatDayLabel(baby.due_date, dayKey(now(), tz), { long: true })}` : "Any day now"}
        </p>
      </div>
      {!readOnly && (
        <Button variant={born ? "ghost" : "primary"} size="sm" className={born ? "-mr-3" : undefined} onClick={() => setBirthOpen(true)}>
          {born ? "Edit" : `${w.Hes} here!`}
        </Button>
      )}
    </div>
  );

  if (readOnly) {
    const phone = doctorSrc.pedPhone;
    return (
      <>
        <Section title={w.name} id="baby-details">
          <div className={GROUP}>
            <p className="flex flex-wrap items-baseline gap-x-2 px-4 py-3.5">
              <span className={cx(tone.display, "text-[24px] leading-tight")}>{baby.name}</span>
              {baby.nickname && <span className={cx(tone.muted, "text-sm")}>“{baby.nickname}”</span>}
            </p>
            {birthRow}
            {doctorSrc.pedName && <p className={cx(tone.body, "px-4 py-3 text-[15px]")}>{doctorSrc.pedName}</p>}
            {phone && (
              <a href={telHref(phone)} className={cx(tone.row, "min-h-[52px]")}>
                <Icon name="phone" size={20} className="shrink-0 text-mp-accent-fg" />
                <span className={cx(tone.body, "flex-1 text-[15px]")}>Pediatrician</span>
                <span className="text-[15px] font-medium text-mp-accent-fg tabular-nums">{phone}</span>
              </a>
            )}
          </div>
        </Section>
      </>
    );
  }

  return (
    <>
      {section === "baby" && <Section title={w.name} id="baby-details" footnote="Edit these details, then save your changes.">
        <div className={GROUP}>
          <InputRow label="Name" value={p.name} maxLength={80} onChange={(e) => setPEdits((x) => ({ ...x, name: e.target.value }))} />
          <InputRow
            label="Nickname"
            value={p.nickname}
            maxLength={40}
            placeholder={baby.name.split(" ")[0]}
            onChange={(e) => setPEdits((x) => ({ ...x, nickname: e.target.value }))}
          />
          <InputRow label="Due date" type="date" value={p.due} onChange={(e) => setPEdits((x) => ({ ...x, due: e.target.value }))} />
          {birthRow}
          {!one && (
            <div className="px-4 py-3">
              <p className={cx(tone.body, "text-[15px]")}>Growth charts</p>
              <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>WHO&apos;s charts are separate for girls and boys. Not set shows the measurements alone.</p>
              <Segmented
                aria-label="Growth charts"
                className="mt-2.5"
                value={sex ?? baby.sex ?? "unset"}
                onChange={(v) => void saveSex(v)}
                options={[
                  { value: "female", label: "Girl" },
                  { value: "male", label: "Boy" },
                  { value: "unset", label: "Not set" },
                ]}
              />
            </div>
          )}
        </div>
        {pDirty && <SaveBar busy={busy === "profile"} onSave={() => void save("profile")} onCancel={() => setPEdits({})} />}
      </Section>}

      {section === "doctor" && <Section title={`${w.His} doctor`} id="doctor-contacts" footnote="Edit these details, then save your changes.">
        <div className={GROUP}>
          <InputRow label="Pediatrician name" value={d.pedName} maxLength={80} onChange={(e) => setDEdits((x) => ({ ...x, pedName: e.target.value }))} />
          <PhoneRow label="Pediatrician" value={d.pedPhone} saved={doctorSrc.pedPhone} onChange={(v) => setDEdits((x) => ({ ...x, pedPhone: v }))} />
          <PhoneRow label="After-hours line" value={d.afterHours} saved={doctorSrc.afterHours} onChange={(v) => setDEdits((x) => ({ ...x, afterHours: v }))} />
          {/* These only tune the reminders. */}
          {warnings && (
            <>
              <InputRow
                label="Weeks at birth"
                note="Born before 37 weeks or under 5½ lb? Maple's reminders step back and defer to your pediatrician's plan."
                inputMode="numeric"
                placeholder="e.g. 39"
                value={d.gaWeeks}
                onChange={(e) => setDEdits((x) => ({ ...x, gaWeeks: e.target.value.replace(/[^\d.]/g, "") }))}
              />
              <InputRow
                label="Feed every … hours (optional)"
                note={`Only if ${w.his} pediatrician gave you a number. It replaces the built-in feeding reminders.`}
                inputMode="decimal"
                placeholder="e.g. 3"
                value={d.feedHours}
                onChange={(e) => setDEdits((x) => ({ ...x, feedHours: e.target.value.replace(/[^\d.]/g, "") }))}
              />
            </>
          )}
        </div>
        {dDirty && <SaveBar busy={busy === "doctor"} onSave={() => void save("doctor")} onCancel={() => setDEdits({})} />}
      </Section>}

      {section === "today" && <Section title="On Today" footnote="Changes save immediately for everyone in this log.">
        <div className={GROUP}>
          <Toggle
            label="Warnings & reminders"
            hint="Feed gaps, diaper counts, weight, vitamin D and checkups. They only make sense when everything gets logged. A temperature, oxygen reading or poop color is still checked as you enter it."
            checked={warnings}
            disabled={savingSettings.has("show_alerts")}
            onChange={(v) => void setSetting("show_alerts", v)}
          />
          {warnings && (
            <Toggle
              label="Vitamin D reminder"
              hint="A gentle evening nudge if no vitamin D drops are logged that day."
              checked={flag("vitamin_d_reminder")}
              disabled={savingSettings.has("vitamin_d_reminder")}
              onChange={(v) => void setSetting("vitamin_d_reminder", v)}
            />
          )}
          <Toggle
            label="Show diaper brigade"
            hint="Who changed how many this week, nights included."
            checked={flag("show_brigade")}
            disabled={savingSettings.has("show_brigade")}
            onChange={(v) => void setSetting("show_brigade", v)}
          />
          <Toggle
            label="Nursing"
            hint="Left and Right on Today. Running feeds and nursing already logged still show."
            checked={toggles.track_nursing ?? logSwitches(baby).nursing}
            disabled={savingSettings.has("track_nursing")}
            onChange={(v) => void setSetting("track_nursing", v)}
          />
          <Toggle
            label="Bottles"
            hint="The Bottle button on Today. Bottles already logged still show."
            checked={flag("feeds_bottle")}
            disabled={savingSettings.has("feeds_bottle")}
            onChange={(v) => void setSetting("feeds_bottle", v)}
          />
          <Toggle
            label="Pumping"
            hint="Pump in More. Off, it's hidden; pumping already logged still shows."
            checked={flag("track_pump")}
            disabled={savingSettings.has("track_pump")}
            onChange={(v) => void setSetting("track_pump", v)}
          />
        </div>
      </Section>}
      <BirthSheet open={birthOpen} onClose={() => setBirthOpen(false)} mode={born ? "edit" : "birth"} />
    </>
  );
}

function PhoneRow({ label, value, saved, onChange }: { label: string; value: string; saved: string; onChange: (v: string) => void }) {
  return (
    <InputRow
      label={label}
      type="tel"
      inputMode="tel"
      autoComplete="off"
      // Not a sample number: borderless, it would read like a saved one at 3am.
      placeholder="Add number"
      aria-label={`${label} phone`}
      className="tabular-nums"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      after={
        saved ? (
          <a href={telHref(saved)} aria-label={`Call ${label}`} className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-mp-accent text-mp-on-accent">
              <Icon name="phone" size={16} strokeWidth={2} />
            </span>
          </a>
        ) : undefined
      }
    />
  );
}

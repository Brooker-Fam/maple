"use client";

import { useMemo, useState } from "react";
import { ROLE_WORDS, type Answer, type OnboardingView } from "@/lib/maple/onboarding/steps";
import { LegalLinks } from "../Legal";
import { Chip, cx, tone } from "../ui";
import { StepShell, TextInput } from "./StepShell";
import type { Onboarding } from "./useOnboarding";

type Props = { ob: Onboarding; view: OnboardingView };

export function WelcomeStep({ ob }: Props) {
  const [adult, setAdult] = useState(false);
  return (
    <StepShell step="welcome" ob={ob} canSave={adult} saveLabel="Continue" onSave={() => void ob.answer("welcome", { adult: true, terms: true })}>
      <label className="flex items-start gap-3">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--mp-accent)]" />
        <span className={cx(tone.body, "text-[15px] leading-snug")}>I&apos;m 18 or older, I live in the US, and I agree to the terms and privacy policy.</span>
      </label>
      <LegalLinks className="-ml-2 justify-start" />
    </StepShell>
  );
}

export function YouStep({ ob, view }: Props) {
  const [name, setName] = useState(view.values.you.name ?? "");
  const known = (ROLE_WORDS as readonly string[]).includes(view.values.you.role_word ?? "");
  const [word, setWord] = useState<string | null>(view.values.you.role_word ?? null);
  const [other, setOther] = useState(!known && !!view.values.you.role_word);
  return (
    <StepShell step="you" ob={ob} canSave={!!name.trim()} onSave={() => void ob.answer("you", { name, role_word: word })}>
      <TextInput label="Your first name" value={name} onChange={setName} autoComplete="given-name" />
      <div className="space-y-1.5">
        <span className={tone.label}>What the baby will call you</span>
        <div className="flex flex-wrap gap-2">
          {ROLE_WORDS.map((w) => (
            <Chip
              key={w}
              selected={!other && word === w}
              onClick={() => {
                setOther(false);
                setWord(word === w ? null : w);
              }}
            >
              {w}
            </Chip>
          ))}
          <Chip
            selected={other}
            onClick={() => {
              setOther(!other);
              setWord(null);
            }}
          >
            Other
          </Chip>
        </div>
        {other && <TextInput label="Your word" value={word ?? ""} onChange={(v) => setWord(v || null)} />}
      </div>
    </StepShell>
  );
}

const US_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico"];

function allZones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
  return list?.length ? list : US_ZONES;
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function TimezoneStep({ ob, view }: Props) {
  const zones = useMemo(() => allZones(), []);
  const [tz, setTz] = useState(() => (view.done.timezone ? view.values.timezone.timezone : (browserZone() ?? view.values.timezone.timezone)));
  const [units, setUnits] = useState(view.values.timezone.units);
  const rest = zones.filter((z) => !US_ZONES.includes(z));
  const label = (z: string) => z.replace(/_/g, " ");
  return (
    <StepShell step="timezone" ob={ob} onSave={() => void ob.answer("timezone", { timezone: tz, units })}>
      <label className="block space-y-1.5">
        <span className={tone.label}>Timezone</span>
        <select value={tz} onChange={(e) => setTz(e.target.value)} className={tone.input}>
          {!zones.includes(tz) && <option value={tz}>{label(tz)}</option>}
          <optgroup label="United States">
            {US_ZONES.map((z) => (
              <option key={z} value={z}>
                {label(z)}
              </option>
            ))}
          </optgroup>
          <optgroup label="Everywhere else">
            {rest.map((z) => (
              <option key={z} value={z}>
                {label(z)}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <div className="space-y-1.5">
        <span className={tone.label}>Units</span>
        <div className="flex flex-wrap gap-2">
          <Chip selected={units === "us"} onClick={() => setUnits("us")}>
            lb, oz, °F
          </Chip>
          <Chip selected={units === "metric"} onClick={() => setUnits("metric")}>
            kg, °C
          </Chip>
        </div>
      </div>
    </StepShell>
  );
}

export function BabyNameStep({ ob, view }: Props) {
  const saved = view.done.baby_name === "answered";
  const [name, setName] = useState(saved ? (view.values.baby?.name ?? "") : "");
  const [nickname, setNickname] = useState(view.values.baby?.nickname ?? "");
  return (
    <StepShell step="baby_name" ob={ob} canSave={!!name.trim()} onSave={() => void ob.answer("baby_name", { name, nickname: nickname || null })}>
      <TextInput label="Baby's name" value={name} onChange={setName} />
      <TextInput label="Nickname (optional)" value={nickname} onChange={setNickname} />
      <p className={cx(tone.faint, "text-[13px]")}>Haven&apos;t picked yet? Skip it, and the log says &quot;Baby&quot; until you do.</p>
    </StepShell>
  );
}

const todayKey = () => new Date().toLocaleDateString("en-CA");

export function BirthStep({ ob, view }: Props) {
  const b = view.values.baby;
  const [born, setBorn] = useState<boolean | null>(view.done.birth ? !!b?.born_at : null);
  const [date, setDate] = useState(b?.born_at ? new Date(b.born_at).toLocaleDateString("en-CA", { timeZone: view.values.timezone.timezone }) : "");
  const [time, setTime] = useState("");
  const [noTime, setNoTime] = useState(false);
  const [due, setDue] = useState(b?.due_date ?? "");
  const value: Answer["birth"] | null = born === true ? (date ? { born: true, date, time: noTime || !time ? null : time } : null) : born === false ? (due ? { born: false, due } : null) : null;
  return (
    <StepShell step="birth" ob={ob} canSave={!!value && (born === false || noTime || !!time)} onSave={() => value && void ob.answer("birth", value)}>
      <div className="flex flex-wrap gap-2">
        <Chip selected={born === true} onClick={() => setBorn(true)}>
          The baby is here
        </Chip>
        <Chip selected={born === false} onClick={() => setBorn(false)}>
          Still waiting
        </Chip>
      </div>
      {born === true && (
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Birth date" type="date" value={date} onChange={setDate} max={todayKey()} />
          {!noTime && <TextInput label="Time" type="time" value={time} onChange={setTime} />}
          <label className="col-span-2 flex items-center gap-2.5">
            <input type="checkbox" checked={noTime} onChange={(e) => setNoTime(e.target.checked)} className="h-5 w-5 accent-[var(--mp-accent)]" />
            <span className={cx(tone.body, "text-[15px]")}>I&apos;m not sure of the time</span>
          </label>
        </div>
      )}
      {born === false && <TextInput label="Due date" type="date" value={due} onChange={setDue} />}
    </StepShell>
  );
}

export function SexStep({ ob }: Props) {
  const pick = (sex: "female" | "male" | null) => void ob.answer("sex", { sex });
  return (
    <StepShell step="sex" ob={ob} hideSave onSave={() => {}}>
      <div className="flex flex-wrap gap-2">
        <Chip onClick={() => pick("female")}>Girl</Chip>
        <Chip onClick={() => pick("male")}>Boy</Chip>
        <Chip onClick={() => pick(null)}>Prefer not to say</Chip>
      </div>
    </StepShell>
  );
}

export function FeedingStep({ ob, view }: Props) {
  const [f, setF] = useState(view.values.feeding ?? { nursing: false, pumping: false, formula: false });
  const toggle = (k: keyof typeof f) => setF({ ...f, [k]: !f[k] });
  return (
    <StepShell step="feeding" ob={ob} canSave={f.nursing || f.pumping || f.formula} onSave={() => void ob.answer("feeding", f)}>
      <p className={cx(tone.body, "text-[15px]")}>Pick any that fit.</p>
      <div className="flex flex-wrap gap-2">
        <Chip selected={f.nursing} onClick={() => toggle("nursing")}>
          Nursing
        </Chip>
        <Chip selected={f.pumping} onClick={() => toggle("pumping")}>
          Pumping
        </Chip>
        <Chip selected={f.formula} onClick={() => toggle("formula")}>
          Formula
        </Chip>
      </div>
    </StepShell>
  );
}

export function PediatricianStep({ ob, view }: Props) {
  const p = view.values.pediatrician;
  const [name, setName] = useState(p?.name ?? "");
  const [phone, setPhone] = useState(p?.phone ?? "");
  const [afterHours, setAfterHours] = useState(p?.after_hours ?? "");
  return (
    <StepShell
      step="pediatrician"
      ob={ob}
      canSave={!!(name.trim() || phone.trim() || afterHours.trim())}
      onSave={() => void ob.answer("pediatrician", { name: name || null, phone: phone || null, after_hours: afterHours || null })}
    >
      <TextInput label="Pediatrician or practice" value={name} onChange={setName} />
      <TextInput label="Office phone" type="tel" value={phone} onChange={setPhone} autoComplete="off" />
      <TextInput label="After-hours phone (optional)" type="tel" value={afterHours} onChange={setAfterHours} autoComplete="off" />
    </StepShell>
  );
}

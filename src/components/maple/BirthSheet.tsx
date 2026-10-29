"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { birthInstant, birthProblem } from "@/lib/maple/onboarding/steps";
import { dayKey, formatTime } from "@/lib/maple/time";
import { cmToIn, formatLength, formatWeight, gramsToLbOz, inToCm, lbOzToGrams } from "@/lib/maple/units";
import type { UnitSystem } from "@/lib/maple/types";
import { MapleLeaf, useStill } from "./art";
import { useBabyWords } from "./familyWords";
import { Icon } from "./icons";
import { useSheets } from "./sheets";
import { MiniStepper, useOpenCount } from "./sheets/parts";
import { useDraftChanged } from "./useDraftChanged";
import { Button, Field, Sheet, WhenField, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

type Mode = "birth" | "edit";

// Same bounds as PATCH /api/maple/baby.
const WEIGHT_G = [400, 7000] as const;
const LENGTH_CM = [25, 65] as const;
const HEAD_CM = [20, 45] as const;

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** cm → the number shown in the field for these units. */
const toShown = (cm: number | null, units: UnitSystem) => (cm == null ? null : units === "us" ? round(cmToIn(cm), 2) : round(cm, 1));
const fromShown = (v: number | null, units: UnitSystem) => (v == null ? null : units === "us" ? inToCm(v) : v);

/** "Born 4:12 AM · 7 lb 6 oz · 20 in long · head 13.5 in" */
export function birthLine(
  born: Date,
  tz: string,
  units: UnitSystem,
  stats: { weightG: number | null; lengthCm: number | null; headCm: number | null },
  timeKnown = true
): string {
  const bits = [timeKnown ? `Born ${formatTime(born, tz)}` : "Birth time not recorded"];
  if (stats.weightG) bits.push(formatWeight(stats.weightG, units));
  if (stats.lengthCm) bits.push(`${formatLength(stats.lengthCm, units)} long`);
  if (stats.headCm) bits.push(`head ${formatLength(stats.headCm, units)}`);
  return bits.join(" · ");
}

type Props = { open: boolean; onClose: () => void; mode?: Mode };

export default function BirthSheet(props: Props) {
  const count = useOpenCount(props.open);
  return <BirthForm key={count} {...props} />;
}

function BirthForm({ open, onClose, mode = "birth" }: Props) {
  const { state, units, now, api, log, refresh, toast } = useMaple();
  const words = useBabyWords();
  const baby = state?.baby;
  const tz = baby?.timezone ?? "America/New_York";

  const initialBorn = mode === "edit" && baby?.born_at ? new Date(baby.born_at) : null;
  const initialUnknown = mode === "edit" && baby?.settings.birth_time_approx === true;
  const lbOz = baby?.birth_weight_g ? gramsToLbOz(baby.birth_weight_g) : null;
  const [when, setWhen] = useState<Date | null>(initialBorn);
  const [timeInvalid, setTimeInvalid] = useState(false);
  const [timeUnknown, setTimeUnknown] = useState(initialUnknown);
  const [exactChosen, setExactChosen] = useState(!initialUnknown);
  const [birthDate, setBirthDate] = useState(() => dayKey(initialBorn ?? now(), tz));
  const [showStats, setShowStats] = useState(true);
  const [lb, setLb] = useState<number | null>(lbOz?.lb ?? null);
  const [oz, setOz] = useState<number | null>(lbOz?.oz ?? null);
  const [grams, setGrams] = useState<number | null>(baby?.birth_weight_g ? Math.round(baby.birth_weight_g) : null);
  const [length, setLength] = useState<number | null>(toShown(baby?.birth_length_cm ?? null, units));
  const [head, setHead] = useState<number | null>(toShown(baby?.birth_head_cm ?? null, units));
  const [saving, setSaving] = useState(false);
  // A typo in a measurement ("7..2") holds Save rather than dropping the number.
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const hasInvalid = Object.values(invalid).some(Boolean);
  const [problem, setProblem] = useState<string | null>(null);

  const dirty = useDraftChanged({ timeInvalid, when, timeUnknown, birthDate, showStats, lb, oz, grams, length, head, hasInvalid });

  if (!baby) return null;

  const weightG = !showStats ? null : units === "us" ? (lb == null && oz == null ? null : lbOzToGrams(lb ?? 0, oz ?? 0)) : grams;
  const lengthCm = showStats ? fromShown(length, units) : null;
  const headCm = showStats ? fromShown(head, units) : null;
  const firstName = baby.nickname || baby.name.split(" ")[0] || "Baby";

  const changeTimeCertainty = (unknown: boolean) => {
    setTimeInvalid(false);
    if (unknown && exactChosen) setBirthDate(dayKey(when ?? now(), tz));
    if (!unknown) {
      setWhen(null);
      setExactChosen(false);
    }
    setTimeUnknown(unknown);
  };

  const check = (): string | null => {
    if (!timeUnknown && !exactChosen) return "Choose the birth time, or keep it marked as unknown.";
    if (!timeUnknown && when && when.getTime() > now().getTime() + 10 * 60_000) return "That birth time is in the future.";
    if (timeUnknown) {
      if (!birthDate) return "Choose the birth date.";
      const issue = birthProblem({ born: true, date: birthDate, time: null }, tz, now());
      if (issue) return issue;
    }
    if (weightG != null && (weightG < WEIGHT_G[0] || weightG > WEIGHT_G[1])) return "That weight looks off. Check the numbers?";
    if (lengthCm != null && (lengthCm < LENGTH_CM[0] || lengthCm > LENGTH_CM[1])) return "That length looks off. Check the numbers?";
    if (headCm != null && (headCm < HEAD_CM[0] || headCm > HEAD_CM[1])) return "That head size looks off. Check the numbers?";
    return null;
  };

  const submit = async () => {
    if (timeInvalid) return;
    const issue = check();
    setProblem(issue);
    if (issue || saving) return;
    setSaving(true);
    const born = timeUnknown ? birthInstant({ date: birthDate, time: null }, tz) : when ?? now();
    const stats = {
      weightG: weightG == null ? null : Math.round(weightG),
      lengthCm: lengthCm == null ? null : round(lengthCm, 1),
      headCm: headCm == null ? null : round(headCm, 1),
    };
    const body: Record<string, unknown> = { born_at: born.toISOString(), settings: { birth_time_approx: timeUnknown ? true : null } };
    // Birth mode only sends what was filled in ("Add later" keeps any saved values);
    // edit mode saves exactly what's on screen, so clearing a field clears it.
    if (mode === "edit" || stats.weightG != null) body.birth_weight_g = stats.weightG;
    if (mode === "edit" || stats.lengthCm != null) body.birth_length_cm = stats.lengthCm;
    if (mode === "edit" || stats.headCm != null) body.birth_head_cm = stats.headCm;
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify(body) });
    } catch (e) {
      setSaving(false);
      setProblem(e instanceof Error && e.message ? e.message : "Couldn't save. Try again in a moment.");
      return;
    }

    if (mode === "edit") {
      setSaving(false);
      onClose();
      toast("Birth details saved");
      void refresh();
      return;
    }

    const line = birthLine(born, tz, units, stats, !timeUnknown);
    // One "Hello, world" moment, even if both parents tap "She's here!" at once:
    // the fixed client_id makes the server keep the first.
    const already = state?.entries.some((e) => e.kind === "moment" && e.data.milestone === "born");
    if (!already) {
      await log(
        {
          kind: "moment",
          client_id: `maple-born-${baby.id}`,
          started_at: born.toISOString(),
          data: { title: "Hello, world", milestone: "born" },
          note: line,
        },
        { silent: true }
      );
    }
    setSaving(false);
    onClose();
    const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(born);
    celebrateBirth({
      name: baby.name,
      when: timeUnknown ? `${day} · time not recorded` : `${day} · ${formatTime(born, tz)}`,
      stats: line.split(" · ").slice(1).join(" · "),
    });
    void refresh();
  };

  // The growth form's steppers: pounds beside ounces; length and head get full
  // rows, since "13.58 in" doesn't fit a half-width field.
  const statInput = (
    key: string,
    label: string | null,
    ariaLabel: string,
    value: number | null,
    set: (v: number | null) => void,
    opts: { step: number; decimals: number; unit: string; max: number }
  ) => (
    <MiniStepper
      key={key}
      label={label}
      ariaLabel={ariaLabel}
      value={value}
      onChange={set}
      step={opts.step}
      decimals={opts.decimals}
      unit={opts.unit}
      max={opts.max}
      onInvalid={(bad) => setInvalid((cur) => ({ ...cur, [key]: bad }))}
    />
  );
  const lenUnit = units === "us" ? "inches" : "centimetres";

  // A box-less wrapper: Family drops this sheet into a space-y list, whose
  // bottom margin would otherwise lift the (fixed) sheet off the screen's
  // bottom edge and let the tab bar show through under its footer.
  return (
    <div className="contents">
      <Sheet
        open={open}
        dirty={dirty}
        onClose={onClose}
        title={mode === "birth" ? `${words.Hes} here!` : "Birth details"}
        footer={
          <Button size="lg" className="w-full" onClick={() => void submit()} disabled={timeInvalid || saving || hasInvalid || (timeUnknown && !birthDate) || (!timeUnknown && !exactChosen)}>
            {saving ? "Saving…" : mode === "birth" ? `Welcome ${firstName}` : "Save"}
          </Button>
        }
      >
        {mode === "birth" && (
          <p className={cx(tone.muted, "text-[15px] leading-relaxed")}>
            Add {words.his} birth date and time, if you know it. Measurements can wait.
          </p>
        )}

        <label className="flex min-h-[44px] items-center gap-3">
          <input type="checkbox" className="h-5 w-5 accent-[var(--mp-accent)]" checked={timeUnknown} onChange={(e) => changeTimeCertainty(e.target.checked)} />
          <span className={cx(tone.body, "text-[15px]")}>Birth time not known</span>
        </label>
        {timeUnknown ? (
          <Field label="Birth date" hint="The log will show the date without a birth time.">
            <input type="date" aria-label="Birth date" className={tone.input} value={birthDate} max={dayKey(now(), tz)} onChange={(e) => setBirthDate(e.target.value)} />
          </Field>
        ) : (
          <div className="space-y-2">
            <WhenField label="Born" value={when} onInvalidChange={setTimeInvalid} onChange={(value) => { setWhen(value); setExactChosen(true); }} tz={tz} offsets={[15, 60, 180, 360]} />
            {!exactChosen && <p className={cx(tone.muted, "text-[13px]")}>Choose a time to replace the unknown birth time.</p>}
          </div>
        )}

        {showStats ? (
          <section aria-labelledby="birth-stats" className="space-y-4">
            <div className="mb-1.5 flex min-h-[36px] items-center justify-between gap-3">
              <h3 id="birth-stats" className={cx(tone.heading, "text-[17px]")}>
                Birth stats <span className="ml-1 text-[13px] font-normal text-mp-ink-3">Optional</span>
              </h3>
              {mode === "birth" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-3"
                  onClick={() => {
                    setShowStats(false);
                    setProblem(null);
                  }}
                >
                  Add later
                </Button>
              )}
            </div>
            {units === "us" ? (
              <div>
                <span className={cx(tone.label, "block")}>Weight</span>
                <div className="grid grid-cols-2 gap-3">
                  {statInput("lb", null, "weight in pounds", lb, setLb, { step: 1, decimals: 0, unit: "lb", max: 15 })}
                  {statInput("oz", null, "weight in ounces", oz, setOz, { step: 1, decimals: 1, unit: "oz", max: 15.9 })}
                </div>
              </div>
            ) : (
              statInput("grams", "Weight", "weight in grams", grams, setGrams, { step: 10, decimals: 0, unit: "g", max: 7000 })
            )}
            {statInput("length", "Length", `length in ${lenUnit}`, length, setLength, units === "us" ? { step: 0.25, decimals: 2, unit: "in", max: 26 } : { step: 0.5, decimals: 1, unit: "cm", max: 65 })}
            {statInput("head", "Head", `head in ${lenUnit}`, head, setHead, units === "us" ? { step: 0.25, decimals: 2, unit: "in", max: 18 } : { step: 0.5, decimals: 1, unit: "cm", max: 45 })}
          </section>
        ) : (
          <Button variant="soft" className="w-full" onClick={() => setShowStats(true)}>
            <Icon name="plus" size={18} />
            Add weight, length & head
          </Button>
        )}

        {problem && (
          <p role="alert" className="flex gap-2 rounded-2xl bg-mp-danger/10 px-4 py-3 text-sm font-medium text-mp-danger">
            <Icon name="circle-alert" size={18} className="mt-px shrink-0" />
            {problem}
          </p>
        )}
      </Sheet>
    </div>
  );
}

// ── Welcome celebration ──────────────────────────────────────────────────
// Lives outside the sheet (and outside Waiting, which unmounts the moment
// born_at is saved), so the shell renders <WelcomeHost /> once.

type Welcome = { name: string; when: string; stats: string };
let welcome: Welcome | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function celebrateBirth(w: Welcome) {
  welcome = w;
  emit();
}

function closeWelcome() {
  welcome = null;
  emit();
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
};

export function WelcomeHost() {
  const w = useSyncExternalStore(subscribe, () => welcome, () => null);
  const { open } = useSheets();
  const words = useBabyWords();
  const still = useStill();
  const actions = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!w) return;
    // Move focus into the dialog so screen readers and keyboards land on it.
    const t = window.setTimeout(() => actions.current?.querySelector("button")?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeWelcome();
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [w]);

  return (
    <AnimatePresence>
      {w && (
        <motion.div
          key="welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="maple-welcome-title"
          className="fixed inset-0 z-[85] flex items-center justify-center overflow-hidden bg-mp-bg px-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: still ? 0.15 : 0.5 }}
        >
          <motion.div
            className="relative w-full max-w-sm text-center"
            initial={still ? false : { y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.6, ease: "easeOut" }}
          >
            {/* The one bit of celebration: her leaf springs in (held still at night). */}
            <motion.div
              className="mx-auto mb-5 w-fit"
              initial={still ? false : { scale: 0.4, rotate: -40 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", damping: 12, stiffness: 120, delay: 0.35 }}
            >
              <MapleLeaf size={88} className="[.maple-night_&]:opacity-70" />
            </motion.div>
            <p className={cx(tone.muted, "text-[20px]")}>Welcome to the world,</p>
            <h2 id="maple-welcome-title" className={cx(tone.display, "mt-1 text-[44px] leading-[1.05]")}>
              {w.name}
            </h2>
            <p className={cx(tone.body, "mt-5 text-[15px] font-semibold tabular-nums")}>{w.when}</p>
            {w.stats && <p className={cx(tone.muted, "mt-0.5 text-[15px] tabular-nums")}>{w.stats}</p>}
            <p className={cx(tone.muted, "mt-4 text-[15px]")}>The whole forest is glad you&apos;re here.</p>
            <div ref={actions} className="mt-8 grid gap-2">
              <Button
                size="lg"
                className="w-full"
                onClick={() => {
                  closeWelcome();
                  open({ kind: "moment", preset: { title: "First photo" } });
                }}
              >
                <Icon name="camera" size={20} />
                Add {words.his} first photo
              </Button>
              <Button variant="ghost" className="w-full" onClick={closeWelcome}>
                Later
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

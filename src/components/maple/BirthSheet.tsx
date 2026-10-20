"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatTime } from "@/lib/maple/time";
import { cmToIn, formatLength, formatWeight, gramsToLbOz, inToCm, lbOzToGrams } from "@/lib/maple/units";
import type { UnitSystem } from "@/lib/maple/types";
import { FallingLeaves, MapleLeaf, useStill } from "./art";
import { useSheets } from "./sheets";
import { Button, Sheet, Stepper, WhenField, cx, tone } from "./ui";
import { useMaple } from "./useMaple";

/**
 * "She's here!" — the birth form. Only the time is required (defaulting to
 * now); weight, length and head can wait. Saving sets born_at, keeps a
 * "Hello, world" moment with her birth stats, and opens the welcome
 * celebration. mode="edit" reuses the form from Family to fix the details
 * later, without the celebration.
 */

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
  stats: { weightG: number | null; lengthCm: number | null; headCm: number | null }
): string {
  const bits = [`Born ${formatTime(born, tz)}`];
  if (stats.weightG) bits.push(formatWeight(stats.weightG, units));
  if (stats.lengthCm) bits.push(`${formatLength(stats.lengthCm, units)} long`);
  if (stats.headCm) bits.push(`head ${formatLength(stats.headCm, units)}`);
  return bits.join(" · ");
}

export default function BirthSheet({ open, onClose, mode = "birth" }: { open: boolean; onClose: () => void; mode?: Mode }) {
  const { state, units, now, api, log, refresh, toast } = useMaple();
  const baby = state?.baby;
  const tz = baby?.timezone ?? "America/New_York";

  const [when, setWhen] = useState<Date | null>(null);
  const [showStats, setShowStats] = useState(true);
  const [lb, setLb] = useState<number | null>(null);
  const [oz, setOz] = useState<number | null>(null);
  const [grams, setGrams] = useState<number | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  // A typo in a measurement ("7..2") holds Save rather than dropping the number.
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const hasInvalid = Object.values(invalid).some(Boolean);
  const [problem, setProblem] = useState<string | null>(null);

  // Fill in from what's saved each time the sheet opens.
  useEffect(() => {
    if (!open || !baby) return;
    const w = baby.birth_weight_g;
    const lbOz = w ? gramsToLbOz(w) : null;
    setWhen(mode === "edit" && baby.born_at ? new Date(baby.born_at) : null);
    setShowStats(true);
    setLb(lbOz ? lbOz.lb : null);
    setOz(lbOz ? lbOz.oz : null);
    setGrams(w ? Math.round(w) : null);
    setLength(toShown(baby.birth_length_cm, units));
    setHead(toShown(baby.birth_head_cm, units));
    setProblem(null);
    // Only on open: later baby/units changes shouldn't wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!baby) return null;

  const weightG = !showStats ? null : units === "us" ? (lb == null && oz == null ? null : lbOzToGrams(lb ?? 0, oz ?? 0)) : grams;
  const lengthCm = showStats ? fromShown(length, units) : null;
  const headCm = showStats ? fromShown(head, units) : null;
  const firstName = baby.nickname || baby.name.split(" ")[0] || "Maple";

  const check = (): string | null => {
    if (weightG != null && (weightG < WEIGHT_G[0] || weightG > WEIGHT_G[1])) return "That weight looks off. Check the numbers?";
    if (lengthCm != null && (lengthCm < LENGTH_CM[0] || lengthCm > LENGTH_CM[1])) return "That length looks off. Check the numbers?";
    if (headCm != null && (headCm < HEAD_CM[0] || headCm > HEAD_CM[1])) return "That head size looks off. Check the numbers?";
    return null;
  };

  const submit = async () => {
    const issue = check();
    setProblem(issue);
    if (issue || saving) return;
    setSaving(true);
    const born = when ?? now();
    const stats = {
      weightG: weightG == null ? null : Math.round(weightG),
      lengthCm: lengthCm == null ? null : round(lengthCm, 1),
      headCm: headCm == null ? null : round(headCm, 1),
    };
    const body: Record<string, unknown> = { born_at: born.toISOString() };
    // Birth mode only sends what was filled in ("Add later" keeps any saved values);
    // edit mode saves exactly what's on screen, so clearing a field clears it.
    if (mode === "edit" || stats.weightG != null) body.birth_weight_g = stats.weightG;
    if (mode === "edit" || stats.lengthCm != null) body.birth_length_cm = stats.lengthCm;
    if (mode === "edit" || stats.headCm != null) body.birth_head_cm = stats.headCm;
    try {
      await api("/api/maple/baby", { method: "PATCH", body: JSON.stringify(body) });
    } catch (e) {
      setSaving(false);
      setProblem(e instanceof Error && e.message ? e.message : "Couldn't reach the forest. Try again in a moment.");
      return;
    }

    if (mode === "edit") {
      setSaving(false);
      onClose();
      toast("Birth details saved", { emoji: "🍁" });
      void refresh();
      return;
    }

    const line = birthLine(born, tz, units, stats);
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
      when: `${day} · ${formatTime(born, tz)}`,
      stats: line.split(" · ").slice(1).join(" · "),
    });
    void refresh();
  };

  const statInput = (
    label: string,
    value: number | null,
    set: (v: number | null) => void,
    opts: { step: number; decimals: number; suffix: string; max: number }
  ) => (
    <div>
      <span className={cx(tone.label, "mb-1.5 block")}>{label}</span>
      <Stepper
        value={value}
        onChange={set}
        step={opts.step}
        decimals={opts.decimals}
        suffix={opts.suffix}
        max={opts.max}
        ariaLabel={label.toLowerCase()}
        onInvalid={(bad) => setInvalid((cur) => ({ ...cur, [label]: bad }))}
      />
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={mode === "birth" ? "She's here!" : "Birth details"}
      emoji="🍁"
      footer={
        <Button size="lg" className="w-full" onClick={() => void submit()} disabled={saving || hasInvalid}>
          {saving ? "Saving…" : mode === "birth" ? `Welcome ${firstName} 🍁` : "Save"}
        </Button>
      }
    >
      {mode === "birth" && (
        <p className={cx(tone.body, "text-[15px] leading-relaxed")}>
          Congratulations! Just her birth time for now. Everything else can wait.
        </p>
      )}

      <WhenField label="Born" value={when} onChange={setWhen} tz={tz} offsets={[15, 60, 180, 360]} />

      {showStats ? (
        <div className="space-y-4">
          <div className="flex items-end justify-between">
            <p className={cx(tone.heading, "text-lg")}>
              Birth stats <span className={cx(tone.muted, "font-[family-name:var(--font-body)] text-sm font-normal")}>· optional</span>
            </p>
            {mode === "birth" && (
              <Button
                variant="ghost"
                size="sm"
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
            <div className="grid gap-3">
              {statInput("Weight · pounds", lb, setLb, { step: 1, decimals: 0, suffix: "lb", max: 15 })}
              {statInput("Weight · ounces", oz, setOz, { step: 1, decimals: 1, suffix: "oz", max: 15.9 })}
            </div>
          ) : (
            statInput("Weight", grams, setGrams, { step: 10, decimals: 0, suffix: "g", max: 7000 })
          )}
          {statInput("Length", length, setLength, units === "us" ? { step: 0.25, decimals: 2, suffix: "in", max: 26 } : { step: 0.5, decimals: 1, suffix: "cm", max: 65 })}
          {statInput("Head", head, setHead, units === "us" ? { step: 0.25, decimals: 2, suffix: "in", max: 18 } : { step: 0.5, decimals: 1, suffix: "cm", max: 45 })}
        </div>
      ) : (
        <Button variant="soft" className="w-full" onClick={() => setShowStats(true)}>
          ＋ Add weight, length & head
        </Button>
      )}

      {problem && (
        <p role="alert" className="rounded-2xl bg-[#B5452B]/10 px-4 py-3 text-sm font-medium text-[#9A3A24] dark:bg-[#E07A5F]/15 dark:text-[#F4A68F]">
          {problem}
        </p>
      )}
    </Sheet>
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
          className="fixed inset-0 z-[85] flex items-center justify-center overflow-hidden bg-[radial-gradient(ellipse_at_50%_35%,#FFF1D6_0%,#FDF8F0_55%,#F6E7D6_100%)] px-6 dark:bg-[radial-gradient(ellipse_at_50%_35%,#1E3A22_0%,#11261A_55%,#0B170D_100%)] [.maple-night_&]:bg-[#0B0F0A] [.maple-night_&]:bg-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: still ? 0.15 : 0.5 }}
        >
          <FallingLeaves count={22} />
          <motion.div
            className="relative w-full max-w-sm text-center"
            initial={still ? false : { y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.6, ease: "easeOut" }}
          >
            <motion.div
              className="mx-auto mb-4 w-fit"
              initial={still ? false : { scale: 0.4, rotate: -40 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", damping: 12, stiffness: 120, delay: 0.35 }}
            >
              <MapleLeaf size={92} />
            </motion.div>
            <p className={cx(tone.heading, "text-[26px] font-medium italic")}>Welcome to the world,</p>
            <h2 id="maple-welcome-title" className={cx(tone.heading, "mt-1 text-[52px] leading-[1.05]")}>
              {w.name}
            </h2>
            <p className={cx(tone.body, "mt-4 text-[15px] font-semibold")}>{w.when}</p>
            {w.stats && <p className={cx(tone.body, "mt-1 text-[15px]")}>{w.stats}</p>}
            <p className={cx(tone.muted, "mt-3 text-sm")}>The whole forest is glad you&apos;re here.</p>
            <div ref={actions} className="mt-8 grid gap-2">
              <Button
                size="lg"
                className="w-full"
                onClick={() => {
                  closeWelcome();
                  open({ kind: "moment", preset: { title: "First photo" } });
                }}
              >
                📷 Add her first photo
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

"use client";

/**
 * Typing an amount in either unit, with this phone's "Amounts in ml and oz" on
 * (useMaple volumeBoth): each amount field has an ml | oz switch beside it,
 * starting in the phone's unit (a feeding plan's amounts, in the plan's), and
 * says the other unit live under it ("= 2 oz"). What's saved is ml, as ever:
 * units.ts fieldAmount is a field's number for an amount, fieldMl what a typed
 * number saves. Off, the fields are as they were: no switch, no line.
 */
import { useCallback, useState } from "react";
import type { UnitSystem } from "@/lib/maple/types";
import { fieldAmount, fieldMl, otherUnits, volumeIn } from "@/lib/maple/units";
import { Segmented, cx, tone } from "../ui";

/**
 * A field's unit and the ml its numbers save. Switching keeps every amount:
 * each moves to the new unit, and the exact ml it was is kept for the save
 * while it still reads the same (70 ml reads 2.37 oz and still saves 70 ml,
 * where 2.37 oz typed would be 70.1), so a switch never changes it.
 */
export function useAmountUnit(initial: UnitSystem | (() => UnitSystem)) {
  const [unit, setUnit] = useState<UnitSystem>(initial);
  const [kept, setKept] = useState<ReadonlyMap<string, number>>(() => new Map());
  /** The exact ml a switch kept for this number in the field's unit, if any. */
  const exact = useCallback((shown: number) => kept.get(`${unit}:${shown}`), [kept, unit]);
  /** What a number in the field's unit saves (ml), or undefined while it's empty. */
  const toMl = useCallback((shown: number | null | undefined) => (shown == null ? undefined : exact(shown) ?? fieldMl(shown, unit)), [exact, unit]);
  /**
   * The field moved to `to`: each amount it holds (the ml it saves, undefined while empty) as `to` shows it, kept
   * exactly for the save. The caller puts the numbers back in its fields.
   */
  const moveTo = (to: UnitSystem, mls: readonly (number | undefined)[]): (number | null)[] => {
    const next = new Map(kept);
    const out = mls.map((ml) => {
      if (ml == null) return null;
      const shown = fieldAmount(ml, to);
      next.set(`${to}:${shown}`, ml);
      return shown;
    });
    setKept(next);
    setUnit(to);
    return out;
  };
  return { unit, toMl, exact, moveTo };
}

/**
 * An amount field's ml | oz switch: which unit it's typed in. 44px targets, so it sits beside a field's label. Only a
 * change reaches `onChange` (tapping the unit it's in leaves the number alone). `disabled` while a number reads wrong:
 * it couldn't move to the other unit, and the field says so.
 */
export function UnitSwitch({ value, onChange, label, disabled }: { value: UnitSystem; onChange: (u: UnitSystem) => void; label: string; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="w-[6.5rem] min-w-0 shrink-0 disabled:opacity-50">
      <Segmented<UnitSystem>
        aria-label={label}
        value={value}
        onChange={(u) => u !== value && onChange(u)}
        options={[
          { value: "metric", label: "ml" },
          { value: "us", label: "oz" },
        ]}
      />
    </fieldset>
  );
}

/** The amount in the other unit, live under its field ("= 2 oz", "= 59.1 ml"); nothing while it's empty or 0. */
export function OtherUnit({ ml, unit, className }: { ml: number | null | undefined; unit: UnitSystem; className?: string }) {
  if (ml == null || !(ml > 0)) return null;
  return <p className={cx(tone.muted, "mt-1.5 text-xs tabular-nums", className)}>= {volumeIn(ml, otherUnits(unit))}</p>;
}

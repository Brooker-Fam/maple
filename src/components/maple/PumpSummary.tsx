import type { DayStats } from "@/lib/maple/insights";
import { pumpAmountLabel, pumpSessionLabel } from "@/lib/maple/pump-summary";
import type { UnitSystem } from "@/lib/maple/types";
import { tone } from "./ui";

export function PumpSummary({ day, units }: { day: DayStats; units: UnitSystem }) {
  if (!day.pumpSessions) return <span className={tone.faint}>—</span>;
  return <>
    <span className="block">{pumpSessionLabel(day)}</span>
    <span className="block text-xs opacity-80">{pumpAmountLabel(day, units)}</span>
  </>;
}

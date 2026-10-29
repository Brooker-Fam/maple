import type { DayStats } from "./insights";
import { formatDuration } from "./time";
import type { UnitSystem } from "./types";
import { formatVolume, formatVolumeBoth } from "./units";

type PumpStats = Pick<DayStats, "pumpSessions" | "pumpSec" | "pumpMeasuredSessions" | "pumpMl">;

export function pumpSessionLabel(day: PumpStats): string {
  return `${day.pumpSessions} session${day.pumpSessions === 1 ? "" : "s"}${day.pumpSec > 0 ? ` · ${formatDuration(day.pumpSec)}` : ""}`;
}

export function pumpAmountLabel(day: PumpStats, units: UnitSystem | "both"): string {
  if (!day.pumpSessions) return "No sessions logged";
  if (!day.pumpMeasuredSessions) return "Amount not logged";
  const unmeasured = day.pumpSessions - day.pumpMeasuredSessions;
  const volume = units === "both" ? formatVolumeBoth(day.pumpMl) : formatVolume(day.pumpMl, units);
  return `${volume} logged${unmeasured ? ` · ${unmeasured} without amount` : ""}`;
}

export function pumpSummaryLabel(day: PumpStats): string {
  return `${pumpSessionLabel(day)} · ${pumpAmountLabel(day, "both")}`;
}

export function pumpTalliesJson(day: PumpStats) {
  return {
    pump_sessions: day.pumpSessions,
    pump_duration_logged: day.pumpSec > 0 ? formatDuration(day.pumpSec) : null,
    pump_measured_sessions: day.pumpMeasuredSessions,
    pumped: day.pumpMeasuredSessions ? formatVolumeBoth(day.pumpMl) : null,
  };
}

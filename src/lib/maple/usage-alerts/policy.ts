export const LEVELS = [50, 80, 100] as const;
export type Metric = { key: string; label: string; period: string; used: bigint; limit: bigint; money?: boolean };
export type Alert = { key: string; subject: string; body: string };

export function money(micro: bigint): string {
  const sign = micro < BigInt(0) ? "-" : "";
  const abs = micro < BigInt(0) ? -micro : micro;
  return `${sign}$${abs / BigInt(1_000_000)}.${String(abs % BigInt(1_000_000)).padStart(6, "0")}`;
}

export function thresholdAlerts(metrics: Metric[]): Alert[] {
  return metrics.flatMap((metric) => LEVELS.filter((level) => metric.limit > BigInt(0) && metric.used * BigInt(100) >= metric.limit * BigInt(level)).map((level) => {
    const value = (n: bigint) => metric.money ? money(n) : n.toString();
    return {
      key: `${metric.key}/${metric.period}/${level}`,
      subject: `Maple usage: ${metric.label} reached ${level}%`,
      body: `${metric.label} reached ${level}% of its limit.\n\nUsed: ${value(metric.used)}\nLimit: ${value(metric.limit)}\nPeriod: ${metric.period}\n\nCheck Maple's usage and limits before increasing a cap.`,
    };
  }));
}

export function decimalMicro(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match || value.length > 100) throw new Error("gateway_cost_invalid");
  const power = 6 + Number(match[3] ?? "0") - (match[2]?.length ?? 0);
  if (!Number.isSafeInteger(power) || Math.abs(power) > 100) throw new Error("gateway_cost_invalid");
  const digits = BigInt(match[1] + (match[2] ?? ""));
  if (power >= 0) return digits * BigInt(10) ** BigInt(power);
  const divisor = BigInt(10) ** BigInt(-power);
  return (digits + divisor / BigInt(2)) / divisor;
}

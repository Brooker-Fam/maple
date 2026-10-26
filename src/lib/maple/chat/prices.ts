import type { LanguageModelUsage } from "ai";

/**
 * Model prices in integer micro-dollars per million tokens (BigInt; never a
 * float). `long` applies once a single request's prompt passes `longAbove`
 * tokens. Cache writes are the 5-minute kind. Requests aren't pinned to US-only
 * inference, so its surcharge doesn't apply. A model with no row here can't
 * be priced, and the chat refuses to run on it.
 */

export type Price = { input: bigint; cacheRead: bigint; cacheWrite: bigint; output: bigint };
export type ModelPrice = { base: Price; longAbove: number; long: Price };

// AI Gateway /v1/models and Anthropic's pricing page, checked 2026-10-26.
export const PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-haiku-5.5": {
    base: { input: BigInt(100_000), cacheRead: BigInt(10_000), cacheWrite: BigInt(125_000), output: BigInt(500_000) },
    longAbove: 100_000,
    long: { input: BigInt(500_000), cacheRead: BigInt(50_000), cacheWrite: BigInt(625_000), output: BigInt(2_500_000) },
  },
};

const MILLION = BigInt(1_000_000);

export function priceFor(model: string): ModelPrice | null {
  return Object.hasOwn(PRICES, model) ? PRICES[model] : null;
}

export type StepTokens = { prompt: number; fresh: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };

const n = (v: number | undefined) => (Number.isFinite(v) && v! > 0 ? Math.round(v!) : 0);

/** One step's usage as whole token counts. `fresh` is the prompt that was neither read from nor written to the cache. */
export function stepTokens(u: Pick<LanguageModelUsage, "inputTokens" | "inputTokenDetails" | "outputTokens" | "outputTokenDetails">): StepTokens {
  const cacheRead = n(u.inputTokenDetails?.cacheReadTokens);
  const cacheWrite = n(u.inputTokenDetails?.cacheWriteTokens);
  const fresh = u.inputTokenDetails?.noCacheTokens != null ? n(u.inputTokenDetails.noCacheTokens) : Math.max(0, n(u.inputTokens) - cacheRead - cacheWrite);
  return {
    prompt: Math.max(n(u.inputTokens), fresh + cacheRead + cacheWrite),
    fresh,
    cacheRead,
    cacheWrite,
    output: n(u.outputTokens),
    reasoning: n(u.outputTokenDetails?.reasoningTokens),
  };
}

/** The step's cost, rounded to the nearest micro-dollar, and which price row it used. */
export function costMicro(model: string, price: ModelPrice, t: StepTokens): { micro: bigint; key: string } {
  const long = t.prompt > price.longAbove;
  const p = long ? price.long : price.base;
  const num = BigInt(t.fresh) * p.input + BigInt(t.cacheRead) * p.cacheRead + BigInt(t.cacheWrite) * p.cacheWrite + BigInt(t.output) * p.output;
  return { micro: (num + MILLION / BigInt(2)) / MILLION, key: long ? `${model}>${price.longAbove}` : model };
}

/** "$0.00295" for a cost in micro-dollars (display only). */
export function dollars(micro: bigint): string {
  const neg = micro < BigInt(0);
  const a = neg ? -micro : micro;
  return `${neg ? "-" : ""}$${a / MILLION}.${(a % MILLION).toString().padStart(6, "0").replace(/0{1,4}$/, "")}`;
}

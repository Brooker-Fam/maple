import type { LanguageModelUsage } from "ai";

/**
 * Model prices in integer micro-dollars per million tokens (BigInt; never a
 * float). `long` applies once a single request's prompt passes `long.above`
 * tokens. Anthropic's cache writes are the 5-minute kind; a model that lists
 * no cache-write price is billed for writes at its input price. Requests
 * aren't pinned to US-only inference, so its surcharge doesn't apply. A
 * model with no row here can't be priced, and the chat refuses to run on it.
 *
 * `providers` is the Gateway's `only` for the model: each one keeps nothing,
 * trains on nothing and charges at most the row, so what the budgets count
 * is what's billed. A provider missing from it is never asked.
 */

export type Price = { input: bigint; cacheRead: bigint; cacheWrite: bigint; output: bigint };
export type ModelPrice = { base: Price; long?: { above: number; price: Price }; providers: readonly string[] };

// AI Gateway /v1/models and /v1/models/{model}/endpoints, and Anthropic's pricing page, checked 2026-10-26.
export const PRICES: Record<string, ModelPrice> = {
  "zai/glm-5.3-flash": {
    base: { input: BigInt(150_000), cacheRead: BigInt(30_000), cacheWrite: BigInt(150_000), output: BigInt(500_000) },
    // Not deepinfra, though it's cheaper: at its 10 tokens a second a reply outlasts the 25-second step.
    providers: ["baseten", "digitalocean", "fireworks", "parasail", "particle", "relace", "runware", "togetherai"],
  },
  "anthropic/claude-haiku-5.5": {
    base: { input: BigInt(100_000), cacheRead: BigInt(10_000), cacheWrite: BigInt(125_000), output: BigInt(500_000) },
    long: { above: 100_000, price: { input: BigInt(500_000), cacheRead: BigInt(50_000), cacheWrite: BigInt(625_000), output: BigInt(2_500_000) } },
    providers: ["anthropic", "bedrock", "vertexAnthropic"],
  },
  // These three: the Gateway's listing, checked 2026-10-27.
  "anthropic/claude-sonnet-5.5": {
    base: { input: BigInt(2_000_000), cacheRead: BigInt(100_000), cacheWrite: BigInt(2_500_000), output: BigInt(10_000_000) },
    providers: ["anthropic", "bedrock", "claudeaws", "vertexAnthropic"],
  },
  "openai/gpt-6-luna": {
    base: { input: BigInt(100_000), cacheRead: BigInt(10_000), cacheWrite: BigInt(125_000), output: BigInt(500_000) },
    long: { above: 272_000, price: { input: BigInt(200_000), cacheRead: BigInt(20_000), cacheWrite: BigInt(250_000), output: BigInt(750_000) } },
    // Not bedrock: no ZDR there.
    providers: ["azure", "openai"],
  },
  "alibaba/qwen3.8-flash": {
    base: { input: BigInt(150_000), cacheRead: BigInt(16_000), cacheWrite: BigInt(200_000), output: BigInt(470_000) },
    providers: ["alibaba"],
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
  const long = price.long && t.prompt > price.long.above ? price.long : null;
  const p = long ? long.price : price.base;
  const num = BigInt(t.fresh) * p.input + BigInt(t.cacheRead) * p.cacheRead + BigInt(t.cacheWrite) * p.cacheWrite + BigInt(t.output) * p.output;
  return { micro: (num + MILLION / BigInt(2)) / MILLION, key: long ? `${model}>${long.above}` : model };
}

/** "$0.00295" for a cost in micro-dollars (display only). */
export function dollars(micro: bigint): string {
  const neg = micro < BigInt(0);
  const a = neg ? -micro : micro;
  return `${neg ? "-" : ""}$${a / MILLION}.${(a % MILLION).toString().padStart(6, "0").replace(/0{1,4}$/, "")}`;
}

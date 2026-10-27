import { priceFor, type ModelPrice, type Price } from "../../src/lib/maple/chat/prices";

/**
 * A model's price row: prices.ts's when it has one (what the chat itself
 * charges against), else built from the Gateway's public listing, with
 * `providers` the ZDR, no-training endpoints at or under the listed price,
 * as prices.ts chooses them.
 */

const GATEWAY = "https://ai-gateway.vercel.sh/v1/models";

/** "0.00000015" dollars per token to micro-dollars per million tokens, without floats. */
export function microPerMillion(perToken: string | number | undefined | null): bigint | null {
  if (perToken == null) return null;
  const s = String(perToken).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Can't read the price "${s}"`);
  const frac = (m[2] ?? "").padEnd(13, "0");
  const whole = BigInt(m[1] + frac.slice(0, 12));
  return Number(frac[12]) >= 5 ? whole + BigInt(1) : whole;
}

type Listed = { input?: string; output?: string; input_cache_read?: string; input_cache_write?: string; input_tiers?: { cost: string; min: number }[]; output_tiers?: { cost: string; min: number }[]; input_cache_read_tiers?: { cost: string; min: number }[]; input_cache_write_tiers?: { cost: string; min: number }[] };
type Endpoint = { provider_name: string; has_zdr?: boolean; has_no_training?: boolean; pricing?: { prompt?: string; completion?: string; input_cache_read?: string } };

function priceOf(p: Listed, tier: number): Price {
  const at = (tiers: { cost: string }[] | undefined, flat: string | undefined) => microPerMillion(tiers?.[tier]?.cost ?? flat);
  const input = at(p.input_tiers, p.input);
  const output = at(p.output_tiers, p.output);
  if (input == null || output == null) throw new Error("The listing has no input or output price");
  return { input, output, cacheRead: at(p.input_cache_read_tiers, p.input_cache_read) ?? input, cacheWrite: at(p.input_cache_write_tiers, p.input_cache_write) ?? input };
}

export async function modelPrice(model: string): Promise<{ price: ModelPrice; source: string }> {
  const local = priceFor(model);
  if (local) return { price: local, source: "src/lib/maple/chat/prices.ts" };
  const list = (await (await fetch(GATEWAY)).json()) as { data: { id: string; pricing?: Listed }[] };
  const listed = list.data.find((m) => m.id === model)?.pricing;
  if (!listed) throw new Error(`${model} has no price in the Gateway's /v1/models listing`);
  const base = priceOf(listed, 0);
  const second = listed.input_tiers?.[1];
  const long = second ? { above: second.min - 1, price: priceOf(listed, 1) } : undefined;
  const eps = (await (await fetch(`${GATEWAY}/${model}/endpoints`)).json()) as { data?: { endpoints?: Endpoint[] } };
  const providers = (eps.data?.endpoints ?? [])
    .filter((e) => e.has_zdr && e.has_no_training)
    .filter((e) => {
      const p = e.pricing ?? {};
      const input = microPerMillion(p.prompt);
      const output = microPerMillion(p.completion);
      const read = microPerMillion(p.input_cache_read) ?? input;
      return input != null && output != null && read != null && input <= base.input && output <= base.output && read <= base.cacheRead;
    })
    .map((e) => e.provider_name);
  if (!providers.length) throw new Error(`${model} has no ZDR, no-training provider at or under its listed price`);
  return { price: { base, ...(long ? { long } : {}), providers }, source: "Gateway /v1/models listing" };
}

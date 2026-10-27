import { deliver, type DeliveryDeps } from "./delivery";
import { decimalMicro, money, type Alert } from "./policy";
import { rows, sent } from "./store";

export function previousMonth(now: Date): { period: string; start: string; end: string; until: string } {
  const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  return { period: start.slice(0, 7), start, end: new Date(until.getTime() - 1).toISOString().slice(0, 10), until: until.toISOString() };
}

export function reportMicro(raw: string): { cost: bigint; requests: bigint } {
  // Preserve the API's decimal money tokens before JSON.parse can round them through a float.
  const strings = raw.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => token.startsWith('"') ? token : JSON.stringify(token));
  const data = JSON.parse(strings) as { results?: { total_cost?: unknown; request_count?: unknown }[] };
  if (!Array.isArray(data.results)) throw new Error("gateway_report_invalid");
  return data.results.reduce((sum, row) => {
    if (typeof row.total_cost !== "string" || typeof row.request_count !== "string" || !/^\d+$/.test(row.request_count)) throw new Error("gateway_report_invalid");
    return { cost: sum.cost + decimalMicro(row.total_cost), requests: sum.requests + BigInt(row.request_count) };
  }, { cost: BigInt(0), requests: BigInt(0) });
}

export async function providerSpend(period: ReturnType<typeof previousMonth>, env: DeliveryDeps["env"], fetcher: typeof fetch = fetch): Promise<{ cost: bigint; requests: bigint }> {
  const token = env.AI_GATEWAY_API_KEY?.trim() || env.VERCEL_OIDC_TOKEN?.trim();
  if (!token) throw new Error("gateway_report_auth_missing");
  const url = new URL("https://ai-gateway.vercel.sh/v1/report");
  url.search = new URLSearchParams({ start_date: period.start, end_date: period.end, group_by: "day", tags: "maple-chat" }).toString();
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`gateway_report_http_${response.status}`);
  return reportMicro(await response.text());
}

export async function reconcileMonth(deps: DeliveryDeps, fetcher: typeof fetch = fetch): Promise<boolean> {
  const period = previousMonth(deps.now);
  const key = `reconciliation/${period.period}`;
  if (await sent(key)) return true;
  try {
    const [provider, local] = await Promise.all([
      providerSpend(period, deps.env, fetcher),
      rows(`SELECT COALESCE(SUM(cost_micro_usd), 0) AS cost, COUNT(*) AS steps FROM maple_ai_usage WHERE created_at >= $1 AND created_at < $2`, [`${period.start}T00:00:00.000Z`, period.until]),
    ]);
    const stored = BigInt(String(local[0].cost));
    const alert: Alert = {
      key,
      subject: `Maple chat reconciliation: ${period.period}`,
      body: `UTC month: ${period.period}\n\nMaple's recorded estimate: ${money(stored)}\nAI Gateway charged for the maple-chat tag: ${money(provider.cost)}\nGateway minus Maple: ${money(provider.cost - stored)}\nMaple steps: ${local[0].steps}\nGateway requests: ${provider.requests}\n\nReview differences in AI Gateway's usage report. Maple estimates tokens at configured model prices; the Gateway records charged cost. The shared maple-chat tag can also include synthetic evaluation requests. No chat content is included.`,
    };
    return await deliver(alert, deps);
  } catch {
    await deps.report(new Error("usage_reconciliation_failed"));
    await deliver({ key: `reconciliation-failed/${period.period}`, subject: "Maple chat reconciliation needs attention", body: `The usage check could not compare Maple's recorded chat spend with AI Gateway for ${period.period}.\n\nCheck the reporting endpoint, Gateway credentials and database. The next daily check will retry.` }, deps);
    return false;
  }
}

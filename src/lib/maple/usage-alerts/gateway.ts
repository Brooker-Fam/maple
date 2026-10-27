import { deliveryDeps, deliver, type DeliveryDeps } from "./delivery";

export function isCreditRefusal(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown, status?: number, depth = 0): boolean => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) return false;
    seen.add(value);
    const e = value as { statusCode?: unknown; type?: unknown; code?: unknown; error?: unknown; cause?: unknown; lastError?: unknown; response?: unknown; responseBody?: unknown; data?: unknown };
    const http = typeof e.statusCode === "number" ? e.statusCode : status;
    if (http === 402 && (e.type === "insufficient_funds" || e.code === "insufficient_funds")) return true;
    let body: unknown;
    if (typeof e.responseBody === "string" && e.responseBody.length < 100_000) {
      try { body = JSON.parse(e.responseBody); } catch {}
    }
    return [e.error, e.cause, e.lastError, e.response, e.data, body].some((nested) => visit(nested, http, depth + 1));
  };
  return visit(error);
}

export async function alertGatewayCredit(error: unknown, over: Partial<DeliveryDeps> = {}): Promise<void> {
  if (!isCreditRefusal(error)) return;
  const deps = deliveryDeps(over);
  try {
    await deliver({
      key: "gateway-credit/lifetime",
      subject: "Maple chat: AI Gateway credit ran out",
      body: "AI Gateway refused a Maple chat request because its credit balance was insufficient.\n\nCheck the guava-tri AI Gateway balance and Maple's project budget. Logging still works. No chat content is included in this notice.",
    }, deps);
  } catch {
    await deps.report(new Error("gateway_credit_alert_failed"));
  }
}

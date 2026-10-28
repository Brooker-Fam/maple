/** Public delivery metadata contains no message text and is scoped by the signed-in server session. */
export type ChatDelivery = { requestId: string; submittedAt: string };
export type ChatDeliveryStatus = {
  requestId: string;
  state: "missing" | "received" | "completed" | "cancelled";
  threadId: string | null;
  busy: boolean;
};

export const CHAT_REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
export const CHAT_QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** Only a bounded ISO instant is accepted; original values stay fixed across retries. */
export function parseDelivery(body: { requestId?: unknown; submittedAt?: unknown }): ChatDelivery | null {
  if (body.requestId === undefined && body.submittedAt === undefined) return null;
  if (typeof body.requestId !== "string" || !CHAT_REQUEST_ID_RE.test(body.requestId)) throw new Error("This message needs a valid delivery reference.");
  const time = typeof body.submittedAt === "string" && body.submittedAt.length <= 35 && /^\d{4}-\d{2}-\d{2}T/.test(body.submittedAt) ? Date.parse(body.submittedAt) : NaN;
  if (!Number.isFinite(time)) throw new Error("This message needs its original send time.");
  return { requestId: body.requestId, submittedAt: new Date(time).toISOString() };
}

export function deliveryTimeProblem(delivery: ChatDelivery, now: Date): string | null {
  const age = now.getTime() - Date.parse(delivery.submittedAt);
  if (age < -2 * 60_000) return "This message's time is ahead of the app. Check your phone's clock and send it again.";
  if (age > CHAT_QUEUE_MAX_AGE_MS) return "This message has been waiting for more than a week. Review it before sending it again.";
  return null;
}

import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { cleanPrefs, deleteSub, patchPrefs, saveSub, subFor, vapidKeys } from "@/lib/maple/push";

/**
 * Pill reminders on this phone (src/lib/maple/push.ts).
 *   GET    ?endpoint=…  → { publicKey, sub: { prefs } | null }  (the key to subscribe with, and this phone's settings)
 *   POST   { subscription: PushSubscriptionJSON, prefs?, device? } → { sub }  (turn on, or move the phone to this member)
 *   PATCH  { endpoint, prefs } → { sub }
 *   DELETE ?endpoint=…  (turn off)
 * Viewers can turn reminders on too, but they can't see her medicines, so
 * nothing about them reaches a viewer's phone.
 */

const endpointOf = (v: unknown): string => {
  if (typeof v !== "string" || !/^https:\/\/[^\s]{10,1000}$/.test(v)) throw new BadRequest("endpoint must be the push service URL");
  return v;
};

export const GET = withMember("GET /api/maple/push", async (request, me) => {
  const keys = vapidKeys();
  const endpoint = new URL(request.url).searchParams.get("endpoint");
  const sub = endpoint ? await subFor(me.email, endpointOf(endpoint)) : null;
  return json({ publicKey: keys?.publicKey ?? null, sub: sub ? { prefs: sub.prefs } : null });
});

export const POST = withMember("POST /api/maple/push", async (request, me) => {
  const body = await readJson<{ subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }; prefs?: unknown; device?: unknown }>(request);
  const s = body.subscription;
  const endpoint = endpointOf(s?.endpoint);
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) throw new BadRequest("subscription keys are missing");
  const device = typeof body.device === "string" ? body.device.slice(0, 80) : null;
  const sub = await saveSub(me.email, { endpoint, p256dh, auth }, cleanPrefs(body.prefs), device);
  return json({ sub: { prefs: sub.prefs } });
});

export const PATCH = withMember("PATCH /api/maple/push", async (request, me) => {
  const body = await readJson<{ endpoint?: unknown; prefs?: unknown }>(request);
  const sub = await patchPrefs(me.email, endpointOf(body.endpoint), cleanPrefs(body.prefs));
  if (!sub) return json({ error: "Reminders aren't on for this phone" }, 404);
  return json({ sub: { prefs: sub.prefs } });
});

export const DELETE = withMember("DELETE /api/maple/push", async (request, me) => {
  await deleteSub(me.email, endpointOf(new URL(request.url).searchParams.get("endpoint")));
  return json({ ok: true });
});

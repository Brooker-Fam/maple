import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { cleanDevice, deviceOf } from "@/lib/maple/device";
import { cleanPrefs, deleteSub, moveSub, patchPrefs, pushHealth, reminderFacts, saveSub, subFor, vapidKeys } from "@/lib/maple/push";

/**
 * Notifications on this phone (src/lib/maple/push.ts).
 *   GET    ?endpoint=…  → { publicKey, sub: { prefs } | null, health, reminders }
 *            health: the server's clock and this phone's last delivery and test (PushHealth);
 *            reminders: what each of her current medicines can notify about (null for viewers).
 *   POST   { subscription: PushSubscriptionJSON, prefs?, device?, replaces? } → { sub }
 *            Turn on, or move the phone to this member. The X-Maple-Device header is this
 *            install's id ("the other phone"). `replaces`: the worker's pushsubscriptionchange,
 *            whose new subscription keeps the old one's settings.
 *   PATCH  { endpoint, prefs } → { sub }
 *   DELETE ?endpoint=…  (turn off)
 * Viewers can turn notifications on too (the nursing timer), but they can't
 * see her medicines, so nothing about them reaches a viewer's phone.
 */

const endpointOf = (v: unknown): string => {
  if (typeof v !== "string" || !/^https:\/\/[^\s]{10,1000}$/.test(v)) throw new BadRequest("endpoint must be the push service URL");
  return v;
};

export const GET = withMember("GET /api/maple/push", async (request, me) => {
  const keys = vapidKeys();
  const raw = new URL(request.url).searchParams.get("endpoint");
  const endpoint = raw ? endpointOf(raw) : null;
  const sub = endpoint ? await subFor(me.email, endpoint) : null;
  const [health, reminders] = await Promise.all([pushHealth(me.email, sub ? endpoint : null), reminderFacts(me)]);
  return json({ publicKey: keys?.publicKey ?? null, sub: sub ? { prefs: sub.prefs } : null, health, reminders });
});

export const POST = withMember("POST /api/maple/push", async (request, me) => {
  const body = await readJson<{
    subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    prefs?: unknown;
    device?: unknown;
    device_id?: unknown;
    replaces?: unknown;
  }>(request);
  const s = body.subscription;
  const endpoint = endpointOf(s?.endpoint);
  const p256dh = s?.keys?.p256dh;
  const auth = s?.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) throw new BadRequest("subscription keys are missing");
  if (typeof body.replaces === "string" && body.prefs === undefined) {
    const moved = await moveSub(me.email, endpointOf(body.replaces), { endpoint, p256dh, auth });
    if (moved) return json({ sub: { prefs: moved.prefs } });
  }
  const label = typeof body.device === "string" ? body.device.slice(0, 80) : null;
  const deviceId = deviceOf(request) ?? cleanDevice(body.device_id);
  const sub = await saveSub(me.email, { endpoint, p256dh, auth }, cleanPrefs(body.prefs), label, { deviceId });
  return json({ sub: { prefs: sub.prefs } });
});

export const PATCH = withMember("PATCH /api/maple/push", async (request, me) => {
  const body = await readJson<{ endpoint?: unknown; prefs?: unknown }>(request);
  const sub = await patchPrefs(me.email, endpointOf(body.endpoint), cleanPrefs(body.prefs));
  if (!sub) return json({ error: "Notifications aren't on for this phone" }, 404);
  return json({ sub: { prefs: sub.prefs } });
});

export const DELETE = withMember("DELETE /api/maple/push", async (request, me) => {
  await deleteSub(me.email, endpointOf(new URL(request.url).searchParams.get("endpoint")));
  return json({ ok: true });
});

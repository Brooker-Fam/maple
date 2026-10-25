import { BadRequest, json, readJson, withMember } from "@/lib/maple/api";
import { cleanDevice, deviceOf } from "@/lib/maple/device";
import { later } from "@/lib/maple/push-hooks";
import { cleanPrefs, deleteSub, fillDeviceId, moveSub, patchPrefs, pushHealth, reminderFacts, saveSub, subFor, vapidKeys } from "@/lib/maple/push";

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
 * see her medicines, so nothing about them reaches a viewer's phone (nor
 * the health line's next wake-up and missed reminders, which are her
 * medicines' times).
 *
 * Turning a phone on or changing what it gets re-arms the exact-time
 * wake-ups after the response: a write with no phone on had nothing to arm.
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
  // A phone that was on before per-install ids: learn its id, so "Logged" skips the phone that logged.
  const device = deviceOf(request);
  if (sub && device && !sub.device_id) await fillDeviceId(sub.id, device);
  const [health, reminders] = await Promise.all([pushHealth(me.email, sub ? endpoint : null), reminderFacts(me)]);
  const shown = reminders === null ? { ...health, next_wake_at: null, missed: [] } : health;
  return json({ publicKey: keys?.publicKey ?? null, sub: sub ? { prefs: sub.prefs } : null, health: shown, reminders });
});

/** Publish the next wake-ups and the safety net now that this phone wants notices. */
const arm = () =>
  later(async () => {
    const { scheduleWakeups } = await import("@/lib/maple/push-wake");
    await scheduleWakeups();
  }, "maple push arm");

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
  const deviceId = deviceOf(request) ?? cleanDevice(body.device_id);
  if (typeof body.replaces === "string" && body.prefs === undefined) {
    const moved = await moveSub(me.email, endpointOf(body.replaces), { endpoint, p256dh, auth }, { deviceId });
    if (moved) {
      arm();
      return json({ sub: { prefs: moved.prefs } });
    }
  }
  const label = typeof body.device === "string" ? body.device.slice(0, 80) : null;
  const sub = await saveSub(me.email, { endpoint, p256dh, auth }, cleanPrefs(body.prefs), label, { deviceId });
  arm();
  return json({ sub: { prefs: sub.prefs } });
});

export const PATCH = withMember("PATCH /api/maple/push", async (request, me) => {
  const body = await readJson<{ endpoint?: unknown; prefs?: unknown }>(request);
  const sub = await patchPrefs(me.email, endpointOf(body.endpoint), cleanPrefs(body.prefs));
  if (!sub) return json({ error: "Notifications aren't on for this phone" }, 404);
  arm();
  return json({ sub: { prefs: sub.prefs } });
});

export const DELETE = withMember("DELETE /api/maple/push", async (request, me) => {
  await deleteSub(me.email, endpointOf(new URL(request.url).searchParams.get("endpoint")));
  return json({ ok: true });
});

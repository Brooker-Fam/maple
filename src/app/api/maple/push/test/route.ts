import { json, readJson, withMember } from "@/lib/maple/api";
import { HELLO_NOTICE, scheduleTest, sendPush, subFor, subsOf } from "@/lib/maple/push";

/**
 * POST { endpoint, in_seconds?, all? }
 *   in_seconds (e.g. 60): "Send a test in 1 minute". The test is due then and
 *   goes out through the real scheduled path (a QStash wake → tick → push
 *   service → worker → receipt), so it can be checked with the phone locked.
 *   → { ok, due_at, mode, phones }; GET /api/maple/push's health.test says how it went.
 *   all: true (owners): every phone signed in on this login gets one, the
 *   shared login's phones included.
 *   Without in_seconds: "Send one now", straight from here → { ok }.
 */
export const POST = withMember("POST /api/maple/push/test", async (request, me) => {
  const body = await readJson<{ endpoint?: unknown; in_seconds?: unknown; all?: unknown }>(request);
  const sub = typeof body.endpoint === "string" ? await subFor(me.email, body.endpoint) : null;
  const all = body.all === true && me.role === "owner";
  if (!sub && !all) return json({ error: "Notifications aren't on for this phone" }, 404);
  const secs = Number(body.in_seconds);
  if (body.in_seconds !== undefined && Number.isFinite(secs) && secs > 0) {
    const phones = all ? await subsOf(me.email) : [sub!];
    if (!phones.length) return json({ error: "No phone has notifications on yet" }, 404);
    let last: Awaited<ReturnType<typeof scheduleTest>> | null = null;
    for (const p of phones) last = await scheduleTest(p, secs);
    return json({ ok: true, ...last, phones: phones.length });
  }
  if (!sub) return json({ error: "Notifications aren't on for this phone" }, 404);
  const ok = await sendPush(sub, HELLO_NOTICE);
  return ok ? json({ ok: true }) : json({ error: "Couldn't reach this phone. Turn notifications off and on again." }, 502);
});

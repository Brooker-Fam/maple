import { json, readJson, withMember } from "@/lib/maple/api";
import { sendPush, subFor } from "@/lib/maple/push";

/** POST { endpoint } → sends "Reminders are on" to this phone, so the family can see one arrive. */
export const POST = withMember("POST /api/maple/push/test", async (request, me) => {
  const body = await readJson<{ endpoint?: unknown }>(request);
  const sub = typeof body.endpoint === "string" ? await subFor(me.email, body.endpoint) : null;
  if (!sub) return json({ error: "Reminders aren't on for this phone" }, 404);
  const ok = await sendPush(sub, {
    title: "Reminders are on",
    body: "Medicine reminders will show up here when one's OK again and at its set times.",
    tag: "test",
    url: "/maple?care=1",
  });
  return ok ? json({ ok: true }) : json({ error: "Couldn't reach this phone. Turn reminders off and on again." }, 502);
});

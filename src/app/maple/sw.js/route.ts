/**
 * Maple's service worker: notifications only (pill reminders, src/lib/maple/push.ts).
 * No fetch handler and no caching, so it never changes how the app loads.
 * Served from /maple/sw.js with Service-Worker-Allowed so it can control
 * /maple itself (the app registers it with scope "/maple").
 */
const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(
    self.registration.showNotification(d.title || "Maple's Log", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "/maple-icon-192.png",
      data: { url: d.url || "/maple" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/maple", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin + "/maple")) {
          return c.focus().then((w) => (w && "navigate" in w ? w.navigate(url) : w));
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
`;

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(SW, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/maple",
    },
  });
}

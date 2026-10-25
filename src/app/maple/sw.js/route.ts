/**
 * Maple's service worker: notifications only (src/lib/maple/push.ts).
 * No fetch handler and no caching, so it never changes how the app loads.
 * Served from /maple/sw.js with Service-Worker-Allowed so it can control
 * /maple itself (the app registers it with scope "/maple").
 *
 * - push: closes the notices the new one replaces before showing it (iOS
 *   ignores tag replacement): the same tag (one per medicine, med:<planId>;
 *   one per feed, nurse:<id>), any other feed's nursing notice, and medicine
 *   notices older than 12 hours. Two nursing updates that cross keep the
 *   newer one's words. Then it posts the receipt (/api/maple/push/receipt).
 * - notificationclick: an open app is focused and told where to go
 *   ({ type: "maple-open", url } with a MessageChannel; the app answers
 *   { ok: true } once it has moved there, so a half-filled sheet survives).
 *   No answer within 600 ms: the window is navigated. No window: one opens.
 * - pushsubscriptionchange (Chrome): the new subscription is saved with the
 *   old one's settings.
 * - message { type: "maple-sw-version" }: answers { version } on its port.
 */
const SW = `
const VERSION = 2;
const HALF_DAY = 12 * 3600 * 1000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function replaces(n, old) {
  const a = n.tag || "";
  const b = old.tag || "";
  if (a && a === b) return true;
  if (a.indexOf("nurse:") === 0 && b.indexOf("nurse:") === 0) return true;
  const od = old.data || {};
  return b.indexOf("med:") === 0 && typeof od.sent === "number" && Date.now() - od.sent > HALF_DAY;
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  const n = d.notification || d;
  e.waitUntil((async () => {
    const reg = self.registration;
    let title = n.title || "Maple's Log";
    let body = n.body || "";
    let data = Object.assign({}, n.data || {}, { url: n.navigate || n.url || "/maple" });
    try {
      const shown = await reg.getNotifications();
      for (const old of shown) {
        if (!replaces(n, old)) continue;
        const od = old.data || {};
        if (n.tag && old.tag === n.tag && data.ts && od.ts && od.ts > data.ts) {
          title = old.title;
          body = old.body;
          data = od;
        }
        old.close();
      }
    } catch (_) {}
    await reg.showNotification(title, {
      body,
      tag: n.tag || undefined,
      icon: "/maple-icon-192.png",
      silent: n.silent === true,
      data,
    });
    if (d.r) {
      try {
        await fetch("/api/maple/push/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ r: d.r, k: d.k }),
          keepalive: true,
        });
      } catch (_) {}
    }
  })());
});

function ask(w, msg, ms) {
  return new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      const t = setTimeout(() => resolve(null), ms);
      ch.port1.onmessage = (m) => { clearTimeout(t); resolve(m.data || null); };
      w.postMessage(msg, [ch.port2]);
    } catch (_) { resolve(null); }
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/maple", self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = list.find((x) => x.url.indexOf(self.location.origin + "/maple") === 0);
    if (!c) return self.clients.openWindow(url);
    let w = c;
    try { w = (await c.focus()) || c; } catch (_) {}
    const answer = await ask(w, { type: "maple-open", url }, 600);
    if (answer && answer.ok) return;
    try { if ("navigate" in w) await w.navigate(url); } catch (_) {}
  })());
});

self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const old = e.oldSubscription || null;
    let sub = e.newSubscription || null;
    if (!sub && old && old.options) sub = await self.registration.pushManager.subscribe(old.options);
    if (!sub) return;
    await fetch("/api/maple/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), replaces: old ? old.endpoint : null }),
    });
  })().catch(() => {}));
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "maple-sw-version" && e.ports && e.ports[0]) e.ports[0].postMessage({ version: VERSION });
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

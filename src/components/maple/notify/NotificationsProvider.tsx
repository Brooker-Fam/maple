"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { careTime, planTitle } from "@/lib/maple/care";
import { DEFAULT_TZ } from "@/lib/maple/time";
import { ApiError, useMaple } from "../useMaple";
import { MAPLE_OPEN_EVENT, NotificationsContext, OfferContext, type MapleOpenEvent, type Notifications, type Offer } from "./context";
import NotificationsSheet from "./NotificationsSheet";
import * as phone from "./phone";
import { notificationsValue, type NotifyStatus, type PushHealth, type PushPrefs, type ReminderFact } from "./words";

type Server = { publicKey: string | null; sub: { prefs: PushPrefs } | null; health: PushHealth; reminders: ReminderFact[] | null };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DENIED = "Notifications for Maple are off in Settings. On iPhone: Settings › Notifications › Maple.";
const enc = encodeURIComponent;

/** A line for a failed turn-on or change: the server's words, else plain ones (the browser's own messages are for developers). */
function problemText(e: unknown): string {
  if (e instanceof ApiError)
    return e.status < 500 && e.message && !/^Request failed/.test(e.message) ? e.message : "That didn't go through. Check the connection and try again.";
  if (e instanceof DOMException && e.name === "NotAllowedError") return DENIED;
  if (e instanceof Error && e.name === "Error" && e.message) return e.message;
  return "Couldn't turn notifications on. Try again in a moment.";
}

/**
 * Notifications on this phone, for the whole app: one provider (mounted once
 * in MapleApp, inside MapleProvider) holds this phone's state and renders the
 * Notifications sheet itself, portaled to <body> so it sits above whatever
 * sheet opened it. Server side: src/lib/maple/push.ts and /api/maple/push.
 *
 * It also keeps the phone honest while the app is open:
 *   - on load and on coming back to the app (at most once an hour) it
 *     re-checks the browser's subscription against what the server and this
 *     phone remember: an endpoint the browser swapped is saved again quietly,
 *     a subscription that's gone, made with an old key, or that the push
 *     service stopped accepting reads "Stopped", with a one-tap Turn on;
 *   - it closes notices the app has made stale (a medicine's "OK again" once
 *     a dose is logged, a finished feed's timer, anything over 12 hours old);
 *   - it answers the service worker's "maple-open" (a tapped notice) by
 *     handing the URL to the app (MAPLE_OPEN_EVENT), so an open sheet survives;
 *   - signing out turns this phone's notifications off.
 * Viewers can turn it on too (the nursing timer); her medicines never reach them.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { state, status: appStatus, api, toast, now: clock } = useMaple();
  const me = appStatus === "ready" ? (state?.me.email ?? null) : null;
  const [status, setStatus] = useState<NotifyStatus>("loading");
  const [prefs, setPrefsState] = useState<PushPrefs>({});
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [health, setHealth] = useState<PushHealth | null>(null);
  const [reminders, setReminders] = useState<ReminderFact[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [testDueAt, setTestDueAt] = useState<string | null>(null);

  // Actions read the latest values when they run, not the render they were made in.
  const live = useRef({ me, status, prefs, endpoint, state });
  live.current = { me, status, prefs, endpoint, state };

  // Bumped by every turn on or off: a check that started before one says nothing (it read the phone as it was).
  const epoch = useRef(0);

  /** Read the browser and the server; returns what this phone is now. */
  const check = useCallback(async (): Promise<NotifyStatus> => {
    const who = live.current.me;
    if (!who) return "loading";
    const started = epoch.current;
    if (!phone.supported()) {
      const s: NotifyStatus = phone.isIos() && !phone.standalone() ? "install" : "unsupported";
      setStatus(s);
      return s;
    }
    const perm = phone.permission();
    const sub = await phone.existing();
    const mark = phone.readMark();
    const mine = mark && mark.member === who ? mark : null;
    const settle = (s: NotifyStatus, ep: string | null = null) => {
      if (epoch.current !== started) return s;
      setStatus(s);
      setEndpoint(ep);
      return s;
    };
    // What the browser alone decides is said at once; the server's part (health, her medicines) follows.
    const early: NotifyStatus | null = perm === "denied" ? "denied" : !sub ? (mine ? "stopped" : "off") : null;
    if (early) settle(early);
    let res: Server | null = null;
    try {
      res = await api<Server>(`/api/maple/push${sub ? `?endpoint=${enc(sub.endpoint)}` : ""}`);
    } catch {
      // Offline or a hiccup: say what the browser alone knows, and keep the rest.
    }
    if (live.current.me !== who) return "loading";
    if (res && epoch.current === started) {
      setHealth(res.health);
      setReminders(res.reminders);
    }
    if (early || !sub) return early ?? settle("off");
    if (!res) return settle(mine && mine.endpoint === sub.endpoint ? "on" : "off", mine ? sub.endpoint : null);
    if (!phone.keyMatches(sub, res.publicKey)) return settle(res.sub || mine ? "stopped" : "off");
    if (epoch.current !== started) return live.current.status;
    if (res.sub) {
      setPrefsState(res.sub.prefs);
      phone.writeMark({ endpoint: sub.endpoint, member: who });
      return settle(res.health.needs_resubscribe ? "stopped" : "on", sub.endpoint);
    }
    if (mine && mine.endpoint !== sub.endpoint && perm === "granted") {
      // The browser swapped this phone's subscription: save the new one with the old one's settings.
      try {
        const saved = await api<{ sub: { prefs: PushPrefs } }>("/api/maple/push", {
          method: "POST",
          body: JSON.stringify({ subscription: sub.toJSON(), replaces: mine.endpoint, device: phone.deviceLabel() }),
        });
        if (epoch.current !== started) return live.current.status;
        setPrefsState(saved.sub.prefs);
        phone.writeMark({ endpoint: sub.endpoint, member: who });
        return settle("on", sub.endpoint);
      } catch {
        return settle("stopped");
      }
    }
    // Here before, and the server stopped sending to it (the push service said it was gone).
    if (mine) return settle("stopped");
    // Someone else's subscription on this phone (another member signed in here before): off for this reader.
    return settle("off");
  }, [api]);

  const refresh = useCallback(async () => {
    await check();
  }, [check]);

  const run = useCallback(async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    setBusy(true);
    setProblem(null);
    try {
      return await fn();
    } catch (e) {
      setProblem(problemText(e));
      return fallback;
    } finally {
      setBusy(false);
    }
  }, []);

  const turnOn = useCallback((): Promise<boolean> => {
    // Asked first, inside the tap, before anything awaits: iOS only shows the prompt for a user's gesture.
    let asked: Promise<NotificationPermission>;
    try {
      asked = phone.supported() ? Promise.resolve(Notification.requestPermission()) : Promise.resolve("denied");
    } catch {
      asked = Promise.resolve(phone.permission() ?? "denied");
    }
    if (!phone.supported()) {
      setOpen(true);
      return Promise.resolve(false);
    }
    // A stopped phone gets a fresh subscription: the old one is what stopped working.
    const fresh = live.current.status === "stopped";
    epoch.current++;
    return run(async () => {
      const who = live.current.me;
      if (!who) return false;
      // Older Safari answers through a callback instead: read where it landed.
      const perm = (await asked) ?? Notification.permission;
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "off");
        if (perm === "denied") setProblem(DENIED);
        return false;
      }
      const keys = await api<Server>("/api/maple/push");
      if (!keys.publicKey) throw new Error("Notifications aren't set up on the server yet.");
      const reg = await phone.worker();
      let sub = await reg.pushManager.getSubscription();
      const mark = phone.readMark();
      const old = sub?.endpoint ?? (mark && mark.member === who ? mark.endpoint : null);
      // A subscription made with another key can't be reused, and a stopped one gets a fresh start.
      if (sub && (!phone.keyMatches(sub, keys.publicKey) || fresh)) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: phone.keyBytes(keys.publicKey) });
      // A new subscription for a phone that had one keeps that phone's settings (`replaces`); otherwise this phone's choices.
      const body =
        old && old !== sub.endpoint
          ? { subscription: sub.toJSON(), replaces: old, device: phone.deviceLabel() }
          : { subscription: sub.toJSON(), prefs: live.current.prefs, device: phone.deviceLabel() };
      const saved = await api<{ sub: { prefs: PushPrefs } }>("/api/maple/push", { method: "POST", body: JSON.stringify(body) });
      phone.writeMark({ endpoint: sub.endpoint, member: who });
      epoch.current++;
      setPrefsState(saved.sub.prefs);
      setEndpoint(sub.endpoint);
      setStatus("on");
      void check();
      return true;
    }, false);
  }, [api, check, run]);

  const turnOff = useCallback(
    () =>
      run(async () => {
        epoch.current++;
        const sub = await phone.existing();
        const ep = sub?.endpoint ?? live.current.endpoint;
        // Off on this phone even when the server can't be told: an unsubscribed endpoint is dropped at its next send.
        if (ep) await api(`/api/maple/push?endpoint=${enc(ep)}`, { method: "DELETE" }).catch(() => null);
        await sub?.unsubscribe().catch(() => false);
        phone.writeMark(null);
        epoch.current++;
        setEndpoint(null);
        setStatus(phone.permission() === "denied" ? "denied" : "off");
      }, undefined),
    [api, run]
  );

  const setPrefs = useCallback(
    (p: PushPrefs) =>
      run(async () => {
        const ep = live.current.endpoint;
        if (!ep) return;
        const before = live.current.prefs;
        setPrefsState(p);
        try {
          const res = await api<{ sub: { prefs: PushPrefs } }>("/api/maple/push", { method: "PATCH", body: JSON.stringify({ endpoint: ep, prefs: p }) });
          setPrefsState(res.sub.prefs);
        } catch (e) {
          setPrefsState(before);
          throw e;
        }
      }, undefined),
    [api, run]
  );

  const testInOneMinute = useCallback(
    (opts: { all?: boolean } = {}) =>
      run(async () => {
        const ep = live.current.endpoint;
        if (!ep && !opts.all) return null;
        const res = await api<{ ok: boolean; due_at: string; phones: number }>("/api/maple/push/test", {
          method: "POST",
          body: JSON.stringify({ endpoint: ep, in_seconds: 60, ...(opts.all ? { all: true } : {}) }),
        });
        setTestDueAt(res.due_at);
        void check();
        return { due_at: res.due_at, phones: res.phones };
      }, null),
    [api, check, run]
  );

  const sendNow = useCallback(
    () =>
      run(async () => {
        const ep = live.current.endpoint;
        if (!ep) return false;
        await api("/api/maple/push/test", { method: "POST", body: JSON.stringify({ endpoint: ep }) });
        return true;
      }, false),
    [api, run]
  );

  const forgetThisPhone = useCallback(async (): Promise<boolean> => {
    if (!phone.supported()) return false;
    try {
      const sub = await phone.existing();
      const mark = phone.readMark();
      const ep = sub?.endpoint ?? live.current.endpoint ?? mark?.endpoint ?? null;
      if (!ep && !sub) return false;
      if (ep) {
        // Never hold sign-out up for long: the unsubscribe below stops it either way.
        const del = api(`/api/maple/push?endpoint=${enc(ep)}`, { method: "DELETE" }).catch(() => null);
        await Promise.race([del, new Promise((r) => window.setTimeout(r, 4000))]);
      }
      await sub?.unsubscribe().catch(() => false);
      phone.writeMark(null);
      epoch.current++;
      setEndpoint(null);
      setStatus("off");
      return true;
    } catch {
      return false;
    }
  }, [api]);

  const open = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  // ── signed in, signed out ─────────────────────────────────────────────

  // Signing out (or the session ending) turns this phone's notifications off: nobody signed in, nothing of hers arrives.
  // The server can't be told any more, but an unsubscribed endpoint is dropped at its next send.
  const lastApp = useRef(appStatus);
  useEffect(() => {
    const was = lastApp.current;
    lastApp.current = appStatus;
    if (was !== "ready" || appStatus !== "signedOut" || !phone.supported()) return;
    void phone.existing().then((sub) => sub?.unsubscribe().catch(() => false));
    phone.writeMark(null);
  }, [appStatus]);

  // A different reader (signed out, or another member on this phone) starts from scratch.
  const [shownFor, setShownFor] = useState<string | null>(me);
  if (shownFor !== me) {
    setShownFor(me);
    setStatus("loading");
    setPrefsState({});
    setEndpoint(null);
    setHealth(null);
    setReminders(null);
    setProblem(null);
    setTestDueAt(null);
    setOpen(false);
  }

  // ── the check on each open ─────────────────────────────────────────────

  const lastCheck = useRef(0);
  useEffect(() => {
    if (!me) return;
    lastCheck.current = 0;
    const keep = async () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck.current < HOUR) return;
      lastCheck.current = Date.now();
      // Re-checks the worker script too (it's served no-cache), so an old worker gets this version.
      void phone.registration().then((reg) => reg?.update().catch(() => {}));
      const s = await check();
      const now = Date.now();
      if ((s !== "stopped" && !(s === "denied" && phone.readMark())) || phone.stoppedSnoozed(now)) return;
      phone.snoozeStopped(now + DAY);
      if (s === "denied") {
        toast(DENIED, { tone: "info", icon: "bell" });
        return;
      }
      toast("Notifications stopped on this phone. Turn them back on?", {
        tone: "info",
        icon: "bell",
        actions: [{ label: "Turn on", onClick: () => void turnOn() }],
        undo: () => phone.snoozeStopped(Date.now() + 3 * DAY),
        undoLabel: "Not now",
      });
    };
    void keep();
    document.addEventListener("visibilitychange", keep);
    return () => document.removeEventListener("visibilitychange", keep);
  }, [me, check, toast, turnOn]);

  // ── stale notices on this phone ───────────────────────────────────────

  // What the app knows that makes a notice stale: her doses' newest times and Maple's timers' versions.
  const care = state?.care;
  const entries = state?.entries;
  const staleKey = useMemo(() => {
    const doses = (care?.entries ?? []).filter((e) => e.kind === "dose").map((e) => `${e.med_id}:${e.created_at}`);
    const feeds = (entries ?? [])
      .filter((e) => e.kind === "feed")
      .slice(0, 5)
      .map((e) => `${e.id}:${e.updated_at}:${e.active}`);
    return `${doses.length}|${doses.slice(0, 5).join(",")}|${feeds.join(",")}`;
  }, [care, entries]);
  useEffect(() => {
    if (!me || !phone.supported()) return;
    const tidy = async () => {
      if (document.visibilityState !== "visible") return;
      const reg = await phone.registration();
      if (!reg?.getNotifications) return;
      const s = live.current.state;
      const t = Date.now();
      try {
        for (const n of await reg.getNotifications()) {
          const tag = n.tag || "";
          const d = (n.data ?? {}) as { kind?: string; plan?: number; entry?: number; ts?: number; sent?: number };
          if (!tag.startsWith("med:") && !tag.startsWith("nurse:")) continue;
          if (typeof d.sent === "number" && t - d.sent > 12 * HOUR) {
            n.close();
            continue;
          }
          // "OK again" or a set time, once a dose (or skip) of that medicine has been logged since it went out.
          if ((d.kind === "ok" || d.kind === "at") && typeof d.plan === "number" && typeof d.sent === "number") {
            const sent = d.sent;
            if (s?.care?.entries.some((e) => e.kind === "dose" && e.med_id === d.plan && Date.parse(e.created_at) > sent)) n.close();
            continue;
          }
          // A feed's notice once the app shows that feed finished, from a state at least as new as the notice.
          if (d.kind === "nurse" && typeof d.entry === "number") {
            const e = s?.entries.find((x) => x.id === d.entry);
            if (e && !e.active && (typeof d.ts !== "number" || Date.parse(e.updated_at) >= d.ts)) n.close();
          }
        }
      } catch {
        // getNotifications isn't everywhere
      }
    };
    void tidy();
    document.addEventListener("visibilitychange", tidy);
    return () => document.removeEventListener("visibilitychange", tidy);
  }, [me, staleKey]);

  // ── a tapped notice while the app is open ─────────────────────────────

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: string } | null;
      if (d?.type !== "maple-open" || typeof d.url !== "string") return;
      // Whatever the notice is about goes on top: this sheet steps aside.
      setOpen(false);
      let handled = false;
      try {
        const url = new URL(d.url, window.location.origin);
        // Just the app (the nursing timer, a test): it's open and focused already.
        if (url.pathname === "/maple" && !url.search) handled = true;
        else {
          const ev: MapleOpenEvent = new CustomEvent(MAPLE_OPEN_EVENT, { detail: { url: url.pathname + url.search + url.hash }, cancelable: true });
          handled = !window.dispatchEvent(ev);
        }
      } catch {
        handled = false;
      }
      // No answer: the worker loads the URL itself after a moment.
      if (handled) e.ports?.[0]?.postMessage({ ok: true });
    };
    sw.addEventListener("message", onMessage);
    sw.startMessages?.();
    return () => sw.removeEventListener("message", onMessage);
  }, []);

  // ── "Remind me at …" ──────────────────────────────────────────────────

  const offer = useCallback<Offer>(
    (plan, nextAt) => {
      const s = live.current.status;
      if (!nextAt || (s !== "off" && s !== "install") || !live.current.me) return null;
      if (phone.offersShown() >= phone.OFFER_MAX) return null;
      phone.countOffer();
      if (s === "install") return { label: "Get reminders on this phone", onClick: () => setOpen(true) };
      const st = live.current.state;
      const tz = st?.baby.timezone ?? DEFAULT_TZ;
      const at = careTime(nextAt, clock(), tz);
      const title = planTitle(plan);
      const whose = st?.care?.person.self ? "your" : "her";
      const setTime = plan.schedule.type === "times";
      return {
        // A two-line tile like the time chips beside it ("Remind me" over "at 4:03 PM"), so it fits their row.
        label: "Remind me",
        sub: `at ${at}`,
        ariaLabel: setTime
          ? `Remind me on this phone at ${at}, ${whose} next ${title} set time`
          : `Remind me on this phone when ${title} is OK again, at ${at}`,
        // Straight from the tap, no await first: the permission prompt needs the gesture.
        onClick: () =>
          void turnOn().then((on) => {
            if (on) {
              toast(
                setTime
                  ? `Notifications are on for this phone. It'll show ${title} at ${at}, ${whose} next set time.`
                  : `Notifications are on for this phone. It'll say when ${title} is OK again, at ${at}.`,
                { tone: "ok", icon: "bell" }
              );
            } else if (phone.permission() === "denied") toast(DENIED, { tone: "info", icon: "bell" });
            // Allowed, but it didn't go through (the connection, the server): the sheet says why and has the switch.
            else if (phone.permission() === "granted") setOpen(true);
          }),
      };
    },
    [clock, toast, turnOn]
  );

  const late = status === "on" && health?.clock === "late" && prefs.meds !== false && !!reminders?.some((r) => r.kind !== null);
  const value = useMemo<Notifications>(
    () => ({
      status,
      prefs,
      health,
      reminders,
      value: notificationsValue(status, { late }),
      busy,
      problem,
      testDueAt,
      isOpen,
      open,
      close,
      turnOn,
      turnOff,
      setPrefs,
      testInOneMinute,
      sendNow,
      refresh,
      forgetThisPhone,
    }),
    [
      status,
      prefs,
      health,
      reminders,
      late,
      busy,
      problem,
      testDueAt,
      isOpen,
      open,
      close,
      turnOn,
      turnOff,
      setPrefs,
      testInOneMinute,
      sendNow,
      refresh,
      forgetThisPhone,
    ]
  );

  return (
    <OfferContext.Provider value={offer}>
      <NotificationsContext.Provider value={value}>
        {children}
        {/* Signed in only. On <body>, so it stacks above any sheet that opened it (her tab's, the picker, a toast's chip). */}
        {me && typeof document !== "undefined" && createPortal(<NotificationsSheet open={isOpen} onClose={close} />, document.body)}
      </NotificationsContext.Provider>
    </OfferContext.Provider>
  );
}

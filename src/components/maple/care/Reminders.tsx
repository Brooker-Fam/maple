"use client";

import { useCallback, useEffect, useState } from "react";
import type { PushPrefs } from "@/lib/maple/push";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple } from "../useMaple";
import { Footnote, GROUP, Problem, SwitchRow } from "./parts";
import type { UseCare } from "./useCare";

/**
 * "Reminders on this phone": Web Push for her medicines (src/lib/maple/push.ts).
 * Each phone opts in for itself; its settings live on the server with its
 * subscription, so the tick knows what to send where. On iPhone this only
 * works from the Home Screen app (iOS 16.4+), so a Safari tab gets the steps.
 *
 * The service worker (/maple/sw.js) only shows notifications; it never
 * caches or touches how the app loads.
 */

type Status = "loading" | "unsupported" | "install" | "denied" | "off" | "on";

const SW_URL = "/maple/sw.js";
const SCOPE = "/maple";

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function standalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json" }, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // a non-JSON error page
  }
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return body as T;
}

async function existing(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** An active worker for /maple: register (or reuse) it and wait until it's running. */
async function worker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
  if (reg.active) return reg;
  const sw = reg.installing ?? reg.waiting;
  if (sw) {
    await new Promise<void>((resolve) => {
      const done = () => sw.state === "activated" && resolve();
      sw.addEventListener("statechange", done);
      done();
    });
  }
  return reg;
}

export type PhoneReminders = {
  status: Status;
  prefs: PushPrefs;
  busy: boolean;
  problem: string | null;
  turnOn(): Promise<void>;
  turnOff(): Promise<void>;
  setPrefs(p: PushPrefs): Promise<void>;
  test(): Promise<boolean>;
  refresh(): Promise<void>;
};

export function usePhoneReminders(): PhoneReminders {
  const [status, setStatus] = useState<Status>("loading");
  const [prefs, setPrefsState] = useState<PushPrefs>({});
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supported()) {
      setStatus(isIos() && !standalone() ? "install" : "unsupported");
      return;
    }
    try {
      const sub = await existing();
      // A subscription the server doesn't know (another member signed in on this phone) reads as off here.
      const res = sub ? await call<{ sub: { prefs: PushPrefs } | null }>(`/api/maple/push?endpoint=${encodeURIComponent(sub.endpoint)}`) : null;
      setEndpoint(sub?.endpoint ?? null);
      setPrefsState(res?.sub?.prefs ?? {});
      setStatus(res?.sub ? "on" : Notification.permission === "denied" ? "denied" : "off");
    } catch {
      setStatus(Notification.permission === "denied" ? "denied" : "off");
    }
  }, []);

  useEffect(() => {
    // Read once on mount: the browser and server state, not React state, decide.
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      // Asked first, while the tap still counts as the user's (iOS insists).
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const { publicKey } = await call<{ publicKey: string | null }>("/api/maple/push");
      if (!publicKey) throw new Error("Reminders aren't set up on the server yet.");
      const reg = await worker();
      let sub = await reg.pushManager.getSubscription();
      // A subscription made with an older key can't be reused.
      const key = sub?.options.applicationServerKey;
      if (sub && key && !sameBytes(new Uint8Array(key), keyBytes(publicKey))) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const device = isIos() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Browser";
      const res = await call<{ sub: { prefs: PushPrefs } }>("/api/maple/push", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), prefs, device }) });
      setEndpoint(sub.endpoint);
      setPrefsState(res.sub.prefs);
      setStatus("on");
    });

  const turnOff = () =>
    run(async () => {
      const sub = await existing();
      const ep = sub?.endpoint ?? endpoint;
      if (ep) await call(`/api/maple/push?endpoint=${encodeURIComponent(ep)}`, { method: "DELETE" });
      await sub?.unsubscribe();
      setEndpoint(null);
      setStatus("off");
    });

  const setPrefs = (p: PushPrefs) =>
    run(async () => {
      if (!endpoint) return;
      const before = prefs;
      setPrefsState(p);
      try {
        const res = await call<{ sub: { prefs: PushPrefs } }>("/api/maple/push", { method: "PATCH", body: JSON.stringify({ endpoint, prefs: p }) });
        setPrefsState(res.sub.prefs);
      } catch (e) {
        setPrefsState(before);
        throw e;
      }
    });

  const test = async () => {
    if (!endpoint) return false;
    let ok = false;
    await run(async () => {
      await call("/api/maple/push/test", { method: "POST", body: JSON.stringify({ endpoint }) });
      ok = true;
    });
    return ok;
  };

  return { status, prefs, busy, problem, turnOn, turnOff, setPrefs, test, refresh };
}

export function remindersValue(status: Status): string | undefined {
  if (status === "on") return "On";
  if (status === "off" || status === "denied") return "Off";
  return undefined;
}

export default function RemindersSheet({ open, onClose, care, phone }: { open: boolean; onClose: () => void; care: UseCare; phone: PhoneReminders }) {
  const { toast } = useMaple();
  const { status, prefs, busy, refresh } = phone;
  // Opening it re-reads the phone: notifications may have been allowed in Settings meanwhile.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  const her = care.self ? "your" : `${care.name}'s`;
  const on = status === "on";
  const muted = new Set(prefs.muted ?? []);
  const meds = prefs.meds !== false;

  const mute = (id: number, remind: boolean) => {
    const next = new Set(muted);
    if (remind) next.delete(id);
    else next.add(id);
    void phone.setPrefs({ ...prefs, muted: [...next] });
  };

  return (
    <Sheet open={open} onClose={onClose} title="Reminders on this phone">
      <div className="space-y-6 pb-2">
        {status === "install" && (
          <div className={cx(tone.card, "space-y-2 px-4 py-3.5")}>
            <p className={cx(tone.body, "text-[15px] font-medium")}>Add Maple&apos;s Log to your Home Screen first</p>
            <p className={cx(tone.muted, "text-sm leading-relaxed")}>
              iPhone only sends reminders to the Home Screen app. In Safari, tap <strong className="font-semibold text-mp-ink">Share</strong>, then{" "}
              <strong className="font-semibold text-mp-ink">Add to Home Screen</strong>. Open Maple&apos;s Log from there and turn reminders on here.
            </p>
          </div>
        )}
        {status === "unsupported" && (
          <p className={cx(tone.muted, "px-1 text-sm leading-relaxed")}>This browser can&apos;t show reminders. On iPhone, use the Home Screen app (iOS 16.4 or later).</p>
        )}
        {status === "denied" && (
          <p className={cx(tone.muted, "px-1 text-sm leading-relaxed")}>
            Notifications are turned off for Maple&apos;s Log. Turn them on in the phone&apos;s Settings (on iPhone: Settings, Notifications, Maple), then come back here.
          </p>
        )}

        {(status === "off" || status === "on" || status === "denied") && (
          <section>
            <div className={GROUP}>
              <SwitchRow
                label="Reminders"
                note={`When one of ${her} medicines is OK again by ${her} plan, and at its set times.`}
                checked={on}
                disabled={busy || status === "denied"}
                onChange={(v) => void (v ? phone.turnOn() : phone.turnOff())}
              />
            </div>
            <Problem className="px-1">{phone.problem}</Problem>
          </section>
        )}

        {on && (
          <>
            <section>
              <h3 className={cx(tone.label, "mb-1.5 px-1")}>What this phone gets</h3>
              <div className={GROUP}>
                <SwitchRow label={care.self ? "Your medicines" : `${care.name}'s medicines`} note="OK again, and set times" checked={meds} disabled={busy} onChange={(v) => void phone.setPrefs({ ...prefs, meds: v })} />
                <SwitchRow
                  label="Doses someone else logs"
                  note={care.self ? "When someone logs one of your doses for you" : `When someone else logs one of ${her} doses`}
                  checked={prefs.logged === true}
                  disabled={busy}
                  onChange={(v) => void phone.setPrefs({ ...prefs, logged: v })}
                />
                <SwitchRow
                  label="Hide medicine names"
                  note="The lock screen says “A medicine reminder” instead"
                  checked={prefs.hide_names === true}
                  disabled={busy}
                  onChange={(v) => void phone.setPrefs({ ...prefs, hide_names: v })}
                />
              </div>
            </section>

            {meds && care.plans.length > 0 && (
              <section>
                <h3 className={cx(tone.label, "mb-1.5 px-1")}>Medicines</h3>
                <div className={GROUP}>
                  {care.plans.map(({ plan }) => (
                    <SwitchRow key={plan.id} label={plan.name} checked={!muted.has(plan.id)} disabled={busy} onChange={(v) => mute(plan.id, v)} />
                  ))}
                </div>
              </section>
            )}

            <div className="flex flex-col items-center gap-1">
              <Button
                variant="soft"
                disabled={busy}
                onClick={async () => {
                  if (await phone.test()) toast("Sent. It should show up in a few seconds.", { tone: "info" });
                }}
              >
                Send a test
              </Button>
            </div>
          </>
        )}

        <Footnote>Reminders can arrive a few minutes late, and they don&apos;t ring through Silent or a Focus. For a dose that matters overnight, set an alarm too.</Footnote>
      </div>
    </Sheet>
  );
}

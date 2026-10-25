import type { PushHealth, PushPrefs } from "@/lib/maple/push";
import { careTime } from "@/lib/maple/care";
import { formatTimeNear } from "@/lib/maple/time";

/**
 * The Notifications sheet's words, kept apart from React so they can be
 * checked on their own. Calm and plain: what this phone gets and whether it
 * arrives. Never "take", "due" or "time for", never a dose: the times are her
 * own plan's.
 */

/** This phone, as the sheet and its row see it. */
export type NotifyStatus = "loading" | "unsupported" | "install" | "denied" | "off" | "on" | "stopped";

/** What one of her medicines can notify about (GET /api/maple/push `reminders`). */
export type ReminderFact = { plan_id: number; kind: "ok" | "at" | null; why?: "daily" | "no_gap" };

export type { PushHealth, PushPrefs };

/** The row's value on Family and her tab: On, Off, Stopped, "Home Screen app first" (and "On · may be late" while the server's clock is behind). */
export function notificationsValue(status: NotifyStatus, opts: { late?: boolean } = {}): string | undefined {
  switch (status) {
    case "loading":
      return undefined;
    case "install":
      return "Home Screen app first";
    case "stopped":
      return "Stopped";
    case "on":
      return opts.late ? "On · may be late" : "On";
    default:
      return "Off";
  }
}

/** "8:00 AM" from a plan's local "08:00". */
export function clockText(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "At 8:00 AM and 8:00 PM" for a set-times plan. */
export function setTimesText(times: string[]): string {
  const sorted = [...times].sort();
  return sorted.length ? `At ${andList(sorted.map(clockText))}` : "At her set times";
}

/**
 * One medicine's row in the sheet: what it can do on this phone, honestly.
 * `switchable` false: there's nothing to switch (no time to remind at).
 */
export function medicineNote(fact: ReminderFact, times: string[] | null, prefs: PushPrefs): { note: string; switchable: boolean } {
  if (fact.kind === null) return { note: fact.why === "daily" ? "No reminder: this one has no set times." : "No reminder: no gap set.", switchable: false };
  if (fact.kind === "ok") return { note: prefs.ok === false ? "OK again is off above" : "When it's OK again", switchable: true };
  return { note: prefs.at === false ? "Set times are off above" : setTimesText(times ?? []), switchable: true };
}

/** "just now", "1 min ago", "12 min ago", then "at 2:10 AM" (with "yesterday" or a weekday when it isn't today). */
export function agoText(iso: string, now: Date, tz: string): string {
  const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `at ${careTime(iso, now, tz)}`;
}

export type HealthLine = { text: string; warn?: boolean };

/**
 * The health lines under "Check it works":
 *   "Checked 2 min ago. Last one reached this phone at 3:10 AM."
 *   "Last checked at 1:40 AM, so notifications may be late. …"
 *   "The last 2 notifications didn't reach this phone. …"
 *   "The 2:10 AM Ibuprofen reminder couldn't go out because the server didn't check between 1:40 and 6:50 AM."
 * `meds`: this reader gets her medicines here (the alarm advice and missed reminders are only for them).
 * `planName(id)`: the medicine's name for a missed one, or null to keep it unnamed (hide names, a viewer, a plan gone).
 */
export function healthLines(h: PushHealth, now: Date, tz: string, opts: { meds: boolean; planName: (id: number) => string | null }): HealthLine[] {
  const out: HealthLine[] = [];
  const alarm = opts.meds ? " For a dose that matters overnight, set an alarm too." : "";
  let phone: string;
  if (h.undelivered >= 2) phone = "";
  else if (h.last_delivered_at) phone = `Last one reached this phone ${agoText(h.last_delivered_at, now, tz)}.`;
  else if (h.last_sent_at) phone = `Last one went out ${agoText(h.last_sent_at, now, tz)}.`;
  else phone = "Nothing has been sent to this phone yet.";

  if (h.clock === "late") {
    out.push({
      text: h.clock_at
        ? `Last checked ${agoText(h.clock_at, now, tz)}, so notifications may be late.${alarm}`
        : `The server's clock hasn't run yet, so notifications may be late.${alarm}`,
      warn: true,
    });
    if (phone) out.push({ text: phone });
  } else {
    const at = h.clock_at ?? h.checked_at;
    out.push({ text: [at ? `Checked ${agoText(at, now, tz)}.` : "", phone].filter(Boolean).join(" ") });
  }
  if (h.undelivered >= 2) {
    out.push({ text: `The last ${h.undelivered} notifications didn't reach this phone. Turn notifications off and on, then send a test.`, warn: true });
  }
  if (opts.meds && h.missed.length) {
    const m = h.missed[h.missed.length - 1];
    const at = careTime(m.at, now, tz);
    const name = opts.planName(m.plan_id);
    const what = name ? `The ${at} ${name} reminder` : `A ${at} reminder`;
    const gap = h.gaps.find((g) => g.from < m.at && m.at <= g.to);
    out.push({
      text: gap
        ? `${what} couldn't go out because the server didn't check between ${formatTimeNear(gap.from, gap.to, tz)} and ${careTime(gap.to, now, tz)}.`
        : `${what} couldn't go out because the server didn't check in time.`,
      warn: true,
    });
  }
  return out.filter((l) => l.text);
}

export type TestView =
  | { kind: "pending"; text: string }
  | { kind: "arrived"; text: string }
  | { kind: "poll"; text: string }
  | { kind: "late"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "ask"; text: string };

const TEST_GRACE_MS = 2 * 60_000;

/** How late the test went out, in whole minutes past its time (0 when on time, under 2 minutes, or unknown). */
export function testLateMinutes(sentAt: string | null, dueAt: string | null): number {
  if (!sentAt || !dueAt) return 0;
  const m = Math.floor((Date.parse(sentAt) - Date.parse(dueAt)) / 60_000);
  return m >= 2 ? m : 0;
}

/**
 * How "Send a test in 1 minute" went, from health.test (null: nothing to say).
 * Once sent, the server forgets when it was due, so `dueAt` is the time this
 * phone was told (for "It went out 4 min late."). `answer`: the "Did it show
 * up?" reply on this phone. A missing receipt isn't proof it failed (a phone
 * can show a notice without running the worker), so that one asks.
 */
export function testView(t: PushHealth["test"], now: Date, tz: string, opts: { answer?: "yes" | "no" | null; dueAt?: string | null } = {}): TestView | null {
  if (!t) return null;
  const at = (iso: string) => careTime(iso, now, tz);
  if (t.via === "failed") return { kind: "failed", text: "The push service didn't take the test. Turn notifications off and on, then send another." };
  if (t.arrived_at && t.via === "poll") {
    return {
      kind: "poll",
      text: "The test arrived, but only because the app was open. With the phone locked, notifications may be late until the server's clock is set up.",
    };
  }
  const late = testLateMinutes(t.sent_at, opts.dueAt ?? null);
  const lateText = late ? ` It went out ${late} min late.` : "";
  if (t.arrived_at)
    return { kind: "arrived", text: `The test arrived ${agoText(t.arrived_at, now, tz)}. Notifications reach this phone, locked or not.${lateText}` };
  if (t.due_at && !t.sent_at) {
    if (now.getTime() - Date.parse(t.due_at) > TEST_GRACE_MS)
      return { kind: "late", text: "The test didn't go out on time, so notifications may be late on every phone right now." };
    return { kind: "pending", text: `Test set for ${at(t.due_at)}. Lock this phone now and wait for it.` };
  }
  if (t.sent_at) {
    if (opts.answer === "yes") return { kind: "arrived", text: `Good. Notifications reach this phone.${lateText}` };
    if (opts.answer === "no") {
      return {
        kind: "failed",
        text: `It went out at ${at(t.sent_at)} but didn't show. Check Settings › Notifications › Maple, then turn notifications off and on here.`,
      };
    }
    if (now.getTime() - Date.parse(t.sent_at) > TEST_GRACE_MS)
      return { kind: "ask", text: `The test went out at ${at(t.sent_at)}.${lateText} Did it show up?` };
    return { kind: "pending", text: `The test went out at ${at(t.sent_at)}. It should show up in a moment.` };
  }
  return null;
}

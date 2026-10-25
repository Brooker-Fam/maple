"use client";

import { useEffect, useState, type ReactNode } from "react";
import { planTitle } from "@/lib/maple/care";
import { DEFAULT_TZ } from "@/lib/maple/time";
import { Icon } from "../icons";
import { Button, Sheet, cx, tone } from "../ui";
import { useMaple, useNow } from "../useMaple";
import { Footnote, GROUP, Problem, SwitchRow } from "../care/parts";
import { useCare } from "../care/useCare";
import { useNotifications } from "./context";
import { healthLines, medicineNote, testView, type PushPrefs } from "./words";

/**
 * "Notifications" for this phone, top to bottom: what's in the way (Home
 * Screen first, off in Settings, Stopped), the switch, her medicines (each
 * kind of notice, names hidden, each medicine, honest rows for the ones that
 * can't notify), Maple's nursing timer on the lock screen, "Check it works"
 * (the server's clock, the last delivery, "Send a test in 1 minute"), and
 * what a phone's own settings decide (Silent, Focus). Rendered by
 * NotificationsProvider; open it with useNotifications().open().
 */

const TEST_POLL_MS = 5000;
const TEST_WINDOW_MS = 3 * 60_000;

export default function NotificationsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // The body (and its clocks and reads) runs only while the sheet is up.
  return (
    <Sheet open={open} onClose={onClose} title="Notifications" subtitle="On this phone">
      <Body />
    </Sheet>
  );
}

function Body() {
  const n = useNotifications();
  const care = useCare();
  const { state, toast } = useMaple();
  const now = useNow(15_000);
  const tz = state?.baby.timezone ?? DEFAULT_TZ;
  const owner = state?.me.role === "owner";
  const { status, prefs, busy, health, refresh } = n;
  const on = status === "on";
  const [answer, setAnswer] = useState<{ key: string; v: "yes" | "no" } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Opening it re-reads the phone: notifications may have been allowed in Settings meanwhile.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A test on its way: re-read every 5 seconds, for up to 3 minutes past its time.
  const test = health?.test ?? null;
  const testKey = test ? `${test.due_at ?? ""}|${test.sent_at ?? ""}` : "";
  const watchUntil = test ? Date.parse(test.due_at ?? test.sent_at ?? "") + TEST_WINDOW_MS : 0;
  const watching = on && !!test && !test.arrived_at && test.via !== "failed" && Number.isFinite(watchUntil) && now.getTime() < watchUntil;
  useEffect(() => {
    if (!watching) return;
    const id = window.setInterval(() => void refresh(), TEST_POLL_MS);
    return () => window.clearInterval(id);
  }, [watching, refresh]);

  // Her medicines, for anyone who can see them: each one's facts from the server, in her list's order.
  const facts = n.reminders;
  const her = care ? (care.self ? "your" : "her") : "her";
  const Her = care ? (care.self ? "Your" : `${care.name}'s`) : "";
  const rows =
    care && facts
      ? care.rows.flatMap((v) => {
          const fact = facts.find((f) => f.plan_id === v.plan.id);
          return fact ? [{ plan: v.plan, fact }] : [];
        })
      : [];
  const showMeds = !!care && facts !== null;
  const meds = prefs.meds !== false;
  const muted = new Set(prefs.muted ?? []);
  const set = (patch: Partial<PushPrefs>) => void n.setPrefs({ ...prefs, ...patch });
  const mute = (id: number, remind: boolean) => {
    const next = new Set(muted);
    if (remind) next.delete(id);
    else next.add(id);
    set({ muted: [...next] });
  };

  const lines = health
    ? healthLines(health, now, tz, {
        meds: showMeds && meds,
        planName: (id) =>
          prefs.hide_names
            ? null
            : (() => {
                const p = care?.rows.find((v) => v.plan.id === id)?.plan ?? care?.finished.find((v) => v.plan.id === id)?.plan;
                return p ? planTitle(p) : null;
              })(),
      })
    : [];
  const tv = on ? testView(test, now, tz, { answer: answer?.key === testKey ? answer.v : null, dueAt: n.testDueAt }) : null;
  const testBusy = busy || (tv?.kind === "pending" && !!test && !test.sent_at);

  const startTest = async (all = false) => {
    const res = await n.testInOneMinute({ all });
    if (res && all)
      toast(res.phones === 1 ? "Test set for the one phone with notifications on." : `Test set for ${res.phones} phones.`, { tone: "info", icon: "bell" });
  };

  return (
    <div className="space-y-6 pb-2">
      {status === "loading" && <p className={cx(tone.muted, "px-1 text-sm")}>Checking this phone…</p>}

      {status === "install" && (
        <div className={cx(tone.card, "space-y-2.5 px-4 py-3.5")}>
          <p className={cx(tone.body, "text-[15px] font-medium")}>Add Maple&apos;s Log to your Home Screen first</p>
          <p className={cx(tone.muted, "text-sm leading-relaxed")}>iPhone only sends notifications to the Home Screen app (iOS 16.4 or later).</p>
          <ol className={cx(tone.muted, "list-decimal space-y-1.5 pl-5 text-sm leading-relaxed")}>
            <li>
              In Safari, tap <Strong>Share</Strong>, then <Strong>Add to Home Screen</Strong>.
            </li>
            <li>Open Maple from your Home Screen and sign in once more (it keeps its own sign-in).</li>
            <li>Turn notifications on there, then send a test.</li>
          </ol>
        </div>
      )}
      {status === "unsupported" && (
        <p className={cx(tone.muted, "px-1 text-sm leading-relaxed")}>
          This browser can&apos;t show notifications. On iPhone, use the Home Screen app (iOS 16.4 or later); on Android, Chrome.
        </p>
      )}
      {status === "denied" && (
        <p className={cx(tone.muted, "px-1 text-sm leading-relaxed")}>
          Notifications for Maple are off in the phone&apos;s Settings. On iPhone: <Strong>Settings › Notifications › Maple</Strong>. Then come back here.
        </p>
      )}
      {status === "stopped" && (
        <div className={cx(tone.card, "space-y-3 px-4 py-3.5")}>
          <div className="flex gap-3">
            <Icon name="bell" size={20} className="mt-0.5 shrink-0 text-mp-ink-2" />
            <div className="min-w-0">
              <p className={cx(tone.body, "text-[15px] font-medium")}>Stopped on this phone</p>
              <p className={cx(tone.muted, "mt-0.5 text-sm leading-relaxed")}>
                This phone was getting notifications, but its connection to them ended. Turn them back on to keep getting them.
              </p>
            </div>
          </div>
          <Button className="w-full" disabled={busy} onClick={() => void n.turnOn()}>
            Turn on
          </Button>
          <Problem>{n.problem}</Problem>
        </div>
      )}

      {(status === "off" || status === "on" || status === "denied") && (
        <section>
          <div className={GROUP}>
            <SwitchRow
              label="Notifications on this phone"
              note={
                on
                  ? undefined
                  : showMeds
                    ? `${Her} medicine times, and the nursing timer if you want it.`
                    : "The nursing timer on the lock screen, if you want it."
              }
              checked={on}
              disabled={busy || status === "denied"}
              onChange={(v) => void (v ? n.turnOn() : n.turnOff())}
            />
          </div>
          <Problem className="px-1">{n.problem}</Problem>
        </section>
      )}

      {on && showMeds && (
        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>{care?.self ? "Your medicines" : `${care?.name}'s medicines`}</h3>
          <div className={GROUP}>
            <SwitchRow
              label="Reminders"
              note={`By ${her} schedule: when one is OK again, and at ${her} set times.`}
              checked={meds}
              disabled={busy}
              onChange={(v) => set({ meds: v })}
            />
            {meds && (
              <>
                {rows.some((r) => r.fact.kind === "ok") && (
                  <SwitchRow
                    label="When one is OK again"
                    note="Once its gap and daily limit have passed"
                    checked={prefs.ok !== false}
                    disabled={busy}
                    onChange={(v) => set({ ok: v })}
                  />
                )}
                {rows.some((r) => r.fact.kind === "at") && (
                  <SwitchRow
                    label="At set times"
                    note="Unless it's logged already"
                    checked={prefs.at !== false}
                    disabled={busy}
                    onChange={(v) => set({ at: v })}
                  />
                )}
                <SwitchRow
                  label="Logged on another phone"
                  note="After a reminder here, once it's logged somewhere else"
                  checked={prefs.closing !== false}
                  disabled={busy}
                  onChange={(v) => set({ closing: v })}
                />
                <SwitchRow
                  label="Every dose logged elsewhere"
                  note="Even with no reminder here"
                  checked={prefs.logged === true}
                  disabled={busy}
                  onChange={(v) => set({ logged: v })}
                />
                <SwitchRow
                  label="Hide medicine names"
                  note="The lock screen says “Maple's Log” instead"
                  checked={prefs.hide_names === true}
                  disabled={busy}
                  onChange={(v) => set({ hide_names: v })}
                />
              </>
            )}
          </div>
          {meds && rows.length > 0 && (
            <>
              <h3 className={cx(tone.label, "mt-5 mb-1.5 px-1")}>Each medicine</h3>
              <div className={GROUP}>
                {rows.map(({ plan, fact }) => {
                  const { note, switchable } = medicineNote(fact, plan.schedule.type === "times" ? plan.schedule.times : null, prefs);
                  const kindOff = (fact.kind === "ok" && prefs.ok === false) || (fact.kind === "at" && prefs.at === false);
                  return switchable ? (
                    <SwitchRow
                      key={plan.id}
                      label={planTitle(plan)}
                      note={note}
                      checked={!muted.has(plan.id) && !kindOff}
                      disabled={busy || kindOff}
                      onChange={(v) => mute(plan.id, v)}
                    />
                  ) : (
                    <div key={plan.id} className="flex min-h-[52px] items-center px-4 py-2.5">
                      <div className="min-w-0">
                        <div className={cx(tone.body, "text-[15px]")}>{planTitle(plan)}</div>
                        <p className={cx(tone.muted, "mt-0.5 text-[13px] leading-snug")}>{note}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {meds && rows.length === 0 && (
            <Footnote>
              {Her} medicines show up here once they&apos;re on {her} list.
            </Footnote>
          )}
        </section>
      )}

      {on && (
        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>Maple</h3>
          <div className={GROUP}>
            <SwitchRow
              label="Nursing timer on the lock screen"
              note="The feed as it runs: the side, a break, and when it's done. Updates quietly where the phone allows."
              checked={prefs.nursing === true}
              disabled={busy}
              onChange={(v) => set({ nursing: v })}
            />
          </div>
        </section>
      )}

      {on && (
        <section>
          <h3 className={cx(tone.label, "mb-1.5 px-1")}>Check it works</h3>
          <div className={cx(tone.card, "space-y-3 px-4 py-3.5")}>
            {lines.map((l) => (
              <p key={l.text} className={cx("flex gap-2 text-sm leading-relaxed", l.warn ? "text-mp-ink" : tone.muted)}>
                {l.warn && <Icon name="triangle-alert" size={16} className="mt-0.5 shrink-0 text-mp-ink-2" />}
                <span>{l.text}</span>
              </p>
            ))}
            <Button variant="soft" className="w-full" disabled={testBusy} onClick={() => void startTest()}>
              <Icon name="bell" size={18} />
              Send a test in 1 minute
            </Button>
            {tv && (
              <div role="status" className="space-y-2">
                <p className={cx("text-sm leading-relaxed", tv.kind === "arrived" ? "font-medium text-mp-accent-fg" : tone.body)}>{tv.text}</p>
                {tv.kind === "ask" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="soft" onClick={() => setAnswer({ key: testKey, v: "yes" })}>
                      Yes, it did
                    </Button>
                    <Button size="sm" variant="soft" onClick={() => setAnswer({ key: testKey, v: "no" })}>
                      No
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="-mx-2 -mb-1 flex flex-wrap items-center">
              <TextButton
                disabled={busy}
                onClick={async () => {
                  if (await n.sendNow()) toast("Sent. It should show up in a few seconds.", { tone: "info", icon: "bell" });
                }}
              >
                Send one now
              </TextButton>
              {owner && (
                <TextButton disabled={busy} onClick={() => void startTest(true)}>
                  Test every phone
                </TextButton>
              )}
            </div>
          </div>
        </section>
      )}

      <div>
        <Footnote>
          Nothing rings through Silent. To let notifications through Sleep or another Focus, add Maple in Settings › Focus › Sleep › Apps.
          {showMeds ? " For a dose that matters overnight, set an alarm too. Check-ins never notify anyone." : ""}
        </Footnote>
        <div className={cx(GROUP, "mt-3")}>
          <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen} className={cx(tone.row, "min-h-[52px]")}>
            <span className={cx(tone.body, "min-w-0 flex-1 text-[15px]")}>Phone settings that help</span>
            <Icon name="chevron-down" size={18} className={cx("shrink-0 text-mp-ink-3 transition", settingsOpen && "rotate-180")} />
          </button>
          {settingsOpen && (
            <div className="space-y-4 px-4 pt-1 pb-4">
              <Steps title="iPhone">
                <li>
                  <Strong>Settings › Notifications › Maple</Strong>: Allow Notifications, with Lock Screen, Notification Center, Banners and Sounds.
                </li>
                <li>
                  <Strong>Settings › Focus › Sleep › Apps › Add › Maple</Strong>, and the same for any Focus you use at night. Maple shows up there once it has
                  been opened from its Home Screen icon.
                </li>
                <li>
                  With an Apple Watch: <Strong>Watch app › Notifications › Mirror iPhone Alerts From › Maple</Strong>. A tap on the wrist won&apos;t wake the
                  baby.
                </li>
                {showMeds && (
                  <li>
                    If others can see the lock screen: <Strong>Settings › Notifications › Show Previews › When Unlocked</Strong>, or Hide medicine names above.
                  </li>
                )}
              </Steps>
              <Steps title="Android">
                <li>
                  In Chrome, <Strong>⋮ › Add to Home screen › Install</Strong>, then open Maple from its icon and sign in.
                </li>
                <li>
                  <Strong>Settings › Apps › Maple › Notifications</Strong>: allowed. With Do Not Disturb on at night, add Maple to its apps.
                </li>
              </Steps>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-mp-ink">{children}</strong>;
}

function Steps({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className={cx(tone.body, "text-sm font-medium")}>{title}</p>
      <ul className={cx(tone.muted, "mt-1 list-disc space-y-1.5 pl-5 text-sm leading-relaxed")}>{children}</ul>
    </div>
  );
}

function TextButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-[44px] rounded-lg px-2 text-sm font-medium text-mp-accent-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

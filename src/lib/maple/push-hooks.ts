import { after } from "next/server";
import { captureServerException } from "@/lib/posthog-server";

/**
 * The write hooks for notifications. The stores (care-store.ts, store.ts)
 * call these at the end of a write, whatever the channel (the app, Siri,
 * Claude or ChatGPT), and the work runs after the response has gone out
 * (`after()`), so a notification never blocks or slows a save. Outside a
 * request (scripts, migrations) after() throws and nothing runs.
 *
 * This file stays tiny on purpose: the stores import it, and the heavy
 * modules (push.ts, notify.ts) are loaded inside the task, so there's no
 * import cycle between the stores and the notification code.
 */

type Task = () => Promise<void>;
let runner: ((task: Task) => void) | null = null;

/** Tests only: run hooks through `fn` instead of next/server's after(). Pass null to restore. */
export function setLaterRunner(fn: ((task: Task) => void) | null): void {
  runner = fn;
}

const codeOf = (err: unknown) => String((err as { code?: unknown })?.code ?? (err instanceof Error ? err.name : "error"));

/** Run `task` after the response; never throws, and reports only an error code. */
export function later(task: Task, route = "maple notify"): void {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      void captureServerException(new Error(codeOf(err)), { route });
    }
  };
  if (runner) {
    runner(run);
    return;
  }
  try {
    after(run);
  } catch {
    // outside a request (scripts calling the stores directly)
  }
}

/**
 * Her medicines changed (a dose, a skip, a plan, an edit or delete): re-arm
 * the exact-time wake-ups, send "Logged" for a new dose or skip (`doseId`,
 * from the phone `device`, when there is one), and run a tick so anything
 * that's now due goes out.
 */
export function careChanged(opts: { doseId?: number; device?: string | null } = {}): void {
  later(async () => {
    const { afterCareWrite } = await import("./notify");
    await afterCareWrite(opts);
  }, "maple notify care");
}

/** A nursing timer changed (start, switch, break, back on, done, discard, a fix): update its lock-screen notice. */
export function nursingChanged(entryId: number): void {
  later(async () => {
    const { notifyNursing } = await import("./notify");
    await notifyNursing(entryId);
  }, "maple notify nursing");
}

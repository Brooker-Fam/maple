import assert from "node:assert/strict";

/**
 * The polls must keep reading the shared log through what a phone does to a page: coming back on screen without a
 * visibilitychange, a write whose connection died quietly, a queued entry the server keeps turning away, a network
 * that comes back, a first read that fails while the phone's Wi-Fi is still waking. Each one used to leave the page
 * showing an old log, with nothing on screen to say so, until someone reloaded it.
 */
export function resumeCases({ check, snapshot, feed, saved, previous, settle, state, poll }) {
  // Another phone's feed: what the page has to catch up on.
  const theirs = { ...feed(906, "2026-01-01T09:30:00.000Z", "2026-01-01T09:45:00.000Z"), created_by: "sam@example.test" };
  const WRITE_TIMEOUT_MS = 30_000;
  const POLL_MS = 10_000;
  const hide = (page) => page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  /** On screen again with no visibilitychange: the browser says nothing, or says only `extra`. */
  const showQuietly = (page, extra) => page.evaluate((extra) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    if (extra === "pageshow") window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    if (extra === "focus") window.dispatchEvent(new Event("focus"));
  }, extra);
  const logSaved = (page) => page.evaluate((entry) => {
    void window.__mapleSync.log({ kind: "feed", started_at: entry.started_at, ended_at: entry.ended_at, data: entry.data }, { silent: true });
  }, saved);
  const shows = async (page, entry, message) => {
    const ids = (await state(page)).state.entries.map((e) => e.id);
    assert(ids.includes(entry.id), `${message} (shown: ${ids.join(", ")})`);
  };
  const reads = async (f) => {
    const read = await f.take("/api/maple/state");
    await f.answer(read, snapshot("theirs", [theirs, previous]));
    return read;
  };

  for (const signal of ["pageshow", "focus"]) check(`a page back on screen with only ${signal} still reads the log`, async (f) => {
    await hide(f.page);
    await showQuietly(f.page, signal);
    await reads(f);
    await shows(f.page, theirs, `Back on screen, the other phone's feed shows without waiting for a visibilitychange that never came`);
  });

  check("the polls keep going when a page comes back on screen without any event", async (f) => {
    await hide(f.page);
    await showQuietly(f.page);
    await f.page.clock.fastForward(POLL_MS + 500);
    await reads(f);
    await shows(f.page, theirs, "A hidden page's beat only skips: once it shows again the next one reads");
  }, { clock: true });

  check("several signals for one return read the log once", async (f) => {
    await hide(f.page);
    await f.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      window.dispatchEvent(new Event("focus"));
    });
    await reads(f);
    await settle(f.page);
    await assert.rejects(f.take("/api/maple/state"), /No GET \/api\/maple\/state/, "visibilitychange, pageshow and focus together are one return");
  });

  check("a write that never answers gives up, so the others' entries still show", async (f) => {
    await logSaved(f.page);
    await f.take("/api/maple/entries", "POST"); // its connection died: no answer, ever
    await f.page.clock.fastForward(WRITE_TIMEOUT_MS + 1_000);
    await reads(f);
    const now = await state(f.page);
    await shows(f.page, theirs, "Once the dead write gives up, the log is read again");
    assert.equal(now.pending, 1, "The feed it carried waits on this phone to send again (the server dedupes it)");
    assert(now.state.entries.some((e) => e.id < 0 && e.started_at === saved.started_at), "and stays on screen meanwhile");
  }, { clock: true });

  check("a timer tap that never answers says it may not have saved, and the log is read", async (f) => {
    await f.page.evaluate(() => { void window.__mapleTimerActions.startFeed("L"); });
    await f.take("/api/maple/timer", "POST");
    await f.page.clock.fastForward(WRITE_TIMEOUT_MS + 1_000);
    await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => /didn't answer/i.test(t.text)));
    await reads(f);
    await shows(f.page, theirs, "After the tap gives up, the page reads what really happened");
    assert.equal((await state(f.page)).online, true, "No answer isn't proof the phone is offline");
  }, { clock: true });

  check("a queued entry the server keeps turning away doesn't hold back the others' entries", async (f) => {
    await logSaved(f.page);
    await (await f.take("/api/maple/entries", "POST")).route.abort("failed");
    await settle(f.page);
    await f.answer(await f.take("/api/maple/state"), snapshot("before", [previous]));
    assert.equal((await state(f.page)).pending, 1);
    await poll(f.page);
    await f.answer(await f.take("/api/maple/entries", "POST"), { error: "Synthetic server error" }, 503);
    await reads(f);
    await shows(f.page, theirs, "The poll still reads the log after the queued entry fails again");
    assert.equal((await state(f.page)).pending, 1, "The queued entry still waits to send");
  });

  check("coming back online reads the log at once", async (f) => {
    await f.page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
    });
    await reads(f);
    await shows(f.page, theirs, "Back on a network, the page catches up without waiting for the next poll");
  });

  check("a read that fails on the network tries again shortly", async (f) => {
    await poll(f.page);
    await (await f.take("/api/maple/state")).route.abort("failed");
    await settle(f.page);
    assert.equal((await state(f.page)).online, false);
    await f.page.clock.fastForward(2_500);
    await reads(f);
    await shows(f.page, theirs, "A phone whose Wi-Fi was still waking catches up within seconds, not at the next poll");
    const now = await state(f.page);
    assert.equal(now.online, true);
    assert.equal(now.error, null);
    // Once: a phone that's really offline waits for the next poll, not a retry every two seconds.
    await poll(f.page);
    await (await f.take("/api/maple/state")).route.abort("failed");
    await settle(f.page);
    await f.page.clock.fastForward(2_500);
    await (await f.take("/api/maple/state")).route.abort("failed");
    await settle(f.page);
    await f.page.clock.fastForward(5_000);
    await assert.rejects(f.take("/api/maple/state"), /No GET \/api\/maple\/state/, "Only one quick retry until a read succeeds");
  }, { clock: true });
}

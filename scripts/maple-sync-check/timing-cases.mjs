import assert from "node:assert/strict";

export function timingCases({ check, snapshot, running, now }) {
  check("saved-entry conflicts return the latest historical entry to the open draft", async (f) => {
    const current = { ...running, kind: "sleep", data: {}, active: false, started_at: "2025-12-01T10:00:00.000Z", ended_at: "2025-12-01T11:00:00.000Z", updated_at: now };
    await f.page.evaluate((entry) => { void window.__mapleSync.update(entry.id, { started_at: "2025-12-01T09:55:00.000Z", expect_updated_at: "2025-12-01T12:00:00.000Z" }, { onConflict: (latest) => { window.__entryConflict = latest; } }); }, current);
    await f.answer(await f.take("/api/maple/entries", "PATCH"), { reason: "changed", error: "This entry changed", entry: current }, 409);
    assert.deepEqual(await f.page.evaluate(() => window.__entryConflict), current, "The editor needs the server revision to recover after an old entry falls outside recent state");
    await f.answer(await f.take("/api/maple/state"), snapshot("recent-only", []));
    assert.deepEqual(await f.page.evaluate(() => window.__entryConflict), current);
  });

  for (const kind of ["sleep", "tummy", "pump"]) check(`${kind} time adjustment and Undo guard their original revisions`, async (f) => {
    const original = { ...running, kind, data: {}, updated_at: "2026-01-01T10:01:00.000Z" };
    await f.page.evaluate(() => { void window.__mapleSync.refresh(); });
    await f.answer(await f.take("/api/maple/state"), snapshot("adjust-before", [original]));
    const at = "2026-01-01T09:55:00.000Z";
    await f.page.evaluate(({ entry, at }) => { void window.__mapleTimerActions.adjust(entry, new Date(at)); }, { entry: original, at });
    const request = await f.take("/api/maple/timer", "POST");
    assert.equal(request.body.expect_updated_at, original.updated_at, "A correction must check the entry that supplied the draft");
    const changed = { ...original, started_at: at, updated_at: now };
    await f.answer(request, { entry: changed });
    await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => /now starts/.test(t.text)));
    await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => /now starts/.test(t.text)).undo());
    const undo = await f.take("/api/maple/timer", "POST");
    assert.equal(undo.body.at, original.started_at);
    assert.equal(undo.body.expect_updated_at, changed.updated_at, "Undo cannot overwrite a later correction");
    await f.answer(undo, { entry: original });
  });

  check("reopening a finished timer checks the version being undone", async (f) => {
    const ended = { ...running, kind: "sleep", data: {}, active: false, ended_at: now, updated_at: now };
    await f.page.evaluate((entry) => { void window.__mapleTimerActions.reopen(entry); }, ended);
    const request = await f.take("/api/maple/timer", "POST");
    assert.equal(request.body.expect_updated_at, ended.updated_at);
    await f.answer(request, { entry: { ...ended, active: true, ended_at: null } });
  });

  check("an explicit end time checks the entry used by the editor", async (f) => {
    await f.page.evaluate((entry) => { void window.__mapleTimerActions.stop(entry, new Date("2026-01-01T10:12:00.000Z")); }, running);
    const request = await f.take("/api/maple/timer", "POST");
    assert.equal(request.body.expect_updated_at, running.updated_at);
    await f.answer(request, { entry: { ...running, active: false, ended_at: request.body.at, updated_at: now } });
  });

  check("earlier switch saves the chosen time once and Undo restores its original revision", async (f) => {
    await f.page.evaluate(() => { void window.__mapleSync.refresh(); });
    await f.answer(await f.take("/api/maple/state"), snapshot("switch-before", [running]));
    const at = "2026-01-01T10:12:00.000Z";
    await f.page.evaluate(({ entry, at }) => { void window.__mapleTimerActions.switchEarlier(entry, "R", new Date(at)); }, { entry: running, at });
    const request = await f.take("/api/maple/timer", "POST");
    assert.deepEqual(request.body, { action: "switch", id: running.id, side: "R", at, expect_updated_at: running.updated_at });
    const before = { segments: running.data.segments, started_at: running.started_at, ended_at: null, updated_at: running.updated_at };
    const entry = { ...running, updated_at: now, data: { ...running.data, segments: [
      { ...running.data.segments[0], end: at }, { side: "R", start: at, end: null },
    ] } };
    await f.answer(request, { entry, before });
    await f.page.waitForFunction(() => window.__mapleSync.toasts.some((t) => /Switched to Right at/.test(t.text)));
    await f.page.evaluate(() => window.__mapleSync.toasts.find((t) => /Switched to Right at/.test(t.text)).undo());
    const undo = await f.take("/api/maple/timer", "POST");
    assert.equal(undo.body.edit.op, "restore");
    assert.equal(undo.body.edit.expect_updated_at, entry.updated_at);
    assert.deepEqual(undo.body.edit.segments, before.segments);
    await f.answer(undo, { entry: running });
  });

  check("earlier switch reports a conflict without a success toast or automatic retry", async (f) => {
    await f.page.evaluate(() => { void window.__mapleSync.refresh(); });
    await f.answer(await f.take("/api/maple/state"), snapshot("switch-before", [running]));
    await f.page.evaluate((entry) => { void window.__mapleTimerActions.switchEarlier(entry, "R", new Date("2026-01-01T10:12:00.000Z"), { onError: (failure) => { window.__switchFailure = failure.kind; } }); }, running);
    const request = await f.take("/api/maple/timer", "POST");
    const changed = { ...running, updated_at: now };
    await f.answer(request, { reason: "changed", error: "The feed changed", entry: changed }, 409);
    await f.page.waitForFunction(() => window.__switchFailure === "changed");
    assert.equal(await f.page.evaluate(() => window.__mapleSync.toasts.some((t) => /Switched to Right at/.test(t.text))), false);
  });
}

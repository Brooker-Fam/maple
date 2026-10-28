import assert from "node:assert/strict";
import path from "node:path";

export async function checkProductionCare({ page, url, screenshots, settleView, noOverflow }) {
  const snapshot = () => page.evaluate(() => window.__productionCareFixture.snapshot());
  const strip = () => page.getByRole("group", { name: "Your medicines", exact: true });
  const editor = () => page.getByRole("dialog", { name: "Edit dose time", exact: true });
  const clock = () => page.getByLabel("Taken at: time", { exact: true });
  const date = () => page.getByLabel("Taken at: date", { exact: true });
  const heldEdit = () => strip().getByRole("button", { name: /^Edit time for Example medicine, logged/ });
  const openPicker = () => strip().getByRole("button", { name: /Open the list\.$/ }).click();
  const save = async () => {
    await editor().getByRole("button", { name: "Save time", exact: true }).click();
    await editor().waitFor({ state: "hidden" });
  };
  const close = async () => {
    await editor().getByRole("button", { name: "Cancel", exact: true }).click();
    await editor().waitFor({ state: "hidden" });
  };
  const capture = async (name) => {
    await settleView();
    await noOverflow();
    await page.screenshot({ path: path.join(screenshots, name) });
  };
  await page.goto(`${url}/care.html`);
  await strip().getByRole("button", { name: "Took it: your Example medicine", exact: true }).click();
  const toastEdit = page.locator("[data-maple-toasts]").getByRole("button", { name: "Edit time for Example medicine", exact: true });
  await toastEdit.waitFor();
  const first = await snapshot();
  assert.equal(first.requests.filter((request) => request.method === "POST").length, 1, "Took it performs one real logDose POST");
  assert.equal(first.server.length, 1);
  assert.equal(first.state.care.entries[0].id, first.server[0].id, "Production hook replaces the optimistic dose");
  assert.equal(first.server[0].at, "2026-10-28T13:30:00.000Z");
  assert.equal(await page.locator("[data-maple-toasts]").getByRole("button", { name: /min earlier/ }).count(), 0, "Confirmation exposes an exact editor instead of fixed offsets");
  await heldEdit().waitFor();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await capture(`today-toast-${width}-day.png`);
    const box = await heldEdit().boundingBox();
    assert(box && box.height >= 44, "Persistent Edit time has a 44px target");
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { document.documentElement.classList.add("dark", "maple-night"); document.documentElement.style.fontSize = "20px"; });
  await capture("today-toast-320-night-large-text.png");
  await page.evaluate(() => { document.documentElement.classList.remove("dark", "maple-night"); document.documentElement.style.fontSize = ""; });
  await page.setViewportSize({ width: 390, height: 844 });

  // This is the real toast callback from useCare, through its DOM event and
  // the real CareNavProvider. The fixture never constructs an Edit time action.
  await toastEdit.click();
  await editor().waitFor();
  assert.equal(await clock().inputValue(), "09:30");
  assert.equal(await date().inputValue(), "2026-10-28");
  await clock().fill("09:15");
  await close();
  assert.equal((await snapshot()).requests.length, 1, "Cancel after Took it does not write");
  assert.equal((await snapshot()).server[0].at, first.server[0].at);
  await heldEdit().click();
  assert.equal(await clock().inputValue(), "09:30", "Persistent editor opens the saved time after a cancelled draft");
  await clock().fill("09:10");
  await save();
  const edited = await snapshot();
  const patch = edited.requests.find((request) => request.method === "PATCH");
  assert.deepEqual(patch.body, { at: "2026-10-28T13:10:00.000Z", expect_updated_at: first.server[0].updated_at }, "Time save sends only the new timestamp and recorded version");
  assert.equal(patch.id, first.server[0].id);
  assert.deepEqual(edited.server[0].data, first.server[0].data);
  assert.equal(edited.server[0].note, first.server[0].note);
  assert.equal(edited.server.length, 1, "Editing a just-logged dose never creates another dose");
  assert.match(await heldEdit().innerText(), /9:10 AM/);

  // The held button is also present in the real picker. Opening the editor
  // must close that launcher so only one dialog remains to navigate.
  await openPicker();
  const picker = page.getByRole("dialog", { name: "My medicine", exact: true });
  await picker.waitFor();
  await picker.getByRole("button", { name: /^Edit time for Example medicine, logged/ }).click();
  await editor().waitFor();
  await picker.waitFor({ state: "hidden" });
  assert.equal(await clock().inputValue(), "09:10");
  await clock().fill("09:05");
  await save();
  let current = await snapshot();
  assert.equal(current.requests.at(-1).body.expect_updated_at, edited.server[0].updated_at, "Reopening uses the latest saved version");
  assert.equal(current.requests.filter((request) => request.method === "POST").length, 1, "Held Edit time cannot log a duplicate");
  console.log("PASS production Today: Took it → real toast Edit time → Cancel/Save, persistent held editor, picker closes, latest-version PATCH only");

  // A second dose of the same plan at the same timestamp must not steal
  // the hold or the original toast's exact-id target.
  await page.evaluate(() => window.__productionCareFixture.addSameTimeDose());
  await heldEdit().click();
  await clock().fill("09:00");
  await save();
  current = await snapshot();
  assert.equal(current.requests.at(-1).id, 1001, "Same-time dose cannot steal the held target");
  assert.equal(current.server.find((entry) => entry.id === 2002).at, "2026-10-28T13:05:00.000Z");
  await page.evaluate(() => window.__productionCareFixture.replayOriginalEdit());
  await editor().waitFor();
  assert.equal(await clock().inputValue(), "09:00", "An older toast callback resolves the current version of its original dose");
  await date().fill("2026-10-27");
  await clock().fill("20:00");
  await save();
  await page.evaluate(() => window.__productionCareFixture.clearToasts());
  await page.setViewportSize({ width: 320, height: 844 });
  await capture("today-held-yesterday-320-day.png");
  const persisted = (await snapshot()).server;
  await page.evaluate(() => window.__productionCareFixture.removeOriginal());
  // Polling updates React state asynchronously. Wait until the new UI and
  // CareNav's event listener have committed before simulating the next tap.
  await heldEdit().waitFor({ state: "hidden" });
  await settleView();
  await page.evaluate(() => window.__productionCareFixture.replayOriginalEdit());
  await page.getByText("That dose is no longer in the log.", { exact: true }).waitFor();
  assert.equal(await editor().count(), 0, "Deleted original cannot retarget its toast to a same-time dose");
  assert.equal(await heldEdit().count(), 0, "Deleted original cannot leave an editable held target for another dose");
  console.log("PASS identity: same-time doses keep their exact id, stale callback resolves current version, removed original never retargets");

  // A fresh page has no one-minute hold and no toast. The saved record must
  // still be easy to reach from Today → medicine picker → Recently logged.
  await page.goto(`${url}/care.html`);
  await page.waitForFunction(() => !!window.__productionCareFixture);
  await page.evaluate((entries) => window.__productionCareFixture.seedSaved(entries), persisted);
  await openPicker();
  await picker.waitFor();
  const recent = picker.getByRole("region", { name: "Recently logged", exact: true });
  await recent.waitFor();
  await capture("medicine-picker-320-day.png");
  await page.evaluate(() => { document.documentElement.classList.add("dark", "maple-night"); document.documentElement.style.fontSize = "20px"; });
  await capture("medicine-picker-320-night-large-text.png");
  const recentOriginal = recent.getByRole("button", { name: /^Edit time for Example medicine,/ }).last();
  await recentOriginal.click();
  await editor().waitFor();
  await picker.waitFor({ state: "hidden" });
  assert.equal(await date().inputValue(), "2026-10-27");
  assert.equal(await clock().inputValue(), "20:00", "Picker's recent dose opens the chosen saved record after the transient confirmation is gone");
  await close();
  assert.equal((await snapshot()).requests.length, 0, "Opening and cancelling from persistent history does not write");
  console.log("PASS durable route: Today medicine picker → Recently logged → exact chosen dose, after toast and hold are gone");
  await page.setViewportSize({ width: 390, height: 844 });
}

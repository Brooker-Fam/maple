/** Real forms and provider: rejected requests retain drafts; pending writes cannot race later edits. */
export function saveCases({ assert, fixture, freshState, record, NOW }) {
  const kinds = [
    ["Pump", "pump", "left, oz", "2"],
    ["Sleep", "sleep"],
    ["Tummy time", "tummy"],
    ["Bath", "bath"],
    ["Diaper", "diaper"],
    ["Growth", "growth", "pounds", "8"],
    ["Vitamin D", "med"],
    ["Temperature", "temp", "temperature in degrees Fahrenheit", "98.6"],
    ["Other readings", "vitals", "heart rate, beats per minute", "120"],
    ["Bottle", "feed", "ounces", "2"],
    ["Nursing", "feed", "minutes on the left", "5"],
  ];
  const writes = (f) => f.requests.filter((req) => req.pathname === "/api/maple/entries" && req.method !== "GET");
  const open = async (page, label) => {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
    const picker = page.getByRole("dialog", { name: "Log earlier", exact: true });
    await picker.getByRole("button", { name: label, exact: true }).click();
    await picker.waitFor({ state: "hidden" });
    const form = page.getByRole("dialog").last();
    await form.waitFor();
    return form;
  };
  const primary = (form) => form.getByRole("button", { name: /^(?:Log it|Log .+|Save)$/ });
  const assertLocked = async (f, form, editing = false) => {
    assert(await form.locator("textarea").isDisabled(), "The submitted note stays fixed while saving");
    const nudge = form.getByRole("button", { name: "1 minute earlier", exact: true }).first();
    if (await nudge.count()) {
      const before = await form.locator('input[type="time"]').evaluateAll((inputs) => inputs.map((input) => input.value));
      await nudge.scrollIntoViewIfNeeded();
      const box = await nudge.boundingBox();
      await f.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.deepEqual(await form.locator('input[type="time"]').evaluateAll((inputs) => inputs.map((input) => input.value)), before, "Pressing a disabled time nudge must not alter the pending draft");
    }
    assert.equal(await form.getByRole("button", { name: "Close", exact: true }).count(), 0);
    if (editing) assert(await form.getByRole("button", { name: "Delete", exact: true }).isDisabled());
    await f.page.keyboard.press("Escape");
    await f.page.goBack();
    await f.page.waitForTimeout(80);
    assert(await form.isVisible(), "Back and Escape must keep the pending save open");
  };
  return [
    ...kinds.map(([label, kind, field, value]) => [`${label} retains rejected logs and locks pending creation and edits`, async () => {
      let response = "reject";
      let release;
      let started;
      let requestStarted = new Promise((resolve) => { started = resolve; });
      const f = await fixture({ entryResponse: async ({ route, req, state }) => {
        if (response !== "retry") await new Promise((resolve) => { release = resolve; started(); });
        if (response === "reject") return route.fulfill({ status: 400, json: { error: "Synthetic rejected entry" } });
        const body = req.postDataJSON();
        const saved = req.method() === "PATCH"
          ? { ...state.entries[0], ...body, data: { ...state.entries[0].data, ...body.data }, updated_at: NOW }
          : record(900, kind, body.data, body.started_at, { ended_at: body.ended_at ?? null, note: body.note });
        state.entries = [saved]; state.rev = `${state.rev}-saved`;
        return route.fulfill({ json: { entry: saved } });
      } });
      try {
        await f.page.goto("https://logging-recovery.example.test/#today");
        let form = await open(f.page, label);
        if (field) await form.getByRole("textbox", { name: field, exact: true }).fill(value);
        await form.locator("textarea").fill("Synthetic draft to keep");
        const clocks = await form.locator('input[type="time"]').evaluateAll((inputs) => inputs.map((input) => input.value));
        await primary(form).dblclick();
        await requestStarted;
        await assertLocked(f, form);
        assert.equal(writes(f).length, 1, "A double tap submits once");
        release();
        await f.page.getByText("Synthetic rejected entry", { exact: true }).waitFor();
        await f.page.waitForTimeout(300);
        assert(await form.isVisible(), "Hard rejection must not dismiss the draft");
        assert.equal(await form.locator("textarea").inputValue(), "Synthetic draft to keep");
        assert.deepEqual(await form.locator('input[type="time"]').evaluateAll((inputs) => inputs.map((input) => input.value)), clocks);
        if (field) assert.equal(await form.getByRole("textbox", { name: field, exact: true }).inputValue(), value);
        response = "retry";
        await form.locator("textarea").fill("Synthetic corrected draft");
        await primary(form).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(f.state.entries[0].note, "Synthetic corrected draft");
        assert.equal(writes(f).length, 2);

        await f.page.goto("https://logging-recovery.example.test/#log");
        await f.page.getByRole("button", { name: /^Edit:/ }).first().click();
        form = f.page.getByRole("dialog").last();
        await form.locator("textarea").fill("Synthetic saved-entry correction");
        response = "edit";
        requestStarted = new Promise((resolve) => { started = resolve; });
        await primary(form).dblclick();
        await requestStarted;
        await assertLocked(f, form, true);
        assert.equal(writes(f).length, 3);
        release();
        await form.waitFor({ state: "hidden" });
        assert.equal(f.state.entries[0].note, "Synthetic saved-entry correction");
        assert.deepEqual(f.errors, []);
      } finally { release?.(); await f.close(); }
    }]),
    ...["Pump", "Bottle"].map((label) => [`${label} closes only after its offline draft is stored once`, async () => {
      const [, kind, field, value] = kinds.find(([name]) => name === label);
      const f = await fixture({ entryResponse: ({ route }) => route.fulfill({ status: 503, json: { error: "Synthetic temporary outage" } }) });
      try {
        await f.page.goto("https://logging-recovery.example.test/#today");
        const form = await open(f.page, label);
        await form.getByRole("textbox", { name: field, exact: true }).fill(value);
        await form.locator("textarea").fill("Synthetic offline draft");
        await primary(form).dblclick();
        await form.waitFor({ state: "hidden" });
        await f.page.waitForFunction(() => window.__loggingReview.pending.length === 1);
        const queued = await f.page.evaluate(() => JSON.parse(localStorage.getItem("maple-outbox-v1")));
        assert.equal(queued.length, 1);
        assert.equal(queued[0].input.kind, kind);
        assert.equal(queued[0].input.note, "Synthetic offline draft");
        assert.equal(writes(f).length, 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ...[false, true].map((correctTemperature) => [`Temperature retries partial vitals failure without duplicating its saved reading${correctTemperature ? " after a correction" : ""}`, async () => {
      let rejectVitals = true;
      const state = freshState();
      const f = await fixture({ state, entryResponse: ({ route, req, state }) => {
        const body = req.postDataJSON();
        if (body.kind === "vitals" && rejectVitals) return route.fulfill({ status: 400, json: { error: "Synthetic rejected other readings" } });
        const saved = req.method() === "PATCH"
          ? { ...state.entries[0], ...body, data: { ...state.entries[0].data, ...body.data }, updated_at: NOW }
          : record(state.entries.length + 900, body.kind, body.data, body.started_at, { note: body.note });
        state.entries = [saved, ...state.entries.filter((entry) => entry.id !== saved.id)];
        state.rev = `${state.rev}-saved`;
        return route.fulfill({ json: { entry: saved } });
      } });
      try {
        await f.page.goto("https://logging-recovery.example.test/#today");
        const form = await open(f.page, "Temperature");
        await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.6");
        await form.getByRole("textbox", { name: "heart rate, beats per minute", exact: true }).fill("120");
        await primary(form).click();
        await f.page.getByText("Synthetic rejected other readings", { exact: true }).waitFor();
        assert(await form.isVisible());
        assert.equal(f.state.entries.length, 1);
        const firstAt = f.state.entries[0].started_at;
        if (correctTemperature) await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.8");
        rejectVitals = false;
        await primary(form).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(f.state.entries.length, 2);
        assert.equal(writes(f).filter((req) => req.method === "POST" && req.body.kind === "temp").length, 1);
        assert.equal(writes(f).filter((req) => req.method === "PATCH").length, correctTemperature ? 1 : 0);
        assert(f.state.entries.every((entry) => entry.started_at === firstAt));
        assert.equal(f.state.entries.find((entry) => entry.kind === "vitals").data.heart_bpm, 120);
        assert.equal(f.state.entries.find((entry) => entry.kind === "temp").id, 900);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
  ];
}

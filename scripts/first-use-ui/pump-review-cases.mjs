export function pumpReviewCases({ fixture, freshState, record, writes, assert }) {
  const openNew = async (page) => {
    await page.goto("https://first-use.example.test/#today");
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Pump", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Pump", exact: true });
    await form.waitFor();
    return form;
  };
  const openSaved = async (page) => {
    await page.goto("https://first-use.example.test/#log");
    const row = page.getByRole("button", { name: /^Edit: Pumped,/ });
    await row.click();
    const form = page.getByRole("dialog", { name: "Pumped", exact: true });
    await form.waitFor();
    return form;
  };
  return [
    ...[
      { name: "one recorded side", data: { left_ml: 30 }, label: "1.01 oz · L 1.01 oz / R not logged" },
      { name: "one zero side", data: { right_ml: 0 }, label: "0 oz · L not logged / R 0 oz" },
      { name: "zero total", data: { total_ml: 0 }, label: "0 oz" },
      { name: "unknown total", data: {}, label: "Amount not logged" },
    ].map(({ name, data, label }) => [`Pump history keeps unknown and zero distinct: ${name}`, async () => {
      const state = freshState();
      state.entries = [record(706, "pump", data)];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        const row = f.page.getByRole("button", { name: /^Edit: Pumped,/ });
        assert((await row.innerText()).includes(label), `${name} should show ${label}`);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ...["sides", "total"].map((mode) => [`Cleared pump measurements stay unknown when saved as ${mode}`, async () => {
      const state = freshState();
      const original = record(705, "pump", { left_ml: 30 });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        const form = await openSaved(f.page);
        await form.getByRole("radio", { name: "Total", exact: true }).click();
        await form.getByRole("radio", { name: "Each side", exact: true }).click();
        await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("");
        if (mode === "total") {
          await form.getByRole("radio", { name: "Total", exact: true }).click();
          assert.equal(await form.getByRole("textbox", { name: "total, oz", exact: true }).inputValue(), "");
        }
        assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled());
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, mode === "total" ? { left_ml: null, right_ml: null, total_ml: null } : { left_ml: null, total_ml: null });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ...["us", "metric"].map((units) => [`Small pump amounts remain visible in ${units} history and editing`, async () => {
      const state = freshState();
      state.entries = [record(701, "pump", { left_ml: 1, right_ml: 2 }, undefined, { ended_at: "2026-10-28T12:15:00.000Z" })];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...state.entries[0], ...req.postDataJSON() } } }) });
      try {
        await f.page.addInitScript((value) => localStorage.setItem("maple-units", value), units);
        await f.page.goto("https://first-use.example.test/#log");
        const row = f.page.getByRole("button", { name: /^Edit: Pumped,/ });
        assert.match(await row.innerText(), units === "metric" ? /3 ml · L 1 ml \/ R 2 ml/ : /0\.1 oz · L 0\.03 oz \/ R 0\.07 oz/);
        await row.click();
        const form = f.page.getByRole("dialog", { name: "Pumped", exact: true });
        const unit = units === "metric" ? "ml" : "oz";
        assert.equal(await form.getByRole("textbox", { name: `left, ${unit}`, exact: true }).inputValue(), units === "metric" ? "1" : "0.03");
        assert.equal(await form.getByRole("textbox", { name: `right, ${unit}`, exact: true }).inputValue(), units === "metric" ? "2" : "0.07");
        await form.locator("textarea").fill("Synthetic small collection");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data, undefined);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ["Pump amount edits preserve a newer caregiver note and an unknown duration", async () => {
      const state = freshState();
      state.entries = [record(702, "pump", { left_ml: 60, right_ml: 60 }, undefined, { note: "Original synthetic note" })];
      const latest = { ...state.entries[0], note: "Newer synthetic caregiver note" };
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => {
        const patch = req.postDataJSON();
        Object.assign(latest, patch, { data: { ...latest.data, ...patch.data } });
        return route.fulfill({ json: { entry: latest } });
      } });
      try {
        const form = await openSaved(f.page);
        await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("3");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.note, undefined);
        assert.equal(writes(f)[0]?.body.ended_at, undefined);
        assert.equal(latest.note, "Newer synthetic caregiver note");
        assert.equal(latest.ended_at, null);
        assert.equal(latest.data.left_ml, 88.7);
        assert.equal(latest.data.right_ml, 60);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["New pump entries leave unrecorded duration unknown", async () => {
      const f = await fixture({ entryResponse: ({ route, req, state, records }) => {
        const entry = record(703, "pump", req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON());
        state.entries = [entry];
        records.push(entry);
        return route.fulfill({ json: { entry } });
      } });
      try {
        const form = await openNew(f.page);
        await form.getByRole("textbox", { name: "left, oz", exact: true }).fill("1.6");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.ended_at, null);
        assert.equal(writes(f)[0]?.body.data.left_ml, 47.3);
        await f.page.getByRole("button", { name: "History", exact: true }).click();
        const row = f.page.getByRole("button", { name: /^Edit: Pumped,/ });
        assert.match(await row.innerText(), /1\.6 oz/);
        assert.doesNotMatch(await row.innerText(), /15m|0m/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A pump duration is recorded only after choosing it", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(704, "pump", req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        const form = await openNew(f.page);
        await form.getByRole("checkbox", { name: "Include duration", exact: true }).check();
        assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled());
        await form.getByRole("button", { name: "20m", exact: true }).click();
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0]?.body;
        assert.equal(Date.parse(saved.ended_at) - Date.parse(saved.started_at), 20 * 60_000);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Pump amount mode has a named keyboard accessible radio group", async () => {
      const f = await fixture();
      try {
        const form = await openNew(f.page);
        const group = form.getByRole("radiogroup", { name: "Pumped amounts", exact: true });
        const sides = group.getByRole("radio", { name: "Each side", exact: true });
        await sides.focus();
        await sides.press("ArrowRight");
        const total = group.getByRole("radio", { name: "Total", exact: true });
        assert.equal(await total.getAttribute("aria-checked"), "true");
        assert(await total.evaluate((element) => element === document.activeElement));
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

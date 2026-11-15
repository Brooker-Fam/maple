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
        // Nobody set a start, so it just finished: the duration counts back from when the form opened.
        assert(Math.abs(Date.parse(saved.ended_at) - Date.parse(freshState().now)) < 60_000, "An untouched start ends the pump now, never after it");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A pump duration runs on from the start chosen before it, moving the end", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(707, "pump", req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        const form = await openNew(f.page);
        await form.getByLabel("When: exact time: time", { exact: true }).fill("09:00");
        await form.getByRole("checkbox", { name: "Include duration", exact: true }).check();
        await form.getByRole("button", { name: "20m", exact: true }).click();
        assert.equal(await form.getByLabel("Started: time", { exact: true }).inputValue(), "09:00", "Choosing a duration keeps the start");
        assert.equal(await form.getByLabel("Ended: time", { exact: true }).inputValue(), "09:20", "Choosing a duration moves the end");
        await form.getByRole("button", { name: "30m", exact: true }).click();
        assert.equal(await form.getByLabel("Started: time", { exact: true }).inputValue(), "09:00");
        assert.equal(await form.getByLabel("Ended: time", { exact: true }).inputValue(), "09:30");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0]?.body;
        assert.equal(saved.started_at, "2026-10-28T13:00:00.000Z");
        assert.equal(saved.ended_at, "2026-10-28T13:30:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Log earlier: a pump's start moved by hand stays put when a duration is chosen", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(708, "pump", req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Pump", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Pump", exact: true });
        const start = form.getByLabel("Started: time", { exact: true });
        const end = form.getByLabel("Ended: time", { exact: true });
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        await start.fill("08:40");
        assert.equal(await end.inputValue(), "09:30", "Moving the start keeps the end");
        await duration.getByRole("button", { name: "20m", exact: true }).click();
        assert.equal(await start.inputValue(), "08:40", "The start someone set is never moved by a duration");
        assert.equal(await end.inputValue(), "09:00");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0]?.body;
        assert.equal(saved.started_at, "2026-10-28T12:40:00.000Z");
        assert.equal(saved.ended_at, "2026-10-28T13:00:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A pump duration that would end after now is off rather than moving the start", async () => {
      const f = await fixture();
      try {
        const form = await openNew(f.page);
        await form.getByRole("button", { name: "15 min ago", exact: true }).click();
        await form.getByRole("checkbox", { name: "Include duration", exact: true }).check();
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        const start = await form.getByLabel("Started: time", { exact: true }).inputValue();
        for (const m of ["10m", "15m"]) assert(await duration.getByRole("button", { name: m, exact: true }).isEnabled(), `${m} fits before now`);
        for (const m of ["20m", "30m", "45m"]) assert(await duration.getByRole("button", { name: m, exact: true }).isDisabled(), `${m} would end after now`);
        await duration.getByText("A longer one would end after now. Choose an earlier start first.", { exact: true }).waitFor();
        await duration.getByRole("button", { name: "10m", exact: true }).click();
        assert.equal(await form.getByLabel("Started: time", { exact: true }).inputValue(), start);
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A saved pump's new duration keeps its start and changes only its end", async () => {
      const state = freshState();
      const original = record(709, "pump", { total_ml: 90 }, "2026-10-28T12:00:00.000Z", { ended_at: "2026-10-28T12:15:00.000Z" });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        const form = await openSaved(f.page);
        const start = form.getByLabel("Started: time", { exact: true });
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        // A start draft past the end holds the chips: they'd count from a start no longer on screen.
        await start.fill("08:30");
        assert(await duration.getByRole("button", { name: "30m", exact: true }).isDisabled());
        await duration.getByText("Check the start date and time before choosing a duration.", { exact: true }).waitFor();
        await start.fill("08:00");
        await duration.getByRole("button", { name: "30m", exact: true }).click();
        assert.equal(await start.inputValue(), "08:00");
        assert.equal(await form.getByLabel("Ended: time", { exact: true }).inputValue(), "08:30");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const patch = writes(f)[0]?.body;
        assert.equal(patch.started_at, undefined, "The saved start is not rewritten");
        assert.equal(patch.ended_at, "2026-10-28T12:30:00.000Z");
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

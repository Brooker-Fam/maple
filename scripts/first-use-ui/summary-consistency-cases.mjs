export function summaryConsistencyCases({ fixture, freshState, record, assert }) {
  const copySummary = async (f) => {
    await f.page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { get: () => undefined }));
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: "More", exact: true }).click();
    await f.page.getByRole("button", { name: /^For the doctor/ }).click();
    const dialog = f.page.getByRole("dialog", { name: "For the doctor", exact: true });
    await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
    return dialog;
  };
  return [
    ["Summary consistency: doctor exports preserve small bottle measurements", async () => {
      const state = freshState();
      state.entries = [record(919, "feed", { method: "bottle", milk: "formula", amount_ml: 1.5 })];
      const f = await fixture({ state, records: state.entries });
      try {
        const dialog = await copySummary(f);
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        assert.match(text, /1 bottle, 0\.05 oz \(1\.5 ml\)/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Summary freshness: copied totals include fetched corrections and new entries", async () => {
      const state = freshState();
      state.entries = [record(920, "pump", { total_ml: 60 }, undefined, { ended_at: "2026-10-28T12:20:00.000Z" })];
      const records = [
        { ...state.entries[0], data: { total_ml: 90 }, updated_at: "2026-10-28T13:31:00.000Z" },
        record(921, "pump", { total_ml: 30 }, "2026-10-28T13:00:00.000Z", { ended_at: "2026-10-28T13:10:00.000Z" }),
      ];
      const f = await fixture({ state, records });
      try {
        const dialog = await copySummary(f);
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        assert.match(text, /pumping 2 sessions · 30m · 4\.06 oz \(120 ml\) logged/);
        assert.ok(f.requests.some(({ query }) => query.includes("from=")));
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Summary freshness: copied totals exclude entries removed from the fresh result", async () => {
      const state = freshState();
      state.entries = [record(922, "feed", { method: "bottle", milk: "formula", amount_ml: 60 })];
      const f = await fixture({ state, records: [] });
      try {
        const dialog = await copySummary(f);
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        assert.match(text.split("\n").find((line) => line.includes("(so far):")), /: 0 feeds ·/);
        assert.doesNotMatch(text, /1 bottle/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Summary freshness: pending local entries prevent incomplete or duplicate exports", async () => {
      const state = freshState();
      state.entries = [record(-923, "pump", { total_ml: 60 })];
      const f = await fixture({ state, records: [record(923, "pump", { total_ml: 60 })] });
      try {
        const dialog = await copySummary(f);
        await dialog.getByRole("alert").filter({ hasText: "waiting to sync" }).waitFor();
        assert.equal(await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).count(), 0);
        assert.equal(f.requests.filter(({ pathname, method }) => pathname === "/api/maple/entries" && method !== "GET").length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Summary freshness: all-time growth uses fetched corrections, additions and removals", async () => {
      const state = freshState();
      state.growth = [
        record(924, "growth", { weight_g: 4000 }, "2026-10-15T12:00:00.000Z"),
        record(925, "growth", { weight_g: 4100 }, "2026-10-16T12:00:00.000Z"),
      ];
      const records = [
        { ...state.growth[0], data: { weight_g: 4200 }, updated_at: "2026-10-28T13:31:00.000Z" },
        record(926, "growth", { weight_g: 4300 }, "2026-10-17T12:00:00.000Z"),
      ];
      const f = await fixture({ state, records });
      try {
        const dialog = await copySummary(f);
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        assert.match(text, /\(4\.2 kg\)/);
        assert.match(text, /\(4\.3 kg\)/);
        assert.doesNotMatch(text, /\(4 kg\)|\(4\.1 kg\)/);
        assert.ok(f.requests.some(({ query }) => query.includes("kind=growth")));
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ...["unavailable", "truncated"].map((failure) => [`Summary freshness: ${failure} growth history prevents copying`, async () => {
      const f = await fixture();
      try {
        await f.page.route("**/api/maple/entries?kind=growth*", (route) => failure === "unavailable"
          ? route.fulfill({ status: 503, json: { error: "Synthetic growth history failure" } })
          : route.fulfill({ json: { entries: [], truncated: true } }));
        const dialog = await copySummary(f);
        await dialog.getByRole("alert").filter({ hasText: "Summary not copied" }).waitFor();
        assert.equal(await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ...["us", "metric"].flatMap((units) => ["pump", "bottle"].map((kind) => [`Summary consistency: small ${kind} measurements stay visible in ${units} charts`, async () => {
      const state = freshState();
      const amount = units === "us" ? 3 : 0.1;
      const entry = (id, ml, at) => kind === "pump"
        ? record(id, "pump", { total_ml: ml }, at)
        : record(id, "feed", { method: "bottle", milk: "formula", amount_ml: ml }, at);
      state.entries = [entry(901, 600, "2026-10-27T12:00:00.000Z"), entry(902, amount)];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.addInitScript((units) => localStorage.setItem("maple-units", units), units);
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.getByRole("radio", { name: "Patterns", exact: true }).click();
        await f.page.getByRole("radio", { name: "Daily totals", exact: true }).click();
        await f.page.getByRole("button", { name: "Charts", exact: true }).click();
        await f.page.getByRole("button", { name: /More charts/ }).click();
        const chart = f.page.getByRole("img", { name: kind === "pump" ? /^Recorded pump volume per day:/ : /^Bottle volume per day:/ });
        await chart.waitFor();
        assert.match(await chart.getAttribute("aria-label"), units === "us" ? /10\/28 0.1 oz/ : /10\/28 0.1 ml/);
        const marks = chart.locator(`path[fill="var(--v-${kind})"], rect[fill="var(--v-${kind})"]`);
        assert.equal(await marks.count(), 2, "Both positive measurements must have a visible bar");
        assert.ok(await marks.last().evaluate((mark) => mark.getBBox().height >= 2), "Small positive measurements need a visible minimum marker");
        const labels = await chart.textContent();
        assert.doesNotMatch(labels, /0\.10144/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }])),
    ...[
      { name: "unknown", data: {}, volume: /Amount not logged/ },
      { name: "zero", data: { total_ml: 0 }, volume: /0 oz \(0 ml\) logged/ },
      { name: "partial", data: { total_ml: 60 }, volume: /2.03 oz \(60 ml\) logged · 1 without amount/ },
    ].map(({ name, data, volume }) => [`Summary consistency: visit export preserves ${name} pumping measurements`, async () => {
      const state = freshState();
      state.entries = [record(903, "pump", data, undefined, { ended_at: "2026-10-28T12:20:00.000Z" })];
      if (name === "partial") state.entries.push(record(904, "pump", {}, "2026-10-28T11:00:00.000Z"));
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("Synthetic clipboard unavailable"); } } }));
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.getByRole("radio", { name: "Patterns", exact: true }).click();
        await f.page.getByRole("button", { name: /^For the doctor:/ }).click();
        await f.page.getByRole("button", { name: "Copy summary", exact: true }).click();
        const text = await f.page.locator("textarea[readonly]").inputValue();
        const today = text.split("\n").find((line) => line.includes("(so far):"));
        assert.match(today, name === "partial" ? /pumping 2 sessions · 20m/ : /pumping 1 session · 20m/);
        assert.match(today, volume);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
  ];
}

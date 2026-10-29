export function pumpSummaryCases({ fixture, freshState, record, assert }) {
  const openTotals = async (page) => {
    await page.goto("https://first-use.example.test/#log");
    await page.getByRole("radio", { name: "Patterns", exact: true }).click();
    await page.getByRole("radio", { name: "Daily totals", exact: true }).click();
  };
  return [
    ["Duration-only pumping remains a logged day with no invented volume", async () => {
      const state = freshState();
      state.entries = [record(801, "pump", {}, undefined, { ended_at: "2026-10-28T12:20:00.000Z" })];
      const f = await fixture({ state, records: state.entries });
      try {
        await openTotals(f.page);
        const table = f.page.getByRole("region", { name: "Daily totals table", exact: true });
        await table.waitFor();
        assert.match(await table.innerText(), /1 session · 20m/);
        assert.match(await table.innerText(), /Amount not logged/);
        assert.doesNotMatch(await table.innerText(), /0 oz/);
        assert.equal(await f.page.getByText("No daily totals logged in this range", { exact: true }).count(), 0);
        await f.page.getByRole("button", { name: "Charts", exact: true }).click();
        await f.page.getByRole("button", { name: /More charts/ }).click();
        const chart = f.page.getByRole("img", { name: /^Pumping sessions per day:/ });
        await chart.waitFor();
        assert.match(await chart.getAttribute("aria-label"), /1 session · 20m, Amount not logged/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Pump totals distinguish measured zero from an unknown amount", async () => {
      const state = freshState();
      state.entries = [
        record(802, "pump", { total_ml: 0 }, "2026-10-27T12:00:00.000Z", { ended_at: "2026-10-27T12:10:00.000Z" }),
        record(803, "pump", {}, undefined, { ended_at: "2026-10-28T12:20:00.000Z" }),
      ];
      const f = await fixture({ state, records: state.entries });
      try {
        await openTotals(f.page);
        const table = f.page.getByRole("region", { name: "Daily totals table", exact: true });
        await table.waitFor();
        const rows = table.getByRole("row");
        assert.match(await rows.filter({ hasText: "Yesterday" }).innerText(), /1 session · 10m[\s\S]*0 oz logged/);
        assert.match(await rows.filter({ hasText: "Today" }).innerText(), /1 session · 20m[\s\S]*Amount not logged/);
        await f.page.getByRole("button", { name: "Charts", exact: true }).click();
        await f.page.getByRole("button", { name: /More charts/ }).click();
        const chart = f.page.getByRole("img", { name: /^Recorded pump volume per day:/ });
        await chart.waitFor();
        assert.match(await chart.getAttribute("aria-label"), /10\/27 0 oz logged, 10\/28 Amount not logged/);
        assert.equal(await chart.getByText("?", { exact: true }).count(), 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Partial pump totals disclose sessions without measurements", async () => {
      const state = freshState();
      state.entries = [
        record(804, "pump", { total_ml: 60 }, "2026-10-28T11:00:00.000Z", { ended_at: "2026-10-28T11:15:00.000Z" }),
        record(805, "pump", {}, undefined, { ended_at: "2026-10-28T12:20:00.000Z" }),
      ];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
        await openTotals(f.page);
        const table = f.page.getByRole("region", { name: "Daily totals table", exact: true });
        await table.waitFor();
        assert.match(await table.innerText(), /2 sessions · 35m/);
        assert.match(await table.innerText(), /60 ml logged · 1 without amount/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

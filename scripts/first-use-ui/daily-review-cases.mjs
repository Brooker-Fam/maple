export function dailyReviewCases({ fixture, freshState, record, writes, assert }) {
  return [
    ["Today includes sleep continuing from the previous family day", async () => {
      for (const active of [false, true]) {
        const state = freshState();
        state.now = "2026-10-28T06:30:00.000Z";
        state.entries = [record(901, "sleep", {}, "2026-10-28T03:00:00.000Z", {
          ended_at: active ? null : "2026-10-28T06:00:00.000Z", active,
        })];
        const f = await fixture({ state, records: state.entries });
        try {
          await f.page.goto("https://first-use.example.test/#today");
          const summary = f.page.getByRole("region", { name: "Logged today", exact: true });
          await summary.waitFor();
          assert.match(await summary.innerText(), active ? /2h 30m sleep logged/ : /2h 00m sleep logged/);
          assert.doesNotMatch(await summary.innerText(), /No sleep logged today/);
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
      const state = freshState();
      state.entries = [record(902, "sleep", {}, "2026-10-28T01:00:00.000Z", { ended_at: "2026-10-28T03:00:00.000Z" })];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        const summary = f.page.getByRole("region", { name: "Logged today", exact: true });
        await summary.waitFor();
        assert.match(await summary.innerText(), /No sleep logged today/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Diaper guidance follows the recorded age when backfilling or editing", async () => {
      for (const editing of [false, true]) {
        const state = freshState();
        if (editing) state.entries = [record(903, "diaper", { pee: false, poop: true, color: "black" }, "2026-10-02T13:30:00.000Z")];
        const f = await fixture({ state, records: state.entries });
        try {
          await f.page.goto("https://first-use.example.test/#today");
          if (editing) {
            await f.page.getByRole("button", { name: /^Edit: Dirty diaper,/ }).click();
          } else {
            await f.page.getByRole("button", { name: "More", exact: true }).click();
            await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
            await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Diaper", exact: true }).click();
          }
          const form = f.page.getByRole("dialog").last();
          await form.getByRole("radio", { name: "Poop", exact: true }).click();
          if (!editing) {
            await form.getByRole("button", { name: "Pick a time", exact: true }).click();
            await form.getByLabel("When: exact time: date", { exact: true }).fill("2026-10-02");
            await form.getByRole("radio", { name: "Black / tarry", exact: true }).click();
          }
          const warning = form.getByText("Still black poop after Day 4", { exact: true });
          assert.equal(await warning.count(), 0, "A Day 2 diaper must use the baby's age when recorded");
          const date = form.getByLabel("When: exact time: date", { exact: true });
          const time = form.getByLabel("When: exact time: time", { exact: true });
          await date.fill("2026-10-05");
          await time.fill("07:59");
          assert.equal(await warning.count(), 0, "The existing threshold does not apply before 96 hours");
          await time.fill("08:00");
          await warning.waitFor();
          await date.fill("2026-10-02");
          assert.equal(await warning.count(), 0, "Changing the date back must remove the later-age warning");
          await form.getByRole("button", { name: "Now", exact: true }).click();
          await warning.waitFor();
          assert.equal(writes(f).length, 0);
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
  ];
}

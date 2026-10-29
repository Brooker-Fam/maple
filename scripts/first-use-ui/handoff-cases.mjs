export function handoffCases({ fixture, freshState, record, writes, assert }) {
  const helper = { email: "helper@example.test", display_name: "Alex", role: "member", emoji: null, color: null };
  const awayState = () => {
    const state = freshState();
    state.seen_at = "2026-10-28T09:30:00.000Z";
    state.members.push(helper);
    return state;
  };
  const fromHelper = (id, kind, data, extra = {}) => record(id, kind, data, "2026-10-28T12:00:00.000Z", { created_by: helper.email, ...extra });
  return [
    ["Handoff includes every other logging kind with real details", async () => {
      for (const [kind, data, extra, title, detail] of [
        ["tummy", {}, { ended_at: "2026-10-28T12:05:00.000Z" }, "Tummy time", "5m"],
        ["pump", { total_ml: 60 }, { ended_at: "2026-10-28T12:10:00.000Z" }, "Pumped", "10m"],
        ["bath", {}, {}, "Bath", "8:00 AM"],
        ["temp", { temp_c: 37 }, {}, "Temperature", "98.6"],
        ["vitals", { heart_bpm: 120 }, {}, "Vitals", "120 bpm"],
        ["growth", { weight_g: 3600 }, {}, "Measured", "7 lb"],
        ["med", { name: "Synthetic medicine", dose: "Recorded label amount" }, {}, "Synthetic medicine", "Recorded label amount"],
        ["note", {}, { note: "Synthetic handoff note" }, "Note", "Synthetic handoff note"],
      ]) {
        const state = awayState();
        state.entries = [fromHelper(61, kind, data, extra)];
        const f = await fixture({ state, records: state.entries });
        try {
          await f.page.goto("https://first-use.example.test/#today");
          const recap = f.page.getByRole("button", { name: /^While you slept/ });
          assert.match(await recap.innerText(), /1 update/, `${kind} must have a meaningful collapsed recap`);
          await recap.click();
          const updates = f.page.getByRole("list", { name: "Other logged updates", exact: true });
          assert.match(await updates.innerText(), new RegExp(title));
          assert.match(await updates.innerText(), new RegExp(detail));
          assert.match(await updates.innerText(), /8:00 AM/, "Handoff clocks use the family's zone, not the browser's");
          assert.equal(await updates.getByRole("listitem").count(), 1);
          assert.equal(writes(f).length, 0, "Reading the recap does not alter the log");
          await f.page.getByRole("button", { name: "Got it", exact: true }).click();
          await recap.waitFor({ state: "hidden" });
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["Handoff keeps mixed updates compact and opens History for the full log", async () => {
      const state = awayState();
      state.me = { ...state.me, role: "viewer" };
      state.members[0] = state.me;
      state.entries = [
        fromHelper(70, "feed", { method: "bottle", amount_ml: 60 }),
        fromHelper(71, "note", {}, { note: "Latest synthetic note", started_at: "2026-10-28T13:00:00.000Z" }),
        fromHelper(72, "bath", {}, { started_at: "2026-10-28T12:50:00.000Z" }),
        fromHelper(73, "tummy", {}, { started_at: "2026-10-28T12:40:00.000Z", ended_at: "2026-10-28T12:45:00.000Z" }),
        fromHelper(74, "pump", { total_ml: 60 }, { started_at: "2026-10-28T12:30:00.000Z", ended_at: "2026-10-28T12:35:00.000Z" }),
        record(75, "note", {}, "2026-10-28T12:25:00.000Z", { note: "My own note" }),
        fromHelper(76, "note", {}, { note: "Old helper note", started_at: "2026-10-28T09:00:00.000Z" }),
      ];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.setViewportSize({ width: 320, height: 740 });
        await f.page.goto("https://first-use.example.test/#today");
        const recap = f.page.getByRole("button", { name: /^While you slept/ });
        assert.match(await recap.innerText(), /1 feed.*4 other updates/, "Counts include the other caregiver's recent updates only");
        await recap.click();
        const details = f.page.locator("#wys-more");
        assert.match(await details.innerText(), /1 feed, at 8:00 AM/, "Existing feed recap stays present");
        assert.match(await details.innerText(), /Latest 3 of 4 other updates/, "A compact recap discloses omitted updates even when the collapsed line is truncated");
        const updates = f.page.getByRole("list", { name: "Other logged updates", exact: true });
        assert.equal(await updates.getByRole("listitem").count(), 3, "The handoff shows only the three newest other updates");
        assert.match(await updates.getByRole("listitem").first().innerText(), /Latest synthetic note/);
        assert.doesNotMatch(await updates.innerText(), /Pumped|My own note|Old helper note/);
        assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "The expanded handoff fits a narrow phone");
        if (process.env.MAPLE_HANDOFF_SCREENSHOT) await f.page.screenshot({ path: process.env.MAPLE_HANDOFF_SCREENSHOT, fullPage: true });
        await details.getByRole("button", { name: "View in History", exact: true }).click();
        await f.page.getByRole("heading", { name: "History", exact: true }).waitFor();
        assert.match(f.page.url(), /#history\/timeline$/);
        assert.equal(writes(f).length, 0, "A viewer can read the full log without saving anything");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

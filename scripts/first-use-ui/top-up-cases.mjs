/**
 * A bottle given with nursing is that feed's top-up (feed.ts topUpRunFor): the bottle form says so before it's
 * saved, Today keeps "Last fed" at the nursing start and adds the top-up to its line, and Today's recent rows and the
 * Timeline show it on that feed's row ("+ 35 ml top-up", feed-parts-cases.mjs), the day counting one feed. Made-up
 * times on the fixture's clock (9:30 AM in the family's zone).
 */
export function topUpCases({ fixture, freshState, record, writes, assert }) {
  const nursing = (id, start, mid, end) =>
    record(id, "feed", { method: "breast", segments: [{ side: "L", start, end: mid }, { side: "R", start: mid, end }], first_side: "L", last_side: "R" }, start, { ended_at: end, updated_at: end });
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  const openBottle = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: /^Bottle/ }).click();
    return f.page.getByRole("dialog", { name: "Feed", exact: true });
  };
  const reply = ({ route, req }) => route.fulfill({ json: { entry: record(99, "feed", req.postDataJSON().data, req.postDataJSON().started_at ?? "2026-10-28T13:30:00.000Z", req.postDataJSON()) } });
  return [
    ["A bottle just after nursing says it's that feed's top-up and saves as one bottle", async () => {
      const state = freshState();
      // 8:45–9:15 AM, Left then Right; the bottle comes 15 minutes after.
      state.entries = [nursing(41, "2026-10-28T12:45:00.000Z", "2026-10-28T13:00:00.000Z", "2026-10-28T13:15:00.000Z")];
      const f = await fixture({ state, entryResponse: reply });
      try {
        await metric(f);
        const form = await openBottle(f);
        assert.match(await form.textContent(), /A top-up for the 8:45 AM feed: part of that feed, not a feed of its own\./);
        await form.getByRole("textbox", { name: "millilitres", exact: true }).fill("35");
        await form.getByRole("button", { name: "Log 35 ml now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f).length, 1);
        assert.deepEqual(writes(f)[0]?.body.data, { method: "bottle", amount_ml: 35 });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A bottle long after nursing is a feed of its own, and the form doesn't call it a top-up", async () => {
      const state = freshState();
      // 6:30–7:00 AM: two and a half hours before.
      state.entries = [nursing(42, "2026-10-28T10:30:00.000Z", "2026-10-28T10:45:00.000Z", "2026-10-28T11:00:00.000Z")];
      const f = await fixture({ state, entryResponse: reply });
      try {
        await metric(f);
        const form = await openBottle(f);
        assert.doesNotMatch(await form.textContent(), /top-up/i);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Today and the Timeline read a top-up as part of its feed", async () => {
      const state = freshState();
      const fed = nursing(43, "2026-10-28T12:45:00.000Z", "2026-10-28T13:00:00.000Z", "2026-10-28T13:15:00.000Z");
      const topUp = record(44, "feed", { method: "bottle", amount_ml: 35, milk: "breastmilk" }, "2026-10-28T13:20:00.000Z");
      state.entries = [topUp, fed];
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("heading", { name: "Recently logged", exact: true }).waitFor();
        const today = await f.page.locator("body").textContent();
        // "Last feed started" stays at the nursing start (45 minutes ago, not the top-up's 10), with the top-up on its line.
        assert.match(today, /Last feed started\s*45m ago/);
        assert.match(today, /\+ 35 ml top-up/);
        assert(await f.page.getByRole("button", { name: /^Edit: \+ 35 ml top-up · breast milk, /, exact: false }).first().isVisible(), "Today's recent row for the feed carries its top-up");
        await f.page.goto("https://first-use.example.test/#log");
        const day = f.page.locator("#maple-day-2026-10-28");
        await day.waitFor();
        assert.match(await day.textContent(), /1 feed ·/);
        assert.match(await day.textContent(), /35 ml bottle \(1 top-up\)/);
        assert(await day.getByRole("button", { name: /^Edit: \+ 35 ml top-up · breast milk, / }).isVisible(), "The Timeline's row for the feed carries its top-up");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["The visit summary keeps the care team's target, the top-ups apart from bottles, and what the bottles held", async () => {
      const state = freshState();
      state.baby.settings = { ...state.baby.settings, feed_target_ml: { min: 45, max: 60 } };
      state.entries = [
        record(45, "feed", { method: "bottle", amount_ml: 35, milk: "breastmilk", via: "paced" }, "2026-10-28T13:20:00.000Z"),
        nursing(46, "2026-10-28T12:45:00.000Z", "2026-10-28T13:00:00.000Z", "2026-10-28T13:15:00.000Z"),
        record(47, "feed", { method: "bottle", amount_ml: 60, milk: "formula" }, "2026-10-28T10:00:00.000Z"),
      ];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { get: () => undefined }));
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("button", { name: /^For the doctor/ }).click();
        const dialog = f.page.getByRole("dialog", { name: "For the doctor", exact: true });
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        assert.match(text, /Target per feed from our care team: 1\.52–2\.03 oz \(45–60 ml\)\./);
        const today = text.split("\n").find((line) => line.includes("(so far):")) ?? "";
        assert.match(today, /: 2 feeds \(/, today);
        assert.match(today, /1 bottle, 2\.03 oz \(60 ml\); 1 top-up with nursing, 1\.18 oz \(35 ml\); by bottle: formula 2\.03 oz \(60 ml\), breast milk 1\.18 oz \(35 ml\)/, today);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Settings keeps a target per feed from the care team, in the units shown", async () => {
      const state = freshState();
      const patches = [];
      const f = await fixture({
        state,
        apiResponse: ({ route, req, url }) => {
          if (url.pathname === "/api/maple/baby" && req.method() === "PATCH") {
            patches.push(req.postDataJSON());
            return route.fulfill({ json: { baby: state.baby } });
          }
          return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
        },
      });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#family/doctor");
        const from = f.page.getByRole("textbox", { name: /^Target per feed, from \(ml\)/ });
        await from.fill("45");
        await f.page.getByRole("textbox", { name: "Up to (ml)", exact: true }).fill("60");
        await f.page.getByRole("button", { name: "Save changes", exact: true }).click();
        for (let i = 0; i < 20 && !patches.length; i++) await f.page.waitForTimeout(100);
        assert.deepEqual(patches.at(-1)?.settings?.feed_target_ml, { min: 45, max: 60 });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

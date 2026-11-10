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
    ["An SNS logged after a feed says it's that feed's, and A feed of its own saves it as one", async () => {
      const state = freshState();
      // 8:00–8:15 AM, Left then Right; it's 9:30, and the SNS is logged now: 75 minutes on, an SNS goes with that feed.
      state.entries = [nursing(51, "2026-10-28T12:00:00.000Z", "2026-10-28T12:08:00.000Z", "2026-10-28T12:15:00.000Z")];
      const f = await fixture({ state, entryResponse: reply });
      try {
        await metric(f);
        const form = await openBottle(f);
        await form.getByRole("textbox", { name: "millilitres", exact: true }).fill("45");
        const own = form.getByRole("switch", { name: "A feed of its own", exact: true });
        assert.equal(await own.count(), 0, "a bottle on its own then: nothing to say");
        await form.getByRole("button", { name: "SNS at the breast", exact: true }).click();
        assert.match(await form.textContent(), /Milk at the breast with the 8:00\sAM feed: part of that feed, not a feed of its own\./);
        assert.equal(await own.getAttribute("aria-checked"), "false");
        const before = await own.boundingBox();
        await own.click();
        assert.equal(await own.getAttribute("aria-checked"), "true");
        const after = await own.boundingBox();
        assert(before && after && Math.abs(after.y - before.y) < 2, `the switch stays put (${before?.y} → ${after?.y})`);
        assert.match(await form.textContent(), /A feed of its own, not part of the 8:00\sAM feed\./);
        assert.doesNotMatch(await form.textContent(), /part of that feed/);
        await form.getByRole("button", { name: "Log 45 ml now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { method: "bottle", amount_ml: 45, via: "sns", own_feed: true });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A saved SNS counted with a feed is made a feed of its own from its form, and back", async () => {
      const fed = nursing(52, "2026-10-28T12:00:00.000Z", "2026-10-28T12:08:00.000Z", "2026-10-28T12:15:00.000Z");
      const sns = (data = {}) => record(53, "feed", { method: "bottle", amount_ml: 45, milk: "formula", via: "sns", ...data }, "2026-10-28T13:00:00.000Z");
      const patched = ({ route, req, records }) => route.fulfill({ json: { entry: { ...records.find((e) => e.id === 53), updated_at: "2026-10-28T13:31:00.000Z" } } });
      let state = freshState();
      state.entries = [sns(), fed];
      let f = await fixture({ state, records: state.entries, entryResponse: patched });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        const day = f.page.locator("#maple-day-2026-10-28");
        await day.waitFor();
        assert.match(await day.textContent(), /1 feed ·/, "with that feed, one feed");
        await day.getByRole("button", { name: /^Edit: \+ 45 ml in the SNS/ }).click();
        const form = f.page.getByRole("dialog", { name: "SNS at the breast", exact: true });
        await form.waitFor();
        assert.match(await form.textContent(), /Milk at the breast with the 8:00\sAM feed: part of that feed, not a feed of its own\./);
        await form.getByRole("switch", { name: "A feed of its own", exact: true }).click();
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const body = writes(f)[0]?.body;
        assert.deepEqual(body?.data, { own_feed: true }, "only what changed");
        assert.equal(body?.expect_updated_at, "2026-10-28T13:00:00.000Z", "against the version shown");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
      // Saved as its own: a feed of its own on the day and on Today, its form saying so, and off again it's that feed's.
      state = freshState();
      state.entries = [sns({ own_feed: true }), fed];
      f = await fixture({ state, records: state.entries, entryResponse: patched });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("heading", { name: "Recently logged", exact: true }).waitFor();
        assert.match(await f.page.locator("body").textContent(), /Last feed started\s*30m ago/, "Last fed at the SNS feed");
        await f.page.goto("https://first-use.example.test/#log");
        const day = f.page.locator("#maple-day-2026-10-28");
        await day.waitFor();
        assert.match(await day.textContent(), /2 feeds ·/);
        assert.doesNotMatch(await day.textContent(), /\+ 45 ml in the SNS/, "a row of its own");
        await day.getByRole("button", { name: /^Edit: SNS/ }).click();
        const form = f.page.getByRole("dialog", { name: "SNS at the breast", exact: true });
        await form.waitFor();
        const own = form.getByRole("switch", { name: "A feed of its own", exact: true });
        assert.equal(await own.getAttribute("aria-checked"), "true");
        assert.match(await form.textContent(), /A feed of its own, not part of the 8:00\sAM feed\./);
        await own.click();
        assert.match(await form.textContent(), /Milk at the breast with the 8:00\sAM feed: part of that feed/);
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { own_feed: null });
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
      state.baby.settings = { ...state.baby.settings, feed_target_ml: { min: 50, max: 70 } };
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
        assert.match(text, /Target per feed from our care team: 1\.69–2\.37 oz \(50–70 ml\)\./);
        const today = text.split("\n").find((line) => line.includes("(so far):")) ?? "";
        assert.match(today, /: 2 feeds \(/, today);
        assert.match(today, /1 bottle, 2\.03 oz \(60 ml\); 1 top-up with nursing, 1\.18 oz \(35 ml\); by bottle: formula 2\.03 oz \(60 ml\), breast milk 1\.18 oz \(35 ml\)/, today);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Milk at the breast is said apart from top-ups and bottles: Last fed, the day so far and the visit summary", async () => {
      const state = freshState();
      state.baby.settings = { ...state.baby.settings, feed_target_ml: { min: 50, max: 70 } };
      // 8:45–9:15 AM with 20 ml of formula in the SNS at 8:50 and a 30 ml paced top-up of formula at 9:20; a 60 ml bottle
      // of breast milk on its own at 6:00.
      state.entries = [
        record(48, "feed", { method: "bottle", amount_ml: 30, milk: "formula", via: "paced" }, "2026-10-28T13:20:00.000Z"),
        nursing(46, "2026-10-28T12:45:00.000Z", "2026-10-28T13:00:00.000Z", "2026-10-28T13:15:00.000Z"),
        record(47, "feed", { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", top_up_of: 46 }, "2026-10-28T12:50:00.000Z"),
        record(49, "feed", { method: "bottle", amount_ml: 60, milk: "breastmilk" }, "2026-10-28T10:00:00.000Z"),
      ];
      const plain = (s) => s.replace(/[\u00a0\u202f]/g, " ");
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { get: () => undefined }));
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("heading", { name: "Recently logged", exact: true }).waitFor();
        // Last fed: the feed's parts in its row's words, the SNS milk never a top-up.
        assert.match(plain(await f.page.locator("body").textContent()), /Left then Right · \+ 20 ml in the SNS · \+ 30 ml top-up/);
        await f.page.goto("https://first-use.example.test/#patterns");
        const tallies = f.page.locator('section[aria-labelledby="day-so-far"]');
        await tallies.waitFor();
        const counted = plain(await tallies.textContent());
        assert.match(counted, /1 top-up(?!s)/, "one top-up by bottle, not two");
        assert.match(counted, /At the breast · syringe or SNS20 ml formula20 ml/);
        assert.match(counted, /By bottle · 30 ml formula90 ml/, "by bottle: the bottles, never the SNS milk");
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("button", { name: /^For the doctor/ }).click();
        const dialog = f.page.getByRole("dialog", { name: "For the doctor", exact: true });
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        const text = await dialog.getByRole("textbox", { name: "Visit summary", exact: true }).inputValue();
        const today = text.split("\n").find((line) => line.includes("(so far):")) ?? "";
        assert.match(today, /: 2 feeds \(/, today);
        assert.match(today, /1 bottle, 2\.03 oz \(60 ml\); 1 top-up with nursing, 1\.01 oz \(30 ml\); milk at the breast \(syringe or SNS\), 0\.68 oz \(20 ml\); in all: formula 1\.69 oz \(50 ml\), breast milk 2\.03 oz \(60 ml\)/, today);
        assert.doesNotMatch(today, /by bottle/, "the SNS milk never went by bottle");
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
        await from.fill("50");
        await f.page.getByRole("textbox", { name: "Up to (ml)", exact: true }).fill("70");
        await f.page.getByRole("button", { name: "Save changes", exact: true }).click();
        for (let i = 0; i < 20 && !patches.length; i++) await f.page.waitForTimeout(100);
        assert.deepEqual(patches.at(-1)?.settings?.feed_target_ml, { min: 50, max: 70 });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

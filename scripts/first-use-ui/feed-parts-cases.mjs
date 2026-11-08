/**
 * A feed's parts: the nipple shield and milk at the breast read as part of the nursing feed. Today's recent rows and
 * the Timeline show a feed's milk at the breast and its top-up as pills on its row (each opening its own bottle,
 * never a row of their own, a cluster summing them), the running nursing card toggles the shield on the feed itself
 * (against the version it shows, made once more after a change elsewhere) and logs milk at the breast tied to the
 * feed, and the feed form saves a shield and milk at the breast with a feed logged afterwards, and lists a saved
 * feed's. Made-up feeds and amounts on the fixture's clock (9:30 AM in the family's zone), in ml.
 */
export function feedPartsCases({ fixture, freshState, record, writes, assert }) {
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  const nursing = (id, start, mid, end, extra = {}) =>
    record(id, "feed", { method: "breast", segments: [{ side: "L", start, end: mid }, { side: "R", start: mid, end }], first_side: "L", last_side: "R", ...extra }, start, { ended_at: end, updated_at: end });
  const oneSide = (id, side, start, end) => record(id, "feed", { method: "breast", segments: [{ side, start, end }], first_side: side, last_side: side }, start, { ended_at: end, updated_at: end });
  const newest = (list) => [...list].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  // 5:00 AM with the nipple shield and 20 ml of formula in the SNS; 7:00 AM bare, with a 30 ml paced top-up at 7:40;
  // a 60 ml bottle on its own at 9:00; a wet diaper at 4:30.
  const day = () => newest([
    record(31, "feed", { method: "bottle", amount_ml: 60, milk: "formula" }, "2026-10-28T13:00:00.000Z"),
    record(22, "feed", { method: "bottle", amount_ml: 30, milk: "breastmilk", via: "paced" }, "2026-10-28T11:40:00.000Z"),
    nursing(21, "2026-10-28T11:00:00.000Z", "2026-10-28T11:15:00.000Z", "2026-10-28T11:30:00.000Z"),
    record(12, "feed", { method: "bottle", amount_ml: 20, milk: "formula", via: "sns" }, "2026-10-28T09:10:00.000Z"),
    nursing(11, "2026-10-28T09:00:00.000Z", "2026-10-28T09:12:00.000Z", "2026-10-28T09:25:00.000Z", { shield: true }),
    record(5, "diaper", { pee: true, poop: false }, "2026-10-28T08:30:00.000Z"),
  ]);
  /** Nursing on the Left since 9:18 AM (a running timer). */
  const running = (extra = {}) => ({
    ...record(41, "feed", { method: "breast", segments: [{ side: "L", start: "2026-10-28T13:18:00.000Z", end: null }], first_side: "L", last_side: "L", ...extra }, "2026-10-28T13:18:00.000Z"),
    active: true,
  });
  const card = (f) => f.page.getByRole("region", { name: "Nursing timer", exact: true });
  const until = async (f, ok) => { for (let i = 0; i < 40 && !ok(); i++) await f.page.waitForTimeout(100); };
  // The server's side of a write: the entry it answers with is also what the next state read has.
  const keep = (state, entry) => {
    state.entries = newest([entry, ...state.entries.filter((e) => e.id !== entry.id)]);
    state.rev = `example-${Date.now()}`;
    return entry;
  };
  const saved = (state, ids) => ({ route, req }) => {
    const body = req.postDataJSON();
    const entry = keep(state, record(ids.shift(), "feed", body.data, body.started_at ?? "2026-10-28T13:30:00.000Z", body.ended_at ? { ended_at: body.ended_at } : {}));
    return route.fulfill({ json: { entry } });
  };

  return [
    ["Feed parts: Today and the Timeline read a feed with its shield, its milk at the breast and its top-up as one row; each part opens its own bottle", async () => {
      const state = freshState();
      state.entries = day();
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        const recent = f.page.getByRole("region", { name: "Recently logged", exact: true });
        await recent.waitFor();
        // Three rows, never eaten by one feed's parts: the bottle on its own, then each feed with its parts on it.
        const rows = await recent.getByRole("button", { name: /^Edit(?: time)?: (?!\+)/ }).evaluateAll((list) => list.map((b) => b.getAttribute("aria-label")));
        assert.deepEqual(rows, ["Edit: Bottle, Today at 9:00 AM", "Edit time: Nursed, Today at 7:00 AM", "Edit time: Nursed, Today at 5:00 AM"]);
        const sns = recent.getByRole("button", { name: "Edit: + 20 ml in the SNS · formula, Today at 5:10 AM", exact: true });
        const topUp = recent.getByRole("button", { name: "Edit: + 30 ml top-up · breast milk · paced bottle, Today at 7:40 AM", exact: true });
        assert.equal(await sns.textContent(), "+ 20 ml in the SNS");
        assert.equal(await topUp.textContent(), "+ 30 ml top-up");
        assert.match(await recent.textContent(), /L 12m, R 13m · started left · shield/, "the shield on its feed's line");
        const box = await sns.boundingBox();
        assert(box && box.height >= 44, `the part is a 44px target (${box?.height})`);
        await sns.click();
        const bottle = f.page.getByRole("dialog", { name: "SNS", exact: true });
        await bottle.waitFor();
        assert.equal(await bottle.getByRole("region", { name: "How it was given" }).getByRole("button", { name: "SNS at the breast", exact: true }).getAttribute("aria-pressed"), "true");
        await bottle.getByRole("button", { name: "Close", exact: true }).click();
        await bottle.waitFor({ state: "hidden" });

        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        await today.waitFor();
        assert.equal(await today.locator("ol > li").count(), 4, "four rows: the bottle, two feeds and the diaper");
        assert.equal(await today.getByRole("button", { name: /^Edit: (?:SNS|Top-up|Syringe)/ }).count(), 0, "no part is a row of its own");
        await today.getByRole("button", { name: /^Edit: \+ 30 ml top-up/ }).click();
        await f.page.getByRole("dialog", { name: "Bottle", exact: true }).waitFor();
        assert.match(await today.textContent(), /2 top-ups/, "the day's line still counts them");
        assert.deepEqual(writes(f), []);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: a cluster sums its feeds' parts in its row and puts each on its feed once it's open", async () => {
      const state = freshState();
      // Three feeds 15 minutes apart from 6:00 AM (a cluster), a 30 ml top-up 10 minutes after the last.
      state.entries = newest([
        oneSide(51, "L", "2026-10-28T10:00:00.000Z", "2026-10-28T10:10:00.000Z"),
        oneSide(52, "R", "2026-10-28T10:25:00.000Z", "2026-10-28T10:35:00.000Z"),
        oneSide(53, "L", "2026-10-28T10:50:00.000Z", "2026-10-28T11:00:00.000Z"),
        record(54, "feed", { method: "bottle", amount_ml: 30, milk: "formula" }, "2026-10-28T11:10:00.000Z"),
      ]);
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        const cluster = today.getByRole("button", { name: /^Cluster · 3 feeds/ });
        await cluster.waitFor();
        assert.match(await cluster.textContent(), /nursed 30m .*· \+ 30 ml top-up/);
        assert.equal(await today.locator("ol > li").count(), 1, "one row: the cluster, its top-up in it");
        await cluster.click();
        const part = today.getByRole("button", { name: "Edit: + 30 ml top-up · formula, Today at 7:10 AM", exact: true });
        await part.click();
        await f.page.getByRole("dialog", { name: "Bottle", exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: the nursing card's Shield saves on the feed against the version shown, and after a change elsewhere once more on the new one", async () => {
      const state = freshState();
      state.entries = [running()];
      const sent = [];
      let conflicts = 1;
      const f = await fixture({
        state,
        entryResponse: ({ route, req }) => {
          const body = req.postDataJSON();
          sent.push(body);
          const cur = state.entries.find((e) => e.id === 41);
          if (conflicts > 0) {
            // A Switch on the other phone landed first: the feed's version moved on.
            conflicts--;
            const moved = keep(state, { ...cur, updated_at: "2026-10-28T13:25:00.000Z", data: { ...cur.data, segments: [{ side: "L", start: cur.started_at, end: "2026-10-28T13:25:00.000Z" }, { side: "R", start: "2026-10-28T13:25:00.000Z", end: null }], last_side: "R" } });
            return route.fulfill({ status: 409, json: { error: "Someone else just changed this. Have another look and try again.", reason: "changed", entry: moved } });
          }
          const data = { ...cur.data, ...body.data };
          for (const [k, v] of Object.entries(body.data)) if (v === null) delete data[k];
          return route.fulfill({ json: { entry: keep(state, { ...cur, data, updated_at: `2026-10-28T13:30:0${sent.length}.000Z` }) } });
        },
      });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        const shield = card(f).getByRole("button", { name: "Nipple shield", exact: true });
        await shield.waitFor();
        assert.equal(await shield.getAttribute("aria-pressed"), "false");
        assert(await card(f).getByRole("button", { name: "Milk at the breast", exact: true }).isVisible(), "milk at the breast, a small chip beside it");
        await shield.click();
        await until(f, () => sent.length >= 2);
        assert.deepEqual(sent, [
          { data: { shield: true }, expect_updated_at: "2026-10-28T13:18:00.000Z" },
          { data: { shield: true }, expect_updated_at: "2026-10-28T13:25:00.000Z" },
        ], "made against the version shown, then once more on the one the other phone saved");
        await f.page.waitForFunction(() => document.querySelector('[aria-label="Nipple shield"]')?.getAttribute("aria-pressed") === "true");
        await shield.click();
        await until(f, () => sent.length >= 3);
        assert.deepEqual(sent[2], { data: { shield: null }, expect_updated_at: "2026-10-28T13:30:02.000Z" }, "off takes it off the feed");
        await f.page.waitForFunction(() => document.querySelector('[aria-label="Nipple shield"]')?.getAttribute("aria-pressed") === "false");
        // Changed elsewhere twice in a row: it says so, and nothing is shown as saved.
        conflicts = 2;
        await shield.click();
        await until(f, () => sent.length >= 5);
        await f.page.getByText("The feed just changed on another phone, so the shield wasn't saved. Tap it again.", { exact: true }).waitFor();
        assert.equal(await shield.getAttribute("aria-pressed"), "false");
        assert.equal(sent.length, 5, "one more try, no more");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: Milk at the breast on the nursing card logs a syringe the first time and as last time after, tied to the feed, then shows it", async () => {
      for (const last of [null, record(12, "feed", { method: "bottle", amount_ml: 20, milk: "formula", via: "sns" }, "2026-10-28T09:10:00.000Z")]) {
        const state = freshState();
        // A 60 ml bottle at 9:00 is the last bottle, never the amount milk at the breast starts from.
        state.entries = newest([running(), record(31, "feed", { method: "bottle", amount_ml: 60, milk: "formula" }, "2026-10-28T13:00:00.000Z"), ...(last ? [last] : [])]);
        const f = await fixture({ state, records: state.entries, entryResponse: saved(state, [99]) });
        try {
          await metric(f);
          await f.page.goto("https://first-use.example.test/#today");
          await card(f).getByRole("button", { name: "Milk at the breast", exact: true }).click();
          const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
          await form.waitFor();
          const how = form.getByRole("region", { name: "How it was given" });
          assert.equal(await how.getByRole("button", { name: last ? "SNS at the breast" : "Syringe", exact: true }).getAttribute("aria-pressed"), "true");
          assert.match(await form.textContent(), /Milk at the breast with the 9:18 AM feed: part of that feed, not a feed of its own\./);
          if (!last) {
            assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "", "no amount made up");
            await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true }).click();
            await form.getByRole("textbox", { name: "millilitres", exact: true }).fill("20");
          }
          await form.getByRole("button", { name: "Log 20 ml now", exact: true }).click();
          await form.waitFor({ state: "hidden" });
          assert.deepEqual(writes(f).map((w) => w.body.data), [{ method: "bottle", amount_ml: 20, milk: "formula", via: last ? "sns" : "syringe", top_up_of: 41 }]);
          await f.page.getByText(`20 ml ${last ? "in the SNS" : "in the syringe"} · 9:30 AM`, { exact: true }).waitFor();
          const given = card(f).getByRole("button", { name: `Edit: 20 ml ${last ? "in the SNS" : "in the syringe"} · formula, at 9:30 AM`, exact: true });
          await given.waitFor();
          assert.equal(await card(f).getByRole("button", { name: "Milk at the breast", exact: true }).count(), 0, "logged: the chip says what was given instead");
          await given.click();
          await f.page.getByRole("dialog", { name: last ? "SNS" : "Syringe", exact: true }).waitFor();
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["Feed parts: a feed logged afterwards saves its nipple shield, then its milk at the breast at its start, naming it, with one toast", async () => {
      const state = freshState();
      state.entries = [record(5, "diaper", { pee: true, poop: false }, "2026-10-28T08:30:00.000Z")];
      const f = await fixture({ state, records: state.entries, entryResponse: saved(state, [99, 100]) });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        await today.getByRole("button", { name: /^Wet diaper/ }).or(today.getByRole("button", { name: /^Edit: Wet diaper/ })).first().waitFor();
        await today.getByRole("button", { name: "Log earlier for Today", exact: true }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Nursing", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.getByRole("textbox", { name: "minutes on the left", exact: true }).fill("12");
        const shield = form.getByRole("switch", { name: "Nipple shield", exact: true });
        assert.equal(await shield.getAttribute("aria-checked"), "false");
        await shield.click();
        const milk = form.getByRole("switch", { name: "Milk at the breast", exact: true });
        assert.equal(await milk.getAttribute("aria-checked"), "false", "off until it's turned on");
        await milk.click();
        const fields = form.getByRole("region", { name: "Milk at the breast" });
        assert.equal(await fields.getByRole("radio", { name: "Syringe", exact: true }).getAttribute("aria-checked"), "true", "a syringe the first time");
        await fields.getByRole("button", { name: "Breast milk", exact: true }).click();
        await fields.getByRole("textbox", { name: "milk at the breast, millilitres", exact: true }).fill("15");
        await fields.getByRole("radio", { name: "SNS", exact: true }).click();
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const posts = writes(f);
        assert.equal(posts.length, 2);
        assert.deepEqual(posts[0].body.data, { method: "breast", left_sec: 720, right_sec: 0, first_side: "L", last_side: "L", shield: true });
        assert.deepEqual(posts[1].body.data, { method: "bottle", via: "sns", amount_ml: 15, milk: "breastmilk", top_up_of: 99 });
        assert.equal(posts[1].body.started_at, posts[0].body.started_at, "at the feed's start");
        await f.page.getByText(/^Nursed 12m \(L 12\) \+ 15 ml in the SNS/).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: a saved feed's form sends only its nipple shield, against the version shown, and lists its milk at the breast to open", async () => {
      const state = freshState();
      state.entries = day();
      const f = await fixture({
        state,
        records: state.entries,
        entryResponse: ({ route, req }) => {
          const body = req.postDataJSON();
          const cur = state.entries.find((e) => e.id === 21);
          return route.fulfill({ json: { entry: keep(state, { ...cur, data: { ...cur.data, ...body.data }, updated_at: "2026-10-28T13:30:00.000Z" }) } });
        },
      });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        // The 7:00 feed: no shield, a paced top-up, no milk at the breast yet.
        await today.getByRole("button", { name: "Edit time: Nursed, Today at 7:00 AM", exact: true }).click();
        await f.page.getByRole("button", { name: /Edit feed details or add a side/ }).click();
        let form = f.page.getByRole("dialog", { name: "Nursed", exact: true });
        const withFeed = form.getByRole("region", { name: "With this feed", exact: true });
        await withFeed.getByRole("button", { name: "Edit: 30 ml top-up, breast milk · paced bottle · 7:40 AM", exact: true }).waitFor();
        assert(await withFeed.getByRole("button", { name: "Add milk at the breast", exact: true }).isVisible());
        await form.getByRole("switch", { name: "Nipple shield", exact: true }).click();
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f).map((w) => w.body), [{ data: { shield: true }, expect_updated_at: "2026-10-28T11:30:00.000Z" }]);
        // The 5:00 feed: its shield on, its milk at the breast listed, a tap opens it.
        await today.getByRole("button", { name: "Edit time: Nursed, Today at 5:00 AM", exact: true }).click();
        await f.page.getByRole("button", { name: /Edit feed details or add a side/ }).click();
        form = f.page.getByRole("dialog", { name: "Nursed", exact: true });
        assert.equal(await form.getByRole("switch", { name: "Nipple shield", exact: true }).getAttribute("aria-checked"), "true");
        const milk = form.getByRole("region", { name: "Milk at the breast", exact: true });
        assert.equal(await milk.getByRole("button", { name: "Add milk at the breast", exact: true }).count(), 0, "it has some");
        await milk.getByRole("button", { name: "Edit: 20 ml in the SNS, formula · 5:10 AM", exact: true }).click();
        await f.page.getByRole("dialog", { name: "SNS", exact: true }).waitFor();
        assert.equal(writes(f).length, 1, "opening it writes nothing");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

/**
 * A feed's parts: the nipple shield and milk at the breast read as part of the nursing feed. Today's recent rows and
 * the Timeline show a feed's milk at the breast and its top-up as pills on its row (each opening its own bottle,
 * never a row of their own, a cluster summing them), the running nursing card toggles the shield on the feed itself
 * (against the version it shows, made once more after a change elsewhere) and logs milk at the breast tied to the
 * feed, and the feed form saves a shield and milk at the breast with a feed logged afterwards, and lists a saved
 * feed's. A part's form says what it is ("Milk at the breast", "SNS at the breast", "Top-up"), a bottle's "last bottle"
 * is never milk at the breast, a plan feed's milk at the breast is the plan's (in its unit), a feed's form says which
 * of the plan's feeds it was, and While you slept counts a feed still going once. The running card counts what was
 * given with the whole feed, across a break of 10 minutes or more. Made-up feeds and amounts on the fixture's clock
 * (9:30 AM in the family's zone), in ml; the plan is the invented one in feeding-plan-cases.mjs.
 */
export function feedPartsCases({ fixture, freshState, record, writes, assert }) {
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  const nursing = (id, start, mid, end, extra = {}) =>
    record(id, "feed", { method: "breast", segments: [{ side: "L", start, end: mid }, { side: "R", start: mid, end }], first_side: "L", last_side: "R", ...extra }, start, { ended_at: end, updated_at: end });
  const oneSide = (id, side, start, end) => record(id, "feed", { method: "breast", segments: [{ side, start, end }], first_side: side, last_side: side }, start, { ended_at: end, updated_at: end });
  const newest = (list) => [...list].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  /** The invented plan of feeding-plan-cases.mjs: "Nurse + SNS" (20 ml of formula in the SNS), "Nurse, top up", "Pump + bottle". */
  const PLAN = {
    v: 1, from: "Feeding clinic", unit: "ml", day: { every: { min: 150, max: 210 } },
    night: { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: "p1f3" },
    feeds: [
      { id: "p1f1", name: "Nurse + SNS", steps: [{ do: "nurse", minutes: { min: 12, max: 18 }, supplement: { via: "sns", ml: { min: 20, max: 20 }, milk: "formula" } }, { do: "pump", minutes: { min: 15, max: 15 } }] },
      { id: "p1f2", name: "Nurse, top up", steps: [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced" }] },
      { id: "p1f3", name: "Pump + bottle", steps: [{ do: "pump", minutes: { min: 20, max: 20 } }, { do: "bottle", milk: "breastmilk_first", to_target: true }] },
    ],
    order: ["p1f1", "p1f2"], rev: 1, updated_at: "2026-10-27T12:00:00.000Z",
  };
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
        // A saved part opens as what it is: milk at the breast, part of its feed.
        const bottle = f.page.getByRole("dialog", { name: "SNS at the breast", exact: true });
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
        await f.page.getByRole("dialog", { name: "Top-up", exact: true }).waitFor();
        // The day's line counts the SNS milk at the breast and the paced top-up by bottle, each once, never "2 top-ups".
        assert.match((await today.textContent()).replace(/[\u00a0\u202f]/g, " "), /3 feeds · 55m nursing · 20 ml at the breast · 90 ml bottle \(1 top-up\) · 80 ml formula/);
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
        await f.page.getByRole("dialog", { name: "Top-up", exact: true }).waitFor();
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
          // It says what it is: milk at the breast with this feed, by syringe or SNS, never a Breast or Bottle feed.
          const form = f.page.getByRole("dialog", { name: "Milk at the breast", exact: true });
          await form.waitFor();
          assert.equal(await form.getByRole("radiogroup", { name: "Feed type" }).count(), 0, "no Breast or Bottle to choose");
          const how = form.getByRole("radiogroup", { name: "How it was given" });
          assert.deepEqual(await how.getByRole("radio").allTextContents(), ["Syringe", "SNS"]);
          assert.equal(await how.getByRole("radio", { name: last ? "SNS" : "Syringe", exact: true }).getAttribute("aria-checked"), "true");
          assert.match(await form.textContent(), /With the 9:18\sAM feed: part of it, not a feed of its own\./);
          const amount = form.getByRole("textbox", { name: `${last ? "in the SNS" : "in the syringe"}, millilitres`, exact: true });
          assert.deepEqual(await form.getByRole("button", { name: /^\d+ ml$/ }).allTextContents(), ["5 ml", "10 ml", "15 ml", "20 ml"], "small amounts, not a bottle's");
          if (!last) {
            assert.equal(await amount.inputValue(), "", "no amount made up");
            await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true }).click();
            await form.getByRole("button", { name: "20 ml", exact: true }).click();
          }
          await form.getByRole("button", { name: `Log 20 ml ${last ? "in the SNS" : "in the syringe"}`, exact: true }).click();
          await form.waitFor({ state: "hidden" });
          assert.deepEqual(writes(f).map((w) => w.body.data), [{ method: "bottle", amount_ml: 20, milk: "formula", via: last ? "sns" : "syringe", top_up_of: 41 }]);
          await f.page.getByText(`20 ml ${last ? "in the SNS" : "in the syringe"} · 9:30 AM`, { exact: true }).waitFor();
          const given = card(f).getByRole("button", { name: `Edit: 20 ml ${last ? "in the SNS" : "in the syringe"} · formula, at 9:30 AM`, exact: true });
          await given.waitFor();
          assert.equal(await card(f).getByRole("button", { name: "Milk at the breast", exact: true }).count(), 0, "logged: the chip says what was given instead");
          await given.click();
          await f.page.getByRole("dialog", { name: last ? "SNS at the breast" : "Syringe at the breast", exact: true }).waitFor();
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["Feed parts: the nursing card counts milk at the breast given after a break of 10 minutes or more, and doesn't offer it again", async () => {
      const state = freshState();
      // On the Left 9:00–9:08, a 12-minute break, back on from 9:20 (one timer); 15 ml in the syringe at 9:24.
      const on = {
        ...record(41, "feed", { method: "breast", segments: [{ side: "L", start: "2026-10-28T13:00:00.000Z", end: "2026-10-28T13:08:00.000Z" }, { side: "L", start: "2026-10-28T13:20:00.000Z", end: null }], first_side: "L", last_side: "L" }, "2026-10-28T13:00:00.000Z"),
        active: true,
      };
      state.entries = newest([on, record(42, "feed", { method: "bottle", amount_ml: 15, milk: "formula", via: "syringe", top_up_of: 41 }, "2026-10-28T13:24:00.000Z")]);
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        await card(f).getByRole("button", { name: "Edit: 15 ml in the syringe · formula, at 9:24 AM", exact: true }).waitFor();
        assert.equal(await card(f).getByRole("button", { name: "Milk at the breast", exact: true }).count(), 0, "given: the chip says so, and it isn't offered again");
        assert.deepEqual(writes(f), []);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
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
        await f.page.getByRole("dialog", { name: "SNS at the breast", exact: true }).waitFor();
        assert.equal(writes(f).length, 1, "opening it writes nothing");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: a bottle starts from the last bottle, never from milk given at the breast", async () => {
      const state = freshState();
      // A 60 ml bottle of breast milk at 6:00 AM; at 8:30 nursing with 20 ml of formula in the syringe (the newest milk).
      state.entries = newest([
        record(31, "feed", { method: "bottle", amount_ml: 60, milk: "breastmilk" }, "2026-10-28T10:00:00.000Z"),
        nursing(41, "2026-10-28T12:30:00.000Z", "2026-10-28T12:38:00.000Z", "2026-10-28T12:45:00.000Z"),
        record(42, "feed", { method: "bottle", amount_ml: 20, milk: "formula", via: "syringe", top_up_of: 41 }, "2026-10-28T12:40:00.000Z"),
      ]);
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "60", "the last bottle's amount, not the syringe's 20 ml");
        assert.equal(await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Breast milk", exact: true }).getAttribute("aria-pressed"), "true");
        assert.match((await form.textContent()).replace(/[\u00a0\u202f]/g, " "), /Last bottle: 60 ml of breast milk at 6:00 AM/);
        assert.equal(await form.getByRole("region", { name: "Plan feed" }).count(), 0, "no plan, no plan feed to say");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: a plan feed's milk at the breast, added from its form, is the plan's, in the plan's ml beside the app's oz", async () => {
      const state = freshState();
      state.baby.settings = { show_alerts: false, feeding_plan: PLAN };
      // 8:00 AM: Nurse + SNS from the plan, its SNS milk not logged. The app shows oz (its default); the plan is in ml.
      state.entries = [nursing(61, "2026-10-28T12:00:00.000Z", "2026-10-28T12:08:00.000Z", "2026-10-28T12:15:00.000Z", { plan: "p1f1" })];
      const f = await fixture({ state, records: state.entries, entryResponse: saved(state, [99]) });
      try {
        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        await today.getByRole("button", { name: "Edit time: Nursed, Today at 8:00 AM", exact: true }).click();
        await f.page.getByRole("button", { name: /Edit feed details or add a side/ }).click();
        await f.page.getByRole("dialog", { name: "Nursed", exact: true }).getByRole("button", { name: "Add milk at the breast", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Milk at the breast", exact: true });
        await form.waitFor();
        const text = (await form.textContent()).replace(/[\u00a0\u202f]/g, " ");
        assert.match(text, /With the 8:00 AM feed: part of it, not a feed of its own\./);
        assert.equal(await form.getByRole("radiogroup", { name: "How it was given" }).getByRole("radio", { name: "SNS", exact: true }).getAttribute("aria-checked"), "true", "the plan's way in");
        assert.equal(await form.getByRole("textbox", { name: "in the SNS, millilitres", exact: true }).inputValue(), "20", "the plan's amount, in its ml");
        assert.match(text, /That's 0\.68 oz\./, "the app's unit beside it");
        assert.deepEqual(await form.getByRole("button", { name: /^\d+ ml$/ }).allTextContents(), ["20 ml"], "the plan's amount is the quick one");
        assert.equal(await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true }).getAttribute("aria-pressed"), "true", "the plan's milk");
        await form.getByRole("button", { name: "Log 20 ml in the SNS", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const posts = writes(f);
        assert.deepEqual(posts.map((w) => w.body.data), [{ method: "bottle", amount_ml: 20, milk: "formula", via: "sns", top_up_of: 61, plan: "p1f1" }]);
        assert.equal(posts[0].body.started_at, "2026-10-28T12:00:00.000Z", "at the feed's start");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: with a plan, a feed's form says which of its feeds it was, and saves it on the feed for every phone", async () => {
      const state = freshState();
      state.baby.settings = { show_alerts: false, feeding_plan: PLAN };
      // 7:00 AM: a feed logged from the dock, not tagged with a plan feed.
      state.entries = [nursing(21, "2026-10-28T11:00:00.000Z", "2026-10-28T11:15:00.000Z", "2026-10-28T11:30:00.000Z")];
      const posted = [];
      const f = await fixture({
        state,
        records: state.entries,
        entryResponse: ({ route, req }) => {
          const body = req.postDataJSON();
          if (req.method() === "POST") {
            posted.push(body);
            return route.fulfill({ json: { entry: keep(state, record(99, "feed", body.data, body.started_at, body.ended_at ? { ended_at: body.ended_at } : {})) } });
          }
          const cur = state.entries.find((e) => e.id === 21);
          return route.fulfill({ json: { entry: keep(state, { ...cur, data: { ...cur.data, ...body.data }, updated_at: "2026-10-28T13:30:00.000Z" }) } });
        },
      });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        const today = f.page.locator("#maple-day-2026-10-28");
        await today.getByRole("button", { name: "Edit time: Nursed, Today at 7:00 AM", exact: true }).click();
        await f.page.getByRole("button", { name: /Edit feed details or add a side/ }).click();
        const form = f.page.getByRole("dialog", { name: "Nursed", exact: true });
        const pick = form.getByRole("region", { name: "Plan feed", exact: true });
        assert.deepEqual(await pick.getByRole("button").allTextContents(), ["Nurse + SNS", "Nurse, top up", "Pump + bottle"]);
        assert.match(await pick.textContent(), /Not set: Maple goes by what was logged with it\./);
        await pick.getByRole("button", { name: "Nurse, top up", exact: true }).click();
        assert.equal(await pick.getByRole("button", { name: "Nurse, top up", exact: true }).getAttribute("aria-pressed"), "true");
        assert.match(await pick.textContent(), /Every phone counts it as this feed of the plan\./);
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f).map((w) => w.body), [{ data: { plan: "p1f2" }, expect_updated_at: "2026-10-28T11:30:00.000Z" }]);
        // A feed logged afterwards says it too.
        await today.getByRole("button", { name: "Log earlier for Today", exact: true }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Nursing", exact: true }).click();
        const fresh = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await fresh.getByRole("textbox", { name: "minutes on the left", exact: true }).fill("12");
        await fresh.getByRole("region", { name: "Plan feed", exact: true }).getByRole("button", { name: "Nurse + SNS", exact: true }).click();
        await fresh.getByRole("button", { name: "Log it", exact: true }).click();
        await fresh.waitFor({ state: "hidden" });
        assert.equal(posted.at(-1)?.data.plan, "p1f1");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feed parts: While you slept counts a feed still going once, with its milk at the breast, never as a feed of its own", async () => {
      const helper = { email: "helper@example.test", display_name: "Alex", role: "member", emoji: null, color: null };
      const state = freshState();
      // Sam last looked at 1:00 AM; Alex fed her at 6:00 AM and is nursing again since 9:10 with 20 ml in the SNS at 9:18.
      state.seen_at = "2026-10-28T05:00:00.000Z";
      state.members.push(helper);
      const by = { created_by: helper.email };
      state.entries = newest([
        { ...record(41, "feed", { method: "breast", segments: [{ side: "L", start: "2026-10-28T13:10:00.000Z", end: null }], first_side: "L", last_side: "L" }, "2026-10-28T13:10:00.000Z", by), active: true },
        record(42, "feed", { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", top_up_of: 41 }, "2026-10-28T13:18:00.000Z", by),
        record(31, "feed", { method: "breast", segments: [{ side: "R", start: "2026-10-28T10:00:00.000Z", end: "2026-10-28T10:15:00.000Z" }], first_side: "R", last_side: "R" }, "2026-10-28T10:00:00.000Z", { ...by, ended_at: "2026-10-28T10:15:00.000Z" }),
      ]);
      const f = await fixture({ state, records: state.entries });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#today");
        const recap = f.page.getByRole("button", { name: /^While you slept/ });
        assert.match(await recap.innerText(), /While you slept · 1 feed · nursing now · by Alex/);
        await recap.click();
        const note = (await f.page.locator("#wys-more").innerText()).replace(/[\u00a0\u202f]/g, " ");
        assert.match(note, /1 feed, at 6:00 AM\./);
        assert.match(note, /Nursing now, since 9:10 AM, 20 ml in the SNS\./);
        assert.deepEqual(writes(f), []);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

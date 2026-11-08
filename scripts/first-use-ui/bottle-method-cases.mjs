/**
 * The bottle form's How (bottle, paced bottle, SNS at the breast) and a Mixed bottle's split: both parts make the
 * amount, one part and the amount say what the rest is, a new amount clears the split, and an edit sends only what
 * changed. Made-up amounts, in ml.
 */
export function bottleMethodCases({ fixture, freshState, record, writes, assert }) {
  const reply = ({ route, req }) => route.fulfill({ json: { entry: record(99, "feed", req.postDataJSON().data, req.postDataJSON().started_at ?? "2026-10-28T13:30:00.000Z", req.postDataJSON()) } });
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  const openBottle = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: /^Bottle/ }).click();
    return f.page.getByRole("dialog", { name: "Feed", exact: true });
  };
  const ml = (form, name) => form.getByRole("textbox", { name, exact: true });
  return [
    ["Formula shows without scrolling on a small phone, and a formula bottle logs as one", async () => {
      const f = await fixture({ entryResponse: reply });
      try {
        await f.page.setViewportSize({ width: 375, height: 667 });
        const form = await openBottle(f);
        const formula = form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true });
        const box = await formula.boundingBox();
        assert(box && box.y >= 0 && box.y + box.height <= 667, `Formula is on screen at 375 × 667 without scrolling (top ${box?.y})`);
        await formula.click();
        await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
        await form.getByRole("button", { name: "Log 2 oz now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { method: "bottle", amount_ml: 59.1, milk: "formula" });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["With Bottles off, More turns them on in one tap and opens the bottle form", async () => {
      const state = freshState();
      state.baby.settings = { ...state.baby.settings, feeds_bottle: false };
      const patches = [];
      const f = await fixture({
        state,
        apiResponse: ({ route, req, url }) => {
          if (url.pathname !== "/api/maple/baby" || req.method() !== "PATCH") return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
          patches.push(req.postDataJSON());
          state.baby.settings = { ...state.baby.settings, ...req.postDataJSON().settings };
          return route.fulfill({ json: { baby: state.baby } });
        },
      });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^More/ }).click();
        assert.equal(await f.page.getByRole("button", { name: /^Bottle/ }).count(), 1, "Bottles off: only More's row offers a bottle");
        await f.page.getByRole("button", { name: /^Bottle.*Turn on bottles/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true }).waitFor();
        assert.deepEqual(patches, [{ settings: { feeds_bottle: true } }], "the family's Bottles switch, and nothing else");
        await form.getByRole("button", { name: "Close", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        await f.page.getByRole("button", { name: /^Bottle/ }).first().waitFor();
        assert.deepEqual(writes(f), [], "turning bottles on logs nothing by itself");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["How it was given saves with the bottle, and nothing is chosen for you", async () => {
      const state = freshState();
      // The last bottle was paced: a new one still starts with no way of giving chosen.
      state.entries = [record(61, "feed", { method: "bottle", amount_ml: 35, milk: "breastmilk", via: "paced" }, "2026-10-28T09:00:00.000Z")];
      const f = await fixture({ state, entryResponse: reply });
      try {
        await metric(f);
        const form = await openBottle(f);
        const how = form.getByRole("region", { name: "How it was given" });
        for (const label of ["Bottle", "Paced bottle", "SNS at the breast"]) assert.equal(await how.getByRole("button", { name: label, exact: true }).getAttribute("aria-pressed"), "false", `${label} starts unchosen`);
        await how.getByRole("button", { name: "SNS at the breast", exact: true }).click();
        await form.getByRole("button", { name: "Formula", exact: true }).click();
        await ml(form, "millilitres").fill("30");
        await form.getByRole("button", { name: "Log 30 ml now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { method: "bottle", amount_ml: 30, milk: "formula", via: "sns" });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A Mixed bottle's two parts make its amount, and a new amount clears them", async () => {
      const f = await fixture({ entryResponse: reply });
      try {
        await metric(f);
        const form = await openBottle(f);
        await form.getByRole("button", { name: "Mixed", exact: true }).click();
        await ml(form, "breast milk, millilitres").fill("30");
        await ml(form, "formula, millilitres").fill("20");
        assert.equal(await ml(form, "millilitres").inputValue(), "50", "the amount is the parts' sum");
        // A new amount: the old split no longer describes it.
        await ml(form, "millilitres").fill("60");
        assert.equal(await ml(form, "breast milk, millilitres").inputValue(), "");
        assert.equal(await ml(form, "formula, millilitres").inputValue(), "");
        await ml(form, "formula, millilitres").fill("20");
        assert.match(await form.textContent(), /The rest, 40 ml, is breast milk\./);
        await ml(form, "formula, millilitres").fill("70");
        assert.match(await form.getByRole("alert").first().textContent(), /One part is more than the whole bottle/);
        assert(await form.getByRole("button", { name: "Log 60 ml now", exact: true }).isDisabled(), "a part bigger than the bottle can't save");
        await ml(form, "formula, millilitres").fill("20");
        await form.getByRole("button", { name: "Log 60 ml now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { method: "bottle", amount_ml: 60, milk: "mixed", formula_ml: 20 });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Editing how a Mixed bottle was given sends only that, keeping its split", async () => {
      const state = freshState();
      const saved = record(62, "feed", { method: "bottle", amount_ml: 50, milk: "mixed", breastmilk_ml: 30, formula_ml: 20 }, "2026-10-28T09:00:00.000Z");
      state.entries = [saved];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...saved, ...req.postDataJSON(), data: { ...saved.data, ...req.postDataJSON().data } } } }) });
      try {
        await metric(f);
        await f.page.goto("https://first-use.example.test/#log");
        await f.page.getByRole("button", { name: /^Edit: Bottle,/ }).click();
        const form = f.page.getByRole("dialog", { name: "Bottle", exact: true });
        assert.equal(await ml(form, "breast milk, millilitres").inputValue(), "30");
        assert.equal(await ml(form, "formula, millilitres").inputValue(), "20");
        await form.getByRole("region", { name: "How it was given" }).getByRole("button", { name: "Bottle", exact: true }).click();
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { via: "bottle" });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

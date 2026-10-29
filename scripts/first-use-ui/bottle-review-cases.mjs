export function bottleReviewCases({ fixture, freshState, record, writes, assert }) {
  const reply = ({ route, req }) => route.fulfill({ json: { entry: record(99, "feed", req.postDataJSON().data, undefined, req.postDataJSON()) } });
  const openBottle = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: /^Bottle/ }).click();
    return f.page.getByRole("dialog", { name: "Feed", exact: true });
  };
  return [
    ["Zero bottle intake cannot create a feed; an unknown amount remains optional", async () => {
      const f = await fixture({ entryResponse: reply });
      try {
        const form = await openBottle(f);
        const amount = form.getByRole("textbox", { name: "ounces", exact: true });
        await amount.fill("0");
        assert(await form.getByRole("button", { name: /^Log / }).isDisabled(), "Zero intake must not become a completed feed");
        assert.match(await form.getByRole("alert").textContent(), /Enter more than 0, or leave blank if the amount is unknown/);
        assert.equal(writes(f).length, 0);
        await amount.fill("");
        await form.getByRole("button", { name: "Formula", exact: true }).click();
        await form.getByRole("button", { name: "Log bottle", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.amount_ml, undefined);
        assert.equal(writes(f)[0]?.body.data.milk, "formula");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Bottle corrections reject zero while existing zero records remain editable", async () => {
      for (const originalAmount of [0, 59.1]) {
        const state = freshState();
        const original = record(51, "feed", { method: "bottle", amount_ml: originalAmount, milk: "formula" });
        state.entries = [original];
        const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
        try {
          await f.page.goto("https://first-use.example.test/#log");
          await f.page.getByRole("button", { name: /^Edit: Bottle,/ }).click();
          const form = f.page.getByRole("dialog", { name: "Bottle", exact: true });
          await form.locator("textarea").fill("Synthetic bottle note");
          const save = form.getByRole("button", { name: "Save", exact: true });
          assert(await save.isEnabled(), "A note-only correction must preserve old records");
          if (originalAmount === 0) {
            await save.click();
            await form.waitFor({ state: "hidden" });
            assert.equal(writes(f)[0]?.body.note, "Synthetic bottle note");
            assert.equal(writes(f)[0]?.body.data, undefined);
          } else {
            await form.getByRole("textbox", { name: "ounces", exact: true }).fill("0");
            assert(await save.isDisabled(), "A changed bottle amount must not become zero intake");
            assert.equal(writes(f).length, 0);
            await form.getByRole("textbox", { name: "ounces", exact: true }).fill("1.6");
            await save.click();
            await form.waitFor({ state: "hidden" });
            assert.equal(writes(f)[0]?.body.data.amount_ml, 47.3);
          }
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["Repeating a bottle retains the last recorded amount and shows its precision", async () => {
      for (const [units, ml, shown, label] of [["us", 63, "2.13", "2.13 oz"], ["metric", 2, "2", "2 ml"]]) {
        const state = freshState();
        state.entries = [record(51, "feed", { method: "bottle", amount_ml: ml, milk: "mixed" })];
        const f = await fixture({ state, entryResponse: reply });
        try {
          await f.page.addInitScript((value) => localStorage.setItem("maple-units", value), units);
          const form = await openBottle(f);
          const amount = form.getByRole("textbox", { name: units === "metric" ? "millilitres" : "ounces", exact: true });
          assert.equal(await amount.inputValue(), shown, "Repeating a bottle must not round it to a different serving");
          assert.match(await form.textContent(), new RegExp(`Last bottle: ${label.replace(".", "\\.")}`));
          await form.getByRole("button", { name: `Log ${label} now`, exact: true }).click();
          await form.waitFor({ state: "hidden" });
          assert.equal(writes(f)[0]?.body.data.amount_ml, ml, "An unchanged repeated bottle retains its metric amount");
          assert.equal(writes(f)[0]?.body.data.milk, "mixed");
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["The feed method selector has an accessible name and bottle amount states consumption", async () => {
      const f = await fixture();
      try {
        const form = await openBottle(f);
        const methods = form.getByRole("radiogroup", { name: "Feed type", exact: true });
        assert(await methods.isVisible());
        assert.equal(await methods.getByRole("radio", { name: "Bottle", exact: true }).getAttribute("aria-checked"), "true");
        assert(await form.getByText("Amount consumed", { exact: true }).isVisible());
        await methods.getByRole("radio", { name: "Breast", exact: true }).click();
        assert(await form.getByRole("textbox", { name: "minutes on the left", exact: true }).isVisible());
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

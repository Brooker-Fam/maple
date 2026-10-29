export function volumeBoundaryCases({ fixture, freshState, record, writes, assert }) {
  const variants = [
    { name: "bottle", kind: "feed", data: { method: "bottle", amount_ml: 500 }, title: "Bottle", field: "ounces", shown: "16.91", maximum: "16.907", corrected: "16.9", expected: 499.8, key: "amount_ml", limit: 500 },
    { name: "pump side", kind: "pump", data: { left_ml: 600 }, title: "Pumped", field: "left, oz", shown: "20.29", maximum: "20.288", corrected: "20.28", expected: 599.8, key: "left_ml", limit: 600 },
    { name: "pump total", kind: "pump", data: { total_ml: 1200 }, title: "Pumped", field: "total, oz", shown: "40.58", maximum: "40.576", corrected: "40.57", expected: 1199.8, key: "total_ml", limit: 1200 },
  ];
  const savedFixture = async (variant, amount) => {
    const state = freshState();
    const data = amount == null ? variant.data : { ...variant.data, [variant.key]: amount };
    const original = record(801, variant.kind, data);
    state.entries = [original];
    const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON(), data: { ...original.data, ...req.postDataJSON().data } } } }) });
    await f.page.goto("https://first-use.example.test/#log");
    await f.page.getByRole("button", { name: new RegExp(`^Edit: ${variant.title},`) }).click();
    return { f, form: f.page.getByRole("dialog", { name: variant.title, exact: true }) };
  };
  return [
    ...variants.map((variant) => [`Volume boundary: maximum ${variant.name} stays editable in US units`, async () => {
      const { f, form } = await savedFixture(variant);
      try {
        const amount = form.getByRole("textbox", { name: variant.field, exact: true });
        assert.equal(await amount.inputValue(), variant.shown);
        await form.locator("textarea").fill("Synthetic maximum-volume note");
        assert.notEqual(await amount.getAttribute("aria-invalid"), "true", "An untouched valid metric amount is valid in US units");
        const save = form.getByRole("button", { name: "Save", exact: true });
        assert(await save.isEnabled(), "A note-only correction must not be blocked by rounded US display");
        await save.click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.note, "Synthetic maximum-volume note");
        assert.equal(writes(f)[0]?.body.data, undefined, "The exact untouched metric amount must not be resent");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ...variants.map((variant) => [`Volume boundary: ${variant.name} explains the limit and permits correction`, async () => {
      const { f, form } = await savedFixture(variant, 60);
      try {
        const amount = form.getByRole("textbox", { name: variant.field, exact: true });
        await amount.fill(variant.shown);
        assert.equal(await amount.inputValue(), variant.shown, "An out-of-range amount must not be clamped");
        assert.equal(await amount.getAttribute("aria-invalid"), "true");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
        assert.match(await form.getByRole("alert").allTextContents().then((parts) => parts.join(" ")), new RegExp(`${variant.limit} ml`), "Explain the canonical limit in an accessible error");
        assert.equal(writes(f).length, 0);
        await amount.fill(variant.corrected);
        await form.getByRole("button", { name: `More ${variant.field}`, exact: true }).click();
        assert.equal(await amount.inputValue(), variant.maximum, "The upper step remains readable and inside the metric limit");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled());
        await amount.fill(variant.corrected);
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data[variant.key], variant.expected);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ["Volume boundary: repeating the metric maximum retains its exact amount", async () => {
      const state = freshState();
      state.entries = [record(802, "feed", { method: "bottle", amount_ml: 500, milk: "formula" })];
      const f = await fixture({ state, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(803, "feed", req.postDataJSON().data) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const save = form.getByRole("button", { name: "Log 16.91 oz now", exact: true });
        assert(await save.isEnabled());
        await save.click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.amount_ml, 500);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Volume boundary: maximum pump sides combine without rounding or blocking", async () => {
      const variant = { ...variants[1], data: { left_ml: 600, right_ml: 600 } };
      const { f, form } = await savedFixture(variant);
      try {
        const total = form.getByRole("radio", { name: "Total", exact: true });
        assert(await total.isEnabled());
        await total.click();
        assert.equal(await form.getByRole("textbox", { name: "total, oz", exact: true }).inputValue(), "40.58");
        const save = form.getByRole("button", { name: "Save", exact: true });
        assert(await save.isEnabled());
        await save.click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { total_ml: 1200, left_ml: null, right_ml: null });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ...variants.map((variant) => [`Volume boundary: tiny imported ${variant.name} stays positive in its editor`, async () => {
      const { f, form } = await savedFixture(variant, 0.01);
      try {
        assert(Number(await form.getByRole("textbox", { name: variant.field, exact: true }).inputValue()) > 0, "A positive imported amount must not look like zero");
        await form.locator("textarea").fill("Synthetic tiny-volume note");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data, undefined);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
  ];
}

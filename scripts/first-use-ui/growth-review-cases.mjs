export function growthReviewCases({ fixture, freshState, record, writes, assert }) {
  const openNew = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: "More", exact: true }).click();
    await f.page.getByRole("button", { name: "Growth", exact: true }).click();
    return f.page.getByRole("dialog", { name: "Growth", exact: true });
  };
  return [
    ["Growth boundary: metric maximums survive US units without changing their values", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(901, "growth", req.postDataJSON().data) } }) });
      try {
        const form = await openNew(f);
        await form.getByRole("radio", { name: "g · cm", exact: true }).click();
        await form.getByRole("textbox", { name: "grams", exact: true }).fill("30000");
        await form.getByRole("textbox", { name: "length in centimetres", exact: true }).fill("130");
        await form.getByRole("textbox", { name: "head circumference in centimetres", exact: true }).fill("60");
        assert(await form.getByRole("button", { name: "Log it", exact: true }).isEnabled());
        await form.getByRole("radio", { name: "lb · in", exact: true }).click();
        await f.page.waitForFunction(() => document.querySelector('input[aria-label="length in inches"]')?.value === "51.18");
        assert.equal(await form.getByRole("textbox", { name: "pounds", exact: true }).inputValue(), "66");
        assert.equal(await form.getByRole("textbox", { name: "length in inches", exact: true }).inputValue(), "51.18");
        assert.notEqual(await form.getByRole("textbox", { name: "pounds", exact: true }).getAttribute("aria-invalid"), "true");
        assert.notEqual(await form.getByRole("textbox", { name: "length in inches", exact: true }).getAttribute("aria-invalid"), "true");
        const metric = form.getByRole("radio", { name: "g · cm", exact: true });
        assert(await metric.isEnabled(), "Converted valid measurements must not prevent switching units back");
        await metric.click();
        await form.getByRole("radio", { name: "lb · in", exact: true }).click();
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.deepEqual(writes(f)[0]?.body.data, { weight_g: 30000, length_cm: 130, head_cm: 60, at: "doctor" });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ...[
      { label: "weight", data: { weight_g: 20000 }, field: "pounds", shown: "44" },
      { label: "length", data: { weight_g: 3345, length_cm: 130 }, field: "length in inches", shown: "51.18" },
    ].map(({ label, data, field, shown }) => [`Growth boundary: a saved upper-range ${label} allows a note correction in US units`, async () => {
      const state = freshState();
      const original = record(902, "growth", { ...data, at: "home" });
      state.entries = [original];
      state.growth = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON(), data: { ...original.data, ...req.postDataJSON().data } } } }) });
      try {
        await f.page.goto("https://first-use.example.test/#patterns");
        await f.page.getByRole("button", { name: /Growth/ }).click();
        await f.page.getByRole("button", { name: "Edit the Today measurement", exact: true }).click();
        const form = f.page.getByRole("dialog").last();
        assert.equal(await form.getByRole("textbox", { name: field, exact: true }).inputValue(), shown);
        await form.locator("textarea").fill("Synthetic measurement note");
        const save = form.getByRole("button", { name: "Save", exact: true });
        assert(await save.isEnabled(), "An untouched valid metric reading must not block saving a note");
        await save.click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.note, "Synthetic measurement note");
        assert.equal(writes(f)[0]?.body.data, undefined, "A note-only change must preserve exact recorded measurements");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ["Growth boundary: decimal pounds within the canonical limit remain savable", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(904, "growth", req.postDataJSON().data) } }) });
      try {
        const form = await openNew(f);
        const pounds = form.getByRole("textbox", { name: "pounds", exact: true });
        await pounds.fill("66.1");
        assert.notEqual(await pounds.getAttribute("aria-invalid"), "true");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.weight_g, 29982);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Growth boundary: head circumference enforces its canonical maximum and accepts a correction", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(903, "growth", req.postDataJSON().data) } }) });
      try {
        const form = await openNew(f);
        const head = form.getByRole("textbox", { name: "head circumference in inches", exact: true });
        await head.fill("25");
        assert.equal(await head.inputValue(), "25");
        assert.equal(await head.getAttribute("aria-invalid"), "true", "An amount above 60 cm must identify the field to correct");
        await form.getByRole("button", { name: "Log it", exact: true }).and(form.locator(":disabled")).waitFor();
        assert.equal(writes(f).length, 0);
        await head.fill("23..6");
        assert.equal(await head.inputValue(), "23..6", "Malformed text must stay visible for correction");
        assert(await form.getByRole("radio", { name: "g · cm", exact: true }).isDisabled());
        await head.fill("23.62");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.head_cm, 60);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

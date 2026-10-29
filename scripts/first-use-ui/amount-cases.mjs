export function amountCases({ fixture, record, writes, assert }) {
  return [
    ["Decimal comma bottle amounts keep the entered quantity", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(99, "feed", req.postDataJSON().data) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const amount = form.getByRole("textbox", { name: "ounces", exact: true });
        await amount.fill("1,5");
        assert.equal(await amount.inputValue(), "1,5");
        await form.getByRole("button", { name: "Formula", exact: true }).click();
        await form.getByRole("button", { name: "Log 1.5 oz now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.amount_ml, 44.4);
        assert.equal(writes(f)[0]?.body.data.milk, "formula");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Invalid bottle numbers stay visible and cannot save", async () => {
      const f = await fixture();
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const amount = form.getByRole("textbox", { name: "ounces", exact: true });
        for (const text of ["-2", "1/2", "1,2.5", "abc", "1e2"]) {
          await amount.fill(text);
          assert.equal(await amount.inputValue(), text);
          assert.equal(await amount.getAttribute("aria-invalid"), "true");
          assert(await form.getByRole("button", { name: /^Log / }).isDisabled());
        }
        assert.equal(writes(f).length, 0);
        await amount.fill("2.5");
        assert(await form.getByRole("button", { name: "Log 2.5 oz now", exact: true }).isEnabled());
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Decimal comma temperature uses the entered reading", async () => {
      const f = await fixture({ entryResponse: ({ route, req }) => route.fulfill({ json: { entry: record(99, "temp", req.postDataJSON().data) } }) });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("button", { name: /^Temperature/ }).click();
        const form = f.page.getByRole("dialog", { name: "Temperature", exact: true });
        const reading = form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true });
        await reading.fill("98,6");
        assert.equal(await reading.inputValue(), "98,6");
        await form.getByRole("button", { name: /^Log / }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.temp_c, 37);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

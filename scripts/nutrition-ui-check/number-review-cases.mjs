export function nutritionNumberCases({ assert, page, snapshot, reset, closeSaved, openManual }) {
  const drink = async (units, amount) => {
    await reset();
    await page.waitForFunction(() => !!window.__nutritionFixture);
    if (units === "ml") await page.evaluate(() => window.__nutritionFixture.setUnits("metric"));
    await openManual("Other drink");
    await page.getByLabel("Drink", { exact: true }).fill("Synthetic tea");
    await page.getByLabel(`Amount in ${units}`, { exact: true }).fill(amount);
  };
  const food = async () => {
    await reset();
    await openManual("Ate something");
    await page.getByRole("button", { name: "Add food item", exact: true }).click();
    await page.getByLabel("Food 1 name", { exact: true }).fill("Synthetic oats");
  };
  return [
    ["nutrition US decimal comma saves the entered drink volume", async () => {
      await drink("oz", "1,5");
      assert.equal(await page.getByRole("button", { name: "Log drink", exact: true }).isEnabled(), true);
      assert.equal(await page.getByLabel("Amount in oz", { exact: true }).inputValue(), "1,5");
      await page.getByRole("button", { name: "Log drink", exact: true }).click();
      await closeSaved();
      assert(Math.abs((await snapshot()).server[0].data.amount_ml - 44.36029434375) < 0.000001);
    }],
    ["nutrition metric decimal comma saves without unit conversion", async () => {
      await drink("ml", "1,5");
      assert.equal(await page.getByRole("button", { name: "Log drink", exact: true }).isEnabled(), true);
      await page.getByRole("button", { name: "Log drink", exact: true }).click();
      await closeSaved();
      assert.equal((await snapshot()).server[0].data.amount_ml, 1.5);
    }],
    ["nutrition decimal nutrients preserve known zero and unknown values", async () => {
      await food();
      await page.getByLabel("Food 1 protein (g)", { exact: true }).fill("1,5");
      await page.getByLabel("Food 1 fiber (g)", { exact: true }).fill("0");
      assert.equal(await page.getByRole("button", { name: "Log food", exact: true }).isEnabled(), true);
      assert.equal(await page.getByLabel("Food 1 protein (g)", { exact: true }).inputValue(), "1,5");
      await page.getByRole("button", { name: "Log food", exact: true }).click();
      await closeSaved();
      const nutrients = (await snapshot()).server[0].data.items[0].nutrients;
      assert.equal(nutrients.protein_g, 1.5);
      assert.equal(nutrients.fiber_g, 0);
      assert.equal(nutrients.energy_kcal ?? null, null);
    }],
    ["nutrition rejects malformed and negative amounts without rewriting them", async () => {
      await drink("ml", "1e2");
      const amount = page.getByLabel("Amount in ml", { exact: true });
      for (const text of ["1e2", "0x10", "-2", "1/2", "1,2.5", "abc", "0"]) {
        await amount.fill(text);
        assert.equal(await amount.inputValue(), text);
        assert.equal(await amount.getAttribute("aria-invalid"), "true", text);
        assert.equal(await page.getByRole("button", { name: "Log drink", exact: true }).isDisabled(), true, text);
      }
      await amount.fill("");
      assert.equal(await page.getByRole("button", { name: "Log drink", exact: true }).isEnabled(), true);
      await page.getByRole("button", { name: "Log drink", exact: true }).click();
      await closeSaved();
      assert.equal((await snapshot()).server[0].data.amount_ml, null);
      await food();
      const protein = page.getByLabel("Food 1 protein (g)", { exact: true });
      for (const text of ["1e2", "0x10", "-2", "1/2", "1,2.5", "abc"]) {
        await protein.fill(text);
        assert.equal(await protein.inputValue(), text);
        assert.equal(await protein.getAttribute("aria-invalid"), "true", text);
        assert.equal(await page.getByRole("button", { name: "Log food", exact: true }).isDisabled(), true, text);
      }
      await protein.fill("");
      assert.equal(await page.getByRole("button", { name: "Log food", exact: true }).isEnabled(), true);
      assert.equal((await snapshot()).requests.length, 0);
    }],
    ["nutrition meal selector announces its purpose", async () => {
      await reset();
      await openManual("Ate something");
      const group = page.getByRole("radiogroup", { name: "Meal type", exact: true });
      assert.equal(await group.count(), 1);
      await group.getByRole("radio", { name: "Snack", exact: true }).click();
      await page.getByRole("button", { name: "Log food", exact: true }).click();
      await closeSaved();
      assert.equal((await snapshot()).server[0].data.meal, "snack");
    }],
  ];
}

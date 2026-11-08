/**
 * Amounts in ml and oz (Settings → This device → Units, kept on this phone as "maple-volume-both"): with it on,
 * every amount reads both ways, the phone's units first, and each amount field has an ml | oz switch with the other
 * unit live under it; switching keeps the amount, and what's saved is ml. Off (the default), everything reads as it
 * did. Made-up feeds and amounts on the fixture's clock (9:30 AM in the family's zone); the plan is the invented one
 * in feeding-plan-cases.mjs ("Nurse + SNS" with 20 ml of formula in the SNS, a 50–70 ml target).
 */
export function bothUnitsCases({ fixture, freshState, record, writes, assert }) {
  const both = (f, units = "us") =>
    f.page.addInitScript((units) => {
      localStorage.setItem("maple-units", units);
      localStorage.setItem("maple-volume-both", "1");
    }, units);
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
  const newest = (list) => [...list].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);
  // 5:00 AM nursing with a 30 ml paced top-up at 5:28 (the plan's "Nurse, top up"); a 2 oz bottle of formula on its own at 8:10.
  const day = () => {
    const state = freshState();
    state.baby.settings = { show_alerts: false, feeding_plan: structuredClone(PLAN), feed_target_ml: { min: 50, max: 70 } };
    state.entries = newest([
      record(46, "feed", { method: "bottle", amount_ml: 59.1, milk: "formula" }, "2026-10-28T12:10:00.000Z"),
      record(42, "feed", { method: "bottle", amount_ml: 30, milk: "formula", via: "paced", plan: "p1f2" }, "2026-10-28T09:28:00.000Z"),
      record(41, "feed", { method: "breast", plan: "p1f2", segments: [{ side: "L", start: "2026-10-28T09:00:00.000Z", end: "2026-10-28T09:12:00.000Z" }, { side: "R", start: "2026-10-28T09:13:00.000Z", end: "2026-10-28T09:25:00.000Z" }], first_side: "L", last_side: "R" }, "2026-10-28T09:00:00.000Z", { ended_at: "2026-10-28T09:25:00.000Z", updated_at: "2026-10-28T09:25:00.000Z" }),
    ]);
    return state;
  };
  const saved = ({ route, req }) => route.fulfill({ json: { entry: record(99, req.postDataJSON().kind, req.postDataJSON().data, req.postDataJSON().started_at ?? "2026-10-28T13:30:00.000Z") } });
  /** A field's value once it shows `want` (a unit switch updates the field's text a frame after the tap). */
  const shown = async (field, want) => {
    for (let i = 0; i < 40 && (await field.inputValue()) !== want; i++) await field.page().waitForTimeout(50);
    return field.inputValue();
  };
  const unitIn = (scope, name) => scope.getByRole("radiogroup", { name, exact: true });

  return [
    ["Amounts in ml and oz: off by default; the phone's switch in Settings turns it on for this phone, and Today then reads both", async () => {
      const state = day();
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.goto("https://first-use.example.test/#family/appearance");
        const toggle = f.page.getByRole("switch", { name: "Amounts in ml and oz", exact: true });
        await toggle.waitFor();
        assert.equal(await toggle.getAttribute("aria-checked"), "false", "off by default");
        assert.match(await f.page.locator("body").innerText(), /Every amount shows both, your units first: 2 oz \(59\.1 ml\)\. Amounts can be typed in either\./);
        await f.page.goto("https://first-use.example.test/#today");
        const recent = f.page.getByRole("region", { name: "Recently logged", exact: true });
        await recent.waitFor();
        assert.match(await recent.innerText(), /2 oz · formula/);
        assert.doesNotMatch(await recent.innerText(), /59\.1 ml/, "one unit while it's off");
        await f.page.goto("https://first-use.example.test/#family/appearance");
        await toggle.click();
        assert.equal(await toggle.getAttribute("aria-checked"), "true");
        assert.equal(await f.page.evaluate(() => localStorage.getItem("maple-volume-both")), "1", "kept on this phone");
        await f.page.goto("https://first-use.example.test/#today");
        await recent.waitFor();
        assert.match(await recent.innerText(), /2 oz \(59\.1 ml\) · formula/);
        assert.equal(writes(f).length, 0, "a phone's choice, never saved for the family");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Amounts in ml and oz: Today's rows, Last fed, the dock's Bottle tile and the plan's card show both, the plan's unit first on its amounts", async () => {
      const state = day();
      const f = await fixture({ state, records: state.entries });
      try {
        await both(f);
        await f.page.goto("https://first-use.example.test/#today");
        const recent = f.page.getByRole("region", { name: "Recently logged", exact: true });
        await recent.waitFor();
        const rows = (await recent.innerText()).replace(/\s+/g, " ");
        assert.match(rows, /Bottle 2 oz \(59\.1 ml\) · formula/, "a bottle, the phone's units first");
        // The plan is in ml: a feed's part says the plan's unit first.
        assert.equal(await recent.getByRole("button", { name: /^Edit: \+ 30 ml \(1\.01 oz\) top-up/ }).textContent(), "+ 30 ml (1.01 oz) top-up");
        // Last fed: the bottle and the care team's target, both ways.
        const page = (await f.page.locator("body").innerText()).replace(/\s+/g, " ");
        assert.match(page, /2 oz \(59\.1 ml\) bottle · target 1\.69–2\.37 oz \(50–70 ml\)/);
        // The plan's card says its amounts in its unit, the other in brackets.
        assert.match((await f.page.locator("[data-next-feed]").innerText()).replace(/\s+/g, " "), /20 ml \(0\.68 oz\) of formula in the SNS/);
        // The dock's Bottle tile: the last bottle, the other unit on a line of its own (one line at 320px holds one).
        const tile = f.page.locator('[data-tile="bottle"]');
        assert.equal(await tile.innerText(), "Bottle\n2 oz last\n59.1 ml");
        await f.page.setViewportSize({ width: 320, height: 640 });
        const box = await tile.boundingBox();
        const fits = await tile.evaluate((el) => [...el.querySelectorAll("span")].every((s) => s.getBoundingClientRect().right <= el.getBoundingClientRect().right + 0.5));
        assert(box && box.height <= 64.5, `the tile keeps the row's 64px at 320 (${box?.height})`);
        assert(fits, "the tile's lines fit it at 320");
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no sideways scroll");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Amounts in ml and oz: the bottle form takes oz on a metric phone and saves ml; the other unit shows live under the field", async () => {
      const f = await fixture({ entryResponse: saved });
      try {
        await both(f, "metric");
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).first().click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const unit = unitIn(form, "Amount in");
        assert.equal(await unit.getByRole("radio", { name: "ml", exact: true }).getAttribute("aria-checked"), "true", "it starts in the phone's unit");
        await unit.getByRole("radio", { name: "oz", exact: true }).click();
        const amount = form.getByRole("textbox", { name: "ounces", exact: true });
        await amount.fill("2");
        await form.getByText("= 59.1 ml", { exact: true }).waitFor();
        // Quick amounts follow the field's unit.
        await form.getByRole("button", { name: "3 oz", exact: true }).waitFor();
        await form.getByRole("button", { name: "2 oz", exact: true }).waitFor();
        await form.getByRole("button", { name: "Formula", exact: true }).click();
        await form.getByRole("button", { name: "Log 2 oz (59.1 ml) now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.amount_ml, 59.1, "saved in ml");
        assert.equal(writes(f)[0]?.body.data.milk, "formula");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Amounts in ml and oz: switching a field's unit keeps the amount (the bottle form and the pump's total), never re-rounds it", async () => {
      const f = await fixture({ entryResponse: saved });
      try {
        await both(f, "metric");
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).first().click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const unit = unitIn(form, "Amount in");
        await form.getByRole("textbox", { name: "millilitres", exact: true }).fill("250");
        await unit.getByRole("radio", { name: "oz", exact: true }).click();
        assert.equal(await shown(form.getByRole("textbox", { name: "ounces", exact: true }), "8.45"), "8.45");
        await form.getByText("= 250 ml", { exact: true }).waitFor();
        await unit.getByRole("radio", { name: "ml", exact: true }).click();
        assert.equal(await shown(form.getByRole("textbox", { name: "millilitres", exact: true }), "250"), "250", "back to the same 250 ml");
        await unit.getByRole("radio", { name: "oz", exact: true }).click();
        await form.getByRole("button", { name: "Log 8.45 oz (250 ml) now", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0]?.body.data.amount_ml, 250, "8.45 oz read from 250 ml still saves 250 ml, not 249.9");
        // The pump's total: 90 ml read in oz saves 90 ml.
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Pump/ }).click();
        const pump = f.page.getByRole("dialog", { name: "Pump", exact: true });
        await pump.getByRole("radio", { name: "Total", exact: true }).click();
        await pump.getByRole("textbox", { name: "total, ml", exact: true }).fill("90");
        await unitIn(pump, "Pumped amounts in").getByRole("radio", { name: "oz", exact: true }).click();
        assert.equal(await shown(pump.getByRole("textbox", { name: "total, oz", exact: true }), "3.04"), "3.04");
        await pump.getByText("= 90 ml", { exact: true }).waitFor();
        await pump.getByRole("button", { name: "Log it", exact: true }).click();
        await pump.waitFor({ state: "hidden" });
        assert.equal(writes(f)[1]?.body.data.total_ml, 90);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Amounts in ml and oz: the target per feed is typed in either unit, said live in the other, and saves what was typed", async () => {
      const state = day();
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
        await both(f);
        await f.page.goto("https://first-use.example.test/#family/doctor");
        const from = (u) => f.page.getByRole("textbox", { name: new RegExp(`^Target per feed, from \\(${u}\\)`) });
        const upTo = (u) => f.page.getByRole("textbox", { name: `Up to (${u})`, exact: true });
        assert.equal(await from("oz").inputValue(), "1.69");
        assert.equal(await upTo("oz").inputValue(), "2.37");
        await f.page.getByText("= 50–70 ml", { exact: true }).waitFor();
        const unit = unitIn(f.page, "Target per feed in");
        await unit.getByRole("radio", { name: "ml", exact: true }).click();
        assert.equal(await shown(from("ml"), "50"), "50");
        await upTo("ml").fill("75");
        await f.page.getByText("= 1.69–2.54 oz", { exact: true }).waitFor();
        await unit.getByRole("radio", { name: "oz", exact: true }).click();
        assert.equal(await shown(upTo("oz"), "2.54"), "2.54");
        await f.page.getByRole("button", { name: "Save changes", exact: true }).click();
        for (let i = 0; i < 20 && !patches.length; i++) await f.page.waitForTimeout(100);
        // 75 ml read as 2.54 oz saves 75, and the saved 50 stays 50 (2.54 oz typed would be 75.1).
        assert.deepEqual(patches.at(-1)?.settings?.feed_target_ml, { min: 50, max: 75 });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Amounts in ml and oz: the feeding plan's form says each amount in the other unit under it; its Amounts in is the switch", async () => {
      const state = day();
      const f = await fixture({ state, apiResponse: ({ route }) => route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } }) });
      try {
        await both(f);
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Feeding plan/ }).click();
        const sheet = f.page.getByRole("dialog", { name: "Feeding plan", exact: true });
        await sheet.waitFor();
        assert.match((await sheet.innerText()).replace(/\s+/g, " "), /50–70 ml \(1\.69–2\.37 oz\)/, "the plan's sheet: its unit first");
        await sheet.getByRole("button", { name: "Edit the plan", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Edit the feeding plan", exact: true });
        await form.waitFor();
        await form.getByText("= 1.69–2.37 oz", { exact: true }).waitFor();
        // One switch for the plan's amounts, not one per field.
        assert.equal(await form.getByRole("radiogroup", { name: "Amounts in", exact: true }).count(), 1);
        await form.getByRole("radiogroup", { name: "Amounts in", exact: true }).getByRole("radio", { name: "oz", exact: true }).click();
        await form.getByText("= 50–70 ml", { exact: true }).waitFor();
        assert.equal(await form.getByRole("textbox", { name: "target per feed, in oz, from", exact: true }).inputValue(), "1.69");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

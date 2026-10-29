export function accessibilityReviewCases({ fixture, freshState, record, assert }) {
  const openMore = async (f, name) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: "More", exact: true }).click();
    await f.page.getByRole("button", { name, exact: true }).click();
    const form = f.page.getByRole("dialog", { name, exact: true });
    await form.waitFor();
    return form;
  };
  const enlarge = async (page) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
      localStorage.setItem("maple-night", "always");
      window.dispatchEvent(new Event("maple-night-pref"));
    });
  };
  return [
    ["History switch fits enlarged text and keeps sticky headings below it", async () => {
      const state = freshState();
      state.me = { ...state.me, role: "viewer" };
      state.members = [state.me];
      const f = await fixture({ state });
      try {
        await f.page.goto("https://first-use.example.test/#history/timeline");
        await f.page.getByRole("radiogroup", { name: "Show", exact: true }).waitFor();
        await enlarge(f.page);
        const measure = () => f.page.getByRole("radiogroup", { name: "Show", exact: true }).evaluate((group) => {
          const bar = group.parentElement;
          return {
            pageWidth: document.documentElement.clientWidth,
            pageScroll: document.documentElement.scrollWidth,
            barHeight: bar.getBoundingClientRect().height,
            offset: parseFloat(getComputedStyle(bar).getPropertyValue("--maple-history-bar")),
            choices: [...group.children].map((button) => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right, width: button.clientWidth, scroll: button.scrollWidth })),
          };
        });
        await f.page.waitForTimeout(100);
        let observed = await measure();
        assert(observed.pageScroll <= observed.pageWidth + 1, JSON.stringify(observed));
        for (const choice of observed.choices) assert(choice.left >= 0 && choice.right <= 320 && choice.scroll <= choice.width + 1, JSON.stringify(choice));
        assert(Math.abs(observed.offset - observed.barHeight) < 1, JSON.stringify(observed));
        await f.page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await f.page.setViewportSize({ width: 390, height: 844 });
        await f.page.waitForTimeout(100);
        observed = await measure();
        assert(Math.abs(observed.offset - observed.barHeight) < 1, JSON.stringify(observed));
        await f.page.getByRole("radio", { name: "Patterns", exact: true }).click();
        await f.page.waitForTimeout(100);
        observed = await measure();
        assert(Math.abs(observed.offset - observed.barHeight) < 1, JSON.stringify(observed));
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["History entries keep complete formula and pump details beside a readable clock", async () => {
      const state = freshState();
      state.me = { ...state.me, role: "viewer" };
      state.members = [state.me];
      state.entries = [record(941, "feed", { method: "bottle", amount_ml: 60, milk: "formula" }), record(942, "pump", { left_ml: 30, right_ml: 30 })];
      const f = await fixture({ state, records: state.entries });
      try {
        await f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
        await f.page.goto("https://first-use.example.test/#history/timeline");
        await f.page.getByRole("heading", { name: "History", exact: true }).waitFor();
        await enlarge(f.page);
        for (const [id, detail] of [[941, /60 ml.*formula/], [942, /60 ml.*L 30 ml.*R 30 ml/]]) {
          const row = f.page.locator(`[data-entry-id="${id}"]`).getByRole("button").first();
          const text = row.getByText(detail);
          await text.waitFor({ state: "attached" });
          const box = await text.boundingBox();
          assert(box && box.width >= 150 && box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
          assert(await text.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), "Entry details must wrap without truncation");
          const clock = await row.getByText("8:00 AM", { exact: true }).boundingBox();
          assert(clock && clock.x >= 0 && clock.x + clock.width <= 320, JSON.stringify(clock));
          assert(box.y >= clock.y + clock.height - 1 || clock.y >= box.y + box.height - 1 || box.x >= clock.x + clock.width - 1 || clock.x >= box.x + box.width - 1, "Entry details and clock must not overlap");
        }
        await f.page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await f.page.setViewportSize({ width: 390, height: 844 });
        const row = f.page.locator('[data-entry-id="942"]').getByRole("button").first();
        const title = await row.getByText("Pumped", { exact: true }).boundingBox();
        const clock = await row.getByText("8:00 AM", { exact: true }).boundingBox();
        assert(title && clock && clock.x > title.x && Math.abs(title.y - clock.y) < 35, "A regular-width row keeps its clock on the right");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Growth choices expose their group names", async () => {
      const f = await fixture();
      try {
        const form = await openMore(f, "Growth");
        assert.equal(await form.getByRole("radiogroup", { name: "Weighed at", exact: true }).count(), 1);
        assert.equal(await form.getByRole("radiogroup", { name: "Units", exact: true }).count(), 1);
      } finally { await f.close(); }
    }],
    ["Doctor questions ask before discarding a typed draft", async () => {
      const f = await fixture();
      try {
        let form = await openMore(f, "For the doctor");
        const input = form.getByRole("textbox", { name: "New question for the doctor" });
        await input.fill("Synthetic unsaved question");
        await f.page.keyboard.press("Escape");
        const guard = f.page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
        await guard.waitFor();
        await guard.getByRole("button", { name: "Keep editing", exact: true }).click();
        await guard.waitFor({ state: "hidden" });
        assert.equal(await input.inputValue(), "Synthetic unsaved question");
        await form.getByRole("button", { name: "Close", exact: true }).click();
        await guard.getByRole("button", { name: "Discard changes", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("button", { name: "For the doctor", exact: true }).click();
        form = f.page.getByRole("dialog", { name: "For the doctor", exact: true });
        assert.equal(await form.getByRole("textbox", { name: "New question for the doctor" }).inputValue(), "");
      } finally { await f.close(); }
    }],
    ["Doctor question entry keeps readable width with enlarged night text", async () => {
      const f = await fixture();
      try {
        const form = await openMore(f, "For the doctor");
        await enlarge(f.page);
        const input = form.getByRole("textbox", { name: "New question for the doctor" });
        await input.fill("Synthetic enlarged question");
        const box = await input.boundingBox();
        assert(box && box.width >= 160 && box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
      } finally { await f.close(); }
    }],
    ["Medicine save actions fit narrow enlarged night text", async () => {
      const state = freshState();
      state.care = {
        person: { member: state.me.email, name: "Sam", self: true, created_by: state.me.email },
        access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true },
        settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [],
      };
      const f = await fixture({ state, apiResponse: ({ route, url }) => url.pathname === "/api/maple/care/entries"
        ? route.fulfill({ json: { entries: [] } })
        : route.fulfill({ status: 400, json: { error: "Unexpected synthetic request" } }) });
      try {
        await f.page.goto("https://first-use.example.test/#care");
        await f.page.getByRole("button", { name: "Add a medicine", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Add a medicine", exact: true });
        await enlarge(f.page);
        await form.getByRole("button", { name: "Save", exact: true }).click({ force: true });
        for (const name of ["Save and add another", "Save"]) {
          const button = form.getByRole("button", { name, exact: true });
          const box = await button.boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= 320 && box.width >= 44, `${name}: ${JSON.stringify(box)}`);
        }
        const bodyHeight = await form.locator(".overflow-y-auto").evaluate((element) => element.clientHeight);
        assert(bodyHeight >= 120, `Form body is only ${bodyHeight}px tall`);
      } finally { await f.close(); }
    }],
  ];
}

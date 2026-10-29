export function accessibilityReviewCases({ fixture, freshState, assert }) {
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

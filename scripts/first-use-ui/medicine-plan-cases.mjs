export function medicinePlanCases({ fixture, freshState, assert }) {
  async function open() {
    const state = freshState();
    state.care = {
      person: { member: state.me.email, name: "Sam", self: true, created_by: state.me.email },
      access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true },
      settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [],
    };
    const f = await fixture({ state, apiResponse: ({ route, req, url }) => {
      if (url.pathname === "/api/maple/care/entries") return route.fulfill({ json: { entries: [] } });
      if (url.pathname === "/api/maple/care/meds" && req.method() === "POST") {
        const plan = { ...req.postDataJSON(), id: 901, stopped_at: null, sort: 0, created_by: state.me.email, created_at: state.now, updated_at: state.now };
        state.care.plans = [plan];
        return route.fulfill({ status: 201, json: { plan } });
      }
      return route.fulfill({ status: 400, json: { error: "Unexpected synthetic medicine request" } });
    } });
    await f.page.goto("https://first-use.example.test/#care");
    await f.page.getByRole("button", { name: "Add a medicine", exact: true }).click();
    const form = f.page.getByRole("dialog", { name: "Add a medicine", exact: true });
    await form.getByLabel("Name", { exact: true }).fill("Synthetic medicine");
    return { f, form, saves: () => f.requests.filter((r) => r.pathname === "/api/maple/care/meds" && r.method === "POST") };
  }
  return [
    ["Medicine hours retain malformed input and reject it", async () => {
      const { f, form, saves } = await open();
      try {
        const hours = form.getByLabel("No sooner than every how many hours", { exact: true });
        for (const text of ["1/2", "-2", "1e1", "2mg", "1,2.5"]) {
          await hours.fill(text);
          assert.equal(await hours.inputValue(), text);
          await form.getByRole("button", { name: "Save", exact: true }).click();
          assert.equal(await hours.getAttribute("aria-invalid"), "true");
          assert.equal(saves().length, 0);
        }
        await hours.fill("0,5");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(saves()[0].body.schedule.min_gap_min, 30);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Medicine whole counts never turn decimals or fractions into integers", async () => {
      const { f, form, saves } = await open();
      try {
        await form.getByRole("button", { name: "Tablets", exact: true }).click();
        const limit = form.getByLabel("No more than how many in 24 hours", { exact: true });
        await limit.fill("1.5");
        assert.equal(await limit.inputValue(), "1.5");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        assert.equal(await limit.getAttribute("aria-invalid"), "true");
        assert.equal(saves().length, 0);
        await limit.fill("4");
        await form.getByRole("radio", { name: "Each day", exact: true }).click();
        const daily = form.getByLabel("How many times a day", { exact: true });
        await daily.fill("-2");
        assert.equal(await daily.inputValue(), "-2");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        assert.equal(await daily.getAttribute("aria-invalid"), "true");
        assert.equal(saves().length, 0);
        await daily.fill("2");
        await form.getByRole("radio", { name: "For a number of days", exact: true }).click();
        const days = form.getByLabel("For how many days", { exact: true });
        await days.fill("1/2");
        assert.equal(await days.inputValue(), "1/2");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        assert.equal(await days.getAttribute("aria-invalid"), "true");
        assert.equal(saves().length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Medicine liquid limits reject negative values and retain decimal quantities", async () => {
      const { f, form, saves } = await open();
      try {
        await form.getByRole("button", { name: "mL", exact: true }).click();
        const limit = form.getByLabel("No more than how many in 24 hours", { exact: true });
        await limit.fill("-1.5");
        assert.equal(await limit.inputValue(), "-1.5");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        assert.equal(await limit.getAttribute("aria-invalid"), "true");
        assert.equal(saves().length, 0);
        await limit.fill("1,5");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(saves()[0].body.max_24h, 1.5);
        assert.equal(saves()[0].body.limit_unit, "mL");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

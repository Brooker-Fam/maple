const STORAGE_ERROR = "Couldn't save on this phone. Keep this page open and try again.";

async function blockOutbox(page) {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    window.__blockOutbox = true;
    Storage.prototype.setItem = function (key, value) {
      if (window.__blockOutbox && key === "maple-outbox-v1") throw new DOMException("Synthetic storage quota", "QuotaExceededError");
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (window.__blockOutbox && key === "maple-outbox-v1") throw new DOMException("Synthetic blocked storage", "SecurityError");
      return remove.call(this, key);
    };
  });
}

export function storageCases({ assert, fixture, freshState }) {
  const careState = () => {
    const state = freshState();
    state.care = { person: { member: state.me.email, name: "Sam", self: true, created_by: state.me.email }, access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true }, settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [] };
    return state;
  };
  return [
    ["Storage failure retains a bottle draft without claiming a save", async () => {
      const f = await fixture({ entryResponse: ({ route }) => route.fulfill({ status: 503, json: { error: "Synthetic outage" } }) });
      try {
        await blockOutbox(f.page);
        await f.page.goto("https://logging-recovery.example.test/#today");
        await f.page.getByRole("button", { name: /^Bottle/ }).first().click();
        const form = f.page.getByRole("dialog").last();
        await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
        await form.getByRole("button", { name: /^Log/ }).click();
        await f.page.getByText(STORAGE_ERROR, { exact: true }).waitFor();
        assert(await form.isVisible());
        assert.equal(await form.getByRole("textbox", { name: "ounces", exact: true }).inputValue(), "2");
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 0);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.state.entries.length), 0);
        await f.page.evaluate(() => { window.__blockOutbox = false; });
        await form.getByRole("button", { name: /^Log/ }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem("maple-outbox-v1")).length), 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Storage failure retains a care question draft", async () => {
      const f = await fixture({ state: careState() });
      try {
        await blockOutbox(f.page);
        await f.page.route("**/api/maple/care/entries", (route) => route.fulfill({ status: 503, json: { error: "Synthetic outage" } }));
        await f.page.goto("https://logging-recovery.example.test/#care");
        const input = f.page.getByRole("textbox", { name: "A question for your OB", exact: true });
        await input.fill("Synthetic recovery question");
        await input.locator("..").getByRole("button", { name: "Add", exact: true }).click();
        await f.page.getByText(STORAGE_ERROR, { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "Synthetic recovery question");
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 0);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.state.care.entries.length), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Storage failure offers retry for an unsaved check-in", async () => {
      const f = await fixture({ state: careState() });
      try {
        await blockOutbox(f.page);
        await f.page.route("**/api/maple/care/mood", (route) => route.fulfill({ status: 503, json: { error: "Synthetic outage" } }));
        await f.page.goto("https://logging-recovery.example.test/#care");
        await f.page.getByRole("radio", { name: "Okay", exact: true }).click();
        await f.page.getByText(STORAGE_ERROR, { exact: true }).first().waitFor();
        await f.page.getByRole("button", { name: "Retry check-in", exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 0);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.state.care.mood.length), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Storage failure keeps a check-in correction unsaved and editable", async () => {
      const state = careState();
      state.care.mood = [{ id: 900, kind: "checkin", at: state.now, data: { level: 4 }, note: null, created_at: state.now, updated_at: state.now }];
      const f = await fixture({ state });
      try {
        await blockOutbox(f.page);
        await f.page.route("**/api/maple/care/mood?*", (route) => route.fulfill({ status: 503, json: { error: "Synthetic outage" } }));
        await f.page.goto("https://logging-recovery.example.test/#care");
        await f.page.getByRole("button", { name: "Anything else? (optional)", exact: true }).click();
        const note = f.page.locator("textarea");
        await note.fill("Synthetic check-in correction");
        await f.page.getByText("How are you doing?", { exact: true }).click();
        await f.page.getByText(STORAGE_ERROR, { exact: true }).waitFor();
        assert.equal(await note.inputValue(), "Synthetic check-in correction");
        await f.page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.equal(await f.page.evaluate(() => window.__loggingReview.state.care.mood[0].note), null);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Storage failure after sync retries the same entry without duplication", async () => {
      let available = false;
      const saved = new Map();
      const f = await fixture({ entryResponse: ({ route, req, state }) => {
        if (!available) return route.fulfill({ status: 503, json: { error: "Synthetic outage" } });
        const input = req.postDataJSON();
        if (!saved.has(input.client_id)) saved.set(input.client_id, { ...input, id: 900, active: false, ended_at: null, created_at: input.started_at, updated_at: input.started_at, created_by: state.me.email, updated_by: null, source: "web" });
        const entry = saved.get(input.client_id);
        state.entries = [entry];
        state.rev += "-saved";
        return route.fulfill({ json: { entry } });
      } });
      try {
        await blockOutbox(f.page);
        await f.page.goto("https://logging-recovery.example.test/#today");
        await f.page.evaluate(() => { window.__blockOutbox = false; });
        await f.page.getByRole("button", { name: /^Bottle/ }).first().click();
        const form = f.page.getByRole("dialog").last();
        await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
        await form.getByRole("button", { name: /^Log/ }).click();
        await form.waitFor({ state: "hidden" });
        available = true;
        await f.page.evaluate(() => { window.__blockOutbox = true; window.dispatchEvent(new Event("online")); });
        await f.page.getByText(STORAGE_ERROR, { exact: true }).waitFor();
        assert.equal(saved.size, 1);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 1);
        await f.page.evaluate(() => { window.__blockOutbox = false; window.dispatchEvent(new Event("online")); });
        await f.page.waitForFunction(() => window.__loggingReview.pending.length === 0);
        assert.equal(saved.size, 1);
        assert.equal(await f.page.evaluate(() => localStorage.getItem("maple-outbox-v1")), null);
        const posts = f.requests.filter((r) => r.method === "POST" && r.pathname === "/api/maple/entries");
        assert.equal(posts.length, 3);
        assert.equal(new Set(posts.map((r) => r.body.client_id)).size, 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Storage failure cannot change or remove a durably queued entry", async () => {
      const f = await fixture({ entryResponse: ({ route }) => route.fulfill({ status: 503, json: { error: "Synthetic outage" } }) });
      try {
        await blockOutbox(f.page);
        await f.page.goto("https://logging-recovery.example.test/#today");
        await f.page.evaluate(() => { window.__blockOutbox = false; });
        await f.page.getByRole("button", { name: /^Bottle/ }).first().click();
        const form = f.page.getByRole("dialog").last();
        await form.getByRole("textbox", { name: "ounces", exact: true }).fill("2");
        await form.getByRole("button", { name: /^Log/ }).click();
        await form.waitFor({ state: "hidden" });
        const result = await f.page.evaluate(async () => {
          const id = window.__loggingReview.pending[0].entry.id;
          const before = localStorage.getItem("maple-outbox-v1");
          window.__blockOutbox = true;
          const updated = await window.__loggingReview.update(id, { note: "Unsaved synthetic change" });
          const removed = await window.__loggingReview.remove(id);
          return { updated, removed, before, after: localStorage.getItem("maple-outbox-v1") };
        });
        assert.equal(result.updated, null);
        assert.equal(result.removed, false);
        assert.equal(result.before, result.after);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.pending.length), 1);
        assert.equal(await f.page.evaluate(() => window.__loggingReview.state.entries[0].note), null);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

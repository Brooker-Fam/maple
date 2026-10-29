export function timeCases({ fixture, freshState, record, writes, assert }) {
  const origin = "https://first-use.example.test";
  const created = (kind) => ({ route, req }) => route.fulfill({ json: { entry: record(99, kind, req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } });
  const stay = async (page, form) => {
    await form.getByRole("button", { name: "Close", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
    await discard.waitFor();
    await discard.getByRole("button", { name: "Keep editing", exact: true }).click();
    await discard.waitFor({ state: "hidden" });
  };
  return [
    ["Care temperature and Settings birth details protect incomplete time drafts", async () => {
      for (const kind of ["care", "birth"]) {
        const state = freshState();
        state.care = { person: { member: state.me.email, name: "Sam", self: true, created_by: state.me.email }, access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true }, settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [] };
        const f = await fixture({ state, apiResponse: ({ route, req, url }) => {
          if (url.pathname === "/api/maple/care/entries" && req.method() === "POST") return route.fulfill({ json: { entry: { ...req.postDataJSON(), id: 9001, updated_at: state.now }, notes: [] } });
          if (url.pathname === "/api/maple/baby" && req.method() === "PATCH") return route.fulfill({ json: { baby: { ...state.baby, ...req.postDataJSON() } } });
          return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
        } });
        try {
          await f.page.goto(`${origin}/#${kind === "care" ? "care" : "family/baby"}`);
          if (kind === "care") await f.page.getByRole("button", { name: "Temperature Add", exact: true }).click();
          else await f.page.getByRole("button", { name: "Edit", exact: true }).click();
          const form = f.page.getByRole("dialog", { name: kind === "care" ? "Your temperature" : "Birth details", exact: true });
          if (kind === "care") {
            await form.getByRole("textbox", { name: "temperature in degrees Fahrenheit", exact: true }).fill("98.6");
            await form.getByRole("button", { name: "Pick a time", exact: true }).click();
          }
          const clock = form.locator('input[type="time"]');
          await clock.fill("");
          assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
          await stay(f.page, form);
          assert.equal(await clock.inputValue(), "");
          assert.equal(f.requests.filter((request) => request.method === "PATCH" || request.method === "POST").length, 0);
          await form.getByRole("button", { name: "15 min ago", exact: true }).click();
          assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled());
          await form.getByRole("button", { name: "Save", exact: true }).click();
          await form.waitFor({ state: "hidden" });
          const saved = f.requests.filter((request) => request.method === "PATCH" || request.method === "POST");
          assert.equal(saved.length, 1, "Only the outer Save submits the recovered time");
          assert.equal(Math.floor(Date.parse(kind === "care" ? saved[0].body.at : saved[0].body.born_at) / 60_000), Date.parse("2026-10-28T13:15:00.000Z") / 60_000);
          assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
      }
    }],
    ["Exact diaper times keep the chosen date and reject a future clock", async () => {
      const f = await fixture({ entryResponse: created("diaper") });
      try {
        await f.page.goto(`${origin}/#today`);
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Diaper", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Diaper", exact: true });
        await form.getByRole("button", { name: "Pick a time", exact: true }).click();
        await form.getByLabel("When: exact time: time", { exact: true }).fill("10:00");
        assert.equal(await form.getByLabel("When: exact time: date", { exact: true }).inputValue(), "2026-10-28");
        assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled());
        assert.match(await form.getByRole("alert").textContent(), /earlier/i);
        assert.equal(writes(f).length, 0, "At 09:30, typing 10:00 cannot save yesterday");
        await stay(f.page, form);
        assert.equal(await form.getByLabel("When: exact time: time", { exact: true }).inputValue(), "10:00");
        await form.getByLabel("When: exact time: date", { exact: true }).fill("2026-10-27");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f).length, 1);
        assert.equal(writes(f)[0].body.started_at, "2026-10-27T14:00:00.000Z", "An explicit earlier date saves exactly that wall clock");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["An incomplete clock is an unsaved draft and a quick preset recovers it", async () => {
      const state = freshState();
      const original = record(54, "diaper", { pee: true, poop: false });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        await f.page.goto(`${origin}/#log`);
        await f.page.getByRole("button", { name: /^Edit: Wet diaper,/ }).click();
        const form = f.page.getByRole("dialog", { name: "Wet diaper", exact: true });
        await form.getByLabel("When: exact time: time", { exact: true }).fill("");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
        await stay(f.page, form);
        assert.equal(await form.getByLabel("When: exact time: time", { exact: true }).inputValue(), "");
        assert.equal(writes(f).length, 0);
        await form.getByRole("button", { name: "5 min ago", exact: true }).click();
        assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled());
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f).length, 1);
        assert.equal(Math.floor(Date.parse(writes(f)[0].body.started_at) / 60_000), Date.parse("2026-10-28T13:25:00.000Z") / 60_000);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Historical sleep rejects reversed times without changing the other endpoint", async () => {
      const state = freshState();
      const original = record(55, "sleep", {}, "2026-10-27T12:00:00.000Z", { ended_at: "2026-10-27T12:30:00.000Z" });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        await f.page.goto(`${origin}/#log`);
        await f.page.getByRole("button", { name: /^Edit: Slept,/ }).click();
        const form = f.page.getByRole("dialog", { name: "Slept", exact: true });
        const start = form.getByLabel("Fell asleep: time", { exact: true });
        const end = form.getByLabel("Woke up: time", { exact: true });
        await start.fill("09:00");
        assert.equal(await start.inputValue(), "09:00", "The entered clock remains visible for correction");
        assert.equal(await end.inputValue(), "08:30", "The end is not moved to accommodate an invalid start");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
        assert.equal(writes(f).length, 0);
        await stay(f.page, form);
        await form.getByRole("group", { name: "Duration", exact: true }).getByRole("button", { name: "30m", exact: true }).click();
        assert.equal(await start.inputValue(), "08:00", "Selecting the unchanged duration clears the invalid start");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isEnabled());
        await end.fill("07:30");
        assert.equal(await start.inputValue(), "08:00");
        assert(await form.getByRole("button", { name: "Save", exact: true }).isDisabled());
        await end.fill("08:45");
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0].body.started_at, undefined);
        assert.equal(writes(f)[0].body.ended_at, "2026-10-27T12:45:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["A nonexistent daylight-saving clock stays invalid instead of moving an hour", async () => {
      const state = freshState();
      state.now = "2026-03-08T08:30:00.000Z";
      state.baby.born_at = "2026-03-01T12:00:00.000Z";
      const f = await fixture({ state, entryResponse: created("diaper") });
      try {
        await f.page.goto(`${origin}/#today`);
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        await f.page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
        await f.page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: "Diaper", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Diaper", exact: true });
        await form.getByRole("button", { name: "Pick a time", exact: true }).click();
        const time = form.getByLabel("When: exact time: time", { exact: true });
        await time.fill("02:30");
        assert.equal(await time.inputValue(), "02:30");
        assert(await form.getByRole("button", { name: "Log it", exact: true }).isDisabled());
        assert.match(await form.getByRole("alert").textContent(), /doesn.t exist|clock/i);
        assert.equal(writes(f).length, 0);
        await time.fill("03:30");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f)[0].body.started_at, "2026-03-08T07:30:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Manual nursing sides block outer Save while either clock is incomplete", async () => {
      const state = freshState();
      const original = record(56, "feed", { method: "breast", first_side: "L", segments: [{ side: "L", start: "2026-10-28T12:00:00.000Z", end: "2026-10-28T12:10:00.000Z" }] }, "2026-10-28T12:00:00.000Z", { ended_at: "2026-10-28T12:10:00.000Z" });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        await f.page.goto(`${origin}/#log`);
        await f.page.getByRole("button", { name: /^Edit time: Nursed/ }).click();
        await f.page.getByRole("button", { name: "Edit feed details or add a side", exact: true }).click();
        const form = f.page.getByRole("dialog").last();
        await form.getByRole("button", { name: /^Add a side/ }).click();
        await form.getByRole("radio", { name: "Right", exact: true }).click();
        const save = form.getByRole("button", { name: /^Save(?: time)?$/ });
        assert(await save.isEnabled());
        const start = form.getByLabel("Started: time", { exact: true });
        const end = form.getByLabel("Ended: time", { exact: true });
        await start.fill("");
        await end.fill("");
        assert(await save.isDisabled());
        await start.fill("08:10");
        assert(await save.isDisabled(), "Fixing one clock does not hide the other invalid clock");
        assert.equal(writes(f).length, 0);
        await end.fill("08:15");
        await save.click();
        await form.waitFor({ state: "hidden" });
        assert.equal(writes(f).length, 1, "The outer Save writes the added side once");
        assert.equal(writes(f)[0].body.data.segments.at(-1).side, "R");
        assert.equal(writes(f)[0].body.data.segments.at(-1).start, "2026-10-28T12:10:00.000Z");
        assert.equal(writes(f)[0].body.data.segments.at(-1).end, "2026-10-28T12:15:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

export function doctorReviewCases({ fixture, freshState, record, writes, assert }) {
  const openDoctor = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: "More", exact: true }).click();
    await f.page.getByRole("button", { name: /^For the doctor/ }).click();
    const dialog = f.page.getByRole("dialog", { name: "For the doctor", exact: true });
    await dialog.waitFor();
    return dialog;
  };
  const unavailableClipboard = (page) => page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { get: () => undefined }));
  return [
    ...["Escape", "Growth chart"].map((action) => [`Doctor question pending saves prevent leaving through ${action}`, async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const f = await fixture({ entryResponse: async ({ route, req }) => {
        await gate;
        const body = req.postDataJSON();
        return route.fulfill({ json: { entry: record(994, body.kind, body.data, body.started_at, { note: body.note }) } });
      } });
      try {
        let confirmations = 0;
        f.page.on("dialog", (dialog) => { confirmations++; return dialog.accept(); });
        const dialog = await openDoctor(f);
        const input = dialog.getByRole("textbox", { name: "New question for the doctor" });
        await input.fill("Synthetic pending question");
        const submitted = f.page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/maple/entries");
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await submitted;
        if (action === "Escape") await f.page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: /^Growth chart/ }).click();
        await f.page.waitForTimeout(200);
        assert.equal(confirmations, 0);
        assert.equal(await f.page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true }).count(), 0);
        assert(await dialog.isVisible());
        assert.equal(await input.inputValue(), "Synthetic pending question");
        release();
        await dialog.getByText("Synthetic pending question", { exact: true }).waitFor();
        await f.page.waitForFunction(() => {
          const field = document.querySelector('input[aria-label="New question for the doctor"]');
          return field && !field.disabled && field.value === "";
        });
        await input.fill("Synthetic next question");
        assert.equal(await input.inputValue(), "Synthetic next question");
        assert.equal(writes(f).length, 1);
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.close(); }
    }]),
    ["Doctor question rejected saves retain the draft and prevent duplicate submissions", async () => {
      let release;
      let reject = true;
      const gate = new Promise((resolve) => { release = resolve; });
      const f = await fixture({ entryResponse: async ({ route, req }) => {
        if (reject) {
          await gate;
          return route.fulfill({ status: 400, json: { error: "Synthetic question rejection" } });
        }
        const body = req.postDataJSON();
        return route.fulfill({ json: { entry: record(991, body.kind, body.data, body.started_at, { note: body.note }) } });
      } });
      try {
        const dialog = await openDoctor(f);
        const input = dialog.getByRole("textbox", { name: "New question for the doctor" });
        await input.fill("Synthetic question to preserve");
        const submitted = f.page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/maple/entries");
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await submitted;
        assert.equal(await input.isDisabled(), true);
        assert.equal(await input.inputValue(), "Synthetic question to preserve");
        release();
        await f.page.getByText("Synthetic question rejection", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "Synthetic question to preserve");
        assert.equal(await input.isDisabled(), false);
        reject = false;
        await dialog.getByRole("button", { name: "Add", exact: true }).click();
        await dialog.getByText("Synthetic question to preserve", { exact: true }).waitFor();
        assert.equal(await input.inputValue(), "");
        assert.equal(writes(f).length, 2);
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.close(); }
    }],
    ["Doctor question history failures remain visible and can be retried", async () => {
      const f = await fixture();
      let failed = true;
      try {
        await f.page.route("**/api/maple/entries?kind=note*", (route) => failed
          ? route.fulfill({ status: 503, json: { error: "Synthetic question history failure" } })
          : route.fulfill({ json: { entries: [record(992, "note", { for_doctor: true }, "2026-10-01T13:00:00.000Z", { note: "Synthetic older question" })], truncated: false } }));
        const dialog = await openDoctor(f);
        await dialog.getByRole("alert").filter({ hasText: "Couldn't load all questions" }).waitFor();
        assert.equal(await dialog.getByText("No questions yet.", { exact: true }).count(), 0);
        failed = false;
        await dialog.getByRole("button", { name: "Retry questions", exact: true }).click();
        await dialog.getByText("Synthetic older question", { exact: true }).waitFor();
        assert.equal(await dialog.getByRole("alert").count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Doctor summaries stop on unavailable question history and recover on retry", async () => {
      const state = freshState();
      state.entries = [record(993, "note", { for_doctor: true }, undefined, { note: "Synthetic current question" })];
      const f = await fixture({ state, records: state.entries });
      let failed = true;
      try {
        await unavailableClipboard(f.page);
        await f.page.route("**/api/maple/entries?kind=note*", (route) => failed
          ? route.fulfill({ status: 503, json: { error: "Synthetic question history failure" } })
          : route.fulfill({ json: { entries: state.entries, truncated: false } }));
        const dialog = await openDoctor(f);
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "Summary not copied" }).waitFor();
        assert.equal(await dialog.locator("textarea[readonly]").count(), 0);
        failed = false;
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        const summary = dialog.getByRole("textbox", { name: "Visit summary", exact: true });
        await summary.waitFor();
        assert.match(await summary.inputValue(), /Synthetic current question/);
        assert.equal(await dialog.getByRole("alert").filter({ hasText: "Summary not copied" }).count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Doctor summaries refuse known incomplete daily history", async () => {
      const f = await fixture({ rangeResponse: ({ route }) => route.fulfill({ json: { entries: [], truncated: true } }) });
      try {
        await unavailableClipboard(f.page);
        const dialog = await openDoctor(f);
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "Summary not copied" }).waitFor();
        assert.equal(await dialog.locator("textarea[readonly]").count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Doctor questions and summaries disclose truncated question history", async () => {
      const f = await fixture();
      try {
        await unavailableClipboard(f.page);
        await f.page.route("**/api/maple/entries?kind=note*", (route) => route.fulfill({ json: { entries: [], truncated: true } }));
        const dialog = await openDoctor(f);
        await dialog.getByRole("alert").filter({ hasText: "Couldn't load all questions" }).waitFor();
        assert.equal(await dialog.getByText("No questions yet.", { exact: true }).count(), 0);
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "Summary not copied" }).waitFor();
        assert.equal(await dialog.locator("textarea[readonly]").count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Doctor summary manual copying has an accessible name and selects all text", async () => {
      const f = await fixture();
      try {
        await unavailableClipboard(f.page);
        const dialog = await openDoctor(f);
        await dialog.getByRole("button", { name: "Copy summary", exact: true }).click();
        const summary = dialog.getByRole("textbox", { name: "Visit summary", exact: true });
        await summary.waitFor();
        const value = await summary.inputValue();
        assert.match(value, /Counts only include what we wrote down/);
        assert.equal(await summary.evaluate((element) => element.selectionEnd - element.selectionStart), value.length);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

/**
 * Today's diaper warnings (AlertCard.tsx), on a synthetic family that logs every bottle and no diaper (Day 28: "0 wet
 * diapers" and "0 poops in the last 24 hours", both call-today warnings). Beside We called, each offers Not all logged:
 * it marks that one handled for the whole family with nothing noted in the log (an ack of its episode, no entry saved),
 * and its toast offers Turn off diaper warnings for everyone (settings.diaper_alerts false, which hides the other one
 * too; its Undo puts the default back). A save that fails brings the card back with the reason; a reading (red in the
 * diaper) never offers it; a viewer sees neither button. Settings → On Today has the switches under Warnings & reminders.
 */
export function alertCases({ fixture, freshState, record, writes, assert, settle }) {
  const origin = "https://first-use.example.test";
  const H = 3600_000;
  const WET = "0 wet diapers in the last 24 hours";
  const POOP = "0 poops in the last 24 hours";

  /** Every bottle logged since yesterday morning, every 2.5 hours, and no diaper: warnings on. */
  const warned = (extra = []) => {
    const state = freshState();
    const now = Date.parse(state.now);
    const bottles = [];
    for (let h = 1, id = 300; h <= 30; h += 2.5, id++) bottles.push(record(id, "feed", { method: "bottle", amount_ml: 90, milk: "formula" }, new Date(now - h * H).toISOString()));
    state.entries = [...bottles, ...extra];
    state.baby.settings = { show_alerts: true };
    return state;
  };

  /**
   * PATCH /api/maple/baby as the server answers it: the settings merged (null removes a key), acks added to what's
   * there, the state's rev moved so the next read brings it. `fail(n)` refuses the nth PATCH.
   */
  const babyRoute = (state, patches, fail = () => false) => ({ route, req, url }) => {
    if (url.pathname !== "/api/maple/baby" || req.method() !== "PATCH") return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
    const body = req.postDataJSON();
    patches.push(body);
    if (fail(patches.length)) return route.fulfill({ status: 503, json: { error: "Maple couldn't save that. Try again." } });
    const { acks, ...rest } = body.settings ?? {};
    const settings = { ...state.baby.settings, ...rest, ...(acks ? { acks: { ...state.baby.settings.acks, ...acks } } : {}) };
    for (const [k, v] of Object.entries(rest)) if (v === null) delete settings[k];
    state.baby = { ...state.baby, settings };
    state.rev = `example-${patches.length + 1}`;
    return route.fulfill({ json: { baby: state.baby } });
  };

  const card = (f, title) => f.page.getByRole("alert").filter({ has: f.page.getByRole("heading", { name: title, exact: true }) });
  const toasts = (f) => f.page.locator("[data-maple-toasts]");
  const waitFor = async (cond, what) => {
    for (let i = 0; i < 40 && !cond(); i++) await new Promise((r) => setTimeout(r, 100));
    assert(cond(), what);
  };

  return [
    ["Diaper warnings: Not all logged hides that one for everyone with nothing noted, and its toast turns diaper warnings off (Undo turns them back on)", async () => {
      const state = warned();
      const patches = [];
      const f = await fixture({ state, apiResponse: babyRoute(state, patches) });
      try {
        await f.page.goto(`${origin}/#today`);
        const wet = card(f, WET);
        await wet.waitFor();
        await card(f, POOP).waitFor();
        // Who to call first, We called, and Not all logged on each.
        for (const c of [wet, card(f, POOP)]) {
          await c.getByText("Call your pediatrician today", { exact: true }).waitFor();
          assert.equal(await c.getByRole("button", { name: "We called", exact: true }).count(), 1);
          assert.equal(await c.getByRole("button", { name: "Not all logged", exact: true }).count(), 1);
        }

        await wet.getByRole("button", { name: "Not all logged", exact: true }).click();
        await wet.waitFor({ state: "detached" });
        await waitFor(() => patches.length === 1, "one save");
        // Just that episode's mark: no note, no "Called the pediatrician", nothing else changed.
        assert.deepEqual(Object.keys(patches[0]), ["settings"]);
        assert.deepEqual(Object.keys(patches[0].settings), ["acks"]);
        assert.deepEqual(Object.keys(patches[0].settings.acks), ["low-wet:28"]);
        assert(!Number.isNaN(Date.parse(patches[0].settings.acks["low-wet:28"])), "the mark is a time");
        assert.equal(writes(f).length, 0, "nothing logged");
        const hidden = toasts(f).getByText("Hidden for everyone. Not logging every diaper?", { exact: true });
        await hidden.waitFor();
        // The other count is still up: only that one was answered.
        await card(f, POOP).waitFor();

        await settle(f);
        await toasts(f).getByRole("button", { name: "Turn off diaper warnings", exact: true }).click();
        await waitFor(() => patches.length === 2, "the switch saved");
        assert.deepEqual(patches[1], { settings: { diaper_alerts: false } });
        await toasts(f).getByText("Diaper warnings are off for everyone. Settings → On Today turns them back on.", { exact: true }).waitFor();
        // Off for the family: the other diaper count goes too, once the state comes back.
        await card(f, POOP).waitFor({ state: "detached" });

        await settle(f);
        await toasts(f).getByRole("button", { name: "Undo", exact: true }).click();
        await waitFor(() => patches.length === 3, "Undo saved");
        assert.deepEqual(patches[2], { settings: { diaper_alerts: null } });
        await toasts(f).getByText("Diaper warnings are back on", { exact: true }).waitFor();
        // Back on: the poop count returns; the wet one stays answered.
        await card(f, POOP).waitFor();
        assert.equal(await card(f, WET).count(), 0);
        assert.equal(writes(f).length, 0, "still nothing logged");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],

    ["Diaper warnings: Not all logged that doesn't save brings the card back with the reason", async () => {
      const state = warned();
      const patches = [];
      const f = await fixture({ state, apiResponse: babyRoute(state, patches, (n) => n === 1) });
      try {
        await f.page.goto(`${origin}/#today`);
        const wet = card(f, WET);
        await wet.waitFor();
        await wet.getByRole("button", { name: "Not all logged", exact: true }).click();
        await toasts(f).getByText("Maple couldn't save that. Try again.", { exact: true }).waitFor();
        await wet.waitFor();
        assert.equal(await toasts(f).getByText("Hidden for everyone. Not logging every diaper?", { exact: true }).count(), 0, "no Hidden toast");
        // Tried again, it saves.
        await settle(f);
        await wet.getByRole("button", { name: "Not all logged", exact: true }).click();
        await wet.waitFor({ state: "detached" });
        await waitFor(() => patches.length === 2, "the second try");
        assert.deepEqual(Object.keys(patches[1].settings.acks), ["low-wet:28"]);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],

    ["Diaper warnings: red in the diaper is a reading (We called only), and a viewer gets neither button", async () => {
      const state = warned();
      // Red in this morning's diaper: its own call-today card, and now one poop in the last 24 hours.
      state.entries.push(record(380, "diaper", { pee: false, poop: true, color: "red" }, new Date(Date.parse(state.now) - 2 * H).toISOString()));
      const f = await fixture({ state, apiResponse: babyRoute(state, []) });
      try {
        await f.page.goto(`${origin}/#today`);
        const red = card(f, "Red in the diaper: call your pediatrician today");
        await red.waitFor();
        assert.equal(await red.getByRole("button", { name: "We called", exact: true }).count(), 1);
        assert.equal(await red.getByRole("button", { name: "Not all logged", exact: true }).count(), 0, "a color is checked as it's entered");
        await card(f, "1 poop in the last 24 hours").getByRole("button", { name: "Not all logged", exact: true }).waitFor();
      } finally { await f.close(); }

      const viewing = warned();
      viewing.me = { ...viewing.me, role: "viewer" };
      viewing.members = [viewing.me];
      const v = await fixture({ state: viewing, apiResponse: babyRoute(viewing, []) });
      try {
        await v.page.goto(`${origin}/#today`);
        const wet = card(v, WET);
        await wet.waitFor();
        assert.equal(await wet.getByRole("button", { name: "Not all logged", exact: true }).count(), 0);
        assert.equal(await wet.getByRole("button", { name: "We called", exact: true }).count(), 0);
        assert.deepEqual(v.errors, []);
      } finally { await v.close(); }
    }],

    ["Settings → On Today: Feed reminders and Diaper warnings are their own switches under Warnings & reminders, on by default (and the feed interval goes with feed reminders)", async () => {
      const state = warned();
      const patches = [];
      const f = await fixture({ state, apiResponse: babyRoute(state, patches) });
      try {
        await f.page.goto(`${origin}/#family/today`);
        const feeds = f.page.getByRole("switch", { name: "Feed reminders", exact: true });
        const diapers = f.page.getByRole("switch", { name: "Diaper warnings", exact: true });
        await diapers.waitFor();
        assert.equal(await feeds.getAttribute("aria-checked"), "true");
        assert.equal(await diapers.getAttribute("aria-checked"), "true");
        await f.page.getByText("When fewer wet or dirty diapers are logged than usual for River's age. Turn off if you don't log every change.", { exact: true }).waitFor();
        await diapers.click();
        await waitFor(() => patches.length === 1, "saved");
        assert.deepEqual(patches[0], { settings: { diaper_alerts: false } });
        assert.equal(await diapers.getAttribute("aria-checked"), "false");
        // With Warnings & reminders off, there's nothing for them to tune: they're not shown.
        await settle(f);
        await f.page.getByRole("switch", { name: "Warnings & reminders", exact: true }).click();
        await waitFor(() => patches.length === 2, "warnings off saved");
        assert.deepEqual(patches[1], { settings: { show_alerts: false } });
        await diapers.waitFor({ state: "detached" });
        assert.equal(await feeds.count(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }

      // Doctor & care plan's "Feed every … hours" only times the feed reminders, so it goes when they're off.
      const field = (p) => p.getByRole("textbox", { name: /^Feed every … hours/ });
      for (const [feedAlerts, shown] of [[undefined, 1], [false, 0]]) {
        const s = warned();
        if (feedAlerts !== undefined) s.baby.settings.feed_alerts = feedAlerts;
        const d = await fixture({ state: s, apiResponse: babyRoute(s, []) });
        try {
          await d.page.goto(`${origin}/#family/doctor`);
          await d.page.getByRole("textbox", { name: /^Weeks at birth/ }).waitFor();
          assert.equal(await field(d.page).count(), shown, `feed reminders ${feedAlerts === false ? "off" : "on"}`);
          assert.deepEqual(d.errors, []);
        } finally { await d.close(); }
      }
    }],
  ];
}

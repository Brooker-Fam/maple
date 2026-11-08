/**
 * Today's Next feed card (src/components/maple/feeding/NextFeedCard.tsx): the family's feeding plan read against the
 * log, so the next feed, when it's due and its steps are on Today with one big action. An invented plan, never any
 * family's: by day every 2.5 to 3.5 hours, taking turns between "Nurse + SNS" (12–18 min, 20 ml of formula in the SNS,
 * then pump 15 min) and "Nurse, top up" (8–12 min each side, then a 25–35 ml paced top-up); at night (11 PM–5 AM)
 * every 3 hours, waking, "Pump + bottle"; a target of 50–70 ml from a "Feeding clinic". Times are wall clock in the
 * family's zone (America/New_York, EDT in late October) on the fixture's clock (9:30 AM on Oct 28).
 */
export function feedingPlanCases({ fixture, freshState, record, writes, assert }) {
  /** "08:15" on Oct `day` (EDT, UTC-4) as an ISO instant. */
  const at = (day, hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2026, 9, day, h + 4, m)).toISOString();
  };
  const PLAN = {
    v: 1,
    from: "Feeding clinic",
    check_in: "2026-10-30",
    unit: "ml",
    day: { every: { min: 150, max: 210 } },
    night: { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: "p1f3" },
    feeds: [
      { id: "p1f1", name: "Nurse + SNS", steps: [{ do: "nurse", minutes: { min: 12, max: 18 }, supplement: { via: "sns", ml: { min: 20, max: 20 }, milk: "formula" } }, { do: "pump", minutes: { min: 15, max: 15 } }] },
      { id: "p1f2", name: "Nurse, top up", steps: [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced" }] },
      { id: "p1f3", name: "Pump + bottle", steps: [{ do: "pump", minutes: { min: 20, max: 20 } }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
    ],
    order: ["p1f1", "p1f2"],
    rev: 1,
    updated_at: "2026-10-27T12:00:00.000Z",
  };
  const planned = ({ plan = PLAN, now, entries = [], role } = {}) => {
    const state = freshState();
    state.baby.settings = { show_alerts: false, feeding_plan: plan, feed_target_ml: { min: 50, max: 70 } };
    if (now) state.now = now;
    if (role) {
      state.me = { ...state.me, role };
      state.members = [state.me];
    }
    state.entries = [...entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
    return state;
  };
  /** Nursing on Oct `day`: [["L", "08:00", "08:15"], ...]; a null end is still on the breast. */
  const nursing = (id, day, parts, extra = {}) => {
    const segments = parts.map(([side, a, b]) => ({ side, start: at(day, a), end: b ? at(day, b) : null }));
    const running = segments.at(-1).end === null;
    return record(id, "feed", { method: "breast", segments, first_side: parts[0][0], last_side: parts.at(-1)[0], ...extra }, segments[0].start, {
      ended_at: running ? null : segments.at(-1).end,
      active: running,
      updated_at: segments.at(-1).end ?? segments.at(-1).start,
    });
  };
  const bottle = (id, day, hhmm, ml, extra = {}) => record(id, "feed", { method: "bottle", amount_ml: ml, ...extra }, at(day, hhmm));
  const pump = (id, day, a, b) => record(id, "pump", {}, at(day, a), { ended_at: b ? at(day, b) : null, active: !b });
  /** 8:00 AM: Nurse + SNS, started from the plan (tagged), with its SNS milk and its pump. */
  const morning = () => [nursing(41, 28, [["L", "08:00", "08:15"]], { plan: "p1f1" }), bottle(42, 28, "08:14", 20, { via: "sns", milk: "formula", plan: "p1f1" }), pump(43, 28, "08:20", "08:35")];

  const card = (f) => f.page.locator("[data-next-feed]");
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  const today = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await card(f).waitFor();
    return card(f);
  };
  /** The server's side of a timer start and an entry save: each answer joins the state the next poll reads. */
  const server = () => {
    const timer = [];
    let id = 70;
    return {
      timer,
      apiResponse: ({ route, req, url, state }) => {
        if (url.pathname !== "/api/maple/timer" || req.method() !== "POST") return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
        const body = req.postDataJSON();
        timer.push(body);
        // Started now on the fixture's clock (the app's clock is the state's `now`, not the machine's).
        const start = state.now;
        const entry =
          body.kind === "feed"
            ? record(++id, "feed", { method: "breast", segments: [{ side: body.side, start, end: null }], first_side: body.side, last_side: body.side, ...(body.with ?? {}) }, start, { active: true })
            : record(++id, body.kind, {}, start, { active: true });
        state.entries = [entry, ...state.entries];
        state.rev = `plan-timer-${timer.length}`;
        return route.fulfill({ json: { entry, alreadyRunning: false } });
      },
      entryResponse: ({ route, req, state }) => {
        const body = req.postDataJSON();
        const entry = record(++id, body.kind, body.data, body.started_at, { note: body.note ?? null });
        state.entries = [entry, ...state.entries].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
        state.rev = `plan-entry-${id}`;
        return route.fulfill({ json: { entry } });
      },
    };
  };
  /** Text as a phone shows it, its narrow and no-break spaces plain. */
  const plain = (t) => t.replace(/[\u202f\u00a0]/g, " ");
  const dock = (f) => f.page.getByRole("region", { name: "Log something", exact: true });
  /** The evening before the night: Nurse + SNS at 8:30 PM from the plan, its SNS milk, its pump. */
  const evening = () => [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05")];
  /** The night's first feed: pumped 11:20–11:40 PM, then 55 ml of pumped milk at 11:45, from the plan. */
  const firstNight = () => [...evening(), pump(74, 28, "23:20", "23:40"), bottle(75, 28, "23:45", 55, { milk: "breastmilk", plan: "p1f3" })];
  const waitFor = async (f, fn, what) => {
    for (let i = 0; i < 40; i++) {
      if (fn()) return;
      await f.page.waitForTimeout(50);
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  return [
    ["Feeding plan: before any feed, the card shows the plan's first feed and its start carries the shield and the plan's feed", async () => {
      // This plan's first feed nurses with a nipple shield.
      const plan = structuredClone(PLAN);
      plan.feeds[0].steps[0].shield = true;
      const s = server();
      const f = await fixture({ state: planned({ plan }), apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse + SNS");
        const text = await c.textContent();
        assert.match(text, /^Next feed/);
        // The first step in full, the rest after it on one line.
        assert.match(text, /Nurse 12–18 min with the nipple shield, 20 ml of formula in the SNS\. Then pump 15 min/);
        // One faint line: who the plan is from and the check-in (the target is in the plan's sheet).
        assert.match(text, /Plan from Feeding clinic · Check-in Fri, Oct 30/);
        assert.doesNotMatch(text, /Due|Next feed \d/, "nothing is due before the first feed");
        // One big action: Start Left (no side suggested yet), Right beside it.
        await c.getByRole("button", { name: "Start Left, with the nipple shield: Nurse + SNS", exact: true }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual({ ...s.timer[0], client_id: undefined }, { action: "start", kind: "feed", side: "L", with: { shield: true, plan: "p1f1" }, client_id: undefined });
        assert.equal(typeof s.timer[0].client_id, "string");
        // The feed is going: the card follows it, and its next step is the milk at the breast.
        await c.getByText("Nursing now", { exact: false }).waitFor();
        assert.match(await c.textContent(), /^Now/);
        assert(await c.getByRole("button", { name: /^Log 20 ml in the SNS/ }).isVisible(), "the SNS milk is the next step's action");
        assert.equal(s.timer.length, 1);
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: after a feed started from the plan, the other feed is next, with when it's due", async () => {
      const s = server();
      const f = await fixture({ state: planned({ entries: morning() }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse, top up");
        const text = (await c.textContent()).replace(/[  ]/g, " ");
        assert.match(text, /10:30 AM–11:30 AM, in 1h 00m · 2\.5–3\.5 h after the 8:00 AM feed/, "due 2.5–3.5 hours from the 8 AM start, saying so");
        assert.match(text, /Nurse 8–12 min each side/);
        assert.match(text, /Then top up 25–35 ml, formula or breast milk, paced bottle/);
        // The side the dock suggests: she started on the Left last time.
        await c.getByRole("button", { name: "Start Right: Nurse, top up", exact: true }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.equal(s.timer[0].side, "R");
        assert.deepEqual(s.timer[0].with, { plan: "p1f2" }, "no shield on this feed");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: Other feed picks another feed on this phone until a feed starts, with the way back, and the dock's start follows it", async () => {
      const s = server();
      const f = await fixture({ state: planned({ entries: morning() }), apiResponse: s.apiResponse });
      /** Open the card's Other feed (it holds Today's taps for a moment as it opens). */
      const other = async () => {
        await card(f).getByRole("button", { name: "Other feed", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
      };
      try {
        await metric(f);
        const c = await today(f);
        // One quiet line, not a link per feed.
        assert.equal(await c.getByRole("button", { name: /instead$/ }).count(), 0, "the other feeds wait behind Other feed");
        await other();
        await c.getByRole("button", { name: "Do Nurse + SNS instead", exact: true }).click();
        await c.getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        assert.match(await c.textContent(), /Picked on this phone, not the plan's turn/);
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await other();
        assert(await c.getByRole("button", { name: "Back to Nurse, top up", exact: true }).isVisible());
        assert.equal(await c.getByRole("button", { name: "Do Nurse, top up instead", exact: true }).count(), 0, "the plan's turn is Back to, not another pick");
        // The pick stays on this phone across a reload.
        await f.page.reload();
        await card(f).getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        // Back to the plan's turn, then the pick again, and its start names the picked feed.
        await other();
        await card(f).getByRole("button", { name: "Back to Nurse, top up", exact: true }).click();
        await card(f).getByRole("heading", { name: "Nurse, top up", exact: true }).waitFor();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await other();
        await card(f).getByRole("button", { name: "Do Nurse + SNS instead", exact: true }).click();
        await card(f).getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        // The dock's Left is the same start as the card's: the picked feed, the side it suggests outlined.
        const dock = f.page.getByRole("region", { name: "Log something", exact: true });
        assert.equal(await dock.getByRole("button", { name: /^Start nursing timer on Right \(next side\)/ }).count(), 1);
        await dock.getByRole("button", { name: /^Start nursing timer on Left/ }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual({ ...s.timer[0], client_id: undefined }, { action: "start", kind: "feed", side: "L", with: { plan: "p1f1" }, client_id: undefined });
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: during an SNS feed, one tap logs its milk at the breast as part of the feed, once", async () => {
      const s = server();
      // On the Right since 9:22 AM, started from the plan as Nurse + SNS.
      const on = nursing(51, 28, [["R", "09:22", null]], { plan: "p1f1" });
      const f = await fixture({ state: planned({ entries: [on] }), apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        const text = await c.textContent();
        assert.match(text, /^Now/);
        assert.match(text, /Nursing now · 8m/);
        assert.match(text, /Then: Nurse, top up/);
        const log = c.getByRole("button", { name: "Log 20 ml in the SNS, formula", exact: true });
        // A double tap logs it once.
        await log.dblclick();
        await waitFor(f, () => writes(f).length > 0, "the SNS milk");
        await f.page.waitForTimeout(400);
        assert.equal(writes(f).length, 1, "a double tap logs once");
        const saved = writes(f)[0].body;
        assert.equal(saved.kind, "feed");
        assert.deepEqual(saved.data, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: "p1f1", top_up_of: 51 });
        assert.equal(typeof saved.client_id, "string");
        // Logged: the step says so, and the pump waits until she's off the breast.
        await c.getByText("Nursing now · 8m · 20 ml in the SNS", { exact: false }).waitFor();
        assert.equal(await c.getByRole("button", { name: /^Log 20 ml/ }).count(), 0);
        assert.equal(await c.getByRole("button", { name: "Start pumping", exact: true }).count(), 0, "she's still on: the pump waits");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: a finished feed's top-up nobody logged gets one line; Log top-up names that feed, and Got it sets it aside", async () => {
      const s = server();
      // 10:40–11:00 AM, Nurse, top up from the plan; no top-up. It's 12:20 PM.
      const fed = nursing(61, 28, [["R", "10:40", "10:50"], ["L", "10:50", "11:00"]], { plan: "p1f2" });
      const state = planned({ now: at(28, "12:20"), entries: [...morning(), fed] });
      const f = await fixture({ state, apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse + SNS", "the next feed is still the plan's turn");
        const missed = c.getByRole("group", { name: "Not logged", exact: true });
        assert.match((await missed.textContent()).replace(/[  ]/g, " "), /10:40 AM feed: top-up not logged/);
        // One row: its fixes wait behind Fix.
        assert.equal(await missed.getByRole("button").count(), 1);
        await missed.getByRole("button", { name: "Fix", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await missed.getByRole("button", { name: /^Log top-up/ }).click();
        // The form says what it is: that feed's top-up, its quick amounts the plan's range.
        const form = f.page.getByRole("dialog", { name: /^Top-up · 10:40\sAM feed$/ });
        await form.waitFor();
        assert.match(await form.textContent(), /Part of that feed, not a feed of its own\./);
        assert.equal(await form.getByRole("radiogroup", { name: "Feed type" }).count(), 0, "no Breast or Bottle to choose");
        assert.deepEqual(await form.getByRole("button", { name: /^\d+ ml$/ }).allTextContents(), ["25 ml", "30 ml", "35 ml"]);
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "25", "the plan's amount, the smaller of its range");
        await form.getByRole("button", { name: /^Log 25 ml/ }).click();
        await form.waitFor({ state: "hidden" });
        await waitFor(f, () => writes(f).length > 0, "the top-up");
        // The plan says formula or breast milk, so the milk is the family's to say: never the last bottle's.
        const { method, amount_ml, via, top_up_of, plan, milk } = writes(f)[0].body.data;
        assert.deepEqual({ method, amount_ml, via, top_up_of, plan, milk }, { method: "bottle", amount_ml: 25, via: "paced", top_up_of: 61, plan: "p1f2", milk: undefined });
        await missed.waitFor({ state: "hidden" });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Got it: gone on this phone, after a reload too, and nothing is logged.
      const g = await fixture({ state: planned({ now: at(28, "12:20"), entries: [...morning(), nursing(61, 28, [["R", "10:40", "10:50"], ["L", "10:50", "11:00"]], { plan: "p1f2" })] }) });
      try {
        await metric(g);
        const c = await today(g);
        await c.getByRole("group", { name: "Not logged", exact: true }).getByRole("button", { name: "Fix", exact: true }).click();
        await g.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("group", { name: "Not logged", exact: true }).getByRole("button", { name: /^Got it/ }).click();
        await c.getByRole("group", { name: "Not logged", exact: true }).waitFor({ state: "hidden" });
        await g.page.reload();
        await card(g).waitFor();
        assert.equal(await card(g).getByRole("group", { name: "Not logged", exact: true }).count(), 0);
        assert.equal(writes(g).length, 0);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: an SNS feed's milk nobody logged is one tap afterwards, at the end of its nursing, as part of that feed", async () => {
      const s = server();
      // 10:40–11:00 AM, Nurse + SNS from the plan, its pump logged, its SNS milk not. It's 12:20 PM.
      const entries = [nursing(81, 28, [["L", "07:40", "08:00"]], { plan: "p1f2" }), bottle(82, 28, "08:05", 30, { via: "paced" }), nursing(83, 28, [["R", "10:40", "11:00"]], { plan: "p1f1" }), pump(84, 28, "11:05", "11:20")];
      const f = await fixture({ state: planned({ now: at(28, "12:20"), entries }), apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        const missed = c.getByRole("group", { name: "Not logged", exact: true });
        assert.match((await missed.textContent()).replace(/[  ]/g, " "), /10:40 AM feed: milk in the SNS not logged/);
        await missed.getByRole("button", { name: "Fix", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await missed.getByRole("button", { name: "Log 20 ml in the SNS, formula", exact: true }).click();
        await waitFor(f, () => writes(f).length > 0, "the SNS milk");
        const saved = writes(f)[0].body;
        assert.equal(saved.started_at, at(28, "11:00"), "given at the breast: logged at the end of that nursing, not now");
        assert.deepEqual(saved.data, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: "p1f1", top_up_of: 83 });
        await missed.waitFor({ state: "hidden" });
        assert.equal(writes(f).length, 1);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: a night feed starts with the pump, its bottle a quiet second action for whoever gives it, then its bottle is next", async () => {
      const s = server();
      const evening = [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05")];
      const f = await fixture({ state: planned({ now: at(28, "23:10"), entries: evening }), apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Pump + bottle");
        const text = (await c.textContent()).replace(/[  ]/g, " ");
        assert.match(text, /^Night feed/);
        // No sex set: the baby's name stands in for the pronoun.
        assert.match(text, /Wake River for it at 11:30 PM, in 20m/);
        assert.match(text, /Burp halfway/);
        // One parent pumps while the other gives the bottle: either can start. The bottle is a quiet link under Start
        // pumping, and the dock's Bottle opens the same form, saying whose bottle it is (not the next step).
        const start = c.getByRole("button", { name: "Start pumping", exact: true });
        const quiet = c.getByRole("button", { name: /^Log bottle: up to 50–70 ml in all/ });
        const [startBox, quietBox] = await Promise.all([start.boundingBox(), quiet.boundingBox()]);
        assert(startBox && quietBox && quietBox.y >= startBox.y + startBox.height - 1, "Log bottle sits under Start pumping");
        assert.equal(await c.locator("[data-plan-primary]").getByRole("button").count(), 1, "one big button");
        const tile = f.page.getByRole("region", { name: "Log something", exact: true }).getByRole("button", { name: /^Bottle: Log bottle/ });
        assert.equal((await tile.textContent()).replace(/[  ]/g, " "), "BottleNight feed");
        assert.doesNotMatch(await tile.getAttribute("aria-label"), /next step/);
        await quiet.click();
        const bottleForm = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await bottleForm.waitFor();
        assert.equal(await bottleForm.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "", "how much was pumped is the family's to say");
        assert.equal(await bottleForm.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Breast milk", exact: true }).getAttribute("aria-pressed"), "true", "pumped milk first");
        assert.match((await bottleForm.textContent()).replace(/[  ]/g, " "), /Target from your care team: 50–70 ml a feed/);
        await bottleForm.getByRole("button", { name: "Close", exact: true }).click();
        await bottleForm.waitFor({ state: "hidden" });
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await start.click();
        // The start moves the page under the thumb (its timer card comes in above): Today's taps wait out the cooldown.
        assert.equal(await f.page.locator("[data-today-page][data-taps-held]").count(), 1, "the start holds Today's taps for a moment");
        await waitFor(f, () => s.timer.length > 0, "the pump start");
        assert.deepEqual({ ...s.timer[0], client_id: undefined }, { action: "start", kind: "pump", client_id: undefined });
        await c.getByText("Pumping now", { exact: false }).waitFor();
        // While the pump runs before any bottle, the next feed counts from the pump, and says so.
        assert.match((await c.textContent()).replace(/[  ]/g, " "), /Then the night feed: Pump \+ bottle.*Wake River for it at 2:30 AM, in 3h 20m · 3 h after 11:30 PM, when this one was due/, "pumped early: it counts from when this one was due");
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("button", { name: /^Log bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "", "the pumped milk's amount is the family's to say");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: a viewer sees the card with no buttons but Plan", async () => {
      const f = await fixture({ state: planned({ entries: morning(), role: "viewer" }) });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse, top up");
        assert.match(await c.textContent(), /top up 25–35 ml/);
        const names = await c.getByRole("button").evaluateAll((list) => list.map((b) => b.getAttribute("aria-label") ?? b.textContent));
        assert.deepEqual(names, ["Plan: open the feeding plan"]);
        // Plan opens the plan's sheet, to read.
        await c.getByRole("button", { name: "Plan: open the feeding plan", exact: true }).click();
        await f.page.getByRole("dialog", { name: "Feeding plan", exact: true }).waitFor();
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: the card's one big action is on screen without scrolling at 375x667, and the card fits 320", async () => {
      const f = await fixture({ state: planned({ entries: morning() }) });
      try {
        await metric(f);
        await f.page.setViewportSize({ width: 375, height: 667 });
        const c = await today(f);
        await f.page.waitForTimeout(300);
        const start = c.getByRole("button", { name: "Start Right: Nurse, top up", exact: true });
        const box = await start.boundingBox();
        const dock = await f.page.getByRole("region", { name: "Log something", exact: true }).boundingBox();
        assert.equal(await f.page.evaluate(() => window.scrollY), 0);
        assert(box && dock && box.y >= 0 && box.y + box.height <= dock.y, `Start Right (${box?.y}–${box && box.y + box.height}) must clear the dock (${dock?.y})`);
        // Above it, only the page's top and the card: nothing to scroll past.
        const top = await c.boundingBox();
        assert(top && top.y < box.y);
        // The card is compact enough that the top of Last fed shows under it too.
        const fed = await f.page.getByRole("button", { name: /^Last (?:fed|feed started) / }).first().boundingBox();
        assert(fed && fed.y + 12 <= dock.y, `the top of Last fed (${fed?.y}) shows above the dock (${dock.y})`);
        // So does the Start on a small, short phone.
        await f.page.setViewportSize({ width: 320, height: 568 });
        await f.page.waitForTimeout(300);
        const small = await start.boundingBox();
        const smallDock = await f.page.getByRole("region", { name: "Log something", exact: true }).boundingBox();
        assert(small && smallDock && small.y + small.height <= smallDock.y, `Start Right (${small && small.y + small.height}) clears the dock (${smallDock?.y}) at 320x568`);
        await f.page.setViewportSize({ width: 320, height: 640 });
        await f.page.waitForTimeout(200);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 320, "no sideways scroll at 320");
        assert.equal(await start.textContent(), "RStart Right", "the side's letter, then the words");
        const [startBox, otherBox] = await Promise.all([start.boundingBox(), c.getByRole("button", { name: /^Left: start on the Left/ }).boundingBox()]);
        assert(startBox && otherBox && Math.abs(startBox.y - otherBox.y) < 1, "both sides on one row at 320");
        assert(startBox.height <= 56, "Start Right stays on one line at 320");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: the dock's sides start a feed picked on this phone with its shield, else the log decides; with a pump first they outline no side", async () => {
      // This plan's Nurse + SNS nurses with a nipple shield; after the 8:00 AM feed, Nurse, top up is the plan's turn.
      const plan = structuredClone(PLAN);
      plan.feeds[0].steps[0].shield = true;
      const s = server();
      const f = await fixture({ state: planned({ plan, entries: morning() }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        await today(f);
        const dock = f.page.getByRole("region", { name: "Log something", exact: true });
        // No pick: the dock's start names no plan feed, so what's logged with it (a shield, a top-up) says which it was.
        await dock.getByRole("button", { name: /^Start nursing timer on Right/ }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual({ ...s.timer[0], client_id: undefined }, { action: "start", kind: "feed", side: "R", client_id: undefined });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Picked on this phone: the dock's start is the card's own, the picked feed with its nipple shield.
      const p = server();
      const e = await fixture({ state: planned({ plan, entries: morning() }), apiResponse: p.apiResponse });
      try {
        await metric(e);
        const c = await today(e);
        await c.getByRole("button", { name: "Other feed", exact: true }).click();
        await e.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("button", { name: "Do Nurse + SNS instead", exact: true }).click();
        await c.getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        await e.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await e.page.getByRole("region", { name: "Log something", exact: true }).getByRole("button", { name: /^Start nursing timer on Right/ }).click();
        await waitFor(e, () => p.timer.length > 0, "the timer start");
        assert.deepEqual(p.timer[0].with, { shield: true, plan: "p1f1" });
        assert.deepEqual(e.errors, []);
      } finally {
        await e.close();
      }
      // At night the next feed starts with the pump: the dock still starts nursing, but outlines neither side, and that
      // start isn't the plan's.
      const t = server();
      const evening = [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05")];
      const g = await fixture({ state: planned({ now: at(28, "23:10"), entries: evening }), apiResponse: t.apiResponse });
      try {
        await metric(g);
        await today(g);
        const dock = g.page.getByRole("region", { name: "Log something", exact: true });
        const sides = await dock.getByRole("button", { name: /^Start nursing timer on/ }).evaluateAll((list) => list.map((b) => b.getAttribute("aria-label")));
        assert.equal(sides.length, 2);
        assert(sides.every((n) => !n.includes("next side")), `no side outlined: ${sides.join(" | ")}`);
        await dock.getByRole("button", { name: /^Start nursing timer on Right/ }).click();
        await waitFor(g, () => t.timer.length > 0, "the timer start");
        assert.equal(t.timer[0].with, undefined);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: the dock's Bottle skips milk at the breast for its last bottle, and opens the plan's bottle when that's the step", async () => {
      // A 60 ml bottle at 5:00 AM, then the 8:00 feed with 20 ml in the SNS: the dock's last bottle is the 60 ml.
      const f = await fixture({ state: planned({ entries: [bottle(40, 28, "05:00", 60, { milk: "formula" }), ...morning()] }) });
      try {
        await metric(f);
        await today(f);
        const tile = f.page.getByRole("region", { name: "Log something", exact: true }).getByRole("button", { name: /^Bottle/ });
        assert.equal((await tile.textContent()).replace(/[  ]/g, " "), "Bottle60 ml last");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // 10:40–11:00 AM, Nurse, top up with no top-up; at 12:20 PM (80 minutes after) the tile is that feed's top-up.
      const fed = nursing(61, 28, [["R", "10:40", "10:50"], ["L", "10:50", "11:00"]], { plan: "p1f2" });
      const g = await fixture({ state: planned({ now: at(28, "12:20"), entries: [...morning(), fed] }) });
      try {
        await metric(g);
        await today(g);
        const tile = g.page.getByRole("region", { name: "Log something", exact: true }).getByRole("button", { name: /^Bottle/ });
        assert.equal((await tile.textContent()).replace(/[  ]/g, " "), "BottleTop-up");
        await tile.click();
        const form = g.page.getByRole("dialog", { name: /^Top-up · 10:40\sAM feed$/ });
        await form.waitFor();
        assert.match(await form.textContent(), /Part of that feed, not a feed of its own\./);
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "25", "the plan's amount");
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
      // The night feed's pump running: the bottle is the next step, outlined, and the form starts at the target's smaller amount.
      const evening = [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05"), pump(74, 28, "23:15", null)];
      const h = await fixture({ state: planned({ now: at(28, "23:20"), entries: evening }) });
      try {
        await metric(h);
        await today(h);
        const tile = h.page.getByRole("region", { name: "Log something", exact: true }).getByRole("button", { name: /^Bottle: Log bottle/ });
        assert.match(await tile.getAttribute("aria-label"), /\(next step\)/);
        assert.equal((await tile.textContent()).replace(/[  ]/g, " "), "BottleNext step");
        await tile.click();
        const form = h.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "", "the pumped milk's amount is the family's to say");
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    }],

    ["Feeding plan: the running timers say the plan's next step: the nursing card its feed and its milk at the breast in one tap, the pump card its bottle", async () => {
      const s = server();
      // On the Right since 9:22 AM, started from the plan as Nurse + SNS (no nipple shield in it).
      const on = nursing(51, 28, [["R", "09:22", null]], { plan: "p1f1" });
      const f = await fixture({ state: planned({ entries: [on] }), apiResponse: s.apiResponse, entryResponse: s.entryResponse });
      try {
        await metric(f);
        await today(f);
        const timer = f.page.getByRole("region", { name: "Nursing timer", exact: true });
        assert.match(await timer.textContent(), /Nurse \+ SNS · then pump 15 min/);
        // The shield stays on every nursing feed, off here (a family off the plan still needs it).
        assert.equal(await timer.getByRole("button", { name: "Nipple shield", exact: true }).getAttribute("aria-pressed"), "false");
        const chip = timer.getByRole("button", { name: "Log 20 ml in the SNS, formula", exact: true });
        assert.equal(await chip.textContent(), "20 ml SNS");
        await chip.dblclick();
        await waitFor(f, () => writes(f).length > 0, "the SNS milk");
        await f.page.waitForTimeout(400);
        assert.equal(writes(f).length, 1, "a double tap logs once");
        assert.deepEqual(writes(f)[0].body.data, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", plan: "p1f1", top_up_of: 51 }, "tagged with the plan's feed");
        await timer.getByRole("button", { name: /^Edit: 20 ml in the SNS/ }).waitFor();
        assert.equal(await chip.count(), 0, "logged: the chip says what was given instead");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // The night feed's pump running: its card offers the bottle next.
      const evening = [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05"), pump(74, 28, "23:15", null)];
      const g = await fixture({ state: planned({ now: at(28, "23:20"), entries: evening }) });
      try {
        await metric(g);
        await g.page.setViewportSize({ width: 375, height: 667 });
        await today(g);
        const timer = g.page.getByRole("region", { name: "Pumping timer", exact: true });
        const next = timer.getByRole("button", { name: /^Next: Log bottle/ });
        const [box, dock] = await Promise.all([next.boundingBox(), g.page.getByRole("region", { name: "Log something", exact: true }).boundingBox()]);
        assert(box && dock && box.y + box.height <= dock.y, `Next: Log bottle (${box && box.y + box.height}) clears the dock (${dock?.y})`);
        // What the bottle is up to, the pumped milk then formula to finish together.
        assert.match((await timer.textContent()).replace(/[  ]/g, " "), /Next: Log bottleUp to 50–70 ml in all/);
        await next.click();
        const form = g.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "", "the pumped milk's amount is the family's to say");
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: Not …? says which plan feed a feed underway was, on the feed itself, once more after a change elsewhere", async () => {
      // On the Right since 9:22 AM, read as Nurse + SNS; it was Nurse, top up.
      const on = nursing(51, 28, [["R", "09:22", null]], { plan: "p1f1" });
      const state = planned({ entries: [on] });
      const sent = [];
      const f = await fixture({
        state,
        entryResponse: ({ route, req, url }) => {
          const body = req.postDataJSON();
          sent.push({ id: url.searchParams.get("id"), body });
          const cur = state.entries.find((e) => e.id === 51);
          if (sent.length === 1) {
            // A Switch on the other phone landed first: the feed's version moved on.
            const moved = { ...cur, updated_at: "2026-10-28T13:25:00.000Z" };
            state.entries = state.entries.map((e) => (e.id === 51 ? moved : e));
            return route.fulfill({ status: 409, json: { error: "Someone else just changed this. Have another look and try again.", reason: "changed", entry: moved } });
          }
          const entry = { ...cur, data: { ...cur.data, ...body.data }, updated_at: "2026-10-28T13:30:05.000Z" };
          state.entries = state.entries.map((e) => (e.id === 51 ? entry : e));
          state.rev = "plan-corrected";
          return route.fulfill({ json: { entry } });
        },
      });
      try {
        await metric(f);
        const c = await today(f);
        await c.getByRole("button", { name: "Not Nurse + SNS?", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        const which = c.getByRole("group", { name: "Which feed it was", exact: true });
        assert.equal(await which.getByRole("button", { name: "It was Pump + bottle", exact: true }).count(), 1, "every other feed that feeds her");
        await which.getByRole("button", { name: "It was Nurse, top up", exact: true }).click();
        await waitFor(f, () => sent.length >= 2, "the correction");
        assert.deepEqual(sent, [
          { id: "51", body: { data: { plan: "p1f2" }, expect_updated_at: "2026-10-28T13:22:00.000Z" } },
          { id: "51", body: { data: { plan: "p1f2" }, expect_updated_at: "2026-10-28T13:25:00.000Z" } },
        ], "made against the version shown, then once more on the one the other phone saved");
        await c.getByRole("heading", { name: "Nurse, top up", exact: true }).waitFor();
        await f.page.getByText("This feed is Nurse, top up now", { exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: once the check-in day has passed the card says it was, and a call-today warning stays above the card", async () => {
      // Oct 31: the plan's check-in was the day before.
      const entries = [nursing(91, 31, [["L", "08:00", "08:15"]], { plan: "p1f1" }), pump(92, 31, "08:20", "08:35"), bottle(93, 31, "08:14", 20, { via: "sns", milk: "formula", plan: "p1f1" })];
      const state = planned({ now: at(31, "09:30"), entries });
      const f = await fixture({ state });
      try {
        await metric(f);
        const c = await today(f);
        assert.match(await c.textContent(), /Plan from Feeding clinic · Check-in was Fri, Oct 30/);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Warnings on, and red in this morning's diaper: its call-today warning comes before the card, not under it.
      const warned = planned({ entries: [...morning(), record(44, "diaper", { pee: false, poop: true, color: "red" }, at(28, "08:50"))] });
      warned.baby.settings.show_alerts = true;
      const g = await fixture({ state: warned });
      try {
        await metric(g);
        const c = await today(g);
        const alert = g.page.getByRole("button", { name: "Call your pediatrician today: Red in the diaper: call your pediatrician today. Show it in full", exact: true });
        const [a, b] = await Promise.all([alert.boundingBox(), c.boundingBox()]);
        assert(a && b && a.y < b.y, `the warning (${a?.y}) is above the card (${b?.y})`);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: a top-up only if she's still hungry keeps its action after nursing with a quiet Not needed, set aside on this phone, and is never not logged", async () => {
      // The plan's second feed: nurse 8–12 min each side, then a 25–35 ml paced top-up only if she's still hungry.
      const plan = structuredClone(PLAN);
      plan.feeds[1] = { id: "p1f2", name: "Nurse, top up if hungry", steps: [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 }, via: "paced", if_needed: true }] };
      // 9:00–9:20 AM from the plan, no top-up. It's 9:30.
      const fed = () => nursing(95, 28, [["L", "09:00", "09:10"], ["R", "09:10", "09:20"]], { plan: "p1f2" });
      const f = await fixture({ state: planned({ plan, entries: [fed()] }) });
      try {
        await metric(f);
        const c = await today(f);
        const text = (await c.textContent()).replace(/[  ]/g, " ");
        assert.match(text, /^Now/);
        assert.match(text, /Top up 25–35 ml if still hungry, paced bottle/);
        // Nothing else to do: the top-up is the big button, with Not needed beside its row.
        assert(await c.locator("[data-plan-primary]").getByRole("button", { name: /^Log top-up/ }).isVisible(), "the top-up is the card's big button");
        await c.getByRole("button", { name: "Not needed", exact: true }).click();
        await c.getByRole("button", { name: /^Log top-up/ }).waitFor({ state: "hidden" });
        assert.equal(await c.getByRole("button", { name: "Not needed", exact: true }).count(), 0);
        assert.match(await c.textContent(), /Not needed/, "the row says it wasn't needed");
        assert.equal(writes(f).length, 0, "nothing is logged");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // An hour on, nobody gave it: the next feed, and no line saying it wasn't logged.
      const g = await fixture({ state: planned({ plan, now: at(28, "10:30"), entries: [fed()] }) });
      try {
        await metric(g);
        const c = await today(g);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse + SNS");
        assert.equal(await c.getByRole("group", { name: "Not logged", exact: true }).count(), 0);
        assert.doesNotMatch(await c.textContent(), /not logged/);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: a feed on one side offers only that side's Start, with the plan's feed, and the dock and Last fed say that side", async () => {
      // After the 8:00 AM feed (on the Left), the plan's turn nurses on the left only: taking turns alone would say Right.
      const plan = structuredClone(PLAN);
      plan.feeds[1] = { id: "p1f2", name: "Left, pump the right", steps: [{ do: "nurse", minutes: { min: 15, max: 20 }, side: "L" }, { do: "pump", minutes: { min: 15, max: 15 } }] };
      const s = server();
      const f = await fixture({ state: planned({ plan, entries: morning() }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Left, pump the right");
        assert.match(await c.textContent(), /Nurse 15–20 min on the left\. Then pump 15 min/);
        assert.equal(await c.locator("[data-plan-primary]").getByRole("button").count(), 1, "one Start, never the other side");
        const dock = f.page.getByRole("region", { name: "Log something", exact: true });
        const sides = await dock.getByRole("button", { name: /^Start nursing timer on/ }).evaluateAll((list) => list.map((b) => b.getAttribute("aria-label")));
        assert(sides.some((n) => n.startsWith("Start nursing timer on Left (next side)")) && !sides.some((n) => n.includes("Right (next side)")), `the dock outlines the left: ${sides.join(" | ")}`);
        assert.equal(await f.page.getByText("next side", { exact: true }).locator("..").textContent(), "Leftnext side", "Last fed's next side");
        await c.getByRole("button", { name: "Start Left: Left, pump the right", exact: true }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual({ side: s.timer[0].side, with: s.timer[0].with }, { side: "L", with: { plan: "p1f2" } });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: on demand, the card says by when, never Due now before then; waking, when to wake if still asleep", async () => {
      // On demand, at least every 3 hours; after the 8:00 AM feed it's 9:30.
      const plan = structuredClone(PLAN);
      plan.day = { every: { min: 180, max: 180 }, on_demand: true };
      const f = await fixture({ state: planned({ plan, entries: morning() }) });
      try {
        await metric(f);
        const c = await today(f);
        const text = (await c.textContent()).replace(/[  ]/g, " ");
        assert.match(text, /By 11:00 AM \(on demand\) · at most 3 h after the 8:00 AM feed/);
        assert.doesNotMatch(text, /Due now/);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      const wake = structuredClone(plan);
      wake.day.wake = true;
      const g = await fixture({ state: planned({ plan: wake, entries: morning() }) });
      try {
        await metric(g);
        const c = await today(g);
        // No sex set: the baby's name stands in for the pronoun.
        assert.match((await c.textContent()).replace(/[  ]/g, " "), /Wake River by 11:00 AM if still asleep · at most 3 h after the 8:00 AM feed/);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: at night the night's feeds take turns: after the night's first, its second is next", async () => {
      // The night's turns: Pump + bottle, then Nurse, pump (10–15 min each side, then pump 15).
      const plan = structuredClone(PLAN);
      plan.feeds.push({ id: "p1f4", name: "Nurse, pump", steps: [{ do: "nurse", minutes: { min: 10, max: 15 }, each_side: true }, { do: "pump", minutes: { min: 15, max: 15 } }] });
      plan.night = { ...plan.night, feed: "p1f3", order: ["p1f3", "p1f4"] };
      const evening = [nursing(71, 28, [["L", "20:30", "20:45"]], { plan: "p1f1" }), bottle(72, 28, "20:44", 20, { via: "sns", milk: "formula" }), pump(73, 28, "20:50", "21:05")];
      const first = [...evening, pump(74, 28, "23:20", "23:40"), bottle(75, 28, "23:45", 55, { milk: "breastmilk", plan: "p1f3" })];
      const f = await fixture({ state: planned({ plan, now: at(28, "23:50"), entries: first }) });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse, pump");
        const text = (await c.textContent()).replace(/[  ]/g, " ");
        assert.match(text, /^Night feed/);
        assert.match(text, /Wake River for it at 2:45 AM, in 2h 55m/);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: a night bottle feed left short is named by its bottle, and the dock's Bottle opens its formula to finish", async () => {
      // Pumped from 11:20 PM, 40 ml of pumped milk at 11:45, no formula to finish. It's 12:40 AM.
      const entries = [...evening(), pump(74, 28, "23:20", "23:40"), bottle(75, 28, "23:45", 40, { milk: "breastmilk", plan: "p1f3" })];
      const f = await fixture({ state: planned({ now: at(29, "00:40"), entries }) });
      try {
        await metric(f);
        const c = await today(f);
        const missed = c.getByRole("group", { name: "Not logged", exact: true });
        assert.match(plain(await missed.textContent()), /11:45 PM feed: formula to finish not logged/, "named by its bottle, never its 11:20 PM pump");
        assert.match(plain(await c.textContent()), /3 h after the 11:45 PM feed/, "the due line names the same moment");
        // The dock's Bottle is the missed line's own fix, saying what it's for.
        const tile = dock(f).getByRole("button", { name: /^Bottle: Log formula to finish/ });
        assert.equal(plain(await tile.textContent()), "BottleTo finish");
        assert.doesNotMatch(await tile.getAttribute("aria-label"), /next step/);
        await tile.click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "10", "the rest of the target's smaller amount");
        assert.equal(await form.getByRole("region", { name: "Milk" }).getByRole("button", { name: "Formula", exact: true }).getAttribute("aria-pressed"), "true");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: the running nursing card counts the milk given across a break and a re-latch, and stops offering the plan's", async () => {
      // On the Left 9:00–9:10 from the plan as Nurse + SNS, a 12-minute break, back on from 9:22; its SNS milk at 9:25.
      const on = nursing(51, 28, [["L", "09:00", "09:10"], ["L", "09:22", null]], { plan: "p1f1" });
      const f = await fixture({ state: planned({ entries: [on, bottle(52, 28, "09:25", 20, { via: "sns", milk: "formula", plan: "p1f1", top_up_of: 51 })] }) });
      try {
        await metric(f);
        const c = await today(f);
        assert.match(await c.textContent(), /20 ml in the SNS/, "the card counts it");
        const timer = f.page.getByRole("region", { name: "Nursing timer", exact: true });
        await timer.getByRole("button", { name: /^Edit: 20 ml in the SNS · formula, at 9:25/ }).waitFor();
        assert.equal(await timer.getByRole("button", { name: /^Log 20 ml in the SNS/ }).count(), 0, "never offered again");
        assert.equal(await timer.getByRole("button", { name: /SNS: opens the bottle form$/ }).count(), 0);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // The feed and its pump done, she latched again 16 minutes on (from the dock): the plan's same feed, its SNS in.
      const fed = nursing(61, 28, [["L", "08:40", "08:52"]], { plan: "p1f1" });
      const entries = [fed, bottle(62, 28, "08:45", 20, { via: "sns", milk: "formula", plan: "p1f1", top_up_of: 61 }), pump(63, 28, "08:54", "09:04"), nursing(64, 28, [["R", "09:20", null]])];
      const g = await fixture({ state: planned({ entries }) });
      try {
        await metric(g);
        await today(g);
        const timer = g.page.getByRole("region", { name: "Nursing timer", exact: true });
        await timer.getByRole("button", { name: /^Edit: 20 ml in the SNS · formula, at 8:45/ }).waitFor();
        assert.equal(await timer.getByRole("button", { name: /^Log 20 ml in the SNS/ }).count(), 0);
        assert.equal(await timer.getByRole("button", { name: "Milk at the breast", exact: true }).count(), 0);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: started from the dock, a feed's parts say what was logged: no plan feed on its own Milk at the breast, and Shield? asks", async () => {
      // Nurse, top up's turn after the 8:00 AM feed, started from the dock at 9:22 (no plan feed named).
      const state = planned({ entries: [...morning(), nursing(51, 28, [["R", "09:22", null]])] });
      const posts = [];
      const f = await fixture({
        state,
        entryResponse: ({ route, req }) => {
          const body = req.postDataJSON();
          posts.push(body);
          const entry = record(90 + posts.length, "feed", body.data, body.started_at ?? state.now);
          state.entries = [entry, ...state.entries];
          state.rev = `parts-${posts.length}`;
          return route.fulfill({ json: { entry } });
        },
      });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse, top up");
        const timer = f.page.getByRole("region", { name: "Nursing timer", exact: true });
        await timer.getByRole("button", { name: "Milk at the breast", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Milk at the breast", exact: true });
        await form.waitFor();
        assert.match(plain(await form.textContent()), /With the 9:22 AM feed: part of it, not a feed of its own\./);
        // As last time (the 8:00 AM feed's 20 ml of formula in the SNS), tied to this feed, never to a plan feed.
        await form.getByRole("button", { name: "Log 20 ml in the SNS", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        await waitFor(f, () => posts.length > 0, "the milk at the breast");
        assert.deepEqual(posts[0].data, { method: "bottle", amount_ml: 20, milk: "formula", via: "sns", top_up_of: 51 }, "what was logged decides which plan feed it was");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // The plan's first feed nurses with the nipple shield, started from the dock: the card's chip asks, until it's
      // tapped either way (off is saved as no shield, so it isn't asked again).
      const plan = structuredClone(PLAN);
      plan.feeds[0].steps[0].shield = true;
      const shieldState = planned({ plan, entries: [nursing(51, 28, [["L", "09:22", null]])] });
      const sent = [];
      const g = await fixture({
        state: shieldState,
        entryResponse: ({ route, req, url }) => {
          const body = req.postDataJSON();
          sent.push(body);
          const cur = shieldState.entries.find((e) => e.id === Number(url.searchParams.get("id")));
          const entry = { ...cur, data: { ...cur.data, ...body.data }, updated_at: `2026-10-28T13:30:0${sent.length}.000Z` };
          shieldState.entries = shieldState.entries.map((e) => (e.id === entry.id ? entry : e));
          shieldState.rev = `shield-${sent.length}`;
          return route.fulfill({ json: { entry } });
        },
      });
      try {
        await metric(g);
        await today(g);
        const timer = g.page.getByRole("region", { name: "Nursing timer", exact: true });
        const asked = timer.getByRole("button", { name: "Nipple shield? The plan's nursing uses one", exact: true });
        assert.equal(await asked.textContent(), "Shield?");
        assert.equal(await asked.getAttribute("aria-pressed"), "false");
        await asked.click();
        await waitFor(g, () => sent.length > 0, "the shield on");
        assert.deepEqual(sent[0].data, { shield: true });
        const chip = timer.getByRole("button", { name: "Nipple shield", exact: true });
        await g.page.waitForFunction(() => document.querySelector('[aria-label="Nipple shield"]')?.getAttribute("aria-pressed") === "true");
        await chip.click();
        await waitFor(g, () => sent.length > 1, "the shield off");
        assert.deepEqual(sent[1].data, { shield: false }, "said: no shield this feed");
        await g.page.waitForFunction(() => document.querySelector('[aria-label="Nipple shield"]')?.getAttribute("aria-pressed") === "false");
        assert.equal(await chip.textContent(), "Shield", "answered: not asked again");
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: a feed she latched again for keeps its first nursing's name, in the missed line and its top-up's form", async () => {
      // Nurse, top up 10:40–11:00 AM from the plan, then she latched again 11:20–11:28 (from the dock); no top-up. 12:20 PM.
      const s = server();
      const entries = [...morning(), nursing(61, 28, [["R", "10:40", "10:50"], ["L", "10:50", "11:00"]], { plan: "p1f2" }), nursing(62, 28, [["L", "11:20", "11:28"]])];
      const f = await fixture({ state: planned({ now: at(28, "12:20"), entries }), entryResponse: s.entryResponse });
      try {
        await metric(f);
        const c = await today(f);
        const missed = c.getByRole("group", { name: "Not logged", exact: true });
        assert.match(plain(await missed.textContent()), /10:40 AM feed: top-up not logged/);
        await missed.getByRole("button", { name: "Fix", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await missed.getByRole("button", { name: /^Log top-up/ }).click();
        const form = f.page.getByRole("dialog", { name: /^Top-up · 10:40\sAM feed$/ });
        await form.waitFor();
        assert.match(await form.textContent(), /Part of that feed, not a feed of its own\./);
        await form.getByRole("button", { name: /^Log 25 ml/ }).click();
        await form.waitFor({ state: "hidden" });
        await waitFor(f, () => writes(f).length > 0, "the top-up");
        const { top_up_of, plan } = writes(f)[0].body.data;
        assert.deepEqual({ top_up_of, plan }, { top_up_of: 62, plan: "p1f2" }, "it tops up her newest nursing, as that plan feed's");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: Not …? says which feed it was on every entry of it: the night's bottle and the nursing after it", async () => {
      // The night's first feed, then she nursed from 12:05 AM (from the dock): one feed. It's 12:10 AM.
      const state = planned({ now: at(29, "00:10"), entries: [...firstNight(), nursing(76, 29, [["L", "00:05", null]])] });
      const sent = [];
      const f = await fixture({
        state,
        entryResponse: ({ route, req, url }) => {
          const id = Number(url.searchParams.get("id"));
          sent.push({ id, data: req.postDataJSON().data });
          const cur = state.entries.find((e) => e.id === id);
          const entry = { ...cur, data: { ...cur.data, ...req.postDataJSON().data }, updated_at: `2026-10-29T04:10:0${sent.length}.000Z` };
          state.entries = state.entries.map((e) => (e.id === id ? entry : e));
          state.rev = `retag-${sent.length}`;
          return route.fulfill({ json: { entry } });
        },
      });
      try {
        await metric(f);
        const c = await today(f);
        assert.match(plain(await c.textContent()), /^Now.*Pump \+ bottle.*River nursed too/);
        await c.getByRole("button", { name: "Not Pump + bottle?", exact: true }).click();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("group", { name: "Which feed it was", exact: true }).getByRole("button", { name: "It was Nurse, top up", exact: true }).click();
        await waitFor(f, () => sent.length >= 2, "the corrections");
        assert.deepEqual(sent.map((x) => [x.id, x.data]).sort((a, b) => a[0] - b[0]), [[75, { plan: "p1f2" }], [76, { plan: "p1f2" }]], "the bottle and the nursing, one feed");
        await f.page.getByText("This feed is Nurse, top up now", { exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: when she only nursed in the night feed's place, the card says so with the plan's words and nothing to do", async () => {
      // The night's first feed, then she nursed from 12:30 AM (from the dock). It's 12:50 AM, still on.
      const entries = [...firstNight(), nursing(76, 29, [["L", "00:30", null]])];
      const f = await fixture({ state: planned({ now: at(29, "00:50"), entries }) });
      try {
        await metric(f);
        const c = await today(f);
        const text = plain(await c.textContent());
        assert.match(text, /^Night feed/, "not Now: the plan's routine isn't what's happening");
        assert.match(text, /River's nursing now · 20m/);
        assert.match(text, /Pump 20 min\. Then bottle up to 50–70 ml, breast milk first, then formula to finish/);
        assert.equal(await c.locator("[data-plan-primary]").count(), 0, "nothing to do");
        assert.equal(await c.getByRole("button", { name: /^(?:Start pumping|Log bottle)/ }).count(), 0);
        assert.doesNotMatch(plain(await f.page.getByRole("region", { name: "Nursing timer", exact: true }).textContent()), /then pump/, "the timer card doesn't push the routine");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Off at 12:50 AM; an hour on, nothing of it reads as not logged.
      const later = [...firstNight(), nursing(76, 29, [["L", "00:30", "00:50"]])];
      const g = await fixture({ state: planned({ now: at(29, "01:45"), entries: later }) });
      try {
        await metric(g);
        const c = await today(g);
        assert.equal(await c.getByRole("group", { name: "Not logged", exact: true }).count(), 0);
        assert.doesNotMatch(await c.textContent(), /not logged/);
        // The dock's Bottle owes nothing for it: the last bottle, as ever.
        const tile = dock(g).getByRole("button", { name: /^Bottle/ });
        assert.equal(plain(await tile.textContent()), "Bottle55 ml last");
        assert.doesNotMatch((await tile.getAttribute("aria-label")) ?? "", /next step/);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: call-today warnings fold into one row above the card, which keeps its action above the dock, its sides as the dock's and its numbers whole", async () => {
      // Warnings on: red in this morning's diaper, and diapers logged since yesterday say one wet one and one poop in 24
      // hours (three call-today warnings). After the 8:00 AM feed the plan's turn is Nurse, top up, Right suggested.
      const diapers = [
        record(44, "diaper", { pee: false, poop: true, color: "red" }, at(28, "08:50")),
        record(45, "diaper", { pee: true, poop: false }, at(28, "06:00")),
        record(46, "diaper", { pee: true, poop: false }, at(27, "08:00")),
      ];
      const warned = planned({ entries: [...morning(), ...diapers] });
      warned.baby.settings.show_alerts = true;
      const f = await fixture({ state: warned });
      const row = () => f.page.getByRole("button", { name: /^Call your pediatrician today: .*\. Show them in full$/ });
      try {
        await metric(f);
        for (const [width, height] of [[375, 667], [375, 812], [320, 568]]) {
          await f.page.setViewportSize({ width, height });
          await f.page.goto("https://first-use.example.test/#today");
          const c = card(f);
          await c.waitFor();
          await f.page.waitForTimeout(250);
          assert.equal(await row().count(), 1, `${width}x${height}: one row for all of them`);
          const [rb, cb] = await Promise.all([row().boundingBox(), c.boundingBox()]);
          assert(rb && cb && rb.height <= 60, `${width}x${height}: a short row (${rb?.height})`);
          // Above the card; on a very short screen there's no room above it, so under it.
          if (height >= 600) assert(rb.y < cb.y, `${width}x${height}: the row (${rb.y}) above the card (${cb.y})`);
          else assert(rb.y > cb.y + cb.height - 1, `${width}x${height}: the row (${rb.y}) under the card (${cb.y + cb.height})`);
          assert.match(plain(await row().textContent()), /^Call your pediatrician today/, "who to call, first");
          const start = c.getByRole("button", { name: "Start Right: Nurse, top up", exact: true });
          const left = c.getByRole("button", { name: /^Left: start on the Left/ });
          const [sb, lb, db] = await Promise.all([start.boundingBox(), left.boundingBox(), dock(f).boundingBox()]);
          assert(sb && db && sb.y + sb.height <= db.y, `${width}x${height}: Start Right (${sb && sb.y + sb.height}) clears the dock (${db?.y})`);
          assert(sb && lb && lb.x < sb.x && sb.width > lb.width && Math.abs(sb.y - lb.y) < 1, `${width}x${height}: Left then Right, as the dock has them, the suggested one wide`);
          // Each number stays on one line with its unit.
          const split = await c.evaluate((el) => [...el.querySelectorAll("span.whitespace-nowrap")].filter((n) => n.getClientRects().length > 1).map((n) => n.textContent));
          assert.deepEqual(split, [], `${width}x${height}: an amount split across lines`);
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), width, "no sideways scroll");
        }
        // A tap opens every one in full, with who to call and We called.
        await row().click();
        await f.page.getByRole("button", { name: "We called", exact: true }).first().waitFor();
        assert.equal(await f.page.getByRole("button", { name: "We called", exact: true }).count(), 3);
        await row().waitFor({ state: "detached" });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],

    ["Feeding plan: She's done and Got it are kept on the phone when the app is closed and opened again, for a day", async () => {
      // Pumped 11:20–11:40 PM, 40 ml at 11:45 PM; at 11:55 PM She's done.
      const entries = [...evening(), pump(74, 28, "23:20", "23:40"), bottle(75, 28, "23:45", 40, { milk: "breastmilk", plan: "p1f3" })];
      const f = await fixture({ state: planned({ now: at(28, "23:55"), entries }) });
      try {
        await metric(f);
        const c = await today(f);
        await c.getByRole("button", { name: "River's done", exact: true }).click();
        await c.getByRole("button", { name: /^Log formula to finish/ }).waitFor({ state: "hidden" });
        // Closed and opened again: this tab's memory is gone, the phone's isn't.
        await f.page.evaluate(() => sessionStorage.clear());
        await f.page.reload();
        await card(f).waitFor();
        assert.equal(await card(f).getByRole("button", { name: /^Log formula to finish/ }).count(), 0, "still set aside");
        assert.equal(await card(f).getByRole("button", { name: "River's done", exact: true }).count(), 0);
        // What was set aside for a feed over a day ago is cleared when the app opens.
        const stale = `maple-plan-close:99:${Date.parse("2026-10-26T12:00:00.000Z")}:p1f3:1`;
        await f.page.evaluate((k) => localStorage.setItem(k, "1"), stale);
        await f.page.reload();
        await card(f).waitFor();
        assert.equal(await f.page.evaluate((k) => localStorage.getItem(k), stale), null);
        assert.equal(await f.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("maple-plan-close:")).length), 1, "today's kept");
        assert.equal(writes(f).length, 0, "nothing is logged");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Got it: gone after the app is closed and opened again too.
      const g = await fixture({ state: planned({ now: at(28, "12:20"), entries: [...morning(), nursing(61, 28, [["R", "10:40", "10:50"], ["L", "10:50", "11:00"]], { plan: "p1f2" })] }) });
      try {
        await metric(g);
        const c = await today(g);
        await c.getByRole("group", { name: "Not logged", exact: true }).getByRole("button", { name: "Fix", exact: true }).click();
        await g.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("group", { name: "Not logged", exact: true }).getByRole("button", { name: /^Got it/ }).click();
        await c.getByRole("group", { name: "Not logged", exact: true }).waitFor({ state: "hidden" });
        await g.page.evaluate(() => sessionStorage.clear());
        await g.page.reload();
        await card(g).waitFor();
        assert.equal(await card(g).getByRole("group", { name: "Not logged", exact: true }).count(), 0);
        assert.equal(writes(g).length, 0);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    // ── plans other families bring home ──────────────────────────────────

    ["Feeding plan: the breast offered only if she wants to is Start Left or Right with a quiet Not this time, then the bottle, never a top-up", async () => {
      // Practice at the breast 5–10 min only if she wants to, then 60 ml of breast milk by paced bottle, every 3 hours.
      const plan = {
        v: 1,
        unit: "ml",
        day: { every: { min: 180, max: 180 } },
        feeds: [{ id: "p1f1", name: "Practice, then bottle", steps: [{ do: "nurse", minutes: { min: 5, max: 10 }, if_needed: true }, { do: "bottle", ml: { min: 60, max: 60 }, milk: "breastmilk", via: "paced" }] }],
        order: ["p1f1"],
        rev: 1,
        updated_at: "2026-10-27T12:00:00.000Z",
      };
      // The last feed, its bottle, at 6:30 AM; it's 9:30.
      const last = () => [bottle(41, 28, "06:30", 60, { milk: "breastmilk", via: "paced", plan: "p1f1" })];
      const s = server();
      const f = await fixture({ state: planned({ plan, entries: last() }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const c = await today(f);
        const text = plain(await c.textContent());
        assert.match(text, /Offer the breast 5–10 min\. Then bottle 60 ml, breast milk, paced bottle/);
        assert.doesNotMatch(text, /Top up|top-up/);
        // In its place, the breast is the next physical step: Start Left and Right, and a quiet Not this time under them.
        const start = c.getByRole("button", { name: "Start Left: Practice, then bottle", exact: true });
        const not = c.getByRole("button", { name: "Not this time", exact: true });
        assert.equal(await c.locator("[data-plan-primary]").getByRole("button").count(), 2, "Left and Right");
        for (const [width, height] of [[375, 667], [320, 568]]) {
          await f.page.setViewportSize({ width, height });
          await f.page.waitForTimeout(250);
          const [sb, nb, db] = await Promise.all([start.boundingBox(), not.boundingBox(), dock(f).boundingBox()]);
          assert(sb && nb && db, "on screen");
          assert(sb.y + sb.height <= db.y, `${width}x${height}: Start Left (${sb.y + sb.height}) clears the dock (${db.y})`);
          assert(nb.y >= sb.y + sb.height - 1 && nb.height >= 44, `${width}x${height}: Not this time under it, 44 px tall`);
          assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), width, `${width}x${height}: no sideways scroll`);
        }
        // The dock's Bottle isn't the plan's next step while the breast is.
        assert.doesNotMatch(plain(await dock(f).getByRole("button", { name: /^Bottle/ }).textContent()), /Next step/);
        await start.click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual({ side: s.timer[0].side, with: s.timer[0].with }, { side: "L", with: { plan: "p1f1" } });
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // Not this time: set aside on this phone for the plan's turn; the bottle is the big button, a bottle of its own.
      const g = await fixture({ state: planned({ plan, entries: last() }) });
      try {
        await metric(g);
        const c = await today(g);
        await c.getByRole("button", { name: "Not this time", exact: true }).click();
        await c.locator("[data-plan-primary]").getByRole("button", { name: "Log bottle: opens the bottle form", exact: true }).waitFor();
        assert.equal(await c.getByRole("button", { name: /^Start Left/ }).count(), 0, "the breast's Start is gone");
        assert.doesNotMatch(plain(await c.textContent()), /Offer the breast/, "and its words, set aside");
        assert.equal(plain(await dock(g).getByRole("button", { name: /^Bottle/ }).textContent()), "BottleNext step");
        await g.page.reload();
        await card(g).waitFor();
        assert.equal(await card(g).getByRole("button", { name: /^Start Left/ }).count(), 0, "still set aside in this tab");
        await card(g).getByRole("button", { name: "Log bottle: opens the bottle form", exact: true }).click();
        const form = g.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "60", "the plan's amount");
        assert.doesNotMatch(await form.textContent(), /Top-up|part of that feed/i, "a bottle of its own, never a top-up");
        assert.equal(writes(g).length, 0, "nothing is logged");
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: a night when she's hungry has no time and never Due since, and the day's due comes back at the night's end", async () => {
      // Every 3 hours by day, waking her; at night (10 PM–6 AM) when she's hungry: a bottle of 60–90 ml of formula.
      const plan = {
        v: 1,
        unit: "ml",
        day: { every: { min: 180, max: 180 }, wake: true },
        night: { from: "22:00", to: "06:00", on_demand: true },
        feeds: [{ id: "p1f1", name: "Bottle", steps: [{ do: "bottle", ml: { min: 60, max: 90 }, milk: "formula" }] }],
        order: ["p1f1"],
        rev: 1,
        updated_at: "2026-10-27T12:00:00.000Z",
      };
      // Her last bottle at 9:40 PM. At 11 PM and at 2:30 AM she's asleep.
      const eve = () => [bottle(41, 28, "21:40", 70, { milk: "formula", plan: "p1f1" })];
      for (const now of [at(28, "23:00"), at(29, "02:30")]) {
        const f = await fixture({ state: planned({ plan, now, entries: eve() }) });
        try {
          await metric(f);
          const c = await today(f);
          const text = plain(await c.textContent());
          assert.match(text, /^Night feed/, now);
          // No sex set: the baby's name stands in for the pronoun.
          assert.match(text, /When River's hungry/, now);
          assert.doesNotMatch(text, /Due|Wake River|in \d/, `${now}: no time at night`);
          assert.equal(await c.locator("[data-plan-hungry]").count(), 1);
          assert(await c.locator("[data-plan-primary]").getByRole("button", { name: /^Log bottle/ }).isVisible(), "the night's feed and its step");
          assert.deepEqual(f.errors, []);
        } finally {
          await f.close();
        }
      }
      // The night over: the day's due, from the night's end.
      const g = await fixture({ state: planned({ plan, now: at(29, "06:05"), entries: eve() }) });
      try {
        await metric(g);
        const c = await today(g);
        const text = plain(await c.textContent());
        assert.match(text, /^Next feed/);
        assert.match(text, /Due now \(6:00 AM\)/);
        assert.doesNotMatch(text, /hungry/);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
    }],

    ["Feeding plan: a night by the clock says the turn's hours beside its name, and Then the night feed says when its turn starts", async () => {
      // A split night: 10 PM–6 AM, the partner's bottle until 2 AM, then nursing; every 2.5–3 hours by day.
      const plan = {
        v: 1,
        unit: "ml",
        day: { every: { min: 150, max: 180 } },
        night: { from: "22:00", to: "06:00", feed: "p1f2", order: ["p1f2", "p1f1"], starts: ["22:00", "02:00"] },
        feeds: [
          { id: "p1f1", name: "Nurse", steps: [{ do: "nurse", minutes: { min: 10, max: 15 }, each_side: true }] },
          { id: "p1f2", name: "Partner's bottle", steps: [{ do: "bottle", ml: { min: 60, max: 90 }, milk: "breastmilk", via: "paced" }] },
        ],
        order: ["p1f1"],
        rev: 1,
        updated_at: "2026-10-27T12:00:00.000Z",
      };
      const eve = () => [nursing(41, 28, [["L", "20:00", "20:15"], ["R", "20:15", "20:30"]], { plan: "p1f1" })];
      // 11 PM, after the 8 PM feed: the partner's turn.
      const f = await fixture({ state: planned({ plan, now: at(28, "23:00"), entries: eve() }) });
      try {
        await metric(f);
        const c = await today(f);
        assert.equal(await c.getByRole("heading").textContent(), "Partner's bottle");
        assert.match(plain(await c.textContent()), /^Night feedPlanPartner's bottleuntil 2 AM/);
        assert.equal(plain(await c.getAttribute("aria-label")), "Night feed: Partner's bottle, until 2 AM");
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
      // 3 AM, the partner's bottle given at 11 PM: nursing's turn, until the night's end.
      const g = await fixture({ state: planned({ plan, now: at(29, "03:00"), entries: [...eve(), bottle(42, 28, "23:00", 70, { milk: "breastmilk", via: "paced", plan: "p1f2" })] }) });
      try {
        await metric(g);
        const c = await today(g);
        assert.equal(await c.getByRole("heading").textContent(), "Nurse");
        assert.match(plain(await c.textContent()), /^Night feedPlanNurseuntil 6 AM/);
        assert.deepEqual(g.errors, []);
      } finally {
        await g.close();
      }
      // 9:30 PM, on the breast: then the night's first turn, from 10 PM.
      const h = await fixture({ state: planned({ plan, now: at(28, "21:40"), entries: [nursing(43, 28, [["L", "21:30", null]], { plan: "p1f1" })] }) });
      try {
        await metric(h);
        const c = await today(h);
        assert.match(plain(await c.textContent()), /Then the night feed: Partner's bottle · from 10 PM/);
        assert.deepEqual(h.errors, []);
      } finally {
        await h.close();
      }
    }],

    ["Feeding plan: the plan's feeds in 24 hours are one quiet line on the card, and a cup feed's Log feed opens the bottle form with no way of giving", async () => {
      // A cup feed: 20–30 ml of breast milk by cup, every 3 hours; at least 8 feeds in 24 hours.
      const plan = {
        v: 1,
        unit: "ml",
        day: { every: { min: 180, max: 180 } },
        per_day: { feeds: { min: 8 } },
        feeds: [{ id: "p1f1", name: "Cup feed", steps: [{ do: "bottle", ml: { min: 20, max: 30 }, milk: "breastmilk", by: "cup" }] }],
        order: ["p1f1"],
        rev: 1,
        updated_at: "2026-10-27T12:00:00.000Z",
      };
      const entries = ["00:30", "03:30", "06:30"].map((t, i) => bottle(41 + i, 28, t, 25, { milk: "breastmilk", plan: "p1f1" }));
      const f = await fixture({ state: planned({ plan, entries }) });
      try {
        await metric(f);
        const c = await today(f);
        const line = c.locator("[data-plan-day]");
        assert.equal(plain(await line.textContent()), "3 feeds in the last 24 hours · plan: at least 8");
        // Context, as quiet as the card's eyebrow: never a warning color.
        const [ink, quiet] = await Promise.all([line.evaluate((el) => getComputedStyle(el).color), c.locator("p").first().evaluate((el) => getComputedStyle(el).color)]);
        assert.equal(ink, quiet, "the line's color is the card's quiet ink");
        assert.match(plain(await c.textContent()), /Cup 20–30 ml, breast milk/);
        await c.getByRole("button", { name: "Log feed: opens the bottle form", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "20", "the plan's amount");
        assert.equal(await form.getByRole("region", { name: "How it was given", exact: true }).getByRole("button", { pressed: true }).count(), 0, "no way of giving said");
        assert.equal(writes(f).length, 0);
        assert.deepEqual(f.errors, []);
      } finally {
        await f.close();
      }
    }],
  ];
}

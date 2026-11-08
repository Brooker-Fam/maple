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
        assert.match(text, /Nurse 12–18 min with the nipple shield, 20 ml of formula in the SNS/);
        assert.match(text, /Pump 15 min/);
        assert.match(text, /Aim for 50–70 ml a feed · Plan from Feeding clinic · Check-in Fri, Oct 30/);
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
        assert.match(text, /10:30 AM–11:30 AM, in 1h 00m/, "due 2.5–3.5 hours from the 8 AM start");
        assert.match(text, /Nurse 8–12 min each side/);
        assert.match(text, /Top up 25–35 ml, formula or breast milk, paced bottle/);
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

    ["Feeding plan: Do the other feed instead, kept on this phone until a feed starts, with the way back", async () => {
      const s = server();
      const f = await fixture({ state: planned({ entries: morning() }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const c = await today(f);
        await c.getByRole("button", { name: "Do Nurse + SNS instead", exact: true }).click();
        await c.getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        assert.match(await c.textContent(), /Picked on this phone/);
        assert(await c.getByRole("button", { name: "Back to Nurse, top up", exact: true }).isVisible());
        assert.equal(await c.getByRole("button", { name: "Do Nurse, top up instead", exact: true }).count(), 0, "the plan's turn is Back to, not another pick");
        // The pick stays on this phone across a reload.
        await f.page.reload();
        await card(f).getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        // Back to the plan's turn, then the pick again, and its start names the picked feed.
        await card(f).getByRole("button", { name: "Back to Nurse, top up", exact: true }).click();
        await card(f).getByRole("heading", { name: "Nurse, top up", exact: true }).waitFor();
        await f.page.waitForTimeout(700);
        await card(f).getByRole("button", { name: "Do Nurse + SNS instead", exact: true }).click();
        await card(f).getByRole("heading", { name: "Nurse + SNS", exact: true }).waitFor();
        await f.page.waitForTimeout(700);
        await card(f).getByRole("button", { name: "Start Right: Nurse + SNS", exact: true }).click();
        await waitFor(f, () => s.timer.length > 0, "the timer start");
        assert.deepEqual(s.timer[0].with, { plan: "p1f1" });
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
        await missed.getByRole("button", { name: /^Log top-up/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.match(await form.textContent(), /A top-up for the 10:40\sAM feed: part of that feed, not a feed of its own\./);
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "25", "the plan's amount, the smaller of its range");
        await form.getByRole("button", { name: /^Log 25 ml/ }).click();
        await form.waitFor({ state: "hidden" });
        await waitFor(f, () => writes(f).length > 0, "the top-up");
        // The plan says formula or breast milk, so the form's own milk (the last bottle's) stands; the rest is the plan's.
        const { method, amount_ml, via, top_up_of, plan } = writes(f)[0].body.data;
        assert.deepEqual({ method, amount_ml, via, top_up_of, plan }, { method: "bottle", amount_ml: 25, via: "paced", top_up_of: 61, plan: "p1f2" });
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

    ["Feeding plan: a night feed starts with the pump, and then its bottle is next", async () => {
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
        await c.getByRole("button", { name: "Start pumping", exact: true }).click();
        // The start moves the page under the thumb (its timer card comes in above): Today's taps wait out the cooldown.
        assert.equal(await f.page.locator("[data-today-page][data-taps-held]").count(), 1, "the start holds Today's taps for a moment");
        await waitFor(f, () => s.timer.length > 0, "the pump start");
        assert.deepEqual({ ...s.timer[0], client_id: undefined }, { action: "start", kind: "pump", client_id: undefined });
        await c.getByText("Pumping now", { exact: false }).waitFor();
        await f.page.waitForFunction(() => !document.querySelector("[data-taps-held]"));
        await c.getByRole("button", { name: /^Log bottle/ }).click();
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "millilitres", exact: true }).inputValue(), "50", "up to the target: its smaller amount");
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
        assert.match(await c.textContent(), /Top up 25–35 ml/);
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
  ];
}

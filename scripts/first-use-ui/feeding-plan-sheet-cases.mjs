/**
 * The feeding plan's sheet (src/components/maple/feeding/FeedingPlanSheet.tsx): the plan laid out to read, the empty
 * state's two ways to add one, the form (the exact PATCH it sends, only what changed), a refusal shown at the top,
 * another phone's change loaded, removing it, a new plan from a starting shape, ounces sent as ml, the newer options
 * (the night when hungry, turns by the clock, offering the breast, up to and at least, a cup or spoon, feeds and milk
 * in 24 hours) read, kept through an edit and put in on the form, and a viewer who only reads it. The ways in are
 * Settings (Doctor & care plan; Baby details for a viewer) and More.
 *
 * An invented plan, never any family's (scripts/maple-feeding-plan-check.ts's): by day every 2.5 to 3.5 hours, taking
 * turns between "Nurse + SNS" (12–18 min with a nipple shield, 20 ml of formula in the SNS, then pump 15) and "Nurse,
 * top up" (8–12 min each side, then a 25–35 ml paced top-up); at night (11 PM–5 AM) every 3 hours, waking, "Pump +
 * bottle"; a target of 50–70 ml from a "Feeding clinic".
 */
export function feedingPlanSheetCases({ fixture, freshState, assert }) {
  const PLAN = {
    v: 1,
    from: "Feeding clinic",
    check_in: "2026-10-30",
    unit: "ml",
    day: { every: { min: 150, max: 210 } },
    night: { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: "p1f3" },
    feeds: [
      { id: "p1f1", name: "Nurse + SNS", steps: [{ do: "nurse", minutes: { min: 12, max: 18 }, shield: true, supplement: { via: "sns", ml: { min: 20, max: 20 }, milk: "formula" } }, { do: "pump", minutes: { min: 15, max: 15 } }] },
      { id: "p1f2", name: "Nurse, top up", steps: [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced" }] },
      { id: "p1f3", name: "Pump + bottle", steps: [{ do: "pump", minutes: { min: 20, max: 20 } }, { do: "bottle", milk: "breastmilk_first", to_target: true }, { do: "note", text: "Burp halfway" }] },
    ],
    order: ["p1f1", "p1f2"],
    notes: "Weigh at the clinic on Friday.",
    rev: 3,
    updated_at: "2026-10-27T12:00:00.000Z",
  };
  /** The plan as this sheet sends it back untouched (amounts in ml, feeds by their place). */
  const SENT = {
    from: "Feeding clinic",
    check_in: "2026-10-30",
    unit: "ml",
    day: { every: { min: 150, max: 210 } },
    feeds: [
      { id: "p1f1", name: "Nurse + SNS", steps: [{ do: "nurse", minutes: { min: 12, max: 18 }, shield: true, supplement: { via: "sns", ml: { min: 20, max: 20 }, milk: "formula" } }, { do: "pump", minutes: { min: 15, max: 15 } }] },
      { id: "p1f2", name: "Nurse, top up", steps: [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced" }] },
      { id: "p1f3", name: "Pump + bottle", steps: [{ do: "pump", minutes: { min: 20, max: 20 } }, { do: "bottle", to_target: true, milk: "breastmilk_first" }, { do: "note", text: "Burp halfway" }] },
    ],
    order: [1, 2],
    notes: "Weigh at the clinic on Friday.",
    night: { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, feed: 3 },
  };
  /**
   * An invented plan with the newer options: "Nurse" up to 20 min each side; "Practice, then bottle" (the breast offered
   * 5–10 min only if she wants to, then at least 60 ml of breast milk, paced); "Partner's bottle" (up to 90 ml, paced);
   * "Cup feed" (20–30 ml by cup); "Nurse, spoon" (nursing, a 10–15 ml spoon top-up if still hungry, pump up to 15 min);
   * by day every 2.5–3 hours; at night (10 PM–6 AM) every 3 hours, by the clock: "Partner's bottle" from 10 PM, then
   * "Nurse" from 2 AM; at least 8 feeds and 450–550 ml in 24 hours.
   */
  const NEWER = {
    v: 1,
    from: "Feeding clinic",
    unit: "ml",
    day: { every: { min: 150, max: 180 } },
    night: { from: "22:00", to: "06:00", every: { min: 180, max: 180 }, feed: "p1f3", order: ["p1f3", "p1f1"], starts: ["22:00", "02:00"] },
    feeds: [
      { id: "p1f1", name: "Nurse", steps: [{ do: "nurse", minutes: { min: 20, max: 20 }, up_to: true, each_side: true }] },
      { id: "p1f2", name: "Practice, then bottle", steps: [{ do: "nurse", minutes: { min: 5, max: 10 }, if_needed: true }, { do: "bottle", ml: { min: 60, max: 60 }, at_least: true, milk: "breastmilk", via: "paced" }] },
      { id: "p1f3", name: "Partner's bottle", steps: [{ do: "bottle", ml: { min: 90, max: 90 }, up_to: true, milk: "breastmilk", via: "paced" }] },
      { id: "p1f4", name: "Cup feed", steps: [{ do: "bottle", ml: { min: 20, max: 30 }, milk: "breastmilk", by: "cup" }] },
      { id: "p1f5", name: "Nurse, spoon", steps: [{ do: "nurse" }, { do: "bottle", ml: { min: 10, max: 15 }, by: "spoon", if_needed: true }, { do: "pump", minutes: { min: 15, max: 15 }, up_to: true }] },
    ],
    order: ["p1f1", "p1f2", "p1f4", "p1f5"],
    per_day: { feeds: { min: 8 }, ml: { min: 450, max: 550 } },
    notes: "Weigh at the clinic on Friday.",
    rev: 3,
    updated_at: "2026-10-27T12:00:00.000Z",
  };
  /** NEWER as this sheet sends it back untouched: every option as the plan's own keys, feeds by their place. */
  const NEWER_SENT = {
    from: "Feeding clinic",
    unit: "ml",
    day: { every: { min: 150, max: 180 } },
    feeds: NEWER.feeds,
    order: [1, 2, 4, 5],
    per_day: { feeds: { min: 8 }, ml: { min: 450, max: 550 } },
    notes: "Weigh at the clinic on Friday.",
    night: { from: "22:00", to: "06:00", every: { min: 180, max: 180 }, order: [3, 1], starts: ["22:00", "02:00"] },
  };
  const planned = ({ plan = PLAN, target = { min: 50, max: 70 }, role } = {}) => {
    const state = freshState();
    state.baby.settings = { show_alerts: false, ...(plan ? { feeding_plan: structuredClone(plan) } : {}), ...(target ? { feed_target_ml: target } : {}) };
    if (role) {
      state.me = { ...state.me, role };
      state.members = [state.me];
    }
    return state;
  };
  const metric = (f) => f.page.addInitScript(() => localStorage.setItem("maple-units", "metric"));
  /**
   * PATCH /api/maple/baby as the server answers it: the settings merged (null removes), the plan a new revision,
   * the state's rev moved so the next read brings it. `reply(body, n)` answers the nth PATCH some other way.
   */
  const server = (reply) => {
    const patches = [];
    return {
      patches,
      apiResponse: ({ route, req, url, state }) => {
        if (url.pathname === "/api/maple/chat" && req.method() === "GET") return route.fulfill({ json: { current: null, items: [], more: false } });
        if (url.pathname !== "/api/maple/baby" || req.method() !== "PATCH") return route.fulfill({ status: 500, json: { error: "Unexpected synthetic endpoint" } });
        const body = req.postDataJSON();
        patches.push(body);
        const custom = reply?.(body, patches.length, state);
        if (custom) return route.fulfill(custom);
        const settings = { ...state.baby.settings };
        for (const [k, v] of Object.entries(body.settings)) {
          if (k === "feeding_plan_base_rev") continue;
          if (v === null) delete settings[k];
          else if (k === "feeding_plan") {
            const { base_rev: _base, ...plan } = v;
            settings[k] = { v: 1, ...plan, rev: (state.baby.settings.feeding_plan?.rev ?? 0) + 1, updated_at: "2026-10-28T13:30:00.000Z" };
          } else settings[k] = v;
        }
        state.baby = { ...state.baby, settings };
        state.rev = `plan-${patches.length}`;
        return route.fulfill({ json: { baby: state.baby } });
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
  const dialog = (f, name) => f.page.getByRole("dialog", { name, exact: true });
  /** More → Feeding plan. */
  const fromMore = async (f) => {
    await f.page.goto("https://first-use.example.test/#today");
    await f.page.getByRole("button", { name: "More", exact: true }).click();
    await dialog(f, "More to log").getByRole("button", { name: /^Feeding plan/ }).click();
    const sheet = dialog(f, "Feeding plan");
    await sheet.waitFor();
    return sheet;
  };
  /** Settings → a page → Feeding plan. */
  const fromSettings = async (f, page) => {
    await f.page.goto(`https://first-use.example.test/#family/${page}`);
    await f.page.getByRole("button", { name: /^Feeding plan/ }).click();
    const sheet = dialog(f, "Feeding plan");
    await sheet.waitFor();
    return sheet;
  };
  const edit = async (f, sheet) => {
    await sheet.getByRole("button", { name: "Edit the plan", exact: true }).click();
    const form = dialog(f, "Edit the feeding plan");
    await form.waitFor();
    return form;
  };
  const box = (form, name) => form.getByRole("textbox", { name, exact: true });
  /**
   * A field's value once it shows `want`: a stepper or a unit switch updates the field's text in an effect, a frame
   * after the tap, so reading it at once can catch the frame before on a slow machine. Gives up after 2 seconds.
   */
  const shown = async (field, want) => {
    for (let i = 0; i < 40 && (await field.inputValue()) !== want; i++) await field.page().waitForTimeout(50);
    return field.inputValue();
  };
  /** A saved feed starts folded to one line: open it to change it. */
  const unfold = (form, name) => form.getByRole("button", { name: new RegExp(`^${name.replace(/[+]/g, "\\+")}`), expanded: false }).click();

  return [
    ["Feeding plan sheet: the plan reads as its care team wrote it, its feeds in the order they take turns", async () => {
      const f = await fixture({ state: planned(), apiResponse: server().apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /From Feeding clinic · Check-in Fri, Oct 30/);
        assert.match(text, /Target per feed 50–70 ml/);
        assert.match(text, /By day Every 2\.5–3\.5 hours From the start of one feed to the next/);
        assert.match(text, /Taking turns by day 1 Nurse \+ SNS 2 Nurse, top up/);
        // No sex set: the baby's name stands in for "her". When to wake is said in hours, never "by the end".
        assert.match(text, /At night 11 PM to 5 AM · Pump \+ bottle Every 3 hours · wake River if River's still asleep at 3 hours/);
        assert.doesNotMatch(text, /by the end/);
        assert.deepEqual(await sheet.getByRole("article").evaluateAll((list) => list.map((a) => a.getAttribute("aria-label"))), ["Nurse + SNS", "Nurse, top up", "Pump + bottle"]);
        const steps = async (name) => (await sheet.getByRole("article", { name, exact: true }).getByRole("listitem").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
        assert.deepEqual(await steps("Nurse + SNS"), ["1Step 1: Nurse 12–18 min with the nipple shield, 20 ml of formula in the SNS", "2Step 2: Pump 15 min"]);
        assert.deepEqual(await steps("Nurse, top up"), ["1Step 1: Nurse 8–12 min each side", "2Step 2: Top up 25–35 ml, formula or breast milk, paced bottle"]);
        assert.deepEqual(await steps("Pump + bottle"), ["1Step 1: Pump 20 min", "2Step 2: Bottle up to 50–70 ml, breast milk first, then formula to finish", "Burp halfway"]);
        assert.match(await sheet.getByRole("article", { name: "Nurse + SNS", exact: true }).textContent(), /Turn 1/);
        assert.match(await sheet.getByRole("article", { name: "Pump + bottle", exact: true }).textContent(), /At night/);
        assert.match(text, /Notes Weigh at the clinic on Friday\./);
        for (const name of ["Edit the plan", "Change it in the chat", "Remove plan"]) assert(await sheet.getByRole("button", { name, exact: true }).isVisible(), `${name} is offered`);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing scrolls sideways");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: says when to wake her in hours, by day from the start of the last feed, and the form's switches say the same", async () => {
      const plan = structuredClone(PLAN);
      plan.day.wake = true;
      const state = planned({ plan });
      state.baby = { ...state.baby, sex: "female" };
      const f = await fixture({ state, apiResponse: server().apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /By day Every 2\.5–3\.5 hours Wake her if she's still asleep at 3\.5 hours from the start of the last feed/);
        assert.match(text, /At night 11 PM to 5 AM · Pump \+ bottle Every 3 hours · wake her if she's still asleep at 3 hours/);
        const form = await edit(f, sheet);
        const said = (await form.innerText()).replace(/\s+/g, " ");
        assert.match(said, /Wake to feed Wake her if she's still asleep at 3\.5 hours from the start of the last feed\./);
        assert.match(said, /Wake to feed at night Wake her if she's still asleep at 3 hours from the start of the last feed\./);
        // The hint follows the hours as they change.
        await box(form, "hours between feeds by day, to").fill("4");
        assert.match((await form.innerText()).replace(/\s+/g, " "), /Wake to feed Wake her if she's still asleep at 4 hours from the start of the last feed\./);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: with no plan, what it does, Add a plan, or a photo of the plan to the chat", async () => {
      const s = server();
      const f = await fixture({ state: planned({ plan: null, target: null }), apiResponse: s.apiResponse });
      try {
        await f.page.goto("https://first-use.example.test/#today");
        await f.page.getByRole("button", { name: "More", exact: true }).click();
        const row = dialog(f, "More to log").getByRole("button", { name: /^Feeding plan/ });
        assert.match(await row.textContent(), /Add your care team's plan/);
        await row.click();
        const sheet = dialog(f, "Feeding plan");
        await sheet.waitFor();
        assert.match(await sheet.textContent(), /A plan from your care team.*Today then shows which feed is next, when it's due and its steps, one tap each\./);
        assert(await sheet.getByRole("button", { name: "Add a plan", exact: true }).isVisible());
        await sheet.getByRole("button", { name: "Send a photo of your plan to the chat", exact: true }).click();
        await sheet.waitFor({ state: "hidden" });
        const message = f.page.getByRole("textbox", { name: "Message", exact: true });
        await message.waitFor();
        for (let i = 0; i < 40 && !(await message.inputValue()); i++) await f.page.waitForTimeout(50);
        assert.equal(await message.inputValue(), "Please add our feeding plan from this photo, and read it back to me before saving it.");
        assert.equal(s.patches.length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: an edit sends the whole plan in ml with the revision it began from, and the target that changed", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        // Settings → Doctor & care plan → Feeding plan, beside the target per feed.
        await f.page.goto("https://first-use.example.test/#family/doctor");
        const row = f.page.getByRole("button", { name: /^Feeding plan/ });
        assert.match(await row.textContent(), /From Feeding clinic · 3 feeds/);
        await row.click();
        const form = await edit(f, dialog(f, "Feeding plan"));
        // Saved feeds start folded to their steps in the plan's words; a note is its own sentence after them, never "then".
        const folded = form.getByRole("button", { name: /^Pump \+ bottle/, expanded: false });
        assert.match((await folded.innerText()).replace(/\s+/g, " "), /Pump \+ bottle Pump 20 min; then bottle up to 50–70 ml, breast milk first, then formula to finish\. Burp halfway Change/);
        await unfold(form, "Nurse + SNS");
        await unfold(form, "Nurse, top up");
        // One number reads as one box: "15 to [ ] min".
        assert.equal(await box(form, "Nurse + SNS, step 2, pump minutes, from").inputValue(), "15");
        assert.equal(await box(form, "Nurse + SNS, step 2, pump minutes, up to").inputValue(), "");
        await box(form, "Nurse, top up, step 1, nursing minutes, up to").fill("15");
        await box(form, "target per feed, in ml, up to").fill("75");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        const sent = structuredClone(SENT);
        sent.feeds[1].steps[0].minutes = { min: 8, max: 15 };
        assert.deepEqual(s.patches[0], { settings: { feeding_plan: { ...sent, base_rev: 3 }, feed_target_ml: { min: 50, max: 75 } } });
        // Back to the plan, as saved.
        const sheet = dialog(f, "Feeding plan");
        await sheet.waitFor();
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /Nurse 8–15 min each side/);
        assert.match(text, /Target per feed 50–75 ml/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: Save sends only what changed: nothing for an untouched plan, the target alone when only it changed", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        let form = await edit(f, await fromMore(f));
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await dialog(f, "Feeding plan").waitFor();
        assert.equal(s.patches.length, 0, "an untouched plan isn't saved again");
        form = await edit(f, dialog(f, "Feeding plan"));
        await box(form, "target per feed, in ml, from").fill("55");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        assert.deepEqual(s.patches[0], { settings: { feed_target_ml: { min: 55, max: 70 } } });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a plan that can't be saved says why at the top, by the feed it's about; the server's refusal shows there too", async () => {
      const s = server((body, n) => (n === 1 ? { status: 400, json: { error: "Synthetic refusal from the server" } } : null));
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        // Checked here first, in the server's words: nothing is sent.
        await unfold(form, "Nurse, top up");
        await box(form, "Feed 2 name").fill("");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        const alerts = form.getByRole("alert");
        await alerts.first().waitFor();
        assert.deepEqual((await alerts.allTextContents()).map((t) => t.trim()), ["Feed 2's name is needed", "Feed 2's name is needed"], "at the top and by the feed");
        assert.equal(s.patches.length, 0);
        // A feed left only pumping once its bottle is taken out: the server's words, by that feed, and nothing sent.
        await box(form, "Feed 2 name").fill("Nurse, top up");
        await unfold(form, "Pump + bottle");
        await form.getByRole("group", { name: "Feed 3", exact: true }).getByRole("button", { name: "Take out step 2", exact: true }).click();
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await alerts.first().waitFor();
        const dry = `"Pump + bottle" needs nursing or a bottle: a pump on its own goes in the plan's notes`;
        assert.deepEqual((await alerts.allTextContents()).map((t) => t.trim()), [dry, dry], "at the top and by the feed");
        assert.equal(s.patches.length, 0);
        await f.page.getByRole("button", { name: "Put it back", exact: true }).click();
        assert.equal(await alerts.count(), 0, "the bottle back, nothing to say");
        // A night without its hours.
        await box(form, "Feed 2 name").fill("Nurse, top up");
        await form.getByLabel("Night starts", { exact: true }).fill("");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        assert.match(await form.getByRole("alert").first().textContent(), /Say when the night starts and ends/);
        assert.equal(s.patches.length, 0);
        // The server's own refusal, word for word.
        await form.getByLabel("Night starts", { exact: true }).fill("23:00");
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Weigh at the clinic on Thursday.");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        await form.getByText("Synthetic refusal from the server", { exact: true }).waitFor();
        assert(await dialog(f, "Edit the feeding plan").isVisible(), "the form stays open with the changes");
        assert.equal(await form.getByRole("textbox", { name: "Notes", exact: true }).inputValue(), "Weigh at the clinic on Thursday.");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: changed on another phone meanwhile, nothing is saved, and the latest loads to change again", async () => {
      const latest = structuredClone(PLAN);
      latest.feeds[1].name = "Nurse both sides, top up";
      latest.rev = 4;
      const s = server((body, n, state) => {
        if (n !== 1) return null;
        state.baby = { ...state.baby, settings: { ...state.baby.settings, feeding_plan: latest } };
        state.rev = "plan-elsewhere";
        return { status: 409, json: { error: "The feeding plan was changed on another phone. Here's the latest; make your change again.", reason: "plan_changed", feeding_plan: latest } };
      });
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Weigh on Friday.");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        const alert = form.getByRole("alert").filter({ hasText: "another phone" });
        await alert.waitFor();
        assert.match(await alert.textContent(), /The feeding plan was changed on another phone just now, so this wasn't saved\./);
        await alert.getByRole("button", { name: "Load the latest", exact: true }).click();
        await unfold(form, "Nurse both sides, top up");
        assert.equal(await box(form, "Feed 2 name").inputValue(), "Nurse both sides, top up");
        assert.equal(await form.getByRole("textbox", { name: "Notes", exact: true }).inputValue(), "Weigh at the clinic on Friday.");
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Weigh on Friday.");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 1, "the second save");
        const again = s.patches[1].settings.feeding_plan;
        assert.equal(again.base_rev, 4, "the second save names the latest revision");
        assert.equal(again.feeds[1].name, "Nurse both sides, top up");
        assert.equal(again.notes, "Weigh on Friday.");
        assert.equal("feed_target_ml" in s.patches[1].settings, false);
        await dialog(f, "Feeding plan").waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: Remove asks first, then removes only the plan this phone saw", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        await sheet.getByRole("button", { name: "Remove plan", exact: true }).click();
        const confirm = dialog(f, "Remove the feeding plan?");
        await confirm.waitFor();
        assert.match(await confirm.textContent(), /Today stops showing the next feed from it\. Feeds already logged stay as they are\./);
        await confirm.getByRole("button", { name: "Remove plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the removal");
        assert.deepEqual(s.patches[0], { settings: { feeding_plan: null, feeding_plan_base_rev: 3 } });
        await confirm.waitFor({ state: "hidden" });
        await sheet.getByRole("button", { name: "Add a plan", exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a new plan starts from a shape, the kinds of step without numbers, and saves as typed", async () => {
      const s = server();
      const f = await fixture({ state: planned({ plan: null, target: null }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        await sheet.getByRole("button", { name: "Add a plan", exact: true }).click();
        const shapes = dialog(f, "New feeding plan");
        await shapes.getByRole("button", { name: /^Two feeds taking turns/ }).click();
        const form = dialog(f, "New feeding plan");
        await box(form, "Feed 1 name").waitFor();
        assert.equal(await box(form, "Feed 1 name").inputValue(), "Nurse, then pump");
        assert.equal(await box(form, "Feed 2 name").inputValue(), "Nurse, then top up");
        // No numbers made up: every amount and minute is empty until typed.
        for (const name of ["Nurse, then pump, step 1, nursing minutes, from", "Nurse, then pump, step 2, pump minutes, from", "Nurse, then top up, step 2, amount, in ml, from"]) assert.equal(await box(form, name).inputValue(), "");
        await box(form, "Nurse, then pump, step 1, nursing minutes, from").fill("10");
        await box(form, "Nurse, then pump, step 1, nursing minutes, up to").fill("15");
        await box(form, "Nurse, then pump, step 2, pump minutes, from").fill("15");
        await box(form, "Nurse, then top up, step 1, nursing minutes, from").fill("10");
        await form.getByRole("group", { name: "Nurse, then top up, step 1: how", exact: true }).getByRole("button", { name: "Each side", exact: true }).click();
        await box(form, "Nurse, then top up, step 2, amount, in ml, from").fill("25");
        await box(form, "Nurse, then top up, step 2, amount, in ml, up to").fill("35");
        await form.getByRole("button", { name: "Half an hour more, hours between feeds by day, from", exact: true }).click();
        await box(form, "hours between feeds by day, from").fill("2.5");
        await form.getByRole("button", { name: "Half an hour more, hours between feeds by day, to", exact: true }).click();
        assert.equal(await shown(box(form, "hours between feeds by day, to"), "3"), "3", "an empty To goes on from From");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        assert.deepEqual(s.patches[0], {
          settings: {
            feeding_plan: {
              unit: "ml",
              day: { every: { min: 150, max: 180 } },
              feeds: [
                { name: "Nurse, then pump", steps: [{ do: "nurse", minutes: { min: 10, max: 15 } }, { do: "pump", minutes: { min: 15, max: 15 } }] },
                { name: "Nurse, then top up", steps: [{ do: "nurse", minutes: { min: 10, max: 10 }, each_side: true }, { do: "bottle", ml: { min: 25, max: 35 } }] },
              ],
              order: [1, 2],
            },
          },
        });
        await dialog(f, "Feeding plan").waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a plan written in ounces keeps oz and sends its amounts as ml", async () => {
      const s = server();
      // US units on this phone: a new plan starts in oz.
      const f = await fixture({ state: planned({ plan: null, target: null }), apiResponse: s.apiResponse });
      try {
        const sheet = await fromMore(f);
        await sheet.getByRole("button", { name: "Add a plan", exact: true }).click();
        await dialog(f, "New feeding plan").getByRole("button", { name: /^Pump and bottle/ }).click();
        const form = dialog(f, "New feeding plan");
        await box(form, "Pump and bottle, step 2, amount, in oz, from").fill("1");
        await box(form, "Pump and bottle, step 2, amount, in oz, up to").fill("1.5");
        await box(form, "target per feed, in oz, from").fill("2");
        // Switching the unit shows the same amounts in ml, never different ones.
        await form.getByRole("radio", { name: "ml", exact: true }).click();
        assert.equal(await shown(box(form, "Pump and bottle, step 2, amount, in ml, from"), "29.6"), "29.6");
        await form.getByRole("radio", { name: "oz", exact: true }).click();
        assert.equal(await shown(box(form, "Pump and bottle, step 2, amount, in oz, from"), "1"), "1");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        assert.deepEqual(s.patches[0], {
          settings: {
            feeding_plan: { unit: "oz", day: {}, feeds: [{ name: "Pump and bottle", steps: [{ do: "pump" }, { do: "bottle", ml: { min: 29.6, max: 44.4 } }] }], order: [1] },
            feed_target_ml: { min: 59.1, max: 59.1 },
          },
        });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: closing an edited plan asks before the changes go", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Weigh on Thursday.");
        await form.getByRole("button", { name: "Close", exact: true }).first().click();
        const ask = dialog(f, "Discard unsaved changes?");
        await ask.waitFor();
        await ask.getByRole("button", { name: "Keep editing", exact: true }).click();
        assert.equal(await form.getByRole("textbox", { name: "Notes", exact: true }).inputValue(), "Weigh on Thursday.");
        // Cancel asks too, then the plan shows as it was.
        await form.getByRole("button", { name: "Cancel", exact: true }).click();
        await dialog(f, "Discard unsaved changes?").getByRole("button", { name: "Discard changes", exact: true }).click();
        const sheet = dialog(f, "Feeding plan");
        await sheet.waitFor();
        assert.match(await sheet.textContent(), /Weigh at the clinic on Friday\./);
        assert.equal(s.patches.length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a feed taken out can be put back as it was, and a feed holding a typo can't fold away", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        await unfold(form, "Nurse, top up");
        await form.getByRole("button", { name: "Take out Nurse, top up", exact: true }).click();
        assert.equal(await form.getByRole("group", { name: "Feed 3", exact: true }).count(), 0, "two feeds left");
        await f.page.getByRole("button", { name: "Put it back", exact: true }).click();
        await form.getByRole("button", { name: /^Nurse, top up/, expanded: false }).waitFor();
        assert.deepEqual(await form.getByRole("list", { name: "Taking turns by day", exact: true }).getByRole("listitem").allInnerTexts().then((rows) => rows.map((r) => r.replace(/\s+/g, " ").trim())), ["1 Nurse + SNS", "2 Nurse, top up"]);
        // A typo holds the feed open (folding would hide it) and holds Save.
        await unfold(form, "Nurse + SNS");
        await box(form, "Nurse + SNS, step 1, nursing minutes, from").fill("1..2");
        assert(await form.getByRole("button", { name: "Fold Nurse + SNS to one line", exact: true }).isDisabled());
        assert(await form.getByRole("button", { name: "Save the plan", exact: true }).isDisabled());
        await box(form, "Nurse + SNS, step 1, nursing minutes, from").fill("12");
        assert(await form.getByRole("button", { name: "Fold Nurse + SNS to one line", exact: true }).isEnabled());
        // Put back as it was: nothing to save.
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await dialog(f, "Feeding plan").waitFor();
        assert.equal(s.patches.length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a feed whose name still says what an edit took out says so, folded too, and Rename goes to its name", async () => {
      const f = await fixture({ state: planned(), apiResponse: server().apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        await unfold(form, "Nurse + SNS");
        const feed = form.getByRole("group", { name: "Feed 1", exact: true });
        assert.equal(await feed.getByText(/Its name still says/).count(), 0, "the name fits as saved");
        await form.getByRole("group", { name: "Nurse + SNS, step 1: milk at the breast", exact: true }).getByRole("button", { name: "None", exact: true }).click();
        await feed.getByText("Its name still says “SNS”.", { exact: true }).waitFor();
        // Folded, it still says so.
        await form.getByRole("button", { name: "Fold Nurse + SNS to one line", exact: true }).click();
        assert.match((await form.getByRole("button", { name: /^Nurse \+ SNS/, expanded: false }).innerText()).replace(/\s+/g, " "), /Its name still says “SNS”\./);
        await unfold(form, "Nurse + SNS");
        await feed.getByRole("button", { name: "Rename Nurse + SNS", exact: true }).click();
        const name = box(form, "Feed 1 name");
        assert(await name.evaluate((el) => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length), "the name is ready to type over");
        await f.page.keyboard.type("Nurse with the shield");
        assert.equal(await name.inputValue(), "Nurse with the shield");
        assert.equal(await feed.getByText(/Its name still says/).count(), 0, "renamed: nothing to say");
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing scrolls sideways");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: on demand, one side, only if needed and the night's turns read as the plan says them", async () => {
      // On demand by day, at least every 3 hours, waking; the top-up only if she's still hungry; a fourth feed on the
      // left only; at night the feeds take turns.
      const plan = structuredClone(PLAN);
      plan.day = { every: { min: 180, max: 180 }, on_demand: true, wake: true };
      plan.feeds[1].steps[1].if_needed = true;
      plan.feeds.push({ id: "p1f4", name: "Left, pump the right", steps: [{ do: "nurse", minutes: { min: 15, max: 20 }, side: "L" }, { do: "pump", minutes: { min: 15, max: 15 } }] });
      plan.night = { ...plan.night, order: ["p1f3", "p1f4"] };
      const f = await fixture({ state: planned({ plan }), apiResponse: server().apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /By day On demand, at least every 3 hours Wake River if River's still asleep at 3 hours from the start of the last feed/);
        assert.match(text, /At night 11 PM to 5 AM · taking turns 1 Pump \+ bottle 2 Left, pump the right Every 3 hours · wake River if River's still asleep at 3 hours/);
        const steps = async (name) => (await sheet.getByRole("article", { name, exact: true }).getByRole("listitem").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
        assert.deepEqual(await steps("Nurse, top up"), ["1Step 1: Nurse 8–12 min each side", "2Step 2: Top up 25–35 ml if still hungry, formula or breast milk, paced bottle"]);
        assert.deepEqual(await steps("Left, pump the right"), ["1Step 1: Nurse 15–20 min on the left", "2Step 2: Pump 15 min"]);
        assert.match(await sheet.getByRole("article", { name: "Pump + bottle", exact: true }).textContent(), /Night turn 1/);
        assert.match(await sheet.getByRole("article", { name: "Left, pump the right", exact: true }).textContent(), /Night turn 2/);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing scrolls sideways");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: the form takes on demand, one side, only if needed and the night's turns, and sends them as the plan's own keys", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        const form = await edit(f, sheet);
        // By day: on demand, up to 3 hours (it starts from the range's longer end, 3.5).
        const day = form.getByRole("group", { name: "hours between feeds by day: how", exact: true });
        await day.getByRole("button", { name: "On demand, up to", exact: true }).click();
        assert.equal(await box(form, "hours between feeds by day, up to").inputValue(), "3.5");
        assert.match((await form.innerText()).replace(/\s+/g, " "), /When River's hungry, and at least this often\./);
        await box(form, "hours between feeds by day, up to").fill("3");
        // "Nurse, top up": on the left only (each side goes off), its top-up only if she's still hungry.
        await unfold(form, "Nurse, top up");
        await form.getByRole("group", { name: "Nurse, top up, step 1: side", exact: true }).getByRole("button", { name: "Left", exact: true }).click();
        assert.equal(await form.getByRole("group", { name: "Nurse, top up, step 1: how", exact: true }).getByRole("button", { name: "Each side", exact: true }).getAttribute("aria-pressed"), "false");
        await form.getByRole("switch", { name: "Nurse, top up, step 2: only if needed", exact: true }).click();
        // The night's feeds: Pump + bottle, then Nurse + SNS (which leaves the day's turns).
        await form.getByRole("button", { name: "Add Nurse + SNS to the night's turns", exact: true }).click();
        assert.deepEqual(await form.getByRole("list", { name: "The night's feeds", exact: true }).getByRole("listitem").allTextContents(), ["1Pump + bottle", "2Nurse + SNS"]);
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        const sent = structuredClone(SENT);
        sent.day = { every: { min: 180, max: 180 }, on_demand: true };
        sent.feeds[1].steps = [{ do: "nurse", minutes: { min: 8, max: 12 }, side: "L" }, { do: "bottle", ml: { min: 25, max: 35 }, milk: "either", via: "paced", if_needed: true }];
        sent.order = [2];
        sent.night = { from: "23:00", to: "05:00", every: { min: 180, max: 180 }, wake: true, order: [3, 1] };
        assert.deepEqual(s.patches[0], { settings: { feeding_plan: { ...sent, base_rev: 3 } } });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: the newer options read as the read-back says them: by the clock, in 24 hours, offering the breast, up to, at least, a cup and a spoon", async () => {
      const f = await fixture({ state: planned({ plan: NEWER }), apiResponse: server().apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /At night 10 PM to 6 AM · by the clock 1 Partner's bottle from 10 PM 2 Nurse from 2 AM Every 3 hours/);
        assert.match(text, /In 24 hours At least 8 feeds 450–550 ml/);
        const steps = async (name) => (await sheet.getByRole("article", { name, exact: true }).getByRole("listitem").allTextContents()).map((s) => s.replace(/\s+/g, " ").trim());
        assert.deepEqual(await steps("Nurse"), ["1Step 1: Nurse up to 20 min each side"]);
        // After the breast offered only if she wants to, the bottle is the feed's, never a top-up.
        assert.deepEqual(await steps("Practice, then bottle"), ["1Step 1: Offer the breast 5–10 min", "2Step 2: Bottle at least 60 ml, breast milk, paced bottle"]);
        assert.deepEqual(await steps("Partner's bottle"), ["1Step 1: Bottle up to 90 ml, breast milk, paced bottle"]);
        assert.deepEqual(await steps("Cup feed"), ["1Step 1: Cup 20–30 ml, breast milk"]);
        assert.deepEqual(await steps("Nurse, spoon"), ["1Step 1: Nurse", "2Step 2: Top up 10–15 ml by spoon if still hungry", "3Step 3: Pump up to 15 min"]);
        // A night feed by the clock says its time.
        assert.match(await sheet.getByRole("article", { name: "Partner's bottle", exact: true }).textContent(), /Night from 10 PM/);
        assert.match(await sheet.getByRole("article", { name: "Nurse", exact: true }).textContent(), /Turn 1 · night from 2 AM/);
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth), 390, "nothing scrolls sideways");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a plan with the newer options, changed on the form, keeps every one of them", async () => {
      const s = server();
      const f = await fixture({ state: planned({ plan: NEWER }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        // The form opens on each as saved.
        assert.equal(await form.getByRole("switch", { name: "By the clock", exact: true }).getAttribute("aria-checked"), "true");
        assert.deepEqual([await form.getByLabel("Partner's bottle at night, from", { exact: true }).inputValue(), await form.getByLabel("Nurse at night, from", { exact: true }).inputValue()], ["22:00", "02:00"]);
        assert.deepEqual([await box(form, "feeds in 24 hours, at least").inputValue(), await box(form, "feeds in 24 hours, up to").inputValue(), await box(form, "milk in 24 hours, in ml, at least").inputValue(), await box(form, "milk in 24 hours, in ml, up to").inputValue()], ["8", "", "450", "550"]);
        await unfold(form, "Practice, then bottle");
        assert.equal(await form.getByRole("switch", { name: "Practice, then bottle, step 1: only if River wants to", exact: true }).getAttribute("aria-checked"), "true");
        assert.equal(await form.getByRole("group", { name: "Practice, then bottle, step 2: Bottle", exact: true }).count(), 1, "its bottle is the feed's, not a top-up");
        assert.equal(await box(form, "Practice, then bottle, step 2, amount, at least, in ml").inputValue(), "60");
        // Only the notes change.
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Weigh on Friday.");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        const { base_rev: base, ...plan } = s.patches[0].settings.feeding_plan;
        assert.equal(base, 3);
        assert.deepEqual(plan, { ...NEWER_SENT, notes: "Weigh on Friday." });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: the form takes the night when hungry, turns by the clock, offering the breast, up to, at least, a cup, and feeds in 24 hours", async () => {
      const s = server();
      const f = await fixture({ state: planned(), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const form = await edit(f, await fromMore(f));
        // At night: On demand with nothing in Up to is whenever she's hungry, and Wake to feed at night goes.
        const wake = form.getByRole("switch", { name: "Wake to feed at night", exact: true });
        assert(await wake.isVisible());
        assert.match((await form.innerText()).replace(/\s+/g, " "), /Leave empty to keep the day's\. For whenever River's hungry, pick On demand and leave Up to empty\./);
        await form.getByRole("group", { name: "hours between feeds at night: how", exact: true }).getByRole("button", { name: "On demand, up to", exact: true }).click();
        assert.equal(await box(form, "hours between feeds at night, up to").inputValue(), "3");
        assert(await wake.isVisible(), "with a most, waking her stays");
        await box(form, "hours between feeds at night, up to").fill("");
        assert.equal(await shown(box(form, "hours between feeds at night, up to"), ""), "", "cleared, the box stays empty");
        assert.match((await form.innerText()).replace(/\s+/g, " "), /Whenever River's hungry: no set time at night, and no waking River for a feed\./);
        assert.equal(await wake.count(), 0, "no time to wake her by");
        // The night's feeds by the clock: Pump + bottle from 11 PM, then Nurse + SNS from 2 AM.
        await form.getByRole("button", { name: "Add Nurse + SNS to the night's turns", exact: true }).click();
        await form.getByRole("switch", { name: "By the clock", exact: true }).click();
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        assert.match(await form.getByRole("alert").first().textContent(), /Say when each of the night's feeds starts, or switch off By the clock\./);
        assert.equal(s.patches.length, 0);
        await form.getByLabel("Pump + bottle at night, from", { exact: true }).fill("23:00");
        await form.getByLabel("Nurse + SNS at night, from", { exact: true }).fill("02:00");
        // "Nurse, top up": the breast offered only if she wants to; its bottle then the feed's, at least 60 ml, by cup.
        await unfold(form, "Nurse, top up");
        assert.equal(await form.getByRole("group", { name: "Nurse, top up, step 2: Top-up", exact: true }).count(), 1);
        await form.getByRole("switch", { name: "Nurse, top up, step 1: only if River wants to", exact: true }).click();
        assert.equal(await form.getByRole("group", { name: "Nurse, top up, step 2: Bottle", exact: true }).count(), 1, "no longer a top-up");
        await form.getByRole("group", { name: "Nurse, top up, step 2: how much", exact: true }).getByRole("button", { name: "At least", exact: true }).click();
        assert.equal(await box(form, "Nurse, top up, step 2, amount, at least, in ml").inputValue(), "25", "at least starts from the range's From");
        await box(form, "Nurse, top up, step 2, amount, at least, in ml").fill("60");
        await form.getByRole("group", { name: "Nurse, top up, step 2: how it's given", exact: true }).getByRole("button", { name: "Cup", exact: true }).click();
        assert.equal(await form.getByRole("group", { name: "Nurse, top up, step 2: Cup", exact: true }).count(), 1, "named for how it's given");
        // "Nurse + SNS": pump up to 20 min.
        await unfold(form, "Nurse + SNS");
        await form.getByRole("button", { name: "Nurse + SNS, step 2, pump minutes: up to, the most", exact: true }).click();
        assert.equal(await box(form, "Nurse + SNS, step 2, pump minutes, at most").inputValue(), "15");
        await box(form, "Nurse + SNS, step 2, pump minutes, at most").fill("20");
        // In 24 hours: at least 8 feeds, up to 700 ml.
        await box(form, "feeds in 24 hours, at least").fill("8");
        await box(form, "milk in 24 hours, in ml, up to").fill("700");
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        const sent = structuredClone(SENT);
        sent.feeds[0].steps[1] = { do: "pump", minutes: { min: 20, max: 20 }, up_to: true };
        sent.feeds[1].steps = [{ do: "nurse", minutes: { min: 8, max: 12 }, each_side: true, if_needed: true }, { do: "bottle", ml: { min: 60, max: 60 }, at_least: true, milk: "either", by: "cup" }];
        sent.order = [2];
        sent.night = { from: "23:00", to: "05:00", on_demand: true, order: [3, 1], starts: ["23:00", "02:00"] };
        sent.per_day = { feeds: { min: 8 }, ml: { max: 700 } };
        assert.deepEqual(s.patches[0], { settings: { feeding_plan: { ...sent, base_rev: 3 } } });
        // Back to the plan, as saved.
        const sheet = dialog(f, "Feeding plan");
        await sheet.waitFor();
        const text = (await sheet.innerText()).replace(/\s+/g, " ");
        assert.match(text, /At night 11 PM to 5 AM · by the clock 1 Pump \+ bottle from 11 PM 2 Nurse \+ SNS from 2 AM When hungry/);
        assert.match(text, /In 24 hours At least 8 feeds Up to 700 ml/);
        assert.match(text, /Offer each breast 8–12 min/);
        assert.match(text, /Cup at least 60 ml, formula or breast milk/);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a new plan's shapes start with the everyday ones, and Bottle is one bottle feed", async () => {
      const s = server();
      const f = await fixture({ state: planned({ plan: null, target: null }), apiResponse: s.apiResponse });
      try {
        await metric(f);
        const sheet = await fromMore(f);
        await sheet.getByRole("button", { name: "Add a plan", exact: true }).click();
        const shapes = dialog(f, "New feeding plan");
        const titles = await shapes.getByRole("button").evaluateAll((list) => list.map((b) => b.querySelector("span span")?.textContent).filter(Boolean));
        assert.deepEqual(titles, ["Nurse, then top up", "Bottle", "Triple feed", "Pump and bottle", "Two feeds taking turns", "Blank"]);
        await shapes.getByRole("button", { name: /^Bottle Formula or breast milk by bottle/ }).click();
        const form = dialog(f, "New feeding plan");
        await box(form, "Feed 1 name").waitFor();
        assert.equal(await box(form, "Feed 1 name").inputValue(), "Bottle");
        assert.equal(await form.getByRole("group", { name: "Bottle, step 1: Bottle", exact: true }).count(), 1);
        await box(form, "Bottle, step 1, amount, in ml, from").fill("60");
        await box(form, "Bottle, step 1, amount, in ml, up to").fill("90");
        await form.getByRole("group", { name: "Bottle, step 1: milk", exact: true }).getByRole("button", { name: "Formula", exact: true }).click();
        // A long note shows how many characters it holds, of 1,000.
        await form.getByRole("textbox", { name: "Notes", exact: true }).fill("Burp halfway. ".repeat(60).trim());
        await form.getByText("839 of 1,000 characters", { exact: true }).waitFor();
        await form.getByRole("button", { name: "Save the plan", exact: true }).click();
        await waitFor(f, () => s.patches.length > 0, "the save");
        assert.deepEqual(s.patches[0], {
          settings: { feeding_plan: { unit: "ml", day: {}, feeds: [{ name: "Bottle", steps: [{ do: "bottle", ml: { min: 60, max: 90 }, milk: "formula" }] }], order: [1], notes: "Burp halfway. ".repeat(60).trim() } },
        });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Feeding plan sheet: a viewer reads the plan from Baby details, with nothing to change", async () => {
      const f = await fixture({ state: planned({ role: "viewer" }), apiResponse: server().apiResponse });
      try {
        await metric(f);
        const sheet = await fromSettings(f, "baby");
        assert.match(await sheet.textContent(), /Nurse 12–18 min with the nipple shield/);
        for (const name of ["Edit the plan", "Change it in the chat", "Remove plan", "Add a plan"]) assert.equal(await sheet.getByRole("button", { name, exact: true }).count(), 0, `a viewer has no ${name}`);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

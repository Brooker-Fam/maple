/**
 * A duration keeps the start and moves the end in every form that takes one: the chips on sleep, tummy time and
 * pump, a bath's length, and nursing minutes. A start someone set (a saved entry's, or one picked in the form) never
 * moves; the form's own guess (Log earlier's 15 minutes ago) gives way only to a duration that couldn't have finished
 * by now from it, so it just did. Pump has its own cases in pump-review-cases.mjs.
 */
export function durationCases({ fixture, freshState, record, writes, assert }) {
  const origin = "https://first-use.example.test";
  const NOW = Date.parse(freshState().now);
  const MIN = 60_000;
  const created = (kind) => ({ route, req }) => route.fulfill({ json: { entry: record(99, kind, req.postDataJSON().data, req.postDataJSON().started_at, req.postDataJSON()) } });
  const near = (iso, at, what) => assert(Math.abs(Date.parse(iso) - at) < MIN, `${what}: ${iso}`);
  const logEarlier = async (page, label) => {
    await page.goto(`${origin}/#today`);
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("dialog", { name: "More to log", exact: true }).getByRole("button", { name: /^Log earlier/ }).click();
    await page.getByRole("dialog", { name: "Log earlier", exact: true }).getByRole("button", { name: label, exact: true }).click();
  };
  return [
    ["Sleep: a duration keeps the time she fell asleep once it's set, and one that would end after now is off", async () => {
      const f = await fixture({ entryResponse: created("sleep") });
      try {
        await f.page.goto(`${origin}/#log`);
        await f.page.getByRole("group", { name: "Log an earlier one", exact: true }).getByRole("button", { name: "Sleep", exact: true }).click();
        const form = f.page.getByRole("dialog", { name: "Sleep", exact: true });
        const start = form.getByLabel("Fell asleep: time", { exact: true });
        const end = form.getByLabel("Woke up: time", { exact: true });
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        await start.fill("07:00");
        await duration.getByRole("button", { name: "1.5h", exact: true }).click();
        assert.equal(await start.inputValue(), "07:00", "A duration keeps the time she fell asleep");
        assert.equal(await end.inputValue(), "08:30", "A duration moves when she woke");
        assert(await duration.getByRole("button", { name: "3h", exact: true }).isDisabled(), "3h from 7:00 would end after now");
        await duration.getByText("A longer one would end after now. Choose an earlier start first.", { exact: true }).waitFor();
        assert.equal(await start.inputValue(), "07:00");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0].body;
        assert.equal(saved.started_at, "2026-10-28T11:00:00.000Z");
        assert.equal(saved.ended_at, "2026-10-28T12:30:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Sleep: Log earlier's guessed start stays while a duration fits, and gives way to one that can't (she just woke)", async () => {
      const f = await fixture({ entryResponse: created("sleep") });
      try {
        await logEarlier(f.page, "Sleep");
        const form = f.page.getByRole("dialog", { name: "Sleep", exact: true });
        const start = form.getByLabel("Fell asleep: time", { exact: true });
        const end = form.getByLabel("Woke up: time", { exact: true });
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        assert.equal(await start.inputValue(), "09:15");
        for (const name of ["15m", "30m", "1h", "3h"]) assert(await duration.getByRole("button", { name, exact: true }).isEnabled(), `${name} is offered from a guessed start`);
        assert.equal(await duration.getByText(/would end after now/).count(), 0);
        await duration.getByRole("button", { name: "1h", exact: true }).click();
        assert.equal(await start.inputValue(), "08:30", "A duration that can't fit from the guess means she just woke");
        assert.equal(await end.inputValue(), "09:30");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0].body;
        near(saved.ended_at, NOW, "She woke now");
        assert.equal(Date.parse(saved.ended_at) - Date.parse(saved.started_at), 60 * MIN);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Tummy time: the guessed start stays while a duration fits; one picked by hand never moves", async () => {
      const f = await fixture({ entryResponse: created("tummy") });
      try {
        await logEarlier(f.page, "Tummy time");
        const form = f.page.getByRole("dialog", { name: "Tummy time", exact: true });
        const start = form.getByLabel("Started: time", { exact: true });
        const end = form.getByLabel("Ended: time", { exact: true });
        const duration = form.getByRole("group", { name: "Duration", exact: true });
        assert.equal(await start.inputValue(), "09:15");
        await duration.getByRole("button", { name: "10m", exact: true }).click();
        assert.equal(await start.inputValue(), "09:15", "A duration that fits keeps even a guessed start");
        assert.equal(await end.inputValue(), "09:25");
        await duration.getByRole("button", { name: "20m", exact: true }).click();
        assert.equal(await start.inputValue(), "09:10", "Past now from the guess, it just finished");
        assert.equal(await end.inputValue(), "09:30");
        await start.fill("09:05");
        assert(await duration.getByRole("button", { name: "30m", exact: true }).isDisabled(), "From a start picked by hand, 30m would end after now");
        await duration.getByRole("button", { name: "20m", exact: true }).click();
        assert.equal(await start.inputValue(), "09:05");
        assert.equal(await end.inputValue(), "09:25");
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0].body;
        assert.equal(saved.started_at, "2026-10-28T13:05:00.000Z");
        assert.equal(saved.ended_at, "2026-10-28T13:25:00.000Z");
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ...[
      ["sleep", "Slept", "Fell asleep", "Woke up", "1h", "09:00", "2026-10-28T13:00:00.000Z"],
      ["tummy", "Tummy time", "Started", "Ended", "20m", "08:20", "2026-10-28T12:20:00.000Z"],
    ].map(([kind, title, startLabel, endLabel, chip, shownEnd, savedEnd]) => [`Saved ${kind}: a new duration keeps its start and moves only its end`, async () => {
      const state = freshState();
      const original = record(70, kind, {}, "2026-10-28T12:00:00.000Z", { ended_at: "2026-10-28T12:10:00.000Z" });
      state.entries = [original];
      const f = await fixture({ state, records: state.entries, entryResponse: ({ route, req }) => route.fulfill({ json: { entry: { ...original, ...req.postDataJSON() } } }) });
      try {
        await f.page.goto(`${origin}/#log`);
        await f.page.getByRole("button", { name: new RegExp(`^Edit: ${title},`) }).click();
        const form = f.page.getByRole("dialog", { name: title, exact: true });
        await form.getByRole("group", { name: "Duration", exact: true }).getByRole("button", { name: chip, exact: true }).click();
        assert.equal(await form.getByLabel(`${startLabel}: time`, { exact: true }).inputValue(), "08:00");
        assert.equal(await form.getByLabel(`${endLabel}: time`, { exact: true }).inputValue(), shownEnd);
        await form.getByRole("button", { name: "Save", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const patch = writes(f)[0].body;
        assert.equal(patch.started_at, undefined, "The saved start is not rewritten");
        assert.equal(patch.ended_at, savedEnd);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }]),
    ["Bath: Log earlier's guessed start gives way to a length that can't fit, and When follows it", async () => {
      const f = await fixture({ entryResponse: created("bath") });
      try {
        await logEarlier(f.page, "Bath");
        const form = f.page.getByRole("dialog", { name: "Bath", exact: true });
        const pressed = async (name) => (await form.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")) === "true";
        assert(await pressed("15 min ago"));
        await form.getByRole("button", { name: "30m", exact: true }).click();
        assert(await pressed("30 min ago"), "When moves back to fit the length: it just happened");
        assert(!(await pressed("15 min ago")));
        assert.equal(await form.getByText(/ends in the future/).count(), 0);
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0].body;
        near(saved.ended_at, NOW, "The bath ended now");
        assert.equal(Date.parse(saved.ended_at) - Date.parse(saved.started_at), 30 * MIN);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
    ["Nursing: Log earlier's guessed start gives way to minutes that can't fit; a start picked by hand stays and minutes move the end", async () => {
      const f = await fixture({ entryResponse: created("feed") });
      try {
        await logEarlier(f.page, "Nursing");
        const form = f.page.getByRole("dialog", { name: "Feed", exact: true });
        const left = form.getByLabel("minutes on the left", { exact: true });
        const right = form.getByLabel("minutes on the right", { exact: true });
        const start = form.getByLabel("Started: time", { exact: true });
        const end = form.getByLabel("Ended: time", { exact: true });
        assert.equal(await start.inputValue(), "09:15");
        await left.fill("10");
        assert.equal(await start.inputValue(), "09:15", "Minutes that fit keep the guessed start");
        assert.equal(await end.inputValue(), "09:25");
        await left.fill("20");
        assert.equal(await start.inputValue(), "09:10", "Minutes that can't fit from the guess: it just finished");
        assert.equal(await end.inputValue(), "09:30");
        await form.getByRole("group", { name: "Started", exact: true }).getByRole("button", { name: "10 min ago", exact: true }).click();
        assert.equal(await start.inputValue(), "09:20");
        await left.fill("5");
        assert.equal(await start.inputValue(), "09:20", "A start picked by hand stays");
        assert.equal(await end.inputValue(), "09:25", "Its minutes move the end");
        await right.fill("10");
        assert.equal(await start.inputValue(), "09:20", "Minutes past now never move a start picked by hand");
        assert.equal(await end.inputValue(), "09:30", "It ends now instead");
        await form.getByText(/^15 min from 9:20.AM would run past now, so it ends now\./).waitFor();
        await form.getByRole("button", { name: "Log it", exact: true }).click();
        await form.waitFor({ state: "hidden" });
        const saved = writes(f)[0].body;
        near(saved.started_at, NOW - 10 * MIN, "It started when picked");
        near(saved.ended_at, NOW, "It ends now");
        assert.equal(saved.data.left_sec, 5 * 60);
        assert.equal(saved.data.right_sec, 10 * 60);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

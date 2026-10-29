export const NOW = "2026-10-28T13:30:00.000Z";

export function world() {
  const me = { email: "sam@example.test", display_name: "Sam", role: "owner", emoji: null, color: null };
  const state = {
    now: NOW, rev: "synthetic-1", seen_at: null, family: { id: 99, ask: "Sam" },
    baby: { id: 99, name: "River", nickname: null, sex: "female", timezone: "America/New_York", born_at: "2026-10-01T12:00:00.000Z", due_date: "2026-10-01", birth_weight_g: null, birth_length_cm: null, birth_head_cm: null, settings: { show_alerts: false } },
    me, members: [me], entries: [], growth: [], lifetime: { diapers: 0, feeds: 0, firsts: { poop: null, bath: null, tummy: null } },
    care: { person: { member: me.email, name: "Sam", self: true, created_by: me.email }, access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true }, settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [] },
  };
  const controls = { state, requests: [], answerFailure: false, foodFailure: false, historyFailure: false };
  let revision = 1;
  controls.changed = () => { state.rev = `synthetic-${++revision}`; return new Date(Date.parse(NOW) + revision * 1000).toISOString(); };
  controls.question = () => {
    const row = { id: 8051, kind: "question", med_id: null, at: NOW, data: { done: true, answer: "" }, note: "Synthetic question", private: false, created_by: me.email, source: "web", created_at: NOW, updated_at: NOW };
    state.care.entries = [row];
    return row;
  };
  controls.medicine = () => {
    const plan = {
      id: 901, name: "Example medicine", also_called: null, dose_text: null,
      schedule: { type: "as_needed" }, max_24h: null, limit_unit: null, units_per_dose: null,
      label_text: null, reason: null, contains_apap: false, instructions: null,
      course_start: null, course_end: null, show_on_today: true, private: false,
      stopped_at: null, reviewed_at: null, reviewed_by: null, sort: 0,
      created_by: me.email, updated_by: null, source: "web", created_at: NOW, updated_at: NOW,
    };
    state.care.plans = [plan];
    controls.changed();
    return plan;
  };
  controls.answerElsewhere = (answer) => {
    const row = state.care.entries.find((entry) => entry.kind === "question");
    state.care.entries = [{ ...row, data: { ...row.data, answer }, updated_at: controls.changed() }];
  };
  return controls;
}

export async function apiRoute(route, controls) {
  const request = route.request();
  const url = new URL(request.url());
  const { state } = controls;
  const body = request.postDataJSON();
  const method = request.method();
  controls.requests.push({ path: url.pathname, method, family: request.headers()["x-maple-family"], body });
  const json = (value, status = 200) => route.fulfill({ status, json: value });
  if (url.pathname === "/api/maple/auth/me") return json({ signedIn: true, google: false, email: false, apple: false, password: false });
  if (url.pathname === "/api/maple/state") return json(state);
  if (url.pathname === "/api/maple/entries") return json({ entries: [], next_cursor: null, truncated: false });
  if (url.pathname === "/api/maple/chat/consent") return json({ terms: true, care: false, self: true });
  if (url.pathname === "/api/maple/onboarding") return json({ needed: false });
  if (url.pathname === "/api/maple/push") return json({ publicKey: null, sub: null, health: { needs_resubscribe: false }, reminders: [] });
  if (url.pathname === "/api/maple/care/entries") {
    if (method === "GET") return controls.historyFailure ? json({ error: "Synthetic history failure" }, 503) : json({ entries: state.care.entries.filter((entry) => entry.at.startsWith(url.searchParams.get("from"))), tz: state.baby.timezone });
    if (method === "POST") {
      if (controls.foodFailure) return json({ error: "Synthetic food connection failure" }, 503);
      const entry = { ...body, id: 9000, updated_at: controls.changed() };
      state.care.entries.push(entry);
      return json({ created: true, entry, notes: [] }, 201);
    }
    if (method === "PATCH") {
      if (controls.pauseAnswer) await new Promise((resolve) => { controls.releaseAnswer = resolve; });
      if (controls.answerFailure) return json({ error: "Synthetic answer save failure" }, 503);
      const entry = state.care.entries.find((row) => row.id === Number(url.searchParams.get("id")));
      if (entry.updated_at !== body.expect_updated_at) return json({ error: "This entry changed on another device. Here's the latest.", entry }, 409);
      entry.data = { ...entry.data, ...body.data };
      entry.updated_at = controls.changed();
      return json({ entry, notes: [] });
    }
  }
  throw new Error(`Unexpected synthetic endpoint: ${method} ${url.pathname}`);
}

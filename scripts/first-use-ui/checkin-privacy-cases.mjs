export function checkinPrivacyCases({ fixture, freshState, assert }) {
  return [
    ["Daily and fuller check-ins disclose family visibility before an answer", async () => {
      const state = freshState();
      state.care = {
        person: { member: state.me.email, name: "Sam", self: true, created_by: state.me.email },
        access: { self: true, read: true, write: true, private: true, mood: true, therapist: true, manage: true },
        settings: { checkin_suggestions: false }, plans: [], entries: [], mood: [],
      };
      const f = await fixture({ state });
      try {
        await f.page.goto("https://first-use.example.test/#care");
        const disclosure = "Family owners and members can see and edit check-ins, answers and notes. View-only guests can't access them.";
        await f.page.getByRole("heading", { name: "How are you doing?", exact: true }).waitFor();
        assert.equal(await f.page.getByText(disclosure, { exact: true }).count(), 1);
        assert.equal(f.requests.filter((request) => request.pathname === "/api/maple/care/mood").length, 0);
        await f.page.getByRole("button", { name: /A fuller check-in/ }).click();
        const intro = f.page.getByRole("dialog");
        await intro.getByRole("button", { name: "Start", exact: true }).waitFor();
        assert.equal(await intro.getByText(disclosure, { exact: true }).count(), 1);
        assert.equal(f.requests.filter((request) => request.pathname === "/api/maple/care/mood").length, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }],
  ];
}

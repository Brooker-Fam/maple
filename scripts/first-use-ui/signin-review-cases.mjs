export function signinReviewCases({ fixture, assert }) {
  const openEmail = async () => {
    const f = await fixture();
    await f.page.route("**/api/maple/auth/me", (route) => route.fulfill({ json: { signedIn: false, google: false, email: true, apple: false, password: false } }));
    await f.page.route("**/api/maple/state", (route) => route.fulfill({ status: 401, json: { error: "Sign in first" } }));
    await f.page.goto("https://first-use.example.test/maple");
    await f.page.getByRole("button", { name: "Continue with email", exact: true }).click();
    await f.page.getByLabel("Email address", { exact: true }).fill("first@example.test");
    return f;
  };
  return [
    ["Email sign-in keeps its destination fixed during code delivery", async () => {
      const f = await openEmail();
      let release;
      let submitted;
      const pending = new Promise((resolve) => { release = resolve; });
      await f.page.route("**/api/maple/auth/email/start", async (route) => {
        submitted = route.request().postDataJSON();
        await pending;
        await route.fulfill({ json: { ok: true } });
      });
      try {
        await f.page.getByRole("button", { name: "Send a code", exact: true }).click();
        await f.page.getByRole("button", { name: "Sending…", exact: true }).waitFor();
        assert.equal(await f.page.getByLabel("Email address", { exact: true }).isDisabled(), true);
        release();
        await f.page.getByLabel("Six-digit code", { exact: true }).waitFor();
        assert.equal(submitted.email, "first@example.test");
        assert.equal(await f.page.locator('form[aria-label="Sign in with email"] strong').innerText(), submitted.email);
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.close(); }
    }],
    ["Email sign-in keeps the submitted code stable until verification returns", async () => {
      const f = await openEmail();
      let release;
      const pending = new Promise((resolve) => { release = resolve; });
      await f.page.route("**/api/maple/auth/email/start", (route) => route.fulfill({ json: { ok: true } }));
      await f.page.route("**/api/maple/auth/email/verify", async (route) => {
        await pending;
        await route.fulfill({ status: 400, json: { error: "That code didn't work." } });
      });
      try {
        await f.page.getByRole("button", { name: "Send a code", exact: true }).click();
        const input = f.page.getByLabel("Six-digit code", { exact: true });
        await input.fill("123456");
        await f.page.getByRole("button", { name: "Continue", exact: true }).click();
        await f.page.getByRole("button", { name: "Checking…", exact: true }).waitFor();
        assert.equal(await input.isDisabled(), true);
        release();
        await f.page.getByRole("alert").filter({ hasText: "That code didn't work." }).waitFor();
        assert.equal(await input.isDisabled(), false);
        await input.fill("654321");
        assert.equal(await input.inputValue(), "654321");
        assert.deepEqual(f.errors, []);
      } finally { release(); await f.close(); }
    }],
  ];
}

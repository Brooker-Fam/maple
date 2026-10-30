import assert from "node:assert/strict";
import path from "node:path";
import { environment, origin, screenshots } from "./environment.mjs";

/** Today's one-time question and Settings → Send feedback, over the synthetic world (nothing leaves the fixture). */
const env = await environment();
const QUESTION = "How is Maple working for you?";
const sends = (f) => f.controls.requests.filter((request) => request.path === "/api/maple/feedback" && request.method === "POST");
const asks = (f) => f.controls.requests.filter((request) => request.path === "/api/maple/feedback" && request.method === "GET");
const noOverflow = async (page) => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No sideways scrolling");
const today = (f) => f.page.getByRole("heading", { level: 1, name: "River", exact: true }).waitFor();
/** Waits until the app has asked the server and drawn its answer, so an absent question means something. */
async function answered(f) {
  const started = Date.now();
  while (!asks(f).length) {
    if (Date.now() - started > 5000) throw new Error("Today never asked whether to show its question");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await f.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const cases = [
  ["Today stays quiet until the server says it's time, and asks once per visit", async () => {
    const f = await env.visit();
    try {
      await today(f);
      await answered(f);
      assert.equal(await f.page.getByRole("heading", { name: QUESTION, exact: true }).count(), 0);
      await f.page.goto(`${origin}/#chat`);
      await f.page.getByRole("heading", { level: 1, name: "Chat", exact: true }).waitFor();
      await f.page.goto(`${origin}/#today`);
      await today(f);
      await answered(f);
      assert.equal(asks(f).length, 1, "asked once for this page load");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Answering sends the rating and words once, then the question is gone", async () => {
    const f = await env.visit({ feedbackAsk: true });
    try {
      const card = f.page.locator('section[aria-labelledby="feedback-ask"]');
      await card.getByRole("heading", { name: QUESTION, exact: true }).waitFor();
      const send = card.getByRole("button", { name: "Send", exact: true });
      assert.equal(await send.isDisabled(), true, "nothing to send yet");
      await card.getByRole("button", { name: "Okay", exact: true }).click();
      assert.equal(await card.getByRole("button", { name: "Okay", exact: true }).getAttribute("aria-pressed"), "true");
      await card.getByLabel("Anything confusing, missing or great? (optional)").fill("Synthetic words: the diaper colors are hard to tell apart at night.");
      await card.getByText("It goes to the person who makes Maple, with your email address so they can reply.", { exact: true }).waitFor();
      await noOverflow(f.page);
      await f.page.screenshot({ path: path.join(screenshots, "feedback-today-390.png"), fullPage: true, animations: "disabled" });
      await send.click();
      await f.page.getByText("Sent. Thank you.", { exact: true }).waitFor();
      await card.waitFor({ state: "detached" });
      assert.deepEqual(sends(f).map((r) => r.body), [{ via: "prompt", rating: "okay", message: "Synthetic words: the diaper colors are hard to tell apart at night." }]);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Not now puts it off on the server and hides it here", async () => {
    const f = await env.visit({ feedbackAsk: true });
    try {
      const card = f.page.locator('section[aria-labelledby="feedback-ask"]');
      await card.getByRole("button", { name: "Not now", exact: true }).click();
      await card.waitFor({ state: "detached" });
      const started = Date.now();
      while (!sends(f).length && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(sends(f).map((r) => r.body), [{ later: true }]);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["The question keeps out of the night look", async () => {
    const f = await env.visit({ feedbackAsk: true, theme: "night" });
    try {
      await today(f);
      await answered(f);
      assert.equal(await f.page.getByRole("heading", { name: QUESTION, exact: true }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Settings → Send feedback writes, sends from the sheet, and keeps email one tap away", async () => {
    for (const role of [undefined, "photos"]) {
      const f = await env.visit({ hash: "family/about", role });
      try {
        await f.page.getByRole("button", { name: /^Send feedback/ }).click();
        const sheet = f.page.getByRole("dialog", { name: "Send feedback" });
        await sheet.waitFor();
        const send = f.page.getByRole("button", { name: "Send", exact: true });
        assert.equal(await send.isDisabled(), true, "nothing typed yet");
        assert.equal(await sheet.getByRole("link", { name: "Or email hello@maplebaby.app" }).getAttribute("href"), "mailto:hello@maplebaby.app?subject=Maple%20feedback");
        await sheet.getByRole("button", { name: "An idea", exact: true }).click();
        await sheet.getByLabel("Your feedback").fill("Synthetic idea: a weekly pumping total.");
        await noOverflow(f.page);
        if (!role) await f.page.screenshot({ path: path.join(screenshots, "feedback-sheet-390.png"), animations: "disabled" });
        await send.click();
        await f.page.getByText("Sent. Thank you.", { exact: true }).waitFor();
        await sheet.waitFor({ state: "detached" });
        assert.deepEqual(sends(f).map((r) => r.body), [{ via: "app", topic: "idea", message: "Synthetic idea: a weekly pumping total." }]);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }],
];

let failures = 0;
try {
  for (const [name, check] of cases) {
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  if (!failures) {
    for (const width of [320, 1024]) {
      const f = await env.visit({ feedbackAsk: true, width });
      try {
        await f.page.getByRole("heading", { name: QUESTION, exact: true }).waitFor();
        await noOverflow(f.page);
      } finally { await f.close(); }
    }
    console.log("PASS feedback layouts at 320 and 1024");
  }
} finally { await env.close(); }
if (failures) process.exitCode = 1;

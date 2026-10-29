import assert from "node:assert/strict";
import path from "node:path";
import { environment, origin, screenshots } from "./environment.mjs";

const env = await environment();
const trigger = (page) => page.getByRole("button", { name: "Account menu", exact: true });
const menu = (page) => page.getByRole("menu", { name: "Account menu", exact: true });
const openMenu = async (page) => { await trigger(page).click(); await menu(page).waitFor(); };
const menuItem = (page, name) => menu(page).getByRole("menuitem", { name, exact: true });
const signouts = (controls) => controls.requests.filter((request) => request.path === "/api/maple/auth/signout");
const titles = { today: "River", care: "Sam", "history/timeline": "History", "history/patterns": "History", moments: "Moments", chat: "Chat", family: "Settings", "family/baby": "Baby details", "family/appearance": "Appearance & units", "family/assistants": "Siri & assistants" };
async function navigate(page, hash) {
  await page.goto(`${origin}/#${hash}`);
  await page.getByRole("heading", { level: 1, name: titles[hash], exact: true }).waitFor();
}

const cases = [
  ["Account menu replaces the Settings tab and stays reachable on every page", async () => {
    const f = await env.visit();
    try {
      for (const hash of ["today", "care", "history/timeline", "history/patterns", "moments", "chat", "family", "family/baby"]) {
        await navigate(f.page, hash);
        await trigger(f.page).waitFor();
        assert.equal(await trigger(f.page).count(), 1, `Exactly one account entry on ${hash}`);
        assert.equal(await f.page.getByRole("navigation", { name: "Maple's Log" }).getByRole("button", { name: "Settings", exact: true }).count(), 0);
        await openMenu(f.page);
        await menuItem(f.page, "Settings").waitFor();
        await menuItem(f.page, "Sign out").waitFor();
        await f.page.keyboard.press("Escape");
        await menu(f.page).waitFor({ state: "hidden" });
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Keyboard and outside dismissal restore account-menu focus", async () => {
    const f = await env.visit();
    try {
      await trigger(f.page).focus();
      await f.page.keyboard.press("Enter");
      await menu(f.page).waitFor();
      assert.equal(await menuItem(f.page, "Settings").evaluate((el) => el === document.activeElement), true);
      await f.page.keyboard.press("Shift+Tab");
      await menu(f.page).waitFor({ state: "hidden" });
      await f.page.keyboard.press("Enter");
      await menu(f.page).waitFor();
      await f.page.keyboard.press("ArrowDown");
      assert.equal(await menuItem(f.page, "Sign out").evaluate((el) => el === document.activeElement), true);
      await f.page.keyboard.press("Escape");
      assert.equal(await trigger(f.page).evaluate((el) => el === document.activeElement), true);
      await openMenu(f.page);
      await f.page.getByRole("heading", { level: 1 }).click();
      await menu(f.page).waitFor({ state: "hidden" });
      await openMenu(f.page);
      await menuItem(f.page, "Settings").click();
      await f.page.getByRole("heading", { level: 1, name: "Settings", exact: true }).waitFor();
      await menu(f.page).waitFor({ state: "hidden" });
      await f.page.goBack();
      assert.equal(new URL(f.page.url()).hash, "#today");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Account sign-out and navigation preserve an unsaved settings draft", async () => {
    const f = await env.visit({ hash: "family/baby" });
    try {
      await trigger(f.page).waitFor();
      await f.page.getByLabel("Name", { exact: true }).fill("River unsaved");
      const prompts = [];
      f.page.on("dialog", async (dialog) => { prompts.push(dialog.message()); await dialog.dismiss(); });
      await openMenu(f.page);
      await menuItem(f.page, "Sign out").click();
      assert.equal(signouts(f.controls).length, 0);
      assert.equal(await f.page.getByLabel("Name", { exact: true }).inputValue(), "River unsaved");
      assert.equal(prompts.length, 1);
      await f.page.getByRole("navigation").getByRole("button", { name: "Today", exact: true }).click();
      assert.equal(await f.page.getByLabel("Name", { exact: true }).inputValue(), "River unsaved");
      assert.equal(prompts.length, 2);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Invite guests see recovery guidance before account-menu sign-out", async () => {
    const f = await env.visit({ guest: true });
    try {
      await openMenu(f.page);
      await menuItem(f.page, "Sign out").click();
      const warning = f.page.getByRole("dialog", { name: "Sign out?", exact: true });
      await warning.getByText(/new invite/).waitFor();
      assert.equal(signouts(f.controls).length, 0);
      await warning.getByRole("button", { name: "Stay signed in", exact: true }).click();
      await warning.waitFor({ state: "hidden" });
      assert.equal(signouts(f.controls).length, 0);
      await openMenu(f.page);
      await menuItem(f.page, "Settings").click();
      assert.equal(await f.page.getByRole("button", { name: /^On Today/ }).count(), 0);
      assert.equal(await f.page.getByRole("button", { name: /^Siri & assistants/ }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Failed account-menu sign-out can be retried", async () => {
    const f = await env.visit();
    try {
      f.controls.signoutFailure = true;
      await openMenu(f.page);
      await menuItem(f.page, "Sign out").click();
      await f.page.getByText("Couldn't confirm sign-out. Try again.", { exact: true }).waitFor();
      assert.equal(f.controls.signedIn, true);
      f.controls.signoutFailure = false;
      if (!await menu(f.page).isVisible()) await openMenu(f.page);
      await menuItem(f.page, "Sign out").click();
      await trigger(f.page).waitFor({ state: "hidden" });
      assert.equal(f.controls.signedIn, false);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
];

async function layouts() {
  let count = 0;
  for (const width of [320, 390, 1024]) {
    for (const theme of ["light", "dark", "night"]) {
      const f = await env.visit({ width, theme });
      try {
        await openMenu(f.page);
        for (const [label, hash] of [["menu", null], ["settings", "family"], ["appearance", "family/appearance"], ["siri", "family/assistants"]]) {
          if (hash) {
            await navigate(f.page, hash);
          }
          assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} fits ${width}px in ${theme}`);
          const box = await trigger(f.page).boundingBox();
          assert(box && box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= width, "Avatar is a visible 44px target");
          await f.page.waitForFunction(() => [...document.querySelectorAll("h1")].filter((el) => el.checkVisibility()).every((el) => {
            for (let parent = el; parent; parent = parent.parentElement) if (Number(getComputedStyle(parent).opacity) < 1) return false;
            return true;
          }));
          await f.page.screenshot({ path: path.join(screenshots, `${width}-${theme}-${label}.png`), fullPage: true, animations: "disabled" });
          count++;
        }
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  }
  console.log(`PASS ${count} responsive settings layouts`);
}

let failures = 0;
try {
  for (const [name, run] of cases) {
    if (process.env.SETTINGS_CASE && !name.includes(process.env.SETTINGS_CASE)) continue;
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  if (!process.env.SETTINGS_BASELINE_REF && !process.env.SETTINGS_CASE && !failures) await layouts();
} finally { await env.close(); }
if (failures) process.exitCode = 1;

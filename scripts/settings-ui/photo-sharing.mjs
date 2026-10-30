import assert from "node:assert/strict";
import path from "node:path";
import { environment, origin, screenshots } from "./environment.mjs";

const env = await environment();
const cases = [
  ["Photo guests open Moments and cannot navigate to health or chat screens", async () => {
    const f = await env.visit({ role: "photos" });
    try {
      for (const hash of ["today", "care", "history/timeline", "chat"]) {
        await f.page.goto(`${origin}/#${hash}`);
        await f.page.getByRole("heading", { level: 1, name: "Moments", exact: true }).waitFor();
        const nav = f.page.getByRole("navigation", { name: "Maple's Log" });
        assert.deepEqual(await nav.getByRole("button").allTextContents(), ["Moments"]);
      }
      assert.equal(f.controls.requests.some((request) => request.path.startsWith("/api/maple/care/") || request.path === "/api/maple/chat"), false);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Photo guest settings expose only account, appearance and people", async () => {
    const f = await env.visit({ role: "photos", hash: "family" });
    try {
      await f.page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      for (const label of [/Baby details/, /Doctor & care plan/, /On Today/, /Siri & assistants/, /Chat privacy/, /Daily discoveries/, /Help and doctor/]) {
        assert.equal(await f.page.getByRole("button", { name: label }).count(), 0);
      }
      await f.page.getByRole("button", { name: /^Sign-in & account/ }).click();
      assert.equal(await f.page.getByRole("link", { name: /Download.*log/ }).count(), 0);
      await f.page.goto(`${origin}/#family/people`);
      await f.page.getByRole("heading", { name: "People & permissions", exact: true }).waitFor();
      assert.equal(await f.page.getByRole("button", { name: "Invite by email", exact: true }).count(), 0);
      await f.page.getByRole("button", { name: "Edit", exact: true }).click();
      await f.page.getByLabel("Your name").fill("Synthetic photo guest");
      await f.page.getByRole("button", { name: "Save", exact: true }).click();
      assert.equal(f.controls.requests.find((request) => request.path === "/api/maple/members" && request.method === "PATCH").body.display_name, "Synthetic photo guest");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["New email and one-time-link invitations default to Photos only", async () => {
    const f = await env.visit({ hash: "family/people" });
    try {
      await f.page.getByRole("heading", { name: "People & permissions", exact: true }).waitFor();
      assert.equal(await f.page.getByRole("radio", { name: /^Photos only/ }).isChecked(), true);
      await f.page.getByLabel("Their email address").fill("synthetic-guest@example.test");
      await f.page.getByRole("button", { name: "Invite by email", exact: true }).click();
      await f.page.getByText(/Send synthetic-guest@example.test this link/).waitFor();
      assert.equal(f.controls.requests.find((request) => request.path === "/api/maple/members" && request.method === "POST").body.role, "photos");
      await f.page.getByRole("button", { name: /Invite with a one-time link/ }).click();
      const sheet = f.page.getByRole("dialog", { name: "Invite with a link", exact: true });
      assert.equal(await sheet.getByRole("radio", { name: /^Photos only/ }).isChecked(), true);
      await sheet.getByLabel("Their name").fill("Synthetic Grandma");
      await sheet.getByRole("button", { name: "Create invite link" }).click();
      await f.page.getByRole("dialog", { name: "Link ready", exact: true }).waitFor();
      assert.equal(f.controls.requests.find((request) => request.path === "/api/maple/invites" && request.method === "POST").body.role, "photos");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["An owner makes a member an owner only after confirming, and the row then reads Owner", async () => {
    const f = await env.visit({ hash: "family/people" });
    try {
      f.controls.state.members = [f.controls.state.me, { email: "synthetic-helper@example.test", role: "member", display_name: "Synthetic Helper", emoji: null, color: null }];
      f.controls.changed();
      await f.page.reload();
      await f.page.getByRole("heading", { name: "People & permissions", exact: true }).waitFor();
      await f.page.getByRole("button", { name: "Manage Synthetic Helper", exact: true }).click();
      await f.page.getByRole("button", { name: "Make owner", exact: true }).click();
      await f.page.getByText(/Make Synthetic Helper an owner\? .*Another owner can't change or remove them afterwards\./).waitFor();
      assert.equal(f.controls.requests.some((request) => request.path === "/api/maple/members" && request.method === "PATCH"), false, "nothing changes before the second tap");
      await f.page.getByRole("button", { name: "Keep", exact: true }).click();
      await f.page.getByRole("button", { name: "Make owner", exact: true }).click();
      await f.page.getByRole("button", { name: "Make owner", exact: true }).nth(0).click();
      await f.page.getByText("Synthetic Helper is now an owner").waitFor();
      assert.deepEqual(f.controls.requests.filter((request) => request.path === "/api/maple/members" && request.method === "PATCH").map((request) => request.body), [{ email: "synthetic-helper@example.test", role: "owner" }]);
      await f.page.getByText("Owner · can invite and manage · synthetic-helper@example.test", { exact: true }).waitFor();
      assert.equal(await f.page.getByRole("button", { name: "Manage Synthetic Helper", exact: true }).count(), 0, "an owner has nothing to manage");
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
  ["Downgrading an open Chat to Photos only removes the retained chat", async () => {
    const f = await env.visit({ hash: "chat" });
    try {
      await f.page.getByRole("heading", { level: 1, name: "Chat", exact: true }).waitFor();
      f.controls.state.me.role = "photos";
      f.controls.state.care = null;
      f.controls.state.entries = [];
      f.controls.changed();
      await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await f.page.getByRole("heading", { level: 1, name: "Moments", exact: true }).waitFor({ timeout: process.env.SETTINGS_BASELINE_REF ? 1500 : 15000 });
      assert.equal(await f.page.getByRole("heading", { name: "Chat", exact: true, includeHidden: true }).count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }],
];

let failures = 0;
try {
  for (const [name, check] of cases) {
    try { await check(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
  }
  if (!process.env.SETTINGS_BASELINE_REF && !failures) {
    for (const width of [320, 390, 1024]) {
      for (const theme of ["light", "dark", "night"]) {
        const f = await env.visit({ hash: "family/people", width, theme });
        try {
          await f.page.getByRole("radio", { name: /^Photos only/ }).waitFor();
          assert(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          await f.page.screenshot({ path: path.join(screenshots, `sharing-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
        } finally { await f.close(); }
      }
    }
    console.log("PASS 9 sharing layouts");
  }
} finally { await env.close(); }
if (failures) process.exitCode = 1;

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const postcss = require("postcss");
const tailwind = require("@tailwindcss/postcss");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const output = await mkdtemp(path.join(tmpdir(), "maple-admin-ui-"));
const screenshots = path.join(root, "test-results/maple-admin-ui");
await mkdir(screenshots, { recursive: true });
await rm(path.join(screenshots, "failure.png"), { force: true });
await build({
  entryPoints: [path.join(here, "fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-admin-boundaries", setup(plugin) {
    plugin.onResolve({ filter: /^(?:next\/link)$|(?:^|\/)useMaple$/ }, () => ({ path: path.join(here, "mocks.jsx") }));
  } }],
});
const css = path.join(root, "src/app/globals.css");
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(css, "utf8"), { from: css });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + await readFile(path.join(root, "src/app/maple/maple.css"), "utf8"));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maple synthetic admin checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');

const NOW = "2026-10-28T16:00:00.000Z";
const metrics = {
  generatedAt: NOW,
  families: { total: 14, signedUp7d: 3, signedUp30d: 9, onboarding: 4, setupComplete: 9, deleting: 1 },
  people: { total: 26 }, waitlist: { total: 2 },
  activity: { families7d: 6, families30d: 10, entries30d: 253 },
  dailySignups: Array.from({ length: 28 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, count: index % 6 === 0 ? 2 : 0 })),
};
// Recipient addresses live only in this Node fixture. Lists/previews never supply them.
const emails = new Map([
  ["synthetic-person-1", "a.long.synthetic.person.address.for.mobile.wrapping@example.test"],
  ["synthetic-person-2", "another.person@example.test"],
  ["synthetic-person-26", "page.two@example.test"],
  ["synthetic-family-21", "family.owner@example.test"],
  ["synthetic-waitlist-31", "waitlist.person@example.test"],
  ["synthetic-waitlist-32", "second.waitlist.person@example.test"],
]);
const waitlist = [31, 32].map((id) => ({ kind: "waitlist", id, ref: `synthetic-waitlist-${id}`, emailMasked: "w•••@•••", createdAt: NOW }));
const families = [{ kind: "family", id: 21, ref: "synthetic-family-21", emailMasked: "f•••@•••", createdAt: NOW, status: "active", members: 2 }];
const people = Array.from({ length: 26 }, (_, index) => ({ kind: "person", ref: `synthetic-person-${index + 1}`, emailMasked: "a•••@•••", familyIds: [21], joinedAt: NOW, lastSeenAt: NOW }));
const preview = (reason = null) => ({
  subject: "Your Maple invitation is ready", text: "Hello,\n\nMaple is ready for your family. Create your own baby log when you’re ready.\n\nhttps://maple.example.test/signup\n\nYou joined the Maple waitlist. No reply is needed.",
  from: "Maple <hello@example.test>", replyTo: "support@example.test", toMasked: "w•••@•••",
  sendToken: reason ? null : "synthetic-reviewed-send-token", canSend: !reason, reason,
  sentAt: reason === "already_sent" ? NOW : null,
});

const browser = await chromium.launch({ headless: true, ...(process.env.MAPLE_UI_CHROMIUM ? { executablePath: process.env.MAPLE_UI_CHROMIUM } : {}) });
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC", serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(7000);
const errors = [];
const calls = [];
let revealFailure = null;
let detailsFailure = null;
let previewFailure = null;
let previewReason = null;
let sendOutcome = "deferred";
let pendingSend = null;
page.on("pageerror", (error) => errors.push(error.message));
const origin = "https://maple-admin-ui.example.test";
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin) {
    errors.push(`Blocked an outside request: ${url.origin}`);
    return route.abort();
  }
  if (url.pathname.startsWith("/api/")) {
    const call = { path: url.pathname, method: request.method(), query: Object.fromEntries(url.searchParams), body: request.postDataJSON() };
    calls.push(call);
    if (call.path === "/api/maple/admin/metrics" && call.method === "GET") return json(route, metrics);
    if (call.path === "/api/maple/admin/details" && call.method === "GET") {
      if (detailsFailure) return json(route, { code: detailsFailure.code }, detailsFailure.status);
      const { view } = call.query;
      const currentPage = Number(call.query.page);
      const rows = view === "people" ? people : view === "waitlist" ? waitlist : families;
      return json(route, { view, page: currentPage, pageSize: 25, total: rows.length, rows: rows.slice((currentPage - 1) * 25, currentPage * 25) });
    }
    if (call.path === "/api/maple/admin/reveal" && call.method === "POST") {
      if (revealFailure) return json(route, { code: revealFailure.code }, revealFailure.status);
      const email = emails.get(call.body.ref);
      return json(route, email ? { email } : { code: "not_found" }, email ? 200 : 404);
    }
    if (call.path === "/api/maple/admin/waitlist/preview" && call.method === "POST") {
      if (previewFailure) return json(route, { code: "preview_unavailable" }, previewFailure);
      return json(route, preview(previewReason));
    }
    if (call.path === "/api/maple/admin/waitlist/send" && call.method === "POST") {
      if (sendOutcome === "deferred") { pendingSend = route; return; }
      if (sendOutcome === "network") return route.abort("failed");
      if (sendOutcome === "expired") return json(route, { code: "preview_expired" }, 409);
      return json(route, { status: sendOutcome, sentAt: sendOutcome === "sent" ? NOW : null });
    }
    errors.push(`Blocked an unexpected API request: ${call.method} ${call.path}`);
    return route.abort();
  }
  const file = ["/app.js", "/app.css"].includes(url.pathname) ? url.pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
const count = (suffix) => calls.filter((call) => call.path === `/api/maple/admin/${suffix}`).length;
const button = (name) => page.getByRole("button", { name, exact: true });
const details = () => page.locator('section[aria-labelledby="admin-details-title"]');
const invitation = () => page.getByRole("region", { name: "Preview launch invitation", exact: true });
const rawEmail = emails.get("synthetic-person-1");
const noRecipientEmails = async () => {
  const html = await page.content();
  for (const email of emails.values()) assert(!html.includes(email), "Unrevealed recipient emails must be absent from all HTML, including attributes");
};
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Admin must fit the viewport, including revealed addresses");
const open = async (label, title) => {
  await button(label).click();
  await page.getByRole("heading", { name: title, exact: true, level: 2 }).waitFor();
  await details().getByRole("button", { name: "Refresh list", exact: true }).waitFor();
  await details().getByRole("button", { name: "Reveal email", exact: true }).first().waitFor();
};
const revealFirst = async () => {
  await details().getByRole("button", { name: "Reveal email", exact: true }).first().click();
  await details().getByRole("button", { name: "Hide email", exact: true }).first().waitFor();
};
const openPreview = async () => {
  if (await invitation().count()) await button("Close invitation preview").click();
  await details().getByRole("button", { name: "Preview invitation", exact: true }).first().click();
  await invitation().getByText("Your Maple invitation is ready", { exact: true }).waitFor();
};
const reset = async () => {
  revealFailure = detailsFailure = previewFailure = previewReason = null;
  sendOutcome = "deferred";
  await page.goto(origin);
  await button("View people").waitFor();
};

try {
  await reset();
  assert.equal(count("details"), 0, "Opening aggregate metrics must not prefetch identities");
  assert.equal(count("reveal"), 0);
  await noRecipientEmails();
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "overview-375.png"), fullPage: true });
  await button("View people").focus();
  await page.keyboard.press("Enter");
  await details().getByText("Account 1", { exact: true }).waitFor();
  assert.equal(await page.locator("#admin-details-title").evaluate((node) => node === document.activeElement), true, "A keyboard-opened list must focus its heading");
  assert.deepEqual(calls.at(-1).query, { view: "people", filter: "all", page: "1" });
  assert.equal(count("reveal"), 0, "Listing masked accounts must not reveal addresses");
  await noRecipientEmails();
  await details().getByRole("button", { name: "Reveal email", exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await page.getByText(rawEmail, { exact: true }).waitFor();
  assert.deepEqual(calls.at(-1).body, { ref: "synthetic-person-1" });
  assert.equal(count("reveal"), 1);
  await noOverflow();
  await button("Hide email").click();
  await page.getByText(rawEmail, { exact: true }).waitFor({ state: "hidden" });
  assert.equal(count("reveal"), 1, "Hide is local and never fetches identity again");
  await noRecipientEmails();
  await revealFirst();
  await button("Next").click();
  await details().getByText("Account 26", { exact: true }).waitFor();
  assert.equal(calls.at(-1).query.page, "2");
  await noRecipientEmails();
  await revealFirst();
  await button("Previous").click();
  await details().getByText("Account 1", { exact: true }).waitFor();
  await noRecipientEmails();
  await revealFirst();
  await details().getByRole("button", { name: "Families", exact: true }).click();
  await details().getByText("Family 21", { exact: true }).waitFor();
  await noRecipientEmails();
  await revealFirst();
  await page.getByRole("combobox", { name: "Filter families", exact: true }).selectOption("active7d");
  await details().getByRole("button", { name: "Reveal email", exact: true }).waitFor();
  assert.equal(calls.at(-1).query.filter, "active7d");
  await noRecipientEmails();
  await revealFirst();
  await button("Refresh list").click();
  await details().getByRole("button", { name: "Reveal email", exact: true }).waitFor();
  await noRecipientEmails();
  await revealFirst();
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await button("Hide email").waitFor({ state: "hidden" });
  await noRecipientEmails();
  await revealFirst();
  await button("Close details").click();
  await details().waitFor({ state: "hidden" });
  await noRecipientEmails();
  console.log("PASS drilldowns: keyboard launch, masked responses, explicit reveal/hide, pagination, filters, refresh, page leave and close clear identities");

  await open("View new families in 7 days", "Families");
  assert.equal(calls.at(-1).query.filter, "7d");
  await open("View waitlist", "Waitlist");
  assert.equal(count("waitlist/preview"), 0, "Opening the waitlist must not prepare an email");
  await openPreview();
  assert.equal(count("waitlist/preview"), 1);
  assert.equal(count("waitlist/send"), 0, "Previewing must never send an email");
  assert.deepEqual(calls.at(-1).body, { ref: "synthetic-waitlist-31" });
  await noRecipientEmails();
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "preview-375.png"), fullPage: true });
  await invitation().getByRole("button", { name: "Reveal email", exact: true }).click();
  await invitation().getByText(emails.get("synthetic-waitlist-31"), { exact: true }).waitFor();
  await button("Close invitation preview").click();
  await noRecipientEmails();
  await openPreview();
  await button("Send invitation").focus();
  await page.keyboard.press("Enter");
  await button("Sending…").waitFor();
  assert(await button("Sending…").isDisabled(), "The pending send must disable its control");
  await button("Sending…").evaluate((node) => { node.click(); node.click(); });
  assert.equal(count("waitlist/send"), 1, "Repeated clicks while pending must not send twice");
  assert.deepEqual(calls.at(-1).body, { sendToken: "synthetic-reviewed-send-token" }, "Only the reviewed token, never a typed recipient, is submitted");
  assert(pendingSend, "The explicit send must reach the mocked endpoint");
  await json(pendingSend, { status: "sent", sentAt: NOW });
  pendingSend = null;
  await invitation().getByText("Invitation sent to the email provider. Delivery can be checked in Resend.", { exact: true }).waitFor();
  assert.equal(await button("Send invitation").count(), 0, "A confirmed send cannot be repeated from the same preview");
  await noRecipientEmails();
  await button("Done").click();
  console.log("PASS invitation: preview and recipient reveal are separate, keyboard send is explicit, pending sends lock, confirmed sends cannot repeat");

  const sendCount = count("waitlist/send");
  for (const reason of ["already_sent", "already_signed_up", "send_pending", "delivery_unknown", "email_unavailable", "signup_closed"]) {
    previewReason = reason;
    await openPreview();
    assert.equal(await button("Send invitation").count(), 0, `${reason} must not expose a send control`);
  }
  assert.equal(count("waitlist/send"), sendCount, "Ineligible previews must not issue sends");
  previewReason = null;
  sendOutcome = "expired";
  await openPreview();
  await button("Send invitation").click();
  await invitation().getByRole("alert").waitFor();
  assert.equal(await button("Send invitation").count(), 0);
  const beforeRefresh = count("waitlist/send");
  await button("Review fresh preview").click();
  await button("Send invitation").waitFor();
  assert.equal(count("waitlist/send"), beforeRefresh, "Refreshing an expired preview must not resend automatically");
  sendOutcome = "network";
  await button("Send invitation").click();
  await invitation().getByText("The last send couldn’t be confirmed. Check Resend before sending anything else to this contact.", { exact: true }).waitFor();
  assert.equal(await button("Send invitation").count(), 0, "An ambiguous send must not offer an immediate resend");
  const beforeStatus = count("waitlist/send");
  previewReason = "send_pending";
  await button("Check status").click();
  await invitation().getByText("A send is already in progress or awaiting confirmation. Check its status before taking any further action.", { exact: true }).waitFor();
  assert.equal(count("waitlist/send"), beforeStatus, "Checking uncertain status is preview-only");
  await noOverflow();
  console.log("PASS invitation outcomes: accepted account, sent, pending, unknown, unavailable and closed signup block send; expired/network responses require review without automatic retries");

  await button("Close invitation preview").click();
  previewFailure = 503;
  await details().getByRole("button", { name: "Preview invitation", exact: true }).first().click();
  await invitation().getByRole("alert").waitFor();
  assert.equal(await button("Send invitation").count(), 0, "An unavailable preview cannot send");
  await button("Close invitation preview").click();
  previewFailure = null;
  await revealFirst();
  detailsFailure = { status: 503 };
  await button("Refresh list").click();
  await details().getByRole("alert").waitFor();
  await noRecipientEmails();
  detailsFailure = null;
  await details().getByRole("button", { name: "Try again", exact: true }).click();
  await details().getByRole("button", { name: "Reveal email", exact: true }).first().waitFor();
  revealFailure = { status: 404 };
  await details().getByRole("button", { name: "Reveal email", exact: true }).first().click();
  await details().getByText("This contact changed or the link expired. Refresh the list and try again.", { exact: true }).waitFor();
  await noRecipientEmails();
  console.log("PASS failures: stale reveal, preview failure and failed list refresh cannot display stale private data or send");

  for (const failure of [{ status: 401, title: "Sign in to see Maple’s metrics" }, { status: 403, code: "metrics_reauth", title: "Verify your admin account" }, { status: 403, title: "This page is for Maple’s admin" }]) {
    await reset();
    await open("View people", "People");
    await revealFirst();
    revealFailure = failure;
    await details().getByRole("button", { name: "Reveal email", exact: true }).first().click();
    await page.getByRole("heading", { name: failure.title, exact: true }).waitFor();
    assert.equal(await details().count(), 0, "Authentication failure must unmount all private lists");
    await noRecipientEmails();
    await noOverflow();
  }
  await reset();
  await open("View people", "People");
  await revealFirst();
  await button("Refresh").click();
  await button("View people").waitFor();
  assert.equal(await details().count(), 0);
  await noRecipientEmails();
  await page.setViewportSize({ width: 1280, height: 900 });
  await open("View waitlist", "Waitlist");
  await openPreview();
  await noOverflow();
  await page.screenshot({ path: path.join(screenshots, "preview-1280.png"), fullPage: true });
  assert.deepEqual(errors, [], "No browser exceptions or unexpected/external requests");
  for (const call of calls) {
    assert(!JSON.stringify(call.query).includes("@"), "Admin requests must never put recipient emails in URLs");
    assert(!("ref" in call.query) && !("sendToken" in call.query), "Opaque private tokens belong in request bodies");
  }
  console.log("PASS auth and layout: 401/403 clear revealed identities, full refresh closes details, 375px/1280px fit without overflow, no outside network");
  console.log(`Synthetic screenshots: ${path.relative(root, screenshots)}`);
} catch (error) {
  await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  if (pendingSend) await pendingSend.abort().catch(() => {});
  await browser.close();
  await rm(output, { recursive: true, force: true });
}

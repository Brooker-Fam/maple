import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const root = path.resolve(here, "..");
const output = await mkdtemp(path.join(tmpdir(), "maple-shared-ui-"));
const screenshots = path.join(root, "test-results/maple-shared-ui");
await mkdir(screenshots, { recursive: true });
await build({
  entryPoints: [path.join(here, "ui-review-shared-fixture.jsx")], outfile: path.join(output, "app.js"), bundle: true,
  format: "esm", jsx: "automatic", sourcemap: "inline", absWorkingDir: root,
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [{ name: "synthetic-logging-boundaries", setup(plugin) {
    if (process.env.SHARED_BASELINE === "1") plugin.onLoad({filter:/src\/components\/maple\/(ui|AppNav|HelpSheet)\.tsx$/}, (args) => ({ contents: execFileSync("git", ["show", `4c709f11cfaf98c6f5550acc667e1443d5447262:${path.relative(root,args.path)}`], {cwd:root, encoding:"utf8"}), loader:"tsx",resolveDir:path.dirname(args.path) }));
    const mocks = { path: path.join(here, "ui-review-shared-mocks.jsx") };
    plugin.onResolve({ filter: /(?:^|\/)(?:useMaple|useCare|CareNav|useTimerActions|sheets|notify)$/ }, () => mocks);
    plugin.onResolve({ filter: /^\.\/index$/ }, (args) => args.importer.endsWith("/sheets/parts.tsx") ? mocks : undefined);
  } }],
});
const compiled = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, "src/app/globals.css"), "utf8"), { from: path.join(root, "src/app/globals.css") });
await writeFile(path.join(output, "app.css"), compiled.css + "\n" + (process.env.SHARED_BASELINE === "1" ? execFileSync("git",["show","4c709f11cfaf98c6f5550acc667e1443d5447262:src/app/maple/maple.css"],{cwd:root,encoding:"utf8"}) : await readFile(path.join(root, "src/app/maple/maple.css"), "utf8")));
await writeFile(path.join(output, "index.html"), '<!doctype html><html class="maple-ui"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic shared checks</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
const browser = await chromium.launch({ headless: true });
let page;
const errors = [];
async function freshPage() {
  if (page) await page.close();
page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", timezoneId: "UTC" });
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/*", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  const file = ["/app.js", "/app.css"].includes(pathname) ? pathname.slice(1) : "index.html";
  await route.fulfill({ status: 200, contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html", body: await readFile(path.join(output, file)) });
});
}
const url = "https://shared.example.test";
const checks = [];
const check = async (name, run) => {
  if (process.env.SHARED_CHECK && !name.includes(process.env.SHARED_CHECK)) return;
  try { await freshPage(); await run(); console.log(`PASS ${name}`); }
  catch (e) { checks.push(name); console.log(`FAIL ${name}: ${e.message}`); await page.screenshot({ path: path.join(screenshots, `${name.replaceAll(" ", "-")}-failure.png`) }); }
};
try {
  await check("one minute ago uses tap time", async () => {
    await page.goto(`${url}?mode=time`);
    // Let a form sit open without rerendering. "Ago" must use the clock at the tap.
    await page.evaluate(() => { window.__sharedNow = "2026-10-28T12:05:00Z"; });
    const quick = page.getByRole("region", {name:"Quick logged time", exact:true});
    await quick.getByRole("button", {name:"1 min ago", exact:true}).click();
    assert.equal(await page.locator("#when-value").textContent(), "2026-10-28T12:04:00.000Z");
    assert.equal(await quick.getByRole("button", {name:"1 min ago", exact:true}).getAttribute("aria-pressed"), "true");
    await quick.getByRole("button", {name:"5 min ago", exact:true}).click();
    assert.equal(await page.locator("#when-value").textContent(), "2026-10-28T12:00:00.000Z");
    await page.getByRole("region", {name:"Timer start", exact:true}).getByRole("button", {name:"1 min ago", exact:true}).click();
    assert.equal(await page.locator("#scrub-value").textContent(), "2026-10-28T12:04:00.000Z");
  });
  await check("recorded time nudges preserve limits and feedback", async () => {
    await page.goto(`${url}?mode=time`);
    const field = page.getByRole("group", {name:"Recorded at", exact:true});
    await field.getByRole("button", {name:"5 min earlier", exact:true}).click();
    assert.equal(await page.getByLabel("Recorded at: time", {exact:true}).inputValue(), "11:40");
    assert.match(await field.getByRole("status").textContent(), /11:40 AM/);
    assert(await field.getByRole("button", {name:"1 min earlier", exact:true}).isDisabled());
    assert(await field.getByRole("button", {name:"5 min earlier", exact:true}).isDisabled());
    await field.getByRole("button", {name:"1 min later", exact:true}).click();
    assert.equal(await page.locator("#recorded-value").textContent(), "2026-10-28T11:41:00.000Z");
    await page.getByLabel("Recorded at: time", {exact:true}).fill("12:01");
    assert.equal(await page.locator("#recorded-value").getAttribute("data-invalid"), "true");
    assert(await field.getByRole("alert").isVisible());
    await page.getByLabel("Recorded at: time", {exact:true}).fill("11:59");
    assert.equal(await page.locator("#recorded-value").getAttribute("data-invalid"), "false");
    assert.equal(await page.locator("#recorded-value").textContent(), "2026-10-28T11:59:00.000Z");
  });
  await check("explicit future and incomplete clocks preserve the draft until one Save", async () => {
    await page.goto(`${url}?mode=explicit`);
    assert(await page.getByLabel("Recorded: date", {exact:true}).isVisible(), "Date and clock are available without another reveal");
    await page.getByLabel("Recorded: time", {exact:true}).fill("13:00");
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:30:42.125Z", "A future clock cannot become yesterday or now");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    assert(await page.getByRole("alert").isVisible());
    assert.equal(await page.getByLabel("Recorded: time", {exact:true}).inputValue(), "13:00");
    await page.getByLabel("Recorded: date", {exact:true}).fill("2026-10-27");
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-27T13:00:00.000Z");
    await page.getByLabel("Recorded: time", {exact:true}).fill("");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    await page.getByLabel("Recorded: time", {exact:true}).fill("13:15");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.getByRole("button", {name:/Apply/}).count(), 0);
    await page.getByRole("button", {name:"Save",exact:true}).click();
    assert.equal(await page.locator("#explicit-saved").textContent(), "2026-10-27T13:15:00.000Z");
  });
  await check("bounded quick choices and nudges stay visible without clamping", async () => {
    await page.goto(`${url}?mode=explicit&range=1&at=2026-10-28T11:44:42.125Z&end=2026-10-28T11:45:00Z`);
    const start=page.getByRole("group", {name:"Started",exact:true});
    const end=page.getByRole("group", {name:"Ended",exact:true});
    for (const name of ["Now","1 min ago","5 min ago","1 minute later","5 minutes later"]) assert(await start.getByRole("button", {name,exact:true}).isDisabled(), name);
    assert(await end.getByRole("button", {name:"1 minute earlier",exact:true}).isDisabled());
    assert(await end.getByRole("button", {name:"30 min ago",exact:true}).isDisabled());
    await start.getByLabel("Started: time", {exact:true}).fill("11:50");
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:44:42.125Z");
    assert.equal(await page.locator("#explicit-end").textContent(), "2026-10-28T11:45:00.000Z");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
  });
  await check("both range drafts must be valid before Save", async () => {
    await page.goto(`${url}?mode=explicit&range=1`);
    await page.getByLabel("Started: time", {exact:true}).fill("11:50");
    await page.getByLabel("Ended: time", {exact:true}).fill("11:20");
    assert.equal(await page.getByRole("alert").count(), 2);
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:30:42.125Z");
    assert.equal(await page.locator("#explicit-end").textContent(), "2026-10-28T11:45:42.125Z");
    await page.getByLabel("Started: time", {exact:true}).fill("11:35");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled(), "Fixing start cannot clear the end's invalid flag");
    await page.getByLabel("Ended: time", {exact:true}).fill("11:55");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isEnabled());
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:35:00.000Z");
    assert.equal(await page.locator("#explicit-end").textContent(), "2026-10-28T11:55:00.000Z");
  });
  await check("changed range bounds commit the now-valid visible draft before Save", async () => {
    await page.goto(`${url}?mode=explicit&range=1`);
    await page.getByLabel("Started: time", {exact:true}).fill("11:50");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    await page.getByLabel("Ended: time", {exact:true}).fill("11:55");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isEnabled());
    await page.getByRole("button", {name:"Save",exact:true}).click();
    assert.equal(await page.locator("#explicit-saved").textContent(), "2026-10-28T11:50:00.000Z", "Save must never use the old start after validation becomes valid");
  });
  await check("same-value quick and duration choices replace invalid raw text", async () => {
    await page.goto(`${url}?mode=explicit&at=2026-10-28T11:30:00Z`);
    await page.getByLabel("Recorded: time", {exact:true}).fill("13:00");
    await page.getByRole("button", {name:"30 min ago",exact:true}).click();
    assert.equal(await page.getByLabel("Recorded: time", {exact:true}).inputValue(), "11:30");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isEnabled());
    await page.goto(`${url}?mode=explicit&range=1`);
    await page.getByLabel("Started: time", {exact:true}).fill("13:00");
    await page.getByRole("group", {name:"Duration",exact:true}).getByRole("button", {name:"15m",exact:true}).click();
    assert.equal(await page.getByLabel("Started: time", {exact:true}).inputValue(), "11:30");
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:30:42.125Z");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isEnabled());
    await page.goto(`${url}?mode=explicit&when=1`);
    await page.getByRole("button", {name:"Pick a time",exact:true}).click();
    await page.getByLabel("When: exact time: time", {exact:true}).fill("13:00");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    await page.getByRole("button", {name:"Now",exact:true}).click();
    assert(await page.getByRole("button", {name:"Save",exact:true}).isEnabled(), "Unmounting custom fields clears their invalid flag");
  });
  await check("missing DST clocks stay invalid and repeated clocks expose both occurrences", async () => {
    await page.goto(`${url}?mode=explicit&tz=America/New_York&now=2026-03-08T08:00:00Z&at=2026-03-08T06:30:42.125Z`);
    await page.getByLabel("Recorded: time", {exact:true}).fill("02:30");
    assert.match(await page.getByRole("alert").textContent(), /clocks skip/);
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-03-08T06:30:42.125Z");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    await page.getByLabel("Recorded: time", {exact:true}).fill("03:30");
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-03-08T07:30:00.000Z");
    await page.goto(`${url}?mode=explicit&tz=America/New_York&now=2026-11-01T08:00:00Z&at=2026-11-01T05:30:42.125Z`);
    await page.getByRole("button", {name:"Second 1:30 AM",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-11-01T06:30:42.125Z");
    await page.getByRole("button", {name:"1 minute later",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-11-01T06:31:42.125Z");
    await page.getByRole("button", {name:"First 1:31 AM",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-11-01T05:31:42.125Z");
  });
  await check("day choices preserve seconds and never shift future clocks", async () => {
    await page.goto(`${url}?mode=explicit&now=2026-10-28T00:10:00Z&at=2026-10-27T23:50:42.125Z`);
    assert(await page.getByRole("button", {name:"Today",exact:true}).isDisabled(), "Today at 11:50 PM is future, not a request for now");
    await page.getByRole("button", {name:"1 minute later",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-27T23:51:42.125Z");
    await page.goto(`${url}?mode=explicit&now=2026-10-28T12:00:00Z&at=2026-10-27T11:30:42.125Z`);
    await page.getByRole("button", {name:"Today",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T11:30:42.125Z");
  });
  await check("opening an exact Now freezes the draft across clock ticks", async () => {
    await page.goto(`${url}?mode=explicit&when=1&at=now&tick=1`);
    await page.getByRole("button", {name:"Pick a time",exact:true}).click();
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T12:00:00.000Z");
    await page.getByLabel("When: exact time: time", {exact:true}).fill("");
    await page.getByRole("button", {name:"Advance clock",exact:true}).click();
    assert.equal(await page.getByLabel("When: exact time: time", {exact:true}).inputValue(), "");
    assert(await page.getByRole("button", {name:"Save",exact:true}).isDisabled());
    assert.equal(await page.locator("#explicit-value").textContent(), "2026-10-28T12:00:00.000Z");
  });
  await check("shared time controls fit narrow phones", async () => {
    await page.setViewportSize({width:320,height:844});
    await page.goto(`${url}?mode=time`);
    for (const theme of ["", "dark", "maple-night"]) {
      await page.evaluate((theme) => { document.documentElement.className=`maple-ui ${theme}`; }, theme);
      const chip=page.getByRole("region", {name:"Quick logged time",exact:true}).getByRole("button", {name:"1 min ago",exact:true});
      await chip.focus();
      const focus=await chip.evaluate(el=>({outline:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));
      assert.deepEqual(focus,{outline:"solid",width:"2px"}, `${theme||"day"} has visible keyboard focus`);
      await page.screenshot({path:path.join(screenshots,`shared-time-controls-320-${theme||"day"}.png`),fullPage:true});
    }
    const sizes=await page.locator("button").evaluateAll(buttons=>buttons.map(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height})));
    for(const size of sizes) assert(size.height>=44 && size.width>=44, `${size.text} needs a 44px touch target`);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), "Time controls do not overflow at 320px");
    assert(await page.getByRole("region", {name:"Useful details",exact:true}).getByRole("button", {name:"Available choice",exact:true}).isVisible());
  });
  await check("radio keyboard", async () => {
    await page.goto(url);
    await page.getByRole("radio",{name:"One",exact:true}).focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("radio",{name:"Two",exact:true}).getAttribute("aria-checked"),"true");
    assert.equal(await page.getByRole("radio",{name:"One",exact:true}).getAttribute("tabindex"),"-1");
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("radio",{name:"Three",exact:true}).getAttribute("aria-checked"),"true");
  });
  await check("focus restoration", async () => {
    await page.goto(url);
    await page.getByRole("button",{name:"Open form",exact:true}).click();
    await page.getByRole("dialog",{name:"Example form",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),"Open form");
  });
  await check("draft close guard", async () => {
    await page.goto(url);
    await page.getByRole("button",{name:"Open form",exact:true}).click();
    await page.getByLabel("Example draft").fill("Synthetic unfinished note");
    await page.getByRole("dialog",{name:"Example form",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("dialog",{name:"Discard unsaved changes?"}).waitFor({timeout:2000});
    await page.getByRole("button",{name:"Keep editing",exact:true}).click();
    assert.equal(await page.getByLabel("Example draft").inputValue(),"Synthetic unfinished note");
    await page.keyboard.press("Escape");
    await page.getByRole("button",{name:"Discard changes",exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    assert.notEqual(await page.evaluate(()=>document.body.style.overflow),"hidden","Discarding the form and confirmation must unlock page scrolling");
  });
  await check("tab browser history", async () => {
    await page.goto(url);
    await page.getByRole("button",{name:"history",exact:true}).click();
    await page.getByRole("button",{name:"View patterns",exact:true}).click();
    assert.equal(new URL(page.url()).hash,"#history/patterns");
    await page.getByRole("button",{name:"moments",exact:true}).click();
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector("output").textContent==="history/patterns");
    await page.goto(`${url}#family/people`);
    assert.equal(await page.getByLabel("Current page").textContent(),"family/patterns");
  });
  await check("sheet browser back", async () => {
    await page.goto(`${url}#history/timeline`);
    await page.getByRole("button",{name:"Open form",exact:true}).click();
    await page.getByRole("button",{name:"Open child",exact:true}).click();
    await page.goBack();
    await page.getByRole("dialog",{name:"Child",exact:true}).waitFor({state:"hidden",timeout:2000});
    assert(await page.getByRole("dialog",{name:"Example form",exact:true}).isVisible());
    await page.getByLabel("Example draft").fill("Synthetic draft before Back");
    await page.goBack();
    await page.getByRole("dialog",{name:"Discard unsaved changes?"}).waitFor({timeout:2000});
    await page.getByRole("button",{name:"Keep editing",exact:true}).click();
    assert.equal(await page.getByLabel("Example draft").inputValue(),"Synthetic draft before Back");
    assert.equal(await page.getByLabel("Current page").textContent(),"history/timeline");
  });
  await check("sheet return to previous tab", async () => {
    await page.goto(`${url}#today`);
    await page.getByRole("button",{name:"moments",exact:true}).click();
    for (let attempt=0;attempt<3;attempt++) {
      await page.getByRole("button",{name:"Open form",exact:true}).click();
      await page.getByLabel("Example draft").fill("Synthetic saved note");
      await page.getByRole("button",{name:"Save",exact:true}).click();
      await page.getByRole("dialog").waitFor({state:"hidden"});
    }
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector("output").textContent.startsWith("today/"));
  });
  await check("night text contrast", async () => {
    await page.goto(url);
    const colors=await page.evaluate(()=>{document.documentElement.classList.add("maple-night");const s=getComputedStyle(document.querySelector("#contrast"));return [s.color,s.backgroundColor]});
    const rgb=colors.map(c=>c.match(/[\d.]+/g).map(Number));
    const alpha=rgb[0][3]??1;
    const fg=rgb[0].slice(0,3).map((v,i)=>v*alpha+rgb[1][i]*(1-alpha));
    const luminance=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const contrast=(luminance(fg)+.05)/(luminance(rgb[1].slice(0,3))+.05);
    assert(contrast>=4.5,`Small night text needs 4.5:1; measured ${contrast.toFixed(2)}:1`);
  });
  await check("contextual help", async () => {
    await page.goto(`${url}#care`);
    await page.getByRole("button",{name:"Open help",exact:true}).click();
    assert.equal(await page.getByRole("dialog",{name:"Help",exact:true}).locator("section[aria-labelledby]").first().getAttribute("aria-labelledby"),"help-mom");
    await page.getByRole("radio",{name:"River",exact:true}).click();
    assert(await page.locator("#help-baby").isVisible());
  });
  await check("forward skips dismissed sheets", async () => {
    await page.goto(`${url}#today`);
    await page.getByRole("button",{name:"moments",exact:true}).click();
    await page.getByRole("button",{name:"Open form",exact:true}).click();
    await page.getByRole("dialog",{name:"Example form",exact:true}).getByRole("button",{name:"Close",exact:true}).click();
    await page.getByRole("dialog").waitFor({state:"hidden"});
    await page.waitForTimeout(150);
    await page.goForward();
    await page.goBack();
    await page.waitForFunction(()=>document.querySelector("output").textContent.startsWith("today/"),{},{timeout:2000});
  });
  await check("draft page navigation guard", async () => {
    await page.goto(`${url}#today`);
    await page.getByRole("button",{name:"Open form",exact:true}).click();
    await page.getByLabel("Example draft").fill("Synthetic note before navigation");
    page.once("dialog",dialog=>dialog.dismiss());
    const permitted=await page.evaluate(()=>window.dispatchEvent(new CustomEvent("maple-before-navigate",{cancelable:true,detail:{tab:"moments"}})));
    assert.equal(permitted,false,"Canceling navigation must preserve the draft");
    const unload=await page.evaluate(()=>window.dispatchEvent(new Event("beforeunload",{cancelable:true})));
    assert.equal(unload,false,"Closing or reloading a page with an unsaved draft must be guarded");
  });
  await check("dialog Tab containment", async () => {
    await page.goto(url);
    await page.getByRole("button", {name:"Open form", exact:true}).click();
    await page.getByRole("button", {name:"Save", exact:true}).focus();
    await page.keyboard.press("Tab");
    assert(await page.getByRole("dialog", {name:"Example form", exact:true}).evaluate(el=>el.contains(document.activeElement)), "Tab from final control should stay inside the dialog");
  });
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  assert.deepEqual(checks, [], "All shared regression checks pass");
} finally { await browser.close(); await rm(output, { recursive: true, force: true }); }

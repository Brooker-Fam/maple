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

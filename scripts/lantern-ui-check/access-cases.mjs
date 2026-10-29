export async function accessCases({ assert, page, browserName, open, dialog, close, pause, calls, center }) {
  for (const theme of ["", "dark", "maple-night"]) {
    for (const [width, font] of [[320, 16], [320, 24], [390, 16], [390, 24], [390, 32], [640, 24]]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      await page.goto("https://lantern.example.test/?minutes");
      const form = page.getByRole("dialog", { name: "Nursing minutes", exact: true });
      await form.waitFor();
      await page.evaluate(({ theme, font }) => {
        document.documentElement.className = `maple-ui ${theme}`;
        document.documentElement.style.fontSize = `${font}px`;
      }, { theme, font });
      const input = form.getByRole("textbox", { name: "minutes on the left", exact: true });
      await input.fill("120");
      await input.blur();
      const fits = await input.evaluate((element) => {
        const style = getComputedStyle(element);
        const context = document.createElement("canvas").getContext("2d");
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        return element.scrollWidth <= element.clientWidth &&
          context.measureText(element.value).width <= element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      assert(fits, `The whole 120-minute value must fit at ${width}px / ${font}px / ${theme || "day"}`);
      for (const [name, expected] of [
        ["5 fewer minutes on the left", "115"], ["Less minutes on the left", "114"],
        ["More minutes on the left", "115"], ["5 more minutes on the left", "120"],
      ]) {
        const button = form.getByRole("button", { name, exact: true });
        const box = await button.boundingBox();
        assert(box.width >= 44 && box.height >= 44, "Every adjustment keeps a 44px target");
        await button.press("Space");
        await page.waitForFunction((expected) => document.querySelector('input[aria-label="minutes on the left"]').value === expected, expected);
        assert.equal(await input.inputValue(), expected, "Wrapping must preserve each keyboard adjustment");
      }
      assert(await form.evaluate((element) => element.scrollWidth <= element.clientWidth), "The sheet needs no horizontal scrolling");
    }
  }
  console.log("PASS Access: complete nursing minutes and four 44px adjustments at narrow widths and enlarged text in every look");

  for (const [width, font] of [[320, 16], [320, 24], [320, 32], [390, 24], [390, 32]]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
    await open("?both-row&care");
    await page.evaluate((font) => { document.documentElement.style.fontSize = `${font}px`; }, font);
    const scroller = dialog.locator(".overflow-y-auto");
    assert(await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth), "Lantern content must not overflow sideways");
    for (const control of await dialog.getByRole("button").all()) {
      await control.scrollIntoViewIfNeeded();
      assert(await control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth && box.width >= 44 && box.height >= 44 &&
          document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === element;
      }), "Every timer and care action must be readable and reachable by scrolling");
    }
    assert(await close.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= innerHeight;
    }), "The close control stays visible while scrolling");
    await pause.press("Space");
    assert.deepEqual(await calls(), ["pause"], "A scrolled-to control still supports keyboard activation");
  }
  console.log("PASS Access: Lantern controls stay reachable without horizontal clipping at 150% and 200% text");

  await page.setViewportSize({ width: 320, height: 568 });
  await open("?both-row&care");
  await page.evaluate(() => { document.documentElement.style.fontSize = "24px"; });
  await page.getByText("Lantern · scroll for controls", { exact: true }).waitFor();
  const scroller = dialog.locator(".overflow-y-auto");
  const both = page.getByRole("button", { name: /^Going back and forth\?/ });
  await both.scrollIntoViewIfNeeded();
  let point = await center(both);
  // A downward gesture at the top is an attempt to scroll, even if the
  // browser delivers pointerup rather than cancelling its pointer stream.
  await both.dispatchEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y });
  await both.dispatchEvent("pointermove", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y + 120 });
  await both.dispatchEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: point.x, clientY: point.y + 120 });
  assert(await dialog.isVisible(), "Scrolling toward the top must not close Lantern");
  assert.deepEqual(await calls(), [], "A scrolling gesture must cancel the hold");

  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const before = await scroller.evaluate((element) => element.scrollTop);
    point = await center(both);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1 }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - i * 20, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction((before) => document.querySelector('[aria-label="Lantern timer"] .overflow-y-auto').scrollTop > before, before);
    await page.waitForTimeout(550);
    assert(await dialog.isVisible(), "Native touch scrolling keeps Lantern open");
    assert.deepEqual(await calls(), [], "Native scrolling on a hold row never saves an action");
    await cdp.detach();
  }
  await close.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator("#root").evaluate((element) => element.inert), false);
  assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden");
  console.log("PASS Access: scroll gestures cancel holds, never dismiss Lantern, and closing restores the page");
}

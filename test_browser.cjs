// Optional integration test: npm install --no-save playwright, then node test_browser.cjs.
const { chromium } = require(process.env.ROOMLINE_PLAYWRIGHT || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const baseUrl = process.env.ROOMLINE_TEST_URL || "http://127.0.0.1:8765";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ROOMLINE_CHROME || undefined,
  });
  const contextA = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  // These tabs intentionally share one cookie jar, matching the reported failure.
  const contextB = contextA;
  const a = await contextA.newPage(),
    b = await contextB.newPage();
  const failures = [];
  for (const page of [a, b])
    page.on("pageerror", (error) => failures.push(error.message));
  const suffix = Date.now().toString().slice(-8);
  async function register(page, name) {
    await page.goto(baseUrl);
    await page
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await page.getByLabel("Username", { exact: true }).fill(name + suffix);
    await page.getByLabel("Display name").fill(name);
    await page
      .getByLabel("Password", { exact: true })
      .fill("demo-password-123");
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await page.getByRole("heading", { name: "Your rooms" }).waitFor();
  }
  try {
    await register(a, "Alex");
    await a.getByRole("button", { name: "Create room", exact: true }).click();
    await a.getByLabel("Room name").fill("Design studio");
    await a
      .locator("#create-form")
      .getByRole("button", { name: "Create room" })
      .click();
    await a.getByText("Connected", { exact: true }).waitFor();
    const roomId = await a.evaluate(() =>
      new URLSearchParams(location.search).get("room"),
    );
    await a.getByRole("button", { name: "Invite", exact: true }).click();
    const link = await a.getByLabel("Room invitation link").inputValue();
    await a.getByRole("button", { name: "Close", exact: true }).click();
    await b.goto(link);
    await b
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await b.getByLabel("Username", { exact: true }).fill("Jamie" + suffix);
    await b.getByLabel("Display name").fill("Jamie");
    await b.getByLabel("Password", { exact: true }).fill("demo-password-123");
    await b
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await b.getByText("Connected", { exact: true }).waitFor();
    await b
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Let’s sketch the onboarding flow.");
    await b.getByRole("button", { name: "Send", exact: true }).click();
    await a
      .getByText("Let’s sketch the onboarding flow.", { exact: true })
      .waitFor();
    await a.waitForFunction(
      () => document.querySelector("#member-strip img")?.alt === "Jamie",
    );
    const area = await a.locator("#canvas").boundingBox();
    await a.mouse.move(area.x + area.width * 0.15, area.y + area.height * 0.25);
    const cursor = `[data-user="alex${suffix}"]`;
    await a.locator('#cursor-layer '+cursor+' .cursor-dot').waitFor();
    await b.locator('#cursor-layer '+cursor+' .cursor-dot').waitFor();
    assert.equal(await a.locator('#canvas').evaluate(el => getComputedStyle(el).cursor), 'none');
    await a.mouse.move(10, 10);
    await b.locator('#cursor-layer '+cursor).waitFor({state:'detached'});
    await a.mouse.move(area.x + area.width * 0.15, area.y + area.height * 0.25);
    await a.mouse.down();
    await a.mouse.move(area.x + area.width * 0.35, area.y + area.height * 0.5, {
      steps: 12,
    });
    await a.mouse.up();
    await a.getByText("All changes saved", { exact: true }).waitFor();
    await b.waitForFunction(async (id) => {
      const r = await fetch("/api/rooms/" + id);
      const data = await r.json();
      return data.strokes.length === 1;
    }, roomId);
    await b.reload();
    await b.getByText("Connected", { exact: true }).waitFor();
    const state = await contextB.request.get(
      baseUrl + "/api/rooms/" + roomId,
    );
    assert.equal((await state.json()).strokes.length, 1);
    await a.getByRole("button", { name: "Save snapshot", exact: true }).click();
    await a.getByLabel("Snapshot name").fill("Onboarding notes");
    await a
      .locator("#save-snapshot-form")
      .getByRole("button", { name: "Save snapshot", exact: true })
      .click();
    await a.getByRole("dialog").waitFor({ state: "hidden" });
    await a.locator('[data-section="rooms"]').click();
    await a
      .getByRole("button", { name: "Saved snapshots", exact: true })
      .click();
    await a.getByRole("button", { name: "Open Onboarding notes" }).click();
    await a
      .getByRole("dialog")
      .getByRole("heading", { name: "Onboarding notes" })
      .waitFor();
    await a.getByRole("button", { name: "Rename", exact: true }).click();
    await a.getByLabel("Name", { exact: true }).fill("First session");
    await a.getByRole("button", { name: "Save name", exact: true }).click();
    await a
      .getByRole("dialog")
      .getByRole("heading", { name: "First session" })
      .waitFor();
    await a.getByRole("button", { name: "Close", exact: true }).click();
    await a.screenshot({
      path: path.join(os.tmpdir(), "roomline-gallery.png"),
    });
    await a.getByRole("button", { name: "Joined rooms", exact: true }).click();
    await a.getByRole("heading", { name: "Your rooms" }).waitFor();
    await a.locator('[data-room="' + roomId + '"]').waitFor();
    await a.screenshot({
      path: path.join(os.tmpdir(), "roomline-workspace.png"),
    });
    await a.locator('[data-room="' + roomId + '"]').click();
    await a.getByText("Connected", { exact: true }).waitFor();
    for (const name of ["Taylor", "Morgan", "Sam"]) {
      const guest = await browser.newContext();
      await guest.request.post(baseUrl + "/api/register", {
        data: {username: name + suffix, nickname: name, password: "demo-password-123"},
      });
      await guest.request.post(baseUrl + "/api/join", {
        data: {invite: link},
      });
    }
    await a.getByRole("button", { name: "All members" }).waitFor();
    assert.equal(await a.locator("#member-strip img").count(), 4);
    await a.screenshot({ path: path.join(os.tmpdir(), "roomline-room.png") });
    for (const viewport of [{width:1366,height:768},{width:1024,height:600},{width:800,height:500}]) {
      await a.setViewportSize(viewport);
      const bounds = await a.evaluate(() => {
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const canvas = document.querySelector('#canvas').getBoundingClientRect();
        return {overflow: document.documentElement.scrollWidth > innerWidth,
          composerBottom: composer.bottom, canvasBottom: canvas.bottom, height: innerHeight};
      });
      assert.equal(bounds.overflow, false);
      assert.ok(bounds.composerBottom <= bounds.height);
      assert.ok(bounds.canvasBottom <= bounds.height);
    }
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({
      path: path.join(os.tmpdir(), "roomline-mobile.png"),
      fullPage: true,
    });
    assert.equal(
      await a.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await a.setViewportSize({ width: 1440, height: 960 });
    await a.locator('#member-strip [data-action="members"]').first().click();
    await a.locator(".member-row").filter({hasText: "Jamie"}).locator("[data-kick]").click();
    await a.locator("#confirm").click();
    await b.getByRole("heading", { name: "Your rooms" }).waitFor();
    const forbidden = await contextB.request.get(
      baseUrl + "/api/rooms/" + roomId,
    );
    assert.equal(forbidden.status(), 403);
    assert.deepEqual(failures, []);
    console.log(
      "PASS two-browser invitation, chat, avatar ordering, drawing, reconnect, snapshot gallery, removal and mobile layout",
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

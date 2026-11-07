import assert from "node:assert/strict";
import { constants, copyFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = "/tmp/nw-shots";
const artifacts = "/opt/cursor/artifacts";
const sampleWalk = {
  name: "Bridge loop",
  route_mode: "safest",
  distance_m: 850,
  duration_s: 640,
  route_geojson: {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [[-0.12, 51.505], [-0.1, 51.513], [-0.09, 51.517]],
    },
    properties: {
      from: { lat: 51.505, lng: -0.12, name: "South Bank" },
      to: { lat: 51.517, lng: -0.09, name: "St Pauls" },
      via: "Via the river",
    },
  },
};

let server;
let browser;
let base;

function contentType(file) {
  const ext = path.extname(file);
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".mp4": "video/mp4",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

function startServer() {
  const listener = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    import("node:fs").then((fs) => {
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": contentType(file) });
        res.end(data);
      });
    });
  });
  return new Promise((resolve) => {
    listener.listen(0, "127.0.0.1", () => resolve(listener));
  });
}

async function openMap(page, search) {
  const errors = [];
  const writes = [];
  const supabase = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("supabase.co")) return;
    supabase.push(`${req.method()} ${url}`);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(`${req.method()} ${url}`);
  });
  await page.goto(`${base}/index.html${search}#map`, { waitUntil: "domcontentloaded" });
  const skip = page.locator("#skip-intro");
  if (await skip.count()) await skip.click({ timeout: 4000 }).catch(() => {});
  await page.waitForSelector(".leaflet-container");
  await page.waitForSelector(".nw-dots");
  await page.waitForFunction(() => window.NW_planner && window.NW_map);
  return { errors, writes, supabase };
}

function keep(name, file) {
  mkdirSync(artifacts, { recursive: true });
  const dest = path.join(artifacts, name);
  try {
    copyFileSync(file, dest, constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

before(async () => {
  mkdirSync(shots, { recursive: true });
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
});

test("existing map, route hook, and sign-in dialog", { timeout: 120000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const seen = await openMap(page, "");
  assert.match(await page.locator("#sheet-status").innerText(), /police\.uk/i);
  assert.match(await page.locator("#legend-types").innerText(), /Violent & sexual/);
  const dotWidth = await page.locator(".nw-dots").evaluate((el) => el.width);
  assert.ok(dotWidth > 0);
  await page.evaluate((walk) => window.NW_planner.showSavedWalk(walk), sampleWalk);
  await page.waitForSelector(".route-card");
  assert.match(await page.locator("#from-input").inputValue(), /South Bank/);
  assert.match(await page.locator(".route-card").innerText(), /Via the river/);
  assert.equal(await page.locator('.modes [data-mode="safest"]').getAttribute("aria-checked"), "true");
  assert.equal(await page.locator("#walk-save").isVisible(), true);
  const mapShot = path.join(shots, "map-route.png");
  await page.screenshot({ path: mapShot });
  keep("screenshot_map_route.png", mapShot);

  await page.locator("#account-open").click();
  await page.locator("#account-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#account-preview").isHidden(), true);
  const signShot = path.join(shots, "sign-in.png");
  await page.screenshot({ path: signShot });
  keep("screenshot_sign_in.png", signShot);
  await page.locator("#account-tab-up").click();
  assert.match(await page.locator("#account-prerequisite").innerText(), /thenightwatch\.pages\.dev/);
  assert.match(await page.locator("#account-prerequisite").innerText(), /not verified/);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileShot = path.join(shots, "sign-in-mobile.png");
  await page.screenshot({ path: mobileShot });
  keep("screenshot_sign_in_mobile.png", mobileShot);

  assert.deepEqual(seen.writes, []);
  assert.deepEqual(seen.errors, []);
  await page.close();
});

test("preview account, private walks, reports, and expiry", { timeout: 120000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const seen = await openMap(page, "?nwtest=1");
  await page.waitForSelector(".nw-report");
  assert.equal(await page.locator(".nw-report.is-pending").count(), 0);
  await page.evaluate(() => window.NW_map.setView([51.513, -0.098], 15));
  await page.locator(".nw-report").first().click({ force: true });
  await page.waitForSelector(".report-kicker");
  assert.match(await page.locator(".report-kicker").innerText(), /unverified community report/i);
  assert.match(await page.locator(".leaflet-popup-content").innerText(), /not a promise of safety/i);
  const reportShot = path.join(shots, "community-report.png");
  await page.screenshot({ path: reportShot });
  keep("screenshot_community_report.png", reportShot);

  await page.locator("#account-open").click();
  assert.equal(await page.locator("#account-preview").isVisible(), true);
  await page.locator("#account-tab-up").click();
  await page.locator("#account-email-input").fill("walker@example.com");
  await page.locator("#account-password-input").fill("correct horse");
  await page.locator("#account-submit").click();
  await page.waitForFunction(() => /not treated as verified/i.test(document.getElementById("account-status").textContent));
  await page.locator("#account-resend").click();
  await page.waitForFunction(() => /requested/i.test(document.getElementById("account-status").textContent));
  await page.locator("#account-tab-in").click();
  await page.locator("#account-password-input").fill("wrong-password");
  await page.locator("#account-submit").click();
  await page.waitForFunction(() => /did not match/i.test(document.getElementById("account-status").textContent));
  await page.locator("#account-password-input").fill("correct horse");
  await page.locator("#account-submit").click();
  await page.waitForFunction(() => document.getElementById("account-email").textContent.includes("walker@example.com"));
  await page.locator("#account-close").click();

  assert.equal((await page.locator("body").innerText()).includes("Someone else's walk home"), false);
  await page.evaluate((walk) => window.NW_planner.showSavedWalk(walk), sampleWalk);
  await page.waitForFunction(() => document.getElementById("walk-save-btn").textContent === "Save this walk");
  await page.locator("#walk-name").fill("Bridge loop");
  await page.locator("#walk-save-btn").click();
  await page.waitForFunction(() => /Saved privately/.test(document.getElementById("walk-save-note").textContent));
  await page.waitForFunction(() => document.getElementById("walk-list").textContent.includes("Bridge loop"));
  const walkShot = path.join(shots, "saved-walk.png");
  await page.locator("#your-walks").scrollIntoViewIfNeeded();
  await page.screenshot({ path: walkShot });
  keep("screenshot_saved_walk.png", walkShot);

  await page.locator("#route-clear").click();
  await page.locator("#walk-list").getByRole("button", { name: "Show on map" }).click();
  await page.waitForFunction(() => document.getElementById("from-input").value.includes("South Bank"));
  await page.locator("#walk-list").getByRole("button", { name: "Rename" }).click();
  await page.locator("#walk-list input").fill("Renamed loop");
  await page.locator("#walk-list").getByRole("button", { name: "Save name" }).click();
  await page.waitForFunction(() => document.getElementById("walk-list").textContent.includes("Renamed loop"));
  await page.locator("#walk-list").getByRole("button", { name: "Delete" }).click();
  await page.locator("#walk-list").getByRole("button", { name: "Delete walk" }).click();
  await page.waitForFunction(() => /Deleted from your account/.test(document.getElementById("walk-save-note").textContent));
  assert.equal((await page.locator("#walk-list").innerText()).includes("Renamed loop"), false);

  await page.locator("#community-reports summary").click();
  await page.locator("input[value=lighting]").check();
  await page.locator("#report-pin").click();
  assert.match(await page.locator("#map-hint").innerText(), /approximate report/i);
  await page.locator("#leaflet").click({ position: { x: 980, y: 360 } });
  await page.waitForFunction(() => /Approximate point/.test(document.getElementById("report-place-note").textContent));
  await page.locator("#report-submit").click();
  await page.waitForFunction(() => /Filed for review/.test(document.getElementById("report-status").textContent));
  await page.waitForSelector(".nw-report.is-pending");
  assert.equal(await page.locator("#report-cancel").isHidden(), true);
  const pendingShot = path.join(shots, "report-pending.png");
  await page.screenshot({ path: pendingShot });
  keep("screenshot_report_filed.png", pendingShot);

  const id = await page.evaluate(() => window.__NW_PREVIEW.__lastReportId());
  await page.evaluate((reportId) => window.__NW_PREVIEW.__moderate(reportId, { status: "approved" }), id);
  await page.waitForFunction(() => document.querySelectorAll(".nw-report.is-pending").length === 0);
  await page.evaluate((reportId) => {
    window.__NW_PREVIEW.__moderate(reportId, { expires_at: new Date(Date.now() - 5000).toISOString() });
  }, id);
  await page.waitForFunction((reportId) => {
    const notes = document.getElementById("report-list").textContent;
    return !notes.includes("Awaiting review");
  }, id);

  const before = await page.locator(".nw-report").count();
  await page.evaluate(() => window.__NW_PREVIEW.__seedExpiring(700));
  await page.waitForFunction((count) => document.querySelectorAll(".nw-report").length === count + 1, before);
  await page.waitForFunction((count) => document.querySelectorAll(".nw-report").length === count, before, { timeout: 5000 });

  assert.equal(seen.supabase.length, 0);
  assert.deepEqual(seen.errors, []);
  assert.equal((await page.locator("body").innerText()).includes("Someone else's walk home"), false);
  await page.close();
});

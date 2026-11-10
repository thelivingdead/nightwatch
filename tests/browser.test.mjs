import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
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

function startServer(siteRoot = root) {
  const listener = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.normalize(path.join(siteRoot, pathname));
    if (!file.startsWith(siteRoot)) {
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
  await page.waitForFunction(() => !document.getElementById("intro-cover"));
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

async function openAccount(page) {
  const fold = page.locator("#account-fold");
  if (!(await fold.evaluate((el) => el.open))) {
    await page.evaluate(() => document.getElementById("account").scrollIntoView({ block: "center" }));
    await fold.locator("summary").click();
  }
  await page.waitForFunction(() => {
    const fold = document.getElementById("account-fold");
    if (!fold.open) return false;
    const form = document.getElementById("account-form");
    const signed = document.getElementById("account-signed-in");
    return (form && !form.hidden) || (signed && !signed.hidden);
  });
}

test("map stays anonymous and the account section sits below it", { timeout: 120000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const seen = await openMap(page, "");
  assert.equal(await page.locator("dialog").count(), 0);
  assert.equal(await page.locator("#account-fold").evaluate((el) => el.open), false);
  assert.equal(await page.locator("#nav").getByRole("link", { name: "Plan my walk" }).count(), 1);
  const brand = await page.locator(".nav-brand").evaluate((el) => {
    const style = getComputedStyle(el);
    const logo = getComputedStyle(el.querySelector("img"));
    return {
      background: style.backgroundColor,
      outline: style.outlineStyle,
      shadow: style.boxShadow,
      font: style.fontFamily,
      color: style.color,
      glow: logo.filter,
    };
  });
  assert.equal(brand.background, "rgba(0, 0, 0, 0)");
  assert.equal(brand.outline, "none");
  assert.equal(brand.shadow, "none");
  assert.match(brand.font, /Pirata One/);
  assert.equal(brand.color, "rgb(143, 220, 255)");
  assert.match(brand.glow, /drop-shadow/);
  assert.equal(await page.locator("#sheet #walk-save").count(), 0);
  assert.equal(await page.locator("#sheet #community-reports").count(), 0);
  assert.match(await page.locator("#sheet-status").innerText(), /police\.uk/i);
  assert.match(await page.locator("#legend-types").innerText(), /Violent & sexual/);
  assert.equal((await page.locator(".map-legend").innerText()).includes("Unverified report"), false);
  const dotWidth = await page.locator(".nw-dots").evaluate((el) => el.width);
  assert.ok(dotWidth > 0);
  const placed = await page.evaluate(() => {
    const mapBox = document.getElementById("map").getBoundingClientRect();
    const accountBox = document.getElementById("account").getBoundingClientRect();
    const fold = getComputedStyle(document.getElementById("account-fold"));
    return {
      accountBelowMap: accountBox.top >= mapBox.bottom - 1,
      position: fold.position,
    };
  });
  assert.equal(placed.accountBelowMap, true);
  assert.equal(placed.position, "static");

  await page.locator("#account-fold summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#account-fold").evaluate((el) => el.open), true);
  await page.locator("#account-email-input").focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), "account-email-input");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#account-fold").evaluate((el) => el.open), false);
  await page.locator("#from-input").focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), "from-input");

  assert.equal((await page.locator("#account-fold summary").innerText()).trim().toLowerCase(), "account");
  await page.evaluate(() => document.getElementById("account").scrollIntoView({ block: "center" }));
  const closedShot = path.join(shots, "account-closed.png");
  await page.locator("#account-fold").screenshot({ path: closedShot });
  keep("screenshot_account_closed.png", closedShot);
  await page.setViewportSize({ width: 390, height: 844 });
  const closedMobile = path.join(shots, "account-closed-mobile.png");
  await page.locator("#account-fold").screenshot({ path: closedMobile });
  keep("screenshot_account_closed_mobile.png", closedMobile);
  await page.setViewportSize({ width: 1440, height: 900 });

  await openAccount(page);
  await page.locator("#account-tab-up").click();
  assert.match(await page.locator("#account-lead").innerText(), /Not an emergency service\. In danger, call 999\./);
  assert.equal(await page.locator("#account-prerequisite").count(), 0);
  const belowShot = path.join(shots, "account-open.png");
  await page.locator("#account").screenshot({ path: belowShot });
  keep("screenshot_account_open.png", belowShot);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileShot = path.join(shots, "account-open-mobile.png");
  await page.locator("#account").screenshot({ path: mobileShot });
  keep("screenshot_account_open_mobile.png", mobileShot);
  const bounds = await page.locator("#account-fold").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { height: box.height, viewport: window.innerHeight, covers: box.height > window.innerHeight * 0.85 };
  });
  assert.equal(bounds.covers, false);

  assert.deepEqual(seen.writes, []);
  assert.deepEqual(seen.errors, []);
  await page.close();
});

test("only fastest and safest draw a route", { timeout: 120000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openMap(page, "");
  const labels = (await page.locator(".modes button").allTextContents()).map((text) => text.trim());
  assert.deepEqual(labels, ["Fastest", "Safest"]);
  await page.evaluate((walk) => window.NW_planner.showSavedWalk(walk), sampleWalk);
  await page.waitForSelector(".route-card");
  for (const mode of ["fastest", "safest"]) {
    await page.locator(`.modes [data-mode="${mode}"]`).click();
    assert.equal(await page.locator(`.modes [data-mode="${mode}"]`).getAttribute("aria-checked"), "true");
    assert.equal(await page.locator(".route-card").count(), 1);
    assert.ok(await page.locator(".leaflet-routes-pane path").count() > 0);
  }
  assert.equal((await page.locator("body").innerText()).toLowerCase().includes("balanced"), false);
  const modesShot = path.join(shots, "route-modes.png");
  await page.locator(".modes").screenshot({ path: modesShot });
  keep("screenshot_route_modes.png", modesShot);
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
  assert.match(await page.locator(".report-kicker").innerText(), /unverified report/i);
  const reportShot = path.join(shots, "community-report.png");
  await page.screenshot({ path: reportShot });
  keep("screenshot_community_report.png", reportShot);

  await openAccount(page);
  await page.locator("#account-tab-up").click();
  await page.locator("#account-email-input").fill("walker@example.com");
  await page.locator("#account-password-input").fill("correct horse");
  await page.locator("#account-submit").click();
  await page.waitForFunction(() => /check your email/i.test(document.getElementById("account-status").textContent));
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
  assert.equal(await page.locator("#account-fold").evaluate((el) => el.open), false);
  await openAccount(page);

  assert.equal((await page.locator("body").innerText()).includes("Someone else's walk home"), false);
  await page.evaluate((walk) => window.NW_planner.showSavedWalk(walk), sampleWalk);
  await page.waitForFunction(() => document.getElementById("walk-save-btn").textContent === "Save this walk");
  await page.locator("#walk-name").fill("Bridge loop");
  await page.locator("#walk-save-btn").click();
  await page.waitForFunction(() => document.getElementById("walk-save-note").textContent === "Saved.");
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
  await page.waitForFunction(() => document.getElementById("walk-save-note").textContent === "Deleted.");
  assert.equal((await page.locator("#walk-list").innerText()).includes("Renamed loop"), false);

  await openAccount(page);
  await page.locator("input[value=lighting]").check();
  assert.equal(await page.locator("#report-picker-map.leaflet-container").count(), 0);
  await page.locator("#report-pin").click();
  await page.waitForSelector("#report-picker-map.leaflet-container");
  assert.equal(await page.locator("#leaflet").evaluate((el) => el.classList.contains("is-reporting")), false);
  assert.doesNotMatch(await page.locator("#map-hint").innerText(), /approximate report/i);
  const pickerBox = await page.locator("#report-picker").evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      position: style.position,
      covers: rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9,
    };
  });
  assert.notEqual(pickerBox.position, "fixed");
  assert.equal(pickerBox.covers, false);
  assert.equal(await page.locator("#report-picker-close").isVisible(), true);
  await page.waitForFunction(() => document.getElementById("report-picker-map").clientHeight > 100);
  const mapBox = await page.locator("#report-picker-map").boundingBox();
  await page.mouse.click(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
  await page.waitForFunction(() => !document.getElementById("report-picker-use").disabled);
  assert.equal(await page.locator("#report-picker-map .leaflet-marker-draggable").count(), 1);
  await page.locator("#report-picker-use").click();
  await page.waitForFunction(() => /\d+\.\d{3}/.test(document.getElementById("report-place-note").textContent));
  assert.equal(await page.locator("#report-picker").isHidden(), true);
  await page.locator("#report-submit").click();
  await page.waitForFunction(() => /Awaiting review/.test(document.getElementById("report-status").textContent));
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

test("the report picker searches London and shows this device", { timeout: 120000 }, async () => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    geolocation: { latitude: 51.513, longitude: -0.098 },
    permissions: ["geolocation"],
  });
  const page = await context.newPage();
  await page.route("https://photon.komoot.io/**", async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.searchParams.get("q"), "Tower");
    assert.equal(url.searchParams.get("lat"), "51.5072");
    assert.equal(url.searchParams.get("lon"), "-0.1276");
    assert.equal(url.searchParams.get("bbox"), "-0.52,51.28,0.34,51.7");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        features: [
          {
            geometry: { type: "Point", coordinates: [-0.0754, 51.5055] },
            properties: { name: "Tower Bridge", city: "London", postcode: "SE1 2UP", osm_value: "bridge" },
          },
          {
            geometry: { type: "Point", coordinates: [2.3522, 48.8566] },
            properties: { name: "Paris", city: "Paris", osm_value: "city" },
          },
        ],
      }),
    });
  });
  await openMap(page, "?nwtest=1");
  await openAccount(page);
  assert.equal(await page.locator("#report-picker-map.leaflet-container").count(), 0);
  await page.locator("#report-pin").click();
  await page.waitForSelector("#report-picker-map.leaflet-container");
  assert.equal(await page.locator("#leaflet.is-reporting").count(), 0);
  const tooShort = page.waitForRequest((req) => req.url().includes("photon.komoot.io"), { timeout: 600 }).then(() => true, () => false);
  await page.locator("#report-search").fill("To");
  assert.equal(await tooShort, false);
  await page.locator("#report-search").fill("Tower");
  await page.waitForSelector("#report-search-list button");
  assert.equal(await page.locator("#report-search-list button").count(), 1);
  assert.match(await page.locator("#report-search-list").innerText(), /Tower Bridge/);
  assert.equal((await page.locator("#report-search-list").innerText()).includes("Paris"), false);
  await page.locator("#report-search-list button").click();
  await page.locator("#report-picker-use").click();
  await page.waitForFunction(() => /51\.505,\s*-0\.075/.test(document.getElementById("report-place-note").textContent));
  assert.equal(await page.locator("#report-picker").isHidden(), true);

  await page.locator("#report-locate").click();
  await page.waitForSelector("#report-picker:not([hidden]) #report-picker-map .nw-pin");
  const seen = await page.evaluate(() => {
    const pin = document.querySelector("#report-picker-map .nw-pin").getBoundingClientRect();
    const map = document.getElementById("report-picker-map").getBoundingClientRect();
    return pin.left < map.right && pin.right > map.left && pin.top < map.bottom && pin.bottom > map.top;
  });
  assert.equal(seen, true);
  await page.locator("#report-picker-use").click();
  await page.waitForFunction(() => /51\.513,\s*-0\.098/.test(document.getElementById("report-place-note").textContent));

  await page.locator("#report-pin").click();
  await page.locator("#report-picker-cancel").click();
  assert.equal(await page.locator("#report-picker").isHidden(), true);
  assert.match(await page.locator("#report-place-note").innerText(), /51\.513,\s*-0\.098/);
  await context.close();
});

test("a stalled sign-in script does not delay the map or a route", { timeout: 120000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("https://cdn.jsdelivr.net/npm/@supabase/**", () => new Promise(() => {}));
  const started = Date.now();
  const seen = await openMap(page, "");
  await page.evaluate((walk) => window.NW_planner.showSavedWalk(walk), sampleWalk);
  await page.waitForSelector(".route-card");
  assert.match(await page.locator("#from-input").inputValue(), /South Bank/);
  assert.ok(Date.now() - started < 15000);
  assert.equal(await page.locator("#account-fold").evaluate((el) => el.open), false);
  assert.deepEqual(seen.errors, []);
  await page.close();
});

test("the map and navigation match the original page", { timeout: 120000 }, async () => {
  const mainDir = "/tmp/nw-main";
  if (!existsSync(path.join(mainDir, "index.html"))) {
    execFileSync("git", ["worktree", "add", "--detach", mainDir, "origin/main"], { cwd: root });
  }
  const mainServer = await startServer(mainDir);
  const mainBase = `http://127.0.0.1:${mainServer.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

  async function capture(url, name) {
    const page = await context.newPage();
    await page.goto(`${url}/index.html#map`, { waitUntil: "domcontentloaded" });
    const skip = page.locator("#skip-intro");
    if (await skip.count()) await skip.click({ timeout: 4000 }).catch(() => {});
    await page.waitForFunction(() => !document.getElementById("intro-cover"));
    await page.waitForSelector(".nw-dots");
    await page.waitForFunction(() => document.querySelectorAll(".leaflet-tile-loaded").length >= 4);
    await page.addStyleTag({ content: ".modes{visibility:hidden !important}" });
    const mapFile = path.join(shots, `${name}-map.png`);
    const navFile = path.join(shots, `${name}-nav.png`);
    await page.locator("#map").screenshot({ path: mapFile });
    await page.locator("#nav").screenshot({ path: navFile });
    await page.close();
    return { mapFile, navFile };
  }

  const mainShots = await capture(mainBase, "first-half-main");
  const branchShots = await capture(base, "first-half-branch");
  keep("screenshot_first_half_main.png", mainShots.mapFile);
  keep("screenshot_first_half_branch.png", branchShots.mapFile);

  function difference(aPath, bPath, { ignoreLeft = 0 } = {}) {
    const a = PNG.sync.read(readFileSync(aPath));
    const b = PNG.sync.read(readFileSync(bPath));
    assert.equal(a.width, b.width);
    assert.equal(a.height, b.height);
    if (ignoreLeft > 0) {
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < ignoreLeft && x < a.width; x++) {
          const i = (a.width * y + x) << 2;
          a.data[i] = b.data[i];
          a.data[i + 1] = b.data[i + 1];
          a.data[i + 2] = b.data[i + 2];
          a.data[i + 3] = b.data[i + 3];
        }
      }
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
    return mismatched / (a.width * a.height);
  }

  const mapDiff = difference(mainShots.mapFile, branchShots.mapFile);
  const navDiff = difference(mainShots.navFile, branchShots.navFile, { ignoreLeft: 360 });
  assert.ok(mapDiff < 0.02, `map first half differs by ${(mapDiff * 100).toFixed(2)}%`);
  assert.ok(navDiff < 0.02, `navigation links differ by ${(navDiff * 100).toFixed(2)}%`);
  await context.close();
  await new Promise((resolve) => mainServer.close(resolve));
});

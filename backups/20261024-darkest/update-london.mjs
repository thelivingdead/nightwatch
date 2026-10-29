import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://data.police.uk/api";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = resolve(ROOT, "data/london.json");
const LONDON = { south: 51.28, west: -0.51, north: 51.70, east: 0.33 };
const GRID = 6;
const REQUEST_GAP_MS = 100;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let lastRequestAt = 0;

async function pacedFetch(url, options) {
  const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastRequestAt));
  if (wait) await sleep(wait);
  lastRequestAt = Date.now();
  return fetch(url, options);
}

async function request(url, options = {}) {
  let error;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const response = await pacedFetch(url, options);
      if (response.status === 503) return response;
      if (response.ok) return response;
      if (![429, 500, 502, 504].includes(response.status)) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      error = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (caught) {
      error = caught;
    }
    await sleep(400 * (2 ** attempt));
  }
  throw error;
}

function split(box) {
  const middleLat = (box.south + box.north) / 2;
  const middleLng = (box.west + box.east) / 2;
  return [
    { south: box.south, west: box.west, north: middleLat, east: middleLng },
    { south: box.south, west: middleLng, north: middleLat, east: box.east },
    { south: middleLat, west: box.west, north: box.north, east: middleLng },
    { south: middleLat, west: middleLng, north: box.north, east: box.east },
  ];
}

function polygon(box) {
  return [
    [box.south, box.west],
    [box.south, box.east],
    [box.north, box.east],
    [box.north, box.west],
  ].map((point) => point.join(",")).join(":");
}

async function fetchBox(box, month, depth = 0) {
  const body = new URLSearchParams({ poly: polygon(box), date: month });
  const response = await request(`${API}/crimes-street/all-crime`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  if (response.status === 503) {
    if (depth >= 10) throw new Error(`The API kept rejecting a very small area: ${polygon(box)}`);
    const results = [];
    for (const child of split(box)) results.push(...await fetchBox(child, month, depth + 1));
    return results;
  }
  return response.json();
}

function gridBoxes() {
  const latStep = (LONDON.north - LONDON.south) / GRID;
  const lngStep = (LONDON.east - LONDON.west) / GRID;
  const boxes = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < GRID; column += 1) {
      boxes.push({
        south: LONDON.south + row * latStep,
        west: LONDON.west + column * lngStep,
        north: LONDON.south + (row + 1) * latStep,
        east: LONDON.west + (column + 1) * lngStep,
      });
    }
  }
  return boxes;
}

async function main() {
  const updatedResponse = await request(`${API}/crime-last-updated`);
  const updated = await updatedResponse.json();
  const month = String(updated.date).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Unexpected latest date: ${updated.date}`);

  const byId = new Map();
  const boxes = gridBoxes();
  for (let index = 0; index < boxes.length; index += 1) {
    const crimes = await fetchBox(boxes[index], month);
    for (const crime of crimes) byId.set(String(crime.id), crime);
    console.log(`${index + 1}/${boxes.length} areas · ${byId.size.toLocaleString("en-GB")} unique crimes`);
  }

  const crimes = [...byId.values()].map((crime) => ({
    id: Number(crime.id),
    category: crime.category,
    lat: Number(crime.location.latitude),
    lng: Number(crime.location.longitude),
    street: crime.location.street.name,
    month: crime.month,
  }));
  const output = { month, count: crimes.length, crimes };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
  console.log(`Wrote ${crimes.length.toLocaleString("en-GB")} crimes to ${OUTPUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

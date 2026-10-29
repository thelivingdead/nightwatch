import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LONDON_JSON = resolve(ROOT, "data/london.json");
const BOROUGHS_JS = resolve(ROOT, "js/data/boroughs.js");
const OUTPUT = resolve(ROOT, "data/darkest-streets.json");

// Scale matches the site: violence and robbery first, then burglary / theft from the person,
// mid theft group, lower-mid public-order / damage / drugs / weapons, lowest ASB / other.
const WEIGHTS = {
  "violent-crime": 5,
  "violence-and-sexual-offences": 5,
  "robbery": 5,
  "burglary": 4,
  "theft-from-the-person": 4,
  "shoplifting": 3,
  "bicycle-theft": 3,
  "vehicle-crime": 3,
  "public-order": 2,
  "criminal-damage-arson": 2,
  "drugs": 2,
  "possession-of-weapons": 2,
  "anti-social-behaviour": 1,
  "other-crime": 1,
  "other-theft": 1,
};

const CITYWIDE_KEEP = 80;
const PER_BOROUGH_KEEP = 15;
const MIN_COUNT = 5;

function displayName(raw) {
  return String(raw || "").replace(/^On or near\s+/i, "").trim() || String(raw || "");
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function loadBoroughs(source) {
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Could not parse borough polygons");
  const collection = JSON.parse(source.slice(start, end + 1));
  return collection.features.map((feature) => {
    const polys = feature.geometry.coordinates;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { name: feature.properties.name, polys, bbox: [minX, minY, maxX, maxY] };
  });
}

function boroughAt(lng, lat, boroughs) {
  return boroughs.find((b) =>
    lng >= b.bbox[0] && lng <= b.bbox[2] && lat >= b.bbox[1] && lat <= b.bbox[3]
    && b.polys.some((poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole)))
  ) || null;
}

function topCategory(categories) {
  let best = "";
  let bestCount = -1;
  let bestWeight = -1;
  for (const [slug, count] of Object.entries(categories)) {
    const weight = WEIGHTS[slug] ?? 1;
    if (count > bestCount || (count === bestCount && weight > bestWeight) || (count === bestCount && weight === bestWeight && slug < best)) {
      best = slug;
      bestCount = count;
      bestWeight = weight;
    }
  }
  return best;
}

function scoreStreet(categories) {
  let score = 0;
  for (const [slug, count] of Object.entries(categories)) {
    score += count * (WEIGHTS[slug] ?? 1);
  }
  return Math.round(score * 10) / 10;
}

function pickStreets(ranked) {
  const chosen = new Map();
  for (const street of ranked.slice(0, CITYWIDE_KEEP)) chosen.set(street.nameRaw, street);
  const byBorough = new Map();
  for (const street of ranked) {
    if (!street.borough) continue;
    const list = byBorough.get(street.borough) || [];
    if (list.length < PER_BOROUGH_KEEP) {
      list.push(street);
      byBorough.set(street.borough, list);
    }
  }
  for (const list of byBorough.values()) {
    for (const street of list) chosen.set(street.nameRaw, street);
  }
  return [...chosen.values()].sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
}

export async function rankStreets() {
  const [londonRaw, boroughsRaw] = await Promise.all([
    readFile(LONDON_JSON, "utf8"),
    readFile(BOROUGHS_JS, "utf8"),
  ]);
  const london = JSON.parse(londonRaw);
  const boroughs = loadBoroughs(boroughsRaw);
  const boroughCache = new Map();
  const groups = new Map();

  for (const crime of london.crimes || []) {
    const raw = crime.street;
    if (!raw) continue;
    const lat = Number(crime.lat);
    const lng = Number(crime.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let group = groups.get(raw);
    if (!group) {
      group = { nameRaw: raw, name: displayName(raw), categories: {}, count: 0, latSum: 0, lngSum: 0, boroughVotes: new Map() };
      groups.set(raw, group);
    }
    const slug = crime.category || "other-crime";
    group.categories[slug] = (group.categories[slug] || 0) + 1;
    group.count += 1;
    group.latSum += lat;
    group.lngSum += lng;
    const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    let borough = boroughCache.get(cacheKey);
    if (borough === undefined) {
      borough = boroughAt(lng, lat, boroughs)?.name || "";
      boroughCache.set(cacheKey, borough);
    }
    if (borough) group.boroughVotes.set(borough, (group.boroughVotes.get(borough) || 0) + 1);
  }

  const ranked = [...groups.values()]
    .filter((group) => group.count >= MIN_COUNT)
    .map((group) => {
      let borough = "";
      let votes = 0;
      for (const [name, count] of group.boroughVotes) {
        if (count > votes || (count === votes && name < borough)) {
          borough = name;
          votes = count;
        }
      }
      return {
        name: group.name,
        nameRaw: group.nameRaw,
        borough,
        count: group.count,
        score: scoreStreet(group.categories),
        topCategory: topCategory(group.categories),
        lat: Math.round((group.latSum / group.count) * 1e6) / 1e6,
        lng: Math.round((group.lngSum / group.count) * 1e6) / 1e6,
        categories: group.categories,
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));

  const streets = pickStreets(ranked);
  const payload = { month: london.month, weights: WEIGHTS, streets };
  await writeFile(OUTPUT, `${JSON.stringify(payload)}\n`);
  return payload;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  rankStreets()
    .then((payload) => {
      const top = payload.streets.slice(0, 3).map((s) => `${s.name} (${s.borough}, ${s.count})`).join(" · ");
      console.log(`Wrote ${payload.streets.length} streets for ${payload.month} to ${OUTPUT}`);
      console.log(`Top 3: ${top}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

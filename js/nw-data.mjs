// Pure Night Watch rules for saved walks and community reports.
// Nothing here talks to the network or the DOM.

import { SITE_ORIGIN } from "./supabase-config.mjs";

export const WALK_MODES = ["fastest", "safest"];
export const REPORT_CATEGORIES = [
  { id: "lighting", label: "Lighting", detail: "A stretch that felt poorly lit" },
  { id: "blocked-path", label: "Blocked path", detail: "A way that was closed or hard to pass" },
  { id: "uncomfortable-experience", label: "Uncomfortable", detail: "A place that felt unsafe to be" },
];

export const LONDON_BBOX = Object.freeze({
  minLat: 51.28,
  maxLat: 51.7,
  minLng: -0.52,
  maxLng: 0.34,
});

const CATEGORY_IDS = new Set(REPORT_CATEGORIES.map((c) => c.id));
const CATEGORY_LABEL = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c.id, c.label]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function categoryLabel(id) {
  return CATEGORY_LABEL[id] || "Report";
}

export function normalizeRouteMode(mode) {
  return mode === "fastest" ? "fastest" : "safest";
}

export function modeLabel(mode) {
  return normalizeRouteMode(mode) === "fastest" ? "Fastest" : "Safest";
}

function fail(error) {
  return { ok: false, error };
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function cleanName(value) {
  const name = cleanText(value, 80);
  if (name.length < 1 || name.length > 60) return fail("Use a name between 1 and 60 characters.");
  return { ok: true, value: name };
}

function roundTo(value, places) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(places));
}

function cleanInt(value, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fail(`This walk has no ${label} to save.`);
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > max) return fail(`This walk’s ${label} is outside what can be saved.`);
  return { ok: true, value: rounded };
}

function buildFeature(input) {
  const coordsIn = input?.coords;
  if (!Array.isArray(coordsIn) || coordsIn.length < 2) return fail("Plan a route before saving it.");
  const coordinates = [];
  for (const pair of coordsIn) {
    if (!Array.isArray(pair) || pair.length < 2) return fail("This route could not be saved.");
    const lng = roundTo(pair[0], 5);
    const lat = roundTo(pair[1], 5);
    if (lng == null || lat == null) return fail("This route could not be saved.");
    coordinates.push([lng, lat]);
  }
  const from = input.from || {};
  const to = input.to || {};
  const fromLat = roundTo(from.lat, 5);
  const fromLng = roundTo(from.lng, 5);
  const toLat = roundTo(to.lat, 5);
  const toLng = roundTo(to.lng, 5);
  if ([fromLat, fromLng, toLat, toLng].some((n) => n == null)) return fail("Set a start and a destination before saving.");
  return {
    ok: true,
    value: {
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: {
        from: { lat: fromLat, lng: fromLng, name: cleanText(from.name, 80) },
        to: { lat: toLat, lng: toLng, name: cleanText(to.name, 80) },
        via: cleanText(input.via, 80),
      },
    },
  };
}

export function walkInsertPayload(input) {
  const name = cleanName(input?.name);
  if (!name.ok) return name;
  const routeMode = input?.route_mode === "balanced" ? "safest" : input?.route_mode;
  if (!WALK_MODES.includes(routeMode)) return fail("Choose fastest or safest before saving.");
  const feature = buildFeature(input);
  if (!feature.ok) return feature;
  const distance = cleanInt(input?.distance ?? input?.distance_m, 100000, "distance");
  if (!distance.ok) return distance;
  const duration = cleanInt(input?.duration ?? input?.duration_s, 86400, "duration");
  if (!duration.ok) return duration;
  const route_geojson = feature.value;
  const bytes = new TextEncoder().encode(JSON.stringify(route_geojson)).length;
  if (bytes > 100000) return fail("This route is too detailed to save. Try a shorter walk.");
  return {
    ok: true,
    value: {
      name: name.value,
      route_mode: routeMode,
      route_geojson,
      distance_m: distance.value,
      duration_s: duration.value,
    },
  };
}

export function walkUpdatePayload(name) {
  const cleaned = cleanName(name);
  if (!cleaned.ok) return cleaned;
  return { ok: true, value: { name: cleaned.value } };
}

export function isUuid(value) {
  return UUID.test(String(value || ""));
}

export function presentWalk(row) {
  if (!row || typeof row !== "object" || !isUuid(row.id)) return null;
  const name = cleanName(row.name);
  const routeMode = row.route_mode === "balanced" ? "safest" : row.route_mode;
  if (!name.ok || !WALK_MODES.includes(routeMode)) return null;
  const route = row.route_geojson;
  if (!route || route.type !== "Feature" || route.geometry?.type !== "LineString") return null;
  return {
    id: String(row.id),
    name: name.value,
    route_mode: routeMode,
    route_geojson: route,
    distance_m: Number.isFinite(Number(row.distance_m)) ? Number(row.distance_m) : null,
    duration_s: Number.isFinite(Number(row.duration_s)) ? Number(row.duration_s) : null,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
  };
}

export function suggestWalkName(snapshot) {
  if (!snapshot) return "";
  const from = cleanText(snapshot.from?.name, 40) || "Start";
  const to = cleanText(snapshot.to?.name, 40) || "End";
  return cleanText(`${from} to ${to}`, 60);
}

export function approximatePoint(lat, lng) {
  const lat3 = roundTo(lat, 3);
  const lng3 = roundTo(lng, 3);
  if (lat3 == null || lng3 == null) return fail("Choose a point on the London map.");
  if (lat3 < LONDON_BBOX.minLat || lat3 > LONDON_BBOX.maxLat || lng3 < LONDON_BBOX.minLng || lng3 > LONDON_BBOX.maxLng) {
    return fail("Reports stay inside Greater London, and only as an approximate point.");
  }
  return { ok: true, value: { lat: lat3, lng: lng3 } };
}

// Photon (Komoot) is the free geocoder the route search already uses. No API key.
// Results are biased to central London and bounded to the same box reports allow.
export const PHOTON_MIN_QUERY = 3;

const PHOTON_KINDS = {
  station: "Station",
  halt: "Station",
  subway_entrance: "Station entrance",
  bus_station: "Bus station",
  suburb: "Area",
  neighbourhood: "Area",
  quarter: "Area",
  village: "Area",
  town: "Area",
  park: "Park",
  common: "Common",
  pub: "Pub",
  bar: "Bar",
  restaurant: "Restaurant",
  cafe: "Café",
  university: "University",
  college: "College",
  school: "School",
  hospital: "Hospital",
  library: "Library",
  cinema: "Cinema",
  theatre: "Theatre",
  museum: "Museum",
  nightclub: "Club",
  house: "Address",
  postcode: "Postcode",
};
const PHOTON_NOISE = new Set(["stop", "stop_position", "platform"]);

export function londonPhotonUrl(query) {
  const q = String(query ?? "").replace(/\s+/g, " ").trim();
  const { minLat, maxLat, minLng, maxLng } = LONDON_BBOX;
  return "https://photon.komoot.io/api/"
    + `?q=${encodeURIComponent(q)}`
    + "&limit=7&lang=en"
    + "&lat=51.5072&lon=-0.1276"
    + `&bbox=${minLng},${minLat},${maxLng},${maxLat}`;
}

function inLondonBox(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= LONDON_BBOX.minLat && lat <= LONDON_BBOX.maxLat
    && lng >= LONDON_BBOX.minLng && lng <= LONDON_BBOX.maxLng;
}

function photonLabel(props) {
  const street = [props.housenumber, props.street].filter(Boolean).join(" ");
  const main = props.name || street || props.postcode || "Unnamed place";
  const area = String(props.district || props.locality || props.city || "")
    .replace(/^London Borough of /, "")
    .replace(/^Royal Borough of /, "");
  const detail = [PHOTON_KINDS[props.osm_value] || "", props.name ? street : "", area, props.postcode || ""]
    .filter((part, index, all) => part && part !== main && all.indexOf(part) === index);
  return { main: String(main), detail: detail.join(" · ") };
}

export function placesFromPhoton(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const seen = new Set();
  const places = [];
  for (const feature of features) {
    const props = feature?.properties || {};
    if (PHOTON_NOISE.has(props.osm_value)) continue;
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!inLondonBox(lat, lng)) continue;
    const label = photonLabel(props);
    const key = `${label.main}|${label.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ ...label, lat, lng });
    if (places.length === 6) break;
  }
  return places;
}

export function reportInsertPayload(input) {
  if (!CATEGORY_IDS.has(input?.category)) {
    return fail("Choose lighting, a blocked path, or an uncomfortable experience.");
  }
  const point = approximatePoint(input?.lat, input?.lng);
  if (!point.ok) return point;
  return { ok: true, value: { category: input.category, lat: point.value.lat, lng: point.value.lng } };
}

export function presentReport(row) {
  if (!row || typeof row !== "object" || !isUuid(row.id)) return null;
  if (!CATEGORY_IDS.has(row.category)) return null;
  if (!["pending", "approved", "rejected"].includes(row.status)) return null;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: String(row.id),
    category: row.category,
    lat,
    lng,
    status: row.status,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    expires_at: typeof row.expires_at === "string" ? row.expires_at : null,
  };
}

export function reportsFromRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const clean = presentReport(row);
    if (clean) map.set(clean.id, clean);
  }
  return map;
}

export function expiryMs(row) {
  const t = Date.parse(row?.expires_at || "");
  return Number.isFinite(t) ? t : NaN;
}

export function isPublicReport(row, now) {
  return Boolean(row && row.status === "approved" && expiryMs(row) > now);
}

export function isPendingReport(row, now) {
  return Boolean(row && row.status === "pending" && expiryMs(row) > now);
}

export function markerSets(reports, now) {
  const pub = [];
  const pending = [];
  for (const row of reports.values()) {
    if (isPublicReport(row, now)) pub.push(row);
    else if (isPendingReport(row, now)) pending.push(row);
  }
  return { pub, pending };
}

// Approved reports are anonymous, so a signed-in person cannot tell which of
// the public dots are theirs. This list is the private remainder: waiting,
// not published, or expired.
export function myReportRows(reports, now) {
  return [...reports.values()]
    .filter((row) => row.status !== "approved" || !isPublicReport(row, now))
    .sort((a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0));
}

export function applyRealtime(reports, payload) {
  const eventType = payload?.eventType;
  if (eventType === "DELETE") {
    if (!payload.old?.id) return reports;
    const next = new Map(reports);
    next.delete(payload.old.id);
    return next;
  }
  if (eventType === "INSERT" || eventType === "UPDATE") {
    if (!payload.new?.id) return reports;
    const next = new Map(reports);
    next.set(payload.new.id, payload.new);
    return next;
  }
  return reports;
}

export function nextExpiry(reports, now) {
  let soonest = null;
  for (const row of reports.values()) {
    if (row.status !== "approved" && row.status !== "pending") continue;
    const t = expiryMs(row);
    if (!Number.isFinite(t) || t <= now) continue;
    if (soonest == null || t < soonest) soonest = t;
  }
  return soonest;
}

export function timeLeft(row, now) {
  const t = expiryMs(row);
  if (!Number.isFinite(t) || t <= now) return "Expired";
  const mins = Math.max(1, Math.round((t - now) / 60000));
  if (mins < 90) return `${mins} min left`;
  const hours = Math.round(mins / 60);
  return `${hours} h left`;
}

export function reportState(row, now) {
  if (row.status === "rejected") return "Not published";
  if (row.status === "pending" && isPendingReport(row, now)) return "Awaiting review";
  if (isPublicReport(row, now)) return "On the public map";
  return "Expired";
}

export function formatWhen(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "the expiry time";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  }).format(t);
}

export function formatKm(metres) {
  const n = Number(metres);
  if (!Number.isFinite(n)) return "–";
  return `${(n / 1000).toFixed(1)} km`;
}

export function formatMin(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "–";
  return `${Math.max(1, Math.round(n / 60))} min`;
}

export function emailRedirectTo(locationLike) {
  const origin = String(locationLike?.origin || "");
  let hostname = "";
  let protocol = "";
  try {
    const url = new URL(origin);
    hostname = url.hostname;
    protocol = url.protocol;
  } catch {
    hostname = "";
  }
  const local = (hostname === "localhost" || hostname === "127.0.0.1") && protocol === "http:";
  if (origin === SITE_ORIGIN || local) return `${origin}/`;
  return `${SITE_ORIGIN}/`;
}

export function validateEmail(email) {
  const trimmed = String(email || "").trim();
  if (!EMAIL.test(trimmed) || trimmed.length > 320) return fail("Enter the email address for your account.");
  return { ok: true, value: trimmed };
}

export function validateCredentials(email, password) {
  const cleaned = validateEmail(email);
  if (!cleaned.ok) return cleaned;
  const secret = String(password ?? "");
  if (secret.length < 6) return fail("Use at least 6 characters for the password.");
  if (secret.length > 72) return fail("That password is too long.");
  return { ok: true, email: cleaned.value, password: secret };
}

export function friendlyAuthError(error) {
  const msg = String(error?.message || "");
  const lower = msg.toLowerCase();
  if (!msg) return "Something went wrong. Try again.";
  if (lower.includes("invalid login") || lower.includes("invalid credentials")) return "That email and password did not match.";
  if (lower.includes("email not confirmed")) return "Confirm your email before signing in. You can resend the confirmation.";
  if (lower.includes("already registered") || lower.includes("already been registered")) {
    return "An account with that email already exists. Sign in, or resend the confirmation.";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) return "Too many emails were sent. Wait a while, then try again.";
  if (lower.includes("valid email") || lower.includes("unable to validate email")) return "Enter a valid email address.";
  if (lower.includes("password")) return msg;
  if (lower.includes("failed to fetch") || lower.includes("network")) return "Couldn’t reach the sign-in service. The map still works.";
  return msg;
}

export function friendlyDataError(error, kind) {
  const msg = String(error?.message || "");
  const lower = msg.toLowerCase();
  const report = kind === "report";
  if (error?.local && msg) return msg;
  if (lower.includes("rate limit")) return "You can file up to five reports an hour.";
  if (
    lower.includes("authentication required")
    || lower.includes("permission denied")
    || lower.includes("jwt")
    || lower.includes("not authenticated")
    || error?.code === "42501"
    || error?.code === "PGRST301"
  ) {
    return report ? "Sign in before filing a report." : "Sign in before saving a walk.";
  }
  if (lower.includes("check constraint") || lower.includes("violates check") || error?.code === "23514") {
    return report
      ? "That report is outside London or uses a category the map does not accept."
      : "That walk could not be saved. Check the name and the route.";
  }
  if (lower.includes("failed to fetch") || lower.includes("network")) return "Couldn’t reach the database. The map still works.";
  if (!msg) return report ? "The report was not filed." : "The walk was not saved.";
  return msg;
}

export function describeSignUp(result) {
  if (result?.error) {
    const message = result.error.local ? result.error.message : friendlyAuthError(result.error);
    return {
      ok: false,
      tone: "warn",
      message,
      resend: /confirm/i.test(String(result.error.message || "")),
    };
  }
  if (result?.data?.session) return { ok: true, tone: "ok", message: "Signed in.", resend: false };
  const identities = result?.data?.user?.identities;
  if (Array.isArray(identities) && identities.length === 0) {
    return {
      ok: true,
      tone: "warn",
      message: "Check your email, or sign in.",
      resend: true,
    };
  }
  return {
    ok: true,
    tone: "ok",
    message: "Check your email, then sign in.",
    resend: true,
  };
}

export function describeSignIn(result) {
  if (result?.error) {
    const message = result.error.local ? result.error.message : friendlyAuthError(result.error);
    return {
      ok: false,
      tone: "warn",
      message,
      resend: /not confirmed/i.test(String(result.error.message || "")),
    };
  }
  if (result?.data?.session) return { ok: true, tone: "ok", message: "Signed in.", resend: false };
  return { ok: false, tone: "warn", message: "Sign-in did not start a session.", resend: false };
}

export function normalizeRealtime(payload) {
  const eventType = String(payload?.eventType || payload?.event || "").toUpperCase();
  if (eventType === "DELETE") {
    const id = payload?.old?.id;
    return { eventType, old: isUuid(id) ? { id: String(id) } : null, new: null };
  }
  if (eventType === "INSERT" || eventType === "UPDATE") {
    return { eventType, old: null, new: presentReport(payload?.new) };
  }
  return { eventType: "", old: null, new: null };
}

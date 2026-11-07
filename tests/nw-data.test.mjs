import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  applyRealtime,
  approximatePoint,
  describeSignIn,
  describeSignUp,
  emailRedirectTo,
  friendlyAuthError,
  isPublicReport,
  markerSets,
  myReportRows,
  nextExpiry,
  normalizeRealtime,
  presentReport,
  presentWalk,
  reportInsertPayload,
  reportsFromRows,
  suggestWalkName,
  validateCredentials,
  walkInsertPayload,
  walkUpdatePayload,
} from "../js/nw-data.mjs";

const NOW = Date.parse("2026-11-07T16:00:00Z");
const FUTURE = "2026-11-08T16:00:00Z";
const PAST = "2026-11-07T12:00:00Z";
const ID = {
  approved: "11111111-1111-4111-8111-111111111111",
  pending: "22222222-2222-4222-8222-222222222222",
  rejected: "33333333-3333-4333-8333-333333333333",
  expired: "44444444-4444-4444-8444-444444444444",
};

function report(id, status, expires_at, extra = {}) {
  return {
    id,
    category: "lighting",
    lat: 51.507,
    lng: -0.128,
    status,
    created_at: "2026-11-07T12:00:00Z",
    expires_at,
    ...extra,
  };
}

const routeInput = {
  name: "  Evening loop  ",
  route_mode: "safest",
  user_id: "forged-user",
  id: "forged-id",
  created_at: "yesterday",
  distance: 1240.4,
  duration: 860.2,
  via: "Via the river",
  from: { lat: 51.50512, lng: -0.12004, name: "South Bank" },
  to: { lat: 51.51789, lng: -0.09001, name: "St Paul’s" },
  coords: [[-0.12004, 51.50512], [-0.1, 51.51], [-0.09001, 51.51789]],
};

test("walk insert keeps only the granted columns", () => {
  const built = walkInsertPayload(routeInput);
  assert.equal(built.ok, true);
  assert.deepEqual(Object.keys(built.value).sort(), ["distance_m", "duration_s", "name", "route_geojson", "route_mode"]);
  assert.equal(built.value.name, "Evening loop");
  assert.equal(built.value.route_mode, "safest");
  assert.equal(built.value.distance_m, 1240);
  assert.equal(built.value.duration_s, 860);
  assert.equal(built.value.route_geojson.type, "Feature");
  assert.equal(built.value.route_geojson.geometry.type, "LineString");
  assert.deepEqual(built.value.route_geojson.geometry.coordinates[0], [-0.12004, 51.50512]);
  assert.equal(built.value.user_id, undefined);
  assert.equal(built.value.id, undefined);
  assert.equal(built.value.created_at, undefined);
});

test("walk insert rejects a bad mode, an empty name, and an oversized path", () => {
  assert.equal(walkInsertPayload({ ...routeInput, route_mode: "scenic" }).ok, false);
  assert.equal(walkInsertPayload({ ...routeInput, name: "   " }).ok, false);
  const coords = Array.from({ length: 8000 }, (_, i) => [-0.12 + i / 100000, 51.5]);
  const huge = walkInsertPayload({ ...routeInput, coords });
  assert.equal(huge.ok, false);
  assert.match(huge.error, /too detailed/i);
});

test("rename sends a name and nothing else", () => {
  const built = walkUpdatePayload("  Night bus  ");
  assert.deepEqual(built.value, { name: "Night bus" });
  assert.equal(walkUpdatePayload(" ").ok, false);
});

test("saved walks drop identity fields before display", () => {
  const walk = presentWalk({
    id: ID.approved,
    name: "Mine",
    route_mode: "balanced",
    route_geojson: routeInput && {
      type: "Feature",
      geometry: { type: "LineString", coordinates: routeInput.coords },
      properties: {},
    },
    distance_m: 10,
    duration_s: 20,
    created_at: FUTURE,
    user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "other@example.com",
  });
  assert.equal(walk.user_id, undefined);
  assert.equal(walk.email, undefined);
  assert.equal(Object.hasOwn(walk, "user_id"), false);
  assert.equal(suggestWalkName(routeInput), "South Bank to St Paul’s");
});

test("report insert is category and rounded coordinates only", () => {
  const built = reportInsertPayload({
    category: "blocked-path",
    lat: 51.5074,
    lng: -0.1278,
    status: "approved",
    note: "free text",
    user_id: "forged",
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.value, { category: "blocked-path", lat: 51.507, lng: -0.128 });
  assert.equal(reportInsertPayload({ category: "crime", lat: 51.5, lng: -0.1 }).ok, false);
  assert.match(approximatePoint(51.2, -0.1).error, /Greater London/);
  assert.equal(approximatePoint(51.28, -0.52).ok, true);
  assert.equal(approximatePoint(51.7, 0.34).ok, true);
});

test("public markers are approved and unexpired, and pending stays separate", () => {
  const rows = [
    report(ID.approved, "approved", FUTURE, { email: "a@b.c", note: "secret", user_id: "nope" }),
    report(ID.pending, "pending", FUTURE),
    report(ID.rejected, "rejected", FUTURE),
    report(ID.expired, "approved", PAST),
  ];
  const map = reportsFromRows(rows);
  const approved = map.get(ID.approved);
  assert.equal(Object.hasOwn(approved, "email"), false);
  assert.equal(Object.hasOwn(approved, "note"), false);
  assert.equal(Object.hasOwn(approved, "user_id"), false);
  const sets = markerSets(map, NOW);
  assert.deepEqual(sets.pub.map((row) => row.id), [ID.approved]);
  assert.deepEqual(sets.pending.map((row) => row.id), [ID.pending]);
  assert.equal(isPublicReport(map.get(ID.expired), NOW), false);
  const mine = myReportRows(map, NOW).map((row) => row.id);
  assert.deepEqual(mine.sort(), [ID.expired, ID.pending, ID.rejected].sort());
  assert.equal(mine.includes(ID.approved), false);
});

test("realtime keeps allowlisted fields and drops expired rows from the marker sets", () => {
  let map = reportsFromRows([report(ID.pending, "pending", FUTURE)]);
  map = applyRealtime(map, normalizeRealtime({
    eventType: "UPDATE",
    new: report(ID.pending, "approved", FUTURE, { email: "walker@example.com", free_text: "no" }),
  }));
  assert.equal(map.get(ID.pending).status, "approved");
  assert.equal(Object.hasOwn(map.get(ID.pending), "email"), false);
  map = applyRealtime(map, normalizeRealtime({
    eventType: "INSERT",
    new: report(ID.approved, "approved", FUTURE),
  }));
  map = applyRealtime(map, normalizeRealtime({ eventType: "DELETE", old: { id: ID.approved, email: "x@y.z" } }));
  assert.equal(map.has(ID.approved), false);
  map = applyRealtime(map, normalizeRealtime({
    eventType: "UPDATE",
    new: report(ID.pending, "approved", PAST),
  }));
  assert.equal(markerSets(map, NOW).pub.length, 0);
  assert.equal(markerSets(map, NOW).pending.length, 0);
  assert.equal(nextExpiry(reportsFromRows([report(ID.approved, "approved", FUTURE)]), NOW), Date.parse(FUTURE));
  assert.equal(presentReport({ id: "not-a-uuid", category: "lighting", lat: 1, lng: 1, status: "approved" }), null);
});

test("auth copy does not treat sign-up as verified", () => {
  const pending = describeSignUp({ data: { user: { identities: [{ id: "1" }] }, session: null }, error: null });
  assert.equal(pending.resend, true);
  assert.match(pending.message, /not treated as verified/i);
  const existing = describeSignUp({ data: { user: { identities: [] }, session: null }, error: null });
  assert.match(existing.message, /not treated as verified/i);
  const signed = describeSignIn({ data: { session: { user: {} } }, error: null });
  assert.equal(signed.message, "Signed in.");
  assert.match(friendlyAuthError({ message: "Email not confirmed" }), /resend/i);
  assert.match(friendlyAuthError({ message: "Invalid login credentials" }), /did not match/i);
  assert.equal(validateCredentials("not-an-email", "secret").ok, false);
  assert.equal(validateCredentials("walker@example.com", "short").ok, false);
});

test("redirects stay on the Night Watch origin", () => {
  assert.equal(emailRedirectTo({ origin: "https://thenightwatch.pages.dev" }), "https://thenightwatch.pages.dev/");
  assert.equal(emailRedirectTo({ origin: "http://127.0.0.1:4173" }), "http://127.0.0.1:4173/");
  assert.equal(emailRedirectTo({ origin: "https://evil.example" }), "https://thenightwatch.pages.dev/");
  assert.equal(emailRedirectTo({ origin: "http://localhost:8080" }), "http://localhost:8080/");
});

test("the site never ships a secret key, background tracking, or a free-text report", () => {
  const files = [
    "index.html",
    "js/account.mjs",
    "js/nw-ui.mjs",
    "js/nw-actions.mjs",
    "js/nw-data.mjs",
    "js/nw-preview.mjs",
    "js/supabase-config.mjs",
    "js/supabase-client.mjs",
    "js/map.js",
  ];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(/service_role|sb_secret_/.test(text), false, file);
    assert.equal(text.includes("watchPosition"), false, file);
  }
  const ui = readFileSync(new URL("../js/nw-ui.mjs", import.meta.url), "utf8");
  assert.equal(ui.includes("getCurrentPosition"), true);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(html.includes("<textarea"), false);
  assert.match(html, /call 999/);
  assert.match(html, /not a promise of safety/i);
  const account = readFileSync(new URL("../js/account.mjs", import.meta.url), "utf8");
  assert.match(account, /127\.0\.0\.1/);
  assert.match(account, /nwtest/);
  const sql = readFileSync(new URL("../supabase/migrations/20261107162100_nightwatch_reports_walks.sql", import.meta.url), "utf8");
  assert.match(sql, /Do not run this file/);
  assert.match(sql, /own walks select/);
  assert.match(sql, /public approved unexpired/);
  assert.match(sql, /supabase_realtime/);
});

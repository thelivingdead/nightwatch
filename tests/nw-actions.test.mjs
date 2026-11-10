import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deleteWalk,
  insertReport,
  insertWalk,
  listReports,
  listWalks,
  renameWalk,
  requestPasswordReset,
  resendSignup,
  signIn,
  signOut,
  signUp,
  subscribeReports,
} from "../js/nw-actions.mjs";
import { createPreviewClient } from "../js/nw-preview.mjs";
import { createRecorder } from "./mock-client.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const walk = {
  name: "Bridge loop",
  route_mode: "fastest",
  user_id: "forged",
  id: "forged",
  created_at: "nope",
  distance: 800,
  duration: 600,
  from: { lat: 51.5, lng: -0.12, name: "A" },
  to: { lat: 51.51, lng: -0.11, name: "B" },
  coords: [[-0.12, 51.5], [-0.11, 51.51]],
};

test("auth calls use email and password and do not invent a session", async () => {
  const client = createRecorder();
  const redirectTo = "https://thenightwatch.pages.dev/";
  await signUp(client, {
    email: " Walker@Example.com ",
    password: "correct horse",
    username: " Night_Walker ",
    emailRedirectTo: redirectTo,
  });
  await signIn(client, { email: "walker@example.com", password: "correct horse" });
  await resendSignup(client, { email: "walker@example.com", emailRedirectTo: redirectTo });
  await requestPasswordReset(client, { email: "walker@example.com", emailRedirectTo: redirectTo });
  await signOut(client);
  const signUpCall = client.calls.find((call) => call.op === "signUp");
  assert.equal(signUpCall.body.email, "Walker@Example.com");
  assert.equal(signUpCall.body.password, "correct horse");
  assert.deepEqual(signUpCall.body.options, {
    emailRedirectTo: redirectTo,
    data: { username: "Night_Walker" },
  });
  const signInCall = client.calls.find((call) => call.op === "signInWithPassword");
  assert.equal(signInCall.body.email, "walker@example.com");
  assert.equal(signInCall.body.password, "correct horse");
  assert.equal("username" in signInCall.body, false);
  assert.deepEqual(client.calls.find((call) => call.op === "resend").body, {
    type: "signup",
    email: "walker@example.com",
    options: { emailRedirectTo: redirectTo },
  });
  assert.equal(client.calls.find((call) => call.op === "resetPasswordForEmail").options.redirectTo, redirectTo);
  assert.deepEqual(client.calls.find((call) => call.op === "signOut").options, { scope: "global" });
  const bad = createRecorder();
  const refused = await signUp(bad, { email: "nope", password: "correct horse", username: "night.walker", emailRedirectTo: redirectTo });
  assert.equal(refused.error.local, true);
  assert.equal(bad.calls.length, 0);
});

test("sign-up stores a trimmed username and refuses a handle that does not fit", async () => {
  const redirectTo = "https://thenightwatch.pages.dev/";
  const client = createRecorder();
  await signUp(client, {
    email: "walker@example.com",
    password: "correct horse",
    username: "  night.walker  ",
    emailRedirectTo: redirectTo,
  });
  assert.deepEqual(client.calls[0].body.options.data, { username: "night.walker" });
  for (const username of ["", "  ", "no", "a".repeat(25), "night walker", "night@watch", "café"]) {
    const skipped = createRecorder();
    const rejected = await signUp(skipped, {
      email: "walker@example.com",
      password: "correct horse",
      username,
      emailRedirectTo: redirectTo,
    });
    assert.equal(rejected.error.local, true, username);
    assert.match(rejected.error.message, /3 to 24/);
    assert.equal(skipped.calls.length, 0);
  }
});

test("walk CRUD stays on the caller's own rows and the granted columns", async () => {
  const client = createRecorder();
  await listWalks(client);
  await insertWalk(client, walk);
  await renameWalk(client, ID, "  Renamed loop  ");
  await deleteWalk(client, ID);
  const listed = client.calls.find((call) => call.op === "select");
  assert.equal(listed.table, "saved_walks");
  assert.equal(listed.select, "id,name,route_mode,route_geojson,distance_m,duration_s,created_at");
  assert.deepEqual(listed.order, { col: "created_at", opts: { ascending: false } });
  const inserted = client.calls.find((call) => call.op === "insert");
  assert.deepEqual(Object.keys(inserted.payload).sort(), ["distance_m", "duration_s", "name", "route_geojson", "route_mode"]);
  assert.equal(inserted.select, null);
  const renamed = client.calls.find((call) => call.op === "update");
  assert.deepEqual(renamed.payload, { name: "Renamed loop" });
  assert.deepEqual(renamed.eq, { col: "id", val: ID });
  const removed = client.calls.find((call) => call.op === "delete");
  assert.deepEqual(removed.eq, { col: "id", val: ID });
  const outside = createRecorder();
  const rejected = await insertWalk(outside, { ...walk, route_mode: "scenic" });
  assert.equal(rejected.error.local, true);
  assert.equal(outside.calls.length, 0);
});

test("report insert does not request the new row back", async () => {
  const client = createRecorder();
  await listReports(client);
  const result = await insertReport(client, { category: "lighting", lat: 51.5134, lng: -0.0984, status: "approved", note: "no" });
  assert.equal(result.error, null);
  const listed = client.calls.find((call) => call.op === "select");
  assert.equal(listed.select, "id,category,lat,lng,status,created_at,expires_at");
  const inserted = client.calls.find((call) => call.op === "insert");
  assert.equal(inserted.table, "community_reports");
  assert.equal(inserted.select, null);
  assert.deepEqual(inserted.payload, { category: "lighting", lat: 51.513, lng: -0.098 });
  const skipped = createRecorder();
  const rejected = await insertReport(skipped, { category: "lighting", lat: 48, lng: 0 });
  assert.match(rejected.error.message, /Greater London/);
  assert.equal(skipped.calls.length, 0);
});

test("realtime subscription listens to community reports only", () => {
  const client = createRecorder();
  const seen = [];
  const channel = subscribeReports(client, (payload) => seen.push(payload), () => {});
  assert.equal(channel.name, "reports");
  assert.deepEqual(channel.filter, { event: "*", schema: "public", table: "community_reports" });
  channel.handler({ eventType: "INSERT", new: { id: "x" } });
  assert.equal(seen.length, 1);
});

test("preview client hides another person's walk and pending report", async () => {
  const client = createPreviewClient();
  const anonWalks = await client.from("saved_walks").select("id,name").order("created_at", { ascending: false });
  assert.equal(anonWalks.error.code, "42501");
  const anonReports = await client.from("community_reports").select("id,category,lat,lng,status,created_at,expires_at");
  assert.equal(anonReports.data.length, 1);
  assert.equal(anonReports.data[0].status, "approved");
  assert.equal(JSON.stringify(anonReports.data).includes("Someone else's walk home"), false);
  assert.equal(anonReports.data.some((row) => row.status === "pending"), false);
  await client.auth.signInWithPassword({ email: "walker@example.com", password: "correct horse" });
  const ownWalks = await client.from("saved_walks").select("id,name");
  assert.deepEqual(ownWalks.data, []);
  assert.equal(JSON.stringify(ownWalks.data).includes("Someone else's walk home"), false);
  const ownReports = await client.from("community_reports").select("id,status");
  assert.equal(ownReports.data.some((row) => row.id === "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), false);
  const inserted = await client.from("community_reports").insert({ category: "uncomfortable-experience", lat: 51.5, lng: -0.12 });
  assert.equal(inserted.data, null);
  assert.equal(inserted.error, null);
  const after = await client.from("community_reports").select("id,status,category");
  const mine = after.data.find((row) => row.category === "uncomfortable-experience");
  assert.equal(mine.status, "pending");
  assert.equal(mine.owner, undefined);
  client.__moderate(mine.id, { status: "approved", expires_at: new Date(Date.now() - 1000).toISOString() });
  const expired = await client.from("community_reports").select("id");
  assert.equal(expired.data.some((row) => row.id === mine.id), true);
});

test("preview sign-up remembers the username for the later sign-in", async () => {
  const client = createPreviewClient();
  const signedUp = await client.auth.signUp({
    email: "walker@example.com",
    password: "correct horse",
    options: { emailRedirectTo: "http://127.0.0.1:4173/", data: { username: "night.walker" } },
  });
  assert.equal(signedUp.data.session, null);
  assert.equal(signedUp.data.user.user_metadata.username, "night.walker");
  assert.equal(signedUp.data.user.identities.length, 1);
  const signedIn = await client.auth.signInWithPassword({ email: "walker@example.com", password: "correct horse" });
  assert.equal(signedIn.data.session.user.user_metadata.username, "night.walker");
  const other = createPreviewClient();
  const plain = await other.auth.signInWithPassword({ email: "walker@example.com", password: "correct horse" });
  assert.deepEqual(plain.data.user.user_metadata, {});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../js/supabase-config.mjs";

const headers = {
  apikey: SUPABASE_PUBLISHABLE_KEY,
  Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
  Accept: "application/json",
};

test("live anon read: public reports are readable and saved walks are not", async () => {
  assert.equal(SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_"), true);
  assert.equal(SUPABASE_PUBLISHABLE_KEY.includes("service_role"), false);
  const reports = await fetch(`${SUPABASE_URL}/rest/v1/community_reports?select=id,category,lat,lng,status,created_at,expires_at&limit=20`, { headers });
  assert.equal(reports.status, 200);
  const rows = await reports.json();
  assert.ok(Array.isArray(rows));
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["category", "created_at", "expires_at", "id", "lat", "lng", "status"]);
    assert.equal(row.status, "approved");
    assert.equal(row.user_id, undefined);
    assert.ok(Date.parse(row.expires_at) > Date.now() - 120000);
  }
  const walks = await fetch(`${SUPABASE_URL}/rest/v1/saved_walks?select=id,name&limit=1`, { headers });
  assert.equal(walks.status, 401);
  const body = await walks.json();
  assert.equal(body.code, "42501");
});

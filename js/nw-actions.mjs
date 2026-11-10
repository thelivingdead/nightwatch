// Query shapes for Night Watch. Callers pass a Supabase client.
// Walk inserts omit id, user_id, and created_at. Report inserts omit status
// and do not ask the API to return the row.

import {
  emailRedirectTo,
  friendlyDataError,
  reportInsertPayload,
  validateCredentials,
  validateEmail,
  validateUsername,
  walkInsertPayload,
  walkUpdatePayload,
  isUuid,
} from "./nw-data.mjs";

const WALK_COLUMNS = "id,name,route_mode,route_geojson,distance_m,duration_s,created_at";
const REPORT_COLUMNS = "id,category,lat,lng,status,created_at,expires_at";

function localError(message) {
  return { data: null, error: { message, local: true } };
}

export function redirectFor(locationLike) {
  return emailRedirectTo(locationLike);
}

export async function signUp(supabase, { email, password, username, emailRedirectTo: redirectTo }) {
  const creds = validateCredentials(email, password);
  if (!creds.ok) return localError(creds.error);
  const handle = validateUsername(username);
  if (!handle.ok) return localError(handle.error);
  // There is no profiles table. Auth stores this on the user as user_metadata.
  return supabase.auth.signUp({
    email: creds.email,
    password: creds.password,
    options: {
      emailRedirectTo: redirectTo,
      data: { username: handle.value },
    },
  });
}

export async function signIn(supabase, { email, password }) {
  const creds = validateCredentials(email, password);
  if (!creds.ok) return localError(creds.error);
  return supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
}

export async function resendSignup(supabase, { email, emailRedirectTo: redirectTo }) {
  const cleaned = validateEmail(email);
  if (!cleaned.ok) return localError(cleaned.error);
  return supabase.auth.resend({
    type: "signup",
    email: cleaned.value,
    options: { emailRedirectTo: redirectTo },
  });
}

export async function requestPasswordReset(supabase, { email, emailRedirectTo: redirectTo }) {
  const cleaned = validateEmail(email);
  if (!cleaned.ok) return localError(cleaned.error);
  return supabase.auth.resetPasswordForEmail(cleaned.value, { redirectTo });
}

export async function signOut(supabase) {
  return supabase.auth.signOut({ scope: "global" });
}

export function listWalks(supabase) {
  return supabase.from("saved_walks").select(WALK_COLUMNS).order("created_at", { ascending: false });
}

export function insertWalk(supabase, input) {
  const built = walkInsertPayload(input);
  if (!built.ok) return Promise.resolve(localError(built.error));
  return supabase.from("saved_walks").insert(built.value);
}

export function renameWalk(supabase, id, name) {
  const built = walkUpdatePayload(name);
  if (!built.ok) return Promise.resolve(localError(built.error));
  if (!isUuid(id)) return Promise.resolve(localError("That walk could not be found."));
  return supabase.from("saved_walks").update(built.value).eq("id", id);
}

export function deleteWalk(supabase, id) {
  if (!isUuid(id)) return Promise.resolve(localError("That walk could not be found."));
  return supabase.from("saved_walks").delete().eq("id", id);
}

export function listReports(supabase) {
  return supabase.from("community_reports").select(REPORT_COLUMNS);
}

export function insertReport(supabase, input) {
  const built = reportInsertPayload(input);
  if (!built.ok) return Promise.resolve(localError(built.error));
  return supabase.from("community_reports").insert(built.value);
}

export function subscribeReports(supabase, onPayload, onStatus) {
  return supabase
    .channel("reports")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "community_reports" },
      (payload) => onPayload(payload),
    )
    .subscribe((status) => onStatus?.(status));
}

export function explainDataError(error, kind) {
  return friendlyDataError(error, kind);
}

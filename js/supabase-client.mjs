import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase-config.mjs";

// Implicit flow matches the browser client: after the site URL is configured,
// a confirmation link can return tokens in the URL hash without a server.
export function createNightwatchClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "implicit",
    },
  });
}

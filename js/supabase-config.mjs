// Public browser configuration. The publishable key is meant to ship in the
// site; row level security is what keeps walks and unpublished reports private.
// Never add a service-role or secret key to this file or anywhere else in the site.

export const SUPABASE_URL = "https://pnxsrycurozugxpiragc.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_-SUmlBgF2fK-tsrs15YFmQ_CgG3eg80";

// Auth > URL Configuration is not set on the project yet. Confirmation and
// password-reset links cannot be treated as working until the owner sets:
//   Site URL: https://thenightwatch.pages.dev
//   Redirect URLs: https://thenightwatch.pages.dev/**
//   and any local http://localhost:* or http://127.0.0.1:* origin used for checks.
export const SITE_ORIGIN = "https://thenightwatch.pages.dev";

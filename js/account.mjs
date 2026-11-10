import { mountNightwatchAccount } from "./nw-ui.mjs?v=picker-1";

const fold = document.getElementById("account-fold");
let started = false;

function note(message) {
  const status = document.getElementById("account-status");
  if (status) status.textContent = message;
}

async function boot() {
  if (started) return;
  started = true;
  const previewRequested = new URLSearchParams(window.location.search).has("nwtest");
  const localHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
  const preview = previewRequested && localHost;
  try {
    const supabase = preview
      ? (await import("./nw-preview.mjs")).createPreviewClient()
      : (await import("./supabase-client.mjs")).createNightwatchClient();
    if (preview) window.__NW_PREVIEW = supabase;
    mountNightwatchAccount({
      supabase,
      planner: window.NW_planner || null,
      map: window.NW_map || null,
      preview,
    });
  } catch (error) {
    console.error(error);
    started = false;
    note("Sign-in is unavailable.");
  }
}

function schedule() {
  const run = () => { boot(); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1500 });
  else setTimeout(run, 1);
}

if (document.readyState === "complete") schedule();
else window.addEventListener("load", schedule, { once: true });

fold?.addEventListener("toggle", () => {
  if (fold.open) boot();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !fold?.open || !fold.contains(document.activeElement)) return;
  event.__nightwatchClosedFold = true;
  fold.open = false;
  fold.querySelector("summary")?.focus();
});

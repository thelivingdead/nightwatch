import { mountNightwatchAccount } from "./nw-ui.mjs";

const previewRequested = new URLSearchParams(window.location.search).has("nwtest");
const localHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
const preview = previewRequested && localHost;

const button = document.getElementById("account-open");

function showUnavailable(message) {
  const dialog = document.getElementById("account-dialog");
  const status = document.getElementById("account-status");
  if (!button || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.addEventListener("click", () => {
    if (status) status.textContent = message;
    if (dialog && !dialog.open) dialog.showModal();
  });
}

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
  if (button) button.dataset.bound = "1";
} catch (error) {
  console.error(error);
  showUnavailable("Sign-in is unavailable right now. The map still works.");
}

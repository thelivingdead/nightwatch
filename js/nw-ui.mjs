// Account, private walks, and community reports on the existing map page.

import {
  applyRealtime,
  approximatePoint,
  categoryLabel,
  describeSignIn,
  describeSignUp,
  formatKm,
  formatMin,
  formatWhen,
  friendlyAuthError,
  isPendingReport,
  isPublicReport,
  markerSets,
  modeLabel,
  myReportRows,
  nextExpiry,
  normalizeRealtime,
  presentWalk,
  reportState,
  reportsFromRows,
  suggestWalkName,
  timeLeft,
} from "./nw-data.mjs";
import {
  deleteWalk,
  explainDataError,
  insertReport,
  insertWalk,
  listReports,
  listWalks,
  redirectFor,
  renameWalk,
  requestPasswordReset,
  resendSignup,
  signIn,
  signOut,
  signUp,
  subscribeReports,
} from "./nw-actions.mjs";

const MARK = {
  lighting: "cat-lighting",
  "blocked-path": "cat-blocked-path",
  "uncomfortable-experience": "cat-uncomfortable-experience",
};

function setNote(el, text, tone) {
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-ok", tone === "ok");
  el.classList.toggle("is-warn", tone === "warn");
}

function popupHtml(row, pending) {
  const label = categoryLabel(row.category);
  const until = formatWhen(row.expires_at)
    .replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const kicker = pending ? "Your report, awaiting review" : "Unverified community report";
  const body = pending
    ? "Only you can see this until a moderator approves it. The point is approximate, about 100 metres. It is not a police record and not an emergency alert."
    : "Noted by a signed-in walker. Rounded to about 100 metres. Not checked, not a police record, and not a promise of safety.";
  return `<p class="report-kicker">${kicker}</p><h4>${label}</h4><p>${body}</p><p class="report-until">Shown until ${until}.</p>`;
}

export function mountNightwatchAccount({ supabase, planner, map, preview = false }) {
  const dialog = document.getElementById("account-dialog");
  const walkList = document.getElementById("walk-list");
  const reportList = document.getElementById("report-list");
  if (!dialog || !supabase || !walkList || !reportList) return;

  const $ = (id) => document.getElementById(id);
  let session = null;
  let generation = 0;
  let channel = null;
  let reports = new Map();
  let walkById = new Map();
  let currentSnap = null;
  let draftLat = null;
  let draftLng = null;
  let expiryTimer = 0;
  let returnFocus = null;
  const reportLayer = map && window.L ? window.L.layerGroup() : null;
  if (reportLayer && map) reportLayer.addTo(map);

  if (preview) {
    $("account-preview").hidden = false;
    const bar = $("preview-bar");
    if (bar) bar.hidden = false;
  }

  function signedIn() {
    return Boolean(session?.user);
  }

  function updateSaveButton() {
    const button = $("walk-save-btn");
    if (!button) return;
    button.textContent = signedIn() ? "Save this walk" : "Sign in to save";
  }

  function paintAccount() {
    const on = signedIn();
    $("account-signed-in").hidden = !on;
    $("account-form").hidden = on;
    const email = session?.user?.email || "";
    $("account-email").textContent = email ? `Signed in as ${email}` : "";
    const label = on ? "Account" : "Sign in";
    $("account-open-text").textContent = label;
    $("account-open").setAttribute("aria-label", label);
    updateSaveButton();
    syncReportButton();
  }

  function setTab(mode) {
    const creating = mode === "up";
    $("account-tab-in").setAttribute("aria-selected", String(!creating));
    $("account-tab-up").setAttribute("aria-selected", String(creating));
    $("account-title").textContent = creating ? "Create account" : "Sign in";
    $("account-submit").textContent = creating ? "Create account" : "Sign in";
    $("account-prerequisite").hidden = !creating;
    $("account-password-input").setAttribute("autocomplete", creating ? "new-password" : "current-password");
    $("account-form").dataset.mode = creating ? "up" : "in";
  }

  function openAccount(mode) {
    returnFocus = document.activeElement;
    if (!signedIn()) setTab(mode || "in");
    paintAccount();
    if (!dialog.open) dialog.showModal();
    (signedIn() ? $("account-out") : $("account-email-input"))?.focus();
  }

  function renderWalks() {
    walkList.replaceChildren();
    const empty = $("walk-empty");
    if (!signedIn()) {
      empty.hidden = false;
      empty.textContent = "Sign in to save a walk. Only you can see the list.";
      return;
    }
    const rows = [...walkById.values()].sort(
      (a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0),
    );
    empty.hidden = rows.length > 0;
    empty.textContent = "No saved walks yet. Plan a route, name it, and save it.";
    for (const walk of rows) walkList.append(walkRecord(walk));
  }

  function linkButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function walkRecord(walk) {
    const li = document.createElement("li");
    li.className = "record";
    const top = document.createElement("div");
    top.className = "record-top";
    const title = document.createElement("strong");
    title.textContent = walk.name;
    const meta = document.createElement("span");
    meta.className = "record-meta";
    meta.textContent = `${modeLabel(walk.route_mode)} · ${formatKm(walk.distance_m)} · ${formatMin(walk.duration_s)}`;
    top.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "record-actions";
    actions.append(
      linkButton("Show on map", () => {
        try {
          planner?.showSavedWalk?.(walk);
        } catch (err) {
          setNote($("walk-save-note"), err.message || "That walk could not be drawn.", "warn");
        }
      }),
      linkButton("Rename", () => startRename(li, walk)),
      linkButton("Delete", () => confirmDelete(actions, walk)),
    );
    li.append(top, actions);
    return li;
  }

  function startRename(li, walk) {
    const form = document.createElement("form");
    form.className = "rename-form";
    const input = document.createElement("input");
    input.value = walk.name;
    input.maxLength = 60;
    input.required = true;
    input.setAttribute("aria-label", "New name for this walk");
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "link-btn";
    save.textContent = "Save name";
    const cancel = linkButton("Cancel", () => form.remove());
    form.append(input, save, cancel);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      const result = await renameWalk(supabase, walk.id, input.value);
      if (result.error) {
        setNote($("walk-save-note"), explainDataError(result.error, "walk"), "warn");
        save.disabled = false;
        return;
      }
      await reloadWalks(generation);
      const updated = walkById.get(walk.id);
      setNote(
        $("walk-save-note"),
        updated ? "Renamed. Only your account can see it." : "That walk is no longer in your account.",
        updated ? "ok" : "warn",
      );
    });
    li.append(form);
    input.focus();
    input.select();
  }

  function confirmDelete(actions, walk) {
    actions.replaceChildren();
    const ask = document.createElement("span");
    ask.textContent = "Delete this walk from your account?";
    const yes = linkButton("Delete walk", async () => {
      yes.disabled = true;
      const result = await deleteWalk(supabase, walk.id);
      if (result.error) {
        setNote($("walk-save-note"), explainDataError(result.error, "walk"), "warn");
        yes.disabled = false;
        return;
      }
      await reloadWalks(generation);
      setNote(
        $("walk-save-note"),
        walkById.has(walk.id) ? "That walk is still on your account." : "Deleted from your account.",
        walkById.has(walk.id) ? "warn" : "ok",
      );
    });
    actions.append(ask, yes, linkButton("Keep", () => renderWalks()));
  }

  function renderReportList(now) {
    reportList.replaceChildren();
    const empty = $("report-empty");
    const rows = signedIn() ? myReportRows(reports, now) : [];
    if (!signedIn()) {
      empty.hidden = false;
      empty.textContent = "Sign in to file a report. Approved reports appear on the map with no name attached.";
      return;
    }
    empty.hidden = rows.length > 0;
    empty.textContent = "Nothing waiting. An approved report joins the public map without your name, so it leaves this list.";
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "record";
      const top = document.createElement("div");
      top.className = "record-top";
      const title = document.createElement("strong");
      title.textContent = categoryLabel(row.category);
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = reportState(row, now);
      top.append(title, tag);
      const meta = document.createElement("p");
      meta.className = "record-meta";
      const where = planner?.placeLabel?.(row.lat, row.lng) || "London";
      meta.textContent = `${where} · approximate · ${timeLeft(row, now)}`;
      li.append(top, meta);
      reportList.append(li);
    }
  }

  function ensureMarker(row, pending) {
    if (!reportLayer || !window.L) return;
    const icon = window.L.divIcon({
      className: `nw-report${pending ? " is-pending" : ""}`,
      html: `<span class="nw-report-pin ${MARK[row.category] || "cat-lighting"}"></span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = window.L.marker([row.lat, row.lng], {
      icon,
      keyboard: true,
      title: pending ? "Your report, awaiting review" : "Unverified community report",
      zIndexOffset: pending ? 400 : 300,
    });
    const label = pending ? "Your report, awaiting review" : "Unverified community report";
    marker.bindTooltip(`${label} · ${categoryLabel(row.category)}`, { direction: "top", offset: [0, -8] });
    marker.bindPopup(popupHtml(row, pending), { className: "nw-popup", maxWidth: 280 });
    marker.on("popupopen", () => marker.closeTooltip());
    marker.addTo(reportLayer);
  }

  function syncLayerVisibility() {
    const toggle = $("layer-reports");
    if (!reportLayer || !map || !toggle) return;
    const on = toggle.checked;
    if (on && !map.hasLayer(reportLayer)) reportLayer.addTo(map);
    if (!on && map.hasLayer(reportLayer)) map.removeLayer(reportLayer);
  }

  function paintReports() {
    const now = Date.now();
    if (reportLayer) {
      reportLayer.clearLayers();
      const sets = markerSets(reports, now);
      for (const row of sets.pub) ensureMarker(row, false);
      for (const row of sets.pending) ensureMarker(row, true);
      syncLayerVisibility();
    }
    renderReportList(now);
    clearTimeout(expiryTimer);
    const at = nextExpiry(reports, now);
    if (at != null) {
      const delay = Math.max(250, Math.min(at - now + 40, 30 * 60 * 1000));
      expiryTimer = setTimeout(paintReports, delay);
    }
  }

  function setLive(status) {
    const el = $("report-live");
    if (!el) return;
    const on = status === "SUBSCRIBED";
    el.classList.toggle("is-on", on);
    if (on) el.textContent = "Live";
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") el.textContent = "Paused";
    else el.textContent = "Connecting";
  }

  async function reloadWalks(gen) {
    if (!signedIn()) {
      walkById = new Map();
      renderWalks();
      return;
    }
    const result = await listWalks(supabase);
    if (gen !== generation) return;
    if (result.error) {
      setNote($("walk-save-note"), explainDataError(result.error, "walk"), "warn");
      return;
    }
    const next = new Map();
    for (const row of result.data || []) {
      const walk = presentWalk(row);
      if (walk) next.set(walk.id, walk);
    }
    walkById = next;
    renderWalks();
  }

  async function reloadReports(gen) {
    const result = await listReports(supabase);
    if (gen !== generation) return;
    if (result.error) {
      setNote($("report-status"), explainDataError(result.error, "report"), "warn");
      return;
    }
    reports = reportsFromRows(result.data);
    paintReports();
  }

  async function resubscribe(gen) {
    if (channel) {
      const old = channel;
      channel = null;
      try { await supabase.removeChannel(old); } catch { /* a dropped channel should not block the map */ }
    }
    if (gen !== generation) return;
    channel = subscribeReports(
      supabase,
      (payload) => {
        reports = applyRealtime(reports, normalizeRealtime(payload));
        paintReports();
      },
      setLive,
    );
  }

  async function applySession(next) {
    const gen = ++generation;
    session = next || null;
    if (!session) {
      walkById = new Map();
      renderWalks();
      setNote($("walk-save-note"), "", "");
    }
    paintAccount();
    await reloadWalks(gen);
    await reloadReports(gen);
    await resubscribe(gen);
  }

  function syncReportButton() {
    const button = $("report-submit");
    const selected = document.querySelector("#report-form input[name=category]:checked");
    const ready = Boolean(selected && draftLat != null && draftLng != null);
    button.disabled = !ready;
    button.textContent = !signedIn() && ready ? "Sign in to file" : "File report";
  }

  function setPoint(lat, lng) {
    const point = approximatePoint(lat, lng);
    $("report-cancel").hidden = true;
    if (!point.ok) {
      draftLat = null;
      draftLng = null;
      setNote($("report-place-note"), point.error, "warn");
      syncReportButton();
      return;
    }
    draftLat = point.value.lat;
    draftLng = point.value.lng;
    setNote($("report-place-note"), pointNote(), "ok");
    syncReportButton();
  }

  function pointNote() {
    const where = planner?.placeLabel?.(draftLat, draftLng) || "Greater London";
    return `Approximate point in ${where} (${draftLat.toFixed(3)}, ${draftLng.toFixed(3)}). About 100 metres, not the exact spot.`;
  }

  function cancelPin() {
    planner?.cancelReportPick?.();
    $("report-cancel").hidden = true;
    if (draftLat == null) {
      setNote($("report-place-note"), "No point chosen. A pin is placed only when you ask, and your location is not tracked.", "");
      return;
    }
    setNote($("report-place-note"), pointNote(), "ok");
  }

  $("account-open").addEventListener("click", () => openAccount("in"));
  $("account-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
  });
  $("account-tab-in").addEventListener("click", () => setTab("in"));
  $("account-tab-up").addEventListener("click", () => setTab("up"));

  $("account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("account-email-input").value;
    const password = $("account-password-input").value;
    const creating = $("account-form").dataset.mode === "up";
    const submit = $("account-submit");
    submit.disabled = true;
    setNote($("account-status"), "Working…", "");
    const redirectTo = redirectFor(window.location);
    const result = creating
      ? await signUp(supabase, { email, password, emailRedirectTo: redirectTo })
      : await signIn(supabase, { email, password });
    submit.disabled = false;
    const described = creating ? describeSignUp(result) : describeSignIn(result);
    setNote($("account-status"), described.message, described.tone);
    $("account-resend").hidden = !described.resend;
    if (described.ok && result?.data?.session) $("account-password-input").value = "";
  });

  $("account-resend").addEventListener("click", async () => {
    const result = await resendSignup(supabase, {
      email: $("account-email-input").value,
      emailRedirectTo: redirectFor(window.location),
    });
    setNote(
      $("account-status"),
      result.error
        ? (result.error.local ? result.error.message : friendlyAuthError(result.error))
        : "Another confirmation has been requested. It is not verified from this page.",
      result.error ? "warn" : "ok",
    );
  });

  $("account-reset").addEventListener("click", async () => {
    const result = await requestPasswordReset(supabase, {
      email: $("account-email-input").value,
      emailRedirectTo: redirectFor(window.location),
    });
    setNote(
      $("account-status"),
      result.error
        ? (result.error.local ? result.error.message : friendlyAuthError(result.error))
        : "If that email has an account, a reset message has been requested. The link can open this site only after the Supabase Site URL is set.",
      result.error ? "warn" : "ok",
    );
  });

  $("account-out").addEventListener("click", async () => {
    walkById = new Map();
    renderWalks();
    setNote($("walk-save-note"), "", "");
    const result = await signOut(supabase);
    if (result?.error) setNote($("account-status"), friendlyAuthError(result.error), "warn");
    else setNote($("account-status"), "Signed out.", "ok");
  });

  $("walk-save-btn")?.addEventListener("click", async () => {
    if (!currentSnap) return;
    if (!signedIn()) {
      setNote($("walk-save-note"), "Sign in to save this walk. It stays private to your account.", "warn");
      openAccount("in");
      return;
    }
    const button = $("walk-save-btn");
    button.disabled = true;
    const name = $("walk-name").value.trim() || suggestWalkName(currentSnap);
    const result = await insertWalk(supabase, {
      name,
      route_mode: currentSnap.mode,
      distance: currentSnap.distance,
      duration: currentSnap.duration,
      coords: currentSnap.coords,
      from: currentSnap.from,
      to: currentSnap.to,
      via: currentSnap.via,
    });
    button.disabled = false;
    if (result.error) {
      setNote($("walk-save-note"), explainDataError(result.error, "walk"), "warn");
      return;
    }
    if (!$("walk-name").value.trim()) $("walk-name").value = name;
    setNote($("walk-save-note"), "Saved privately to your account.", "ok");
    const section = $("your-walks");
    if (section) section.open = true;
    await reloadWalks(generation);
  });

  planner?.subscribe?.((snap) => {
    currentSnap = snap;
    const box = $("walk-save");
    if (box) box.hidden = !snap;
    updateSaveButton();
  });

  $("report-form").addEventListener("change", syncReportButton);
  $("report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = document.querySelector("#report-form input[name=category]:checked");
    if (!signedIn()) {
      setNote($("report-status"), "Sign in to file a report. Nothing is sent until you do.", "warn");
      openAccount("in");
      return;
    }
    const button = $("report-submit");
    button.disabled = true;
    const result = await insertReport(supabase, {
      category: selected?.value,
      lat: draftLat,
      lng: draftLng,
    });
    if (result.error) {
      setNote($("report-status"), explainDataError(result.error, "report"), "warn");
      syncReportButton();
      return;
    }
    draftLat = null;
    draftLng = null;
    planner?.cancelReportPick?.();
    $("report-cancel").hidden = true;
    $("report-form").reset();
    setNote($("report-place-note"), "No point chosen. A pin is placed only when you ask, and your location is not tracked.", "");
    setNote(
      $("report-status"),
      "Filed for review. It stays off the public map until a moderator approves it. It expires 48 hours after it was filed. Only you can see it while it waits. This is not an emergency alert.",
      "ok",
    );
    await reloadReports(generation);
    syncReportButton();
  });

  $("report-pin").addEventListener("click", () => {
    if (!planner?.armReportPick) {
      setNote($("report-place-note"), "The map is not ready for a pin yet.", "warn");
      return;
    }
    planner.armReportPick((latlng) => setPoint(latlng.lat, latlng.lng));
    $("report-cancel").hidden = false;
    setNote($("report-place-note"), "Click the map to place an approximate point. Press Escape to cancel. Night Watch does not follow you.", "");
  });

  $("report-cancel").addEventListener("click", cancelPin);
  $("report-locate").addEventListener("click", () => {
    planner?.cancelReportPick?.();
    $("report-cancel").hidden = true;
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
      setNote($("report-place-note"), "This browser cannot share a location. Drop a pin instead.", "warn");
      return;
    }
    setNote($("report-place-note"), "Asking once for an approximate point. Night Watch does not keep watching your location.", "");
    navigator.geolocation.getCurrentPosition(
      (pos) => setPoint(pos.coords.latitude, pos.coords.longitude),
      () => setNote($("report-place-note"), "Location was not available. You can drop a pin on the map instead.", "warn"),
      { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 },
    );
  });

  $("layer-reports")?.addEventListener("change", syncLayerVisibility);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || dialog.open) return;
    if (planner?.isReporting?.()) cancelPin();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) paintReports();
  });
  setInterval(paintReports, 30000);

  supabase.auth.onAuthStateChange((_event, next) => {
    setTimeout(() => {
      applySession(next).catch(() => {
        setNote($("account-status"), "Couldn’t reach the sign-in service. The map still works.", "warn");
      });
    }, 0);
  });

  paintAccount();
  renderWalks();
  renderReportList(Date.now());
}

export function isPublicMarker(row, now) {
  return isPublicReport(row, now);
}

export function isPendingMarker(row, now) {
  return isPendingReport(row, now);
}

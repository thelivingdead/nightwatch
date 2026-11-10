// Account, private walks, and community reports on the existing map page.

import {
  applyRealtime,
  approximatePoint,
  categoryLabel,
  londonPhotonUrl,
  PHOTON_MIN_QUERY,
  placesFromPhoton,
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
  const kicker = pending ? "Awaiting review" : "Unverified report";
  return `<p class="report-kicker">${kicker}</p><h4>${label}</h4><p class="report-until">Until ${until}.</p>`;
}

export function mountNightwatchAccount({ supabase, planner, map, preview = false }) {
  const fold = document.getElementById("account-fold");
  const walkList = document.getElementById("walk-list");
  const reportList = document.getElementById("report-list");
  if (!fold || !supabase || !walkList || !reportList) return;

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
  const reportLayer = map && window.L ? window.L.layerGroup() : null;
  if (reportLayer && map) reportLayer.addTo(map);

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
    updateSaveButton();
    syncReportButton();
  }

  function setTab(mode) {
    const creating = mode === "up";
    $("account-tab-in").setAttribute("aria-selected", String(!creating));
    $("account-tab-up").setAttribute("aria-selected", String(creating));
    $("account-title").textContent = creating ? "Create account" : "Sign in";
    $("account-submit").textContent = creating ? "Create account" : "Sign in";
    $("account-password-input").setAttribute("autocomplete", creating ? "new-password" : "current-password");
    $("account-form").dataset.mode = creating ? "up" : "in";
  }

  function openAccount(mode) {
    if (!signedIn()) setTab(mode || "in");
    paintAccount();
    fold.open = true;
    (signedIn() ? $("account-out") : $("account-email-input"))?.focus();
  }

  function renderWalks() {
    walkList.replaceChildren();
    const empty = $("walk-empty");
    if (!signedIn()) {
      empty.hidden = false;
      empty.textContent = "Sign in to save a walk.";
      return;
    }
    const rows = [...walkById.values()].sort(
      (a, b) => (Date.parse(b.created_at || "") || 0) - (Date.parse(a.created_at || "") || 0),
    );
    empty.hidden = rows.length > 0;
    empty.textContent = "No saved walks yet.";
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
          setNote($("walk-save-note"), err.message || "Could not draw that walk.", "warn");
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
        updated ? "Renamed." : "Walk not found.",
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
    ask.textContent = "Delete this walk?";
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
        walkById.has(walk.id) ? "Still saved." : "Deleted.",
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
      empty.textContent = "No reports yet.";
      return;
    }
    empty.hidden = rows.length > 0;
    empty.textContent = "Nothing waiting.";
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
      meta.textContent = `${where} · ${timeLeft(row, now)}`;
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
      title: pending ? "Awaiting review" : "Unverified report",
      zIndexOffset: pending ? 400 : 300,
    });
    const label = pending ? "Awaiting review" : "Unverified report";
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
    return `${where} · ${draftLat.toFixed(3)}, ${draftLng.toFixed(3)}`;
  }

  let searchTimer = 0;
  let searchAbort = null;
  let searchResults = [];
  let searchActive = -1;
  let pickerMap = null;
  let pickerMarker = null;
  const pickerEsri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";

  function pickerOpen() {
    const panel = $("report-picker");
    return Boolean(panel && !panel.hidden);
  }

  function hideSuggestions() {
    const list = $("report-search-list");
    const input = $("report-search");
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
    searchResults = [];
    searchActive = -1;
    input?.setAttribute("aria-expanded", "false");
    input?.removeAttribute("aria-activedescendant");
  }

  function abortSearch() {
    clearTimeout(searchTimer);
    searchTimer = 0;
    if (searchAbort) searchAbort.abort();
    searchAbort = null;
  }

  function closePicker({ keepNote = false } = {}) {
    if (!pickerOpen()) return;
    abortSearch();
    hideSuggestions();
    $("report-picker").hidden = true;
    $("report-cancel").hidden = true;
    if (keepNote) return;
    if (draftLat != null) setNote($("report-place-note"), pointNote(), "ok");
    else setNote($("report-place-note"), "", "");
  }

  function cancelPin() {
    planner?.cancelReportPick?.();
    if (pickerOpen()) closePicker();
    else {
      $("report-cancel").hidden = true;
      if (draftLat == null) setNote($("report-place-note"), "", "");
      else setNote($("report-place-note"), pointNote(), "ok");
    }
  }

  function ensurePickerMap() {
    if (pickerMap) return pickerMap;
    const el = $("report-picker-map");
    pickerMap = window.L.map(el, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false,
      rotate: false,
      touchRotate: false,
      shiftKeyRotate: false,
      rotateControl: false,
    });
    window.L.tileLayer(`${pickerEsri}World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      maxNativeZoom: 16,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &middot; &copy; <a href="https://www.esri.com/">Esri</a>',
    }).addTo(pickerMap);
    const labels = pickerMap.createPane("pickerLabels");
    labels.style.zIndex = "450";
    labels.style.pointerEvents = "none";
    window.L.tileLayer(`${pickerEsri}World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19,
      maxNativeZoom: 16,
      pane: "pickerLabels",
      className: "nw-labels",
    }).addTo(pickerMap);
    pickerMap.setView([51.5072, -0.1276], 11);
    pickerMap.on("click", (event) => placePickerMarker(event.latlng));
    return pickerMap;
  }

  function placePickerMarker(latlng, { pan = false } = {}) {
    const map = ensurePickerMap();
    if (!pickerMarker) {
      pickerMarker = window.L.marker(latlng, {
        draggable: true,
        keyboard: false,
        autoPan: true,
        icon: window.L.divIcon({
          className: "nw-pin",
          html: '<span style="--pin:#8FDCFF"></span>',
          iconSize: [26, 34],
          iconAnchor: [13, 39],
        }),
      }).addTo(map);
      pickerMarker.on("dragend", () => {
        $("report-picker-use").disabled = false;
      });
    } else {
      pickerMarker.setLatLng(latlng);
    }
    $("report-picker-use").disabled = false;
    if (pan) map.setView(latlng, Math.max(map.getZoom(), 16));
  }

  function clearPickerMarker() {
    if (pickerMarker) {
      pickerMarker.remove();
      pickerMarker = null;
    }
    const use = $("report-picker-use");
    if (use) use.disabled = true;
  }

  function openPicker(point) {
    const panel = $("report-picker");
    if (!panel || !window.L) {
      setNote($("report-place-note"), "The map is not ready for a pin yet.", "warn");
      return;
    }
    panel.hidden = false;
    $("report-search").value = "";
    abortSearch();
    hideSuggestions();
    setNote(
      $("report-place-note"),
      point ? "Check this spot, then use it." : "Choose a spot, then use it.",
      "",
    );
    const apply = () => {
      const map = ensurePickerMap();
      map.invalidateSize();
      if (point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))) {
        placePickerMarker(window.L.latLng(point.lat, point.lng), { pan: true });
      } else {
        clearPickerMarker();
        map.setView([51.5072, -0.1276], 11);
      }
    };
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(() => pickerMap?.invalidateSize());
    });
    panel.scrollIntoView({ block: "nearest", inline: "nearest" });
    $("report-search")?.focus({ preventScroll: true });
  }

  function confirmPicker() {
    if (!pickerMarker) return;
    const { lat, lng } = pickerMarker.getLatLng();
    const check = approximatePoint(lat, lng);
    setPoint(lat, lng);
    if (!check.ok) return;
    closePicker({ keepNote: true });
    $("report-pin")?.focus();
  }

  function setSearchActive(index) {
    searchActive = index;
    const buttons = [...$("report-search-list").querySelectorAll("button")];
    buttons.forEach((button, i) => button.setAttribute("aria-selected", String(i === index)));
    const id = buttons[index]?.id;
    if (id) $("report-search").setAttribute("aria-activedescendant", id);
    buttons[index]?.scrollIntoView({ block: "nearest" });
  }

  function renderSuggestions(places, note) {
    const list = $("report-search-list");
    const input = $("report-search");
    list.replaceChildren();
    searchResults = places;
    searchActive = places.length ? 0 : -1;
    if (!places.length) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = note;
      list.append(item);
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    places.forEach((place, i) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.id = `report-place-${i}`;
      button.dataset.i = String(i);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(i === 0));
      const strong = document.createElement("strong");
      strong.textContent = place.main;
      button.append(strong);
      if (place.detail) {
        const small = document.createElement("small");
        small.textContent = place.detail;
        button.append(small);
      }
      item.append(button);
      list.append(item);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", "report-place-0");
  }

  function choosePlace(index) {
    const place = searchResults[index];
    if (!place || !window.L) return;
    hideSuggestions();
    $("report-search").value = place.main;
    placePickerMarker(window.L.latLng(place.lat, place.lng), { pan: true });
  }

  async function runPickerSearch(query) {
    if (searchAbort) searchAbort.abort();
    const controller = new AbortController();
    searchAbort = controller;
    try {
      const res = await fetch(londonPhotonUrl(query), { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (searchAbort !== controller) return;
      const places = placesFromPhoton(data);
      renderSuggestions(places, "No places found in London.");
    } catch (err) {
      if (controller.signal.aborted || searchAbort !== controller) return;
      renderSuggestions([], "Search isn’t available right now. You can still tap the map.");
    }
  }

  $("account-close").addEventListener("click", () => {
    fold.open = false;
    fold.querySelector("summary")?.focus();
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
        : "Confirmation requested.",
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
        : "Reset email requested.",
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
      setNote($("walk-save-note"), "Sign in to save.", "warn");
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
    setNote($("walk-save-note"), "Saved.", "ok");
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
      setNote($("report-status"), "Sign in to file a report.", "warn");
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
    closePicker({ keepNote: true });
    $("report-cancel").hidden = true;
    $("report-form").reset();
    setNote($("report-place-note"), "", "");
    setNote($("report-status"), "Awaiting review.", "ok");
    await reloadReports(generation);
    syncReportButton();
  });

  $("report-pin").addEventListener("click", () => {
    planner?.cancelReportPick?.();
    const point = draftLat != null ? { lat: draftLat, lng: draftLng } : null;
    openPicker(point);
  });

  $("report-cancel").addEventListener("click", cancelPin);
  $("report-picker-close").addEventListener("click", () => {
    closePicker();
    $("report-pin")?.focus();
  });
  $("report-picker-cancel").addEventListener("click", () => {
    closePicker();
    $("report-pin")?.focus();
  });
  $("report-picker-use").addEventListener("click", confirmPicker);
  $("report-search").addEventListener("input", () => {
    abortSearch();
    const query = $("report-search").value.trim();
    if (query.length < PHOTON_MIN_QUERY) {
      hideSuggestions();
      return;
    }
    searchTimer = setTimeout(() => { runPickerSearch(query); }, 300);
  });
  $("report-search").addEventListener("keydown", (event) => {
    const count = searchResults.length;
    const open = !$("report-search-list").hidden;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count && open) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSearchActive((searchActive + step + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (count && open) choosePlace(Math.max(0, searchActive));
    }
  });
  $("report-search").addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement === $("report-search")) return;
      if ($("report-search-list")?.contains(document.activeElement)) return;
      hideSuggestions();
    }, 180);
  });
  $("report-search-list").addEventListener("mousedown", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    event.preventDefault();
    choosePlace(Number(button.dataset.i));
  });
  $("report-locate").addEventListener("click", () => {
    planner?.cancelReportPick?.();
    $("report-cancel").hidden = true;
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== "function") {
      setNote($("report-place-note"), "Location is unavailable. Drop a pin.", "warn");
      return;
    }
    setNote($("report-place-note"), "Getting a point…", "");
    navigator.geolocation.getCurrentPosition(
      (pos) => openPicker({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setNote($("report-place-note"), "Location was not available.", "warn"),
      { enableHighAccuracy: false, maximumAge: 0, timeout: 8000 },
    );
  });

  $("layer-reports")?.addEventListener("change", syncLayerVisibility);
  fold.addEventListener("toggle", () => {
    if (!fold.open) closePicker();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !pickerOpen()) return;
    event.preventDefault();
    event.stopPropagation();
    if (!$("report-search-list").hidden) {
      hideSuggestions();
      return;
    }
    closePicker();
    $("report-pin")?.focus();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.__nightwatchClosedFold) return;
    if (fold.open && fold.contains(document.activeElement)) return;
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

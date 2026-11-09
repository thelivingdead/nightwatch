(() => {
  const el = document.getElementById("leaflet");
  const LD = window.NW_LONDON;
  const OUTLINES = window.NW_BOROUGHS;
  if (!window.L || !LD || !OUTLINES) {
    el.innerHTML = '<p style="padding:24px;color:#9AA8B8">The map could not load. Check your connection and refresh.</p>';
    return;
  }

  const CATEGORY_META = {
    "violent-crime": ["Violence & sexual offences", 3.0],
    "robbery": ["Robbery", 3.0],
    "possession-of-weapons": ["Possession of weapons", 2.5],
    "theft-from-the-person": ["Theft from the person", 2.0],
    "public-order": ["Public order", 1.5],
    "drugs": ["Drugs", 1.0],
    "anti-social-behaviour": ["Anti-social behaviour", 1.0],
    "criminal-damage-arson": ["Criminal damage & arson", 1.0],
    "other-crime": ["Other crime", 1.0],
    "burglary": ["Burglary", 0.5],
    "other-theft": ["Other theft", 0.5],
    "vehicle-crime": ["Vehicle crime", 0.5],
    "bicycle-theft": ["Bicycle theft", 0.3],
    "shoplifting": ["Shoplifting", 0.2],
  };
  const catLabel = (slug) => (CATEGORY_META[slug] || [slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())])[0];
  const catWeight = (slug) => (CATEGORY_META[slug] || [null, 1.0])[1];

  // The eight map colours live in the stylesheet as --crime-*, most serious first.
  const css = getComputedStyle(document.documentElement);
  const cssVar = (name) => css.getPropertyValue(name).trim();
  const CRIME_TYPES = [
    { id: "violent", label: "Violent & sexual", short: "violent", cats: ["violent-crime"] },
    { id: "robbery", label: "Robbery", short: "robbery", cats: ["robbery"] },
    { id: "burglary", label: "Burglary", short: "burglary", cats: ["burglary"] },
    { id: "vehicle", label: "Vehicle crime", short: "vehicle", cats: ["vehicle-crime"] },
    { id: "drugs", label: "Drugs", short: "drugs", cats: ["drugs"] },
    { id: "theft", label: "Theft", short: "theft", cats: ["theft-from-the-person", "other-theft", "shoplifting", "bicycle-theft"] },
    { id: "asb", label: "Anti-social behaviour", short: "ASB", cats: ["anti-social-behaviour"] },
    { id: "other", label: "Other", short: "other", cats: ["possession-of-weapons", "public-order", "criminal-damage-arson", "other-crime"] },
  ].map((t) => ({ ...t, color: cssVar(`--crime-${t.id}`) }));
  const OTHER = CRIME_TYPES.length - 1;
  const typeIndex = {};
  CRIME_TYPES.forEach((t, i) => t.cats.forEach((c) => { typeIndex[c] = i; }));
  LD.categories.forEach((c) => {
    if (!(c in typeIndex)) { typeIndex[c] = OTHER; CRIME_TYPES[OTHER].cats.push(c); }
  });
  const ACCENT = cssVar("--nights-watch");
  const DANGER = cssVar("--crime-violent");

  const BUFFER_M = 40;
  const SCORE_REF = 150;
  const AREA_MAX_ZOOM = 13;
  const BOROUGH_CLICK_MAX_ZOOM = 12;
  const ROUTER = "https://routing.openstreetmap.de/routed-foot/route/v1/foot/";
  const STREETISH = /\b(Street|St|Road|Lane|Place|Square|Row|Court|Avenue|Way|Walk|Gardens|Mews|Yard|Alley|Passage|Circus|Hill|Gate|Terrace|Market|Strand|Haymarket|Mall|Piccadilly|Kingsway|Holborn|Aldwych|Broadway|Embankment|Crescent|Buildings|Green|Common|Park|Rise|Grove|Parade|Drive|Close)$/i;
  const LABEL_ZOOM = 16;
  const HEX_COLORS = ["#2a0009", "#4A0010", "#7a0a1f", "#E8202A", "#FF4D1A", "#FF8A3D", "#FFC07A", "#FFD3A8"];
  const HEX_ALPHA = [0.35, 0.45, 0.55, 0.62, 0.7, 0.78, 0.85, 0.92];

  const PRESETS = [
    { label: "Oxford Circus → Covent Garden", from: [51.5152, -0.1419, "Oxford Circus"], to: [51.5129, -0.1243, "Covent Garden"] },
    { label: "Camden Town → King’s Cross", from: [51.5392, -0.1426, "Camden Town"], to: [51.5308, -0.1238, "King’s Cross"] },
    { label: "Brixton → Clapham Common", from: [51.4627, -0.1145, "Brixton"], to: [51.4618, -0.1384, "Clapham Common"] },
  ];

  const monthLabel = new Date(LD.month + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const fmt = (n) => n.toLocaleString("en-GB");

  /* Local projection in metres around central London */
  const origin = { lat: 51.5072, lng: -0.1276 };
  const kx = 111320 * Math.cos((origin.lat * Math.PI) / 180);
  const ky = 110540;
  const project = (lat, lng) => [(lng - origin.lng) * kx, (lat - origin.lat) * ky];
  const unproject = (x, y) => L.latLng(origin.lat + y / ky, origin.lng + x / kx);

  /* Data: one entry per snapped location, with counts per category */
  const locations = (() => {
    const [south, west] = LD.origin;
    const byKey = new Map();
    for (const [dy, dx, ci, n, si] of LD.points) {
      const key = dy + ":" + dx;
      let loc = byKey.get(key);
      if (!loc) {
        const lat = south + dy / 1e5;
        const lng = west + dx / 1e5;
        const [x, y] = project(lat, lng);
        const world = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), 0);
        loc = { lat, lng, x, y, px: world.x, py: world.y, street: LD.streets[si], cats: {} };
        byKey.set(key, loc);
      }
      const cat = LD.categories[ci];
      loc.cats[cat] = (loc.cats[cat] || 0) + n;
    }
    return [...byKey.values()];
  })();

  const boroughs = OUTLINES.features.map((f) => {
    const stats = LD.boroughs.find((b) => b.code === f.properties.code);
    const polys = f.geometry.coordinates;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly[0]) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    return { code: f.properties.code, name: f.properties.name, polys, bbox: [minX, minY, maxX, maxY], areaKm2: stats.areaKm2, byCat: stats.byCat, feature: f };
  });

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function boroughAt(latlng) {
    const x = latlng.lng;
    const y = latlng.lat;
    return boroughs.find((b) => x >= b.bbox[0] && x <= b.bbox[2] && y >= b.bbox[1] && y <= b.bbox[3]
      && b.polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)))) || null;
  }

  const state = {
    enabled: new Set(LD.categories),
    points: [],
    hexes: null,
    from: null,
    to: null,
    routes: [],
    selected: -1,
    mode: "safest",
    eps: 60,
    minw: 50,
    request: null,
    rankExpanded: false,
  };
  let reportPick = null;
  const checked = (id) => document.getElementById(id).checked;

  /* Map + panes */
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NEEDLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="needle-n" d="M12 2.5 15.2 12H8.8z"/><path class="needle-s" d="M12 21.5 8.8 12h6.4z"/><circle class="needle-pin" cx="12" cy="12" r="1.6"/></svg>';
  if (L.Control.Rotate) {
    // The compass only reports the bearing and turns the map back to north; rotating happens on the map itself.
    L.Control.Rotate.include({
      onAdd(m) {
        const box = L.DomUtil.create("div", "leaflet-control-rotate");
        this._link = L.DomUtil.create("a", "leaflet-control-rotate-toggle", box);
        this._link.href = "#";
        this._link.setAttribute("role", "button");
        this._arrow = L.DomUtil.create("span", "leaflet-control-rotate-arrow", this._link);
        this._arrow.innerHTML = NEEDLE;
        this._readout = L.DomUtil.create("span", "leaflet-control-rotate-readout", box);
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(this._link, "click", (e) => { L.DomEvent.preventDefault(e); faceNorth(); });
        m.on("rotate", this._restyle, this);
        this._restyle();
        return box;
      },
      _restyle() {
        const bearing = this._map.getBearing();
        const deg = Math.round(bearing) % 360;
        const label = deg ? `Map turned ${deg}° from north. Click to face north` : "Map faces north";
        this._arrow.style.transform = `rotate(${bearing}deg)`;
        this._link.title = label;
        this._link.setAttribute("aria-label", label);
        this._readout.textContent = `${deg}°`;
        this._readout.hidden = !deg;
      },
    });
  }

  // shiftKeyRotate is off because the plugin re-enables wheel zoom on every plain scroll, which traps the page.
  const map = L.map(el, {
    zoomControl: false, scrollWheelZoom: false, boxZoom: false, minZoom: 9, zoomSnap: 0.25, maxBoundsViscosity: 0.8,
    rotate: true, bearing: 0, touchRotate: true, shiftKeyRotate: false, rotateControl: false,
  });
  window.NW_map = map;
  L.control.zoom({ position: "topright" }).addTo(map);
  // Added after the zoom buttons so the compass sits beneath them.
  if (L.control.rotate) L.control.rotate({ position: "topright", closeOnZeroBearing: false }).addTo(map);
  map.attributionControl.setPrefix(false);

  // The map sits inside a scrolling page, so the wheel only zooms once someone has clicked into it.
  map.on("focus mousedown", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());
  el.addEventListener("mouseleave", () => map.scrollWheelZoom.disable());

  // Keep fitted content clear of the fixed nav and of the panel when it floats over the map.
  const NAV_HEIGHT = 64;
  const sheet = document.getElementById("sheet");
  function fitTo(bounds, opts = {}) {
    const gap = opts.gap ?? 40;
    const floating = getComputedStyle(sheet).position === "absolute";
    const tl = L.point(floating ? sheet.offsetLeft + sheet.offsetWidth + gap : gap, NAV_HEIGHT + gap);
    const br = L.point(gap, gap);
    const zoom = Math.min(map.getBoundsZoom(bounds, false, tl.add(br)), opts.maxZoom ?? Infinity);
    // The padding is on screen, so turn its offset through the bearing before moving the centre.
    const { cos, sin } = screenFrame(map);
    const v = br.subtract(tl).divideBy(2);
    const mid = map.project(bounds.getSouthWest(), zoom).add(map.project(bounds.getNorthEast(), zoom)).divideBy(2);
    map.setView(map.unproject(mid.add([v.x * cos + v.y * sin, v.y * cos - v.x * sin]), zoom), zoom, { animate: opts.animate });
  }
  // With rotation on, map-aligned panes belong in the plugin's rotating pane; markers expect the upright one.
  const pane = (name, z, cls, parent = "rotatePane") => {
    const p = map.createPane(name, map.getPane(parent));
    p.style.zIndex = z;
    if (cls) p.classList.add(cls);
  };
  pane("areas", 405);
  pane("boroughs", 415);
  pane("hotspots", 420);
  pane("dots", 430);
  pane("rawCrimes", 435);
  pane("labels", 440, "labels-pane");
  pane("boroughLabels", 445, "labels-pane", "norotatePane");
  pane("rings", 455);
  pane("routes", 460);
  pane("darkest", 448);
  pane("giCells", 449);
  const giPane = map.getPane("giCells");
  if (giPane) giPane.style.pointerEvents = "none";

  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
  L.tileLayer(`${ESRI}World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19,
    maxNativeZoom: 16,
    attribution: 'Basemap &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Crime: <a href="https://data.police.uk/">police.uk</a> (OGL v3.0) · Boundaries: ONS',
  }).addTo(map);
  L.tileLayer(`${ESRI}World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19,
    maxNativeZoom: 16,
    pane: "labels",
    className: "nw-labels",
  }).addTo(map);

  const areaRenderer = L.canvas({ pane: "areas", padding: 0.3 });
  const layers = {
    areas: L.layerGroup().addTo(map),
    heat: null,
    hotspots: L.layerGroup(),
    rings: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    boroughLabels: L.layerGroup(),
    darkest: L.layerGroup().addTo(map),
    giHot: L.layerGroup(),
    giFocus: L.layerGroup().addTo(map),
  };

  const outlineStyle = { pane: "boroughs", interactive: false, color: "#ffffff", weight: 1, opacity: 0.22, fill: false };
  const boroughLayer = L.geoJSON(OUTLINES, { style: () => outlineStyle }).addTo(map);
  boroughLayer.eachLayer((layer) => {
    const b = boroughs.find((x) => x.code === layer.feature.properties.code);
    b.layer = layer;
  });
  const londonBounds = boroughLayer.getBounds();
  map.setMaxBounds(londonBounds.pad(0.25));

  function labelPoint(b) {
    let best = null;
    let bestArea = 0;
    for (const poly of b.polys) {
      const ring = poly[0];
      let a = 0; let cx = 0; let cy = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        a += f;
        cx += (ring[j][0] + ring[i][0]) * f;
        cy += (ring[j][1] + ring[i][1]) * f;
      }
      if (Math.abs(a) > bestArea) {
        bestArea = Math.abs(a);
        best = [cy / (3 * a), cx / (3 * a)];
      }
    }
    return best;
  }
  boroughs.forEach((b) => {
    L.marker(labelPoint(b), {
      pane: "boroughLabels",
      interactive: false,
      keyboard: false,
      icon: L.divIcon({ className: "borough-label", html: `<span>${b.name.replace(/ and /g, " & ")}</span>`, iconSize: [0, 0] }),
    }).addTo(layers.boroughLabels);
  });

  /* Aggregation by enabled category */
  function aggregate() {
    const points = [];
    for (const loc of locations) {
      let count = 0;
      let weight = 0;
      let type = CRIME_TYPES.length;
      let typeCount = 0;
      const cats = {};
      for (const cat in loc.cats) {
        if (!state.enabled.has(cat)) continue;
        const n = loc.cats[cat];
        count += n;
        weight += n * catWeight(cat);
        cats[cat] = n;
        const t = typeIndex[cat];
        if (t < type) { type = t; typeCount = n; } else if (t === type) typeCount += n;
      }
      if (count) points.push({ lat: loc.lat, lng: loc.lng, x: loc.x, y: loc.y, px: loc.px, py: loc.py, street: loc.street, count, weight, cats, type, typeCount });
    }
    // Least serious first, so the most serious dots are painted on top.
    points.sort((a, b) => b.type - a.type);
    state.points = points;
  }

  function boroughTotal(b) {
    return b.byCat.reduce((s, n, i) => s + (state.enabled.has(LD.categories[i]) ? n : 0), 0);
  }

  function breakdown(cats, limit = 4) {
    return Object.entries(cats)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([slug, n]) => `<li>${fmt(n)} × ${catLabel(slug)}</li>`)
      .join("");
  }

  /* Crime areas: hexagon grid across London */
  const SQRT3 = Math.sqrt(3);
  const hexSizeForZoom = (z) => (z < 10.5 ? 1100 : z < 11.5 ? 750 : z < 12.5 ? 480 : 320);
  function hexAt(x, y, size) {
    const q = ((SQRT3 / 3) * x - y / 3) / size;
    const r = ((2 / 3) * y) / size;
    const s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    const rs = Math.round(s);
    const dq = Math.abs(rq - q);
    const dr = Math.abs(rr - r);
    const ds = Math.abs(rs - s);
    if (dq > dr && dq > ds) rq = -rr - rs;
    else if (dr > ds) rr = -rq - rs;
    return [rq, rr];
  }
  function hexCorners(q, r, size) {
    const cx = size * SQRT3 * (q + r / 2);
    const cy = size * 1.5 * r;
    const out = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      out.push(unproject(cx + size * Math.cos(a), cy + size * Math.sin(a)));
    }
    return out;
  }

  function drawAreas() {
    layers.areas.clearLayers();
    state.hexes = null;
    if (!checked("layer-areas") || map.getZoom() > AREA_MAX_ZOOM) return;
    const size = hexSizeForZoom(map.getZoom());
    const bins = new Map();
    for (const p of state.points) {
      const [q, r] = hexAt(p.x, p.y, size);
      const key = q + "," + r;
      let bin = bins.get(key);
      if (!bin) { bin = { q, r, count: 0, cats: {} }; bins.set(key, bin); }
      bin.count += p.count;
      for (const cat in p.cats) bin.cats[cat] = (bin.cats[cat] || 0) + p.cats[cat];
    }
    const counts = [...bins.values()].map((b) => b.count).sort((a, b) => a - b);
    const breaks = [0.3, 0.5, 0.65, 0.77, 0.86, 0.93, 0.98].map((q) => counts[Math.floor(q * (counts.length - 1))] || 0);
    for (const bin of bins.values()) {
      const cls = breaks.filter((v) => bin.count > v).length;
      L.polygon(hexCorners(bin.q, bin.r, size * 0.97), {
        renderer: areaRenderer,
        interactive: false,
        color: HEX_COLORS[cls],
        weight: 0.6,
        opacity: 0.6,
        fillColor: HEX_COLORS[cls],
        fillOpacity: HEX_ALPHA[cls],
      }).addTo(layers.areas);
    }
    state.hexes = { size, bins, areaKm2: ((3 * SQRT3) / 2) * size * size / 1e6 };
  }

  /* Screen-sized canvases (dots, heat) */
  // Layer points reach the screen through the bearing; reading the mapping off the map keeps it exact with or without rotation.
  function screenFrame(m) {
    const a = m.layerPointToContainerPoint([0, 0]);
    const b = m.layerPointToContainerPoint([1e4, 0]);
    const cos = (b.x - a.x) / 1e4;
    const sin = (b.y - a.y) / 1e4;
    const angle = Math.atan2(sin, cos);
    return { a, cos, sin, angle: Math.abs(angle) < 1e-9 ? 0 : angle };
  }
  // The canvas lives in a pane that turns with the map, so it is turned back to line up with the container.
  function placeUpright(m, canvas) {
    const tl = m.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setTransform(canvas, tl, 1, -screenFrame(m).angle, tl);
  }
  // Zooming from centre c0 to e.center scales screen points by s about the container: P' = s·P + C(1 − s) + s·R(w(c0) − w(e.center)).
  function zoomUpright(m, canvas, e) {
    const z = m.getZoom();
    const s = m.getZoomScale(e.zoom, z);
    const { cos, sin, angle } = screenFrame(m);
    const d = m.project(m.getCenter(), z).subtract(m.project(e.center, z));
    const half = m.getSize().divideBy(2);
    const t = m.containerPointToLayerPoint([
      half.x * (1 - s) + s * (d.x * cos - d.y * sin),
      half.y * (1 - s) + s * (d.x * sin + d.y * cos),
    ]);
    L.DomUtil.setTransform(canvas, t, s, -angle, t);
  }
  // Until a turn is redrawn the canvas rotates with its pane, so it stays on the streets; only text leans for a frame.
  const Upright = {
    _onRotate() {
      if (this._turnFrame) return;
      this._turnFrame = requestAnimationFrame(() => {
        this._turnFrame = 0;
        if (this._map && !this._zooming) this._reset();
      });
    },
    _animateZoom(e) {
      if (this._turnFrame) {
        cancelAnimationFrame(this._turnFrame);
        this._turnFrame = 0;
        this._reset();
      }
      this._zooming = true;
      zoomUpright(this._map, this._canvas, e);
    },
  };

  // leaflet.heat draws in container space but assumes an unrotated pane.
  if (L.HeatLayer) {
    L.HeatLayer.include(Upright);
    L.HeatLayer.include({
      getEvents() {
        return { rotate: this._onRotate };
      },
      _reset() {
        const m = this._map;
        const size = m.getSize();
        this._zooming = false;
        this._canvas.style.transformOrigin = "0 0";
        placeUpright(m, this._canvas);
        if (this._heat._width !== size.x) this._canvas.width = this._heat._width = size.x;
        if (this._heat._height !== size.y) this._canvas.height = this._heat._height = size.y;
        this._redraw();
      },
    });
  }

  /* Street-level layers */
  function drawHeat() {
    if (layers.heat) map.removeLayer(layers.heat);
    layers.heat = L.heatLayer(state.points.map((p) => [p.lat, p.lng, p.count]), {
      radius: 18,
      blur: 22,
      maxZoom: 15,
      max: 34,
      minOpacity: 0.04,
      gradient: { 0.0: "rgba(74,0,16,0)", 0.25: "#4A0010", 0.45: "#E8202A", 0.6: "#FF4D1A", 0.75: "#FF8A3D", 0.9: "#FFC07A", 1.0: "#FFD3A8" },
    });
  }

  /* Crime dots: one glowing dot per snapped location, in the colour of its most serious crime */
  function glowSprite(color) {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "#FFF4E8");
    grad.addColorStop(0.14, color);
    grad.addColorStop(0.34, color + "80");
    grad.addColorStop(1, color + "00");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }
  const sprites = CRIME_TYPES.map((t) => glowSprite(t.color));
  const dotSize = (z) => (z < 10.5 ? 2.6 : z < 11.5 ? 3.2 : z < 12.5 ? 4.2 : z < 13.5 ? 5.6 : z < 14.5 ? 7.5 : z < 15.5 ? 9.5 : 11.5);
  const HIT_CELL = 24;
  let dotHits = null;

  function paintDots(g, size) {
    const z = map.getZoom();
    const scale = map.getZoomScale(z, 0);
    const o = map.getPixelOrigin();
    // World pixels at zoom 0 to container pixels: scale, subtract the pixel origin, turn by the bearing, shift.
    const { a, cos, sin } = screenFrame(map);
    const xx = scale * cos;
    const xy = -scale * sin;
    const yx = scale * sin;
    const yy = scale * cos;
    const tx = a.x - o.x * cos + o.y * sin;
    const ty = a.y - o.x * sin - o.y * cos;
    const base = dotSize(z);
    const grow = z >= 13 ? 0.32 : 0.12;
    const hits = z > BOROUGH_CLICK_MAX_ZOOM ? new Map() : null;
    const visible = [];

    g.globalCompositeOperation = z < 14 ? "lighter" : "source-over";
    g.globalAlpha = z < 11.5 ? 0.7 : 0.92;
    for (const p of state.points) {
      const x = p.px * xx + p.py * xy + tx;
      const y = p.px * yx + p.py * yy + ty;
      if (x < -24 || y < -24 || x > size.x + 24 || y > size.y + 24) continue;
      const r = base * (1 + grow * Math.log2(p.count));
      g.drawImage(sprites[p.type], x - r, y - r, r * 2, r * 2);
      if (!hits) continue;
      const v = { x, y, r, p };
      visible.push(v);
      const key = Math.floor(x / HIT_CELL) + ":" + Math.floor(y / HIT_CELL);
      if (!hits.has(key)) hits.set(key, []);
      hits.get(key).push(v);
    }
    dotHits = hits;
    if (z >= LABEL_ZOOM) paintLabels(g, visible);
  }

  // One label per spot, most serious first; labels that would overlap one already placed are skipped.
  function paintLabels(g, visible) {
    const CELL = 48;
    const taken = new Map();
    const overlaps = (b) => {
      for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
        for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
          for (const o of taken.get(cx + ":" + cy) || []) {
            if (b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h) return true;
          }
        }
      }
      return false;
    };
    const claim = (b) => {
      for (let cx = Math.floor(b.x / CELL); cx <= Math.floor((b.x + b.w) / CELL); cx++) {
        for (let cy = Math.floor(b.y / CELL); cy <= Math.floor((b.y + b.h) / CELL); cy++) {
          const key = cx + ":" + cy;
          if (!taken.has(key)) taken.set(key, []);
          taken.get(key).push(b);
        }
      }
    };
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.font = "500 10.5px 'JetBrains Mono', ui-monospace, monospace";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.lineWidth = 3;
    g.strokeStyle = "rgba(3, 5, 10, 0.92)";
    visible
      .slice()
      .sort((a, b) => a.p.type - b.p.type || b.p.typeCount - a.p.typeCount)
      .forEach(({ x, y, r, p }) => {
        const text = `${CRIME_TYPES[p.type].short} ×${p.typeCount}`;
        const box = { x: x + r * 0.4 + 3, y: y - 8, w: g.measureText(text).width + 4, h: 16 };
        if (overlaps(box)) return;
        claim(box);
        g.strokeText(text, box.x, y);
        g.fillStyle = CRIME_TYPES[p.type].color;
        g.fillText(text, box.x, y);
      });
  }

  function dotAt(point) {
    if (!dotHits) return null;
    const cx = Math.floor(point.x / HIT_CELL);
    const cy = Math.floor(point.y / HIT_CELL);
    let best = null;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const v of dotHits.get(cx + dx + ":" + (cy + dy)) || []) {
          const d = Math.hypot(v.x - point.x, v.y - point.y);
          if (d <= Math.max(6, v.r * 0.5) && d < bestD) { best = v.p; bestD = d; }
        }
      }
    }
    return best;
  }

  function dotTip(p) {
    const t = CRIME_TYPES[p.type];
    const rest = p.count - p.typeCount;
    return `<span class="dot-type" style="--c:${t.color}">${t.label} ×${p.typeCount}</span>
      <strong>${p.street}</strong>${rest ? `<br>${fmt(p.count)} crimes recorded here<ul style="margin:4px 0 0;padding-left:16px">${breakdown(p.cats, 4)}</ul>` : ""}`;
  }

  const DotLayer = L.Layer.extend({
    includes: Upright,
    onAdd(m) {
      const animated = m.options.zoomAnimation && L.Browser.any3d;
      this._canvas = L.DomUtil.create("canvas", `nw-dots ${animated ? "leaflet-zoom-animated" : "leaflet-zoom-hide"}`);
      this._canvas.style.transformOrigin = "0 0";
      m.getPane("dots").appendChild(this._canvas);
      m.on("moveend resize", this._reset, this);
      m.on("rotate", this._onRotate, this);
      if (animated) m.on("zoomanim", this._animateZoom, this);
      this._reset();
    },
    onRemove(m) {
      cancelAnimationFrame(this._turnFrame);
      this._turnFrame = 0;
      this._canvas.remove();
      m.off("moveend resize", this._reset, this);
      m.off("rotate", this._onRotate, this);
      m.off("zoomanim", this._animateZoom, this);
      dotHits = null;
    },
    redraw() {
      if (this._map) this._reset();
    },
    _reset() {
      const m = this._map;
      const size = m.getSize();
      const dpr = window.devicePixelRatio || 1;
      const c = this._canvas;
      this._zooming = false;
      placeUpright(m, c);
      c.width = Math.round(size.x * dpr);
      c.height = Math.round(size.y * dpr);
      c.style.width = `${size.x}px`;
      c.style.height = `${size.y}px`;
      const g = c.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintDots(g, size);
    },
  });
  const dotLayer = new DotLayer();

  let rawCrimes = [];
  let rawCrimeLayer = null;
  let rawCrimeLoadStarted = false;

  const RawCrimeLayer = L.Layer.extend({
    includes: Upright,
    onAdd(m) {
      this._canvas = L.DomUtil.create("canvas", "nw-raw-crimes leaflet-zoom-animated");
      this._canvas.style.transformOrigin = "0 0";
      m.getPane("rawCrimes").appendChild(this._canvas);
      m.on("moveend resize", this._reset, this);
      m.on("rotate", this._onRotate, this);
      m.on("zoomanim", this._animateZoom, this);
      this._reset();
    },
    onRemove(m) {
      cancelAnimationFrame(this._turnFrame);
      this._canvas.remove();
      m.off("moveend resize", this._reset, this);
      m.off("rotate", this._onRotate, this);
      m.off("zoomanim", this._animateZoom, this);
    },
    _reset() {
      const m = this._map;
      const size = m.getSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = this._canvas;
      this._zooming = false;
      placeUpright(m, canvas);
      canvas.width = Math.round(size.x * dpr);
      canvas.height = Math.round(size.y * dpr);
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (m.getZoom() <= AREA_MAX_ZOOM) return;

      const zoom = m.getZoom();
      const scale = m.getZoomScale(zoom, 0);
      const pixelOrigin = m.getPixelOrigin();
      const { a, cos, sin } = screenFrame(m);
      const xx = scale * cos;
      const xy = -scale * sin;
      const yx = scale * sin;
      const yy = scale * cos;
      const tx = a.x - pixelOrigin.x * cos + pixelOrigin.y * sin;
      const ty = a.y - pixelOrigin.x * sin - pixelOrigin.y * cos;
      const radius = zoom >= 16 ? 2.1 : 1.4;
      g.fillStyle = DANGER;
      g.globalAlpha = 0.58;
      for (const crime of rawCrimes) {
        const x = crime.px * xx + crime.py * xy + tx;
        const y = crime.px * yx + crime.py * yy + ty;
        if (x < -4 || y < -4 || x > size.x + 4 || y > size.y + 4) continue;
        g.beginPath();
        g.arc(x, y, radius, 0, Math.PI * 2);
        g.fill();
      }
    },
  });

  async function loadRawCrimes() {
    if (rawCrimeLoadStarted) return;
    rawCrimeLoadStarted = true;
    try {
      const response = await fetch("data/london.json");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      rawCrimes = data.crimes.map((crime) => {
        const point = L.CRS.EPSG3857.latLngToPoint(L.latLng(crime.lat, crime.lng), 0);
        return { ...crime, px: point.x, py: point.y };
      });
      rawCrimeLayer = new RawCrimeLayer();
      if (map.getZoom() > AREA_MAX_ZOOM) rawCrimeLayer.addTo(map);
    } catch {
      rawCrimeLoadStarted = false;
    }
  }

  function setLayer(layer, on) {
    if (!layer) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function syncZoomLayers() {
    const z = map.getZoom();
    const detail = z > AREA_MAX_ZOOM;
    drawAreas();
    setLayer(layers.heat, detail && checked("layer-heat"));
    setLayer(dotLayer, checked("layer-dots"));
    if (detail) loadRawCrimes();
    setLayer(rawCrimeLayer, detail && checked("layer-dots"));
    if (!checked("layer-dots")) hoverTip.remove();
    setLayer(boroughLayer, checked("layer-boroughs"));
    setLayer(layers.boroughLabels, checked("layer-boroughs") && z >= 10.75 && z <= 12.5);
    updateHint();
  }

  /* DBSCAN on unique snapped locations, weighted by incident count */
  function dbscan(points, eps, minWeight) {
    const grid = new Map();
    points.forEach((p, i) => {
      const k = Math.floor(p.x / eps) + ":" + Math.floor(p.y / eps);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    const neighbours = (i) => {
      const p = points[i];
      const cx = Math.floor(p.x / eps);
      const cy = Math.floor(p.y / eps);
      const out = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(cx + dx + ":" + (cy + dy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (Math.hypot(points[j].x - p.x, points[j].y - p.y) <= eps) out.push(j);
          }
        }
      }
      return out;
    };
    const weightOf = (idx) => idx.reduce((s, j) => s + points[j].count, 0);

    const labels = new Int32Array(points.length).fill(-2);
    let cluster = 0;
    for (let i = 0; i < points.length; i++) {
      if (labels[i] !== -2) continue;
      const n = neighbours(i);
      if (weightOf(n) < minWeight) { labels[i] = -1; continue; }
      labels[i] = cluster;
      const queue = n.slice();
      while (queue.length) {
        const j = queue.pop();
        if (labels[j] === -1) labels[j] = cluster;
        if (labels[j] !== -2) continue;
        labels[j] = cluster;
        const nj = neighbours(j);
        if (weightOf(nj) >= minWeight) queue.push(...nj);
      }
      cluster++;
    }
    const clusters = Array.from({ length: cluster }, () => []);
    labels.forEach((l, i) => { if (l >= 0) clusters[l].push(points[i]); });
    return clusters;
  }

  function convexHull(pts) {
    const p = pts.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
      upper.push(p[i]);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function drawHotspots() {
    layers.hotspots.clearLayers();
    if (!checked("layer-hotspots")) return;
    const clusters = dbscan(state.points, state.eps, state.minw)
      .map((members) => {
        const count = members.reduce((s, m) => s + m.count, 0);
        const cats = {};
        members.forEach((m) => Object.entries(m.cats).forEach(([k, v]) => { cats[k] = (cats[k] || 0) + v; }));
        const cx = members.reduce((s, m) => s + m.x * m.count, 0) / count;
        const cy = members.reduce((s, m) => s + m.y * m.count, 0) / count;
        return { members, count, cats, cx, cy };
      })
      .sort((a, b) => b.count - a.count);

    const maxCount = clusters.length ? clusters[0].count : 1;
    clusters.forEach((c, i) => {
      const intensity = c.count / maxCount;
      const style = {
        pane: "hotspots",
        color: DANGER,
        weight: 1.5,
        opacity: 0.9,
        dashArray: "5 5",
        fillColor: DANGER,
        fillOpacity: 0.05 + 0.2 * intensity,
        className: "hotspot-shape",
      };
      const hull = convexHull(c.members);
      let shape;
      if (hull.length >= 3) {
        const padded = hull.map(([x, y]) => {
          const dx = x - c.cx;
          const dy = y - c.cy;
          const d = Math.hypot(dx, dy) || 1;
          return unproject(x + (dx / d) * 18, y + (dy / d) * 18);
        });
        shape = L.polygon(padded, style);
      } else {
        shape = L.circle(unproject(c.cx, c.cy), { ...style, radius: 30 });
      }
      shape
        .bindTooltip(`<strong>Hotspot ${i + 1}</strong> · ${fmt(c.count)} incidents<ul style="margin:4px 0 0;padding-left:16px">${breakdown(c.cats, 3)}</ul>`, { sticky: true })
        .addTo(layers.hotspots);
    });

    const clustered = clusters.reduce((s, c) => s + c.count, 0);
    const total = state.points.reduce((s, p) => s + p.count, 0);
    document.getElementById("hotspot-summary").textContent = clusters.length
      ? `${clusters.length} hotspot${clusters.length === 1 ? "" : "s"} across London covering ${fmt(clustered)} of ${fmt(total)} incidents. The rest is treated as noise.`
      : "No hotspots at these settings. Try a larger radius or fewer minimum incidents.";
  }

  /* London overview: borough ranking */
  function renderRanking() {
    const ranked = boroughs.map((b) => ({ b, total: boroughTotal(b) })).sort((a, b) => b.total - a.total);
    const max = ranked[0]?.total || 1;
    const shown = state.rankExpanded ? ranked : ranked.slice(0, 8);
    document.getElementById("london-total").textContent = fmt(ranked.reduce((s, r) => s + r.total, 0));
    document.getElementById("borough-rank").innerHTML = shown.map(({ b, total }, i) => `
      <li><button data-code="${b.code}">
        <span class="rank-num">${i + 1}</span>
        <span class="rank-name">${b.name}<span class="rank-bar" style="width:${Math.max(3, (total / max) * 100)}%"></span></span>
        <span class="rank-count">${fmt(total)}</span>
      </button></li>`).join("");
    document.getElementById("rank-more").textContent = state.rankExpanded ? "Show top 8" : `Show all ${boroughs.length}`;
  }
  document.getElementById("borough-rank").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-code]");
    if (btn) focusBorough(boroughs.find((b) => b.code === btn.dataset.code));
  });
  document.getElementById("rank-more").addEventListener("click", () => {
    state.rankExpanded = !state.rankExpanded;
    renderRanking();
  });

  function rankOf(b) {
    const totals = boroughs.map(boroughTotal).sort((x, y) => y - x);
    return totals.indexOf(boroughTotal(b)) + 1;
  }

  function boroughCard(b) {
    const total = boroughTotal(b);
    const cats = b.byCat
      .map((n, i) => [LD.categories[i], n])
      .filter(([cat, n]) => n && state.enabled.has(cat))
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3);
    const top = cats[0]?.[1] || 1;
    return `
      <div class="b-card">
        <h4>${b.name}</h4>
        <p class="b-big">${fmt(total)} <span>crimes in ${monthLabel}</span></p>
        <p class="b-meta">#${rankOf(b)} of ${boroughs.length} boroughs · ${fmt(Math.round(total / b.areaKm2))} per km²</p>
        <ul class="b-cats">${cats.map(([cat, n]) => `
          <li><span>${catLabel(cat)}</span><span>${fmt(n)}</span><i style="width:${(n / top) * 100}%"></i></li>`).join("")}
        </ul>
        <button class="b-zoom" data-zoom="${b.code}">Zoom in to plan a walk</button>
      </div>`;
  }

  function focusBorough(b) {
    if (!b) return;
    fitTo(b.layer.getBounds(), { gap: 30 });
    map.once("moveend", () => {
      L.popup({ className: "nw-popup", maxWidth: 300 }).setLatLng(L.latLng(labelPoint(b))).setContent(boroughCard(b)).openOn(map);
    });
  }

  map.on("popupopen", (e) => {
    const btn = e.popup.getElement().querySelector("[data-zoom]");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const b = boroughs.find((x) => x.code === btn.dataset.zoom);
      map.closePopup();
      map.setView(L.latLng(labelPoint(b)), 14);
    });
  });

  /* Hover read-out for the overview */
  const hoverTip = L.tooltip({ className: "area-tip", direction: "top", offset: [0, -10] });
  let hovered = null;
  function highlightBorough(b) {
    if (hovered === b) return;
    if (hovered) hovered.layer.setStyle(outlineStyle);
    hovered = b;
    if (b && checked("layer-boroughs")) b.layer.setStyle({ color: ACCENT, weight: 2, opacity: 0.9 });
  }
  let lastMove = 0;
  map.on("mousemove", (e) => {
    const now = performance.now();
    if (now - lastMove < 40) return;
    lastMove = now;
    if (map.getZoom() > BOROUGH_CLICK_MAX_ZOOM) {
      highlightBorough(null);
      const overMarker = e.originalEvent.target.classList?.contains("leaflet-interactive");
      const p = !overMarker && checked("layer-dots") ? dotAt(e.containerPoint) : null;
      if (!p) { hoverTip.remove(); return; }
      hoverTip.setLatLng([p.lat, p.lng]).setContent(dotTip(p));
      if (!map.hasLayer(hoverTip)) hoverTip.addTo(map);
      return;
    }
    const b = boroughAt(e.latlng);
    highlightBorough(b);
    if (!b) { hoverTip.remove(); return; }
    let html = `<strong>${b.name}</strong> · ${fmt(boroughTotal(b))} crimes`;
    if (state.hexes) {
      const [x, y] = project(e.latlng.lat, e.latlng.lng);
      const [q, r] = hexAt(x, y, state.hexes.size);
      const bin = state.hexes.bins.get(q + "," + r);
      const area = state.hexes.areaKm2.toFixed(state.hexes.areaKm2 < 1 ? 2 : 1);
      html += bin
        ? `<br>${fmt(bin.count)} in this ${area} km² area, mostly ${catLabel(Object.entries(bin.cats).sort((a, c) => c[1] - a[1])[0][0]).toLowerCase()}`
        : `<br>No recorded crime in this ${area} km² area`;
    }
    hoverTip.setLatLng(e.latlng).setContent(html);
    if (!map.hasLayer(hoverTip)) hoverTip.addTo(map);
  });
  el.addEventListener("mouseleave", () => { hoverTip.remove(); highlightBorough(null); });

  /* Rotation: shift+drag or right-drag turns the map about its centre; the compass turns it back to north */
  const turn = { target: 0, current: 0, frame: 0, spin: 0 };
  const twist = { id: null, last: 0, start: 0, sum: 0, moved: false, swallow: false };
  // Bearings here are unwrapped, so easing across north takes the short way instead of spinning round.
  function easeBearing() {
    turn.current += (turn.target - turn.current) * 0.3;
    if (Math.abs(turn.target - turn.current) < 0.05) turn.current = turn.target;
    map.setBearing(turn.current);
    turn.frame = turn.current === turn.target ? 0 : requestAnimationFrame(easeBearing);
  }
  function stopTurning() {
    cancelAnimationFrame(turn.frame);
    cancelAnimationFrame(turn.spin);
    turn.frame = 0;
    turn.spin = 0;
  }
  function pointerAngle(e) {
    const p = map.mouseEventToContainerPoint(e);
    const c = map.getSize().divideBy(2);
    return { deg: (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI, r: p.distanceTo(c) };
  }
  function faceNorth() {
    stopTurning();
    const from = map.getBearing();
    const delta = ((540 - from) % 360) - 180;
    if (Math.abs(delta) < 0.01 || reduceMotion) { map.setBearing(0); return; }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / 400);
      map.setBearing(t < 1 ? from + delta * (1 - (1 - t) ** 3) : 0);
      turn.spin = t < 1 ? requestAnimationFrame(step) : 0;
    };
    turn.spin = requestAnimationFrame(step);
  }

  el.addEventListener("pointerdown", (e) => {
    if (!map.setBearing || e.pointerType === "touch" || !(e.button === 2 || (e.button === 0 && e.shiftKey))) return;
    if (e.target.closest(".leaflet-control, .leaflet-marker-icon, .leaflet-popup")) return;
    stopTurning();
    turn.current = turn.target = map.getBearing();
    Object.assign(twist, { id: e.pointerId, last: pointerAngle(e).deg, start: turn.current, sum: 0, moved: false });
    el.setPointerCapture(e.pointerId);
    el.classList.add("is-rotating");
    L.DomUtil.disableTextSelection();
    hoverTip.remove();
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (e.pointerId !== twist.id) return;
    const a = pointerAngle(e);
    // Near the centre the angle swings wildly for tiny moves.
    if (a.r < 24) { twist.last = a.deg; return; }
    twist.sum += ((a.deg - twist.last + 540) % 360) - 180;
    twist.last = a.deg;
    if (Math.abs(twist.sum) > 1) twist.moved = true;
    turn.target = twist.start + twist.sum;
    if (!turn.frame) turn.frame = requestAnimationFrame(easeBearing);
  });
  const endTwist = (e) => {
    if (e.pointerId !== twist.id) return;
    twist.id = null;
    el.classList.remove("is-rotating");
    L.DomUtil.enableTextSelection();
    if (!twist.moved) return;
    twist.swallow = true;
    setTimeout(() => { twist.swallow = false; });
  };
  el.addEventListener("pointerup", endTwist);
  el.addEventListener("pointercancel", endTwist);
  // A shift+drag that turned the map ends in a click, which must not drop a route point.
  el.parentElement.addEventListener("click", (e) => {
    if (!twist.swallow) return;
    twist.swallow = false;
    e.stopPropagation();
  }, true);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  // Leaflet's maxBounds drag limit assumes the map faces north.
  map.on("rotate", () => { map.options.maxBoundsViscosity = map.getBearing() ? 0 : 0.8; });

  /* Refresh everything that depends on the category filter */
  function refresh() {
    aggregate();
    drawHeat();
    syncZoomLayers();
    dotLayer.redraw();
    drawHotspots();
    renderRanking();
    if (state.routes.length) {
      state.routes.forEach(scoreRoute);
      state.selected = pickIndex(state.mode);
      renderRoutes(false);
    }
  }
  map.on("zoomend", syncZoomLayers);

  /* Crime types: panel list and map legend share the same colours */
  function buildCategoryList() {
    const counts = CRIME_TYPES.map(() => 0);
    for (const loc of locations) for (const cat in loc.cats) counts[typeIndex[cat]] += loc.cats[cat];
    const max = Math.max(...counts);
    document.getElementById("categories").innerHTML = CRIME_TYPES.map((t, i) => `
      <li><label title="Scoring weights: ${t.cats.map((c) => `${catLabel(c)} ${catWeight(c).toFixed(1)}`).join(", ")}">
        <input type="checkbox" value="${t.id}" ${t.cats.some((c) => state.enabled.has(c)) ? "checked" : ""}>
        <span class="cat-name"><span><i class="swatch" style="--c:${t.color}"></i>${t.label}</span><span class="cat-bar" style="--c:${t.color};width:${Math.max(4, (counts[i] / max) * 100)}%"></span></span>
        <span class="cat-count">${fmt(counts[i])}<small>${t.color}</small></span>
      </label></li>`).join("");
    document.getElementById("legend-types").innerHTML = CRIME_TYPES.map((t) => `
      <li><i class="swatch" style="--c:${t.color}"></i><span>${t.label}</span><code>${t.color}</code></li>`).join("");
    updateToggleAll();
  }
  function updateToggleAll() {
    document.getElementById("cat-toggle-all").textContent = state.enabled.size ? "None" : "All";
  }
  document.getElementById("categories").addEventListener("change", (e) => {
    const t = CRIME_TYPES.find((x) => x.id === e.target.value);
    t.cats.forEach((c) => (e.target.checked ? state.enabled.add(c) : state.enabled.delete(c)));
    updateToggleAll();
    refresh();
  });
  document.getElementById("cat-toggle-all").addEventListener("click", () => {
    const all = state.enabled.size === 0;
    state.enabled = new Set(all ? LD.categories : []);
    document.querySelectorAll("#categories input").forEach((i) => { i.checked = all; });
    updateToggleAll();
    refresh();
  });

  /* Layer toggles */
  ["layer-areas", "layer-boroughs", "layer-heat", "layer-dots"].forEach((id) => {
    document.getElementById(id).addEventListener("change", syncZoomLayers);
  });
  document.getElementById("layer-hotspots").addEventListener("change", (e) => {
    document.getElementById("hotspot-controls").hidden = !e.target.checked;
    setLayer(layers.hotspots, e.target.checked);
    drawHotspots();
  });
  const eps = document.getElementById("eps");
  const minw = document.getElementById("minw");
  const onHotspotParams = () => {
    state.eps = +eps.value;
    state.minw = +minw.value;
    document.getElementById("eps-out").textContent = `${state.eps} m`;
    document.getElementById("minw-out").textContent = String(state.minw);
    drawHotspots();
  };
  eps.addEventListener("input", onHotspotParams);
  minw.addEventListener("input", onHotspotParams);

  /* Pins */
  const pinIcon = (color) => L.divIcon({
    className: "nw-pin",
    html: `<span style="--pin:${color}"></span>`,
    iconSize: [26, 34],
    iconAnchor: [13, 39],
  });
  const markers = {
    from: L.marker([0, 0], { icon: pinIcon(cssVar("--text")), draggable: true, keyboard: false }),
    to: L.marker([0, 0], { icon: pinIcon(ACCENT), draggable: true, keyboard: false }),
  };
  markers.from.on("dragend", () => { state.from = { latlng: markers.from.getLatLng(), name: null }; updateFields(); plan(); });
  markers.to.on("dragend", () => { state.to = { latlng: markers.to.getLatLng(), name: null }; updateFields(); plan(); });

  function nearestStreet(latlng) {
    const [x, y] = project(latlng.lat, latlng.lng);
    let best = null;
    let bestD = 150;
    for (const loc of locations) {
      if (Math.abs(loc.x - x) > bestD || Math.abs(loc.y - y) > bestD || !STREETISH.test(loc.street)) continue;
      const d = Math.hypot(loc.x - x, loc.y - y);
      if (d < bestD) { bestD = d; best = loc.street; }
    }
    return best ? `Near ${best}` : `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  }

  function updateHint() {
    const hint = document.getElementById("map-hint");
    const z = map.getZoom();
    if (reportPick) {
      hint.textContent = "Click the map to place an approximate report";
      hint.classList.remove("hidden");
      return;
    }
    if (state.from && state.to) {
      hint.textContent = "Drag the pins to adjust, or click to start again";
    } else if (state.from) {
      hint.textContent = "Now click or search for a destination";
    } else if (state.to) {
      hint.textContent = "Now click or search for a start";
    } else if (z <= BOROUGH_CLICK_MAX_ZOOM) {
      hint.textContent = "Click a borough for its numbers, or search for a place to start";
    } else {
      hint.textContent = "Click the map to set a start point";
    }
    hint.classList.toggle("hidden", Boolean(state.from && state.to && state.routes.length));
  }

  const inputs = { from: document.getElementById("from-input"), to: document.getElementById("to-input") };

  function updateFields() {
    for (const end of ["from", "to"]) {
      if (document.activeElement === inputs[end]) continue;
      const point = state[end];
      inputs[end].value = point ? (point.name || nearestStreet(point.latlng)) : "";
    }
    document.getElementById("route-clear").hidden = !state.from && !state.to;
    if (state.from) markers.from.setLatLng(state.from.latlng).addTo(map); else markers.from.remove();
    if (state.to) markers.to.setLatLng(state.to.latlng).addTo(map); else markers.to.remove();
    updateHint();
  }

  function clearRoutes() {
    if (state.request) {
      const pending = state.request;
      state.request = null;
      pending.abort();
    }
    state.routes = [];
    state.selected = -1;
    layers.routes.clearLayers();
    layers.rings.clearLayers();
    document.getElementById("route-results").innerHTML = "";
    const warn = document.getElementById("route-street-warn");
    if (warn) { warn.hidden = true; warn.textContent = ""; }
    document.querySelectorAll("#presets .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    notifyRoutes();
  }

  function clearRoute() {
    clearRoutes();
    state.from = null;
    state.to = null;
    updateFields();
  }
  document.getElementById("route-clear").addEventListener("click", clearRoute);

  function setEnd(end, point, { pan = true } = {}) {
    state[end] = point;
    if (state.from && state.to) {
      document.querySelectorAll("#presets .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      updateFields();
      plan();
      return;
    }
    clearRoutes();
    updateFields();
    if (point && pan) map.setView(point.latlng, Math.max(map.getZoom(), 15));
  }

  map.on("click", (e) => {
    if (reportPick) {
      const place = reportPick;
      reportPick = null;
      map.getContainer().classList.remove("is-reporting");
      place(e.latlng);
      updateHint();
      return;
    }
    const halfway = Boolean(state.from) !== Boolean(state.to);
    if (map.getZoom() <= BOROUGH_CLICK_MAX_ZOOM && !halfway) {
      const b = boroughAt(e.latlng);
      if (b) {
        L.popup({ className: "nw-popup", maxWidth: 300 }).setLatLng(e.latlng).setContent(boroughCard(b)).openOn(map);
      }
      return;
    }
    const point = { latlng: e.latlng, name: null };
    if (state.from && state.to) {
      clearRoute();
      setEnd("from", point, { pan: false });
    } else {
      setEnd(state.from ? "to" : "from", point, { pan: false });
    }
  });

  document.getElementById("swap").addEventListener("click", () => {
    const { from, to } = state;
    state.to = from;
    setEnd("from", to, { pan: false });
  });

  /* Place search (Photon, OpenStreetMap data), limited to Greater London */
  const GEOCODER = "https://photon.komoot.io/api/";
  const PLACE_KINDS = {
    station: "Station", halt: "Station", subway_entrance: "Station entrance", bus_station: "Bus station",
    suburb: "Area", neighbourhood: "Area", quarter: "Area", village: "Area", town: "Area",
    park: "Park", common: "Common", pub: "Pub", bar: "Bar", restaurant: "Restaurant", cafe: "Café",
    university: "University", college: "College", school: "School", hospital: "Hospital",
    library: "Library", cinema: "Cinema", theatre: "Theatre", museum: "Museum", nightclub: "Club",
  };
  // Platforms and stop positions duplicate the station they belong to.
  const NOISY_PLACES = new Set(["stop", "stop_position", "platform"]);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const suggestionsEl = document.getElementById("suggestions");
  const search = { end: null, results: [], active: -1, timer: 0, controller: null };

  function describePlace(p) {
    const street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const main = p.name || street || p.postcode || "Unnamed place";
    const area = (p.district || p.locality || p.city || "").replace(/^London Borough of /, "").replace(/^Royal Borough of /, "");
    const detail = [PLACE_KINDS[p.osm_value], p.name ? street : null, area, p.postcode]
      .filter((part, i, all) => part && part !== main && all.indexOf(part) === i);
    return { main, detail: detail.join(" · ") };
  }

  function closeSuggestions() {
    clearTimeout(search.timer);
    if (search.controller) search.controller.abort();
    search.controller = null;
    search.end = null;
    search.results = [];
    search.active = -1;
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
    Object.values(inputs).forEach((i) => {
      i.setAttribute("aria-expanded", "false");
      i.removeAttribute("aria-activedescendant");
    });
  }

  function showSuggestions(end, results, note) {
    search.end = end;
    search.results = results;
    search.active = results.length ? 0 : -1;
    suggestionsEl.innerHTML = results.length
      ? results.map((r, i) => `
        <li role="option" id="place-${i}" data-i="${i}" aria-selected="${i === 0}">
          <span class="pin-dot pin-${end}"></span>
          <span><strong>${esc(r.main)}</strong>${r.detail ? `<small>${esc(r.detail)}</small>` : ""}</span>
        </li>`).join("")
      : `<li class="empty">${note}</li>`;
    suggestionsEl.hidden = false;
    inputs[end].setAttribute("aria-expanded", "true");
    if (results.length) inputs[end].setAttribute("aria-activedescendant", "place-0");
  }

  async function runSearch(end, q) {
    if (search.controller) search.controller.abort();
    const controller = new AbortController();
    search.controller = controller;
    const b = londonBounds;
    const url = `${GEOCODER}?q=${encodeURIComponent(q)}&limit=7&lang=en&lat=51.5072&lon=-0.1276`
      + `&bbox=${b.getWest().toFixed(3)},${b.getSouth().toFixed(3)},${b.getEast().toFixed(3)},${b.getNorth().toFixed(3)}`;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (search.controller !== controller || document.activeElement !== inputs[end]) return;
      const seen = new Set();
      const results = data.features
        .filter((f) => !NOISY_PLACES.has(f.properties.osm_value))
        .map((f) => ({ ...describePlace(f.properties), latlng: L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]) }))
        .filter((r) => {
          const key = `${r.main}|${r.detail}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 6);
      showSuggestions(end, results, "No places found in London");
    } catch (err) {
      if (controller.signal.aborted || document.activeElement !== inputs[end]) return;
      showSuggestions(end, [], "Search isn’t available right now. You can still click the map.");
    }
  }

  function choose(i) {
    const r = search.results[i];
    const end = search.end;
    if (!r || !end) return;
    closeSuggestions();
    inputs[end].value = r.main;
    inputs[end].blur();
    setEnd(end, { latlng: r.latlng, name: r.main });
  }

  for (const end of ["from", "to"]) {
    const input = inputs[end];
    input.addEventListener("input", () => {
      clearTimeout(search.timer);
      const q = input.value.trim();
      if (q.length < 2) {
        closeSuggestions();
        return;
      }
      search.timer = setTimeout(() => runSearch(end, q), 250);
    });
    input.addEventListener("keydown", (e) => {
      const n = search.results.length;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n && search.end === end) {
        e.preventDefault();
        search.active = (search.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        suggestionsEl.querySelectorAll("[data-i]").forEach((li) => li.setAttribute("aria-selected", String(+li.dataset.i === search.active)));
        input.setAttribute("aria-activedescendant", `place-${search.active}`);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (n && search.end === end) choose(Math.max(0, search.active));
        else if (input.value.trim().length >= 2) {
          clearTimeout(search.timer);
          runSearch(end, input.value.trim());
        }
      } else if (e.key === "Escape") {
        closeSuggestions();
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement === input) return;
        if (search.end === end) closeSuggestions();
        if (!input.value.trim() && state[end]) setEnd(end, null);
        else updateFields();
      }, 120);
    });
  }
  suggestionsEl.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (!li) return;
    e.preventDefault();
    choose(+li.dataset.i);
  });

  const presetsEl = document.getElementById("presets");
  presetsEl.innerHTML = PRESETS.map((p, i) => `<button class="chip" data-preset="${i}" aria-pressed="false">${p.label}</button>`).join("");
  presetsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const p = PRESETS[+btn.dataset.preset];
    clearRoute();
    btn.setAttribute("aria-pressed", "true");
    state.from = { latlng: L.latLng(p.from[0], p.from[1]), name: p.from[2] };
    state.to = { latlng: L.latLng(p.to[0], p.to[1]), name: p.to[2] };
    updateFields();
    fitTo(L.latLngBounds([state.from.latlng, state.to.latlng]), { gap: 80, maxZoom: 16 });
    plan();
  });

  /* Routing */
  function haversine(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Routing through a via point can double back along a dead end; cut those loops out.
  function removeBacktracks(coords) {
    const out = [];
    const seen = new Map();
    for (const c of coords) {
      const key = c[0].toFixed(5) + "," + c[1].toFixed(5);
      if (seen.has(key)) {
        const idx = seen.get(key);
        for (let k = idx + 1; k < out.length; k++) {
          seen.delete(out[k][0].toFixed(5) + "," + out[k][1].toFixed(5));
        }
        out.length = idx + 1;
        continue;
      }
      seen.set(key, out.length);
      out.push(c);
    }
    return out;
  }

  function toRoute(osrm) {
    const coords = removeBacktracks(osrm.geometry.coordinates);
    let distance = 0;
    for (let i = 0; i < coords.length - 1; i++) distance += haversine(coords[i], coords[i + 1]);
    const pace = osrm.duration / Math.max(osrm.distance, 1);
    const stepNames = [];
    for (const leg of osrm.legs || []) {
      for (const step of leg.steps || []) {
        if (step.name) stepNames.push(step.name);
      }
    }
    return { coords, distance, duration: distance * pace, stepNames };
  }

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function lineDist(px, py, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const d = segDist(px, py, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]);
      if (d < best) best = d;
    }
    return best;
  }

  function similarity(a, b) {
    const lineB = b.coords.map(([lng, lat]) => project(lat, lng));
    const sample = a.coords.filter((_, i) => i % 3 === 0);
    const close = sample.filter(([lng, lat]) => {
      const [x, y] = project(lat, lng);
      return lineDist(x, y, lineB) < 15;
    }).length;
    return close / sample.length;
  }

  // Paths that differ only by a short detour score the same, so only one is worth showing.
  function sameRoute(a, b) {
    if (Math.abs(a.distance - b.distance) <= 0.03 * Math.max(a.distance, b.distance) && a.incidents === b.incidents) return true;
    return similarity(a, b) > 0.88 && similarity(b, a) > 0.88;
  }

  async function plan() {
    if (!state.from || !state.to) return;
    if (state.request) state.request.abort();
    const controller = new AbortController();
    state.request = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);

    const results = document.getElementById("route-results");
    results.innerHTML = `<p class="route-status">Finding walking routes…</p>`;
    const warn = document.getElementById("route-street-warn");
    if (warn) { warn.hidden = true; warn.textContent = ""; }
    layers.routes.clearLayers();
    layers.rings.clearLayers();

    const a = state.from.latlng;
    const b = state.to.latlng;
    const [ax, ay] = project(a.lat, a.lng);
    const [bx, by] = project(b.lat, b.lng);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const nx = -(by - ay) / len;
    const ny = (bx - ax) / len;
    const off = Math.min(600, Math.max(120, len * 0.28));
    const vias = [off, -off].map((o) => unproject((ax + bx) / 2 + nx * o, (ay + by) / 2 + ny * o));

    const q = "?overview=full&geometries=geojson&steps=true";
    const urls = [
      `${ROUTER}${a.lng},${a.lat};${b.lng},${b.lat}${q}&alternatives=3`,
      ...vias.map((v) => `${ROUTER}${a.lng},${a.lat};${v.lng},${v.lat};${b.lng},${b.lat}${q}`),
    ];

    try {
      const settled = await Promise.allSettled(urls.map((u) =>
        fetch(u, { signal: controller.signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))));
      if (state.request !== controller) return;

      const candidates = [];
      settled.forEach((s, i) => {
        if (s.status !== "fulfilled" || s.value.code !== "Ok") return;
        const list = i === 0 ? s.value.routes : s.value.routes.slice(0, 1);
        list.forEach((r) => candidates.push(toRoute(r)));
      });
      if (!candidates.length) throw new Error("No route found");

      const shortest = Math.min(...candidates.map((r) => r.distance));
      const unique = [];
      candidates
        .filter((r) => r.distance <= shortest * 1.6)
        .sort((x, y) => x.duration - y.duration)
        .forEach((r) => {
          scoreRoute(r);
          if (!unique.some((u) => sameRoute(r, u))) unique.push(r);
        });

      state.routes = unique.slice(0, 4);
      nameRoutes();
      state.selected = pickIndex(state.mode);
      renderRoutes(true);
    } catch (err) {
      if (state.request !== controller) return;
      results.innerHTML = `<p class="route-status warn">${controller.signal.aborted ? "The routing service took too long to answer." : "Couldn’t reach the routing service."} Try again in a moment.</p>`;
    } finally {
      clearTimeout(timeout);
      if (state.request === controller) state.request = null;
      updateFields();
    }
  }

  function scoreRoute(route) {
    const line = route.coords.map(([lng, lat]) => project(lat, lng));
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const [x, y] of line) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const near = [];
    let exposure = 0;
    let incidents = 0;
    for (const p of state.points) {
      if (p.x < minX - BUFFER_M || p.x > maxX + BUFFER_M || p.y < minY - BUFFER_M || p.y > maxY + BUFFER_M) continue;
      if (lineDist(p.x, p.y, line) <= BUFFER_M) {
        near.push(p);
        exposure += p.weight;
        incidents += p.count;
      }
    }
    const perKm = exposure / Math.max(route.distance / 1000, 0.1);
    route.near = near;
    route.exposure = exposure;
    route.incidents = incidents;
    route.safety = Math.round(100 * Math.exp(-perKm / SCORE_REF));
  }

  function nameRoutes() {
    const used = new Set();
    state.routes.forEach((r, i) => {
      const tally = {};
      r.near.forEach((p) => { if (STREETISH.test(p.street)) tally[p.street] = (tally[p.street] || 0) + p.count; });
      const pick = Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([s]) => s).find((s) => !used.has(s));
      if (pick) used.add(pick);
      r.name = pick ? `Via ${pick}` : `Route ${i + 1}`;
    });
  }

  function pickIndex(mode) {
    const rs = state.routes;
    if (!rs.length) return -1;
    const argmin = (f) => rs.reduce((best, r, i) => (f(r) < f(rs[best]) ? i : best), 0);
    if (mode === "fastest") return argmin((r) => r.duration);
    return argmin((r) => r.exposure + r.duration / 1e6);
  }

  function renderRoutes(fit) {
    layers.routes.clearLayers();
    layers.rings.clearLayers();
    const rs = state.routes;
    if (!rs.length) {
      notifyRoutes();
      return;
    }

    const tags = rs.map(() => []);
    tags[pickIndex("fastest")].push("fastest");
    tags[pickIndex("safest")].push("safest");

    rs.forEach((r, i) => {
      if (i === state.selected) return;
      L.polyline(r.coords.map(([lng, lat]) => [lat, lng]), {
        pane: "routes", color: "#4F6A8F", weight: 5, opacity: 0.85, bubblingMouseEvents: false,
      })
        .on("click", () => selectRoute(i))
        .bindTooltip(r.name, { sticky: true })
        .addTo(layers.routes);
    });

    const sel = rs[state.selected];
    const latlngs = sel.coords.map(([lng, lat]) => [lat, lng]);
    L.polyline(latlngs, { pane: "routes", color: ACCENT, weight: 14, opacity: 0.18, interactive: false }).addTo(layers.routes);
    L.polyline(latlngs, { pane: "routes", color: ACCENT, weight: 5, opacity: 1, className: "route-glow", interactive: false }).addTo(layers.routes);
    L.polyline(latlngs, { pane: "routes", color: "#E6F7FF", weight: 1.5, opacity: 0.9, interactive: false }).addTo(layers.routes);

    sel.near.forEach((p) => {
      L.circleMarker([p.lat, p.lng], {
        pane: "rings", radius: 3 + Math.sqrt(p.count) * 1.4, color: DANGER, weight: 1.5, opacity: 0.95, fill: false,
      })
        .bindTooltip(`<strong>${p.street}</strong><br>${p.count} incident${p.count === 1 ? "" : "s"}<ul style="margin:4px 0 0;padding-left:16px">${breakdown(p.cats, 3)}</ul>`, { direction: "top" })
        .addTo(layers.rings);
    });

    if (fit) {
      const bounds = L.latLngBounds(rs.flatMap((r) => r.coords.map(([lng, lat]) => [lat, lng])));
      fitTo(bounds, { gap: 60, maxZoom: 17 });
    }

    const results = document.getElementById("route-results");
    const cards = rs.map((r, i) => `
      <button class="route-card" data-route="${i}" aria-pressed="${i === state.selected}">
        <span class="route-card-top"><span class="route-idx">R${i + 1}</span><strong>${r.name}</strong><span class="route-tags">${tags[i].map((t) => `<span class="tag tag-${t}">${t}</span>`).join("")}</span></span>
        <span class="route-stats">
          <span><small>Distance</small><b>${(r.distance / 1000).toFixed(1)}<i>km</i></b></span>
          <span><small>Walk</small><b>${Math.max(1, Math.round(r.duration / 60))}<i>min</i></b></span>
          <span><small>Incidents</small><b>${r.incidents}<i>≤${BUFFER_M} m</i></b></span>
          <span class="route-safety"><small>Safety</small><b>${r.safety}<i>/100</i></b></span>
        </span>
        <span class="score-bar" title="Safety score ${r.safety}/100"><span style="width:${r.safety}%"></span></span>
      </button>`).join("");
    const notes = [];
    if (rs.length === 1) notes.push(`<p class="route-status">Only one sensible walking route here, so every mode picks it.</p>`);
    if (!boroughAt(state.from.latlng) || !boroughAt(state.to.latlng)) {
      notes.push(`<p class="route-status warn">Part of this walk is outside London’s 33 boroughs, so crime there isn’t counted.</p>`);
    }
    if (!state.enabled.size) notes.push(`<p class="route-status warn">Every category is unticked, so nothing is being scored.</p>`);
    results.innerHTML = `<p class="route-status">Route found. We've got your back.</p>` + cards + notes.join("");
    updateRouteStreetWarn(sel);
    notifyRoutes();
  }

  function selectRoute(i) {
    state.selected = i;
    renderRoutes(false);
  }
  document.getElementById("route-results").addEventListener("click", (e) => {
    const card = e.target.closest("[data-route]");
    if (card) selectRoute(+card.dataset.route);
  });

  document.querySelectorAll(".modes [data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode === "fastest" ? "fastest" : "safest";
      document.querySelectorAll(".modes [data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b === btn)));
      if (state.routes.length) {
        state.selected = pickIndex(state.mode);
        renderRoutes(false);
      }
    });
  });

  /* London's Darkest Streets — ranked list from data/darkest-streets.json, not london.json */
  const streetKey = (name) => String(name || "").replace(/^On or near\s+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
  const darkest = { streets: [], highlight: null };

  function updateRouteStreetWarn(route) {
    const warn = document.getElementById("route-street-warn");
    if (!warn) return;
    const hit = routeDarkestHit(route);
    if (!hit) {
      warn.hidden = true;
      warn.textContent = "";
      return;
    }
    warn.hidden = false;
    warn.textContent = `This route passes ${hit.name}.`;
  }

  function routeDarkestHit(route) {
    if (!route || !darkest.streets.length) return null;
    const keys = new Set((route.stepNames || []).map(streetKey).filter(Boolean));
    if (keys.size) {
      const named = darkest.streets
        .filter((s) => keys.has(streetKey(s.name)) || keys.has(streetKey(s.nameRaw)))
        .sort((a, b) => b.score - a.score);
      if (named[0]) return named[0];
    }
    const line = route.coords.map(([lng, lat]) => project(lat, lng));
    let best = null;
    let bestD = 100;
    for (const s of darkest.streets) {
      const d = lineDist(...project(s.lat, s.lng), line);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  function highlightDarkest(street) {
    layers.darkest.clearLayers();
    darkest.highlight = street || null;
    if (!street) return;
    L.circleMarker([street.lat, street.lng], {
      pane: "darkest", radius: 18, color: "#FF1F4B", weight: 2, opacity: 0.9,
      fillColor: "#FF1F4B", fillOpacity: 0.12, interactive: false,
    }).addTo(layers.darkest);
    L.circleMarker([street.lat, street.lng], {
      pane: "darkest", radius: 6, color: "#FF1F4B", weight: 2, opacity: 1,
      fillColor: "#FF1F4B", fillOpacity: 0.85, interactive: false,
    }).addTo(layers.darkest);
    const dest = L.latLng(street.lat, street.lng);
    if (reduceMotion) map.setView(dest, 16);
    else map.flyTo(dest, 16, { duration: 0.75 });
    renderDarkestList();
  }

  function filteredDarkest() {
    const borough = document.getElementById("darkest-borough")?.value || "";
    const type = document.getElementById("darkest-type")?.value || "";
    let rows = darkest.streets;
    if (borough) rows = rows.filter((s) => s.borough === borough);
    if (type) rows = rows.filter((s) => (s.categories?.[type] || 0) > 0);
    const ranked = type
      ? [...rows].sort((a, b) => (b.categories[type] || 0) - (a.categories[type] || 0) || b.score - a.score)
      : [...rows].sort((a, b) => b.score - a.score || b.count - a.count);
    return ranked.slice(0, 10);
  }

  function escapeText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function renderDarkestList() {
    const list = document.getElementById("darkest-list");
    const empty = document.getElementById("darkest-empty");
    if (!list) return;
    const rows = filteredDarkest();
    if (empty) empty.hidden = rows.length > 0;
    list.innerHTML = rows.map((s) => `
      <li>
        <button type="button" data-street="${encodeURIComponent(s.nameRaw)}" class="${darkest.highlight?.nameRaw === s.nameRaw ? "is-active" : ""}">
          <span class="darkest-name">
            <strong>${escapeText(s.name)}</strong>
            <small>${escapeText(s.borough || "London")} · ${escapeText(catLabel(s.topCategory))}</small>
          </span>
          <span class="darkest-count">${fmt(s.count)}</span>
        </button>
      </li>`).join("");
  }

  function bootDarkest(data) {
    const section = document.getElementById("darkest-streets");
    if (!data?.streets?.length) {
      if (section) section.hidden = true;
      return;
    }
    darkest.streets = data.streets;
    const boroughSel = document.getElementById("darkest-borough");
    const typeSel = document.getElementById("darkest-type");
    if (boroughSel) {
      const names = [...new Set(data.streets.map((s) => s.borough).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      boroughSel.innerHTML = `<option value="">All boroughs</option>` + names.map((n) => `<option value="${n}">${n}</option>`).join("");
    }
    if (typeSel) {
      const cats = [...new Set(data.streets.flatMap((s) => Object.keys(s.categories || {})))].sort((a, b) => catLabel(a).localeCompare(catLabel(b)));
      typeSel.innerHTML = `<option value="">All types</option>` + cats.map((c) => `<option value="${c}">${catLabel(c)}</option>`).join("");
    }
    boroughSel?.addEventListener("change", renderDarkestList);
    typeSel?.addEventListener("change", renderDarkestList);
    document.getElementById("darkest-list")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-street]");
      if (!btn) return;
      const raw = decodeURIComponent(btn.dataset.street);
      const street = darkest.streets.find((s) => s.nameRaw === raw);
      if (street) highlightDarkest(street);
    });
    renderDarkestList();
  }

  fetch("data/darkest-streets.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(bootDarkest)
    .catch(() => {
      const section = document.getElementById("darkest-streets");
      if (section) section.hidden = true;
    });

  const giHotRenderer = L.canvas({ pane: "giCells", padding: 0.25 });
  window.NW_insightsMap = {
    flyToCell(south, west, north, east) {
      const bounds = L.latLngBounds([south, west], [north, east]);
      layers.giFocus.clearLayers();
      L.rectangle(bounds, {
        pane: "giCells",
        color: ACCENT,
        weight: 2.5,
        opacity: 1,
        fillColor: ACCENT,
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(layers.giFocus);
      const dest = bounds.getCenter();
      if (reduceMotion) map.setView(dest, 16);
      else map.flyTo(dest, 16, { duration: 0.75 });
    },
    setHotCells(rects, on) {
      layers.giHot.clearLayers();
      if (map.hasLayer(layers.giHot)) map.removeLayer(layers.giHot);
      if (!on || !rects || !rects.length) return;
      rects.forEach(([s, w, n, e]) => {
        L.rectangle([[s, w], [n, e]], {
          pane: "giCells",
          renderer: giHotRenderer,
          color: DANGER,
          weight: 1,
          opacity: 0.9,
          fillColor: DANGER,
          fillOpacity: 0.32,
          interactive: false,
        }).addTo(layers.giHot);
      });
      layers.giHot.addTo(map);
    },
  };

  function notifyRoutes() {
    const snap = routeSnapshot();
    routeListeners.forEach((fn) => {
      try { fn(snap); } catch (err) { console.error(err); }
    });
  }

  function routeSnapshot() {
    const route = state.selected >= 0 ? state.routes[state.selected] : null;
    if (!route || !state.from || !state.to) return null;
    return {
      mode: state.mode,
      from: {
        lat: state.from.latlng.lat,
        lng: state.from.latlng.lng,
        name: state.from.name || inputs.from.value || "",
      },
      to: {
        lat: state.to.latlng.lat,
        lng: state.to.latlng.lng,
        name: state.to.name || inputs.to.value || "",
      },
      via: route.name || "",
      distance: route.distance,
      duration: route.duration,
      coords: route.coords,
    };
  }

  function placeLabel(lat, lng) {
    const borough = boroughAt({ lat, lng });
    return borough ? borough.name : "Greater London";
  }

  function showSavedWalk(row) {
    const feature = row?.route_geojson;
    const coords = feature?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) throw new Error("This saved walk has no path to draw.");
    const props = feature.properties || {};
    const from = props.from || {};
    const to = props.to || {};
    const fromLat = Number.isFinite(Number(from.lat)) ? Number(from.lat) : Number(coords[0][1]);
    const fromLng = Number.isFinite(Number(from.lng)) ? Number(from.lng) : Number(coords[0][0]);
    const toLat = Number.isFinite(Number(to.lat)) ? Number(to.lat) : Number(coords[coords.length - 1][1]);
    const toLng = Number.isFinite(Number(to.lng)) ? Number(to.lng) : Number(coords[coords.length - 1][0]);
    if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) throw new Error("This saved walk has no path to draw.");
    if (reportPick) {
      reportPick = null;
      map.getContainer().classList.remove("is-reporting");
    }
    clearRoute();
    state.mode = row.route_mode === "fastest" ? "fastest" : "safest";
    document.querySelectorAll(".modes [data-mode]").forEach((btn) => {
      btn.setAttribute("aria-checked", String(btn.dataset.mode === state.mode));
    });
    state.from = { latlng: L.latLng(fromLat, fromLng), name: from.name || null };
    state.to = { latlng: L.latLng(toLat, toLng), name: to.name || null };
    const route = {
      coords,
      distance: Number(row.distance_m) || 0,
      duration: Number(row.duration_s) || 0,
      stepNames: [],
      name: props.via || row.name || "Saved walk",
    };
    scoreRoute(route);
    state.routes = [route];
    state.selected = 0;
    updateFields();
    renderRoutes(true);
  }

  const routeListeners = new Set();
  window.NW_planner = {
    snapshot: routeSnapshot,
    subscribe(fn) {
      routeListeners.add(fn);
      try { fn(routeSnapshot()); } catch (err) { console.error(err); }
      return () => routeListeners.delete(fn);
    },
    showSavedWalk,
    placeLabel,
    armReportPick(fn) {
      reportPick = fn;
      map.closePopup();
      map.getContainer().classList.add("is-reporting");
      updateHint();
    },
    cancelReportPick() {
      if (!reportPick) return;
      reportPick = null;
      map.getContainer().classList.remove("is-reporting");
      updateHint();
    },
    isReporting() {
      return Boolean(reportPick);
    },
  };

  /* Boot */
  document.getElementById("london-month").textContent = monthLabel;
  document.getElementById("data-status").textContent =
    `${fmt(locations.reduce((s, l) => s + Object.values(l.cats).reduce((a, n) => a + n, 0), 0))} crimes recorded across London’s ${boroughs.length} boroughs in ${monthLabel}, from police.uk. Boundaries from the ONS.`;
  fitTo(londonBounds, { gap: 16 });
  const startBearing = parseFloat(new URLSearchParams(location.search).get("bearing"));
  if (startBearing && map.setBearing) {
    map.setBearing(startBearing);
    fitTo(londonBounds, { gap: 16, animate: false });
  }
  buildCategoryList();
  refresh();
  updateFields();
})();

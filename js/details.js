(() => {
  const STACK = [
    { name: "React / Next.js", role: "Frontend", why: "Interactive map UI, sidebar filters, route planner pages.", value: "Modern production frontend with React, TypeScript and SSR." },
    { name: "Python + FastAPI", role: "Backend", why: "API for crime queries, route scoring and ML predictions.", value: "Typed, asynchronous Python and REST API design." },
    { name: "PostgreSQL + PostGIS", role: "Database", why: "Stores crimes as spatial points and handles route-buffer queries.", value: "Geospatial databases and spatial SQL." },
    { name: "Mapbox GL JS or Leaflet", role: "Maps", why: "Renders the dark map, crime dots, routes and heatmap.", value: "Web mapping and geospatial visualisation." },
    { name: "scikit-learn", role: "ML · later", why: "Clusters crime hotspots, served as a heatmap layer.", value: "Applied unsupervised ML on real data." },
  ];
  document.getElementById("stack-grid").innerHTML = `
    <div class="stack-row stack-head" aria-hidden="true"><span>Layer</span><span>Tool</span><span>Why it’s there</span><span>Resume value</span></div>
    ${STACK.map((item) => `
      <article class="stack-row">
        <span class="stack-role">${item.role}</span>
        <h3>${item.name}</h3>
        <p>${item.why}</p>
        <p class="stack-value">${item.value}</p>
      </article>`).join("")}`;

  const GROUPS = [
    { id: "record", title: "The record", text: "What happened, and how much it counts. One row per police.uk crime, with the category weights used to score a walk." },
    { id: "streets", title: "The streets", text: "Where it happened. Borough boundaries and the walkable network from OpenStreetMap, with lighting and pavements." },
    { id: "watch", title: "The watch", text: "What Night’s Watch works out: the routes it plans and the hotspots its clustering finds." },
    { id: "people", title: "The people", text: "Planned for V2: accounts and reports dropped on the map by people walking at night." },
  ];
  const SCHEMA = [
    { name: "crime_incidents", group: "record", stage: "core", note: "One row per police.uk street-level crime.", cols: [
      ["id", "BIGSERIAL", "pk"],
      ["police_uk_id", "TEXT", "uq", "persistent_id from police.uk"],
      ["category_id", "INT", "fk:crime_categories"],
      ["borough_id", "INT", "fk:boroughs"],
      ["month", "DATE", "", "police.uk gives month only"],
      ["location", "Point, 4326", "geo", "approximate snapped location"],
      ["street_name", "TEXT"],
      ["outcome", "TEXT"],
      ["ingested_at", "TIMESTAMPTZ"],
    ], idx: ["GIST (location)", "(month, category_id)"] },
    { name: "crime_categories", group: "record", stage: "core", note: "police.uk categories with scoring weights.", cols: [
      ["id", "SERIAL", "pk"],
      ["slug", "TEXT", "uq", "police.uk category, e.g. robbery"],
      ["label", "TEXT"],
      ["severity_weight", "REAL", "", "default 1.0, used in route risk scoring"],
    ] },
    { name: "boroughs", group: "streets", stage: "core", note: "London borough boundaries.", cols: [
      ["id", "SERIAL", "pk"],
      ["name", "TEXT", "uq"],
      ["boundary", "MultiPolygon, 4326", "geo"],
    ] },
    { name: "street_segments", group: "streets", stage: "core", note: "Walkable network from OpenStreetMap.", cols: [
      ["id", "BIGSERIAL", "pk"],
      ["osm_way_id", "BIGINT"],
      ["geom", "LineString, 4326", "geo"],
      ["length_m", "REAL"],
      ["is_lit", "BOOLEAN"],
      ["has_sidewalk", "BOOLEAN"],
      ["pedestrian_score", "REAL", "", "walkability 0..1"],
      ["risk_score", "REAL", "", "derived from nearby crimes and hotspots"],
    ], idx: ["GIST (geom)"] },
    { name: "routes", group: "watch", stage: "core", note: "Planned walks and their scores.", cols: [
      ["id", "BIGSERIAL", "pk"],
      ["user_id", "UUID", "fk:users", "nullable for anonymous"],
      ["origin", "Point, 4326", "geo"],
      ["destination", "Point, 4326", "geo"],
      ["path", "LineString, 4326", "geo"],
      ["distance_m", "REAL"],
      ["duration_s", "REAL"],
      ["safety_score", "REAL"],
      ["mode", "TEXT", "", "fastest | safest"],
      ["created_at", "TIMESTAMPTZ"],
    ], idx: ["GIST (path)"] },
    { name: "users", group: "people", stage: "v2", note: "V2, or use Supabase auth.", cols: [
      ["id", "UUID", "pk"],
      ["email", "TEXT", "uq"],
      ["created_at", "TIMESTAMPTZ"],
    ] },
    { name: "user_reports", group: "people", stage: "v2", note: "V2 pin-dropping.", cols: [
      ["id", "BIGSERIAL", "pk"],
      ["user_id", "UUID", "fk:users"],
      ["location", "Point, 4326", "geo"],
      ["report_type", "TEXT", "", "poor_lighting, harassment, …"],
      ["note", "TEXT"],
      ["created_at", "TIMESTAMPTZ"],
      ["upvotes", "INT"],
    ], idx: ["GIST (location)"] },
    { name: "hotspot_clusters", group: "watch", stage: "ml", note: "ML stage output, drives the heatmap.", cols: [
      ["id", "SERIAL", "pk"],
      ["model_run_id", "INT"],
      ["algorithm", "TEXT", "", "dbscan | kmeans"],
      ["centroid", "Point, 4326", "geo"],
      ["area", "Polygon, 4326", "geo", "convex hull of cluster"],
      ["incident_count", "INT"],
      ["intensity", "REAL", "", "drives heatmap"],
      ["period_start", "DATE"],
      ["period_end", "DATE"],
    ], idx: ["GIST (area)"] },
  ];
  const stageLabel = { core: "Core", v2: "V2", ml: "ML" };
  const refs = Object.fromEntries(SCHEMA.map((table) => [table.name, new Set()]));
  SCHEMA.forEach((table) => table.cols.forEach(([, , flag]) => {
    if (!flag?.startsWith("fk:")) return;
    const target = flag.slice(3);
    refs[table.name].add(target);
    refs[target].add(table.name);
  }));

  const badge = (flag) => {
    if (!flag) return "";
    if (flag === "pk") return '<span class="badge badge-pk">PK</span>';
    if (flag === "uq") return '<span class="badge badge-uq">UQ</span>';
    if (flag === "geo") return '<span class="badge badge-geo">GEO</span>';
    if (flag.startsWith("fk:")) {
      const target = flag.slice(3);
      return `<span class="badge badge-fk" data-target="${target}" title="References ${target}">FK → ${target}</span>`;
    }
    return "";
  };

  const columns = SCHEMA.flatMap((table) => table.cols);
  const indexes = SCHEMA.flatMap((table) => table.idx || []);
  const stats = [
    ["Tables", SCHEMA.length],
    ["Geometry columns", columns.filter(([, , flag]) => flag === "geo").length],
    ["GIST indexes", indexes.filter((index) => index.startsWith("GIST")).length],
    ["Foreign keys", columns.filter(([, , flag]) => flag?.startsWith("fk:")).length],
    ["SRID", 4326],
  ];
  document.getElementById("schema-stats").innerHTML = stats.map(([label, value]) => `
    <div class="schema-stat"><span class="hud-label">${label}</span><strong>${value}</strong></div>`).join("");

  const tableCard = (table) => `
    <article class="table-card" tabindex="0" data-table="${table.name}" data-stage="${table.stage}">
      <header class="table-head">
        <div class="table-head-top"><h4>${table.name}</h4><span class="stage stage-${table.stage}">${stageLabel[table.stage]}</span></div>
        <p>${table.note}</p>
      </header>
      <ul class="columns">
        ${table.cols.map(([name, type, flag, note]) => `
          <li>
            <span class="col-name">${name} ${badge(flag)}</span>
            <span class="col-type">${type}</span>
            ${note ? `<span class="col-note">${note}</span>` : ""}
          </li>`).join("")}
      </ul>
      ${table.idx ? `<div class="table-foot">INDEX ${table.idx.join(" · ")}</div>` : ""}
    </article>`;

  const schema = document.getElementById("schema");
  schema.innerHTML = GROUPS.map((group) => `
    <section class="schema-group">
      <header class="group-head">
        <h3>${group.title}</h3>
        <p>${group.text}</p>
      </header>
      <div class="group-tables">${SCHEMA.filter((table) => table.group === group.id).map(tableCard).join("")}</div>
    </section>`).join("");

  const focusTable = (name) => {
    schema.classList.toggle("focusing", Boolean(name));
    schema.querySelectorAll(".table-card").forEach((card) => {
      card.classList.toggle("is-focus", card.dataset.table === name);
      card.classList.toggle("is-related", Boolean(name) && refs[name].has(card.dataset.table));
    });
  };
  schema.querySelectorAll(".table-card").forEach((card) => {
    card.addEventListener("mouseenter", () => focusTable(card.dataset.table));
    card.addEventListener("focus", () => focusTable(card.dataset.table));
    card.addEventListener("mouseleave", () => focusTable(null));
    card.addEventListener("blur", () => focusTable(null));
  });
  schema.addEventListener("click", (event) => {
    const foreignKey = event.target.closest(".badge-fk");
    if (!foreignKey) return;
    const target = schema.querySelector(`[data-table="${foreignKey.dataset.target}"]`);
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
  });
})();

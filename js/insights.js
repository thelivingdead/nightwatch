(() => {
  const section = document.getElementById("insights");
  const INS = window.NW_INSIGHTS;
  if (!section) return;
  if (!INS || !INS.boroughs || !INS.boroughs.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const CAT_LABEL = {
    "violent-crime": "Violence & sexual offences",
    "robbery": "Robbery",
    "possession-of-weapons": "Possession of weapons",
    "theft-from-the-person": "Theft from the person",
    "public-order": "Public order",
    "drugs": "Drugs",
    "anti-social-behaviour": "Anti-social behaviour",
    "criminal-damage-arson": "Criminal damage & arson",
    "other-crime": "Other crime",
    "burglary": "Burglary",
    "other-theft": "Other theft",
    "vehicle-crime": "Vehicle crime",
    "bicycle-theft": "Bicycle theft",
    "shoplifting": "Shoplifting",
  };
  const CLUSTER = ["#7FD4FF", "#FF1F4B", "#FFC07A", "#44ACE4", "#FF8A3D", "#CDEFFF"];
  const catLabel = (slug) => CAT_LABEL[slug] || slug.replace(/-/g, " ");
  const fmt = (n) => Number(n).toLocaleString("en-GB");
  const monthLabel = new Date(INS.month + "-01T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const escapeText = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function $(id) { return document.getElementById(id); }

  function cellBounds(i, j) {
    const g = INS.grid;
    const x0 = i * g.cellM;
    const x1 = (i + 1) * g.cellM;
    const y0 = j * g.cellM;
    const y1 = (j + 1) * g.cellM;
    return [
      g.origin[0] + y0 / g.ky,
      g.origin[1] + x0 / g.kx,
      g.origin[0] + y1 / g.ky,
      g.origin[1] + x1 / g.kx,
    ];
  }

  const hotRects = [];
  const packed = INS.hotCells || [];
  for (let n = 0; n + 1 < packed.length; n += 2) hotRects.push(cellBounds(packed[n], packed[n + 1]));

  $("ins-total").textContent = fmt(INS.total);
  $("ins-month").textContent = monthLabel;
  $("ins-violent").textContent = `${fmt(INS.violent)} violent crimes (${INS.violentShare}% of the month). Top types:`;
  $("ins-types").innerHTML = INS.top5.map((row) => `
    <li>
      <span class="ins-type-name">${escapeText(catLabel(row.category))}</span>
      <span class="ins-type-bar" style="--p:${Math.max(row.pct, 0.5)}%"></span>
      <span class="ins-type-pct">${row.pct.toFixed(1)}%</span>
    </li>`).join("");

  const conc = INS.concentration;
  $("ins-conc-stats").innerHTML = `
    <li><span>Top 1% of cells</span><strong>${conc.top1}%</strong></li>
    <li><span>Top 5% of cells</span><strong>${conc.top5}%</strong></li>
    <li><span>Top 10% of cells</span><strong>${conc.top10}%</strong></li>
    <li><span>Gini coefficient</span><strong>${conc.gini}</strong></li>`;
  $("ins-conc-note").textContent = `${fmt(conc.nCells)} cells of 200 m. Ranked among land cells (centre inside a borough) plus any cell with a crime; empty water is excluded. ${conc.top1}% / ${conc.top5}% / ${conc.top10}% of violent crime sits in the busiest 1%, 5% and 10% of those cells.`;

  const lorenz = $("ins-lorenz");
  const Lx0 = 40, Ly0 = 12, Lx1 = 308, Ly1 = 168;
  const lx = (t) => Lx0 + t * (Lx1 - Lx0);
  const ly = (t) => Ly1 - t * (Ly1 - Ly0);
  const pts = (conc.lorenz || []).map(([x, y]) => `${lx(x).toFixed(1)},${ly(y).toFixed(1)}`).join(" ");
  lorenz.innerHTML = `
    <title id="ins-lorenz-title">Lorenz curve of violent crime across 200 metre cells</title>
    <line x1="${lx(0)}" y1="${ly(0)}" x2="${lx(1)}" y2="${ly(1)}" class="ins-eq"></line>
    <polyline points="${pts}" class="ins-curve" fill="none"></polyline>
    <text x="${(Lx0 + Lx1) / 2}" y="194" class="ins-axis">Share of cells</text>
    <text transform="translate(12,${(Ly0 + Ly1) / 2}) rotate(-90)" class="ins-axis">Share of violent crime</text>`;

  const hotList = $("ins-hot");
  const topHot = INS.topHot || [];
  hotList.innerHTML = topHot.map((cell, i) => `
    <li>
      <div class="ins-hot-main">
        <strong>${escapeText(cell.street)}</strong>
        <small>${escapeText(cell.borough)} · z ${cell.z} · ${fmt(cell.count)} violent</small>
      </div>
      <button type="button" class="link-btn" data-hot="${i}" aria-label="Show this hot cell on the map: ${escapeText(cell.street)}, ${escapeText(cell.borough)}">Show on map</button>
    </li>`).join("");
  if (!topHot.length) hotList.innerHTML = "<li class=\"tiny\">No significant hot cells after FDR.</li>";

  hotList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-hot]");
    if (!btn) return;
    const cell = topHot[Number(btn.dataset.hot)];
    if (!cell || !window.NW_insightsMap) return;
    const [s, w, n, e2] = cell.b;
    window.NW_insightsMap.flyToCell(s, w, n, e2);
  });

  const layerToggle = $("ins-hot-layer");
  layerToggle.checked = false;
  layerToggle.addEventListener("change", () => {
    window.NW_insightsMap?.setHotCells(hotRects, layerToggle.checked);
  });

  const sel = $("ins-borough");
  sel.innerHTML = INS.boroughs.map((b, i) => {
    const mark = b.small ? " (small area)" : "";
    return `<option value="${i}">${escapeText(b.name)}${mark}</option>`;
  }).join("");

  function renderProfile() {
    const i = Number(sel.value) || 0;
    const b = INS.boroughs[i];
    if (!b) return;
    const lqRows = (INS.categories || []).map((cat, ci) => ({ cat, lq: b.lq[ci] }))
      .sort((a, c) => c.lq - a.lq);
    const smallNote = b.small
      ? `<p class="tiny">City of London is only ${b.areaKm2} km², so crimes per km² is distorted by its small size.</p>`
      : "";
    $("ins-profile").innerHTML = `
      <p class="overview-total"><strong>${fmt(b.total)}</strong> crimes</p>
      <p class="tiny">${b.perKm2.toLocaleString("en-GB")} per km² · density rank ${b.densityRank} of ${INS.boroughs.length}</p>
      ${smallNote}
      <ul class="ins-lq">${lqRows.map((row) => {
        const hi = row.lq > 1.25;
        const lo = row.lq < 0.8;
        const cls = hi ? "ins-lq-hi" : lo ? "ins-lq-lo" : "";
        return `<li class="${cls}"><span>${escapeText(catLabel(row.cat))}</span><strong>${row.lq.toFixed(2)}</strong></li>`;
      }).join("")}</ul>`;

    $("ins-similar").innerHTML = b.similar.map((s) => {
      const other = INS.boroughs[s.i];
      return `<li><button type="button" class="link-btn" data-sim="${s.i}" aria-label="Switch profile to ${escapeText(other.name)}">${escapeText(other.name)} <span>${s.cos.toFixed(2)}</span></button></li>`;
    }).join("");
    renderPca(i);
  }

  function renderPca(selected) {
    const svg = $("ins-pca");
    const rows = INS.boroughs;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    rows.forEach((b) => {
      minX = Math.min(minX, b.pca[0]); maxX = Math.max(maxX, b.pca[0]);
      minY = Math.min(minY, b.pca[1]); maxY = Math.max(maxY, b.pca[1]);
    });
    const pad = 22;
    const w = 320, h = 200;
    const dx = maxX - minX || 1;
    const dy = maxY - minY || 1;
    const px = (x) => pad + ((x - minX) / dx) * (w - 2 * pad);
    const py = (y) => h - pad - ((y - minY) / dy) * (h - 2 * pad);
    const dots = rows.map((b, i) => {
      const r = i === selected ? 6.5 : 4;
      const color = CLUSTER[b.cluster % CLUSTER.length];
      const label = `${b.name}, cluster ${b.cluster + 1}`;
      return `<circle cx="${px(b.pca[0]).toFixed(1)}" cy="${py(b.pca[1]).toFixed(1)}" r="${r}" fill="${color}" tabindex="0" role="button" data-pca="${i}" aria-label="${escapeText(label)}" ${i === selected ? 'aria-current="true"' : ""}></circle>`;
    }).join("");
    svg.innerHTML = `
      <title id="ins-pca-title">Borough similarity scatter, two principal components, coloured by cluster</title>
      ${dots}
      <text x="160" y="216" class="ins-axis">PC1 ${(INS.pcaVar[0] * 100).toFixed(0)}% · PC2 ${(INS.pcaVar[1] * 100).toFixed(0)}%</text>`;
  }

  $("ins-pca").addEventListener("click", (e) => {
    const node = e.target.closest("[data-pca]");
    if (!node) return;
    sel.value = node.getAttribute("data-pca");
    renderProfile();
  });
  $("ins-pca").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const node = e.target.closest("[data-pca]");
    if (!node) return;
    e.preventDefault();
    sel.value = node.getAttribute("data-pca");
    renderProfile();
  });

  $("ins-similar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sim]");
    if (!btn) return;
    sel.value = btn.getAttribute("data-sim");
    renderProfile();
  });
  sel.addEventListener("change", renderProfile);

  const sil = INS.silhouette || {};
  const silBits = [3, 4, 5, 6].map((k) => `${k}: ${sil[k] ?? sil[String(k)]}`).join(", ");
  $("ins-cluster-note").textContent = `${INS.boroughs.length} boroughs grouped into ${INS.k} clusters (silhouette ${silBits}). Points are PCA of crime-type shares; click a point to switch borough.`;
  $("ins-footnote").textContent = `Based on police.uk reports for ${monthLabel}. Locations are approximate snap points, so cell results are approximate. Not live and not a forecast.`;

  renderProfile();
})();

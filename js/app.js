(() => {
  const $ = (id) => document.getElementById(id);
  const LD = window.NW_LONDON;

  /* Nav */
  const nav = $("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* "Plan my walk" lands on the map with the start field ready */
  document.querySelectorAll("[data-begin]").forEach((link) => {
    link.addEventListener("click", () => {
      const input = $("from-input");
      if (input && window.matchMedia("(min-width: 901px)").matches) setTimeout(() => input.focus({ preventScroll: true }), 60);
    });
  });

  /* Hero read-out */
  if (LD) {
    const total = LD.boroughs.reduce((s, b) => s + b.byCat.reduce((a, n) => a + n, 0), 0);
    const month = new Date(LD.month + "-01T00:00:00");
    $("hud-crimes").textContent = total.toLocaleString("en-GB");
    $("hud-month").textContent = month.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    $("hud-boroughs").textContent = String(LD.boroughs.length);
    $("sheet-status").textContent = `police.uk · ${month.toLocaleDateString("en-GB", { month: "short", year: "numeric" })} · ${LD.boroughs.length} boroughs`;
  }

  /* Tonight's watch: London's dusk and dawn, and the hour a watchman would call */
  const LONDON = { lat: 51.5072, lng: -0.1276 };
  const HOURS = ["Twelve", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven"];
  const inLondon = { timeZone: "Europe/London", hourCycle: "h23" };
  const clockFmt = new Intl.DateTimeFormat("en-GB", { ...inLondon, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const timeFmt = new Intl.DateTimeFormat("en-GB", { ...inLondon, hour: "2-digit", minute: "2-digit" });
  const hourFmt = new Intl.DateTimeFormat("en-GB", { ...inLondon, hour: "numeric" });

  // Sunrise and sunset from the standard solar position formulas, good to about a minute.
  function sunTimes(date) {
    const rad = Math.PI / 180;
    const days = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
    const lw = -LONDON.lng * rad;
    const phi = LONDON.lat * rad;
    const n = Math.round(days - 0.0009 - lw / (2 * Math.PI));
    const transit = (ha) => 0.0009 + (ha + lw) / (2 * Math.PI) + n;
    const ds = transit(0);
    const M = rad * (357.5291 + 0.98560028 * ds);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad * 102.9372 + Math.PI;
    const dec = Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));
    const julian = (d) => 2451545 + d + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    const w = Math.acos((Math.sin(rad * -0.833) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    const noon = julian(ds);
    const set = julian(transit(w));
    const toDate = (j) => new Date((j + 0.5 - 2440588) * 86400000);
    return { rise: toDate(noon - (set - noon)), set: toDate(set) };
  }

  function watchWindow(now) {
    const day = 86400000;
    const today = sunTimes(now);
    if (now < today.rise) return { dusk: sunTimes(new Date(now - day)).set, dawn: today.rise, onDuty: true };
    const dawn = sunTimes(new Date(+now + day)).rise;
    return { dusk: today.set, dawn, onDuty: now >= today.set };
  }

  const span = (ms) => {
    const mins = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(mins / 60);
    return h ? `${h} h ${mins % 60} min` : `${mins} min`;
  };

  function updateWatch() {
    const now = new Date();
    const w = watchWindow(now);
    const hourCall = `${HOURS[Number(hourFmt.format(now)) % 12]} o’clock, and all’s well`;
    const dusk = timeFmt.format(w.dusk);
    const dawn = timeFmt.format(w.dawn);
    $("hud-sun").textContent = `${dusk} · ${dawn}`;
    $("hud-call").textContent = w.onDuty ? hourCall : `Keeps watch from ${dusk}`;
    $("watch-call").textContent = w.onDuty ? `${hourCall}.` : `The watch begins at ${dusk}.`;
    $("watch-dusk").textContent = dusk;
    $("watch-dawn").textContent = dawn;
    $("watch-status").textContent = w.onDuty ? "On watch" : "Resting until dusk";
    $("watch-status").classList.toggle("on", w.onDuty);
    const progress = w.onDuty ? Math.min(1, (now - w.dusk) / (w.dawn - w.dusk)) : 0;
    $("watch-progress").style.width = `${progress * 100}%`;
    $("watch-lantern").style.left = `${progress * 100}%`;
    $("watch-note").textContent = w.onDuty ? `${span(w.dawn - now)} until dawn` : `Dusk falls in ${span(w.dusk - now)}`;
  }
  const tickClock = () => { $("hud-clock").textContent = clockFmt.format(new Date()); };
  updateWatch();
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(updateWatch, 30000);

  /* Hero sky: stars above, London's streets as city lights below */
  const canvas = $("sky");
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let stars = [];
  let sparkles = [];
  let glints = [];
  let city = null;
  let dpr = 1;
  let view = { width: 0, height: 0 };

  // One light per snapped street location, brighter where more was recorded.
  const streetLights = (() => {
    if (!LD) return [];
    const k = Math.cos((51.5 * Math.PI) / 180);
    const byKey = new Map();
    for (const [dy, dx, , n] of LD.points) {
      const key = dy * 1e6 + dx;
      byKey.set(key, (byKey.get(key) || 0) + n);
    }
    return [...byKey].map(([key, n]) => ({ x: (key % 1e6) * k, y: -Math.floor(key / 1e6), n }));
  })();

  function renderCity(width, height) {
    if (!streetLights.length) return null;
    const [south, west] = LD.origin;
    const k = Math.cos((51.5 * Math.PI) / 180);
    let minX = Infinity;
    let maxX = -Infinity;
    for (const p of streetLights) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    const scale = Math.max(width * 0.92, Math.min(width * 1.6, height * 0.75)) / (maxX - minX);
    const ax = (LONDON.lng - west) * 1e5 * k;
    const ay = -(LONDON.lat - south) * 1e5;
    const cx = width / 2;
    const cy = height * 0.84;

    const layer = document.createElement("canvas");
    layer.width = Math.round(width * dpr);
    layer.height = Math.round(height * dpr);
    const g = layer.getContext("2d");
    g.scale(dpr, dpr);
    g.globalCompositeOperation = "lighter";

    const LEVELS = 6;
    const buckets = Array.from({ length: LEVELS }, () => []);
    const bright = [];
    for (const p of streetLights) {
      const sx = cx + (p.x - ax) * scale;
      const sy = cy + (p.y - ay) * scale;
      if (sx < -2 || sx > width + 2 || sy < -2 || sy > height + 2) continue;
      const t = Math.min(1, Math.log1p(p.n) / Math.log1p(30));
      buckets[Math.min(LEVELS - 1, Math.floor(t * LEVELS))].push(sx, sy);
      if (p.n >= 6 && sy > height * 0.62) bright.push({ x: sx, y: sy, n: p.n });
    }
    buckets.forEach((pts, i) => {
      const t = (i + 0.5) / LEVELS;
      const r = 0.7 + 1.2 * t;
      g.fillStyle = `rgba(${Math.round(120 + 101 * t)}, ${Math.round(160 + 71 * t)}, ${Math.round(205 + 37 * t)}, ${(0.16 + 0.55 * t).toFixed(2)})`;
      for (let j = 0; j < pts.length; j += 2) g.fillRect(pts[j] - r / 2, pts[j + 1] - r / 2, r, r);
    });

    // Bloom: blur by scaling down and back up, so busy streets glow like the photos from orbit.
    [4, 12].forEach((factor, i) => {
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(layer.width / factor));
      small.height = Math.max(1, Math.round(layer.height / factor));
      small.getContext("2d").drawImage(layer, 0, 0, small.width, small.height);
      g.globalAlpha = i ? 0.9 : 0.75;
      g.drawImage(small, 0, 0, width, height);
    });

    g.globalAlpha = 1;
    g.globalCompositeOperation = "destination-in";
    const fade = g.createLinearGradient(0, height * 0.46, 0, height * 0.76);
    fade.addColorStop(0, "rgba(0, 0, 0, 0)");
    fade.addColorStop(1, "rgba(0, 0, 0, 1)");
    g.fillStyle = fade;
    g.fillRect(0, 0, width, height);

    for (let i = bright.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bright[i], bright[j]] = [bright[j], bright[i]];
    }
    glints = bright.slice(0, Math.round(width / 11)).map((b) => ({
      x: b.x,
      y: b.y,
      size: 2 + Math.min(4.5, Math.log1p(b.n)),
      speed: Math.random() * 0.8 + 0.3,
      phase: Math.random() * Math.PI * 2,
    }));
    return layer;
  }

  function seedSky() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const { width, height } = canvas.getBoundingClientRect();
    view = { width, height };
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    stars = Array.from({ length: Math.round((width * height) / 5200) }, () => ({
      x: Math.random() * width,
      y: Math.pow(Math.random(), 1.3) * height * 0.62,
      r: Math.random() * 1.1 + 0.2,
      a: Math.random() * 0.6 + 0.2,
      speed: Math.random() * 1.5 + 0.4,
      phase: Math.random() * Math.PI * 2,
      tint: Math.random() < 0.12,
    }));
    sparkles = Array.from({ length: Math.max(4, Math.round(width / 260)) }, () => ({
      x: Math.random() * width,
      y: Math.random() * height * 0.42,
      size: Math.random() * 7 + 5,
      speed: Math.random() * 0.6 + 0.3,
      phase: Math.random() * Math.PI * 2,
    }));
    city = renderCity(width, height);
  }

  const sparkleSprite = (() => {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const glow = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    glow.addColorStop(0, "rgba(221, 231, 242, 0.55)");
    glow.addColorStop(0.45, "rgba(169, 184, 200, 0.18)");
    glow.addColorStop(1, "rgba(127, 212, 255, 0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, size, size);
    const r = size * 0.36;
    g.translate(size / 2, size / 2);
    g.fillStyle = "#F2F6FA";
    g.beginPath();
    g.moveTo(0, -r);
    g.quadraticCurveTo(0, 0, r, 0);
    g.quadraticCurveTo(0, 0, 0, r);
    g.quadraticCurveTo(0, 0, -r, 0);
    g.quadraticCurveTo(0, 0, 0, -r);
    g.fill();
    return c;
  })();

  function drawSparkle(x, y, size, alpha) {
    const d = size * 2.8;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sparkleSprite, x - d / 2, y - d / 2, d, d);
  }

  function drawSky(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    const time = t / 1000;
    for (const s of stars) {
      const tw = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(time * s.speed + s.phase);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = s.tint ? "#A9D8F5" : "#DDE7F2";
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (city) {
      ctx.globalAlpha = 1;
      ctx.drawImage(city, 0, 0, view.width, view.height);
    }
    for (const sp of sparkles) {
      const pulse = reduceMotion ? 0.7 : 0.35 + 0.65 * Math.max(0, Math.sin(time * sp.speed + sp.phase));
      drawSparkle(sp.x, sp.y, sp.size * (0.7 + 0.3 * pulse), pulse * 0.9);
    }
    for (const gl of glints) {
      const pulse = reduceMotion ? 0.5 : Math.max(0, Math.sin(time * gl.speed + gl.phase));
      if (pulse > 0.05) drawSparkle(gl.x, gl.y, gl.size * (0.5 + 0.5 * pulse), pulse * 0.8);
    }
    ctx.globalAlpha = 1;
  }

  let skyVisible = true;
  let lastFrame = 0;
  new IntersectionObserver(([entry]) => { skyVisible = entry.isIntersecting; }).observe(canvas);
  function loop(t) {
    if (skyVisible && t - lastFrame > 50) {
      drawSky(t);
      lastFrame = t;
    }
    if (!reduceMotion) requestAnimationFrame(loop);
  }
  seedSky();
  requestAnimationFrame(loop);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { seedSky(); drawSky(performance.now()); }, 150);
  });

})();

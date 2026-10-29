(() => {
  const sheet = document.getElementById("sheet");
  const handle = document.getElementById("sheet-resize");
  if (!sheet || !handle) return;

  const STORAGE = "nw-sheet-width";
  const DEFAULT = 384;
  const MIN = 280;
  const MAX = 560;
  const desktop = window.matchMedia("(min-width: 901px)");

  const maxWidth = () => Math.round(Math.min(MAX, window.innerWidth * 0.7));
  const clamp = (n) => Math.max(MIN, Math.min(maxWidth(), Math.round(n)));

  let raf = 0;
  function invalidateMap() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const map = window.NW_map;
      if (map && typeof map.invalidateSize === "function") map.invalidateSize({ animate: false });
    });
  }

  function stored() {
    try {
      const n = parseInt(localStorage.getItem(STORAGE), 10);
      return Number.isFinite(n) ? n : DEFAULT;
    } catch (_) {
      return DEFAULT;
    }
  }

  function apply(width, persist) {
    const w = clamp(width);
    document.documentElement.style.setProperty("--sheet-width", `${w}px`);
    handle.setAttribute("aria-valuenow", String(w));
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    if (persist) {
      try { localStorage.setItem(STORAGE, String(w)); } catch (_) {}
    }
    invalidateMap();
  }

  function syncMode() {
    const on = desktop.matches;
    handle.hidden = !on;
    handle.tabIndex = on ? 0 : -1;
    handle.setAttribute("aria-hidden", on ? "false" : "true");
    if (on) apply(stored(), false);
  }

  let drag = null;

  handle.addEventListener("pointerdown", (e) => {
    if (!desktop.matches || e.button !== 0) return;
    e.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    drag = { startX: e.clientX, startW: sheet.getBoundingClientRect().width };
    document.body.classList.add("is-sheet-resizing");
  });

  handle.addEventListener("pointermove", (e) => {
    if (!drag) return;
    apply(drag.startW + (e.clientX - drag.startX), false);
  });

  function endDrag() {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("is-sheet-resizing");
    apply(sheet.getBoundingClientRect().width, true);
  }

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("lostpointercapture", endDrag);

  handle.addEventListener("dblclick", (e) => {
    e.preventDefault();
    apply(DEFAULT, true);
  });

  handle.addEventListener("keydown", (e) => {
    if (!desktop.matches) return;
    const now = parseInt(handle.getAttribute("aria-valuenow"), 10) || DEFAULT;
    const step = e.shiftKey ? 48 : 16;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); apply(now + step, true); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); apply(now - step, true); }
    else if (e.key === "Home") { e.preventDefault(); apply(MIN, true); }
    else if (e.key === "End") { e.preventDefault(); apply(maxWidth(), true); }
  });

  desktop.addEventListener("change", syncMode);
  window.addEventListener("resize", () => {
    if (desktop.matches) apply(parseInt(handle.getAttribute("aria-valuenow"), 10) || stored(), false);
  });

  handle.setAttribute("aria-valuemin", String(MIN));
  syncMode();
})();

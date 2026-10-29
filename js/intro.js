(() => {
  const cover = document.getElementById("intro-cover");
  if (!cover) return;
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";

  const root = document.documentElement;
  const video = cover.querySelector("video");
  const enter = document.getElementById("skip-intro");
  const toTop = () => window.scrollTo(0, 0);

  root.classList.add("intro-open");
  toTop();
  window.addEventListener("load", () => { if (root.classList.contains("intro-open")) toTop(); }, { once: true });
  enter.focus({ preventScroll: true });

  // Scrolls happen before intro-open is removed so they stay instant rather than smooth.
  function close() {
    if (cover.classList.contains("is-leaving")) return;
    cover.classList.add("is-leaving");
    document.removeEventListener("keydown", onKey);
    const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target) target.scrollIntoView();
    else toTop();
    root.classList.remove("intro-open");
    if (cover.contains(document.activeElement)) document.querySelector(".nav-brand")?.focus({ preventScroll: true });
    setTimeout(() => cover.remove(), 750);
  }

  // Enter is cancelled so it can't go on to activate whatever takes focus next.
  function onKey(event) {
    if (event.key !== "Escape" && event.key !== "Enter") return;
    event.preventDefault();
    close();
  }

  document.addEventListener("keydown", onKey);
  enter.addEventListener("click", close);
  video.addEventListener("ended", () => setTimeout(close, 650), { once: true });
  video.addEventListener("error", () => setTimeout(close, 3200), { once: true });
  setTimeout(close, 10000);
})();

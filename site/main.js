// The site's small amount of behaviour: theme switch, product-tour tabs, scroll reveals, the live GitHub star count and
// download links resolved to the files of the latest release. Every link already points at the releases page, so the
// page works with JavaScript off and when the GitHub API call fails.

const REPO = "AhmedKhalil777/OneClient";
const STAR_COUNT_MIN = 25;
document.documentElement.classList.add("js");

// ---- theme ----
document.getElementById("theme-toggle")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("oneclient-theme", next);
  } catch {
    /* not remembered */
  }
});

// ---- nav border once scrolled ----
const nav = document.getElementById("nav");
const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 8);
onScroll();
addEventListener("scroll", onScroll, { passive: true });

// ---- product tour ----
const SHOTS = {
  workbench: ["images/workbench.png", "The oneClient workbench with the Explorer, a JSON editor and the integrated terminal"],
  "aggregate-order": ["images/aggregate-order.png", "A Fast Aggregate: an order form with its items and tags"],
  pipelines: ["images/pipelines.png", "A passing test pipeline with its steps and assertions"],
  postgres: ["images/postgres.png", "A PostgreSQL query window with results"],
  kafka: ["images/kafka.png", "The Kafka topic browser with a message open"],
  "http-client": ["images/http-client.png", "The HTTP client with a request and its JSON response"],
};
const heroShot = document.getElementById("hero-shot");
const chips = document.querySelectorAll(".chips [role=tab]");
for (const chip of chips) {
  chip.addEventListener("click", () => {
    const [src, alt] = SHOTS[chip.dataset.shot] ?? [];
    if (!src || !heroShot) return;
    for (const c of chips) c.setAttribute("aria-selected", String(c === chip));
    heroShot.src = src;
    heroShot.alt = alt;
  });
}

// ---- reveal on scroll ----
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  for (const el of reveals) io.observe(el);
} else {
  for (const el of reveals) el.classList.add("in");
}

// ---- GitHub: stars, and the latest release's files ----
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n));

async function wireStars() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const { stargazers_count: stars } = await res.json();
    // A small number is a weak signal: show the count only once it reads as one.
    if (typeof stars !== "number" || stars < STAR_COUNT_MIN) return;
    for (const el of document.querySelectorAll("[data-stars]")) {
      el.textContent = compact(stars);
      el.hidden = false;
    }
  } catch {
    /* offline or rate-limited: the buttons simply stay without a number */
  }
}

// Asset names come from scripts/package.mjs: oneClient-<version>-<os>-<arch>.<ext>.
const ASSETS = {
  "win-installer": /-win-x64\.exe$/,
  "win-zip": /-win-x64\.zip$/,
  "mac-arm64": /-mac-arm64\.dmg$/,
  "mac-x64": /-mac-x64\.dmg$/,
  "linux-appimage": /-linux-x86_64\.AppImage$/,
  "linux-tar": /-linux-x64\.tar\.gz$/,
};

function detectOs() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent).toLowerCase();
  if (p.includes("win")) return "win";
  if (p.includes("mac")) return "mac";
  if (p.includes("linux") && !/android/i.test(navigator.userAgent)) return "linux";
  return null;
}

const HERO = { win: ["Download for Windows", "win-installer"], mac: ["Download for macOS", "mac-arm64"], linux: ["Download for Linux", "linux-appimage"] };

async function wireDownloads() {
  const os = detectOs();
  if (os) {
    document.querySelector(`.dl-card[data-os="${os}"]`)?.classList.add("is-current");
    const label = document.getElementById("hero-download-label");
    if (label) label.textContent = HERO[os][0];
  }

  let release;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    release = await res.json();
  } catch {
    return;
  }

  const urls = {};
  for (const [key, pattern] of Object.entries(ASSETS)) {
    const asset = release.assets?.find((a) => pattern.test(a.name));
    if (asset) urls[key] = asset.browser_download_url;
  }
  for (const link of document.querySelectorAll("[data-asset]")) {
    const url = urls[link.dataset.asset];
    if (url) link.href = url;
  }
  if (os && urls[HERO[os][1]]) {
    const hero = document.getElementById("hero-download");
    if (hero) hero.href = urls[HERO[os][1]];
  }
  const version = release.tag_name?.replace(/^v/, "");
  const v = document.getElementById("dl-version");
  if (version && v) v.textContent = `v${version}`;
}

wireStars();
wireDownloads();

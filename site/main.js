// Plugin showcase tabs, and download links resolved to the files of the latest GitHub release.
// Every link already points at the releases page, so the page works even when the API call fails.

const REPO = "AhmedKhalil777/OneClient";

// ---- tabs ----
const tabs = document.querySelectorAll(".tabs [role=tab]");
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
    for (const panel of document.querySelectorAll(".tab-panel")) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
  });
}

// ---- downloads ----
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
    document.getElementById("hero-download-label").textContent = HERO[os][0];
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

  const version = release.tag_name || release.name || "";
  if (version) document.getElementById("dl-version").textContent = version;
  const hero = document.getElementById("hero-download");
  if (os && urls[HERO[os][1]]) {
    hero.href = urls[HERO[os][1]];
    document.getElementById("hero-download-note").textContent = `${version} · ${os === "mac" ? "Apple silicon — Intel build below" : "free"} · other platforms below`;
  } else if (version) {
    document.getElementById("hero-download-note").textContent = `Latest: ${version}`;
  }
}

void wireDownloads();

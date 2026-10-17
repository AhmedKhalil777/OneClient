/**
 * Rasterizes resources/logo.svg into the PNG icons Electron needs (window/
 * taskbar icon; packagers build .ico/.icns from icon.png). Uses Electron
 * itself as the renderer, so no extra image tooling is needed:
 *
 *   pnpm --filter @oneclient/core run icons
 *
 * (Must run as a real Electron app — make sure ELECTRON_RUN_AS_NODE is unset.)
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const svg = fs.readFileSync(path.join(root, "resources/logo.svg"), "utf8");
const MASTER = 512;
const sizes = { "icon.png": 512, "icon-256.png": 256, "icon-64.png": 64, "icon-32.png": 32 };

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    // One render at full size, then downscale: re-loading pages in fresh offscreen windows is flaky (ERR_FAILED).
    const win = new BrowserWindow({
      width: MASTER,
      height: MASTER,
      show: false,
      frame: false,
      transparent: true,
      useContentSize: true,
      webPreferences: { offscreen: true },
    });
    const tmp = path.join(app.getPath("temp"), "oneclient-icon.html");
    fs.writeFileSync(
      tmp,
      `<html><body style="margin:0;background:transparent">${svg.replace(/width="256" height="256"/, `width="${MASTER}" height="${MASTER}"`)}</body></html>`,
    );
    await win.loadFile(tmp);
    await new Promise((r) => setTimeout(r, 200));
    const master = await win.webContents.capturePage({ x: 0, y: 0, width: MASTER, height: MASTER });
    fs.rmSync(tmp, { force: true });

    for (const [file, size] of Object.entries(sizes)) {
      const image = master.resize({ width: size, height: size, quality: "best" });
      fs.writeFileSync(path.join(root, "resources", file), image.toPNG());
      console.log(`resources/${file} (${size}x${size})`);
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

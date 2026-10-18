// Assembles the GitHub Pages site into _site/: the pages in site/, plus the assets they share with the rest of the
// repo — README screenshots (docs/images), the app logo and each plugin's icon — so none of them are duplicated.
//   node scripts/build-site.mjs   → open _site/index.html, or serve the folder
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "icons"), { recursive: true });

cpSync(join(root, "site"), out, { recursive: true });
cpSync(join(root, "docs", "images"), join(out, "images"), { recursive: true });
cpSync(join(root, "packages", "core", "resources", "logo.svg"), join(out, "logo.svg"));

// packages/plugins/oneclient-<name>/icon.svg → icons/<name>.svg
const pluginsDir = join(root, "packages", "plugins");
for (const dir of readdirSync(pluginsDir)) {
  const icon = join(pluginsDir, dir, "icon.svg");
  if (existsSync(icon)) cpSync(icon, join(out, "icons", `${dir.replace(/^oneclient-/, "")}.svg`));
}

// No Jekyll processing on GitHub Pages: serve the files as they are.
writeFileSync(join(out, ".nojekyll"), "");

console.log(`Site built → ${out}`);

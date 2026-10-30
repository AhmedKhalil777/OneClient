/**
 * Stages every plugin (packages/plugins/<dir>) as a self-contained npm package folder: main bundled with esbuild (the
 * workspace libraries @oneclient/plugin-api, sql-core, editor-kit are inlined — they are not published), the UI bundle,
 * icons, README, LICENSE, and a package.json whose `dependencies` are only the third-party packages main really imports.
 * Shared by publish-plugins.mjs (GitHub Packages) and release-plugins.mjs (GitHub Releases).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * @param {{ root: string, owner: string, staging: string, only?: string[] }} opts
 * @returns {Promise<Array<{ dir: string, version: string, target: string, manifest: any, pkg: any }>>}
 */
export async function stagePlugins({ root, owner, staging, only = [] }) {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Third-party dependencies of the inlined workspace libraries (e.g. sql-core → ssh2) are external too.
  const libDeps = {};
  for (const lib of ["plugin-api", "sql-core", "editor-kit"]) Object.assign(libDeps, readJson(join(root, "packages", lib, "package.json")).dependencies);
  for (const d of Object.keys(libDeps)) if (d.startsWith("@oneclient/")) delete libDeps[d];

  const pluginsRoot = join(root, "packages", "plugins");
  const staged = [];
  for (const dir of readdirSync(pluginsRoot).sort()) {
    const src = join(pluginsRoot, dir);
    if (!existsSync(join(src, "oneclient.json")) || !existsSync(join(src, "package.json"))) continue;
    if (only.length && !only.includes(dir)) continue;

    const pkg = readJson(join(src, "package.json"));
    const manifest = readJson(join(src, "oneclient.json"));
    const name = `@${owner}/${dir}`;
    const target = join(staging, dir);
    mkdirSync(target, { recursive: true });
    console.log(`\n== ${name}@${manifest.version}`);

    // main: one file, workspace libraries inlined, everything else left as a runtime dependency.
    const result = await build({
      entryPoints: [join(src, "dist", "main.js")],
      outfile: join(target, "dist", "main.js"),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      external: ["electron", "*.node", ...Object.keys({ ...libDeps, ...pkg.dependencies }).filter((d) => !d.startsWith("@oneclient/"))],
      metafile: true,
      logLevel: "warning",
    });
    const externals = new Set();
    for (const out of Object.values(result.metafile.outputs))
      for (const imp of out.imports) if (imp.external && !imp.path.startsWith("node:") && !imp.path.startsWith(".")) externals.add(imp.path.split("/").slice(0, imp.path.startsWith("@") ? 2 : 1).join("/"));
    const builtins = new Set(["electron", ...builtinModules]);
    const dependencies = {};
    for (const d of [...externals].sort()) {
      if (builtins.has(d)) continue;
      const range = pkg.dependencies?.[d] ?? libDeps[d];
      if (!range) throw new Error(`${dir}: main.js imports "${d}", which isn't in its dependencies.`);
      dependencies[d] = range;
    }

    // Everything else the manifest points at: the UI bundle, icons, README.
    for (const rel of [manifest.ui, manifest.icon, "oneclient.json", "README.md", "LICENSE"]) {
      if (rel && existsSync(join(src, rel))) cpSync(join(src, rel), join(target, rel), { recursive: true });
    }
    if (!existsSync(join(target, "LICENSE"))) cpSync(join(root, "LICENSE"), join(target, "LICENSE"));
    for (const c of manifest.contributes?.icons ?? []) {
      if (c.path && existsSync(join(src, c.path))) cpSync(join(src, c.path), join(target, c.path), { recursive: true });
    }

    writeFileSync(
      join(target, "package.json"),
      JSON.stringify(
        {
          name,
          version: manifest.version,
          description: pkg.description ?? manifest.description,
          license: pkg.license ?? "MIT",
          keywords: ["oneclient", "oneclient-plugin"],
          main: manifest.main,
          files: ["dist", "oneclient.json", "README.md", "LICENSE", "*.svg", "*.png"],
          dependencies,
          repository: { type: "git", url: `git+https://github.com/${owner}/OneClient.git`, directory: `packages/plugins/${dir}` },
          publishConfig: { registry: "https://npm.pkg.github.com", access: "restricted" },
        },
        null,
        2,
      ) + "\n",
    );
    staged.push({ dir, version: manifest.version, target, manifest, pkg });
  }
  return staged;
}
